#!/usr/bin/env node
/* tools/trend-book.mjs
 * Consolidate RawNode‑ESM JSON reports into a per‑period trend book.
 * Zero deps, Node 20+, deterministic, fully async with bounded concurrency.
 * Supports --bucket week|month and optional --csv export.
 */

import { parseArgs } from 'node:util';
import { opendir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename, dirname as pathDirname } from 'node:path';
import os from 'node:os';

/* ────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────── */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir:         { type: 'string' },
    out:         { type: 'string' },
    csv:         { type: 'string' },
    recursive:   { type: 'boolean', default: false },
    metrics:     { type: 'string', default: 'avgBatchSize,avgMsPerBatch,avgThroughput,efficiency' },
    bucket:      { type: 'string', default: 'week' }, // week|month
    concurrency: { type: 'string' },
    pretty:      { type: 'boolean', default: true },
    verbose:     { type: 'boolean', default: false }
  }
});

const rootDir     = resolve(values.dir ?? positionals[0] ?? process.cwd());
const outPath     = resolve(values.out ?? join(process.cwd(), 'trend-book.json'));
const csvPath     = values.csv ? resolve(values.csv) : null;
const recursive   = !!values.recursive;
const metricsList = values.metrics.split(',').map(s => s.trim()).filter(Boolean);
const bucket      = (values.bucket === 'month') ? 'month' : 'week';
const concurrency = Math.max(1, Number(values.concurrency ?? Math.min(8, os.cpus().length)));
const PRETTY      = !!values.pretty;
const VERBOSE     = !!values.verbose;

/* ────────────────────────────────────────────────────────────────
 * Helpers (deterministic guards & formatting)
 * ──────────────────────────────────────────────────────────────── */
const NF = new Intl.NumberFormat('en-US'); // console only; JSON & CSV get raw numbers

const num = (v, d=0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fix = (v, digits, d=0) => { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(digits)) : d; };

const DIGITS = (k) => (k === 'avgThroughput' ? 1 : 2); // mirrors run.mjs rounding.  // :contentReference[oaicite:4]{index=4}
const byName = (a, b) => String(a).localeCompare(String(b), 'en');

/* Period keys (UTC) */
function isoWeekInfo(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(+d)) return null;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = target.getUTCDay() || 7; // 1..7 Mon..Sun
  target.setUTCDate(target.getUTCDate() + 4 - day); // Thursday
  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);

  const monday = new Date(target); monday.setUTCDate(target.getUTCDate() - 3); monday.setUTCHours(0,0,0,0);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6); sunday.setUTCHours(23,59,59,999);

  return { key: `${year}-W${String(week).padStart(2,'0')}`, from: monday.toISOString(), to: sunday.toISOString() };
}

function monthInfo(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(+d)) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth(); // 0..11
  const first = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const last  = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  return { key: `${y}-${String(m+1).padStart(2,'0')}`, from: first.toISOString(), to: last.toISOString() };
}

const getPeriod = (ts) => bucket === 'month' ? monthInfo(ts) : isoWeekInfo(ts);

/* Tiny async pool with back‑pressure */
class AsyncPool {
  constructor(limit) { this.limit = Math.max(1, limit|0); this.active = 0; this.q = []; }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally { this.active--; if (this.q.length) this.q.shift()(); }
      };
      (this.active < this.limit) ? run() : this.q.push(run);
    });
  }
}

/* Discovery (JSON files) */
async function* walkJSON(dir, { recursive }) {
  let dh; try { dh = await opendir(dir); } catch { return; }
  const entries = [];
  for await (const ent of dh) entries.push(ent);
  entries.sort((a,b) => a.name.localeCompare(b.name, 'en'));
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) { if (recursive) yield* walkJSON(full, { recursive }); continue; }
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) yield full;
  }
}

/* Validation & back‑compat (aligns with run.mjs schema, tolerant to future changes) */
function validateReportShape(report, file, metrics) {
  const warnings = [];
  if (!report || typeof report !== 'object') {
    warnings.push({ file, msg: 'Invalid JSON: not an object' }); return { ok:false, warnings };
  }
  const ts = typeof report.timestamp === 'string' ? report.timestamp : null;
  if (!ts) warnings.push({ file, msg: 'Missing/invalid "timestamp" (string)' });

  const s = (report && typeof report.summary === 'object') ? report.summary : {};
  const aliases = {
    avgLatencyMs: 'avgMsPerBatch',
    filesPerSecond: 'avgThroughput',
  };
  for (const k of metrics) {
    const v = s[k] ?? s[aliases[k]];
    if (!Number.isFinite(Number(v))) warnings.push({ file, msg: `summary.${k} missing or non-numeric` });
  }
  return { ok: true, warnings };
}

/* Aggregation */
function makeAgg(periodInfo, metricKeys) {
  const m = {}; for (const k of metricKeys) m[k] = { min: +Infinity, max: -Infinity, sum: 0, cnt: 0 };
  return { key: periodInfo.key, from: periodInfo.from, to: periodInfo.to, runs: 0, metrics: m, files: [] };
}
function finalizeAgg(agg, metricKeys) {
  const out = { period: agg.key, from: agg.from, to: agg.to, runs: agg.runs, metrics: {} };
  for (const k of metricKeys.sort(byName)) {
    const a = agg.metrics[k];
    if (a.cnt === 0) { out.metrics[k] = { min: 0, max: 0, avg: 0 }; continue; }
    out.metrics[k] = { min: fix(a.min, DIGITS(k)), max: fix(a.max, DIGITS(k)), avg: fix(a.sum / a.cnt, DIGITS(k)) };
  }
  return out;
}

