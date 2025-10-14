// /src/verify.mjs
'use strict';

export async function verify({ path, content, facts, plan }) {
  // Conservative verify stub:
  //  - basic newline sanity to avoid giant single-line files
  //  - ensure no overlapping edits remain (applyEdits already guards)
  //  - hook for future "node --check" style passes
  const errors = [];
  if (typeof content !== 'string' || content.length === 0) {
    errors.push({ file:path, code:'VERIFY-EMPTY', level:'error', message:'Empty output content.', hint:'Investigate transformation plan.' });
  }
  if (!/\n/.test(content) && content.length > 1e6) {
    errors.push({ file:path, code:'VERIFY-MEGALINE', level:'error', message:'Abnormally long single-line output.', hint:'Check string/template handling.' });
  }
  return { errors };
}
