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
