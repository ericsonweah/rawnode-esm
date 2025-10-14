// worker.mjs — runs inside each worker thread for RawNode ESM converter
import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/* ────────────────────────────────────────────────────────────────
 * Worker message handler
 * ──────────────────────────────────────────────────────────────── */
parentPort.on("message", async ({ dir, dryRun }) => {
  const start = performance.now();
  try {
    const converted = await replaceRequire(dir, dryRun);
    const durationMs = performance.now() - start;
    parentPort.postMessage({ type: "done", dir, converted, durationMs });
  } catch (err) {
    const durationMs = performance.now() - start;
    parentPort.postMessage({
      type: "error",
      dir,
      durationMs,
      error: err.message,
      stack: err.stack,
    });
  }
});

/* ────────────────────────────────────────────────────────────────
 * Conversion Logic (smart, scope-aware)
 * ──────────────────────────────────────────────────────────────── */
async function replaceRequire(dir, dryRun) {
  let count = 0;

  // Helper: Resolve correct .js or index.js path
  function resolveImportPath(mod, baseDir) {
    const isRelative = mod.startsWith("./") || mod.startsWith("../");
    if (!isRelative) return mod; // Node builtins / packages
    const abs = path.resolve(baseDir, mod);
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return `${mod.replace(/\/$/, "")}/index.js`;
    } catch {}
    return mod.endsWith(".js") ? mod : `${mod}.js`;
  }

  // Detect function/class/constructor scopes for async import context
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

  function walk(dirPath) {
    for (const file of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, file);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!file.endsWith(".js")) continue;

      let code = fs.readFileSync(full, "utf8");
      const original = code;
      const baseDir = path.dirname(full);
      const scopes = detectScopes(code);
      const topLevelImports = [];
      const seenImports = new Set();

      // Handle require('mod')(args)
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

      // Handle require('mod').member or call
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

      // Handle const x = require('mod')
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

      // Handle destructured require
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

      // module.exports and exports.*
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

      // Dynamic require placeholders
      code = code.replace(
        /\brequire\(([^)"']+)\)/g,
        (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`
      );

      // Deduplicate imports
      if (topLevelImports.length) {
        const unique = topLevelImports.filter((imp) => {
          if (seenImports.has(imp)) return false;
          seenImports.add(imp);
          return true;
        });
        code = `${unique.join("\n")}\n\n${code}`;
      }

      if (code !== original) {
        count++;
        if (!dryRun) fs.writeFileSync(full, code, "utf8");
      }
    }
  }

  walk(dir);
  return count;
}
