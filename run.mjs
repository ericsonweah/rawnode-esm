#!/usr/bin/env node
// run.mjs — final production-grade RawNode ESM converter CLI
// Features: worker pool, adaptive gradient progress bar, ETA, throughput,
// cinematic finish, quiet mode, and JSON benchmarking report.

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/* ────────────────────────────────────────────────────────────────
 * CLI FLAGS
 * ──────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonReport = args.includes("--json-report");
const quiet = args.includes("--quiet");
const targetIndex = args.indexOf("--target");
const concurrencyIndex = args.indexOf("--concurrency");
const reportIndex = args.indexOf("--report");

const targetDir =
  targetIndex !== -1 && args[targetIndex + 1]
    ? path.resolve(args[targetIndex + 1])
    : path.resolve("./src");

const concurrency =
  concurrencyIndex !== -1 && args[concurrencyIndex + 1]
    ? Math.max(1, Number(args[concurrencyIndex + 1]))
    : Math.max(1, Math.floor(cpus().length / 2));

let customReportPath = null;
if (reportIndex !== -1 && args[reportIndex + 1]) {
  customReportPath = path.resolve(args[reportIndex + 1]);
}

function timestamp() {
  return new Date().toISOString().replace(/[:]/g, "-");
}

/* ────────────────────────────────────────────────────────────────
 * TERMINAL UTILITIES
 * ──────────────────────────────────────────────────────────────── */
const isTTY = process.stdout.isTTY;
function color(code) {
  return isTTY ? `\x1b[${code}m` : "";
}
const RESET = color(0);
const GREEN = color("38;5;82");
const YELLOW = color("38;5;226");
const RED = color("38;5;196");
const CYAN = color("36");
const DIM = color("2");
const BOLD = color("1");

/* Gradient color based on percentage */
function gradientColor(pct) {
  if (!isTTY) return "";
  if (pct < 0.5) return GREEN;
  if (pct < 0.8) return YELLOW;
  return RED;
}

/* ────────────────────────────────────────────────────────────────
 * INITIAL LOGS
 * ──────────────────────────────────────────────────────────────── */
if (!quiet) {
  console.log(
    `🚀 Starting RawNode ESM conversion\n` +
      `Target: ${targetDir}\n` +
      `Concurrency: ${concurrency}\n` +
      (dryRun ? "Mode: 🔍 Dry-run (no writes)\n" : "Mode: ✍️  Write in-place\n") +
      (jsonReport
        ? `Reporting: ${customReportPath ? customReportPath : "report.json"}\n`
        : "")
  );
}

/* ────────────────────────────────────────────────────────────────
 * DISCOVER ALL DIRECTORIES RECURSIVELY
 * ──────────────────────────────────────────────────────────────── */
function discoverAllDirs(root, out = []) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    let hasJS = false;
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        discoverAllDirs(full, out);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        hasJS = true;
      }
    }
    if (hasJS) out.push(root);
  } catch (err) {
    if (!quiet) console.warn(`⚠️  [skip] Cannot read ${root}: ${err.message}`);
  }
  return out;
}

