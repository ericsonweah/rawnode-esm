import { performance } from 'node:perf_hooks';

export class Logger {
  constructor({ mode='pretty' }={}) { this.mode = mode; }
  info(msg, obj)  { this.#emit('info', msg, obj); }
  warn(msg, obj)  { this.#emit('warn', msg, obj); }
  error(msg, obj) { this.#emit('error', msg, obj); }
  summary(s) { this.#emit('info', 'summary', s); }
  printDiff(a, b, path) {
    const diff = renderUnifiedDiff(a, b, path);
    process.stdout.write(diff + '\n');
  }
  #emit(level, msg, obj) {
    if (this.mode === 'json') {
      process.stdout.write(JSON.stringify({ level, msg, ...obj }) + '\n');
    } else {
      const tag = level.toUpperCase().padEnd(5);
      process.stdout.write(`[${tag}] ${msg}${obj ? ' ' + JSON.stringify(obj) : ''}\n`);
    }
  }
}

export class Metrics {
  constructor() { this._c = new Map(); }
  counter(name){ const c=this._c.get(name)||{n:0}; this._c.set(name,c); return { inc:(k=1)=>{c.n+=k;} }; }
  snapshot(){ const o={}; for(const [k,v] of this._c) o[k]=v.n; return o; }
}

export function renderUnifiedDiff(a, b, path) {
  // Minimal diff: show old/new length and a simple header; (placeholder for richer diff)
  const al = a.split('\n'), bl = b.split('\n');
  const header = `--- a/${path}\n+++ b/${path}\n@@ -1,${al.length} +1,${bl.length} @@\n`;
  return header + bl.join('\n');
}
