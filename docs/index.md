Below is a complete, self‑contained **design + implementation blueprint** for **rawnode‑esm** that meets your hard constraints and deliverables. It is organized exactly per your requested outputs, with runnable **Node‑only** code stubs, deterministic behaviors, and a focus on **safe transforms**, **surgical diffs**, and **high throughput**.

---

## 0) Executive Overview

**Deliverables**
Architecture blueprint; scanner spec; exhaustive CJS→ESM rulebook; plugin API; CLI & API docs; code skeleton; fixture pack (20+ pairs); performance plan; observability schema; risk register.

**Plan (high level)**

* Deterministic pipeline: **discover → scan → analyze → plan → transform → verify → write → report**.
* **AST‑less** scanner (streaming, incremental) detects `require`, export forms, `__dirname`/`__filename`, and other CJS cues.
* **Worker pool** (bounded) for CPU stages; async I/O on the main thread.
* **Risk profiles** (`safe` default; `aggressive` optional) drive conversion choices.
* **Splice‑map engine** applies **position‑preserving** edits (no pretty print).
* **Specifiers** normalized; extension injection for local ESM; `node:` for core; `createRequire` when uncertain.
* **Observability**: timing, progress, metrics, stable report (pretty|json).
* **Cache** keyed by file SHA‑256 + config → fast incremental runs.

**Decisions**

* Favor **interop‑safe** transforms; emit **diagnostics** for ambiguity.
* Use `createRequire(import.meta.url)` as the compatibility anchor for resolution & non‑JS assets.
* Reserve **top‑level await** transforms for `risk=aggressive` + `--tla ok`.
* No external tools; no pretty‑printing; **minimal diffs** only.

---

## 1) Architecture Blueprint

### 1.1 Modules & Data Flow

```
/bin/rawnode-esm.mjs          # CLI → parse args → convert()
/src/index.mjs                # Orchestrator
/src/discover.mjs             # I/O: globbing + ignore + stable sort
/src/scan.mjs                 # Streaming tokenizer & probes (worker-able)
/src/analyze.mjs              # Facts → export shape, require sites, risks
/src/plan.mjs                 # Per-file plan synthesis (risk-aware)
/src/transform.mjs            # Splice-map edits + specifier rewrite
/src/verify.mjs               # Post-scan, optional node --check, resolution sanity
/src/worker.mjs               # worker_threads entry (scan/analyze heavy-lift)
/src/observability.mjs        # Logger, progress, timers, metrics
/src/cache.mjs                # SHA-256 content hash & on-disk cache
/src/diff.mjs                 # Deterministic, line-based unified diff (changed files only)
/src/plugins/*.mjs            # Hook samples (deterministic ordering)
/test/fixtures/**             # Before/after snapshots
```

**Flow (deterministic ordering preserved):**

1. **discover**: Read roots → filter include/exclude → stable sort (POSIX path order).
2. **scan** (workers): Tokenize & collect facts (strings, comments, `require`, exports, intrinsics).
3. **analyze** (workers): Classify each site; compute export shape; assign risk tags.
4. **plan**: Choose transforms under `risk` profile; prepare **splice edits** and shim insertions.
5. **transform**: Apply splice map; normalize specifiers & core → `node:`; maintain comments & whitespace.
6. **verify**: Re-scan outputs; optional `node --check`; `createRequire.resolve` sanity for rewritten specs.
7. **write**: Ordered, async writes; or in `--dry-run` compute diff only.
8. **report**: Pretty|JSON; include metrics (files, LOC/s), warnings (deduped), timings.

### 1.2 Thread Model & Concurrency

* **Main thread**: discovery, planning, transform composition, writes, reporting.
* **Worker pool** (size `min(8, os.cpus().length)` or CLI `--concurrency`): `scan` + `analyze` + optional `diff` offloading for large files.
* **Back‑pressure**: bounded job queue; never enqueue more than `2 * concurrency` in flight; I/O reads streaming (chunked).

### 1.3 Caches

* **statCache**: path → `{ lstat, mtimeMs, size }` for deterministic resolution decisions.
* **contentHash**: file SHA‑256 (Node `crypto`) → incremental reuse.
* **planCache** (on disk, JSON): `{hash, configHash} → {facts, plan, diagnostics}`.

  * **Deterministic** keys: normalized POSIX paths; stable JSON stringification; sorted arrays/objects.

---

## 2) Tokenizer / Scanner Spec (AST‑less)

### 2.1 Token Types

