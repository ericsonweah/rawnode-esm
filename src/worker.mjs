'use strict';

// /src/worker.mjs

import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { scanSource } from './scan.mjs';
import { cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    if (msg.type === 'scan') {
      const facts = scanSource(msg.content);
      parentPort.postMessage({ id: msg.id, facts });
    }
  });
}

export function createWorkerPool({ size, logger }) {
  const N = Math.max(1, Number(size || Math.min(8, cpus().length)));
  const workers = Array.from({length:N}, () => new Worker(fileURLToPath(import.meta.url)));
  let id = 0, qi = 0;
  const pending = new Map();

  for (const w of workers) {
    w.on('message', ({ id, facts }) => {
      const { resolve } = pending.get(id); pending.delete(id);
      resolve(facts);
    });
  }

  async function scan({ path, content }) {
    // round-robin dispatch
    const wid = qi; qi = (qi+1) % workers.length;
    const msgId = ++id;
    const p = new Promise((resolve,reject)=> pending.set(msgId, { resolve, reject }));
    workers[wid].postMessage({ type:'scan', id: msgId, path, content });
    return p;
  }

  async function close() {
    await Promise.all(workers.map(w => w.terminate()));
  }

  return { scan, close };
}
