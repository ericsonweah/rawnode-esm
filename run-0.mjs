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