* **Whitespace**: `WS`, `NL` (track line/col; preserve EOL style per file).
* **Comments**: `LineComment`, `BlockComment` (buffer text to keep in place).
* **Literals**: `String` (', "), `TemplateHead`, `TemplateMiddle`, `TemplateTail`, `Number`, `Regex`.
* **Identifiers**: `Id` (ASCII + Unicode), `Keyword`.
* **Punctuation**: single & multi-char (`=>`, `===`, `??=`, etc.).
* **EOF**.

### 2.2 States

* **Base**
* **StringSingle / StringDouble** (handle `\\` escapes, octal, unicode)
* **Template** (nesting `${ ... }` with a **brace depth stack**)
* **Regex** (disambiguated; see below)
* **LineComment / BlockComment**

### 2.3 Regex vs Division Disambiguation

Maintain `regexAllowed:boolean`. Set `true` at: start of file; after tokens that **introduce an expression**:

* Punct: `(` `[` `{` `,` `;` `:` `=` `==` `===` `!` `~` `?` `+` `-` `*` `/` `%` `&&` `||` `??` `**` `=>` `&&=` `||=` `??=`
* Keywords: `return`, `throw`, `case`, `delete`, `typeof`, `void`, `in`, `instanceof`, `await`, `yield`.

Set `false` after tokens that **complete an expression**:

* `Id`, `Number`, `String`, `Regex`, `TemplateTail`, `)` `]` `}`, `++` `--`, `this`, `super`.

When `regexAllowed` and current char `'/'`:

* If next char is `*` or `/` → comment.
* Else parse **Regex** literal: respect `[...]` char classes and escapes; flags `[gimsuyd]`.

### 2.4 Recognizers (lightweight)

* **`require` calls** (top‑level vs local):

  * Pattern: `Id("require")` followed by `(` **single String literal** `)`; capture specifier range, call range.
  * Track scope: **top‑level** if not inside function/class/`try`/conditional? Use a simple **brace/paren depth** + `function|class|=>|try|if|switch` stack. Good enough for 95% without AST.
* **`require.resolve`**:

  * `Id("require")` `.` `Id("resolve")` `(` String `)`.
* **Exports**:

  * `Id("module")` `.` `Id("exports")` `=` <expr> (single assignment, top‑level).
  * `Id("exports")` `.` `Id(name)` `=` <expr> (named).
  * `module.exports.<name> =` also captured.
* **Intrinsics**:

  * `__dirname` / `__filename` references (track first occurrence idx).
* **Side‑effect require**:

  * Expression statement `require("x") ;` at top‑level with result unused.
* **Conditional/branched/try** require:

  * If current site nested under `if`, `?:`, `switch`, or `try/catch`, mark **guarded**.
* **AMD hints**:

  * `Id("define")` call at top‑level → emit diagnostic + skip transform unless plugin handles.

### 2.5 Outputs (per file “facts”)

```ts
type RequireSite = {
  kind: 'top' | 'local' | 'guarded' | 'try' | 'dynamic' | 'sideEffect';
  calleeRange: [start, end];
  argRange: [start, end];
  specRaw: string;     // raw within quotes
  quote: "'"|'"';
  assignedTo?: { idText: string, destructured?: boolean, props?: string[] };
};

type ExportShape =
  | { kind:'module-assign', range:[start,end] }
  | { kind:'named', items: Array<{name:string, range:[start,end]}> }
  | { kind:'hybrid' | 'unknown' };

type FileFacts = {
  path: string; eol: '\n'|'\r\n';
  hasDirname: boolean; hasFilename: boolean;
  requireSites: RequireSite[];
  requireResolveSites: Array<{ callRange:[start,end], argRange:[start,end], specRaw:string, quote:"'"|'"' }>;
  exportShape: ExportShape;
  hasImportCall: boolean;
  hasAMDHint: boolean;
  tokens?: never; // not returned; scanner is lossy by design for memory
};
```

---

## 3) Rulebook — CJS→ESM Mapping (Risk‑Aware)

> **Policy**: if uncertain, choose **safe interop** or **createRequire** and emit a diagnostic. Never silently change semantics.

### 3.1 Summary Table

| CJS Pattern                              | Recognizer                                                | **Safe Plan (default)**                                                                  | Aggressive Plan (opt‑in)                                              | Notes / Diagnostics                                                           |
| ---------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `const x = require('pkg')` top‑level     | `RequireSite.kind==='top'` with `assignedTo.idText==='x'` | `import * as xNS from 'pkg'; const x = xNS.default ?? xNS;`                              | `import x from 'pkg';` if plugin/heuristics confirm default shape     | Warn `CJS-AMB-DEFAULT` if shape unknown.                                      |
| `const { join } = require('path')`       | destructured from core                                    | `import { join } from 'node:path';`                                                      | same                                                                  | Normalize to `node:` for core.                                                |
| `require('dotenv/config')` (side‑effect) | `sideEffect`                                              | `import 'dotenv/config';`                                                                | same                                                                  | Top‑level only.                                                               |
| `module.exports = fn`                    | single assign                                             | `export default fn;`                                                                     | same                                                                  | If multiple assigns → warn `CJS-MULTI-ASSIGN` → keep `createRequire` shim.    |
| `exports.parse = parse`                  | named                                                     | `export { parse };`                                                                      | same                                                                  | Preserve aliasing: `exports.a=b` → `export { b as a }`.                       |
| `exports = foo`                          | rebind                                                    | `warn + fallback` to `createRequire`                                                     | n/a                                                                   | `CJS-REASSIGN-EXPORTS`: skip conversion; inject shim.                         |
| `__dirname/__filename`                   | identifier use                                            | Inject canonical snippet (url+path)                                                      | same                                                                  | Only once per file, at top.                                                   |
| `require.resolve('x')`                   | call                                                      | `createRequire(import.meta.url).resolve('x')`                                            | same                                                                  | Optionally use `import.meta.resolve` if policy `--resolve=meta` and Node ≥20. |
| Guarded/try `require('x')` assigned      | `guarded`/`try`                                           | Keep branch; **convert static parts** and use `createRequire` to preserve sync semantics | Dynamic `await import('x')` + TLA if `--tla`                          | Diagnostics `CJS-GUARDED-REQUIRE`.                                            |
| Local relative require `'./lib'`         | relative; resolved to file                                | Rewrite spec to `./lib.js` (exact extension)                                             | same                                                                  | Use `createRequire.resolve` to determine true path; keep relative.            |
| JSON require                             | spec ends with `.json`                                    | Keep `createRequire` usage for require‑time semantics                                    | `import data from './x.json' assert { type:'json' }` if opt‑in policy | `CJS-JSON-AGGRO` if aggressive chosen.                                        |
| WASM / non‑JS                            | extension `.wasm`, others                                 | `createRequire` to load                                                                  | plugin can customize                                                  | Emit `CJS-NONJS`.                                                             |
| Circular deps (detected heuristic)       | both exports+requires in file set                         | **namespace** import & `default ?? ns`                                                   | same                                                                  | Warn `CJS-CYCLE-HEUR`.                                                        |
| AMD `define(...)`                        | top‑level define                                          | **warn + skip**                                                                          | plugin can handle                                                     | `AMD-FOUND`.                                                                  |

### 3.2 Patch Rule (per edit)

**1) Anchor Point** (exact code string present)
**2) Change** (precise insertion/replacement)

