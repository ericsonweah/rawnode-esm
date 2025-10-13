#!/usr/bin/env node

// /bin/rawnode-esm.mjs
import { parseArgs } from 'node:util';
import { convert } from '../src/index.mjs';
import os from 'node:os';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    fix: { type: 'boolean', default: false },
    risk: { type: 'string', default: 'safe' },
    concurrency: { type: 'string' },
    include: { type: 'string' },
    exclude: { type: 'string' },
    plugins: { type: 'string' },
    report: { type: 'string', default: 'pretty' },
    'print-diff': { type: 'boolean', default: false },
    'cache-dir': { type: 'string', default: './.rawnode-esm' },
    timeout: { type: 'string' },
    'plan-only': { type: 'boolean', default: false },
    'resolve-policy': { type: 'string', default: 'node-prefix' }
  }
});

const cfg = {
  roots: positionals.length ? positionals : ['.'],
  dryRun: values['dry-run'],
  check: values.check,
  fix: values.fix,
  risk: values.risk === 'aggressive' ? 'aggressive' : 'safe',
  concurrency: Math.max(1, Number(values.concurrency ?? Math.min(8, os.cpus().length))),
  include: (values.include ?? '**/*.js,**/*.cjs').split(',').map(s => s.trim()),
  exclude: (values.exclude ?? 'node_modules/**,dist/**').split(',').map(s => s.trim()),
  plugins: (values.plugins ?? '').split(',').map(s => s.trim()).filter(Boolean),
  report: values.report === 'json' ? 'json' : 'pretty',
  printDiff: values['print-diff'],
  cacheDir: values['cache-dir'],
  timeout: Number(values.timeout ?? 0) || 0,
  planOnly: !!values['plan-only'],
  resolvePolicy: values['resolve-policy']
};

const loadedPlugins = [];
for (const p of cfg.plugins) {
  const mod = await import(p);
  loadedPlugins.push(mod);
}
const res = await convert({ ...cfg, plugins: loadedPlugins, onProgress: () => {} });

if (cfg.check && (res.changedFiles > 0 || res.errors > 0)) process.exit(1);