const dirs = discoverAllDirs(targetDir);
if (dirs.length === 0) {
  console.log("⚠️  No .js files found anywhere under target path.");
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────
 * WORKER POOL
 * ──────────────────────────────────────────────────────────────── */
let nextJob = 0;
let completedDirs = 0;
let totalFiles = 0;
let totalErrors = 0;
const start = performance.now();

const workers = [];
const workerStats = new Map(); // id -> stats
let lastUpdate = 0;

/* ────────────────────────────────────────────────────────────────
 * PROGRESS BAR + STATS
 * ──────────────────────────────────────────────────────────────── */
function renderProgress() {
  if (!isTTY || quiet) return;

  const now = performance.now();
  const elapsed = (now - start) / 1000;
  const pct = Math.min(completedDirs / dirs.length, 1);
  const barWidth = Math.max(20, Math.min(40, (process.stdout.columns || 80) - 60));
  const filled = Math.round(barWidth * pct);
  const empty = barWidth - filled;

  const grad = gradientColor(pct);
  const bar =
    grad +
    "█".repeat(filled) +
    DIM +
    "░".repeat(empty) +
    RESET;

  const throughput = totalFiles > 0 ? (totalFiles / elapsed).toFixed(0) : "0";
  const remaining =
    completedDirs > 0
      ? ((elapsed / completedDirs) * (dirs.length - completedDirs)).toFixed(2)
      : "—";

  const line =
    `📊 ${bar} ${BOLD}${(pct * 100).toFixed(1)}%${RESET}` +
    ` | ${totalFiles} files | ${completedDirs}/${dirs.length} dirs` +
    ` | ⚡ ${throughput} f/s | ETA ~${remaining}s\r`;

  process.stdout.write(line);
}

function finalProgress() {
  if (!isTTY || quiet) return;
  const barWidth = Math.max(20, Math.min(40, (process.stdout.columns || 80) - 60));
  const bar = GREEN + "█".repeat(barWidth) + RESET;
  process.stdout.write(
    `📊 ${bar} ${BOLD}100.0%${RESET} | ${totalFiles} files | ${dirs.length}/${dirs.length} dirs | ⏱ ${(performance.now() - start) / 1000}s\n`
  );
}

/* ────────────────────────────────────────────────────────────────
 * WORKER MANAGEMENT
 * ──────────────────────────────────────────────────────────────── */
function createWorker(id) {
  const worker = new Worker(new URL("./worker.mjs", import.meta.url));
  worker.idle = false;
  workerStats.set(id, {
    workerId: id,
    dirsProcessed: 0,
    filesConverted: 0,
    activeMs: 0,
    startTime: performance.now(),
    totalMs: 0,
  });

  worker.on("message", (msg) => {
    const stat = workerStats.get(id);
    switch (msg.type) {
      case "done":
        completedDirs++;
        totalFiles += msg.converted;
        stat.dirsProcessed++;
        stat.filesConverted += msg.converted;
        stat.activeMs += msg.durationMs ?? 0;
        renderProgress();
        assignNext(worker, id);
        break;
      case "error":
        totalErrors++;
        assignNext(worker, id);
        break;
    }
  });

  worker.on("exit", (code) => {
    const stat = workerStats.get(id);
    stat.totalMs = performance.now() - stat.startTime;
    worker.idle = true;
    if (workers.every((w) => w.idle)) finish();
  });

  return worker;
}

function assignNext(worker, id) {
  if (nextJob >= dirs.length) {
    worker.idle = true;
    if (workers.every((w) => w.idle)) finish();
    return;
  }
  const dir = dirs[nextJob++];
  worker.idle = false;
  worker.postMessage({ dir, dryRun });
}

/* ────────────────────────────────────────────────────────────────
 * FINALIZATION + REPORT
 * ──────────────────────────────────────────────────────────────── */
function finish() {
  const end = performance.now();
  const elapsed = ((end - start) / 1000).toFixed(2);

  if (!quiet) finalProgress();

  console.log(
    `\n🎉 All workers finished\n` +
      `Modules processed: ${completedDirs}\n` +
      `Total files converted: ${totalFiles}\n` +
      `Errors: ${totalErrors}\n` +
      `Elapsed: ${elapsed}s\n`
  );

  if (jsonReport) {
    const report = {
      timestamp: new Date().toISOString(),
      target: targetDir,
      dirsProcessed: completedDirs,
      filesConverted: totalFiles,
      dryRun,
      concurrency,
      elapsedSeconds: Number(elapsed),
      perWorkerStats: Array.from(workerStats.values()).map((s) => ({
        workerId: s.workerId,
        dirsProcessed: s.dirsProcessed,
        filesConverted: s.filesConverted,
        activeMs: Math.round(s.activeMs),
        totalMs: Math.round(s.totalMs),
      })),
    };

    let reportPath = customReportPath || path.join(process.cwd(), "report.json");
    if (reportPath.includes("%DATE%")) {
      reportPath = reportPath.replace("%DATE%", timestamp());
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`🧾 JSON report written to ${reportPath}`);
  }

  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────
 * START
 * ──────────────────────────────────────────────────────────────── */
if (!quiet) console.log(`🧩 Discovered ${dirs.length} directories containing JS files.\n`);

for (let i = 0; i < Math.min(concurrency, dirs.length); i++) {
  const worker = createWorker(i + 1);
  workers.push(worker);
}

workers.forEach((w, i) => assignNext(w, i + 1));

if (isTTY && !quiet) {
  const interval = setInterval(() => {
    renderProgress();
    if (workers.every((w) => w.idle)) clearInterval(interval);
  }, 200);
}

//if (!quiet) renderProgress();