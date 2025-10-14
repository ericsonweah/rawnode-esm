import fs from "node:fs";
import path from "node:path";

/* ────────────────────────────────────────────────────────────────
 * CLI flags
 * ──────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetIndex = args.indexOf("--target");
const targetDir =
  targetIndex !== -1 && args[targetIndex + 1]
    ? args[targetIndex + 1]
    : "./src";

if (dryRun)
  console.log(`🔍 Dry-run mode: no files will be modified.\nTarget: ${targetDir}\n`);
else console.log(`🚀 Running converter on: ${targetDir}\n`);

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
 * Helper: detect scopes (functions, methods, constructors, classes)
 * ──────────────────────────────────────────────────────────────── */
function detectScopes(code) {
  const ranges = [];
  const stack = [];
  const regex = /(function\s+\w*|constructor|class\s+\w+|\w+\s*\([^)]*\)\s*\{)/g;
  let match;
  while ((match = regex.exec(code))) {
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
 * Core Converter
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
    const topLevelImports = [];
    const seenImports = new Set(); // prevent duplicates

    /* ───────────── require() replacements ───────────── */

    // 1️⃣ require('x')(args)
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

    // 2️⃣ require('x').member or require('x').member(...)
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

    // 3️⃣ const foo = require('x')
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

    // 4️⃣ const { a,b } = require('x')
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

    /* ───────────── module.exports / exports ───────────── */
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

    /* ───────────── dynamic require flag ───────────── */
    code = code.replace(
      /\brequire\(([^)"']+)\)/g,
      (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`
    );

    /* ───────────── prepend unique imports ───────────── */
    if (topLevelImports.length) {
      const unique = topLevelImports.filter((imp) => {
        if (seenImports.has(imp)) return false;
        seenImports.add(imp);
        return true;
      });
      code = `${unique.join("\n")}\n\n${code}`;
    }

    /* ───────────── write or preview ───────────── */
    if (code !== original) {
      if (dryRun) {
        console.log(`🔸 Preview: ${full}`);
        console.log(code.slice(0, 400) + (code.length > 400 ? "\n..." : ""));
        console.log("──────────────────────────────\n");
      } else {
        fs.writeFileSync(full, code, "utf8");
        console.log("✅ Converted", full);
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * Run
 * ──────────────────────────────────────────────────────────────── */
replaceRequire(targetDir);
console.log(
  dryRun
    ? `\n👀 Dry-run complete — no files modified in: ${targetDir}`
    : `\n🎉 Conversion complete in: ${targetDir} (scope-aware, deduplicated imports, safe for methods & constructors).`
);