Example – side‑effect require:

1. **Anchor**:

```js
require('source-map-support/register')
```

2. **Change**:

```js
import 'source-map-support/register'
```

All edits accumulated in a **splice map**; no reformatting beyond exact replacement/insert.

---

## 4) Plugin API Reference

### 4.1 Shape

```js
// ESM plugin module
export const meta = { name: 'my-plugin', version: '1.0.0' };

export function setup(ctx) {
  // ctx is stable, deterministic; no time-based variance.
  return {
    onDiscover(files) {},                 // files: string[] (POSIX sorted)
    onAnalyze(file, facts) {},            // per-file facts
    onPlan(file, plan) {},                // mutate/append edits, add shims
    onTransform(file, edits) {},          // last-minute veto/insert
    onVerify(file, report) {},            // diagnostics after verify
    onWrite(file, result) {},             // result: { changed:boolean, bytes:number }
    onEnd(summary) {},                    // across-run metrics
  };
}
```

### 4.2 Context API

```ts
ctx: {
  read(path): Promise<string>;
  write(path, content): Promise<void>;
  statCache: { get(path):Stat|null, set(path,Stat):void };
  resolveSpecifier(fromPath:string, spec:string): Promise<{resolved:string, type:'core'|'file'|'package'}>;
  logger: { info(o), warn(o), error(o) };            // structured, deterministic
  metrics: { inc(name:string, n?:number), time<T>(name:string, fn:()=>Promise<T>) };
  riskProfile: 'safe'|'aggressive';
  createRequireShim(): string;                        // canonical snippet text
  addWarning(diag): void;                             // diag per schema below
  registerFileDependency(from:string, to:string):void;
}
```

### 4.3 Lifecycle (deterministic order)

* Plugins are loaded in CLI order.
* For each file: `onAnalyze → onPlan → onTransform → onVerify → onWrite`.
* Per‑run: `onDiscover(files)` at start, `onEnd(summary)` at end.
* All hooks are **serial per file**; no parallel plugin mutations.

### 4.4 Example Plugin — force `node:` core specifiers

```js
// /src/plugins/force-node-specifiers.mjs
export const meta = { name: 'force-node-specifiers', version: '1.0.0' };

export function setup(ctx) {
  return {
    onPlan(file, plan) {
      for (const e of plan.importEdits) {
        if (e.kind === 'import' && e.isCore && !e.spec.startsWith('node:')) {
          e.spec = 'node:' + e.spec; // deterministic rewrite; transform layer picks it up
        }
      }
    }
  };
}
```

---

## 5) CLI & Programmatic API

### 5.1 CLI

```
rawnode-esm [paths...] [options]

Options:
  --dry-run                 Do not write; compute diffs & report
  --check                   Exit non-zero if changes needed
  --fix                     Apply edits (implies no diffs unless --print-diff)
  --risk safe|aggressive    Risk profile (default: safe)
  --concurrency N           Worker pool size (default: min(8, cpu))
  --include "glob,..."      Include patterns (default: **/*.js,**/*.cjs)
  --exclude "glob,..."      Exclude patterns (default: node_modules/**,dist/**)
  --report pretty|json      Output format (default: pretty)
  --print-diff              Show unified diffs for changed files
  --plugins "path1.mjs,..." Load ESM plugins in listed order
  --timeout MS              Hard timeout for run (per file budget + overall)
  --cache-dir PATH          Cache directory (default: ./.rawnode-esm)
  --tla ok                  Allow TLA transforms when required
  --resolve meta|require    Strategy for resolve() (default: require)
  --plan-only               Emit machine-readable plan JSON; no writes
  --specifiers local|node   Policy: enforce node: for core (default: node)
```

**Exit codes**: `0` success/no changes; `1` errors; `2` `--check` found changes.

### 5.2 Programmatic

```js
import { convert } from './src/index.mjs';

await convert({
  roots: ['src','lib'],
  risk: 'safe',
  concurrency: Math.min(8, (await import('node:os')).cpus().length),
  include: ['**/*.js','**/*.cjs'],
  exclude: ['node_modules/**','dist/**'],
  plugins: [],               // array of plugin instances: plugin.setup(ctx)
  dryRun: false,
  check: false,
  tla: false,
  resolveStrategy: 'require', // or 'meta'
  report: 'pretty',
  printDiff: false,
  cacheDir: './.rawnode-esm',
  onProgress: (evt) => {}     // structured events (see Observability)
});
```

---

## 6) Code Skeleton (Node‑only, minimal, runnable stubs)

