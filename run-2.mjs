import os from 'node:os';

import { convert } from './src/run/index.mjs'; // or from 'rawnode-esm'
import {setup as plugin} from './src/plugins/example.mjs';
await convert({
  roots: ['src'],
  include: ['**/*.js','**/*.cjs'],
  exclude: ['node_modules/**','dist/**'],
  risk: 'safe',
  concurrency: Math.min(8, os.cpus().length),
  inflight: 2 * Math.min(8, os.cpus().length),   // files processed concurrently
  highWater: 64, lowWater: 16,                   // back-pressure
  dryRun: false, check: false, timeout: 120000,
  report: 'pretty', printDiff: false,
  // plugins: [plugin()],
  planOnly: false,
  resolvePolicy: 'node-prefix',
  signal: new AbortController().signal,
  onProgress: (evt) => {}
});
