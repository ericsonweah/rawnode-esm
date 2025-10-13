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
