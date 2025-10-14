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

        /* ---------- scope analysis: find function regions -------------------- */
        const fnRanges = [];
        const stack = [];
        for (let i = 0; i < code.length; i++) {
            if (code.startsWith("function", i) || code.startsWith("async function", i)) {
                const start = code.indexOf("{", i);
                if (start !== -1) stack.push({ start, depth: 1 });
            } else if (code[i] === "{") {
                if (stack.length) stack[stack.length - 1].depth++;
            } else if (code[i] === "}") {
                if (stack.length) {
                    const top = stack[stack.length - 1];
                    top.depth--;
                    if (top.depth === 0) {
                        fnRanges.push([top.start, i]);
                        stack.pop();
                    }
                }
            }
        }

        const isInFunction = (pos) => fnRanges.some(([s, e]) => pos > s && pos < e);

        /* ---- requires ------------------------------------------------------- */

        // require('x')(args)
        code = code.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\(([^)]*)\);?/g, (m, name, mod, args, offset) => {
            const importPath = resolveImportPath(mod, baseDir);
            if (isInFunction(offset)) {
                return `const ${name} = (await (async () => (await import("${importPath}")).default)())(${args});`;
            }
            return `import tmp_${name} from "${importPath}";\nconst ${name} = tmp_${name}(${args});`;
        });

        // require('x').member
        // require('x').member or require('x').member(...)
        // --- require('x').member OR require('x').member(...)
        // Handles both property access and method calls, with context awareness
        // --- require('x').member OR require('x').member(...)
        // Always safe: wraps in async IIFE, works inside functions and top-level code
        code = code.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\.([A-Za-z$_][\w$]*)(\([^)]*\))?/g, (match, name, mod, member, callArgs = "", offset) => {
            const importPath = resolveImportPath(mod, baseDir);
            return `const ${name} = await (async () => (await import("${importPath}")).${member}${callArgs || ""})();`;
        });

        // const foo = require('x')
        code = code.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g, (m, name, mod, offset) => {
            const importPath = resolveImportPath(mod, baseDir);
            if (isInFunction(offset)) {
                return `const ${name} = await (async () => await import("${importPath}"))();`;
            }
            return `import ${name} from "${importPath}";`;
        });

        // const { a,b } = require('x')
        code = code.replace(/const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g, (m, names, mod, offset) => {
            const importPath = resolveImportPath(mod, baseDir);
            if (isInFunction(offset)) {
                return `const { ${names.trim()} } = await (async () => await import("${importPath}"))();`;
            }
            return `import { ${names.trim()} } from "${importPath}";`;
        });

        /* ---- exports -------------------------------------------------------- */
        let hasDefault = false;
        code = code.replace(/module\.exports\s*=\s*([^;]+)/g, (_, rhs) => {
            hasDefault = true;
            return `export default ${rhs}`;
        });
        code = code
            .replace(/\bexports\.([A-Za-z$_][\w$]*)\s*=\s*(?!require)([^;\n]+)/g, (_, k, rhs) => `export const ${k} = ${rhs}`)
            .replace(/\bmodule\.exports\.([A-Za-z$_][\w$]*)\s*=\s*([^;\n]+)/g, (_, k, rhs) => (hasDefault ? `export { ${rhs} as ${k} };` : `export const ${k} = ${rhs}`));

        code = code.replace(/\brequire\(([^)]+)\)/g, (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`);

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
console.log("\n🎉 Conversion complete (context-aware dynamic imports).");
