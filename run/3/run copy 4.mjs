#!/usr/bin/env node
// run.mjs — enterprise-grade RawNode ESM converter runner (zero deps, Node 20+)
// - Async, deterministic, signal-aware, and aligned with worker protocol.
// - Jobs are explicit roots only (no nested subdir sharding to avoid duplicates).
// - Rich TTY progress, ETA, JSON report, and trend compare preserved.

import { Worker } from "node:worker_threads";
import os from "node:os";
import { opendir, stat as pstat, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

/* ────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────── */
const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        "debug-walk": { type: "boolean", default: false },
        target: { type: "string" }, // deprecated; prefer positionals or --targets
        targets: { type: "string" }, // comma-separated roots
        concurrency: { type: "string" }, // # of worker threads (jobs processed in parallel)
        "worker-concurrency": { type: "string" }, // per-worker file concurrency
        "include-exts": { type: "string", default: ".js" },
        "exclude-names": { type: "string", default: "node_modules,.git" },
        "progress-every-ms": { type: "string", default: "300" },
        "timeout-ms": { type: "string", default: "0" },
        "json-report": { type: "boolean", default: false },
        report: { type: "string" }, // path (supports %DATE%)
        "dry-run": { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        "report-summary": { type: "boolean", default: false },
        compare: { type: "string" }, // space-separated after flag; handled later
        "export-trend": { type: "string" }, // optional path for trend export
    },
});

// Flags & roots (deterministic)
const debugWalk = !!values["debug-walk"];

// Priority (deterministic):
// 1) positionals (explicit)
// 2) --target
// 3) --targets (CSV)
// 4) fallback '.'
const rootsRaw = positionals.length ? positionals : values.target ? [values.target] : values.targets ? values.targets.split(",") : ["."];

// Resolve → dedupe → stable POSIX sort
const roots = Array.from(
    new Set(
        rootsRaw
            .map((r) => r && r.trim())
            .filter(Boolean)
            .map((r) => path.resolve(r))
    )
).sort((a, b) => a.split(path.sep).join("/").localeCompare(b.split(path.sep).join("/"), "en"));

if (values.help) {
    console.log(
        `RawNode-ESM runner

Usage:
  node run.mjs [ROOT ...] [--flags]

Roots:
  One or more directories to convert. If omitted, --target/--targets may be used.

Common flags:
  --dry-run                   Do not write files (analyze/plan only)
  --debug-walk                Log scheduled roots/jobs (runner-level; low-noise)
  --concurrency N             Worker threads for parallel roots (default: min(8, CPU))
  --worker-concurrency N      Per-worker file concurrency (default inside worker)
  --include-exts ".js,.cjs"   File extensions to include
  --exclude-names "node_modules,.git"  Directory names to skip
  --progress-every-ms 300     Progress event cadence
  --timeout-ms 0              Per-job timeout (0 = disabled)
  --json-report               Emit JSON report (path via --report)
  --report ./report.json      JSON report path (supports %DATE%)
  --report-summary            Pretty summary table
  --quiet                     Minimal console output

Trend analysis:
  --compare a.json b.json [c.json ...] [--export-trend trend.json]
`
    );
    process.exit(0);
}

/* ────────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────────── */
const isTTY = process.stdout.isTTY;
const color = (c) => (isTTY ? `\x1b[${c}m` : "");
const RESET = color(0),
    GREEN = color("38;5;82"),
    YELLOW = color("38;5;226"),
    RED = color("38;5;196"),
    CYAN = color("36"),
    DIM = color("2"),
    BOLD = color("1");
const gradientColor = (p) => (!isTTY ? "" : p < 0.5 ? GREEN : p < 0.8 ? YELLOW : RED);

