import { builtinModules } from 'node:module';
import { resolve, dirname, extname, sep, posix } from 'node:path';
import { stat, readFile } from 'node:fs/promises';

export function normalizePosix(p){ return p.split(sep).join('/'); }
export function isNodeCore(spec){ return builtinModules.includes(spec) || builtinModules.includes(spec.replace(/^node:/,'')); }
export function toNodeSpecifier(spec){ const s = spec.replace(/^node:/,''); return `node:${s}`; }
export function slug(s){ return s.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }

// tiny glob compiler: ** → .*, * → [^/]*, ? → ., anchor begin/end, POSIX
export function compileGlob(g) {
  const rx = '^' + g.split('/').map(seg => seg
    .replace(/[.+^${}()|[\]\\]/g,'\\$&')
    .replace(/\*\*/g,'__GLOBSTAR__')
    .replace(/\*/g,'[^/]*')
    .replace(/__GLOBSTAR__/g,'.*')
    .replace(/\?/g,'.')
  ).join('/') + '$';
  const re = new RegExp(rx);
  return (p)=> re.test(normalizePosix(p));
}

export async function resolveSpecifier(from, spec, statCache) {
  if (isNodeCore(spec)) return { kind:'node' };
  if (spec.startsWith('data:')) return { kind:'unknown' };
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = resolve(dirname(from), spec);
    const asIs = await tryStat(base, statCache);
    if (asIs?.isFile) return { kind:'file', path: base };
    // try with extensions
    for (const ext of ['.js','.mjs','.cjs','.json']) {
      const p = base + ext; const st = await tryStat(p, statCache);
      if (st?.isFile) return { kind:'file', path: p };
    }
    // index files in dir
    const dir = await tryStat(base, statCache);
    if (dir?.isDirectory) {
      for (const idx of ['/index.js','/index.mjs','/index.cjs']) {
        const p = base + idx; const st = await tryStat(p, statCache);
        if (st?.isFile) return { kind:'dir', path: p };
      }
      // package.json main (basic)
      const pkg = base + '/package.json';
      const st = await tryStat(pkg, statCache);
      if (st?.isFile) {
        try { const j = JSON.parse(await readFile(pkg, 'utf8')); 
          if (typeof j.main === 'string') {
            const p = resolve(base, j.main);
            const st2 = await tryStat(p, statCache); if (st2?.isFile) return { kind:'dir', path: p };
          }
        } catch {}
      }
    }
    return { kind:'unknown' };
  }
  return { kind:'package' };
}

async function tryStat(p, cache) {
  const k = normalizePosix(p);
  const c = cache.get(k);
  if (c) return c;
  try {
    const st = await stat(p);
    const v = { isFile: st.isFile(), isDirectory: st.isDirectory(), mtime: st.mtimeMs };
    cache.set(k, v);
    return v;
  } catch {
    cache.set(k, null);
    return null;
  }
}
