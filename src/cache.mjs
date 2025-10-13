import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';

export async function initCache(cfg) {
  await mkdir(cfg.cacheDir, { recursive: true });
  function hash(content) {
    return createHash('sha256').update(content).digest('hex');
  }
  async function read(p) {
    try { return JSON.parse(await readFile(path.join(cfg.cacheDir, p), 'utf8')); }
    catch { return null; }
  }
  async function write(p, obj) {
    await writeFile(path.join(cfg.cacheDir, p), JSON.stringify(obj, null, 0));
  }
  return { hash, read, write };
}
