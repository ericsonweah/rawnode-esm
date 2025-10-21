"use strict";

// /src/worker.mjs — enterprise‑grade, non‑blocking worker for RawNode ESM converter
// - Keeps { dir, dryRun } message contract and progress/done/error events.
// - Fully async I/O; bounded concurrency; deterministic ordering; atomic writes.
// - Cancellation + optional timeout support.
// - Comment‑aware transforms (no matches inside // or /* */ comments).
// - Export conversions are span‑safe (no "export default X;X;" duplication).
// - Post‑hoist header fix removes conflicting default‑import names (e.g., EventEmitter).

import { parentPort, threadId } from "node:worker_threads";
import { opendir, lstat, stat, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname as pathDirname, resolve as pathResolve, sep as PATH_SEP } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

/* ────────────────────────────────────────────────────────────────
 * Protocol
 * ──────────────────────────────────────────────────────────────── */
const WORKER_PROTOCOL_V1 = 1;
// Inbound:  { dir, dryRun, includeExts?, excludeNames?, concurrency?, timeoutMs?, progressEveryMs? }
// Outbound: progress | done | error | warn
// Cancel:   { type: 'cancel' }

/* ────────────────────────────────────────────────────────────────
 * Utilities
 * ──────────────────────────────────────────────────────────────── */

const toPosix = (p) => p.split(PATH_SEP).join("/");
const byStablePath = (a, b) => toPosix(a).localeCompare(toPosix(b), "en");

/** Minimal async pool with back‑pressure */
class AsyncPool {
  constructor(limit) { this.limit = Math.max(1, limit | 0); this.active = 0; this.q = []; }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally { this.active--; if (this.q.length) this.q.shift()(); }
      };
      this.active < this.limit ? run() : this.q.push(run);
    });
  }
}