const listFromCSV = (s) =>
    (s || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
const timestamp = () => new Date().toISOString().replace(/:/g, "-");

const envConc = Number(process.env.RAWNODE_ESM_CONCURRENCY || 0);
const defaultWorkers = Math.max(1, Number(values.concurrency ?? (envConc || Math.min(8, os.cpus().length))));
const workerConcurrency = Number(values["worker-concurrency"] || 0) || undefined;

const includeExts = listFromCSV(values["include-exts"] || ".js").map((x) => x.toLowerCase());
const excludeNames = new Set(listFromCSV(values["exclude-names"] || "node_modules,.git"));

const progressEveryMs = Math.max(50, Number(values["progress-every-ms"]));
const timeoutMs = Math.max(0, Number(values["timeout-ms"]));

const dryRun = !!values["dry-run"];
const quiet = !!values.quiet;
const jsonReport = !!values["json-report"];

let reportPath = values.report || path.resolve(process.cwd(), "report.json");
if (reportPath.includes("%DATE%")) reportPath = reportPath.replace("%DATE%", timestamp());

// Roots: positionals win, else --targets CSV, else legacy --target, else ./src
const rootsArg = positionals.length ? positionals : values.targets ? listFromCSV(values.targets) : values.target ? [values.target] : ["./src"];

// const roots = Array.from(new Set(rootsArg.map((r) => path.resolve(r)))).sort((a,b) =>
//   a.split(path.sep).join("/").localeCompare(b.split(path.sep).join("/"), "en")
// );

const workerCount = Math.min(defaultWorkers, roots.length || 1);

/* ────────────────────────────────────────────────────────────────
 * Intro
 * ──────────────────────────────────────────────────────────────── */
if (!quiet) {
    console.log(
        `🚀 Starting RawNode ESM conversion\n` + `Roots: ${roots.join(", ")}\n` + `Workers: ${workerCount}\n` + (dryRun ? "Mode: 🔍 Dry-run (no writes)\n" : "Mode: ✍️  Write in-place\n") + (jsonReport ? `Reporting: ${reportPath}\n` : "")
    );
}

/* ────────────────────────────────────────────────────────────────
 * Async sanity checks (roots exist; directories)
 * ──────────────────────────────────────────────────────────────── */
async function filterValidRoots(rs) {
    const out = [];
    for (const r of rs) {
        try {
            const st = await pstat(r);
            if (st.isDirectory()) out.push(r);
            else if (!quiet) console.warn(`⚠️  [skip] Not a directory: ${r}`);
        } catch (e) {
            if (!quiet) console.warn(`⚠️  [skip] Cannot access ${r}: ${e.message}`);
        }
    }
    return out;
}

/* ────────────────────────────────────────────────────────────────
 * (Optional) light async scan for quick total-file estimate
 * ──────────────────────────────────────────────────────────────── */
async function countJsFiles(root) {
    let n = 0;
    const Q = [root];
    while (Q.length) {
        const d = Q.shift();
        let dh;
        try {
            dh = await opendir(d);
        } catch {
            continue;
        }
        for await (const ent of dh) {
            if (excludeNames.has(ent.name)) continue;
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) {
                Q.push(full);
                continue;
            }
            const low = ent.name.toLowerCase();
            if (includeExts.some((ext) => low.endsWith(ext))) n++;
        }
    }
    return n;
}

/* ────────────────────────────────────────────────────────────────
 * Progress and formatting
 * ──────────────────────────────────────────────────────────────── */
const NF = new Intl.NumberFormat("en-US"); // deterministic formatting
const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};
const fix = (v, digits = 1, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(digits)) : d;
};

const start = performance.now();
let aborted = false;
let nextJob = 0,
    completed = 0,
    totalConverted = 0,
    totalErrors = 0;

const workers = [];
const perWorker = new Map(); // id -> stats
const perRoot = new Map(); // dir -> { converted, durationMs, errors }
let progressTimer = null; // for safe cleanup on finish()
let finished = false; // single-shot finish guard

function renderProgress() {
    if (!isTTY || quiet) return;
    const now = performance.now();
    const elapsed = (now - start) / 1000;
    const pct = Math.min(completed / Math.max(roots.length, 1), 1);
    const barWidth = Math.max(20, Math.min(40, (process.stdout.columns || 80) - 60));
    const filled = Math.round(barWidth * pct);
    const bar = gradientColor(pct) + "█".repeat(filled) + DIM + "░".repeat(barWidth - filled) + RESET;
    const tput = totalConverted > 0 ? (totalConverted / Math.max(elapsed, 1e-3)).toFixed(0) : "0";
    const eta = completed > 0 ? ((elapsed / completed) * (roots.length - completed)).toFixed(2) : "—";

    let out = `📊 ${bar} ${BOLD}${(pct * 100).toFixed(1)}%${RESET}` + ` | ${totalConverted} files | ${completed}/${roots.length} roots` + ` | ⚡ ${tput} f/s | ETA ~${eta}s\n`;

    const workersInfo = Array.from(perWorker.values())
        .map((s = {}) => {
            const ageSec = (performance.now() - (s.lastProgress || 0)) / 1000;
            const alive = ageSec < 2 ? GREEN : DIM;
            const bsz = String(num(s.batchSize, 0)).padEnd(3);
            const ams = String(fix(s.avgMsPerBatch, 1, 0)).padStart(4);
            const tps = String(fix(s.throughput, 0, 0)).padStart(4);
            const qrem = String(num(s.queueRemaining, 0)).padStart(4);
            return `${alive}W${s.workerId ?? 0}${RESET} ${DIM}b=${RESET}${bsz} ${DIM}avg=${RESET}${ams}ms ${DIM}⚡${RESET}${tps}f/s ${DIM}q=${RESET}${qrem}`;
        })
        .join("   ");

    out += `   ${workersInfo}\r`;
    process.stdout.write(out);
}
function finalProgress() {
    if (!isTTY || quiet) return;
    const barWidth = Math.max(20, Math.min(40, (process.stdout.columns || 80) - 60));
    const bar = GREEN + "█".repeat(barWidth) + RESET;
    process.stdout.write(`📊 ${bar} ${BOLD}100.0%${RESET} | ${totalConverted} files | ${roots.length}/${roots.length} roots | ⏱ ${(performance.now() - start) / 1000}s\n`);
}

