import { opendir, lstat } from 'node:fs/promises';
import { join, resolve, posix } from 'node:path';
import { normalizePosix, compileGlob } from './utils.mjs';

export async function discover({ roots, include, exclude, hook, logger }) {
  const includeFns = (include||[]).map(g => compileGlob(g));
  const excludeFns = (exclude||[]).map(g => compileGlob(g));

  const acc = [];
  for (const r of roots) await walk(resolve(r), acc);

  // Filter
  const jsFiles = acc.filter(p => {
    const rp = normalizePosix(p);
    const okInc = includeFns.length ? includeFns.some(fn => fn(rp)) : true;
    const okExc = excludeFns.some(fn => fn(rp));
    return okInc && !okExc && (rp.endsWith('.js') || rp.endsWith('.cjs'));
  });

  // Stable sort
  jsFiles.sort((a,b) => normalizePosix(a).localeCompare(normalizePosix(b), 'en'));

  return jsFiles.map(p => ({ path: p, relPath: normalizePosix(p) }));
}

async function walk(dir, acc) {
  const it = await opendir(dir);
  for await (const ent of it) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.git')) continue;
    const p = join(dir, ent.name);
    const st = await lstat(p);
    if (st.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
}
