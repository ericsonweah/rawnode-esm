
'use strict';

// /src/analyze.mjs

export function analyze({ path, facts }) {
  // Infer export shape
  let shape = 'none';
  let hasModuleExports = false, hasNamed = false;

  for (const e of facts.exports) {
    if (e.kind === 'module.exports') hasModuleExports = true;
    if (e.kind === 'exports.name')   hasNamed = true;
  }
  if (hasModuleExports && hasNamed) shape = 'hybrid';
  else if (hasModuleExports) shape = 'default';
  else if (hasNamed) shape = 'named';
  else shape = 'unknown';

  const hasDyn = facts.requires.some(r => r.pattern === 'dynamic');
  const hasTryCatch = false; // would be flagged at scan if implemented

  return { exportShape: shape, hasDynamicRequire: hasDyn, hasTryCatch };
}
