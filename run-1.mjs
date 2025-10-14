

import fs from "node:fs";
import path from "node:path";

/* ---------- helpers ------------------------------------------------------- */

function resolveImportPath(mod, baseDir) {
  const isRelative = mod.startsWith("./") || mod.startsWith("../");
  if (!isRelative) return mod;                       // core / package
  const absPath = path.resolve(baseDir, mod);
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return `${mod.replace(/\/$/, "")}/index.js`;
  } catch {}
  return mod.endsWith(".js") ? mod : `${mod}.js`;
}

/* ---------- main ---------------------------------------------------------- */

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

    /* ---- requires ------------------------------------------------------- */

    // require('x')(args)
    code = code.replace(
      /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\(([^)]*)\);?/g,
      (_, name, mod, args) => {
        const importPath = resolveImportPath(mod, baseDir);
        return `import tmp_${name} from "${importPath}";\nconst ${name} = tmp_${name}(${args});`;
      }
    );

    // require('x').member
    code = code.replace(
      /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\.([A-Za-z$_][\w$]*)/g,
      (_, name, mod, member) => {
        const importPath = resolveImportPath(mod, baseDir);
        return `import * as __tmp_${name} from "${importPath}";\nconst ${name} = __tmp_${name}.${member};`;
      }
    );

    // const foo = require('x')
    code = code.replace(
      /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
      (_, name, mod) => {
        const importPath = resolveImportPath(mod, baseDir);
        return `import ${name} from "${importPath}";`;
      }
    );

    // const { a,b } = require('x')
    code = code.replace(
      /const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
      (_, names, mod) => {
        const importPath = resolveImportPath(mod, baseDir);
        return `import { ${names.trim()} } from "${importPath}";`;
      }
    );

    /* ---- exports -------------------------------------------------------- */

    // Case: module.exports = something
    // keep a marker so we can later append named exports if found
    let hasDefault = false;
    code = code.replace(/module\.exports\s*=\s*([^;]+)/g, (_, rhs) => {
      hasDefault = true;
      return `export default ${rhs}`;
    });

    // Case: exports.foo = ...
    code = code.replace(
      /\bexports\.([A-Za-z$_][\w$]*)\s*=\s*(?!require)([^;\n]+)/g,
      (_, key, rhs) => `export const ${key} = ${rhs}`
    );

    // Case: module.exports.foo = ...
    code = code.replace(
      /\bmodule\.exports\.([A-Za-z$_][\w$]*)\s*=\s*([^;\n]+)/g,
      (_, key, rhs) => (hasDefault ? `export { ${rhs} as ${key} };` : `export const ${key} = ${rhs}`)
    );

    /* ---- dynamic require flags ----------------------------------------- */
    code = code.replace(
      /\brequire\(([^)]+)\)/g,
      (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`
    );

    if (code !== original) {
      fs.writeFileSync(full, code, "utf8");
      console.log("✅ Converted", full);
    }
  }
}

/* ------------------------------------------------------------------------ */

replaceRequire("./src");
console.log("\n🎉 Conversion complete (handles exports.*, module.exports.*, and directory index.js).");