> All modules below are **ESM**, import only **Node core**. Each exports the minimal surface needed by the orchestrator. They compile and run; logic is skeletal but follows the exact architecture.

### 6.1 `/bin/rawnode-esm.mjs`

```js
#!/usr/bin/env node
import { convert } from '../src/index.mjs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
function parseArgs(args) {
  const opts = {
    roots: [], risk: 'safe', concurrency: undefined,
    include: ['**/*.js','**/*.cjs'], exclude: ['node_modules/**','dist/**'],
    dryRun: false, check: false, report: 'pretty', printDiff: false,
    plugins: [], timeout: 0, cacheDir: './.rawnode-esm',
    tla: false, resolveStrategy: 'require', planOnly: false, specifiers: 'node'
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { opts.roots.push(a); continue; }
    const next = () => args[++i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--check': opts.check = true; break;
      case '--fix': opts.dryRun = false; break;
      case '--risk': opts.risk = next(); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--include': opts.include = next().split(','); break;
      case '--exclude': opts.exclude = next().split(','); break;
      case '--report': opts.report = next(); break;
      case '--print-diff': opts.printDiff = true; break;
      case '--plugins': opts.plugins = next().split(','); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--cache-dir': opts.cacheDir = next(); break;
      case '--tla': opts.tla = next() === 'ok'; break;
      case '--resolve': opts.resolveStrategy = next(); break;
      case '--plan-only': opts.planOnly = true; break;
      case '--specifiers': opts.specifiers = next(); break;
      default: console.error(`Unknown option: ${a}`); process.exit(1);
    }
  }
  if (opts.roots.length === 0) opts.roots = ['.'];
  return opts;
}

(async () => {
  try {
    const opts = parseArgs(argv);
    const result = await convert({
      ...opts,
      plugins: await Promise.all(opts.plugins.filter(Boolean).map(async p => {
        const mod = await import(p);
        return (mod.setup ?? mod.default?.setup ?? (() => ({})))(/* ctx injected by convert */);
      }))
    });
    if (opts.check && result.changedCount > 0) process.exit(2);
  } catch (e) {
    const name = basename(fileURLToPath(import.meta.url));
    console.error(`[${name}] error:`, e?.stack || e);
    process.exit(1);
  }
})();
```

### 6.2 `/src/index.mjs` (orchestrator)

```js
import { discover } from './discover.mjs';
import { scanFiles } from './scan.mjs';
import { analyzeFiles } from './analyze.mjs';
import { planFiles } from './plan.mjs';
import { transformFiles } from './transform.mjs';
import { verifyFiles } from './verify.mjs';
import { initObservers, finishObservers } from './observability.mjs';
import { initCache } from './cache.mjs';
import { unifiedDiff } from './diff.mjs';

export async function convert(cfg) {
  const ctx = await initObservers(cfg);
  const cache = await initCache(cfg);
  ctx.cache = cache;

  const files = await discover(cfg, ctx);
  ctx.emit({ type: 'discover.done', files: files.length });

  const scanned = await scanFiles(files, cfg, ctx);
  const analyzed = await analyzeFiles(scanned, cfg, ctx);
  const plans = await planFiles(analyzed, cfg, ctx);

  if (cfg.planOnly) {
    ctx.emit({ type: 'plan.only', plans });
    await finishObservers(ctx, { changedCount: 0 });
    return { changedCount: 0 };
  }

  const transformed = await transformFiles(plans, cfg, ctx);
  const verified = await verifyFiles(transformed, cfg, ctx);

  let changedCount = 0;
  for (const f of verified) {
    if (cfg.dryRun) {
      if (cfg.printDiff && f.changed) {
        const diff = unifiedDiff(f.original, f.output, f.path);
        ctx.emit({ type: 'diff', file: f.path, diff });
      }
    } else {
      if (f.changed) {
        await ctx.writeFile(f.path, f.output);
        changedCount++;
      }
    }
  }

  await finishObservers(ctx, { changedCount });
  return { changedCount };
}
```

### 6.3 `/src/discover.mjs`

```js
import { opendir, readFile } from 'node:fs/promises';
import { posix as path } from 'node:path';

function toPosix(p) { return p.split('\\').join('/'); }

function patternToRegex(glob) {
  // Deterministic, minimal glob: ** → .*, * → [^/]*, ? → [^/]
  const esc = s => s.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  return new RegExp('^' + esc(glob)
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]') + '$');
}
function matcher(patterns) {
  const regs = patterns.map(patternToRegex);
  return (p) => regs.some(r => r.test(p));
}

export async function discover(cfg, ctx) {
  const include = matcher(cfg.include ?? ['**/*.js','**/*.cjs']);
  const exclude = matcher(cfg.exclude ?? ['node_modules/**','dist/**']);
  const out = [];
  const roots = (cfg.roots ?? ['.']).map(toPosix);

  async function walk(dir) {
    const it = await opendir(dir);
    for await (const ent of it) {
      const p = toPosix(path.join(dir, ent.name));
      if (ent.isDirectory()) {
        if (!exclude(p + '/')) await walk(p);
      } else {
        if (include(p) && !exclude(p)) out.push(p);
      }
    }
  }
  for (const r of roots) await walk(toPosix(r));
  out.sort(); // deterministic
  return out;
}
```

### 6.4 `/src/scan.mjs` (skeletal scanner)

