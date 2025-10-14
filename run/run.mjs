import fs from "node:fs";
import path from "node:path";

/* ---------- helpers ------------------------------------------------------- */
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

/* ---------- main ---------------------------------------------------------- */
function replaceRequire(dir, opts = {}) {
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    if (/(^|\/)(node_modules|dist|test)\b/.test(full)) continue;
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      replaceRequire(full, opts);
      continue;
    }
    if (!file.endsWith(".js")) continue;

    let code = fs.readFileSync(full, "utf8");
    const original = code;
    const baseDir = path.dirname(full);

    /* ---- require patterns ----------------------------------------------- */

    // --- inside-function require → await import()
// --- inside-function require → async IIFE dynamic import ---
code = code.replace(
  /(\bconst\s*\{[^}]+\}\s*=\s*)require\(['"]([^'"]+)['"]\)/g,
  (_, left, mod) =>
    `${left}await (async () => await import("${resolveImportPath(mod, baseDir)}"))();`
);

code = code.replace(
  /(\bconst\s+\w+\s*=\s*)require\(['"]([^'"]+)['"]\)/g,
  (_, left, mod) =>
    `${left}await (async () => await import("${resolveImportPath(mod, baseDir)}"))();`
);

    code = code
      .replace(
        /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\(([^)]*)\);?/g,
        (_, name, mod, args) =>
          `import tmp_${name} from "${resolveImportPath(mod, baseDir)}";\nconst ${name} = tmp_${name}(${args});`
      )
      .replace(
        /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\.([A-Za-z$_][\w$]*)/g,
        (_, name, mod, member) =>
          `import * as __tmp_${name} from "${resolveImportPath(mod, baseDir)}";\nconst ${name} = __tmp_${name}.${member};`
      )
      .replace(
        /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
        (_, name, mod) => `import ${name} from "${resolveImportPath(mod, baseDir)}";`
      )
      .replace(
        /const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
        (_, names, mod) =>
          `import { ${names.trim()} } from "${resolveImportPath(mod, baseDir)}";`
      );

    /* ---- exports -------------------------------------------------------- */
    let hasDefault = false;
    code = code.replace(/module\.exports\s*=\s*([^;]+)/g, (_, rhs) => {
      hasDefault = true;
      return `export default ${rhs}`;
    });
    code = code
      .replace(/\bexports\.([A-Za-z$_][\w$]*)\s*=\s*(?!require)([^;\n]+)/g, (_, k, rhs) => `export const ${k} = ${rhs}`)
      .replace(/\bmodule\.exports\.([A-Za-z$_][\w$]*)\s*=\s*([^;\n]+)/g, (_, k, rhs) =>
        hasDefault ? `export { ${rhs} as ${k} };` : `export const ${k} = ${rhs}`
      );

    code = code.replace(
      /\brequire\(([^)]+)\)/g,
      (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`
    );

    /* ---- write result --------------------------------------------------- */
    if (code !== original) {
      if (opts.dry) {
        console.log(`--- ${full} (dry-run) ---`);
        console.log(code);
      } else {
        if (opts.backup && !fs.existsSync(full + ".bak")) fs.copyFileSync(full, full + ".bak");
        fs.writeFileSync(full, code, "utf8");
        console.log("✅ Converted", full);
      }
    }
  }
}

/* ---------- CLI ----------------------------------------------------------- */
const target = process.argv[2] || "./src";
const dry = process.argv.includes("--dry");
const backup = process.argv.includes("--backup");
replaceRequire(target, { dry, backup });
console.log("\n🎉 Conversion complete (handles exports.*, module.exports.*, and directory index.js).");
