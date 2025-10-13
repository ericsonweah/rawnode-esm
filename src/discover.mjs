import { opendir, readFile } from 'node:fs/promises';
import { posix as path } from 'node:path';

function toPosix(p) { return p.split('\\').join('/'); }

function patternToRegex(glob) {
  // Deterministic, minimal glob: ** → .*, * → [^/]*, ? → [^/]
  const esc = s => s.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  return new RegExp('^' + esc(glob)
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]') + '$');
}
function matcher(patterns) {
  const regs = patterns.map(patternToRegex);
  return (p) => regs.some(r => r.test(p));
}

export async function discover(cfg, ctx) {
  const include = matcher(cfg.include ?? ['**/*.js','**/*.cjs']);
  const exclude = matcher(cfg.exclude ?? ['node_modules/**','dist/**']);
  const out = [];
  const roots = (cfg.roots ?? ['.']).map(toPosix);

  async function walk(dir) {
    const it = await opendir(dir);
    for await (const ent of it) {
      const p = toPosix(path.join(dir, ent.name));
      if (ent.isDirectory()) {
        if (!exclude(p + '/')) await walk(p);
      } else {
        if (include(p) && !exclude(p)) out.push(p);
      }
    }
  }
  for (const r of roots) await walk(toPosix(r));
  out.sort(); // deterministic
  return out;
}