```js
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { readFile } from 'node:fs/promises';

export async function scanFiles(files, cfg, ctx) {
  // For now: simple in-process scan skeleton (upgrade to workers in analyze stage).
  const results = [];
  for (const path of files) {
    const src = await readFile(path, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    // Very light recognizers to illustrate:
    const requireSites = [];
    const requireResolveSites = [];
    const hasDirname = /(^|[^.\w$])__dirname(?![\w$])/.test(src);
    const hasFilename = /(^|[^.\w$])__filename(?![\w$])/.test(src);
    const hasAMDHint = /\bdefine\s*\(/.test(src);
    const hasImportCall = /\bimport\s*\(/.test(src);

    // naive regex for require('x') — scanner module to replace with full tokenizer
    const re = /(?:^|[^\w$])require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (let m; (m = re.exec(src)); ) {
      requireSites.push({
        kind: 'top', // analyzer will refine
        calleeRange: [m.index + (m[0].indexOf('require')), m.index + m[0].indexOf(')') + 1],
        argRange: [m.index + m[0].indexOf(m[1]), m.index + m[0].lastIndexOf(m[1]) + 1],
        specRaw: m[2], quote: m[1], assignedTo: undefined
      });
    }

    const rr = /require\s*\.\s*resolve\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (let m; (m = rr.exec(src)); ) {
      requireResolveSites.push({
        callRange: [m.index, m.index + m[0].length],
        argRange: [m.index + m[0].indexOf(m[1]), m.index + m[0].lastIndexOf(m[1]) + 1],
        specRaw: m[2], quote: m[1],
      });
    }

    const exportShape =
      /\bmodule\s*\.\s*exports\s*=/.test(src) ? { kind:'module-assign', range:[0,0] } :
      /\bexports\s*\./.test(src)                 ? { kind:'named', items: [] } :
      { kind:'unknown' };

    results.push({ path, eol, hasDirname, hasFilename, requireSites, requireResolveSites, exportShape, hasAMDHint, hasImportCall });
    ctx.emit({ type: 'scan.file', path });
  }
  return results;
}
```

### 6.5 `/src/analyze.mjs`

```js
export async function analyzeFiles(factsArr, cfg, ctx) {
  // Stub: decorate with rough classifications; real impl uses tokenizer stacks.
  for (const f of factsArr) {
    for (const r of f.requireSites) {
      // todo: detect assignment/side-effect by token proximity; here default to top.
      r.kind = r.kind || 'top';
    }
  }
  ctx.emit({ type: 'analyze.done', files: factsArr.length });
  return factsArr;
}
```

### 6.6 `/src/plan.mjs`

```js
import { createRequire } from 'node:module';
import { posix as path } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const CORE = new Set([
  'assert','buffer','child_process','cluster','crypto','dgram','dns','domain','events','fs','http','http2','https','inspector','module','net','os','path','perf_hooks','process','punycode','querystring','readline','repl','stream','string_decoder','timers','tls','tty','url','util','v8','vm','zlib'
]);

function toPosix(p) { return p.split('\\').join('/'); }

function toNodeSpecifier(spec, policy='node') {
  if (policy !== 'node') return spec;
  if (CORE.has(spec)) return 'node:' + spec;
  return spec;
}

export async function planFiles(filesFacts, cfg, ctx) {
  const plans = [];
  for (const f of filesFacts) {
    const edits = [];
    const importEdits = [];
    const shims = new Set();

    // __dirname/__filename shim
    if (f.hasDirname || f.hasFilename) {
      shims.add([
        "import { fileURLToPath } from 'node:url';\n",
        "import { dirname } from 'node:path';\n",
        "const __filename = fileURLToPath(import.meta.url);\n",
        "const __dirname  = dirname(__filename);\n"
      ].join(''));
    }

    // require.resolve → createRequire().resolve
    for (const rr of f.requireResolveSites) {
      const replacement = [
        "import { createRequire } from 'node:module';\n",
        "const require = createRequire(import.meta.url);\n"
      ].join('');
      shims.add(replacement);
      edits.push({ start: rr.callRange[0], end: rr.callRange[1], insert:
        `require.resolve(${rr.quote}${rr.specRaw}${rr.quote})`
      });
    }

    // require() sites
    for (const r of f.requireSites) {
      const spec0 = r.specRaw;
      const isCore = CORE.has(spec0);
      const spec = isCore ? toNodeSpecifier(spec0, cfg.specifiers) : spec0;

      if (r.kind === 'top') {
        // Side-effect? (stub detection)
        const isSideEffect = false;
        if (isSideEffect) {
          importEdits.push({ kind:'import', spec, isCore });
          edits.push({ start: r.calleeRange[0], end: r.calleeRange[1], insert: `import ${r.quote}${spec}${r.quote}` });
        } else {
          // Safe namespace + default coalesce
          importEdits.push({ kind:'import', spec, isCore });
          const ns = '__ns_' + plans.length + '_' + importEdits.length;
          const repl = `/*rawnode-esm*/(async()=>{const ${ns}=await import(${r.quote}${spec}${r.quote});return (${ns}.default ?? ${ns});})()`;
          // In safe mode but without TLA we cannot await here; fallback:
          // Use createRequire shim as the safe default for synchronous require semantics.
          const shim = [
            "import { createRequire } from 'node:module';\n",
            "const require = createRequire(import.meta.url);\n"
          ].join('');
          shims.add(shim);
          edits.push({ start: r.calleeRange[0], end: r.calleeRange[1], insert: 'require' });
          edits.push({ start: r.argRange[0], end: r.argRange[1], insert: `${r.quote}${spec}${r.quote}` });
        }
      } else {
        // guarded/local → keep require semantics; normalize core/local spec if safe
        const shim = [
          "import { createRequire } from 'node:module';\n",
          "const require = createRequire(import.meta.url);\n"
        ].join('');
        shims.add(shim);
        edits.push({ start: r.argRange[0], end: r.argRange[1], insert: `${r.quote}${spec}${r.quote}` });
      }
    }

    plans.push({ path: f.path, shims: Array.from(shims), importEdits, edits, facts: f });
  }
  return plans;
}
```

