'use strict';

// /src/verify.mjs

import { scanSource } from './scan.mjs';
import { performance } from 'node:perf_hooks';

export async function verify({ path, content, facts, plan }) {
  const t0 = performance.now();
  const post = scanSource(content);
  // basic sanity: no stray "require(" introduced
  const errors = [];
  if (post.requires.some(r => r.callee==='require' && r.arg)) {
    errors.push({ file:path, code:'VERIFY-REQUIRE-LEFT', level:'error', message:'require() still present after transform', hint:'Use risk=safe or keep createRequire.' });
  }
  const dt = performance.now() - t0;
  return { errors, time: dt };
}
