#!/usr/bin/env node
/* tools/trend-book.mjs
 * Consolidate RawNode‑ESM JSON reports into a per‑ISO‑week trend book.
 * Zero deps, Node 20+, deterministic, fully async with bounded concurrency.
 */

import { parseArgs } from 'node:util';
import { opendir, readFile, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import os from 'node:os';

/* ────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────── */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir:           { type: 'string' },
    out:           { type: 'string' },
    recursive:     { type: 'boolean', default: false },
    metrics:       { type: 'string', default: 'avgBatchSize,avgMsPerBatch,avgThroughput,efficiency' },
    concurrency:   { type: 'string' },
    pretty:        { type: 'boolean', default: true },
    verbose:       { type: 'boolean', default: false }
  }
});

const rootDir     = resolve(values.dir ?? positionals[0] ?? process.cwd());
const outPath     = resolve(values.out ?? join(process.cwd(), 'trend-book.json'));
const recursive   = !!values.recursive;
const metricsList = values.metrics.split(',').map(s => s.trim()).filter(Boolean);
const concurrency = Math.max(1, Number(values.concurrency ?? Math.min(8, os.cpus().length)));
const PRETTY      = !!values.pretty;
const VERBOSE     = !!values.verbose;

/* ────────────────────────────────────────────────────────────────
 * Helpers (deterministic guards & formatting)
 * ──────────────────────────────────────────────────────────────── */
const NF = new Intl.NumberFormat('en-US'); // console only; JSON remains pure numbers

const num = (v, d=0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fix = (v, digits, d=0) => { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(digits)) : d; };

const DIGITS = (k) => (k === 'avgThroughput' ? 1 : 2); // mirrors run.mjs rounding.  :contentReference[oaicite:3]{index=3}

/* Stable compare for strings */
const byName = (a, b) => String(a).localeCompare(String(b), 'en');

/* ISO week key + Monday..Sunday window, all in UTC */
function isoWeekInfo(isoTs) {
  const d = new Date(isoTs);
  if (!(d instanceof Date) || Number.isNaN(d)) return null;

  // Use a UTC date truncated to midnight
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week (ISO trick)
  const day = target.getUTCDay() || 7; // 1..7 (Mon..Sun); Sun->7
  target.setUTCDate(target.getUTCDate() + 4 - day);

  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);

  const monday = new Date(target);
  monday.setUTCDate(target.getUTCDate() - 3);
  monday.setUTCHours(0,0,0,0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23,59,59,999);

  return {
    key: `${year}-W${String(week).padStart(2,'0')}`,
    from: monday.toISOString(),
    to: sunday.toISOString()
  };
}

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

/* ────────────────────────────────────────────────────────────────
 * Discovery (JSON files)
 * ──────────────────────────────────────────────────────────────── */
async function* walkJSON(dir, { recursive }) {
  let dh;
  try { dh = await opendir(dir); } catch { return; }
  const entries = [];
  for await (const ent of dh) entries.push(ent);
  // stable ordering
  entries.sort((a,b) => a.name.localeCompare(b.name, 'en'));

  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) yield* walkJSON(full, { recursive });
      continue;
    }
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) yield full;
  }
}

/* ────────────────────────────────────────────────────────────────
 * Validation (aligns with run.mjs schema)
 * ──────────────────────────────────────────────────────────────── */
function validateReportShape(report, file, metrics) {
  const warnings = [];
  if (!report || typeof report !== 'object') {
    warnings.push({ file, msg: 'Invalid JSON: not an object' });
    return { ok:false, warnings };
  }
  if (typeof report.timestamp !== 'string') {
    warnings.push({ file, msg: 'Missing/invalid "timestamp" (string)' });
  }
  if (!report.summary || typeof report.summary !== 'object') {
    warnings.push({ file, msg: 'Missing/invalid "summary" object' });
  } else {
    for (const k of metrics) {
      const v = report.summary[k];
      if (!Number.isFinite(Number(v))) {
        warnings.push({ file, msg: `summary.${k} is missing or not numeric` });
      }
    }
  }
  // non-fatal; we’ll coerce with num()/fix() either way
  return { ok: true, warnings };
}

/* ────────────────────────────────────────────────────────────────
 * Aggregation
 * ──────────────────────────────────────────────────────────────── */
function makeWeekAgg(weekInfo, metricKeys) {
  const m = {};
  for (const k of metricKeys) m[k] = { min: +Infinity, max: -Infinity, sum: 0, cnt: 0 };
  return { key: weekInfo.key, from: weekInfo.from, to: weekInfo.to, runs: 0, metrics: m, files: [] };
}

