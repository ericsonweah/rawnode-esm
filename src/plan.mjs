import { isNodeCore, toNodeSpecifier, slug } from './utils.mjs';

export function planFile({ path, content, facts, analysis, risk, resolvePolicy, logger }) {
  const edits = [];
  const warnings = [];
  const decls = new Set(); // imports to hoist (text -> once)
  const nsMap = new Map(); // spec -> ns ident for interop
  const topInsertions = [];

  const addWarning = (code, message, hint) => warnings.push({ file:path, code, level:'warn', message, hint });

  const ensureNS = (spec) => {
    if (nsMap.has(spec)) return nsMap.get(spec);
    const id = `__ns_${slug(spec)}`;
    nsMap.set(spec, id);
    // normalize node: prefix
    const spec2 = isNodeCore(spec) ? toNodeSpecifier(spec) : spec;
    decls.add(`import * as ${id} from '${spec2}';`);
    return id;
  };

  // __dirname/__filename
  if (facts.uses.__dirname || facts.uses.__filename) {
    topInsertions.push(
`import { fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = __dirname_fn(__filename);`
    );
  }

  // require.resolve shim
  if (facts.requires.some(r => r.callee === 'require.resolve')) {
    topInsertions.push(
`import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`
    );
  }

  // per-site
  for (const r of facts.requires) {
    if (r.callee === 'require.resolve') continue; // shim handled
    if (!r.arg) { addWarning('CJS-DYN-REQUIRE', 'Dynamic require cannot be converted safely.', 'Use createRequire/import() manually.'); continue; }

    let spec = r.arg;
    if (isNodeCore(spec)) spec = toNodeSpecifier(spec);

    // side-effect only
    if (r.pattern === 'side-effect' && r.topLevel) {
      edits.push({ start: r.start, end: r.end, text: `import '${spec}';`, why:'side-effect', code:'CJS-SFX' });
      continue;
    }

    // destructure of core (already captured as 'destructure' pattern)
    if (r.pattern === 'destructure' && isNodeCore(spec)) {
      // We can't reconstruct exact named list here w/o LHS parse; safe fallback:
      const ns = ensureNS(spec);
      // keep original; warn that aggressive could map to named import
      addWarning('CJS-AMB-DESTRUCTURE', `Destructured require('${spec}') kept via namespace interop.`, 'Use risk=aggressive.');
      continue;
    }

    // default-like assign
    if (r.pattern === 'assign') {
      if (risk === 'aggressive' && !isNodeCore(spec)) {
        // Try default import; still safe for local files discovered to be default-shaped
        decls.add(`import ${`__tmp_${slug(spec)}`} from '${spec}';`);
        // Replace the whole require expression with the imported identifier:
        const id = `__tmp_${slug(spec)}`;
        edits.push({ start: r.start, end: r.end, text: id, why:'default-aggressive', code:'CJS-ASSIGN-DFLT' });
      } else {
        const ns = ensureNS(spec);
        edits.push({ start: r.start, end: r.end, text: `${ns}.default ?? ${ns}`, why:'interop', code:'CJS-ASSIGN-NS' });
        addWarning('CJS-AMB-DEFAULT', `Using namespace interop for '${spec}'.`, 'Use risk=aggressive to try default import when safe.');
      }
      continue;
    }
  }

  // inject hoisted imports at top (once)
  if (decls.size || topInsertions.length) {
    const header = [...topInsertions, ...decls].join('\n');
    // Insert at beginning (preserve shebang if present)
    const shebang = content.startsWith('#!') ? content.split('\n',1)[0] : null;
    const offset = shebang ? shebang.length+1 : 0;
    const text = shebang ? `${shebang}\n${header}\n` : `${header}\n`;
    const start = 0 + offset, end = 0 + offset;
    edits.unshift({ start, end, text, why:'imports-hoist', code:'CJS-HDR' });
  }

  return { edits, warnings, shims:{ dirname:facts.uses.__dirname || facts.uses.__filename, requireResolve: facts.requires.some(r=>r.callee==='require.resolve') } };
}