/* CSV */
function toCSV(rows, metricKeys) {
  const head = ['period','from','to','runs',
    ...metricKeys.map(k => `${k}_min`),
    ...metricKeys.map(k => `${k}_avg`),
    ...metricKeys.map(k => `${k}_max`)
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    const vals = [r.period, r.from, r.to, String(r.runs)];
    for (const k of metricKeys) vals.push(String(r.metrics[k]?.min ?? 0));
    for (const k of metricKeys) vals.push(String(r.metrics[k]?.avg ?? 0));
    for (const k of metricKeys) vals.push(String(r.metrics[k]?.max ?? 0));
    lines.push(vals.join(','));
  }
  return lines.join('\n') + '\n';
}

/* ────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────── */
(async function main() {
  try { const st = await stat(rootDir); if (!st.isDirectory()) throw new Error('not a directory'); }
  catch { console.error(`❌ Cannot read directory: ${rootDir}`); process.exit(1); }

  const pool = new AsyncPool(concurrency);
  const files = [];
  for await (const f of walkJSON(rootDir, { recursive })) files.push(f);
  files.sort((a,b) => a.localeCompare(b, 'en'));

  if (files.length === 0) { console.log(`⚠️  No JSON files found under ${rootDir}`); process.exit(0); }

  const periods = new Map(); // key -> agg
  const warningsAll = [];
  let parsedOk = 0;

  await Promise.all(files.map(file => pool.schedule(async () => {
    let j;
    try { j = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { warningsAll.push({ file, msg: `Parse error: ${e?.message ?? String(e)}` }); return; }

    const { warnings } = validateReportShape(j, file, metricsList);
    if (warnings.length) warningsAll.push(...warnings);

    const ts = typeof j.timestamp === 'string' ? j.timestamp : null;
    const pi = ts ? getPeriod(ts) : null;
    if (!pi) { warningsAll.push({ file, msg: 'Cannot derive period key; skipping' }); return; }

    // Back‑compat value extraction (aliases allowed)
    const s = j?.summary ?? {};
    const aliases = { avgLatencyMs: 'avgMsPerBatch', filesPerSecond: 'avgThroughput' };
    const vals = {};
    for (const k of metricsList) vals[k] = num(s[k] ?? s[aliases[k]], 0);

    // Aggregate
    let agg = periods.get(pi.key); if (!agg) { agg = makeAgg(pi, metricsList); periods.set(pi.key, agg); }
    agg.runs++; agg.files.push(basename(file));
    for (const k of metricsList) {
      const v = vals[k]; if (!Number.isFinite(v)) continue;
      const a = agg.metrics[k]; a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); a.sum += v; a.cnt++;
    }
    parsedOk++;
  })));

  const keys = Array.from(periods.keys()).sort(byName);
  const rows = keys.map(k => finalizeAgg(periods.get(k), metricsList));

  const trendBook = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceDir: rootDir,
      bucket,
      reports: files.length,
      okReports: parsedOk,
      skippedReports: files.length - parsedOk,
      metrics: metricsList.slice().sort(byName),
      concurrency
    },
    warnings: warningsAll,
    periods: rows
  };
  if (bucket === 'week') trendBook.weeks = rows; // convenience alias for older consumers

  await mkdir(pathDirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(trendBook, null, 2), 'utf8');

  if (csvPath) {
    await mkdir(pathDirname(csvPath), { recursive: true });
    await writeFile(csvPath, toCSV(rows, metricsList), 'utf8');
  }

  if (PRETTY) {
    console.log(`\n📚 Trend book (${bucket}) → ${outPath}`);
    if (csvPath) console.log(`📄 CSV → ${csvPath}`);
    console.log(`   Periods: ${rows.length} | Reports: ${files.length} (ok ${parsedOk}, warn ${warningsAll.length})`);
    const head = ['Period','Runs', ...metricsList.map(k => `${k} min`), ...metricsList.map(k => `${k} avg`), ...metricsList.map(k => `${k} max`)];
    console.log(head.join(' | '));
    console.log('-'.repeat(head.join(' | ').length));
    for (const r of rows) {
      const row = [r.period, String(r.runs)];
      for (const k of metricsList) row.push(String(r.metrics[k]?.min ?? 0));
      for (const k of metricsList) row.push(String(r.metrics[k]?.avg ?? 0));
      for (const k of metricsList) row.push(String(r.metrics[k]?.max ?? 0));
      console.log(row.join(' | '));
    }
    if (VERBOSE && warningsAll.length) {
      console.log('\n⚠️  Warnings:');
      for (const w of warningsAll) console.log(` - ${w.file}: ${w.msg}`);
    }
  }
})().catch((e) => {
  console.error('❌ trend-book failed:', e?.stack || e?.message || String(e));
  process.exit(1);
});
