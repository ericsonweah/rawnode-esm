"use strict";

// /src/worker.mjs — enterprise‑grade, non‑blocking worker for RawNode ESM converter
// - Keeps { dir, dryRun } message contract and progress/done/error events.
// - Fully async I/O; bounded concurrency; deterministic ordering; atomic writes.
// - Cancellation + optional timeout support.
// - Surgical regex/token transforms; preserves comments/shebang; stable hoisting.
// - Risk profiles: safe | aggressive (default: safe).

import { parentPort, threadId } from "node:worker_threads";
import { opendir, lstat, stat, readFile, writeFile, rename } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join, dirname as pathDirname, resolve as pathResolve, sep as PATH_SEP } from "node:path";
import os from "node:os";
import { builtinModules } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

/* ────────────────────────────────────────────────────────────────
 * Protocol
 * ──────────────────────────────────────────────────────────────── */
const WORKER_PROTOCOL_V1 = 1;
// Inbound:  { dir, dryRun, includeExts?, excludeNames?, concurrency?, timeoutMs?, progressEveryMs?, risk? }
// Outbound: progress | done | error
// Cancel:   { type: 'cancel' }

/* ────────────────────────────────────────────────────────────────
 * Utilities
 * ──────────────────────────────────────────────────────────────── */

const toPosix = (p) => p.split(PATH_SEP).join("/");
const byStablePath = (a, b) => toPosix(a).localeCompare(toPosix(b), "en");

function isNodeCore(spec) {
  const s = spec.replace(/^node:/, "");
  return builtinModules.includes(s);
}
function toNodeSpecifier(spec) {
  return `node:${spec.replace(/^node:/, "")}`;
}

/** Minimal async pool with back‑pressure */
class AsyncPool {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.q = [];
  }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          this.active--;
          if (this.q.length) this.q.shift()();
        }
      };
      this.active < this.limit ? run() : this.q.push(run);
    });
  }
}

