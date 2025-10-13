#!/usr/bin/env node
import { convert } from '../src/index.mjs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
function parseArgs(args) {
  const opts = {
    roots: [], risk: 'safe', concurrency: undefined,
    include: ['**/*.js','**/*.cjs'], exclude: ['node_modules/**','dist/**'],
    dryRun: false, check: false, report: 'pretty', printDiff: false,
    plugins: [], timeout: 0, cacheDir: './.rawnode-esm',
    tla: false, resolveStrategy: 'require', planOnly: false, specifiers: 'node'
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { opts.roots.push(a); continue; }
    const next = () => args[++i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--check': opts.check = true; break;
      case '--fix': opts.dryRun = false; break;
      case '--risk': opts.risk = next(); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--include': opts.include = next().split(','); break;
      case '--exclude': opts.exclude = next().split(','); break;
      case '--report': opts.report = next(); break;
      case '--print-diff': opts.printDiff = true; break;
      case '--plugins': opts.plugins = next().split(','); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--cache-dir': opts.cacheDir = next(); break;
      case '--tla': opts.tla = next() === 'ok'; break;
      case '--resolve': opts.resolveStrategy = next(); break;
      case '--plan-only': opts.planOnly = true; break;
      case '--specifiers': opts.specifiers = next(); break;
      default: console.error(`Unknown option: ${a}`); process.exit(1);
    }
  }
  if (opts.roots.length === 0) opts.roots = ['.'];
  return opts;
}

(async () => {
  try {
    const opts = parseArgs(argv);
    const result = await convert({
      ...opts,
      plugins: await Promise.all(opts.plugins.filter(Boolean).map(async p => {
        const mod = await import(p);
        return (mod.setup ?? mod.default?.setup ?? (() => ({})))(/* ctx injected by convert */);
      }))
    });
    if (opts.check && result.changedCount > 0) process.exit(2);
  } catch (e) {
    const name = basename(fileURLToPath(import.meta.url));
    console.error(`[${name}] error:`, e?.stack || e);
    process.exit(1);
  }
})();
