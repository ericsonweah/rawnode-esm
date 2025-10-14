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

const targetDir = targetIndex !== -1 && args[targetIndex + 1] ? path.resolve(args[targetIndex + 1]) : path.resolve("./src");

const concurrency = concurrencyIndex !== -1 && args[concurrencyIndex + 1] ? Math.max(1, Number(args[concurrencyIndex + 1])) : Math.max(1, Math.floor(cpus().length / 2));

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
            (jsonReport ? `Reporting: ${customReportPath ? customReportPath : "report.json"}\n` : "")
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
    const bar = grad + "█".repeat(filled) + DIM + "░".repeat(empty) + RESET;

    const throughput = totalFiles > 0 ? (totalFiles / elapsed).toFixed(0) : "0";
    const remaining = completedDirs > 0 ? ((elapsed / completedDirs) * (dirs.length - completedDirs)).toFixed(2) : "—";

    // Main bar
    let output = `📊 ${bar} ${BOLD}${(pct * 100).toFixed(1)}%${RESET}` + ` | ${totalFiles} files | ${completedDirs}/${dirs.length} dirs` + ` | ⚡ ${throughput} f/s | ETA ~${remaining}s\n`;

    // UPDATED: add per-worker adaptive stats
    const workersInfo = Array.from(workerStats.values())
        .map((s) => {
            const age = ((now - s.lastProgress) / 1000).toFixed(1);
            const alive = age < 2 ? GREEN : DIM; // mark inactive if not updating
            return (
                `${alive}W${s.workerId}${RESET} ` +
                `${DIM}b=${RESET}${s.batchSize.toString().padEnd(3)} ` +
                `${DIM}avg=${RESET}${s.avgMsPerBatch.toFixed(1).padStart(4)}ms ` +
                `${DIM}⚡${RESET}${s.throughput.toFixed(0).padStart(4)}f/s ` +
                `${DIM}q=${RESET}${s.queueRemaining.toString().padStart(4)}`
            );
        })
        .join("   ");

    output += `   ${workersInfo}\r`;

    process.stdout.write(output);
}

function updateProgress() {
    if (!isTTY || quiet) return;
    const now = performance.now();
    if (now - lastUpdate < 100) return;
    lastUpdate = now;
    renderProgress();
}