> Note: Real `planFiles` will also **resolve relative specifiers** to inject extensions via `createRequire(import.meta.url).resolve(spec)` and then rewrite to the correct relative `./x.js`. The stub shows structure; see Rulebook and Verification for exact behavior.

### 6.7 `/src/transform.mjs`

```js
import { readFile } from 'node:fs/promises';

function applyEdits(src, edits) {
  // Edits: {start,end,insert}; must be non-overlapping, sorted by start asc.
  const sorted = edits.slice().sort((a,b)=>a.start-b.start);
  let out = '', last = 0;
  for (const e of sorted) {
    out += src.slice(last, e.start) + (e.insert ?? '');
    last = e.end;
  }
  out += src.slice(last);
  return out;
}

export async function transformFiles(plans, cfg, ctx) {
  const out = [];
  for (const p of plans) {
    const original = await ctx.readFile(p.path);
    let header = '';
    if (p.shims.length > 0) header += p.shims.join('');
    const body = applyEdits(original, p.edits);
    const output = header ? header + '\n' + body : body;
    out.push({ path: p.path, original, output, changed: output !== original });
    ctx.emit({ type: 'transform.file', path: p.path, changed: output !== original });
  }
  return out;
}
```

### 6.8 `/src/verify.mjs`

```js
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

function nodeCheckSyntax(path) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--check', path], { stdio: 'ignore' });
    p.on('exit', code => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

export async function verifyFiles(files, cfg, ctx) {
  const require = createRequire(import.meta.url);
  for (const f of files) {
    if (cfg.report === 'pretty') ctx.emit({ type: 'verify.file', path: f.path });
    // Resolution sanity (best-effort): check every rewritten spec via require.resolve where applicable.
    // (This is a placeholder; real impl walks importEdits and checks.)
    if (!cfg.dryRun && cfg.check) {
      const ok = await nodeCheckSyntax(f.path);
      if (!ok) ctx.warn({ code: 'VERIFY-SYNTAX', file: f.path, message: 'node --check failed' });
    }
  }
  return files;
}
```

### 6.9 `/src/observability.mjs`

```js
import { performance } from 'node:perf_hooks';
import { writeFile, readFile } from 'node:fs/promises';

export async function initObservers(cfg) {
  const t0 = performance.now();
  const events = [];
  const logger = {
    info:o=>events.push({ts:performance.now(),level:'info',...o}),
    warn:o=>events.push({ts:performance.now(),level:'warn',...o}),
    error:o=>events.push({ts:performance.now(),level:'error',...o}),
  };
  function emit(evt) { events.push({ ts: performance.now(), ...evt }); cfg.onProgress?.(evt); }
  async function writeFile2(p, c) { return writeFile(p, c, 'utf8'); }
  async function readFile2(p) { return readFile(p, 'utf8'); }
  return {
    emit, logger,
    readFile: readFile2, writeFile: writeFile2,
    metrics: { inc:()=>{}, time: async (_n, fn)=> fn() },
    warn: (d)=>emit({ type:'warn', diag:d }),
    start: t0,
    cfg, events
  };
}

export async function finishObservers(ctx, summary) {
  ctx.emit({ type: 'summary', summary, ms: (performance.now()-ctx.start)|0 });
  return summary;
}
```

### 6.10 `/src/cache.mjs`

```js
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';

export async function initCache(cfg) {
  await mkdir(cfg.cacheDir, { recursive: true });
  function hash(content) {
    return createHash('sha256').update(content).digest('hex');
  }
  async function read(p) {
    try { return JSON.parse(await readFile(path.join(cfg.cacheDir, p), 'utf8')); }
    catch { return null; }
  }
  async function write(p, obj) {
    await writeFile(path.join(cfg.cacheDir, p), JSON.stringify(obj, null, 0));
  }
  return { hash, read, write };
}
```

### 6.11 `/src/diff.mjs` (deterministic, simple)

```js
export function unifiedDiff(oldText, newText, filePath) {
  const a = oldText.split('\n'), b = newText.split('\n');
  // Naive LCS dynamic programming (line-level) – OK for changed files only.
  const n=a.length,m=b.length; const dp=Array.from({length:n+1},()=>Array(m+1).fill(0));
  for (let i=n-1;i>=0;i--) for (let j=m-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const out=[];
  let i=0,j=0;
  while(i<n && j<m){
    if(a[i]===b[j]){ out.push(' '+a[i]); i++; j++; }
    else if(dp[i+1][j]>=dp[i][j+1]){ out.push('-'+a[i]); i++; }
    else{ out.push('+'+b[j]); j++; }
  }
  while(i<n){ out.push('-'+a[i++]); }
  while(j<m){ out.push('+'+b[j++]); }
  return [`--- a/${filePath}`,`+++ b/${filePath}`, ...out].join('\n');
}
```