/** Atomic write using rename (same dir) + shebang preservation upstream */
async function writeFileAtomic(path, data) {
  const tmp = path + `.rawnode-esm.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Deterministic, tolerant BFS directory walk with async I/O and skip rules */
async function* walkBFS(root, { excludeNames = new Set(["node_modules", ".git", "dist", "build", ".cache"]) } = {}) {
  const Q = [root];
  while (Q.length) {
    const dir = Q.shift();
    let dh;
    try {
      dh = await opendir(dir);
    } catch {
      continue;
    }
    const entries = [];
    for await (const ent of dh) entries.push(ent);
    // dirs first, then files; stable, locale‑fixed
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, "en") : a.isDirectory() ? -1 : 1));
    for (const ent of entries) {
      const name = ent.name;
      if (excludeNames.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // avoid cycles
      if (st.isDirectory()) {
        Q.push(full);
        continue;
      }
      yield full;
    }
    // yield to keep the worker’s event loop responsive
    await sleep(0);
  }
}

/** Memoized file/directory checks */
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
function makeResolveImportPath({ risk = "safe" } = {}) {
  const exts = [".js", ".cjs", ".mjs"];
  let calls = 0;
  return async function resolveImportPath(mod, baseDir) {
    const isRelative = mod.startsWith("./") || mod.startsWith("../") || mod.startsWith("/");
    if (!isRelative) {
      // Normalize node core to node: prefix
      return isNodeCore(mod) ? toNodeSpecifier(mod) : mod;
    }
    const abs = pathResolve(baseDir, mod);
    // exact file?
    if (await isFile(abs)) return toPosix(mod);
    // try extension probing (only if risk !== 'strict')
    for (const ext of exts) {
      if (await isFile(abs + ext)) return toPosix(mod + ext);
    }
    // try index.* in directory
    const idxs = ["/index.js", "/index.cjs", "/index.mjs"];
    for (const idx of idxs) {
      if (await isFile(abs + idx)) return toPosix((mod.replace(/\/$/, "") + idx));
    }
    // No blind fallback to index.js—preserve as‑is (safer)
    return toPosix(mod);
  };
}

/** Lightweight scope detection */
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

/** Async replace helper for regex with async replacer */
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

/** createRequire shim injector (only if needed) */
function insertRequireShimIfNeeded(code) {
  // already present?
  if (/\bcreateRequire\s+as\s+__createRequire\b/.test(code) || /\b__createRequire\(/.test(code)) return code;
  if (!/\brequire\s*\(/.test(code) && !/\brequire\.resolve\s*\(/.test(code)) return code;

  const header = `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`;
  // preserve shebang if present; otherwise insert at top
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    if (nl > -1) return code.slice(0, nl + 1) + header + code.slice(nl + 1);
  }
  return header + code;
}

/** __dirname/__filename shim injector */
function insertDirnameShimIfNeeded(code) {
  if (!/\b__dirname\b|\b__filename\b/.test(code)) return code;
  if (/\bfileURLToPath\s*\(\s*import\.meta\.url\s*\)/.test(code) && /const\s+__filename\b/.test(code)) return code;

  const hdr = `import { fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = __dirname_fn(__filename);
`;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    if (nl > -1) return code.slice(0, nl + 1) + hdr + code.slice(nl + 1);
  }
  return hdr + code;
}

/* ────────────────────────────────────────────────────────────────
 * Core transform (extended coverage)
 * ──────────────────────────────────────────────────────────────── */
async function transformFile(originalCode, absPath, { risk = "safe" } = {}) {
  let code = originalCode;
  const baseDir = pathDirname(absPath);
  const scopes = detectScopes(code);
  const topDecls = [];             // hoisted imports / shims
  const seenDeclText = new Set();  // dedupe hoists
  let changed = false;

  const resolveImportPath = makeResolveImportPath({ risk });

  const hoistOnce = (text) => {
    if (seenDeclText.has(text)) return;
    seenDeclText.add(text);
    topDecls.push(text);
  };

  // Helper: normalize specifier (node: prefix for core)
  const normalizeSpec = async (spec) => {
    if (isNodeCore(spec)) return toNodeSpecifier(spec);
    return await resolveImportPath(spec, baseDir);
  };

  // ────────────────────────────────────────────────────────────────
  // 1) Top-level side‑effect requires: require('x'); → import 'x';
  // ────────────────────────────────────────────────────────────────
  code = await replaceAsyncAll(
    code,
    /(^|\n)(\s*)require\s*\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx) => {
      const prefix = m[1] ?? "", indent = m[2] ?? "";
      const spec = m[4];
      if (isInside(idx, scopes)) {
        // inside scope → dynamic side-effect
        changed = true;
        const imp = await normalizeSpec(spec);
        return `${prefix}${indent}await import("${imp}");`;
      } else {
        changed = true;
        const imp = await normalizeSpec(spec);
        return `${prefix}${indent}import "${imp}";`;
      }
    }
  );

  // ────────────────────────────────────────────────────────────────
  // 2) Multi-declarator var/let/const blocks
  //    let a = require('x'), b = require('../y'), c = 1;
  //    - Replaces only RHS require(...) sub-expressions (surgical)
  //    - Hoists imports; Node core → namespace; others per risk
  // ────────────────────────────────────────────────────────────────
  code = await replaceAsyncAll(
    code,
    /(^|\n)(\s*)(var|let|const)\s+([^;]+);?/g,
    async (m, idx, src) => {
      const [_full, bol, indent, kind, declarators] = m;
      // Only process actual top-level declarations; inside function → dynamic import strategy
      const inScope = isInside(idx, scopes);

      // Split declarators by commas, respecting basic nesting/strings
      const parts = [];
      let cur = "", depthP = 0, depthB = 0, depthC = 0, str = null, esc = false;
      for (let i = 0; i < declarators.length; i++) {
        const c = declarators[i];
        if (str) {
          cur += c;
          if (!esc && c === str) str = null;
          esc = !esc && c === "\\";
          continue;
        }
        if (c === "'" || c === '"' || c === "`") { str = c; cur += c; continue; }
        if (c === "(") depthP++;
        else if (c === ")") depthP = Math.max(0, depthP - 1);
        else if (c === "[") depthB++;
        else if (c === "]") depthB = Math.max(0, depthB - 1);
        else if (c === "{") depthC++;
        else if (c === "}") depthC = Math.max(0, depthC - 1);

        if (c === "," && depthP === 0 && depthB === 0 && depthC === 0) {
          parts.push(cur.trim()); cur = "";
        } else {
          cur += c;
        }
      }
      if (cur.trim()) parts.push(cur.trim());

      let anyChanged = false;
      const rewritten = await Promise.all(parts.map(async (decl) => {
        // Patterns we handle (keep conservative):
        // name = require('spec')
        // name = require('spec').member(...?)  |  name = require('spec').member
        // { a,b } = require('spec')            |  {promises: fs} = require('fs')
        // name = require(expr)                 |  dynamic variable path
        const RE_REQ_LIT  = /^\s*([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\s*$/;
        const RE_REQ_MEM  = /^\s*([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\.([A-Za-z_$][\w$]*)(\s*\([^)]*\))?\s*$/;
        const RE_DESTR    = /^\s*\{\s*([^}]+)\s*\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\s*$/;
        const RE_ALIAS    = /^\s*\{\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\3\s*\)\s*$/;
        const RE_REQ_VAR  = /^\s*([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*([^)]+)\s*\)\s*$/;

        // 2.1 simple literal require
        let m1 = decl.match(RE_REQ_LIT);
        if (m1) {
          anyChanged = true; changed = true;
          const [, name, _q, spec0] = m1;
          const spec = await normalizeSpec(spec0);
          if (inScope) {
            // inside function/try → dynamic
            return `${name} = await import("${spec}")`;
          }
          if (isNodeCore(spec)) {
            const ns = `__ns_${name}`;
            hoistOnce(`import * as ${ns} from '${spec}';`);
            return `${name} = ${ns}`;
          }
          if (risk === "aggressive") {
            hoistOnce(`import ${name} from '${spec}';`);
            return `/* moved import for ${name} */ ${name} = ${name}`;
          } else {
            const ns = `__ns_${name}`;
            hoistOnce(`import * as ${ns} from '${spec}';`);
            return `${name} = ${ns}.default ?? ${ns}`;
          }
        }

        // 2.2 require('x').member[ (args) ]
        let m2 = decl.match(RE_REQ_MEM);
        if (m2) {
          anyChanged = true; changed = true;
          const [, name, _q, spec0, member, call = ""] = m2;
          const spec = await normalizeSpec(spec0);
          if (inScope) {
            // dynamic
            return `${name} = (await import("${spec}")).${member}${call}`;
          }
          const ns = `__ns_${name}`;
          hoistOnce(`import * as ${ns} from '${spec}';`);
          return `${name} = ${ns}.${member}${call}`;
        }

        // 2.3 destructure: { a,b } = require('x')
        let m3 = decl.match(RE_DESTR);
        if (m3) {
          anyChanged = true; changed = true;
          const [, names, _q, spec0] = m3;
          const spec = await normalizeSpec(spec0);
          if (inScope) return `{ ${names.trim()} } = await import("${spec}")`;
          // safe path: namespace + local destructure binding
          const ns = `__ns_${names.split(',')[0].trim().replace(/[^A-Za-z0-9_$]/g,'_')||'ns'}`;
          hoistOnce(`import * as ${ns} from '${spec}';`);
          return `{ ${names.trim()} } = ${ns}`;
        }

        // 2.4 alias destructure: { promises: fs } = require('fs')
        let m4 = decl.match(RE_ALIAS);
        if (m4) {
          anyChanged = true; changed = true;
          const [, member, alias, _q, spec0] = m4;
          const spec = await normalizeSpec(spec0);
          if (inScope) return `${alias} = (await import("${spec}")).${member}`;
          const ns = `__ns_${alias}`;
          hoistOnce(`import * as ${ns} from '${spec}';`);
          return `${alias} = ${ns}.${member}`;
        }

        // 2.5 dynamic variable path: const plugin = require(entryPath);
        let m5 = decl.match(RE_REQ_VAR);
        if (m5) {
          anyChanged = true; changed = true;
          const [, name, variableExpr] = m5;
          // dynamic require → await import(expr) (both in and out of scope; top-level TLA is OK in ESM)
          return `${name} = await import(${variableExpr.trim()})`;
        }

        // No change for this declarator
        return decl;
      }));

      if (!anyChanged) return m[0]; // unchanged

      // Reassemble statement
      const rebuilt = `${bol}${indent}${kind} ${rewritten.join(", ")};`;
      return rebuilt;
    }
  );

  // ────────────────────────────────────────────────────────────────
  // 3) Non-declaration assignments:  foo = require('x');  (top-level vs scope)
  // ────────────────────────────────────────────────────────────────
  code = await replaceAsyncAll(
    code,
    /(^|[^\w$])([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\3\s*\)\s*;?/g,
    async (m, idx) => {
      const pre = m[1], name = m[2], spec0 = m[4];
      const spec = await normalizeSpec(spec0);
      changed = true;
      if (isInside(idx, scopes)) {
        return `${pre}${name} = await import("${spec}")`;
      }
      if (isNodeCore(spec)) {
        const ns = `__ns_${name}`;
        hoistOnce(`import * as ${ns} from '${spec}';`);
        return `${pre}${name} = ${ns}`;
      }
      if (risk === "aggressive") {
        hoistOnce(`import ${name} from '${spec}';`);
        return `${pre}/* moved import for ${name} */ ${name} = ${name}`;
      } else {
        const ns = `__ns_${name}`;
        hoistOnce(`import * as ${ns} from '${spec}';`);
        return `${pre}${name} = ${ns}.default ?? ${ns}`;
      }
    }
  );

  // ────────────────────────────────────────────────────────────────
  // 4) Call-form: const x = require('mod')(args)
  // ────────────────────────────────────────────────────────────────
  code = await replaceAsyncAll(
    code,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*\(([^)]*)\)\s*;?/g,
    async (m, idx) => {
      const [, name, _q, spec0, args] = m;
      const spec = await normalizeSpec(spec0);
      changed = true;
      if (isInside(idx, scopes)) {
        return `const ${name} = await (async()=> (await import("${spec}")).default(${args}))();`;
      }
      const ns = `__ns_${name}`;
      hoistOnce(`import * as ${ns} from '${spec}';`);
      return `const ${name} = (${ns}.default ?? ${ns})(${args});`;
    }
  );

  // ────────────────────────────────────────────────────────────────
  // 5) Member-form: const x = require('mod').member(…?)  |  .member
  // ────────────────────────────────────────────────────────────────
  code = await replaceAsyncAll(
    code,
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\.([A-Za-z_$][\w$]*)(\([^)]*\))?\s*;?/g,
    async (m, idx) => {
      const [, name, _q, spec0, member, call = ""] = m;
      const spec = await normalizeSpec(spec0);
      changed = true;
      if (isInside(idx, scopes)) {
        return `const ${name} = await (async()=> (await import("${spec}")).${member}${call})()`;
      }
      const ns = `__ns_${name}`;
      hoistOnce(`import * as ${ns} from '${spec}';`);
      return `const ${name} = ${ns}.${member}${call};`;
    }
  );

  // ────────────────────────────────────────────────────────────────
  // 6) require.resolve('x') → inject createRequire shim (no callsite change)
  // ────────────────────────────────────────────────────────────────
  if (/\brequire\.resolve\s*\(/.test(code)) {
    hoistOnce(`import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);`);
    changed = true;
  }

  // ────────────────────────────────────────────────────────────────
  // 7) module.exports / exports.*
  // ────────────────────────────────────────────────────────────────
  let hasDefault = false;
  code = code.replace(/module\.exports\s*=\s*([^;]+)/g, (_, rhs) => {
    hasDefault = true; changed = true;
    return `export default ${rhs}`;
  });
  code = code.replace(/\bexports\.([A-Za-z$_][\w$]*)\s*=\s*(?!require)([^;\n]+)/g, (_, key, rhs) => {
    changed = true;
    return `export const ${key} = ${rhs}`;
  });
  code = code.replace(/\bmodule\.exports\.([A-Za-z$_][\w$]*)\s*=\s*([^;\n]+)/g, (_, key, rhs) => {
    changed = true;
    return hasDefault ? `export { ${rhs} as ${key} };` : `export const ${key} = ${rhs}`;
  });

  // 8) Top-of-file hoist (deduped); preserve shebang
  if (topDecls.length) {
    const shebang = code.startsWith("#!") ? code.split("\n", 1)[0] : null;
    const body = shebang ? code.slice(shebang.length + 1) : code;
    code = (shebang ? `${shebang}\n` : "") + `${topDecls.join("\n")}\n\n` + body;
  }

  // 9) __dirname/__filename shim as needed
  code = insertDirnameShimIfNeeded(code);

  // 10) require shim if any require(...) remains (including dynamic paths)
  if (/\brequire\s*\(/.test(code) || /\brequire\.resolve\s*\(/.test(code)) {
    code = insertRequireShimIfNeeded(code);
  }

  return { code, changed };
}

/* ────────────────────────────────────────────────────────────────
 * replaceRequire(dir, dryRun) — orchestrator
 * ──────────────────────────────────────────────────────────────── */
async function replaceRequire(dir, dryRun, opts = {}) {
  const includeExts = new Set((opts.includeExts ?? [".js", ".cjs"]).map((s) => s.toLowerCase()));
  const excludeNames = new Set(opts.excludeNames ?? ["node_modules", ".git", "dist", "build", ".cache"]);
  const concurrency = Math.max(1, Number(opts.concurrency ?? Math.min(32, os.cpus().length * 2)));
  const progressEveryMs = Number(opts.progressEveryMs ?? 300);
  const risk = opts.risk === "aggressive" ? "aggressive" : "safe";

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
  files.sort(byStablePath); // deterministic

  const promises = [];
  for (const file of files) {
    if (aborted) break;
    promises.push(
      pool.schedule(async () => {
        try {
          const before = await readFile(file, "utf8");
          const { code, changed } = await transformFile(before, file, { risk });
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
              processed,
              converted,
              throughput: Number((processed / (elapsed + 1e-3)).toFixed(1)),
              concurrency,
              // Back‑compat fields:
              batchSize: concurrency,
              avgMsPerBatch: Number(avgMsPerBatch.toFixed(2)),
            });
            lastEmittedProcessed = processed;
            lastEmit = now;
          }
        }
      })
    );
    if (processed % 64 === 0) await Promise.resolve(); // keep event loop fluid
  }

  // Optional overall timeout
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
      risk: msg.risk
    });
    const durationMs = performance.now() - start;
    parentPort?.postMessage({ type: "done", dir: msg.dir, converted, durationMs, protocol: WORKER_PROTOCOL_V1, threadId });
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

export {}; // ESM marker