function finalProgress() {
    if (!isTTY || quiet) return;
    const barWidth = Math.max(20, Math.min(40, (process.stdout.columns || 80) - 60));
    const bar = GREEN + "█".repeat(barWidth) + RESET;
    process.stdout.write(`📊 ${bar} ${BOLD}100.0%${RESET} | ${totalFiles} files | ${dirs.length}/${dirs.length} dirs | ⏱ ${(performance.now() - start) / 1000}s\n`);
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
        // UPDATED: track adaptive metrics
        batchSize: 0,
        avgMsPerBatch: 0,
        throughput: 0,
        queueRemaining: 0,
        lastProgress: performance.now(),
    });

    worker.on("message", (msg) => {
        const stat = workerStats.get(id);

        switch (msg.type) {
            case "progress": // UPDATED: structured event from worker
                stat.batchSize = msg.batchSize;
                stat.avgMsPerBatch = msg.avgMsPerBatch;
                stat.throughput = msg.throughput;
                stat.queueRemaining = msg.queueRemaining;
                stat.lastProgress = performance.now();
                break;

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

  // ─────────────────────────────────────────────
  // Prepare per-worker + summary telemetry
  // ─────────────────────────────────────────────
  const perWorkerStats = Array.from(workerStats.values()).map((s) => ({
    workerId: s.workerId,
    dirsProcessed: s.dirsProcessed,
    filesConverted: s.filesConverted,
    activeMs: Math.round(s.activeMs),
    totalMs: Math.round(s.totalMs),
    batchSize: s.batchSize,
    avgMsPerBatch: Number(s.avgMsPerBatch?.toFixed?.(2) || 0),
    throughput: Number(s.throughput?.toFixed?.(1) || 0),
    queueRemaining: s.queueRemaining,
  }));

  const avgBatchSize =
    perWorkerStats.reduce((a, s) => a + (s.batchSize || 0), 0) /
    Math.max(perWorkerStats.length, 1);
  const avgThroughput =
    perWorkerStats.reduce((a, s) => a + (s.throughput || 0), 0) /
    Math.max(perWorkerStats.length, 1);
  const avgMsPerBatch =
    perWorkerStats.reduce((a, s) => a + (s.avgMsPerBatch || 0), 0) /
    Math.max(perWorkerStats.length, 1);
  const totalActiveMs = perWorkerStats.reduce((a, s) => a + s.activeMs, 0);
  const efficiency =
    totalActiveMs > 0 ? ((totalFiles / totalActiveMs) * 1000).toFixed(2) : 0;

  const summary = {
    avgBatchSize: Number(avgBatchSize.toFixed(2)),
    avgMsPerBatch: Number(avgMsPerBatch.toFixed(2)),
    avgThroughput: Number(avgThroughput.toFixed(1)),
    totalActiveMs,
    efficiency: Number(efficiency),
    efficiencyLabel:
      efficiency > 500
        ? "🚀 Excellent"
        : efficiency > 250
        ? "⚡ High"
        : efficiency > 100
        ? "🧩 Moderate"
        : "🐢 Low",
  };

  // ─────────────────────────────────────────────
  // JSON report generation (if enabled)
  // ─────────────────────────────────────────────
  if (jsonReport) {
    const report = {
      timestamp: new Date().toISOString(),
      target: targetDir,
      dirsProcessed: completedDirs,
      filesConverted: totalFiles,
      dryRun,
      concurrency,
      elapsedSeconds: Number(elapsed),
      perWorkerStats,
      summary,
    };

    let reportPath = customReportPath || path.join(process.cwd(), "report.json");
    if (reportPath.includes("%DATE%")) {
      reportPath = reportPath.replace("%DATE%", timestamp());
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

    console.log(`🧾 JSON report written to ${reportPath}`);
  }

  // ─────────────────────────────────────────────
  // NEW: Optional CLI flag --report-summary
  // ─────────────────────────────────────────────
  if (args.includes("--report-summary")) {
    console.log("");
    console.log(`${BOLD}${CYAN}📊 RAWNODE-ESM SUMMARY${RESET}`);
    console.log(`${DIM}───────────────────────────────${RESET}`);
    console.log(
      `${DIM}Average Batch Size:${RESET}  ${GREEN}${summary.avgBatchSize.toFixed(
        1
      )}${RESET}`
    );
    console.log(
      `${DIM}Average Latency:${RESET}     ${YELLOW}${summary.avgMsPerBatch.toFixed(
        2
      )} ms${RESET}`
    );
    console.log(
      `${DIM}Average Throughput:${RESET}  ${CYAN}${summary.avgThroughput.toFixed(
        1
      )} files/s${RESET}`
    );
    console.log(
      `${DIM}Total Active Time:${RESET}   ${summary.totalActiveMs.toLocaleString()} ms`
    );
    console.log(
      `${DIM}Efficiency Rating:${RESET}   ${summary.efficiencyLabel}`
    );
    console.log(`${DIM}───────────────────────────────${RESET}`);
    console.log("");
  }

  // ─────────────────────────────────────────────
  // EXTENDED: Compare Mode (--compare report1.json report2.json [...])
  // ─────────────────────────────────────────────
  const compareIndex = args.indexOf("--compare");
  if (compareIndex !== -1 && args.length > compareIndex + 1) {
    const reportFiles = args.slice(compareIndex + 1).filter((f) => f.endsWith(".json"));
    if (reportFiles.length < 2) {
      console.error(`${RED}❌ Please provide at least two report files to compare.${RESET}`);
    } else {
      try {
        const reports = reportFiles.map((f) => ({
          name: f,
          data: JSON.parse(fs.readFileSync(f, "utf8")),
        }));

        const summaries = reports.map((r) => ({
          file: r.name,
          ...r.data.summary,
        }));

        const metrics = [
          { key: "avgBatchSize", label: "Avg Batch" },
          { key: "avgMsPerBatch", label: "Latency (ms)" },
          { key: "avgThroughput", label: "Throughput (f/s)" },
          { key: "efficiency", label: "Efficiency" },
        ];

        console.log("");
        console.log(`${BOLD}${CYAN}📊 MULTI-RUN TREND ANALYSIS${RESET}`);
        console.log(`${DIM}──────────────────────────────────────────────────────────${RESET}`);

        for (const { key, label } of metrics) {
          const values = summaries.map((s) => s[key]).filter((v) => typeof v === "number");
          const min = Math.min(...values);
          const max = Math.max(...values);
          const avg = values.reduce((a, v) => a + v, 0) / values.length;
          const delta = ((max - min) / (min || 1)) * 100;

          const trendColor = delta > 10 ? GREEN : delta < -10 ? RED : YELLOW;
          console.log(
            `${DIM}${label.padEnd(18)}${RESET}: min=${min.toFixed(2)}  max=${max.toFixed(
              2
            )}  avg=${avg.toFixed(2)}  ${trendColor}Δ=${delta.toFixed(2)}%${RESET}`
          );
        }

        console.log(`${DIM}──────────────────────────────────────────────────────────${RESET}`);
        const latest = summaries[summaries.length - 1];
        const earliest = summaries[0];
        const effDelta = ((latest.efficiency - earliest.efficiency) / earliest.efficiency) * 100;
        const resultLabel =
          effDelta > 10
            ? `${GREEN}▲ Improved`
            : effDelta < -10
            ? `${RED}▼ Regressed`
            : `${YELLOW}≈ Stable`;

        console.log(`${BOLD}${CYAN}Result:${RESET} ${resultLabel}${RESET}`);
        console.log("");
      } catch (err) {
        console.error(`${RED}❌ Comparison failed:${RESET} ${err.message}`);
      }
    }
  }

  console.log(
    `📈 Summary → avg batch=${summary.avgBatchSize}, avg throughput=${summary.avgThroughput} f/s, efficiency=${summary.efficiencyLabel}`
  );

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
