export const meta = { name: 'example', version: '1.0.0' };
export function setup(ctx) {
  return {
    onPlan(file, plan) {
      // Example: enforce node: prefix policy
      plan.edits = plan.edits.map(e => {
        if (/from 'path'/.test(e.text)) e.text = e.text.replace(/from 'path'/g, "from 'node:path'");
        return e;
      });
    }
  };
}
