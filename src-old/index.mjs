import { discover } from './discover.mjs';
import { scanFiles } from './scan.mjs';
import { analyzeFiles } from './analyze.mjs';
import { planFiles } from './plan.mjs';
import { transformFiles } from './transform.mjs';
import { verifyFiles } from './verify.mjs';
import { initObservers, finishObservers } from './observability.mjs';
import { initCache } from './cache.mjs';
import { unifiedDiff } from './diff.mjs';

export async function convert(cfg) {
  const ctx = await initObservers(cfg);
  const cache = await initCache(cfg);
  ctx.cache = cache;

  const files = await discover(cfg, ctx);
  ctx.emit({ type: 'discover.done', files: files.length });

  const scanned = await scanFiles(files, cfg, ctx);
  const analyzed = await analyzeFiles(scanned, cfg, ctx);
  const plans = await planFiles(analyzed, cfg, ctx);

  if (cfg.planOnly) {
    ctx.emit({ type: 'plan.only', plans });
    await finishObservers(ctx, { changedCount: 0 });
    return { changedCount: 0 };
  }

  const transformed = await transformFiles(plans, cfg, ctx);
  const verified = await verifyFiles(transformed, cfg, ctx);

  let changedCount = 0;
  for (const f of verified) {
    if (cfg.dryRun) {
      if (cfg.printDiff && f.changed) {
        const diff = unifiedDiff(f.original, f.output, f.path);
        ctx.emit({ type: 'diff', file: f.path, diff });
      }
    } else {
      if (f.changed) {
        await ctx.writeFile(f.path, f.output);
        changedCount++;
      }
    }
  }

  await finishObservers(ctx, { changedCount });
  return { changedCount };
}
