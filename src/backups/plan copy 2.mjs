"use strict";

import { isNodeCore, toNodeSpecifier, slug } from "./utils.mjs";

export function planFile({ path, content, facts, analysis, risk, resolvePolicy, logger }) {
  let edits = [];
  const warnings = [];
  const decls = new Set();
  const nsMap = new Map();
  const topInsertions = [];
  const assignedVars = new Map(); // track variable -> module spec

  const addWarning = (code, message, hint) =>
    warnings.push({ file: path, code, level: "warn", message, hint });

  const ensureNS = (spec) => {
    if (nsMap.has(spec)) return nsMap.get(spec);
    const id = `__ns_${slug(spec)}`;
    nsMap.set(spec, id);
    const spec2 = isNodeCore(spec) ? toNodeSpecifier(spec) : spec;
    decls.add(`import * as ${id} from '${spec2}';`);
    return id;
  };

  // helper to capture the LHS variable in `const X = require('mod')`
  function extractLhsVar(src, startIndex) {
    const pre = src.slice(Math.max(0, startIndex - 80), startIndex);
    const m = pre.match(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/);
    return m ? m[1] : null;
  }

  // handle __dirname/__filename
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

  // ─────────────────────────────────────────────────────────────
  // 1️⃣  REQUIRE sites
  // ─────────────────────────────────────────────────────────────
  for (const r of facts.requires) {
    if (r.callee === "require.resolve") continue;
    if (!r.arg) {
      addWarning("CJS-DYN-REQUIRE", "Dynamic require cannot be converted safely.", "Use createRequire/import() manually.");
      continue;
    }

    let spec = r.arg;
    if (isNodeCore(spec)) spec = toNodeSpecifier(spec);

    const lhs = extractLhsVar(content, r.start);

    // record for later if simple const assign
    if (lhs && r.pattern === "assign") {
      assignedVars.set(lhs, spec);
    }

    // side-effect require
    if (r.pattern === "side-effect" && r.topLevel) {
      edits.push({ start: r.start, end: r.end, text: `import '${spec}';`, why: "side-effect", code: "CJS-SFX" });
      continue;
    }

    // destructured core import
    if (r.pattern === "destructure" && isNodeCore(spec)) {
      const ns = ensureNS(spec);
      addWarning("CJS-AMB-DESTRUCTURE", `Destructured require('${spec}') kept via namespace interop.`, "Use risk=aggressive.");
      continue;
    }

    // standard assignment require
    if (r.pattern === "assign") {
      if (risk === "aggressive" && !isNodeCore(spec)) {
        const id = `__tmp_${slug(spec)}`;
        decls.add(`import ${id} from '${spec}';`);
        edits.push({ start: r.start, end: r.end, text: id, why: "default-aggressive", code: "CJS-ASSIGN-DFLT" });
      } else {
        const ns = ensureNS(spec);
        edits.push({
          start: r.start,
          end: r.end,
          text: `${ns}.default ?? ${ns}`,
          why: "interop",
          code: "CJS-ASSIGN-NS",
        });
        addWarning("CJS-AMB-DEFAULT", `Using namespace interop for '${spec}'.`, "Use risk=aggressive to try default import when safe.");
      }
      continue;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2️⃣  module.exports = …  → export default …
  // ─────────────────────────────────────────────────────────────
  for (const e of facts.exports) {
    if (e.kind !== "module.exports") continue;
    if (!e.topLevel) {
      addWarning("CJS-EXPORT-DYNAMIC", "module.exports assigned outside top-level; skipped.", "Refactor to a top-level assignment.");
      continue;
    }

    const stmtEnd = findStmtEnd(content, e.eqPos);
    const rhs = content.slice(e.eqPos, stmtEnd).trim();

    // detect if RHS refers to a variable imported from require()
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rhs) && assignedVars.has(rhs)) {
      const spec = assignedVars.get(rhs);
      const importStmt = `import ${rhs} from '${spec.endsWith(".js") ? spec : spec + ".js"}';`;
      edits.push({
        start: 0,
        end: 0,
        text: `${importStmt}\n`,
        why: "collapse require+export",
        code: "CJS-COLLAPSE-EXPORT",
      });
      edits.push({
        start: e.start,
        end: stmtEnd,
        text: `export default ${rhs}`,
        why: "collapse require+export",
        code: "CJS-COLLAPSE-EXPORT",
      });
      continue;
    }

    const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rhs);
    const isKnownSafe = isIdentifier || /^(?:function\b|class\b|\{|\[|\(|`|new\s+[A-Za-z_$])/.test(rhs);
    if (!isKnownSafe) {
      addWarning(
        "CJS-EXPORT-AMB",
        `Ambiguous right-hand side of module.exports: "${rhs.slice(0, 30)}..."`,
        "Review manually."
      );
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

  // ─────────────────────────────────────────────────────────────
  // helper: find end of statement
  // ─────────────────────────────────────────────────────────────
  function findStmtEnd(src, from) {
    let i = from, depth = 0, str = null, tpl = false, esc = false;
    while (i < src.length) {
      const c = src[i];
      if (str) {
        if (!esc && c === str) str = null;
        esc = !esc && c === "\\";
        i++;
        continue;
      }
      if (tpl) {
        if (!esc && c === "`") { tpl = false; i++; continue; }
        if (!esc && c === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        esc = !esc && c === "\\";
        i++;
        continue;
      }
      if (c === '"' || c === "'") { str = c; i++; continue; }
      if (c === "`") { tpl = true; i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (c === "(" || c === "{" || c === "[") { depth++; i++; continue; }
      if (c === ")" || c === "}" || c === "]") { depth = Math.max(0, depth - 1); i++; continue; }
      if (c === ";" && depth === 0) return i + 1;
      i++;
    }
    return src.length;
  }

  // ─────────────────────────────────────────────────────────────
  // 3️⃣  Header insertion for hoisted imports
  // ─────────────────────────────────────────────────────────────
  if (decls.size || topInsertions.length) {
    const header = [...topInsertions, ...decls].join("\n");
    const shebang = content.startsWith("#!") ? content.split("\n", 1)[0] : null;
    const offset = shebang ? shebang.length + 1 : 0;
    const text = shebang ? `${shebang}\n${header}\n` : `${header}\n`;
    const start = 0 + offset,
      end = 0 + offset;
    edits.unshift({ start, end, text, why: "imports-hoist", code: "CJS-HDR" });
  }

  return {
    edits,
    warnings,
    shims: {
      dirname: facts.uses.__dirname || facts.uses.__filename,
      requireResolve: facts.requires.some((r) => r.callee === "require.resolve"),
    },
  };
}
