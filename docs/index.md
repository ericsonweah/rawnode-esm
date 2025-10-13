Below are **practical, copy‑pasteable usage examples** for `rawnode‑esm`—both **CLI** and **programmatic API**—covering safe/aggressive modes, side‑effects, Node core, `__dirname`, `require.resolve`, JSON/WASM, conditional/try/catch, plan‑only, and plugins. Examples follow the **Patch Rule** (Anchor → Change) where relevant and keep edits **surgical** (no reformatting).

---

## 1) CLI — Quick Start (preview only)

**Preview changes without writing:**

```bash
node ./bin/rawnode-esm.mjs src --dry-run --report pretty --print-diff
```

* **What you get:** a deterministic list of files to change, warnings, and unified diffs printed to stdout.
* **Exit code:** `0` (since we didn’t ask `--check`).

**Typical output (pretty mode):**

```
[INFO ] summary {"files":128,"changedFiles":34,"warnings":5,"errors":0,"metrics":{"files_total":128,"files_changed":34}}
--- a/src/util/path.js
+++ b/src/util/path.js
@@ -1,20 +1,22 @@
 import { join } from 'node:path';
 ...
```

---

## 2) CLI — CI “Would change?” gate

**Fail CI if any file would change (no writes):**

```bash
node ./bin/rawnode-esm.mjs src --dry-run --check --report json
```

* **Exit code:** `1` if changes are needed or verification errors exist; `0` otherwise.
* **Use case:** pre‑commit or CI guard.

---

## 3) CLI — Apply transforms (safe profile, default)

> In this engine, writes happen by default unless `--dry-run` is provided.

```bash
node ./bin/rawnode-esm.mjs src
```

* **Deterministic**: file order and edits are stable across runs.
* **Zero deps**: only Node core modules.

---

## 4) CLI — “Aggressive” profile (cleaner imports when provably safe)

```bash
node ./bin/rawnode-esm.mjs src --risk aggressive
```

* Uses default imports when the export shape is proven or heuristically safe.
* Falls back to namespace interop otherwise.

**Example (local module with `module.exports = …`):**

**Anchor**

```js
const x = require('./lib');
```

**Change (aggressive)**

```js
import x from './lib.js';
```

**Change (safe fallback)**

```js
import * as __ns__lib from './lib.js';
const x = __ns__lib.default ?? __ns__lib;
```

---

## 5) CLI — Include/Exclude Globs and Concurrency

```bash
node ./bin/rawnode-esm.mjs . \
  --include "**/*.js,**/*.cjs" \
  --exclude "node_modules/**,dist/**,**/*.test.js" \
  --concurrency 6 \
  --report pretty
```

* Globs are **POSIX‑style**; ordering is **stable**.
* Concurrency caps worker threads for scanning/analysis.

---

## 6) CLI — Plan‑only (machine‑readable plan, no writes)

```bash
node ./bin/rawnode-esm.mjs src --plan-only --report json
```

**Excerpt of plan JSON (per file):**

```json
{
  "file": "src/index.js",
  "plan": {
    "edits": [
      {"start":0,"end":0,"text":"import { join } from 'node:path';\n","code":"CJS-HDR"},
      {"start":27,"end":53,"text":"__ns__lib.default ?? __ns__lib","code":"CJS-ASSIGN-NS"}
    ],
    "warnings": [
      {"code":"CJS-AMB-DEFAULT","level":"warn","message":"Using namespace interop for './lib.js'."}
    ],
    "shims":{"dirname":false,"requireResolve":false}
  }
}
```

---

## 7) Typical Patterns — Before/After (CLI produces these edits)

### A) Node core → `node:` + destructuring

**Anchor**

```js
const { join, dirname } = require('path');
```

**Change**

```js
import { join, dirname } from 'node:path';
```

---

### B) Side‑effect requires

**Anchor**

```js
require('dotenv/config');
```

**Change**

```js
import 'dotenv/config';
```

---

### C) `__dirname` / `__filename`

**Anchor**

```js
const p = __dirname + '/data/a.txt';
```

**Change (top‑of‑file injection + keep usage)**

