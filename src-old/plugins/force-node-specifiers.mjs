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
