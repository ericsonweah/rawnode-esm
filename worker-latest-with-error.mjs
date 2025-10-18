"use strict";

// /src/worker.mjs — enterprise‑grade, non‑blocking worker for RawNode ESM converter
// - Keeps { dir, dryRun } message contract and progress/done/error/warn events.
// - Fully async I/O; bounded concurrency; deterministic ordering; atomic writes.
// - Cancellation + optional timeout support.
// - Preserves your regex-based transforms & behaviors.
// - NEW: comment/string mask to avoid converting code inside comments/strings.
// - NEW: import header de‑duplication by binding + warn diagnostics.

import { parentPort, threadId } from "node:worker_threads";
import { opendir, lstat, stat, readFile, writeFile, rename } from "node:fs/promises";
import { constants as FS } from "node:fs";
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
async function* walkBFS(root, { excludeNames = new Set(["node_modules", ".git"]) } = {}) {
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
    // sort: dirs first, then files; stable, locale‑fixed
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name, "en")
        : a.isDirectory()
        ? -1
        : 1
    );
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

/** Memoized stat checks */
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
    if (!isRelative) return mod; // builtins or packages unchanged (preserve your old behavior)
    const abs = pathResolve(baseDir, mod);
    const filePath = `${abs}.js`;
    const indexPath = join(abs, "index.js");
    // micro‑yield every ~50 calls
    if (++calls % 50 === 0) await Promise.resolve();
    try {
      if (await isFile(filePath)) return `${mod}.js`;
      if (await isFile(indexPath)) return `${mod.replace(/\/$/, "")}/index.js`;
      // default fallback (unchanged behavior)
      return `${mod.replace(/\/$/, "")}/index.js`;
    } catch {
      return `${mod.replace(/\/$/, "")}/index.js`;
    }
  };
}

/** Lightweight scope detection (same as before, but factored) */
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

/* ────────────────────────────────────────────────────────────────
 * NEW: comment/string mask + guarded replacements
 * ──────────────────────────────────────────────────────────────── */

/** Build a mask of comment & string ranges so we never transform inside them. */
function makeCommentStringMask(src) {
  const ranges = [];
  let i = 0, start = -1;
  let inSL = false, inML = false, inS = false, inD = false, inTpl = false, esc = false;

  while (i < src.length) {
    const c = src[i], n = src[i + 1];

    if (inSL) { if (c === "\n") { ranges.push([start, i]); inSL = false; } i++; continue; }
    if (inML) { if (c === "*" && n === "/") { i += 2; ranges.push([start, i]); inML = false; } else i++; continue; }
    if (inS)  { if (!esc && c === "'") { inS = false; ranges.push([start, i + 1]); } esc = !esc && c === "\\"; i++; continue; }
    if (inD)  { if (!esc && c === '"') { inD = false; ranges.push([start, i + 1]); } esc = !esc && c === "\\"; i++; continue; }
    if (inTpl){
      if (!esc && c === "`") { inTpl = false; ranges.push([start, i + 1]); i++; continue; }
      esc = !esc && c === "\\";
      i++; continue;
    }

    if (c === "/" && n === "/") { start = i; inSL = true; i += 2; continue; }
    if (c === "/" && n === "*") { start = i; inML = true; i += 2; continue; }
    if (c === "'") { start = i; inS = true; i++; continue; }
    if (c === '"') { start = i; inD = true; i++; continue; }
    if (c === "`"){ start = i; inTpl = true; i++; continue; }

    i++;
  }
  // helper: binary search-ish check
  function isMasked(idx) {
    // linear is fine; files are not huge, and we call sparsely
    for (let k = 0; k < ranges.length; k++) {
      const [s, e] = ranges[k];
      if (idx < s) return false;
      if (idx >= s && idx < e) return true;
    }
    return false;
  }
  return isMasked;
}

/** Async replace helper that skips matches inside masked (comment/string) regions */
async function replaceAsyncAllGuarded(src, re, replacer, isMasked) {
  re.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    const idx = m.index;
    const next = idx + m[0].length;
    if (isMasked(idx)) {
      out += src.slice(last, next); // keep as-is
    } else {
      out += src.slice(last, idx) + (await replacer(m, idx, src));
    }
    last = next;
  }
  out += src.slice(last);
  return out;
}

/** Sync guard for simple .replace cases */
function replaceAllGuarded(src, re, fn, isMasked) {
  re.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    const idx = m.index;
    const next = idx + m[0].length;
    if (isMasked(idx)) {
      out += src.slice(last, next);
    } else {
      out += src.slice(last, idx) + fn(m, idx, src);
    }
    last = next;
  }
  out += src.slice(last);
  return out;
}

