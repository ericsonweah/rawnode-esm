"use strict";

// /src/plan.mjs

import { isNodeCore, toNodeSpecifier, slug } from "./utils.mjs";

export function planFile({ path, content, facts, analysis, risk, resolvePolicy, logger }) {
    const edits = [];
    const warnings = [];
    const decls = new Set(); // imports to hoist (text -> once)
    const nsMap = new Map(); // spec -> ns ident for interop
    const topInsertions = [];

    const addWarning = (code, message, hint) => warnings.push({ file: path, code, level: "warn", message, hint });

    const ensureNS = (spec) => {
        if (nsMap.has(spec)) return nsMap.get(spec);
        const id = `__ns_${slug(spec)}`;
        nsMap.set(spec, id);
        // normalize node: prefix
        const spec2 = isNodeCore(spec) ? toNodeSpecifier(spec) : spec;
        decls.add(`import * as ${id} from '${spec2}';`);
        return id;
    };

    // add:
    const EXT_RX = /\.(?:[cm]?js|json|node|wasm)$/i;
    function withJsIfRelative(spec, risk) {
        if (/^(?:\.{1,2}\/)/.test(spec) && !EXT_RX.test(spec)) {
            return risk === "aggressive" ? `${spec}.js` : spec;
        }
        return spec;
    }

    // __dirname/__filename
    if (facts.uses.__dirname || facts.uses.__filename) {
        topInsertions.push(
            `import { fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = __dirname_fn(__filename);`
        );
    }

    // require.resolve shim
    if (facts.requires.some((r) => r.callee === "require.resolve")) {
        topInsertions.push(
            `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`
        );
    }

    // Pass-through detection (const X = require('...'); module.exports = X;)
    let passThrough = null;
    let exportSite = null;
    for (const e of facts.exports) {
        if (e.kind === "module.exports" && e.topLevel) {
            exportSite = e;
            break;
        }
    }
    if (exportSite) {
        const expEnd = findStmtEnd(content, exportSite.eqPos);
        const rhs = content.slice(exportSite.eqPos, expEnd).trim();
        for (const r of facts.requires) {
            if (r.pattern === "assign" && r.topLevel && r.arg && r.lhs) {
                passThrough = { r, rhs, exportSite, expEnd };
                break;
            }
        }
    }

    if (passThrough && passThrough.rhs === passThrough.r.lhs) {
        let spec = passThrough.r.arg;
        if (isNodeCore(spec)) spec = toNodeSpecifier(spec);
        spec = withJsIfRelative(spec, risk);

        // 1) Hoist a clean default import for the LHS
        decls.add(`import ${passThrough.r.lhs} from '${spec}';`);

        // 2) Remove the entire "const LHS = require('...');" statement (single-line heuristic)
        const lineStart = (() => {
            let i = passThrough.r.start;
            while (i > 0 && content[i - 1] !== "\n") i--;
            return i;
        })();
        const reqStmtEnd = findStmtEnd(content, passThrough.r.end);
        edits.push({ start: lineStart, end: reqStmtEnd, text: "", why: "pass-through fold", code: "CJS-PASS-THROUGH" });

        // 3) Keep the normal export conversion below (module.exports -> export default <rhs>)
        //    No extra action here; the existing export rule will handle it.

        // Prevent double-processing of this require site
        passThrough._skipRequireStart = passThrough.r.start;
    }

    // per-site
    // for (const r of facts.requires) {
    for (const r of facts.requires) {
        if (passThrough && r.start === passThrough._skipRequireStart) continue;

        if (r.callee === "require.resolve") continue; // shim handled
        if (!r.arg) {
            addWarning("CJS-DYN-REQUIRE", "Dynamic require cannot be converted safely.", "Use createRequire/import() manually.");
            continue;
        }

        // let spec = r.arg;
        // if (isNodeCore(spec)) spec = toNodeSpecifier(spec);

        let spec = r.arg;
        if (isNodeCore(spec)) spec = toNodeSpecifier(spec);
        spec = withJsIfRelative(spec, risk);
        if (/^(?:\.{1,2}\/)/.test(r.arg) && !/\.(?:[cm]?js|json|node|wasm)$/i.test(r.arg) && risk !== "aggressive") {
            addWarning("CJS-REL-NOEXT", `Relative import '${r.arg}' lacks extension required by ESM.`, "Run with --risk aggressive or enable a plugin/policy to append '.js'.");
        }

        // side-effect only
        if (r.pattern === "side-effect" && r.topLevel) {
            edits.push({ start: r.start, end: r.end, text: `import '${spec}';`, why: "side-effect", code: "CJS-SFX" });
            continue;
        }

        // destructure of core (already captured as 'destructure' pattern)
        if (r.pattern === "destructure" && isNodeCore(spec)) {
            // We can't reconstruct exact named list here w/o LHS parse; safe fallback:
            const ns = ensureNS(spec);
            // keep original; warn that aggressive could map to named import
            addWarning("CJS-AMB-DESTRUCTURE", `Destructured require('${spec}') kept via namespace interop.`, "Use risk=aggressive.");
            continue;
        }

        // default-like assign
        // at top of file (near other consts):
        const CORE_DEFAULTABLE = new Set(["node:http"]); // Builtin CJS: default import yields the CJS object

        // replace the 'assign' block with:
        if (r.pattern === "assign") {
            if (CORE_DEFAULTABLE.has(spec)) {
                const id = `__tmp_${slug(spec)}`;
                decls.add(`import ${id} from '${spec}';`);
                edits.push({ start: r.start, end: r.end, text: id, why: "core-default", code: "CJS-ASSIGN-CORE-DFLT" });
                // note: no CJS-AMB-DEFAULT warning for this whitelisted core
            } else if (risk === "aggressive" && !isNodeCore(spec)) {
                const id = `__tmp_${slug(spec)}`;
                decls.add(`import ${id} from '${spec}';`);
                edits.push({ start: r.start, end: r.end, text: id, why: "default-aggressive", code: "CJS-ASSIGN-DFLT" });
            } else {
                const ns = ensureNS(spec);
                edits.push({ start: r.start, end: r.end, text: `${ns}.default ?? ${ns}`, why: "interop", code: "CJS-ASSIGN-NS" });
                addWarning("CJS-AMB-DEFAULT", `Using namespace interop for '${spec}'.`, "Use risk=aggressive to try default import when safe.");
            }
            continue;
        }
    }

    // exports: module.exports = <expr>;  →  export default <expr>;
    for (const e of facts.exports) {
        if (e.kind !== "module.exports") continue;
        if (!e.topLevel) {
            addWarning("CJS-EXPORT-DYNAMIC", "module.exports assigned outside top-level; skipped.", "Refactor to a top-level assignment.");
            continue;
        }

        // Find statement end: scan to next top-level semicolon or EOF (basic string/bracket tracking)
        const stmtEnd = findStmtEnd(content, e.eqPos);
        const rhs = content.slice(e.eqPos, stmtEnd).trim();

        // Basic safety: accept common RHS forms (identifier, function/class expr, object/array, call/arrow/function parens)
        if (!/^(?:[A-Za-z_$][A-Za-z0-9_$]*|function\b|class\b|\{|\[|\(|`)/.test(rhs)) {
            addWarning("CJS-EXPORT-AMB", "Ambiguous right-hand side of module.exports; skipped.", "Edit manually or simplify RHS.");
            continue;
        }

        edits.push({
            start: e.start,
            end: stmtEnd,
            text: `export default ${rhs}`,
            why: "module.exports default",
            code: "CJS-EXP-DFLT",
        });
    }

    // helper: local scan to end-of-statement (not exported)
    function findStmtEnd(src, from) {
        let i = from,
            depth = 0,
            str = null,
            tpl = false,
            esc = false;
        while (i < src.length) {
            const c = src[i];
            if (str) {
                if (!esc && c === str) {
                    str = null;
                }
                esc = !esc && c === "\\";
                i++;
                continue;
            }
            if (tpl) {
                if (!esc && c === "`") {
                    tpl = false;
                    i++;
                    continue;
                }
                if (!esc && c === "$" && src[i + 1] === "{") {
                    depth++;
                    i += 2;
                    continue;
                }
                esc = !esc && c === "\\";
                i++;
                continue;
            }
            if (c === '"' || c === "'") {
                str = c;
                i++;
                continue;
            }
            if (c === "`") {
                tpl = true;
                i++;
                continue;
            }
            if (c === "/" && src[i + 1] === "/") {
                while (i < src.length && src[i] !== "\n") i++;
                continue;
            }
            if (c === "/" && src[i + 1] === "*") {
                i += 2;
                while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
                i += 2;
                continue;
            }
            if (c === "(" || c === "{" || c === "[") {
                depth++;
                i++;
                continue;
            }
            if (c === ")" || c === "}" || c === "]") {
                depth = Math.max(0, depth - 1);
                i++;
                continue;
            }
            if (c === ";" && depth === 0) return i + 1;
            i++;
        }
        return src.length;
    }

    // inject hoisted imports at top (once)
    if (decls.size || topInsertions.length) {
        const header = [...topInsertions, ...decls].join("\n");
        // Insert at beginning (preserve shebang if present)
        const shebang = content.startsWith("#!") ? content.split("\n", 1)[0] : null;
        const offset = shebang ? shebang.length + 1 : 0;
        const text = shebang ? `${shebang}\n${header}\n` : `${header}\n`;
        const start = 0 + offset,
            end = 0 + offset;
        edits.unshift({ start, end, text, why: "imports-hoist", code: "CJS-HDR" });
    }

    return { edits, warnings, shims: { dirname: facts.uses.__dirname || facts.uses.__filename, requireResolve: facts.requires.some((r) => r.callee === "require.resolve") } };
}
