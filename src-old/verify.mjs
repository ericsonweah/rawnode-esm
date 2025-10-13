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