/* ────────────────────────────────────────────────────────────────
 * Worker management
 * ──────────────────────────────────────────────────────────────── */
function createWorker(id) {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url));
    worker.idle = false;
    perWorker.set(id, {
        workerId: id,
        dirsProcessed: 0,
        filesConverted: 0,
        activeMs: 0,
        startTime: performance.now(),
        totalMs: 0,
        batchSize: 0,
        avgMsPerBatch: 0,
        throughput: 0,
        queueRemaining: 0,
        lastProgress: performance.now(),
    });

    worker.on("message", (msg) => {
        const s = perWorker.get(id);
        if (!s) return;
        switch (msg.type) {
            case "progress":
                s.batchSize = num(msg.batchSize);
                s.avgMsPerBatch = fix(msg.avgMsPerBatch, 2);
                s.throughput = fix(msg.throughput, 1);
                s.queueRemaining = num(msg.queueRemaining);
                s.lastProgress = performance.now();
                break;

            case "done": {
                completed++;
                totalConverted += num(msg.converted);
                s.dirsProcessed++;
                s.filesConverted += num(msg.converted);
                s.activeMs += num(msg.durationMs);
                const r = perRoot.get(msg.dir) || { converted: 0, durationMs: 0, errors: 0 };
                r.converted += num(msg.converted);
                r.durationMs += num(msg.durationMs);
                perRoot.set(msg.dir, r);
                assignNext(worker, id);
                renderProgress();
                break;
            }

            case "error": {
                totalErrors++;
                const r = perRoot.get(msg.dir) || { converted: 0, durationMs: 0, errors: 0 };
                r.errors++;
                perRoot.set(msg.dir, r);
                assignNext(worker, id);
                break;
            }
        }
    });

    worker.on("error", (err) => {
        totalErrors++;
        if (!quiet) console.error(`${RED}❌ Worker ${id} error:${RESET} ${err?.message || err}`);
        worker.idle = true;
        if (workers.every((w) => w.idle)) finish();
    });

    worker.on("exit", () => {
        const s = perWorker.get(id);
        if (s) s.totalMs = performance.now() - s.startTime;
        worker.idle = true;
        if (workers.every((w) => w.idle)) finish();
    });

    return worker;
}

function assignNext(worker, id) {
    if (aborted) {
        worker.idle = true;
        if (workers.every((w) => w.idle)) finish();
        return;
    }
    if (nextJob >= roots.length) {
        worker.idle = true;
        if (workers.every((w) => w.idle)) finish();
        return;
    }
    const dir = roots[nextJob++];
    worker.idle = false;
    perRoot.set(dir, perRoot.get(dir) || { converted: 0, durationMs: 0, errors: 0 });
    if (debugWalk && !quiet) console.log(`${DIM}→ assign${RESET} W${id} ${dir}`);
    worker.postMessage({
        dir,
        dryRun,
        includeExts,
        excludeNames: Array.from(excludeNames),
        concurrency: workerConcurrency,
        progressEveryMs,
        timeoutMs,
    });
}

/* ────────────────────────────────────────────────────────────────
 * Finish + report
 * ──────────────────────────────────────────────────────────────── */
