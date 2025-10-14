
// src/run.mjs
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { normalizePosix } from '../utils.mjs';
import { discover } from '../discover.mjs';
import { createWorkerPool } from '../worker.mjs';
import { analyze } from '../analyze.mjs';
import { planFile } from '../plan.mjs';
import { applyEdits } from '../transform.mjs';
import { verify } from '../verify.mjs';
import { Logger, Metrics } from '../observability.mjs';
import { Cache, hashContent } from '../cache.mjs';

/**
 * Deterministic, non-blocking orchestrator for RAWNODE-ESM.
 * - Async I/O, bounded worker pool, back-pressure via in-flight window.
 * - Deterministic order: files discovered/sorted; reporting emitted in file order.
 * - Zero dependencies; Node 20+; `node:` specifiers only.
 */

export async function convert(config = {}) {
  const started = performance.now();
  const {
    roots = ['.'],
    include = ['**/*.js','**/*.cjs'],
    exclude = ['node_modules/**','dist/**'],
    risk = 'safe',
    concurrency = Math.max(1, Math.min(8, os.cpus().length)),
    inflight = Math.max(1, concurrency * 2),
    highWater = 64,
    lowWater = 16,
    dryRun = false,
    check = false,
    report = 'pretty',
    printDiff = false,
    cacheDir = './.rawnode-esm',
    planOnly = false,
    resolvePolicy = 'node-prefix',
    timeout = 0,
    plugins = [],
    signal = undefined,
    onProgress = () => {}
  } = config;

  const logger  = new Logger({ mode: report });
  const metrics = new Metrics();
  const pluginCtx = makePluginCtx({ logger, metrics, risk, resolvePolicy });
  const hook = composePlugins(plugins, pluginCtx);

  const abort = makeAbort(signal, timeout);
  const cache = new Cache(cacheDir);
  const files = await discover({ roots, include, exclude, hook, logger });
  await hook.onDiscover?.(files);
  onProgress({ type:'start', total: files.length });

  const pool = createWorkerPool({ size: concurrency, logger });

  // back-pressure counters
  let pending = 0;
  let drainResolve = null;
  const needDrain = () => pending > highWater;
  const drained   = () => pending <= lowWater;
  const awaitDrain = async () => {
    if (!needDrain()) return;
    await new Promise(r => (drainResolve = r));
  };
  const fileResults = new Array(files.length);
  let changedFiles = 0, errors = 0, warnings = 0;

  // process in stable order but concurrently (bounded)
  let cursor = 0;
  const next = async () => {
    if (abort.aborted) return;
    if (cursor >= files.length) return;
    const i = cursor++;
    const f = files[i];
    pending++;
    try {
      if (needDrain()) await awaitDrain();
      onProgress({ type:'file:start', file: normalizePosix(f.path), index:i });
      const t0 = performance.now();
      const res = await processOne({ f, i });
      const ms = performance.now() - t0;
      fileResults[i] = { ...res, ms };
      changedFiles += res.changed ? 1 : 0;
      warnings     += res.warnings;
      errors       += res.errors;
      onProgress({ type:'file:done', file: normalizePosix(f.path), index:i, changed:res.changed, warnings:res.warnings, errors:res.errors, ms });
    } finally {
      pending--;
      if (drainResolve && drained()) { const r = drainResolve; drainResolve = null; r(); }
      // Yield to event loop periodically
      await new Promise(r => setImmediate(r));
      // fill pipeline
      if (cursor < files.length) await next();
    }
  };

  // kick off up to inflight tasks
  const starters = [];
  for (let k=0; k<Math.min(inflight, files.length); k++) starters.push(next());
  await Promise.all(starters);

  // Emit diffs & summary in deterministic file order
  for (let i=0;i<files.length;i++) {
    const r = fileResults[i];
    if (r?.printDiff) logger.printDiff(r.before, r.after, normalizePosix(files[i].path));
  }

  const summary = {
    files: files.length,
    changedFiles,
    warnings,
    errors,
    metrics: metrics.snapshot(),
    ms: Math.round(performance.now() - started)
  };
  await hook.onEnd?.(summary);
  logger.summary(summary);
  await pool.close();

  if (check && (changedFiles > 0 || errors > 0)) {
    // surface non-zero in CLI layer, but also return summary
    summary.exitCode = 1;
  } else {
    summary.exitCode = 0;
  }
  return summary;

  /* ----------------------- per-file pipeline ---------------------------- */
  async function processOne({ f, i }) {
    abortThrowIfNeeded(abort);
    const abs = f.path;
    const before = await readFile(abs, 'utf8');
    const contentHash = hashContent(before);

    let facts = await cache.getFacts(abs, contentHash);
    if (!facts) facts = await pool.scan({ path: abs, content: before });
    await hook.onAnalyze?.(abs, facts);

    const analysis = analyze({ path: abs, facts });
    const plan = planFile({ path: abs, content: before, facts, analysis, risk, resolvePolicy, logger });
    await hook.onPlan?.(abs, plan);

    if (planOnly) {
      return { changed:false, warnings:(plan.warnings||[]).length, errors:0, before, after:before, printDiff:false };
    }

    // transform
    await hook.onTransform?.(abs, plan.edits);
    let after = before;
    if (plan.edits.length) after = applyEdits(before, plan.edits);

    // verify
    const verifyReport = await verify({ path: abs, content: after, facts, plan });
    for (const d of (plan.warnings ?? [])) { logger.warn(d.message || d.code, d); }
    for (const d of (verifyReport.errors ?? [])) { logger.error(d.message || d.code, d); }
    const warnCount = (plan.warnings ?? []).length;
    const errCount  = (verifyReport.errors ?? []).length;
    await hook.onVerify?.(abs, verifyReport);

    // write
    if (!dryRun && plan.edits.length) await writeFile(abs, after);
    await cache.putFacts(abs, contentHash, facts);
    await hook.onWrite?.(abs, { changed: plan.edits.length > 0 });

    return {
      changed: plan.edits.length > 0,
      warnings: warnCount,
      errors: errCount,
      before, after,
      printDiff: printDiff && plan.edits.length > 0
    };
  }
}