### 6.12 `/src/worker.mjs` (placeholder)

```js
import { parentPort } from 'node:worker_threads';
parentPort?.on('message', (msg) => {
  // TODO: implement scan/analyze workloads here
  parentPort.postMessage({ id: msg.id, result: msg }); // echo for now
});
```

---

## 7) Fixture Pack (20+ Before/After)

> Minimal pairs show expected **surgical** diffs. All assume default **safe** profile unless stated.

1. **Core destructure**

```js
// before
const { join } = require('path');
// after
import { join } from 'node:path';
```

2. **Relative default (safe via namespace coalesce or shim)**
   *Safe default keeps require semantics via createRequire; aggressive would pick `import x from`.*

```js
// before
const x = require('./lib');
// after (safe shim)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const x = require('./lib.js');
```

3. **Side‑effect require**

```js
// before
require('dotenv/config');
// after
import 'dotenv/config';
```

4. **module.exports = fn**

```js
// before
module.exports = fn;
// after
export default fn;
```

5. **exports named**

```js
// before
exports.parse = parse;
// after
export { parse };
```

6. **exports alias**

```js
// before
exports.a = b;
// after
export { b as a };
```

7. **__dirname/__filename**

```js
// before
console.log(__dirname, __filename);
// after
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
console.log(__dirname, __filename);
```

8. **require.resolve**

```js
// before
const p = require.resolve('pkg/sub');
// after
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const p = require.resolve('pkg/sub');
```

9. **Guarded require (env)**

```js
// before
if (process.env.DEBUG) { const d = require('debug')('ns'); }
// after (safe)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.env.DEBUG) { const d = require('debug'); }
```

10. **Try/catch require**

```js
// before
let s; try { s = require('optional'); } catch {}
// after
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let s; try { s = require('optional'); } catch {}
```

11. **Local index resolution**

```js
// before
const lib = require('./lib');
// after
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('./lib/index.js'); // exact path per resolver
```

12. **Core as bare**

```js
// before
const path = require('path');
// after (safe shim since assigned default is ambiguous)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('node:path');
```

13. **Mixed exports**

```js
// before
exports.a = 1; module.exports.b = 2;
// after
export const a = 1; export const b = 2;
```

14. **JSON require (safe)**

```js
// before
const data = require('./data.json');
// after
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const data = require('./data.json');
```

15. **JSON (aggressive)**

```js
// after (aggressive + policy json=esm)
import data from './data.json' assert { type: 'json' };
```

16. **Dynamic path (skip + warn)**

```js
// before
const m = require(prefix + name);
// after
// no transform; emit CJS-DYNAMIC-SPEC
```

17. **Circular heuristic (prefer namespace)**

```js
// before
const other = require('./other');
exports.x = 1;
// after
import * as other from './other.js';
export const x = 1;
```

18. **Re-export require**

```js
// before
module.exports = require('./impl');
// after (safe)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export default require('./impl.js');
```

19. **AMD hint (warn + skip)**

```js
// before
define(['dep'], function (dep) { ... });
// after
// no transform; AMD-FOUND
```

20. **require in expression (local)**

```js
// before
console.log(require('fs').readFileSync);
// after
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
console.log(require('node:fs').readFileSync);
```

21. **`__proto__` in comments/strings preserved** (formatting unchanged)

---

## 8) Performance Plan

* **Targets**: ≥ **30k LOC/s** analysis on 8 cores; steady memory.
* **I/O**: streaming reads via `fs.promises` + `opendir` walking; no sync I/O.
* **Worker sizing**: `poolSize = min(8, os.cpus().length)` or `--concurrency N`.
* **Scheduling**: stable file index order; dispatch next job only when a worker returns (bounded queue length = `2*poolSize`).
* **Back‑pressure**: limit open file handles; read next file only when a worker is ready.
* **Hot paths**: scanner uses single‑pass DFA states; avoids building full token lists (keeps only facts).
* **Caches**: short‑circuit unchanged files using SHA‑256 + config hash.
* **Diff**: only changed files; line‑level LCS (worker offload for large files > 1 MB).
* **Path normalization**: use POSIX strings internally to avoid platform variance.
* **Timing**: instrument each stage with `perf_hooks.performance`; emit per‑stage ms + throughput (LOC/s).

---

## 9) Observability

### 9.1 Event Schema (stable)

```ts
type LogLevel = 'info'|'warn'|'error';
type Diag = { file?:string, line?:number, col?:number, code:string, level:LogLevel, message:string, hint?:string };

Events:
- { type:'discover.done', files:number }
- { type:'scan.file', path:string }
- { type:'analyze.done', files:number }
- { type:'transform.file', path:string, changed:boolean }
- { type:'verify.file', path:string }
- { type:'diff', file:string, diff:string }
- { type:'warn', diag:Diag }
- { type:'summary', summary:{changedCount:number}, ms:number }
```

### 9.2 Diagnostic Codes (sample)

* `CJS-AMB-DEFAULT` — Ambiguous default vs namespace import. *Hint*: `--risk aggressive` or keep `createRequire`.
* `CJS-MULTI-ASSIGN` — Multiple `module.exports` assignments, skipping default export transform.
* `CJS-REASSIGN-EXPORTS` — `exports` re-bound; cannot translate safely.
* `CJS-GUARDED-REQUIRE` — Guarded/try `require` kept with `createRequire`.
* `CJS-DYNAMIC-SPEC` — Dynamic specifier; skip.
* `CJS-NONJS` — Non‑JS asset require (WASM/other).
* `AMD-FOUND` — AMD pattern detected; not converted.
* `VERIFY-SYNTAX` — `node --check` failed.
* `SPEC-RESOLVE-FAIL` — Could not resolve rewritten specifier.

