// /src/scan.mjs
'use strict';

export function scanSource(src) {
  const requires = [];
  const exports = [];
  const uses = { __dirname: false, __filename: false };

  // Mask strings/comments/templates to avoid false positives.
  const mask = new Array(src.length).fill(' ');
  let i = 0, str = null, tpl = false, esc = false, depthParen = 0, depthBrace = 0;
  while (i < src.length) {
    const c = src[i], n = src[i+1];
    if (str) {
      mask[i] = src[i]; // keep length; still masked logically
      if (!esc && c === str) { str = null; }
      esc = !esc && c === '\\';
      i++; continue;
    }
    if (tpl) {
      mask[i] = src[i];
      if (!esc && c === '`') { tpl = false; i++; continue; }
      if (!esc && c === '$' && n === '{') { depthBrace++; i+=2; continue; }
      esc = !esc && c === '\\';
      i++; continue;
    }
    if (c === '"' || c === "'") { str = c; mask[i] = c; i++; continue; }
    if (c === '`') { tpl = true; mask[i] = '`'; i++; continue; }
    if (c === '/' && n === '/') { // line comment
      while (i < src.length && src[i] !== '\n') { mask[i] = src[i]; i++; }
      continue;
    }
    if (c === '/' && n === '*') { // block comment
      mask[i] = '/'; mask[i+1] = '*'; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i+1] === '/')) { mask[i] = src[i]; i++; }
      mask[i] = '*'; mask[i+1] = '/'; i += 2; continue;
    }

    // track top-level-ish
    if (c === '(') depthParen++;
    else if (c === ')') depthParen = Math.max(0, depthParen - 1);
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace = Math.max(0, depthBrace - 1);

    // record bare tokens for __dirname/__filename
    if (isIdentStart(c)) {
      const j = readIdent(src, i);
      const word = src.slice(i, j);
      if (word === '__dirname') uses.__dirname = true;
      else if (word === '__filename') uses.__filename = true;
      i = j; continue;
    }

    i++;
  }

  const S = mask.join('');

  // module.exports = ...
  for (const m of matchAll(S, /\bmodule\.exports\s*=\s*/g)) {
    const eqPos = m.index + m[0].length;
    const topLevel = depthAt(S, m.index) === 0;
    exports.push({ kind: 'module.exports', start: m.index, eqPos, topLevel });
  }

  // exports.name = ...
  for (const m of matchAll(S, /\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    const key = m[1];
    const topLevel = depthAt(S, m.index) === 0;
    exports.push({ kind: 'exports.name', name: key, start: m.index, topLevel });
  }

  // require.resolve(...)
  for (const m of matchAll(S, /\brequire\.resolve\s*\(([^)]*)\)/g)) {
    const arg = readStringArg(src, m[1]);
    requires.push({ callee:'require.resolve', pattern:'call', arg, topLevel: depthAt(S, m.index)===0, start:m.index, end:m.index + m[0].length });
  }

  // const x = require('pkg')
  for (const m of matchAll(S, /\brequire\s*\(([^)]*)\)/g)) {
    const arg = readStringArg(src, m[1]);
    const start = m.index, end = m.index + m[0].length;
    const topLevel = depthAt(S, start) === 0;

    // classify surrounding pattern conservatively using short left-scan
    const lhsInfo = scanLhs(S, start);
    if (!arg) {
      requires.push({ pattern:'dynamic', callee:'require', arg:null, topLevel, start, end });
      continue;
    }
    if (lhsInfo.kind === 'destructure') {
      requires.push({ pattern:'destructure', callee:'require', arg, topLevel, start, end, lhs: lhsInfo.name });
    } else if (lhsInfo.kind === 'assign') {
      requires.push({ pattern:'assign', callee:'require', arg, topLevel, start, end, lhs: lhsInfo.name });
    } else {
      // side-effect require('x');
      requires.push({ pattern:'side-effect', callee:'require', arg, topLevel, start, end });
    }
  }

  return { requires, exports, uses };
}

/* ----------------------- helpers ---------------------------------------- */

function* matchAll(s, re) { for (let m; (m = re.exec(s));) yield m; }

function readIdent(s, i) {
  let j = i;
  while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
  return j;
}
function isIdentStart(c){ return /[A-Za-z_$]/.test(c); }

// very rough depth: count { } to approximate "top-level"
function depthAt(s, upTo) {
  let d = 0;
  for (let i=0;i<upTo;i++) {
    const c = s[i];
    if (c === '{') d++;
    else if (c === '}') d = Math.max(0, d-1);
  }
  return d;
}

function readStringArg(src, rawInsideParens) {
  const trimmed = rawInsideParens.trim();
  const q = trimmed[0];
  if (q === "'" || q === '"') {
    // find matching quote; assume no nested quotes since masked
    const end = trimmed.lastIndexOf(q);
    if (end > 0) return trimmed.slice(1, end);
  }
  return null; // dynamic
}

// Scan to detect "const LHS = require(...)" or "const {a} = require(...)"
function scanLhs(masked, reqStartIdx) {
  // get beginning of the statement
  let i = reqStartIdx - 1;
  while (i > 0 && masked[i] !== '\n' && masked[i] !== ';') i--;
  const stmt = masked.slice(i+1, reqStartIdx);
  // destructure
  const d = /(?:^|\s)const\s*\{\s*[^}]+\s*\}\s*=\s*$/m.exec(stmt);
  if (d) return { kind:'destructure', name: null };
  const a = /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/m.exec(stmt);
  if (a) return { kind:'assign', name: a[1] };
  return { kind:'none' };
}