/* -------------------------- plugin plumbing ------------------------------ */
function makePluginCtx({ logger, metrics, risk, resolvePolicy }) {
  const ctx = {
    logger,
    metrics,
    riskProfile: risk,
    resolvePolicy,
    statCache: new Map(),
    addWarning(d) { logger.warn(d.message, d); },
    async read(path)  { const { readFile }  = await import('node:fs/promises'); return readFile(path, 'utf8'); },
    async write(path, s) { const { writeFile } = await import('node:fs/promises'); return writeFile(path, s); },
    createRequireShim() {
      return {
        ident: 'require',
        importText:
`import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`
      };
    },
    async resolveSpecifier(from, spec) {
      const { resolveSpecifier } = await import('./utils.mjs');
      return resolveSpecifier(from, spec, this.statCache);
    },
    registerFileDependency() {}
  };
  return ctx;
}

function composePlugins(mods, ctx) {
  const hooks = (mods || []).map(m => (m.setup?.(ctx)) ?? {});
  const wrap = name => async (...args) => {
    for (const h of hooks) if (typeof h[name] === 'function') await h[name](...args);
  };
  return {
    onDiscover: hooks.some(h=>h.onDiscover)? wrap('onDiscover'):null,
    onAnalyze:  hooks.some(h=>h.onAnalyze)?  wrap('onAnalyze'):null,
    onPlan:     hooks.some(h=>h.onPlan)?     wrap('onPlan'):null,
    onTransform:hooks.some(h=>h.onTransform)?wrap('onTransform'):null,
    onVerify:   hooks.some(h=>h.onVerify)?   wrap('onVerify'):null,
    onWrite:    hooks.some(h=>h.onWrite)?    wrap('onWrite'):null,
    onEnd:      hooks.some(h=>h.onEnd)?      wrap('onEnd'):null,
  };
}

/* ---------------------------- abort helpers ------------------------------ */
function makeAbort(signal, timeoutMs) {
  const ctl = timeoutMs > 0 ? new AbortController() : null;
  if (ctl) setTimeout(()=> ctl.abort(new Error('timeout')), timeoutMs).unref?.();
  const aborted = () => (signal?.aborted || ctl?.signal.aborted);
  return {
    get aborted() { return aborted(); },
    throwIfAborted() {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (ctl?.signal.aborted) throw new Error('timeout');
    }
  };
}
function abortThrowIfNeeded(a){ if (a.aborted) a.throwIfAborted(); }