```js
import { fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = __dirname_fn(__filename);

const p = __dirname + '/data/a.txt';
```

---

### D) `require.resolve()`

**Anchor**

```js
const p = require.resolve('pkg/sub');
```

**Change (shim + keep semantics)**

```js
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
const p = require.resolve('pkg/sub');
```

---

### E) JSON (or WASM) requires — safe interop

**Anchor**

```js
const cfg = require('./cfg.json');
```

**Change (shim + keep)**

```js
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
const cfg = require('./cfg.json'); // CJS-JSON
```

> *Reason:* JSON import attributes aren’t uniformly available under Node 20 without flags; we preserve behavior with `createRequire`.

---

### F) Conditional side‑effect requires

**Anchor**

```js
if (process.env.NODE_ENV !== 'production') require('source-map-support/register');
```

**Change**

```js
if (process.env.NODE_ENV !== 'production') import 'source-map-support/register';
```

> **Note:** This upgrade only applies to **side‑effect** usage. Conditional **assigned** requires keep `require()` via shim and emit a diagnostic.

---

### G) Try/catch optional dependency

**Anchor**

```js
let m; try { m = require('optional'); } catch {}
```

**Change (safe fallback)**

```js
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
let m; try { m = require('optional'); } catch {}
// CJS-TRY-REQUIRE
```

---

### H) Directory/file resolution — add extension deterministically

When stat cache confirms `./lib.js`:

**Anchor**

```js
const lib = require('./lib');
```

**Change (safe fallback shown; aggressive may use `import lib from`)**

```js
import * as __ns__lib from './lib.js';
const lib = __ns__lib.default ?? __ns__lib;
```

---

### I) Hybrid exports (default + named) — conservative

**Anchor**

```js
module.exports = fn;
exports.extra = 1;
```

**Change (keep behavior; emit diagnostic)**

```js
// CJS-EXPORT-HYBRID: kept CommonJS semantics
module.exports = fn;
exports.extra = 1;
```

> If a plugin asserts a safe mapping, the tool can emit:
>
> ```js
> export default fn;
> export const extra = 1;
> ```

---

## 8) Programmatic API — Minimal

```js
// tools/run-conversion.mjs
import os from 'node:os';
import { convert } from '../src/index.mjs';

const summary = await convert({
  roots: ['src','lib'],
  risk: 'safe',
  concurrency: Math.min(8, os.cpus().length),
  include: ['**/*.js','**/*.cjs'],
  exclude: ['node_modules/**','dist/**'],
  plugins: [],                // or: [myPluginModule]
  dryRun: false,
  check: false,
  printDiff: false,
  report: 'pretty',
  cacheDir: './.rawnode-esm',
  onProgress: (evt) => {
    // evt: {stage,file,done,total,metrics}
    if (evt.stage === 'summary') console.log('Done:', evt);
  }
});

console.log('Summary:', summary);
```

Run:

```bash
node tools/run-conversion.mjs
```

---

## 9) Programmatic API — With a Plugin

**Plugin**: turn dev‑only side‑effect requires into `import` (extra guard)

```js
// plugins/dev-side.mjs
export const meta = { name: 'dev-only-sideeffects', version: '1.0.0' };

export function setup(ctx) {
  return {
    onPlan(file, plan) {
      // Example: strengthen the conditional side-effect transform if scanner provided metadata.
      // Here, we simply annotate a warning to demonstrate the contract.
      plan.warnings ??= [];
      plan.warnings.push({
        file, code: 'PLG-DEV-SIDE', level: 'warn',
        message: 'Plugin processed dev-only side-effect candidates.',
        hint: 'Ensure only side-effect calls are upgraded.'
      });
    }
  };
}
```

**Use via CLI:**

```bash
node ./bin/rawnode-esm.mjs src --plugins ./plugins/dev-side.mjs
```

**Use via API:**

```js
import * as devSide from '../plugins/dev-side.mjs';
await convert({ roots:['src'], plugins:[devSide], /*...*/ });
```

---

## 10) Editor‑friendly plan preview

Emit a machine‑readable plan to power quick‑fix UIs:

