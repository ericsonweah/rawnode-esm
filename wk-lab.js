"use strict";

// /src/worker.mjs — enterprise‑grade, non‑blocking worker for RawNode‑ESM
// - Async I/O; bounded concurrency; deterministic ordering; atomic writes.
// - Converts CommonJS → ESM with safe interop and conservative fallbacks.
// - Handles: const/let/var (incl. comma-chained) requires, member/call patterns,
//   alias destructuring, dynamic requires (await import), __dirname/__filename,
//   require.resolve() via createRequire shim, and module.exports / exports.*.
// - Node core modules get node: specifiers; relative specifiers resolve to
//   ./x.js or ./x/index.js (fallback to /index.js), matching your earlier behavior.
//
// Protocol (V1)
// In:  { dir, dryRun, includeExts?, excludeNames?, concurrency?, timeoutMs?, progressEveryMs? }
// Out: { type:'progress'|'done'|'error', ... }  | Cancel: { type:'cancel' }

import { parentPort, threadId } from "node:worker_threads";
import { opendir, lstat, stat, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname as pathDirname, resolve as pathResolve, sep as PATH_SEP, posix as pathPosix } from "node:path";
import os from "node:os";
import { builtinModules } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

/* ────────────────────────────────────────────────────────────────
 * Protocol
 * ──────────────────────────────────────────────────────────────── */
const WORKER_PROTOCOL_V1 = 1;

/* ────────────────────────────────────────────────────────────────
 * Utilities
 * ──────────────────────────────────────────────────────────────── */

const toPosix = (p) => p.split(PATH_SEP).join("/");
const byStablePath = (a, b) => toPosix(a).localeCompare(toPosix(b), "en");

class AsyncPool {
  constructor(limit) { this.limit = Math.max(1, limit | 0); this.active = 0; this.q = []; }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          this.active--;
          if (this.q.length) this.q.shift()();
        }
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

/** Node core helpers */
const CORE = new Set([...builtinModules, ...builtinModules.map((s) => s.replace(/^node:/, ""))]);
const isNodeCore = (spec) => CORE.has(spec.replace(/^node:/, ""));
const toNodeSpecifier = (spec) => {
  const s = spec.replace(/^node:/, "");
  return CORE.has(s) ? `node:${s}` : spec;
};

/** Smart resolver (file.js → index.js; fallback to /index.js) */
function makeResolveImportPath() {
  return async function resolveImportPath(mod, baseDir) {
    const isRelative = mod.startsWith("./") || mod.startsWith("../") || mod.startsWith("/");
    if (!isRelative) return toNodeSpecifier(mod);
    const abs = pathResolve(baseDir, mod);
    // exact file
    if (await isFile(abs)) return toPosix(mod);
    // ./foo.js
    if (await isFile(`${abs}.js`)) return toPosix(`${mod}.js`);
    // ./foo/index.js
    if (await isFile(join(abs, "index.js"))) return toPosix((mod.replace(/\/$/, "")) + "/index.js");
    // fallback favors index.js (matches your previous behavior)
    return toPosix((mod.replace(/\/$/, "")) + "/index.js");
  };
}

/** Scope detection (top‑level vs inside braces) */
function detectScopes(code) {
  const ranges = [];
  const stack = [];
  let i = 0, str = null, tpl = false, esc = false;
  while (i < code.length) {
    const c = code[i];
    if (str) { esc = !esc && c === "\\"; if (!esc && c === str) str = null; i++; continue; }
    if (tpl) {
      if (!esc && c === "`") { tpl = false; i++; continue; }
      esc = !esc && c === "\\";
      i++; continue;
    }
    if (c === "'" || c === '"') { str = c; i++; continue; }
    if (c === "`") { tpl = true; i++; continue; }
    if (c === "{") { stack.push(i); i++; continue; }
    if (c === "}") { const s = stack.pop(); if (s !== undefined) ranges.push([s, i]); i++; continue; }
    i++;
  }
  return ranges;
}
const isInside = (i, scopes) => scopes.some(([s, e]) => i > s && i < e);

/** Async replace all using an async replacer */
async function replaceAsyncAll(src, re, replacer) {
  re.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    out += src.slice(last, m.index) + (await replacer(m, m.index, src));
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  return out;
}

