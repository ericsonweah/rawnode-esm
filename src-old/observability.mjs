import { performance } from 'node:perf_hooks';
import { writeFile, readFile } from 'node:fs/promises';

export async function initObservers(cfg) {
  const t0 = performance.now();
  const events = [];
  const logger = {
    info:o=>events.push({ts:performance.now(),level:'info',...o}),
    warn:o=>events.push({ts:performance.now(),level:'warn',...o}),
    error:o=>events.push({ts:performance.now(),level:'error',...o}),
  };
  function emit(evt) { events.push({ ts: performance.now(), ...evt }); cfg.onProgress?.(evt); }
  async function writeFile2(p, c) { return writeFile(p, c, 'utf8'); }
  async function readFile2(p) { return readFile(p, 'utf8'); }
  return {
    emit, logger,
    readFile: readFile2, writeFile: writeFile2,
    metrics: { inc:()=>{}, time: async (_n, fn)=> fn() },
    warn: (d)=>emit({ type:'warn', diag:d }),
    start: t0,
    cfg, events
  };
}

export async function finishObservers(ctx, summary) {
  ctx.emit({ type: 'summary', summary, ms: (performance.now()-ctx.start)|0 });
  return summary;
}
