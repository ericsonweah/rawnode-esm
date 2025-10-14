Excellent catch — that’s exactly the nuance between **bare built-in modules** (like `node:fs`, `node:path`, `node:events`) and **relative/project files** (like `./utils`).

Your observation is spot-on:

> Node core modules **must not** get “`.js`” appended.

Let’s upgrade the script so it:

1. ✅ Keeps core / bare imports (e.g. `node:fs`, `path`, `fs/promises`, `events`) untouched.
2. ✅ Converts destructured imports like `const { promises } = require("node:fs")`.
3. ✅ Adds `.js` only for **relative** imports (`./` or `../`).

---

## 🔧 **Improved Conversion Script**

Save this as `convert-require-to-import.mjs` in your project root:

```js
import fs from 'node:fs';
import path from 'node:path';

/**
 * Simple recursive converter for require → import.
 * Handles:
 *  - const x = require('./mod')
 *  - const { a, b } = require('./mod')
 *  - module.exports = ...
 * Skips:
 *  - core modules (e.g., node:fs, path, events)
 */
function replaceRequire(dir) {
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      replaceRequire(full);
    } else if (file.endsWith('.js')) {
      let code = fs.readFileSync(full, 'utf8');
      let original = code;

      // --- Step 1: convert default requires (const x = require('...'))
      code = code.replace(
        /const\s+(\w+)\s*=\s*require\(['"](.+?)['"]\);?/g,
        (_, name, mod) => {
          const isRelative = mod.startsWith('./') || mod.startsWith('../');
          const needsExt = isRelative && !mod.endsWith('.js');
          const importPath = needsExt ? `${mod}.js` : mod;
          return `import ${name} from "${importPath}";`;
        }
      );

      // --- Step 2: convert destructured requires (const { a, b } = require('...'))
      code = code.replace(
        /const\s*\{\s*([^\}]+)\s*\}\s*=\s*require\(['"](.+?)['"]\);?/g,
        (_, names, mod) => {
          const isRelative = mod.startsWith('./') || mod.startsWith('../');
          const needsExt = isRelative && !mod.endsWith('.js');
          const importPath = needsExt ? `${mod}.js` : mod;
          return `import { ${names.trim()} } from "${importPath}";`;
        }
      );

      // --- Step 3: module.exports → export default
      code = code.replace(/module\.exports\s*=\s*/g, 'export default ');

      if (code !== original) {
        fs.writeFileSync(full, code, 'utf8');
        console.log('✅ Converted', full);
      }
    }
  }
}

replaceRequire('./src');
console.log('\n🎉 Conversion complete (with safe core-module handling).');
```

---

## ✅ What this script now does

### ✔ Core modules

```js
// before
const path = require('node:path');
const { promises } = require('node:fs');
const { EventEmitter } = require('node:events');

// after
import path from 'node:path';
import { promises } from 'node:fs';
import { EventEmitter } from 'node:events';
```

### ✔ Local files

```js
// before
const utils = require('./utils');
const { join } = require('../helpers');
module.exports = myFn;

// after
import utils from './utils.js';
import { join } from '../helpers.js';
export default myFn;
```

### ✔ External packages

```js
// before
const express = require('express');

// after
import express from 'express';
```

(no `.js` added — since it’s a package, not a file)

---

## 🧩 How It Works

* It detects **relative paths** (`./`, `../`) and only adds `.js` there.
* It leaves **bare imports** (`express`, `path`, `node:fs`) alone.
* It supports **both** default and destructured `require`s.
* It converts `module.exports = ...` → `export default ...`.

---

## 🚀 Run It Once

In your project root:

```bash
node convert-require-to-import.mjs
```

It will recursively convert all `.js` files under `./src/`.

After that, your codebase will be mostly ready for ESM; you’ll just fix a few edge cases manually (like conditional requires or mixed export patterns).

---

Would you like me to enhance it one step further so it **also converts `exports.foo = …` → `export const foo = …`** automatically? That’s a common leftover after this step.