async function finish() {
    if (finished) return;
    finished = true;
    if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
    }
    const end = performance.now();
    const elapsedSec = Number(((end - start) / 1000).toFixed(2));

    if (!quiet && !aborted) finalProgress();

    console.log(`\n${aborted ? "🛑 Aborted" : "🎉 All workers finished"}\n` + `Roots processed: ${completed}/${roots.length}\n` + `Total files converted: ${totalConverted}\n` + `Errors: ${totalErrors}\n` + `Elapsed: ${elapsedSec}s\n`);

    const perWorkerStats = Array.from(perWorker.values()).map((s = {}) => ({
        workerId: s.workerId ?? 0,
        dirsProcessed: num(s.dirsProcessed),
        filesConverted: num(s.filesConverted),
        activeMs: num(s.activeMs),
        totalMs: num(s.totalMs),
        batchSize: num(s.batchSize),
        avgMsPerBatch: fix(s.avgMsPerBatch, 2),
        throughput: fix(s.throughput, 1),
        queueRemaining: num(s.queueRemaining),
    }));

    const avgBatchSize = fix(perWorkerStats.reduce((a, s) => a + (s.batchSize || 0), 0) / Math.max(perWorkerStats.length, 1), 2);
    const avgThroughput = fix(perWorkerStats.reduce((a, s) => a + (s.throughput || 0), 0) / Math.max(perWorkerStats.length, 1), 1);
    const avgMsPerBatch = fix(perWorkerStats.reduce((a, s) => a + (s.avgMsPerBatch || 0), 0) / Math.max(perWorkerStats.length, 1), 2);
    const totalActiveMs = num(perWorkerStats.reduce((a, s) => a + s.activeMs, 0));
    const efficiency = Number((totalActiveMs > 0 ? (totalConverted / totalActiveMs) * 1000 : 0).toFixed(2));
    const efficiencyLabel = efficiency > 500 ? "🚀 Excellent" : efficiency > 250 ? "⚡ High" : efficiency > 100 ? "🧩 Moderate" : "🐢 Low";

    const summary = { avgBatchSize, avgMsPerBatch, avgThroughput, totalActiveMs, efficiency, efficiencyLabel };

    if (jsonReport) {
        const report = {
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            aborted,
            roots,
            dryRun,
            workerCount,
            workerConcurrency: workerConcurrency ?? null,
            includeExts,
            excludeNames: Array.from(excludeNames),
            elapsedSeconds: elapsedSec,
            totalFilesConverted: totalConverted,
            totalErrors,
            perWorkerStats,
            perRoot: Array.from(perRoot.entries()).map(([dir, v]) => ({ dir, ...v })),
            summary,
        };
        try {
            await mkdir(path.dirname(reportPath), { recursive: true });
            await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
            console.log(`🧾 JSON report written to ${reportPath}`);
        } catch (e) {
            console.error(`${RED}❌ Failed to write report:${RESET} ${e.message}`);
        }
    }

    if (values["report-summary"]) {
        console.log("");
        console.log(`${BOLD}${CYAN}📊 RAWNODE-ESM SUMMARY${RESET}`);
        console.log(`${DIM}───────────────────────────────${RESET}`);
        console.log(`${DIM}Average Batch Size:${RESET}  ${GREEN}${fix(summary.avgBatchSize, 1)}${RESET}`);
        console.log(`${DIM}Average Latency:${RESET}     ${YELLOW}${fix(summary.avgMsPerBatch, 2)} ms${RESET}`);
        console.log(`${DIM}Average Throughput:${RESET}  ${CYAN}${fix(summary.avgThroughput, 1)} files/s${RESET}`);
        console.log(`${DIM}Total Active Time:${RESET}   ${NF.format(num(summary.totalActiveMs))} ms`);
        console.log(`${DIM}Efficiency Rating:${RESET}   ${summary.efficiencyLabel}`);
        console.log(`${DIM}───────────────────────────────${RESET}\n`);
    }

    // Trend analysis
    const compareIdx = process.argv.indexOf("--compare");
    if (compareIdx !== -1 && process.argv.length > compareIdx + 1) {
        try {
            const files = process.argv.slice(compareIdx + 1).filter((f) => f.endsWith(".json"));
            if (files.length < 2) {
                console.error(`${RED}❌ Please provide at least two report files to compare.${RESET}`);
            } else {
                const reports = await Promise.all(files.map(async (f) => ({ name: path.basename(f), data: JSON.parse(await readFile(f, "utf8")) })));
                const summaries = reports.map((r) => ({ file: r.name, ...r.data.summary }));

                const metrics = [
                    { key: "avgBatchSize", label: "Avg Batch" },
                    { key: "avgMsPerBatch", label: "Latency (ms)" },
                    { key: "avgThroughput", label: "Throughput (f/s)" },
                    { key: "efficiency", label: "Efficiency" },
                ];

                console.log("");
                console.log(`${BOLD}${CYAN}📊 MULTI-RUN TREND ANALYSIS${RESET}`);
                console.log(`${DIM}──────────────────────────────────────────────────────────${RESET}`);

                const trendSummary = { timestamp: new Date().toISOString(), files: summaries.length, metrics: {} };

                for (const { key, label } of metrics) {
                    const valuesNum = summaries.map((s) => s[key]).filter((v) => typeof v === "number");
                    const min = Math.min(...valuesNum),
                        max = Math.max(...valuesNum);
                    const avg = valuesNum.reduce((a, v) => a + v, 0) / valuesNum.length || 0;
                    const delta = ((max - (min || 1)) / (min || 1)) * 100;
                    const trendColor = delta > 10 ? GREEN : delta < -10 ? RED : YELLOW;
                    console.log(`${DIM}${label.padEnd(18)}${RESET}: min=${min.toFixed(2)}  max=${max.toFixed(2)}  avg=${avg.toFixed(2)}  ${trendColor}Δ=${delta.toFixed(2)}%${RESET}`);
                    trendSummary.metrics[key] = { label, min: Number(min.toFixed(2)), max: Number(max.toFixed(2)), avg: Number(avg.toFixed(2)), deltaPercent: Number(delta.toFixed(2)) };
                }
                console.log(`${DIM}──────────────────────────────────────────────────────────${RESET}`);

                const latest = summaries[summaries.length - 1];
                const earliest = summaries[0];
                const effDelta = ((latest.efficiency - earliest.efficiency) / Math.max(earliest.efficiency, 1e-6)) * 100;
                const resultLabel = effDelta > 10 ? `${GREEN}▲ Improved` : effDelta < -10 ? `${RED}▼ Regressed` : `${YELLOW}≈ Stable`;
                console.log(`${BOLD}${CYAN}Result:${RESET} ${resultLabel}${RESET}\n`);

                const exportIdx = process.argv.indexOf("--export-trend");
                if (exportIdx !== -1) {
                    const exportPath = process.argv[exportIdx + 1] && !process.argv[exportIdx + 1].startsWith("--") ? path.resolve(process.argv[exportIdx + 1]) : path.join(process.cwd(), "trend-report.json");
                    trendSummary.result = {
                        status: resultLabel.replace(/\x1b\[[0-9;]*m/g, ""),
                        efficiencyDelta: Number(effDelta.toFixed(2)),
                    };
                    await mkdir(path.dirname(exportPath), { recursive: true });
                    await writeFile(exportPath, JSON.stringify(trendSummary, null, 2), "utf8");
                    console.log(`📊 Trend report exported → ${CYAN}${exportPath}${RESET}`);
                }
            }
        } catch (err) {
            console.error(`${RED}❌ Comparison failed:${RESET} ${err.message}`);
        }
    }

    console.log(`📈 Summary → avg batch=${fix(summary.avgBatchSize, 2)}, avg throughput=${fix(summary.avgThroughput, 1)} f/s, efficiency=${summary.efficiencyLabel}`);

    process.exit(aborted ? 2 : 0);
}