/** Idempotent "createRequire" shim injector for ESM files that still use require() */
function insertRequireShimIfNeeded(code) {
  if (/\bcreateRequire\s+as\s+__createRequire\b/.test(code) || /\b__createRequire\(/.test(code)) return code;
  // NOTE: We only check *unmasked* occurrences later; this is a final safeguard.
  const header = `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    if (nl > -1) return code.slice(0, nl + 1) + header + code.slice(nl + 1);
  }
  return header + code;
}

/* ────────────────────────────────────────────────────────────────
 * Core transform (preserves your original logic & ordering)
 * ──────────────────────────────────────────────────────────────── */
async function transformFile(originalCode, absPath) {
  let code = originalCode;
  const baseDir = pathDirname(absPath);
  const scopes = detectScopes(code);
  const isMasked = makeCommentStringMask(code);
  const topLevelImports = [];
  const seenImports = new Set();
  const resolveImportPath = makeResolveImportPath();
  let changed = false;

  // require('mod')(args)
  code = await replaceAsyncAllGuarded(
    code,
    /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\(([^)]*)\);?/g,
    async (m, idx) => {
      const [, name, mod, args] = m;
      const imp = await resolveImportPath(mod, baseDir);
      if (isInside(idx, scopes))
        return `const ${name} = await (async()=> (await import("${imp}")).default(${args}))();`;
      topLevelImports.push(`import tmp_${name} from "${imp}";`);
      changed = true;
      return `const ${name} = tmp_${name}(${args});`;
    },
    isMasked
  );

  // require('mod').member or call
  code = await replaceAsyncAllGuarded(
    code,
    /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)\.([A-Za-z$_][\w$]*)(\([^)]*\))?/g,
    async (m, idx) => {
      const [, name, mod, member, call = ""] = m;
      const imp = await resolveImportPath(mod, baseDir);
      if (isInside(idx, scopes))
        return `const ${name} = await (async()=> (await import("${imp}")).${member}${call})();`;
      topLevelImports.push(`import * as __tmp_${name} from "${imp}";`);
      changed = true;
      return `const ${name} = __tmp_${name}.${member}${call};`;
    },
    isMasked
  );

  // const/let/var x = require('mod')  — keep semantics; shim will be injected below.
  let __needsRequireShim = false;
  // detect (unmasked) bare assignment require to decide on require shim:
  {
    const reAssign = /(^|[^\w$])([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?/gm;
    let m;
    while ((m = reAssign.exec(code))) {
      if (!isMasked(m.index)) { __needsRequireShim = true; break; }
    }
  }

  // const name = require('mod');
  code = await replaceAsyncAllGuarded(
    code,
    /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
    async (m, idx) => {
      const [, name, mod] = m;
      const imp = await resolveImportPath(mod, baseDir);
      if (isInside(idx, scopes)) return `const ${name} = await (async()=> await import("${imp}"))();`;
      topLevelImports.push(`import ${name} from "${imp}";`);
      changed = true;
      return `// moved import for ${name}`;
    },
    isMasked
  );

  // alias destructuring: const { promises: fs } = require("fs");
  code = await replaceAsyncAllGuarded(
    code,
    /const\s*\{\s*([A-Za-z$_][\w$]*)\s*:\s*([A-Za-z$_][\w$]*)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
    async (m, idx) => {
      const [, member, alias, mod] = m;
      const imp = await resolveImportPath(mod, baseDir);
      if (isInside(idx, scopes)) return `const ${alias} = await (async()=> (await import("${imp}")).${member})()`;
      topLevelImports.push(`import * as __tmp_${alias} from "${imp}";`);
      changed = true;
      return `// moved import for ${alias}\nconst ${alias} = __tmp_${alias}.${member};`;
    },
    isMasked
  );

  // destructured require: const { a,b } = require('mod')
  code = await replaceAsyncAllGuarded(
    code,
    /const\s*\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
    async (m, idx) => {
      const [, names, mod] = m;
      const imp = await resolveImportPath(mod, baseDir);
      if (isInside(idx, scopes)) return `const { ${names.trim()} } = await (async()=> await import("${imp}"))();`;
      topLevelImports.push(`import { ${names.trim()} } from "${imp}";`);
      changed = true;
      return `// moved import for { ${names.trim()} }`;
    },
    isMasked
  );

  // Bare assignment requires (non-const)
  code = await replaceAsyncAllGuarded(
    code,
    /^\s*([A-Za-z_$][\w$]*)\s*=\s*require\(['"]([^'"]+)['"]\)\s*;?/gm,
    async (match, idx, src) => {
      const [, name, mod] = match;
      const imp = await resolveImportPath(mod, baseDir);
      // detect if inside try/catch (local context)
      const before = src.slice(Math.max(0, idx - 200), idx);
      const inTry = /\btry\s*\{[^}]*$/.test(before);
      changed = true;
      return inTry ? `${name} = await import("${imp}");` : `import ${name} from "${imp}";`;
    },
    isMasked
  );

  // Dynamic variable requires (variable module path) — e.g. const plugin = require(entryPath);
  code = await replaceAsyncAllGuarded(
    code,
    /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*([^)]+)\s*\)\s*;?/gm,
    async (match) => {
      const [, name, variable] = match;
      changed = true;
      return `// dynamic require (variable path)\nconst ${name} = await import(${variable});`;
    },
    isMasked
  );

  /* ────────────────────────────────────────────────────────────────
   * Exports — robust (multi-line-safe)
   * ──────────────────────────────────────────────────────────────── */

  // Find statement end (strings/templates/braces aware enough for our use)
  function findStmtEnd(src, from) {
    let i = from, depth = 0, str = null, tpl = false, esc = false;
    while (i < src.length) {
      const c = src[i];
      if (str) { if (!esc && c === str) str = null; esc = !esc && c === "\\"; i++; continue; }
      if (tpl) { if (!esc && c === "`") { tpl = false; i++; continue; } esc = !esc && c === "\\"; i++; continue; }
      if (c === "'" || c === '"') { str = c; i++; continue; }
      if (c === "`") { tpl = true; i++; continue; }
      if (c === "(" || c === "{" || c === "[") { depth++; i++; continue; }
      if (c === ")" || c === "}" || c === "]") { depth--; i++; continue; }
      if (c === ";" && depth === 0) { i++; break; }
      i++;
    }
    return i;
  }

  // module.exports = RHS;
  code = await replaceAsyncAllGuarded(
    code,
    /(^|\n)\s*module\.exports\s*=\s*/g,
    async (m, idx, src) => {
      const lead = m[1] || "";
      const start = idx + m[0].length;
      const end = findStmtEnd(src, start);
      const rhs = src.slice(start, end).trim().replace(/;$/, "");
      changed = true;
      return `${lead}export default ${rhs};`;
    },
    isMasked
  );

  // module.exports.name = RHS;  →  export const name = RHS
  code = await replaceAsyncAllGuarded(
    code,
    /(^|\n)\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=\s*/g,
    async (m, idx, src) => {
      const lead = m[1] || "";
      const key = m[2];
      const start = idx + m[0].length;
      const end = findStmtEnd(src, start);
      const rhs = src.slice(start, end).trim().replace(/;$/, "");
      changed = true;
      return `${lead}export const ${key} = ${rhs};`;
    },
    isMasked
  );

  // exports.name = RHS;  →  export const name = RHS
  code = await replaceAsyncAllGuarded(
    code,
    /(^|\n)\s*exports\.([A-Za-z_$][\w$]*)\s*=\s*/g,
    async (m, idx, src) => {
      const lead = m[1] || "";
      const key = m[2];
      const start = idx + m[0].length;
      const end = findStmtEnd(src, start);
      const rhs = src.slice(start, end).trim().replace(/;$/, "");
      changed = true;
      return `${lead}export const ${key} = ${rhs};`;
    },
    isMasked
  );

  // Annotate *unmasked* dynamic require mentions (kept behavior)
  code = replaceAllGuarded(
    code,
    /\brequire\(([^)"']+)\)/g,
    (m) => `/* TODO dynamic require → await import(${m[1]}.js) */ ${m[0]}`,
    isMasked
  );

  /* ────────────────────────────────────────────────────────────────
   * Hoist imports (unique + binding de‑dup)
   * ──────────────────────────────────────────────────────────────── */

  // 1) Unique by text
  let importLines = [];
  if (topLevelImports.length) {
    const uniq = topLevelImports.filter((t) => {
      if (seenImports.has(t)) return false;
      seenImports.add(t);
      return true;
    });
    importLines = uniq;
  }

  // 2) De‑dup by declared bindings (avoid duplicate identifiers like EventEmitter/fs)
  if (importLines.length) {
    const declared = new Map(); // name -> {spec,line}
    const kept = [];
    const nameRE = /^[A-Za-z_$][\w$]*$/;

    function recordOrWarn(names, spec, line) {
      let conflict = null;
      for (const n of names) {
        if (!nameRE.test(n)) continue;
        if (declared.has(n)) {
          const prev = declared.get(n);
          // emit a non-fatal warn — we drop the *later* line to avoid syntax error
          parentPort?.postMessage({
            type: "warn",
            file: absPath,
            code: "DUPLICATE_IMPORT_BINDING",
            name: n,
            keptSpec: prev.spec,
            droppedSpec: spec,
            message: `Duplicate import binding "${n}" from "${spec}" dropped (already declared from "${prev.spec}").`,
          });
          conflict = true;
        }
      }
      if (!conflict) {
        kept.push(line);
        for (const n of names) if (nameRE.test(n)) declared.set(n, { spec, line });
      }
    }

    for (const line of importLines) {
      // default import: import X from 'spec'
      let m = line.match(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
      if (m) { recordOrWarn([m[1]], m[2], line); continue; }
      // namespace: import * as NS from 'spec'
      m = line.match(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
      if (m) { recordOrWarn([m[1]], m[2], line); continue; }
      // named: import { a, b as c } from 'spec'
      m = line.match(/^\s*import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
      if (m) {
        const spec = m[2];
        const raw = m[1].split(",").map((s) => s.trim()).filter(Boolean);
        const names = raw.map((item) => {
          const mm = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          return mm ? (mm[2] || mm[1]) : null;
        }).filter(Boolean);
        recordOrWarn(names, spec, line);
        continue;
      }
      // unknown form; keep as-is
      kept.push(line);
    }
    importLines = kept;
  }

  // 3) Insert header with shebang preservation
  if (importLines.length) {
    const shebang = code.startsWith("#!") ? code.split("\n", 1)[0] : null;
    const body = shebang ? code.slice(shebang.length + 1) : code;
    code = (shebang ? `${shebang}\n` : "") + `${importLines.join("\n")}\n\n` + body;
  }

  // Optional shim injection if any *unmasked* require() survived
  if (__needsRequireShim || /\brequire\s*\(/.test(code.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))) {
    code = insertRequireShimIfNeeded(code);
  }

  // Guard: flag accidental “export { function … as … }”
  if (/export\s*\{\s*function\b/.test(code)) {
    parentPort?.postMessage({
      type: "warn",
      file: absPath,
      code: "CJS-GUARD-EXPORT-FN-BRACES",
      message:
        "Suspicious pattern `export { function … as … }` detected post-transform. Expected `export const name = function …`.",
    });
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
  let lastEmittedProcessed = 0; // for local throughput/latency estimation

  const onCancel = (msg) => {
    if (msg?.type === "cancel") aborted = true;
  };
  parentPort?.on("message", onCancel);

  const files = [];
  for await (const p of walkBFS(dir, { excludeNames })) {
    // extension filter
    const low = p.toLowerCase();
    if ([...includeExts].some((ext) => low.endsWith(ext))) files.push(p);
  }
  // deterministic ordering
  files.sort(byStablePath);

  const promises = [];
  for (const file of files) {
    if (aborted) break;
    promises.push(
      pool.schedule(async () => {
        try {
          const before = await readFile(file, "utf8");
          const { code, changed } = await transformFile(before, file);
          if (changed && !dryRun) await writeFileAtomic(file, code);
          if (changed) converted++;
        } catch (e) {
          // per‑file errors do not crash the batch; report and continue
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
            const throughput = processed / (elapsed + 1e-3);
            const deltaP = processed - lastEmittedProcessed;
            const deltaMs = Math.max(1, now - lastEmit);
            const localTps = deltaP > 0 ? deltaP / (deltaMs / 1000) : 0; // files/s in this slice
            const avgMsPerBatch = localTps > 0 ? (1000 / localTps) * concurrency : 0;

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
              // 🔁 Back-compat fields expected by run.mjs:
              batchSize: concurrency,
              avgMsPerBatch: Number(avgMsPerBatch.toFixed(2)),
            });
            lastEmittedProcessed = processed;

            lastEmit = now;
          }
        }
      })
    );
    // periodic cooperative yield to keep event loop fluid while scheduling
    if (processed % 64 === 0) await Promise.resolve();
  }

  // Optional overall timeout
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const timeout = sleep(opts.timeoutMs, { ref: true }).then(() => {
      throw new Error(`Worker timeout after ${opts.timeoutMs} ms`);
    });
    await Promise.race([Promise.all(promises), timeout]);
  } else {
    await Promise.all(promises);
  }

  parentPort?.off("message", onCancel);
  if (aborted) return converted; // graceful early stop

  return converted;
}

/* ────────────────────────────────────────────────────────────────
 * Message handler
 * ──────────────────────────────────────────────────────────────── */
parentPort?.on("message", async (msg) => {
  // Back‑compat shape: { dir, dryRun }
  if (!msg || msg.type === "cancel") return; // cancel handled in replaceRequire
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

export {}; // ESM marker
