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
    // UPDATED: smarter .js / index.js resolver with fallback (Case 1, Case 2, default→Case 2)
    // UPDATED: smarter .js / index.js resolver with microtask-yield (Case 1, Case 2, default→Case 2)
    function resolveImportPath(mod, baseDir) {
        const isRelative = mod.startsWith("./") || mod.startsWith("../");
        if (!isRelative) return mod; // Node builtins or external packages

        const abs = path.resolve(baseDir, mod);
        const filePath = `${abs}.js`;
        const indexPath = path.join(abs, "index.js");

        // Lightweight microtask yield every ~20 calls
        if (!resolveImportPath._calls) resolveImportPath._calls = 0;
        if (++resolveImportPath._calls % 20 === 0) {
            const now = performance.now();
            const p = Promise.resolve();
            p.then(() => {
                // microtask yields the worker thread briefly
                if (performance.now() - now > 5) process.emitWarning("slow fs batch");
            });
        }

        try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return `${mod}.js`; // Case 1
            }
            if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
                return `${mod.replace(/\/$/, "")}/index.js`; // Case 2
            }
            // Default fallback → assume Case 2 when nothing found
            return `${mod.replace(/\/$/, "")}/index.js`;
        } catch {
            // Graceful fallback on any fs error → Case 2
            return `${mod.replace(/\/$/, "")}/index.js`;
        }
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

    // UPDATED: non-blocking directory walker using micro-task scheduling
    function walk(dirPath) {
        const queue = [dirPath];
        let processed = 0;

        // internal runner (iterative instead of deep recursion)
        function processNext() {
            // micro-batch: handle up to N directories before yielding
            const BATCH_SIZE = 10;
            let batch = 0;

            while (queue.length && batch++ < BATCH_SIZE) {
                const currentDir = queue.pop();
                let files;
                try {
                    files = fs.readdirSync(currentDir);
                } catch {
                    continue; // skip unreadable directories
                }

                for (const file of files) {
                    const full = path.join(currentDir, file);
                    let stat;
                    try {
                        stat = fs.statSync(full);
                    } catch {
                        continue;
                    }

                    if (stat.isDirectory()) {
                        queue.push(full);
                        continue;
                    }
                    if (!file.endsWith(".js")) continue;

                    processed++;
                    // reuse your synchronous conversion logic verbatim ↓↓↓
                    let code = fs.readFileSync(full, "utf8");
                    const original = code;
                    const baseDir = path.dirname(full);
                    const scopes = detectScopes(code);
                    const topLevelImports = [];
                    const seenImports = new Set();

                    // all your require→import replacements
                    code = code.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\(([^)]*)\);?/g, (m, name, mod, args, idx) => {
                        const imp = resolveImportPath(mod, baseDir);
                        if (isInside(idx, scopes)) return `const ${name} = await (async()=> (await import("${imp}")).default(${args}))();`;
                        topLevelImports.push(`import tmp_${name} from "${imp}";`);
                        return `const ${name} = tmp_${name}(${args});`;
                    });

                    code = code.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\.([A-Za-z$_][\w$]*)(\([^)]*\))?/g, (m, name, mod, member, call = "", idx) => {
                        const imp = resolveImportPath(mod, baseDir);
                        if (isInside(idx, scopes)) return `const ${name} = await (async()=> (await import("${imp}")).${member}${call})();`;
                        topLevelImports.push(`import * as __tmp_${name} from "${imp}";`);
                        return `const ${name} = __tmp_${name}.${member}${call};`;
                    });

                    code = code.replace(/const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g, (m, name, mod, idx) => {
                        const imp = resolveImportPath(mod, baseDir);
                        if (isInside(idx, scopes)) return `const ${name} = await (async()=> await import("${imp}"))();`;
                        topLevelImports.push(`import ${name} from "${imp}";`);
                        return `// moved import for ${name}`;
                    });

                    code = code.replace(/const\s*\{\s*([A-Za-z$_][\w$]*)\s*:\s*([A-Za-z$_][\w$]*)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g, (m, member, alias, mod, idx) => {
                        const imp = resolveImportPath(mod, baseDir);
                        if (isInside(idx, scopes)) return `const ${alias} = await (async()=> (await import("${imp}")).${member})()`;
                        topLevelImports.push(`import * as __tmp_${alias} from "${imp}";`);
                        return `// moved import for ${alias}\nconst ${alias} = __tmp_${alias}.${member};`;
                    });

                    code = code.replace(/const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g, (m, names, mod, idx) => {
                        const imp = resolveImportPath(mod, baseDir);
                        if (isInside(idx, scopes)) return `const { ${names.trim()} } = await (async()=> await import("${imp}"))();`;
                        topLevelImports.push(`import { ${names.trim()} } from "${imp}";`);
                        return `// moved import for { ${names.trim()} }`;
                    });

                    let hasDefault = false;
                    code = code.replace(/module\.exports\s*=\s*([^;]+)/g, (_, rhs) => {
                        hasDefault = true;
                        return `export default ${rhs}`;
                    });
                    code = code.replace(/\bexports\.([A-Za-z$_][\w$]*)\s*=\s*(?!require)([^;\n]+)/g, (_, key, rhs) => `export const ${key} = ${rhs}`);
                    code = code.replace(/\bmodule\.exports\.([A-Za-z$_][\w$]*)\s*=\s*([^;\n]+)/g, (_, key, rhs) => (hasDefault ? `export { ${rhs} as ${key} };` : `export const ${key} = ${rhs}`));

                    code = code.replace(/\brequire\(([^)"']+)\)/g, (m) => `/* TODO dynamic require → await import(${m.slice(8, -1)}.js) */ ${m}`);

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

            // yield control if queue not empty
            if (queue.length) {
                queueMicrotask(processNext);
            }
        }

        processNext();
    }

    walk(dir);
    return count;
}
