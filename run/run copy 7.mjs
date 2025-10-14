#!/usr/bin/env node
// run.mjs — main CLI & worker pool controller (RawNode ESM Converter)

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/* ────────────────────────────────────────────────────────────────
 * CLI flags
 * ──────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetIndex = args.indexOf("--target");
const concurrencyIndex = args.indexOf("--concurrency");

const targetDir =
  targetIndex !== -1 && args[targetIndex + 1]
    ? args[targetIndex + 1]
    : "./src";

const concurrency =
  concurrencyIndex !== -1 && args[concurrencyIndex + 1]
    ? Math.max(1, Number(args[concurrencyIndex + 1]))
    : Math.max(1, Math.floor(cpus().length / 2));

console.log(
  `🚀 Starting RawNode ESM conversion\n` +
    `Target: ${targetDir}\n` +
    `Concurrency: ${concurrency}\n` +
    (dryRun ? "Mode: 🔍 Dry-run (no writes)\n" : "Mode: ✍️  Write in-place\n")
);

/* ────────────────────────────────────────────────────────────────
 * Directory discovery
 * ──────────────────────────────────────────────────────────────── */
function getAllSubdirs(root) {
  const out = [];
  for (const file of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, file.name);
    if (file.isDirectory()) out.push(full);
  }
  return out.length ? out : [root];
}

const dirs = getAllSubdirs(targetDir);
let nextJob = 0;
let completed = 0;
let totalFiles = 0;
const start = performance.now();

/* ────────────────────────────────────────────────────────────────
 * Worker management
 * ──────────────────────────────────────────────────────────────── */
const workers = [];
const results = [];

function createWorker(id) {
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    workerData: null,
  });

  worker.on("message", (msg) => {
    if (msg.type === "log") {
      process.stdout.write(`🧵 Worker ${id} → ${msg.message}\n`);
    } else if (msg.type === "done") {
      completed++;
      totalFiles += msg.converted;
      process.stdout.write(
        `✅ Worker ${id} → done ${msg.dir} (${msg.converted} files)\n`
      );
      results.push(msg);
      assignNext(worker, id);
    } else if (msg.type === "error") {
      process.stdout.write(`⚠️  Worker ${id} → error in ${msg.dir}: ${msg.error}\n`);
      assignNext(worker, id);
    }
  });

  worker.on("exit", (code) => {
    if (code !== 0)
      console.error(`❌ Worker ${id} exited with code ${code}`);
  });

  return worker;
}

function assignNext(worker, id) {
  if (nextJob >= dirs.length) {
    if (workers.every((w) => w.idle)) {
      if (completed === dirs.length) finish();
    }
    worker.idle = true;
    return;
  }
  const dir = dirs[nextJob++];
  worker.idle = false;
  worker.postMessage({ dir, dryRun });
  process.stdout.write(
    `🧵 Worker ${id} → processing ${path.basename(dir)}\n`
  );
}

function finish() {
  const end = performance.now();
  const elapsed = ((end - start) / 1000).toFixed(2);
  console.log(
    `\n🎉 All workers finished\n` +
      `Modules processed: ${completed}\n` +
      `Total files handled: ${totalFiles}\n` +
      `Elapsed: ${elapsed}s\n`
  );
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────
 * Pool initialization
 * ──────────────────────────────────────────────────────────────── */
for (let i = 0; i < Math.min(concurrency, dirs.length); i++) {
  const worker = createWorker(i + 1);
  workers.push(worker);
}

workers.forEach((w, i) => assignNext(w, i + 1));