```bash
node ./bin/rawnode-esm.mjs src --plan-only --report json > ./.rawnode-esm/plan.json
```

Then load `plan.json` to show **per‑file** edits and diagnostics without writing files.

---

## 11) Examples with Patch Rule (Anchor → Change)

### Example 1 — Replace side‑effect require

**Anchor**

```
require('dotenv/config')
```

**Change**

```
import 'dotenv/config';
```

---

### Example 2 — Assigned top‑level require (safe interop)

**Anchor**

```
const x = require('./lib')
```

**Change**

```
import * as __ns__lib from './lib.js';
const x = __ns__lib.default ?? __ns__lib;
```

---

### Example 3 — Node core destructure

**Anchor**

```
const { readFile, writeFile } = require('fs/promises')
```

**Change**

```
import { readFile, writeFile } from 'node:fs/promises';
```

---

## 12) JSON Mode vs Pretty Mode (logging)

**Pretty (default):**

```
[WARN ] Using namespace interop for './lib.js'. {"file":"src/index.js","code":"CJS-AMB-DEFAULT"}
```

**JSON:**

```bash
node ./bin/rawnode-esm.mjs src --report json
```

**Output line:**

```json
{"level":"warn","msg":"Using namespace interop for './lib.js'.","file":"src/index.js","code":"CJS-AMB-DEFAULT","hint":"Use risk=aggressive to try default import when safe."}
```

---

## 13) CI Recipe

**Step 1 (plan check, no writes):**

```bash
node ./bin/rawnode-esm.mjs . --dry-run --check --report json
```

**Step 2 (apply on main after approval):**

```bash
node ./bin/rawnode-esm.mjs .
```

---

## 14) Handling tricky cases — examples & outcomes

### Dynamic require (kept)

**Anchor**

```js
const m = require(name);
```

**Change**

```js
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
const m = require(name); // CJS-DYN-REQUIRE
```

### Local `require` shadowing (skipped)

**Anchor**

```js
function f(require) { return require('x'); }
```

**Change**

```js
function f(require) { return require('x'); } // CJS-LOCAL-REQUIRE-SHADOW
```

---

## 15) End‑to‑End Example (safe)

**Input (CJS)**

```js
const { join } = require('path');
const x = require('./lib');
if (process.env.NODE_ENV !== 'production') require('source-map-support/register');
module.exports = function run(p) { return join(x.root, p); }
```

**Command**

```bash
node ./bin/rawnode-esm.mjs src --report pretty
```

**Output (ESM)**

```js
import { join } from 'node:path';
import * as __ns__lib from './lib.js';
const x = __ns__lib.default ?? __ns__lib;
if (process.env.NODE_ENV !== 'production') import 'source-map-support/register';
export default function run(p) { return join(x.root, p); }
```

**Warnings (pretty):**

```
[WARN ] Using namespace interop for './lib.js'. {"file":"src/index.js","code":"CJS-AMB-DEFAULT","hint":"Use risk=aggressive to try default import when safe."}
```

---

## 16) Performance‑aware invocation

* Pin workers to a reasonable number (avoid oversubscription on CI runners):

```bash
node ./bin/rawnode-esm.mjs src --concurrency 4
```

* Large repos: prefer **`--dry-run` first**, then apply; cache short‑circuits scanning on unchanged files.

---

## 17) Deterministic specifier policy

**Always normalize Node core to `node:` (default behavior).**
If you choose to keep original specifiers, run with (when supported):

```bash
node ./bin/rawnode-esm.mjs src --resolve-policy keep
```

*(Policy is deterministic per run; don’t mix.)*

---

### Summary

* Use `--dry-run`/`--check` for **preview/CI**.
* Use `--risk aggressive` when you **know** local shapes allow default imports.
* JSON/WASM/conditional/try‑catch/dynamic cases fall back to **`createRequire` shim** and emit **actionable diagnostics**.
* Plugins let you **codify team policy** and post‑process plans deterministically.

If you want tailored examples against a specific file tree, paste a small snippet (≤50 LOC), and I’ll show the exact **Anchor → Change** patches it would produce.
