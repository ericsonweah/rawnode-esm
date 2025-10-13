import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { readFile } from 'node:fs/promises';

export async function scanFiles(files, cfg, ctx) {
  // For now: simple in-process scan skeleton (upgrade to workers in analyze stage).
  const results = [];
  for (const path of files) {
    const src = await readFile(path, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    // Very light recognizers to illustrate:
    const requireSites = [];
    const requireResolveSites = [];
    const hasDirname = /(^|[^.\w$])__dirname(?![\w$])/.test(src);
    const hasFilename = /(^|[^.\w$])__filename(?![\w$])/.test(src);
    const hasAMDHint = /\bdefine\s*\(/.test(src);
    const hasImportCall = /\bimport\s*\(/.test(src);

    // naive regex for require('x') — scanner module to replace with full tokenizer
    const re = /(?:^|[^\w$])require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (let m; (m = re.exec(src)); ) {
      requireSites.push({
        kind: 'top', // analyzer will refine
        calleeRange: [m.index + (m[0].indexOf('require')), m.index + m[0].indexOf(')') + 1],
        argRange: [m.index + m[0].indexOf(m[1]), m.index + m[0].lastIndexOf(m[1]) + 1],
        specRaw: m[2], quote: m[1], assignedTo: undefined
      });
    }

    const rr = /require\s*\.\s*resolve\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (let m; (m = rr.exec(src)); ) {
      requireResolveSites.push({
        callRange: [m.index, m.index + m[0].length],
        argRange: [m.index + m[0].indexOf(m[1]), m.index + m[0].lastIndexOf(m[1]) + 1],
        specRaw: m[2], quote: m[1],
      });
    }

    const exportShape =
      /\bmodule\s*\.\s*exports\s*=/.test(src) ? { kind:'module-assign', range:[0,0] } :
      /\bexports\s*\./.test(src)                 ? { kind:'named', items: [] } :
      { kind:'unknown' };

    results.push({ path, eol, hasDirname, hasFilename, requireSites, requireResolveSites, exportShape, hasAMDHint, hasImportCall });
    ctx.emit({ type: 'scan.file', path });
  }
  return results;
}