/* ────────────────────────────────────────────────────────────────
 * Start
 * ──────────────────────────────────────────────────────────────── */
const validRoots = await filterValidRoots(roots);
if (!validRoots.length) {
    console.log("⚠️  No valid roots found.");
    process.exit(0);
}
if (!quiet) {
    // best effort estimate (async) — not used for control flow
    const ests = await Promise.all(validRoots.map((r) => countJsFiles(r).catch(() => 0)));
    const totalEst = ests.reduce((a, b) => a + b, 0);
    console.log(`🧩 ${validRoots.length} root(s); ~${totalEst} file(s) estimated.\n`);
}

// Low-noise, deterministic scheduling trace
if (debugWalk && !quiet) {
    console.log(`${DIM}🧭 Debug-walk:${RESET} scheduling roots in order:`);
    for (const r of validRoots) console.log(`${DIM}  - ${RESET}${r}`);
}

for (let i = 0; i < Math.min(workerCount, validRoots.length); i++) {
    const w = createWorker(i + 1);
    workers.push(w);
}

process.on("SIGINT", () => {
    if (aborted) return;
    aborted = true;
    console.log(`\n${YELLOW}⎋  Cancel requested; signalling workers...${RESET}`);
    for (const w of workers) w.postMessage({ type: "cancel" });
});

process.on("SIGTERM", () => {
    if (aborted) return;
    aborted = true;
    console.log(`\n${YELLOW}⎋  Termination requested; signalling workers...${RESET}`);
    for (const w of workers) w.postMessage({ type: "cancel" });
});

workers.forEach((w, i) => assignNext(w, i + 1));

if (isTTY && !quiet) {
    const interval = setInterval(() => {
        renderProgress();
        if (workers.every((w) => w.idle)) clearInterval(interval);
    }, 200);
}

//if (!quiet) renderProgress();
if (isTTY && !quiet) {
    progressTimer = setInterval(() => {
        renderProgress();
        if (workers.every((w) => w.idle) && progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
    }, 200);
}