/** Atomic write using rename (same dir) */
async function writeFileAtomic(path, data) {
  const tmp = path + `.rawnode-esm.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Deterministic BFS walk; skip symlinks; yield files */
async function* walkBFS(root, { excludeNames = new Set(["node_modules", ".git"]) } = {}) {
  const Q = [root];
  while (Q.length) {
    const dir = Q.shift();
    let dh; try { dh = await opendir(dir); } catch { continue; }
    const entries = [];
    for await (const ent of dh) entries.push(ent);
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, "en") : a.isDirectory() ? -1 : 1
    );
    for (const ent of entries) {
      if (excludeNames.has(ent.name)) continue;
      const full = join(dir, ent.name);
      let st; try { st = await lstat(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { Q.push(full); continue; }
      yield full;
    }
    await sleep(0);
  }
}

/** Cached stat */
const statCache = new Map();
async function isFile(p) {
  const k = toPosix(p);
  if (statCache.has(k)) return statCache.get(k) === 1;
  try {
    const st = await stat(p);
    const v = st.isFile() ? 1 : 0;
    statCache.set(k, v);
    return v === 1;
  } catch {
    statCache.set(k, 0);
    return false;
  }
}

/** Async, conservative resolver for ./foo vs ./foo.js vs ./foo/index.js */
function makeResolveImportPath() {
  let calls = 0;
  return async function resolveImportPath(mod, baseDir) {
    const isRelative = mod.startsWith("./") || mod.startsWith("../");
    if (!isRelative) return mod; // builtins or packages unchanged
    const abs = pathResolve(baseDir, mod);
    const filePath  = `${abs}.js`;
    const indexPath = join(abs, "index.js");
    if (++calls % 64 === 0) await Promise.resolve(); // micro‑yield
    try {
      if (await isFile(filePath))  return `${mod}.js`;
      if (await isFile(indexPath)) return `${mod.replace(/\/$/, "")}/index.js`;
      return `${mod.replace(/\/$/, "")}/index.js`; // fallback
    } catch {
      return `${mod.replace(/\/$/, "")}/index.js`;
    }
  };
}

/* ────────────────────────────────────────────────────────────────
 * Comment & string aware scanners
 * ──────────────────────────────────────────────────────────────── */
function buildCommentRanges(src) {
  const ranges = [];
  let i = 0, len = src.length;
  let inLine = false, inBlock = false;
  let str = null, tpl = false, esc = false, depthTpl = 0;

  while (i < len) {
    const c = src[i], c2 = src[i+1];

    if (inLine) { if (c === "\n") { ranges.push([startLine, i]); inLine = false; } i++; continue; }
    if (inBlock) { if (c === "*" && c2 === "/") { ranges.push([startBlock, i+2]); inBlock = false; i += 2; continue; } i++; continue; }

    if (str) { if (!esc && c === str) str = null; esc = !esc && c === "\\"; i++; continue; }
    if (tpl) {
      if (!esc && c === "`" && depthTpl === 0) { tpl = false; i++; continue; }
      if (!esc && c === "$" && c2 === "{") { depthTpl++; i += 2; continue; }
      if (c === "}") { depthTpl = Math.max(0, depthTpl - 1); i++; continue; }
      esc = !esc && c === "\\"; i++; continue;
    }

    // start of string/template
    if (c === "'" || c === '"') { str = c; i++; continue; }
    if (c === "`") { tpl = true; i++; continue; }

    // comments
    if (c === "/" && c2 === "/") { var startLine = i; inLine = true; i += 2; continue; }
    if (c === "/" && c2 === "*") { var startBlock = i; inBlock = true; i += 2; continue; }

    i++;
  }
  if (inLine) ranges.push([startLine, len]);
  if (inBlock) ranges.push([startBlock, len]);
  return ranges;
}
function inRanges(idx, ranges) {
  for (let i=0;i<ranges.length;i++) {
    const [s,e] = ranges[i];
    if (idx >= s && idx < e) return true;
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────
 * Generic async replace (global regex) with guard support
 * ──────────────────────────────────────────────────────────────── */
async function replaceAsyncAll(src, re, replacer, isGuarded) {
  re.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    const idx = m.index;
    out += src.slice(last, idx) + (isGuarded && isGuarded(idx) ? m[0] : await replacer(m, idx, src));
    last = idx + m[0].length;
  }
  out += src.slice(last);
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Tiny helpers used by transforms
 * ──────────────────────────────────────────────────────────────── */
const slug = (s) =>
  String(s).replace(/^node:/, "").replace(/[^\w$]+/g, "_").replace(/^(\d)/, "_$1");

function insertRequireShimIfNeeded(text) {
  // already present?
  if (/\bcreateRequire\s+as\s+__createRequire\b/.test(text) || /\b__createRequire\(/.test(text)) return text;
  if (!/\brequire\s*\(/.test(text)) return text; // nothing left that needs the shim

  const shim = "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);\n\n";
  if (text.startsWith("#!")) {
    const nl = text.indexOf("\n");
    if (nl > -1) return text.slice(0, nl + 1) + shim + text.slice(nl + 1);
  }
  return shim + text;
}

/* ────────────────────────────────────────────────────────────────
 * Core transform
 * ──────────────────────────────────────────────────────────────── */
async function transformFile(originalCode, absPath) {
  let code = originalCode;
  const baseDir = pathDirname(absPath);
  const resolveImportPath = makeResolveImportPath();

  // comment map once
  // const commentRanges = buildCommentRanges(code);
  // const isCommented = (i) => inRanges(i, commentRanges);

    // comment map (refreshable)
  let commentRanges = buildCommentRanges(code);
  const isCommented = (i) => inRanges(i, commentRanges);
  const _refreshComments = () => { commentRanges = buildCommentRanges(code); };

  const topLevelImports = [];
  const seenImports = new Set();
  let changed = false;

  // Pre‑scan aliases like: const { promises: fs } = require('fs');
  // Pre‑scan aliases inside any require-destructuring (captures mixed lists too)
  const aliasProtect = new Set();
  {
    const RE_DESTRUCT = /(^|[;\s])(?:var|let|const)\s*\{\s*([^}]+)\s*\}\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)/g;
    let m;
    while ((m = RE_DESTRUCT.exec(code))) {
      if (isCommented(m.index)) continue;
      const body = m[2];
      body.split(",").forEach((part) => {
        const mm = part.trim().match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
        if (mm) aliasProtect.add(mm[2]);
      });
    }
  }

  // Helper to hoist import uniquely
  const hoist = (line) => {
    if (!seenImports.has(line)) { seenImports.add(line); topLevelImports.push(line); }
  };

  // require('mod')(args)
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*\(\s*([^)]*)\s*\)\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, name, , mod, args] = m;
      const imp = await resolveImportPath(mod, baseDir);
      hoist(`import tmp_${name} from "${imp}";`);
      changed = true;
      return `const ${name} = tmp_${name}(${args});`;
    },
    isCommented
  );

  // require('mod').member(…?)
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\.([A-Za-z_$][\w$]*)(\s*\([^)]*\))?\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, name, , mod, member, call = ""] = m;
      const imp = await resolveImportPath(mod, baseDir);
      hoist(`import * as __tmp_${name} from "${imp}";`);
      changed = true;
      return `const ${name} = __tmp_${name}.${member}${call};`;
    },
    isCommented
  );

  // const/let/var x = require('mod')  (skip if protected alias name)
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:(var|let|const))\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, , name, , mod] = m;
      if (aliasProtect.has(name)) return m[0]; // leave as-is to avoid redeclare
      const imp = await resolveImportPath(mod, baseDir);
      hoist(`import ${name} from "${imp}";`);
      changed = true;
      return `// moved import for ${name}`;
    },
    isCommented
  );

  // alias destructuring: const { promises: fs } = require('fs');  (single-pair case)
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s*\{\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, member, alias, , mod] = m;
      const imp = await resolveImportPath(mod, baseDir);
      const ns = `__ns_${slug(imp)}`;
      hoist(`import * as ${ns} from "${imp}";`);
      changed = true;
      return `const ${alias} = ${ns}.${member};`;
    },
    isCommented
  );

  // **Mixed destructuring fix**:
  // const { promises: fs, createReadStream, statSync } = require("fs");
  //  → import * as __ns_fs from "fs"; import { createReadStream, statSync } from "fs"; const fs = __ns_fs.promises;
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s*\{\s*([^}]+)\s*\}\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, namesRaw, , mod] = m;

      // Split on top-level commas (simple but sufficient for usual patterns)
      const parts = namesRaw.split(",").map(s => s.trim()).filter(Boolean);

      const pairs = [];   // [{prop, alias}]
      const simple = [];  // ["name", "other"]
      for (const p of parts) {
        const mm = p.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
        if (mm) pairs.push({ prop: mm[1], alias: mm[2] });
        else if (p) simple.push(p.replace(/\s+/g, " "));
      }

      // If this was *only* simple names, let the standard named-import path handle it below
      // (but we are *in* this handler already; so if there are no pairs at all, return as-is and
      // let the original simple-destructuring handler (below) pick it up).
      if (pairs.length === 0 && simple.length > 0) return m[0];

      const imp = await resolveImportPath(mod, baseDir);
      const ns  = `__ns_${slug(imp)}`;

      if (pairs.length && simple.length) {
        hoist(`import * as ${ns} from "${imp}";`);
        hoist(`import { ${simple.join(", ")} } from "${imp}";`);
        changed = true;
        return pairs.map(({prop, alias}) => `const ${alias} = ${ns}.${prop};`).join("\n");
      }

      if (pairs.length && simple.length === 0) {
        hoist(`import * as ${ns} from "${imp}";`);
        changed = true;
        return pairs.map(({prop, alias}) => `const ${alias} = ${ns}.${prop};`).join("\n");
      }

      // pairs.length === 0 and simple.length === 0 → fall through (unlikely)
      return m[0];
    },
    isCommented
  );

  // simple destructuring only: const { a,b } = require('mod')
  // (runs if the mixed handler above returned original string)
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s*\{\s*([^}]+)\s*\}\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, namesRaw, , mod] = m;

      // Only proceed if there are NO alias pairs inside; mixed cases were handled above.
      if (/\:/.test(namesRaw)) return m[0];

      const names = namesRaw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .join(", ");

      const imp = await resolveImportPath(mod, baseDir);
      hoist(`import { ${names} } from "${imp}";`);
      changed = true;
      return `// moved import for { ${names} }`;
    },
    isCommented
  );

  // Bare assignment requires: name = require('mod')
  code = await replaceAsyncAll(
    code,
    /(^|\n)\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx, src) => {
      if (isCommented(idx)) return m[0];
      const [, lead, name, , mod] = m;
      const before = src.slice(Math.max(0, idx - 200), idx);
      const inTry = /\btry\s*\{[^}]*$/.test(before);
      const imp = await resolveImportPath(mod, baseDir);
      changed = true;
      return inTry ? `${lead}${name} = await import("${imp}");` : `${lead}import ${name} from "${imp}";`;
    },
    isCommented
  );

  // Dynamic variable requires: const x = require(expr)
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:(var|let|const))\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*([^'")][^)]+)\s*\)\s*;?/g,
    async (m, idx) => {
      if (isCommented(idx)) return m[0];
      const [, decl, name, expr] = m;
      changed = true;
      return `${decl} ${name} = await import(${expr.trim()});`;
    },
    isCommented
  );

  // Side‑effect only require('x');  → import "x";   (but NOT inside try/catch probes)
  code = await replaceAsyncAll(
    code,
    /(^|\n)\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g,
    async (m, idx, src) => {
      if (isCommented(idx)) return m[0];
      const [, lead, , mod] = m;
      const before = src.slice(Math.max(0, idx - 200), idx);
      const inTry = /\btry\s*\{[^}]*$/.test(before);
      if (inTry) return m[0]; // preserve sync availability probes
      const imp = await resolveImportPath(mod, baseDir);
      changed = true;
      return `${lead}import "${imp}";`;
    },
    isCommented
  );


    // The code has been mutated by require->import passes; refresh the guard map.
  _refreshComments();


  /* ────────────────────────────────────────────────────────────────
   * Exports — span-safe replacements (no duplication)
   * ──────────────────────────────────────────────────────────────── */
  function findStmtEnd(src, from) {
    let i = from, depth = 0, str = null, tpl = false, esc = false;
    while (i < src.length) {
      const c = src[i], n = src[i+1];
      if (str) { if (!esc && c === str) str = null; esc = !esc && c === "\\"; i++; continue; }
      if (tpl) {
        if (!esc && c === "`") { tpl = false; i++; continue; }
        if (!esc && c === "$" && n === "{") { depth++; i += 2; continue; }
        if (c === "}") { depth = Math.max(0, depth-1); i++; continue; }
        esc = !esc && c === "\\"; i++; continue;
      }
      if (c === "'" || c === '"') { str = c; i++; continue; }
      if (c === "`") { tpl = true; i++; continue; }
      if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
      if (c === ")" || c === "]" || c === "}") { depth--; i++; continue; }
      if (c === ";" && depth === 0) { i++; break; }
      i++;
    }
    return i;
  }

  {
    const RE_EQ   = /(^|\n)([ \t]*)module\.exports\s*=\s*/g;
    const RE_MDOT = /(^|\n)([ \t]*)module\.exports\.([A-Za-z_$][\w$]*)\s*=\s*/g;
    const RE_EXP  = /(^|\n)([ \t]*)exports\.([A-Za-z_$][\w$]*)\s*=\s*/g;

    function applySplices(src, splices) {
      if (!splices.length) return src;
      splices.sort((a,b)=>a[0]-b[0]);
      let out = "", last = 0;
      for (const [s,e,rep] of splices) { out += src.slice(last, s) + rep; last = e; }
      out += src.slice(last);
      return out;
    }

    const splices = [];
    let m;

    while ((m = RE_EQ.exec(code))) {
      const idx = m.index;
      if (isCommented(idx)) continue;
      const lead = m[1] || "", indent = m[2] || "";
      const rhsStart = RE_EQ.lastIndex;
      const end = findStmtEnd(code, rhsStart);
      const rhs = code.slice(rhsStart, end).trim().replace(/;$/, "");
      const semi = code[end-1] === ";" ? ";" : "";
      splices.push([idx, end, `${lead}${indent}export default ${rhs}${semi}`]);
      changed = true;
    }
    while ((m = RE_MDOT.exec(code))) {
      const idx = m.index;
      if (isCommented(idx)) continue;
      const lead = m[1] || "", indent = m[2] || "", key = m[3];
      const rhsStart = RE_MDOT.lastIndex;
      const end = findStmtEnd(code, rhsStart);
      const rhs = code.slice(rhsStart, end).trim().replace(/;$/, "");
      const semi = code[end-1] === ";" ? ";" : "";
      splices.push([idx, end, `${lead}${indent}export const ${key} = ${rhs}${semi}`]);
      changed = true;
    }
    while ((m = RE_EXP.exec(code))) {
      const idx = m.index;
      if (isCommented(idx)) continue;
      const lead = m[1] || "", indent = m[2] || "", key = m[3];
      const rhsStart = RE_EXP.lastIndex;
      const end = findStmtEnd(code, rhsStart);
      const rhs = code.slice(rhsStart, end).trim().replace(/;$/, "");
      const semi = code[end-1] === ";" ? ";" : "";
      splices.push([idx, end, `${lead}${indent}export const ${key} = ${rhs}${semi}`]);
      changed = true;
    }

    if (splices.length) code = applySplices(code, splices);
  }

  // Hoist top‑level imports uniquely; preserve shebang
  if (topLevelImports.length) {
    const shebang = code.startsWith("#!") ? code.split("\n", 1)[0] : null;
    const body = shebang ? code.slice(shebang.length + 1) : code;
    const header = topLevelImports.join("\n");
    code = (shebang ? (shebang + "\n") : "") + header + "\n\n" + body;
  }

  /* ────────────────────────────────────────────────────────────────
   * Post‑hoist: dedupe conflicting default‑import names in header
   *   e.g., "import EventEmitter from 'node:events';"
   *         and "import EventEmitter from './cores/event-emitter.js';"
   *   -> keep relative/local spec, drop core/package one.
   * ──────────────────────────────────────────────────────────────── */
  code = (() => {
    const shebang = code.startsWith("#!") ? code.split("\n", 1)[0] : null;
    const startIdx = shebang ? shebang.length + 1 : 0;
    // Capture contiguous import lines from top
    const lines = code.slice(startIdx).split("\n");
    let i = 0;
    const importLines = [];
    while (i < lines.length) {
      const L = lines[i];
      if (/^\s*import\b/.test(L)) importLines.push([i, L]);
      else if (/^\s*$/.test(L)) importLines.push([i, L]); // allow blank lines in header
      else break;
      i++;
    }
    if (!importLines.length) return code;

    const CORE = new Set(["fs","path","http","http2","https","events","stream","util","zlib","crypto","os","url","querystring","perf_hooks","async_hooks","dns","net","tls","child_process","module"]);
    const isRelative = (s) => s.startsWith("./") || s.startsWith("../");

    const parseDefault = (text) => {
      // import X from '...';
      const m = text.match(/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s+['"]([^'"]+)['"]\s*;?\s*$/);
      return m ? { name: m[1], spec: m[2] } : null;
    };

    const keep = new Array(importLines.length).fill(true);
    const seen = new Map(); // name -> {spec, k}
    for (let k=0;k<importLines.length;k++) {
      const [, text] = importLines[k];
      const parsed = parseDefault(text);
      if (!parsed) continue;
      const { name, spec } = parsed;
      if (!seen.has(name)) { seen.set(name, {spec, k}); continue; }
      const prev = seen.get(name);
      if (prev.spec === spec) { keep[k] = false; continue; } // exact dupe
      // conflict: prefer relative over core/package, else keep first
      if (isRelative(spec) && !isRelative(prev.spec)) {
        keep[prev.k] = false; seen.set(name, {spec, k});
      } else if (!isRelative(spec) && isRelative(prev.spec)) {
        keep[k] = false;
      } else {
        keep[k] = false;
      }
    }

    if (keep.every(Boolean)) return code;

    // rebuild header
    const rebuilt = lines.slice(0, i).filter((L, idxWithin) => keep[idxWithin] !== false).join("\n");
    const rest = lines.slice(i).join("\n");
    return (shebang ? (shebang + "\n") : "") + rebuilt + "\n" + rest;
  })();

  // Regression guard: accidental “export default X;X;”
  if (/export\s+default\s+([A-Za-z_$][\w$]*)\s*;\s*\1\s*;/.test(code)) {
    parentPort?.postMessage({
      type: "warn",
      file: absPath,
      code: "CJS-EXPORT-DUP",
      message: "Detected duplicated identifier immediately after export default; review transform."
    });
  }

    // Header hoist (and previous edits) may have shifted offsets again — refresh.
  _refreshComments();


  // Determine if a real require( remains outside comments → inject shim (idempotent)
  const hasRealRequire = (() => {
    const re = /\brequire\s*\(/g;
    let m; while ((m = re.exec(code))) {
      if (!isCommented(m.index)) return true;
    }
    return false;
  })();
  if (hasRealRequire) {
    code = insertRequireShimIfNeeded(code);
  }

  return { code, changed };
}

/* ────────────────────────────────────────────────────────────────
 * replaceRequire(dir, dryRun) — orchestrator
 * ──────────────────────────────────────────────────────────────── */
async function replaceRequire(dir, dryRun, opts = {}) {
  const includeExts = new Set((opts.includeExts ?? [".js"]).map((s) => s.toLowerCase()));
  const excludeNames = new Set(opts.excludeNames ?? ["node_modules", ".git"]);
  const concurrency = Math.max(1, Number(opts.concurrency ?? Math.min(32, os.cpus().length * 2)));
  const progressEveryMs = Number(opts.progressEveryMs ?? 300);

  const pool = new AsyncPool(concurrency);
  const start = performance.now();
  let lastEmit = 0;
  let processed = 0;
  let converted = 0;
  let aborted = false;
  let lastEmittedProcessed = 0;

  const onCancel = (msg) => { if (msg?.type === "cancel") aborted = true; };
  parentPort?.on("message", onCancel);

  const files = [];
  for await (const p of walkBFS(dir, { excludeNames })) {
    const low = p.toLowerCase();
    if ([...includeExts].some((ext) => low.endsWith(ext))) files.push(p);
  }
  files.sort(byStablePath);

  const promises = [];
  for (const file of files) {
    if (aborted) break;
    promises.push(pool.schedule(async () => {
      try {
        const before = await readFile(file, "utf8");
        const { code, changed } = await transformFile(before, file);
        if (changed && !dryRun) await writeFileAtomic(file, code);
        if (changed) converted++;
      } catch (e) {
        parentPort?.postMessage({ type: "error", dir, file, error: e?.message ?? String(e), stack: e?.stack });
      } finally {
        processed++;
        const now = performance.now();
        if (now - lastEmit >= progressEveryMs) {
          const elapsed = (now - start) / 1000;
          const deltaP = processed - lastEmittedProcessed;
          const deltaMs = Math.max(1, now - lastEmit);
          const localTps = deltaP > 0 ? deltaP / (deltaMs / 1000) : 0;
          const avgMsPerBatch = localTps > 0 ? (1000 / localTps) * concurrency : 0;
          parentPort?.postMessage({
            type: "progress",
            pid: process.pid,
            threadId,
            protocol: WORKER_PROTOCOL_V1,
            queueRemaining: Math.max(0, files.length - processed),
            processed, converted,
            throughput: Number((processed / ((now - start) / 1000 + 1e-3)).toFixed(1)),
            concurrency, batchSize: concurrency, avgMsPerBatch: Number(avgMsPerBatch.toFixed(2)),
          });
          lastEmittedProcessed = processed;
          lastEmit = now;
        }
      }
    }));
    if (processed % 64 === 0) await Promise.resolve();
  }

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const timeout = sleep(opts.timeoutMs, { ref: true }).then(() => { throw new Error(`Worker timeout after ${opts.timeoutMs} ms`); });
    await Promise.race([Promise.all(promises), timeout]);
  } else {
    await Promise.all(promises);
  }

  parentPort?.off("message", onCancel);
  if (aborted) return converted;

  return converted;
}

/* ────────────────────────────────────────────────────────────────
 * Message handler
 * ──────────────────────────────────────────────────────────────── */
parentPort?.on("message", async (msg) => {
  if (!msg || msg.type === "cancel") return;
  const start = performance.now();
  try {
    const converted = await replaceRequire(msg.dir, !!msg.dryRun, {
      includeExts: msg.includeExts,
      excludeNames: msg.excludeNames,
      concurrency: msg.concurrency,
      timeoutMs: msg.timeoutMs,
      progressEveryMs: msg.progressEveryMs,
    });
    const durationMs = performance.now() - start;
    parentPort?.postMessage({ type: "done", dir: msg.dir, converted, durationMs, protocol: WORKER_PROTOCOL_V1, threadId });
  } catch (err) {
    const durationMs = performance.now() - start;
    parentPort?.postMessage({ type: "error", dir: msg.dir, durationMs, error: err?.message ?? String(err), stack: err?.stack });
  }
});

export {};
