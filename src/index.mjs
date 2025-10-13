'use strict';

// /src/index.mjs

import { discover } from './discover.mjs';
import { createWorkerPool } from './worker.mjs';
import { analyze } from './analyze.mjs';
import { planFile } from './plan.mjs';
import { applyEdits } from './transform.mjs';
import { verify } from './verify.mjs';
import { Logger, Metrics } from './observability.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { hashContent, Cache } from './cache.mjs';
import { normalizePosix } from './utils.mjs';

export async function convert(config) {
  const {
    roots, include, exclude, risk, concurrency, plugins,
    dryRun, check, report, printDiff, cacheDir, planOnly, resolvePolicy
  } = config;

  const logger = new Logger({ mode: report });
  const metrics = new Metrics();
  const pluginCtx = makePluginCtx({ logger, metrics, risk, resolvePolicy });
  const hook = composePlugins(plugins, pluginCtx);

  const files = await discover({ roots, include, exclude, hook, logger });
  const pool = createWorkerPool({ size: concurrency, logger });
  const cache = new Cache(cacheDir);

  let changedFiles = 0, errors = 0, warnings = 0;
  const results = [];

  await hook.onDiscover?.(files);

  for (const file of files) {
    const abs = file.path;
    const content = await readFile(abs, 'utf8');
    const contentHash = hashContent(content);

    let facts = await cache.getFacts(abs, contentHash);
    if (!facts) facts = await pool.scan({ path: abs, content });

    await hook.onAnalyze?.(abs, facts);

    const analysis = analyze({ path: abs, facts });
    const plan = planFile({ path: abs, content, facts, analysis, risk, resolvePolicy, logger });

    await hook.onPlan?.(abs, plan);

    if (planOnly) { results.push({ file: abs, plan }); continue; }

    let out = content;
    if (plan.edits.length) {
      out = applyEdits(content, plan.edits);
      changedFiles++;
    }

    const report = await verify({ path: abs, content: out, facts, plan });
    for (const d of (plan.warnings ?? [])) { logger.warn(d.message, d); warnings++; }
    for (const d of (report.errors ?? [])) { logger.error(d.message, d); errors++; }

    await hook.onVerify?.(abs, report);

    if (!dryRun && plan.edits.length) await writeFile(abs, out);

    await cache.putFacts(abs, contentHash, facts);
    await hook.onWrite?.(abs, { changed: plan.edits.length > 0 });
    if (printDiff && plan.edits.length) logger.printDiff(content, out, normalizePosix(abs));
  }

  const summary = { files: files.length, changedFiles, warnings, errors, metrics: metrics.snapshot() };
  await hook.onEnd?.(summary);
  logger.summary(summary);
  await pool.close();
  return summary;
}

function makePluginCtx({ logger, metrics, risk, resolvePolicy }) {
  const ctx = {
    logger,
    metrics,
    riskProfile: risk,
    resolvePolicy,
    statCache: new Map(),
    addWarning(d) { logger.warn(d.message, d); },
    async read(path) { const { readFile } = await import('node:fs/promises'); return readFile(path, 'utf8'); },
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
  const hooks = mods.map(m => (m.setup?.(ctx)) ?? {});
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