/** Split “a = x, {b:c} = y, d = f(g)” by commas at top level */
function splitTopLevelCommas(s) {
  const parts = [];
  let i = 0, start = 0, depth = 0, str = null, tpl = false, esc = false;
  while (i <= s.length) {
    const c = s[i] || ",";
    if (str) { esc = !esc && c === "\\"; if (!esc && c === str) str = null; i++; continue; }
    if (tpl) {
      if (!esc && c === "`") { tpl = false; i++; continue; }
      esc = !esc && c === "\\"; i++; continue;
    }
    if (c === "'" || c === '"') { str = c; i++; continue; }
    if (c === "`") { tpl = true; i++; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; i++; continue; }
    if (c === "," && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; i++; continue; }
    i++;
  }
  return parts.filter(Boolean);
}

/** Require shim (only if needed) */
function injectRequireShimIfNeeded(code) {
  if (/\bcreateRequire\s+as\s+__createRequire\b/.test(code) || /\b__createRequire\(/.test(code)) return code;
  if (!/\brequire\s*\(/.test(code) && !/\brequire\.resolve\s*\(/.test(code)) return code;
  const shim =
`import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    if (nl > -1) return code.slice(0, nl + 1) + shim + code.slice(nl + 1);
  }
  return shim + code;
}

/* ────────────────────────────────────────────────────────────────
 * Core transform
 * ──────────────────────────────────────────────────────────────── */
async function transformFile(originalCode, absPath) {
  let code = originalCode;
  const baseDir = pathDirname(absPath);
  const scopes = detectScopes(code);
  const isTopLevel = (idx) => !isInside(idx, scopes);
  const resolveImportPath = makeResolveImportPath();

  const hoisted = [];
  const seenHoist = new Set();
  const hoistOnce = (line) => { if (!seenHoist.has(line)) { seenHoist.add(line); hoisted.push(line); } };

  let changed = false;

  // Detect features needing shims
  const needsDirname = /\b__dirname\b/.test(code);
  const needsFilename = /\b__filename\b/.test(code);
  const needsRequireResolve = /\brequire\.resolve\s*\(/.test(code);

  const normalizeSpec = async (mod) => {
    let s = mod;
    s = toNodeSpecifier(s);
    if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
      s = await resolveImportPath(s, baseDir);
    }
    return s;
  };

  // ── (A) Multi‑declarator const/let/var with requires (top‑level only) ──
  code = await replaceAsyncAll(
    code,
    /(^|\n)(\s*)(var|let|const)\s+([\s\S]*?)\s*;(?![^]*?\))/g,
    async (m, _idx, _src) => {
      const [full, lead, indent, kind, declsRaw] = m;
      const idx = _idx + lead.length; // position at statement start
      if (!isTopLevel(idx)) return full;   // leave function-scope statements untouched

      const decls = splitTopLevelCommas(declsRaw);
      const keep = [];
      let localChanged = false;

      for (const d of decls) {
        // static require: name = require('spec')
        let mm = d.match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*$/);
        if (mm) {
          const [, name, , mod] = mm;
          const spec = await normalizeSpec(mod);
          hoistOnce(`import ${name} from '${spec}';`);
          localChanged = true;
          continue; // drop this declarator
        }
        // dynamic require: name = /* TODO dynamic require → await import(expr.js) */ require(expr)
        mm = d.match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*([^'"][^)]+)\s*\)\s*$/);
        if (mm) {
          const [, name, expr] = mm;
          keep.push(`${name} = await import(${expr.trim()})`);
          localChanged = true;
          continue;
        }
        // otherwise keep verbatim
        keep.push(d);
      }

      if (!localChanged) return full;
      changed = true;
      if (keep.length) return `${lead}${indent}${kind} ${keep.join(", ")};`;
      // remove whole statement if nothing to keep
      return `${lead}`;
    }
  );

  // ── (B) require('mod')(args) ──
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*\(\s*([^)]*)\s*\)\s*;?/g,
    async (m, idx) => {
      const [, name, , mod, args] = m;
      const spec = await normalizeSpec(mod);
      if (!isTopLevel(idx)) {
        changed = true;
        return `const ${name} = (await (await import('${spec}')).default(${args}));`;
      }
      hoistOnce(`import tmp_${name} from '${spec}';`);
      changed = true;
      return `const ${name} = tmp_${name}(${args});`;
    }
  );

  // ── (C) import "mod";.member(…?) ──
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\.([A-Za-z_$][\w$]*)(\s*\([^)]*\))?\s*;?/g,
    async (m, idx) => {
      const [, name, , mod, member, call = ""] = m;
      const spec = await normalizeSpec(mod);
      if (!isTopLevel(idx)) {
        changed = true;
        return `const ${name} = (await import('${spec}')).${member}${call};`;
      }
      hoistOnce(`import * as __tmp_${name} from '${spec}';`);
      changed = true;
      return `const ${name} = __tmp_${name}.${member}${call};`;
    }
  );

  // ── (D) alias destructuring: const fs = await (async()=> (await import("fs")).promises)() ──
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s*\{\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx) => {
      const [, member, alias, , mod] = m;
      const spec = await normalizeSpec(mod);
      if (!isTopLevel(idx)) {
        changed = true;
        return `const ${alias} = (await import('${spec}')).${member};`;
      }
      // Use namespace + local const to avoid “import fs, {promises as fs}”
      hoistOnce(`import * as __tmp_${alias} from '${spec}';`);
      changed = true;
      return `const ${alias} = __tmp_${alias}.${member};`;
    }
  );

  // ── (E) destructuring: const { a,b } = await (async()=> await import("mod"))(); ──
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:var|let|const)\s*\{\s*([^}]+)\s*\}\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g,
    async (m, idx) => {
      const [, namesRaw, , mod] = m;
      const spec = await normalizeSpec(mod);
      const names = namesRaw.trim().replace(/\s+/g, " ");
      if (!isTopLevel(idx)) {
        changed = true;
        return `const { ${names} } = await import('${spec}');`;
      }
      hoistOnce(`import { ${names} } from '${spec}';`);
      changed = true;
      return `// moved import for { ${names} }`;
    }
  );

  // ── (F) simple const/let/var import name from "mod";(fallback if any remain) ──
  code = await replaceAsyncAll(
    code,
    /(?:^|[;\s])(?:(var|let|const))\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx) => {
      const [, decl, name, , mod] = m;
      const spec = await normalizeSpec(mod);
      if (!isTopLevel(idx)) {
        changed = true;
        return `${decl} ${name} = await import('${spec}');`;
      }
      hoistOnce(`import ${name} from '${spec}';`);
      changed = true;
      return `// moved import for ${name}`;
    }
  );

  // ── (G) dynamic variable requires at top level: const x = /* TODO dynamic require → await import(expr.js) */ require(expr) ──
  code = await replaceAsyncAll(
    code,
    /(?:^|\n)\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*([^'"][^)]+)\s*\)\s*;?/g,
    async (m, idx) => {
      const [, name, expr] = m;
      if (!isTopLevel(idx)) return m[0]; // leave inner scopes alone
      changed = true;
      return `const ${name} = await import(${expr.trim()});`;
    }
  );

  // ── (H) Exports ──
  const findStmtEnd = (src, from) => {
    let i = from, depth = 0, str = null, tpl = false, esc = false;
    while (i < src.length) {
      const c = src[i];
      if (str) { esc = !esc && c === "\\"; if (!esc && c === str) str = null; i++; continue; }
      if (tpl) {
        if (!esc && c === "`") { tpl = false; i++; continue; }
        esc = !esc && c === "\\"; i++; continue;
      }
      if (c === "'" || c === '"') { str = c; i++; continue; }
      if (c === "`") { tpl = true; i++; continue; }
      if (c === "(" || c === "{" || c === "[") { depth++; i++; continue; }
      if (c === ")" || c === "}" || c === "]") { depth--; i++; continue; }
      if (c === ";" && depth === 0) { i++; break; }
      i++;
    }
    return i;
  };

  // export default RHS;
  code = await replaceAsyncAll(
    code,
    /(^|\n)\s*module\.exports\s*=\s*/g,
    async (m, idx, src) => {
      const start = m.index + m[0].length; // position after '='
      const end = findStmtEnd(src, start);
      const rhs = src.slice(start, end).trim();
      changed = true;
      return `${m[1]}export default ${rhs};`;
    }
  );

  // export { RHS as name };;
  code = await replaceAsyncAll(
    code,
    /(^|\n)\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=\s*/g,
    async (m, idx, src) => {
      const key = m[2];
      const start = m.index + m[0].length;
      const end = findStmtEnd(src, start);
      const rhs = src.slice(start, end).trim();
      changed = true;
      return `${m[1]}export const ${key} = ${rhs};`;
    }
  );

  // export const name = RHS;
  code = await replaceAsyncAll(
    code,
    /(^|\n)\s*exports\.([A-Za-z_$][\w$]*)\s*=\s*/g,
    async (m, idx, src) => {
      const key = m[2];
      const start = m.index + m[0].length;
      const end = findStmtEnd(src, start);
      const rhs = src.slice(start, end).trim();
      changed = true;
      return `${m[1]}export const ${key} = ${rhs};`;
    }
  );

  // ── (I) Header injection: hoisted imports + shims ──
  const header = [];
  if (hoisted.length) {
    // stable text order by spec inside import line
    const sorted = [...hoisted].sort((a, b) => {
      // extract 'from '...''
      const sa = (a.match(/from\s+['"]([^'"]+)['"]/) || [,""])[1];
      const sb = (b.match(/from\s+['"]([^'"]+)['"]/) || [,""])[1];
      return toPosix(sa).localeCompare(toPosix(sb), "en");
    });
    header.push(...sorted);
  }
  if (needsDirname || needsFilename) {
    header.push(
`import { fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = __dirname_fn(__filename);`
    );
  }
  if (needsRequireResolve || /\brequire\(/.test(code)) {
    // still referenced somewhere → keep shim
    header.push(
`import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`
    );
  }

  if (header.length) {
    const shebang = code.startsWith("#!") ? code.slice(0, code.indexOf("\n") + 1) : "";
    const body = shebang ? code.slice(shebang.length) : code;
    code = (shebang || "") + header.join("\n") + "\n\n" + body;
  } else {
    // If no header but still need shim based on dynamic use:
    code = injectRequireShimIfNeeded(code);
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

  const onCancel = (msg) => { if (msg?.type === "cancel") aborted = true; };
  parentPort?.on("message", onCancel);

  const files = [];
  for await (const p of walkBFS(dir, { excludeNames })) {
    const low = p.toLowerCase();
    if ([...includeExts].some((ext) => low.endsWith(ext))) files.push(p);
  }
  files.sort(byStablePath);

  const jobs = [];
  for (const file of files) {
    if (aborted) break;
    jobs.push(
      pool.schedule(async () => {
        try {
          const before = await readFile(file, "utf8");
          const { code, changed } = await transformFile(before, file);
          if (changed && !dryRun) await writeFileAtomic(file, code);
          if (changed) converted++;
        } catch (e) {
          parentPort?.postMessage({
            type: "error",
            dir,
            file,
            error: e?.message ?? String(e),
            stack: e?.stack,
          });
        } finally {
          processed++;
          const now = performance.now();
          if (now - lastEmit >= progressEveryMs) {
            parentPort?.postMessage({
              type: "progress",
              pid: process.pid,
              threadId,
              protocol: WORKER_PROTOCOL_V1,
              queueRemaining: Math.max(0, files.length - processed),
              processed,
              converted,
              throughput: Number((processed / ((now - start) / 1000 + 1e-3)).toFixed(1)),
              concurrency,
              batchSize: concurrency,
              avgMsPerBatch: Number(((now - lastEmit) / Math.max(1, processed)).toFixed(2)),
            });
            lastEmit = now;
          }
        }
      })
    );
    if (processed % 64 === 0) await Promise.resolve();
  }

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const timeout = sleep(opts.timeoutMs, { ref: true }).then(() => { throw new Error(`Worker timeout after ${opts.timeoutMs} ms`); });
    await Promise.race([Promise.all(jobs), timeout]);
  } else {
    await Promise.all(jobs);
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
      excludeNames: new Set(msg.excludeNames || ["node_modules", ".git"]),
      concurrency: msg.concurrency,
      timeoutMs: msg.timeoutMs,
      progressEveryMs: msg.progressEveryMs,
    });
    const durationMs = performance.now() - start;
    parentPort?.postMessage({
      type: "done",
      dir: msg.dir,
      converted,
      durationMs,
      protocol: WORKER_PROTOCOL_V1,
      threadId,
    });
  } catch (err) {
    const durationMs = performance.now() - start;
    parentPort?.postMessage({
      type: "error",
      dir: msg.dir,
      durationMs,
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
  }
});

export {};
