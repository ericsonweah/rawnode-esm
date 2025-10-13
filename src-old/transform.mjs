import { readFile } from 'node:fs/promises';

function applyEdits(src, edits) {
  // Edits: {start,end,insert}; must be non-overlapping, sorted by start asc.
  const sorted = edits.slice().sort((a,b)=>a.start-b.start);
  let out = '', last = 0;
  for (const e of sorted) {
    out += src.slice(last, e.start) + (e.insert ?? '');
    last = e.end;
  }
  out += src.slice(last);
  return out;
}

export async function transformFiles(plans, cfg, ctx) {
  const out = [];
  for (const p of plans) {
    const original = await ctx.readFile(p.path);
    let header = '';
    if (p.shims.length > 0) header += p.shims.join('');
    const body = applyEdits(original, p.edits);
    const output = header ? header + '\n' + body : body;
    out.push({ path: p.path, original, output, changed: output !== original });
    ctx.emit({ type: 'transform.file', path: p.path, changed: output !== original });
  }
  return out;
}
