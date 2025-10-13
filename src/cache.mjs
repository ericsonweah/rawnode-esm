'use strict';

// /src/cache.mjs

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function hashContent(s) {
  return createHash('sha256').update(s).digest('hex');
}

export class Cache {
  constructor(dir) { this.dir = dir; this.ready = mkdir(dir, { recursive:true }); }
  async getFacts(path, contentHash) {
    await this.ready;
    try {
      const j = await readFile(join(this.dir, safe(path) + '.' + contentHash + '.facts.json'), 'utf8');
      return JSON.parse(j);
    } catch { return null; }
  }
  async putFacts(path, contentHash, facts) {
    await this.ready;
    const p = join(this.dir, safe(path) + '.' + contentHash + '.facts.json');
    await writeFile(p, JSON.stringify(facts));
  }
}
function safe(p){ return p.replace(/[^A-Za-z0-9_.-]+/g,'_'); }