function finalizeWeekAgg(wa, metricKeys) {
  const out = { week: wa.key, from: wa.from, to: wa.to, runs: wa.runs, metrics: {} };
  for (const k of metricKeys.sort(byName)) {
    const a = wa.metrics[k];
    if (a.cnt === 0) { out.metrics[k] = { min: 0, max: 0, avg: 0 }; continue; }
    out.metrics[k] = {
      min: fix(a.min, DIGITS(k)),
      max: fix(a.max, DIGITS(k)),
      avg: fix(a.sum / a.cnt, DIGITS(k)),
    };
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────── */
(async function main() {
  // sanity on dir
  try { const st = await stat(rootDir); if (!st.isDirectory()) throw new Error('not a directory'); }
  catch { console.error(`❌ Cannot read directory: ${rootDir}`); process.exit(1); }

  const pool = new AsyncPool(concurrency);
  const files = [];
  for await (const f of walkJSON(rootDir, { recursive })) files.push(f);
  files.sort((a,b) => a.localeCompare(b, 'en'));

  if (files.length === 0) {
    console.log(`⚠️  No JSON files found under ${rootDir}`);
    process.exit(0);
  }

  const weeks = new Map(); // key -> weekAgg
  const warningsAll = [];
  let parsedOk = 0;

  await Promise.all(files.map(file => pool.schedule(async () => {
    let j;
    try {
      const txt = await readFile(file, 'utf8');
      j = JSON.parse(txt);
    } catch (e) {
      warningsAll.push({ file, msg: `Parse error: ${e?.message ?? String(e)}` });
      return;
    }

    const { warnings } = validateReportShape(j, file, metricsList);
    if (warnings.length) warningsAll.push(...warnings);

    const ts = typeof j.timestamp === 'string' ? j.timestamp : null;
    const wi = ts ? isoWeekInfo(ts) : null;
    if (!wi) {
      warningsAll.push({ file, msg: 'Cannot derive ISO week (missing/invalid timestamp); skipping' });
      return;
    }

    // Pull numeric values with guards (same guard logic as CLI)  :contentReference[oaicite:4]{index=4}
    const vals = {};
    for (const k of metricsList) vals[k] = num(j?.summary?.[k], 0);

    // aggregate
    let agg = weeks.get(wi.key);
    if (!agg) { agg = makeWeekAgg(wi, metricsList); weeks.set(wi.key, agg); }
    agg.runs++;
    agg.files.push(basename(file));
    for (const k of metricsList) {
      const v = vals[k];
      if (!Number.isFinite(v)) continue;
      const a = agg.metrics[k];
      a.min = Math.min(a.min, v);
      a.max = Math.max(a.max, v);
      a.sum += v;
      a.cnt++;
    }
    parsedOk++;
  })));

  // finalize
  const weekKeys = Array.from(weeks.keys()).sort(byName);
  const weeksOut = weekKeys.map(k => finalizeWeekAgg(weeks.get(k), metricsList));

  const trendBook = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceDir: rootDir,
      reports: files.length,
      okReports: parsedOk,
      skippedReports: files.length - parsedOk,
      metrics: metricsList.slice().sort(byName),
      concurrency
    },
    warnings: warningsAll,
    weeks: weeksOut
  };

  // write JSON
  await import('node:fs/promises').then(async ({ writeFile, mkdir }) => {
    await mkdir(resolve(outPath, '..'), { recursive: true });
    await writeFile(outPath, JSON.stringify(trendBook, null, 2), 'utf8');
  });

  // pretty console (optional)
  if (PRETTY) {
    console.log(`\n📚 Trend book → ${outPath}`);
    console.log(`   Weeks: ${weeksOut.length} | Reports: ${files.length} (ok ${parsedOk}, warn ${warningsAll.length})`);
    // small table
    const head = ['Week','Runs', ...metricsList.map(k => `${k} min`), ...metricsList.map(k => `${k} avg`), ...metricsList.map(k => `${k} max`)];
    console.log(head.join(' | '));
    console.log('-'.repeat(head.join(' | ').length));
    for (const w of weeksOut) {
      const row = [w.week, String(w.runs)];
      for (const k of metricsList) row.push(String(w.metrics[k]?.min ?? 0));
      for (const k of metricsList) row.push(String(w.metrics[k]?.avg ?? 0));
      for (const k of metricsList) row.push(String(w.metrics[k]?.max ?? 0));
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