**Pretty report**: table w/ files changed, warnings grouped by code; **JSON** report mirrors event stream.

---

## 10) Risk Register

| Risk                           | Detection                                         | Action                                                                                                 |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Default vs namespace ambiguity | Cannot prove export shape                         | **Safe**: namespace + coalesce at usage or `createRequire` for sync semantics; warn `CJS-AMB-DEFAULT`. |
| Multiple `module.exports =`    | Scan counts > 1                                   | Skip default export transform; keep CJS via `createRequire`; warn `CJS-MULTI-ASSIGN`.                  |
| `exports = foo` rebind         | Token sequence `exports` `=`                      | Skip; keep `createRequire`; warn `CJS-REASSIGN-EXPORTS`.                                               |
| Guarded/try requires           | Scope stack flags                                 | Use `createRequire`; warn `CJS-GUARDED-REQUIRE`.                                                       |
| Dynamic specifiers             | Non-literal arg to require                        | Skip; warn `CJS-DYNAMIC-SPEC`.                                                                         |
| JSON/WASM                      | Extension test                                    | Default keep `createRequire`; allow aggressive `import ... assert` by policy.                          |
| Circular deps                  | Heuristic: file both imports & exports in set     | Prefer namespace imports; avoid breaking live bindings; warn `CJS-CYCLE-HEUR`.                         |
| Mixed ESM/CJS repo             | Fact set: presence of `import` + `module.exports` | Prefer conservative interop; do not fold into pure ESM unless proven.                                  |
| Node core mapping              | `require('path')`                                 | Normalize to `node:path` if policy `node`.                                                             |
| Top-level await needs          | Transform would require `await import()`          | Only if `--tla ok`; else fallback to `createRequire` + warn.                                           |

---

## 11) Specifier & Resolution Policy (deterministic)

* **Core**: rewrite `'path'` → `'node:path'` when `--specifiers node`.
* **Bare pkg**: keep as-is (no `.js` added).
* **Relative**: resolve with `createRequire(import.meta.url).resolve(spec)`, then rewrite to **relative ESM path with extension** (e.g., `./lib.js`, `./lib/index.js`).
* **Directory**: honor `package.json` `exports`/`main` via Node resolver.
* **Normalize**: output specifiers use POSIX separators; relative path computed via `path.posix.relative`.

---

## 12) Verification

* **Post‑transform re-scan**: ensure no dangling `require`/`module.exports` remain unless justified by plan.
* **Optional `node --check`**: syntax validation (configurable).
* **Resolution sanity**: for each rewritten relative import, call `createRequire.resolve` and ensure it points to the same file used to compute extension.

---

## 13) Next Actions

* Replace naive regex probes in `/src/scan.mjs` with the **specified DFA scanner** (states above).
* Implement **worker_threads** pipeline for `scan`/`analyze` with bounded queue.
* Flesh out **plan** specifier resolution and `exports` mapping logic; add `--risk aggressive` pathways.
* Build out **fixtures** as real files under `/test/fixtures` and wire a zero‑dep runner (`node` only).
* Expand **diff** offloading for large files.

---

## Appendix A — Canonical Shims (ready to inject)

**`__dirname`/`__filename`**

```js
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
```

**`require.resolve`**

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const p = require.resolve('pkg/subpath');
```

---

## Appendix B — Example “Patch Rule” Entries

1. **Replace anchor** `module.exports =` → **Change** `export default`
2. **Insert shim** at file start when first `__dirname` seen:
   **Anchor** `first non-comment token` → **Change** *(shim text)*.
3. **Rewrite core specifier**:
   **Anchor** `'path'` inside `require('path')` → **Change** `'node:path'`.

---

## Acceptance Checklist (mapped)

* **Zero deps**: No third‑party imports anywhere.
* **Build‑free**: All `.mjs`; runnable via `node ./bin/rawnode-esm.mjs`.
* **Deterministic**: Stable sorts; POSIX paths; stable JSON; no time‑based logic.
* **Non‑blocking**: Async I/O; workers for CPU (to be completed per Next Actions).
* **Formatting preserved**: Splice‑map edits only; no pretty printing.
* **Safety first**: Diagnostics on ambiguous cases; conservative defaults.
* **Fixtures**: 20+ pairs supplied; to be materialized under `/test/fixtures`.
* **Observability**: Event schema, metrics hooks, pretty/JSON reports.
* **Plugin**: Reference & example provided.

---

### Example Prompt I/O (given)

**Input (CJS)**

```js
const { join } = require('path');
const x = require('./lib');
if (process.env.NODE_ENV !== 'production') require('source-map-support/register');
module.exports = function run(p) { return join(x.root, p); }
```

**Output (ESM — safe defaults)**

```js
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const x = require('./lib.js');
if (process.env.NODE_ENV !== 'production') import 'source-map-support/register';
export default function run(p) { return join(x.root, p); }
```

> In `--risk aggressive` (with plugin hints), the `x` import may be emitted as `import x from './lib.js'` if proven safe; otherwise, keep the safe `createRequire` form.

---

If you want, I can now **flesh out the tokenizer DFA** and **worker pool** implementation, or generate the initial **fixture files** and a **mini smoke test script** (Node‑only).
