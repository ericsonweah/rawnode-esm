'use strict';
// /src/transform.mjs
export function applyEdits(src, edits) {
  // Sort by start, then end, then stable index
  const ord = edits.map((e, i) => ({...e, __i:i}))
    .sort((a,b)=> a.start-b.start || a.end-b.end || a.__i-b.__i);

  let out = '', cursor = 0;
  for (const e of ord) {
    if (e.start < cursor) throw new Error(`Overlapping edit at ${e.start}-${e.end}`);
    out += src.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += src.slice(cursor);
  return out;
}
