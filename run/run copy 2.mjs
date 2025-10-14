import fs from "node:fs";
import path from "node:path";

/* ────────────────────────────────────────────────────────────────
 * Helper: normalize relative imports
 * ──────────────────────────────────────────────────────────────── */
function resolveImportPath(mod, baseDir) {
  const isRelative = mod.startsWith("./") || mod.startsWith("../");
  if (!isRelative) return mod;
  const abs = path.resolve(baseDir, mod);
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `${mod.replace(/\/$/, "")}/index.js`;
  } catch {}
  return mod.endsWith(".js") ? mod : `${mod}.js`;
}

/* ────────────────────────────────────────────────────────────────
 * Helper: find approximate function / method / constructor scopes
 * ──────────────────────────────────────────────────────────────── */
function detectScopes(code) {
  const ranges = [];
  const stack = [];
  const tokenRegex = /(function\s+\w*|constructor|class\s+\w+|\w+\s*\([^)]*\)\s*\{)/g;
  let match;
  while ((match = tokenRegex.exec(code))) {
    const braceStart = code.indexOf("{", match.index);
    if (braceStart !== -1) stack.push({ start: braceStart, depth: 1 });
  }
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "{") stack.forEach((s) => (s.depth += 1));
    else if (c === "}") {
      for (const s of stack) {
        s.depth -= 1;
        if (s.depth === 0 && !s.done) {
          ranges.push([s.start, i]);
          s.done = true;
        }
      }
    }
  }
  return ranges;
}
const isInside = (i, scopes) => scopes.some(([s, e]) => i > s && i < e);

/* ────────────────────────────────────────────────────────────────
 * Core converter
 * ──────────────────────────────────────────────────────────────── */
function replaceRequire(dir) {
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      replaceRequire(full);
      continue;
    }
    if (!file.endsWith(".js")) continue;

    let code = fs.readFileSync(full, "utf8");
    const original = code;
    const baseDir = path.dirname(full);
    const scopes = detectScopes(code);
    const topLevelImports = []; // ← FIX: declare collector

    /* ───────────── require() replacements ───────────── */

    // 1. require('x')(args)
    code = code.replace(
      /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\(([^)]*)\);?/g,
      (m, name, mod, args, idx) => {
        const imp = resolveImportPath(mod, baseDir);
        if (isInside(idx, scopes))
          return `const ${name} = await (async()=> (await import("${imp}")).default(${args}))();`;
        topLevelImports.push(`import tmp_${name} from "${imp}";`);
        return `const ${name} = tmp_${name}(${args});`;
      }
    );

    // 2. require('x').member or require('x').member(...)
    code = code.replace(
      /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\.([A-Za-z$_][\w$]*)(\([^)]*\))?/g,
      (m, name, mod, member, call = "", idx) => {
        const imp = resolveImportPath(mod, baseDir);
        if (isInside(idx, scopes))
          return `const ${name} = await (async()=> (await import("${imp}")).${member}${call})();`;
        topLevelImports.push(`import * as __tmp_${name} from "${imp}";`);
        return `const ${name} = __tmp_${name}.${member}${call};`;
      }
    );

    // 3. const foo = require('x')
    code = code.replace(
      /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
      (m, name, mod, idx) => {
        const imp = resolveImportPath(mod, baseDir);
        if (isInside(idx, scopes))
          return `const ${name} = await (async()=> await import("${imp}"))();`;
        topLevelImports.push(`import ${name} from "${imp}";`);
        return `// moved import for ${name}`;
      }
    );

    // 4. const { a,b } = require('x')
    code = code.replace(
      /const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
      (m, names, mod, idx) => {
        const imp = resolveImportPath(mod, baseDir);
        if (isInside(idx, scopes))
          return `const { ${names.trim()} } = await (async()=> await import("${imp}"))();`;
        topLevelImports.push(`import { ${names.trim()} } from "${imp}";`);
        return `// moved import for { ${names.trim()} }`;
      }
    );

    /* ───────────── exports ───────────── */
    let hasDefault = false;
    code = code.replace(/module\.exports\s*=\s*([^;]+)/g, (_, rhs) => {
      hasDefault = true;
      return `export default ${rhs}`;
    });
    code = code.replace(
      /\bexports\.([A-Za-z$_][\w$]*)\s*=\s*(?!require)([^;\n]+)/g,
      (_, key, rhs) => `export const ${key} = ${rhs}`
    );
    code = code.replace(
      /\bmodule\.exports\.([A-Za-z$_][\w$]*)\s*=\s*([^;\n]+)/g,
      (_, key, rhs) =>
        hasDefault ? `export { ${rhs} as ${key} };` : `export const ${key} = ${rhs}`
    );

    /* ───────────── dynamic require notice ───────────── */
    code = code.replace(
      /\brequire\(([^)"']+)\)/g,
      (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`
    );

    /* ───────────── prepend imports ───────────── */
    if (topLevelImports.length) {
      code = `${topLevelImports.join("\n")}\n\n${code}`;
    }

    /* ───────────── write result ───────────── */
    if (code !== original) {
      fs.writeFileSync(full, code, "utf8");
      console.log("✅ Converted", full);
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * Run
 * ──────────────────────────────────────────────────────────────── */
replaceRequire("./src");
console.log(
  "\n🎉 Conversion complete (scope-aware with hoisted top-level imports)."
);
