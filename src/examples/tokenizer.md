"use strict"; // ADDED

// /modules/parser/tokenizer/index.js
/* -----------------------------------------------------------------------------// ADDED
 * RawNodeView Tokenizer (zero‑dependency)                                        // ADDED
 *  ‑ Converts a template string into a linear stream of tokens:                  // ADDED
 *      TEXT, RAW_ECHO, ESC_ECHO, COMMENT, COMPONENT_PLACEHOLDER, DIRECTIVE.      // ADDED
 *  ‑ Keeps the old mega‑regex internally for now, but **exposes a clean API**    // ADDED
 *    for future hand‑written or incremental Lexer upgrades.                      // ADDED
 * --------------------------------------------------------------------------- */ // ---------------------------------------------------------------------------            // ADDED
// v2 Streaming / State-Machine Scanner: config & utilities                               // ADDED
// ---------------------------------------------------------------------------            // ADDED
const { StringDecoder } = require("string_decoder");
// const TOKEN = Object.freeze({
const TOKEN = Object.freeze({
    // UPDATED
    TEXT: "TEXT",
    RAW_ECHO: "RAW_ECHO",
    ESC_ECHO: "ESC_ECHO",
    COMMENT: "COMMENT",
    COMPONENT_PLACEHOLDER: "COMPONENT_PLACEHOLDER",
    DIRECTIVE: "DIRECTIVE",
});

const DEFAULTS = Object.freeze({
    // ADDED
    file: null, // ADDED
    delims: {
        // ADDED
        escOpen: "{{",
        escClose: "}}", // ADDED
        rawOpen: "{!!",
        rawClose: "!!}", // ADDED
        commentOpen: "{{",
        commentClose: "}}", // ADDED
        directiveSigil: "@", // ADDED
    }, // ADDED
    emitErrorTokens: true, // if false, errors report via hooks only               // ADDED
    keepTail: 2, // chars to keep between chunks (e.g., for '{{')        // ADDED
    trimWhitespaceMarker: "-", // Blade-like: {{- x -}} / {!!- x -!!}                  // ADDED
    schedule: null, // 'immediate' | 'micro' | null                         // ADDED
    hooks: null, // { init, onChunk, beforeToken, onToken,               // ADDED
});

function isWS(ch) {
    // ADDED
    return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x0b || ch === 0x0c;
} // ADDED

function advance2(str, line, col, offset) {
    // ADDED
    // count columns by code points; offset by code units                                    // ADDED
    let i = 0; // ADDED
    for (const cp of str) {
        // ADDED
        if (cp === "\n") {
            line++;
            col = 1;
        } else {
            col++;
        } // ADDED
        i += cp.length; // code units consumed                                                 // ADDED
    } // ADDED
    return { line, col, offset: offset + i }; // ADDED
} // ADDED

function sliceByOffsets(s, startOffset, endOffset) {
    // ADDED
    return s.slice(startOffset, endOffset); // ADDED
} // ADDED

function scheduleOnce(kind) {
    // ADDED
    if (kind === "immediate") return new Promise((r) => setImmediate(r)); // ADDED
    if (kind === "micro") return Promise.resolve(); // ADDED
    return null; // ADDED
} // ADDED

// Very small token factory to reduce allocations                                          // ADDED
function makeToken(type, extra, locStart, locEnd, file) {
    // ADDED
    const t = extra ? Object.assign({ type }, extra) : { type }; // ADDED
    if (locStart && locEnd) t.loc = { start: locStart, end: locEnd, file: file || null }; // ADDED
    return t; // ADDED
} // ADDED

// Hook runner helpers (no overhead when hooks == null)                                    // ADDED
function runHook(h, name, a, b, c) {
    // ADDED
    return h && typeof h[name] === "function" ? h[name](a, b, c) : a; // ADDED
} // ADDED

// ADDED

// module.exports = function tokenize(template) {                                     // ADDED
//   const tokens = [];                                                               // ADDED
//   let cursor    = 0;                                                               // ADDED
module.exports = function tokenize(template) {
    // UPDATED
    const tokens = []; // UPDATED
    let cursor = 0, // UPDATED
        line = 1, // ADDED
        col = 1; // ADDED
    // ADDED
    const RE = /{!!\s*(-)?\s*([\s\S]*?)\s*(-)?\s*!!}|{{\s*--([\s\S]*?)--\s*}}|{{\s*(-)?\s*([\s\S]*?)\s*(-)?\s*}}|@componentPlaceholder\((\d+)\)|@([a-zA-Z_]\w*)(?:\s*\(((?:[^()]*|\([^()]*\))*)\))?/g; // ADDED
    // ADDED
    let m; // ADDED
    while ((m = RE.exec(template)) !== null) {
        // ADDED
        /* 1. text preceding the match */ // ADDED
        // if (m.index > cursor) {                                                         // ADDED
        //   tokens.push({ type: TOKEN.TEXT, value: template.slice(cursor, m.index) });    // ADDED
        // }                                                                               // ADDED

        /* 1. text preceding the match */ // UPDATED
        if (m.index > cursor) {
            // UPDATED
            const text = template.slice(cursor, m.index); // UPDATED
            tokens.push({ type: TOKEN.TEXT, value: text, loc: { line, col } }); // ADDED
            ({ line, col } = advance(text, line, col)); // ADDED
        } // ADDED
        // ADDED
        /* 2. classify match groups */ if (m[4] !== undefined) {
            // comment // ADDED
            tokens.push({ type: TOKEN.COMMENT, value: m[4] }); // ADDED
        } else if (m[2] !== undefined) {
            // RAW_ECHO // ADDED
            tokens.push({ type: TOKEN.RAW_ECHO, value: m[2].trim(), leading: !!m[1], trailing: !!m[3] }); // ADDED
        } else if (m[6] !== undefined) {
            // ESC_ECHO // ADDED
            tokens.push({ type: TOKEN.ESC_ECHO, value: m[6].trim(), leading: !!m[5], trailing: !!m[7] }); // ADDED
        } else if (m[8] !== undefined) {
            // COMPONENT // ADDED
            tokens.push({ type: TOKEN.COMPONENT_PLACEHOLDER, index: parseInt(m[8], 10) }); // ADDED
        } else if (m[9] !== undefined) {
            // DIRECTIVE // ADDED
            tokens.push({ type: TOKEN.DIRECTIVE, name: m[9], args: (m[10] || "").trim() }); // ADDED
            //}                                                                               // ADDED
        } // UPDATED

        // advance cursor position by matched chunk                                    // ADDED
        const advanced = template.slice(cursor, RE.lastIndex); // ADDED
        ({ line, col } = advance(advanced, line, col)); // ADDED
        // ADDED
        cursor = RE.lastIndex; // ADDED
    } // ADDED // ADDED
    // ADDED
    /* 3. trailing text */ if (cursor < template.length) {
        // ADDED
        //tokens.push({ type: TOKEN.TEXT, value: template.slice(cursor) });               // ADDED

        const tail = template.slice(cursor); // ADDED
        tokens.push({ type: TOKEN.TEXT, value: tail, loc: { line, col } }); // ADDED
    } // ADDED
    // ADDED
    return tokens; // ADDED
}; // ADDED

// helper to update line/column counters                                           // ADDED
function advance(str, l, c) {
    // ADDED
    for (const ch of str) {
        // ADDED
        if (ch === "\n") {
            l++;
            c = 1;
        } // ADDED
        else c++; // ADDED
    } // ADDED
    return { line: l, col: c }; // ADDED
}

// ---------------------------------------------------------------------------            // ADDED
// scanSync: synchronous generator over a string                                           // ADDED
// ---------------------------------------------------------------------------            // ADDED
function* scanSync(template, options) {
    // ADDED
    const opt = Object.assign({}, DEFAULTS, options || {}); // ADDED
    const hooks = opt.hooks; // ADDED
    runHook(hooks, "init", { mode: "sync", options: opt }); // ADDED

    const { escOpen, escClose, rawOpen, rawClose, commentOpen, commentClose, directiveSigil } = opt.delims; // ADDED
    const trimMark = opt.trimWhitespaceMarker; // ADDED

    let buffer = template; // ADDED
    let pos = 0; // ADDED
    let line = 1,
        col = 1,
        offset = 0; // ADDED
    const file = opt.file; // ADDED

    // fast local helpers                                                                    // ADDED
    const look = (x) => buffer.indexOf(x, pos); // ADDED
    const emit = (tok) => {
        // ADDED
        const t1 = runHook(hooks, "beforeToken", tok, { line, col, offset }); // ADDED
        if (t1 === null) return; // ADDED
        const t2 = runHook(hooks, "onToken", t1, { line, col, offset }); // ADDED
        if (t2 === null) return; // ADDED
        return t2; // ADDED
    }; // ADDED

    while (pos < buffer.length) {
        // ADDED
        // Find earliest opener among raw/esc/comment/directive                                // ADDED
        const iEsc = look(escOpen); // ADDED
        const iRaw = look(rawOpen); // ADDED
        const iCom = look(commentOpen); // ADDED
        const iDir = look(directiveSigil); // ADDED

        // Choose the nearest positive index                                                   // ADDED
        let i = -1,
            kind = "TEXT"; // ADDED
        for (const [idx, k] of [
            [iEsc, "ESC"],
            [iRaw, "RAW"],
            [iCom, "COM"],
            [iDir, "DIR"],
        ]) {
            // ADDED
            if (idx !== -1 && (i === -1 || idx < i)) {
                i = idx;
                kind = k;
            } // ADDED
        } // ADDED

        if (i === -1) {
            // ADDED
            // trailing text                                                                     // ADDED
            const text = buffer.slice(pos); // ADDED
            if (text.length) {
                // ADDED
                const start = { line, col, offset }; // ADDED
                ({ line, col, offset } = advance2(text, line, col, offset)); // ADDED
                const out = makeToken(TOKEN.TEXT, { value: text }, start, { line, col, offset }, file); // ADDED
                const emitted = emit(out);
                if (emitted) yield emitted; // ADDED
            } // ADDED
            pos = buffer.length; // ADDED
            break; // ADDED
        } // ADDED

        // Emit text before opener                                                             // ADDED
        if (i > pos) {
            // ADDED
            const text = buffer.slice(pos, i); // ADDED
            const start = { line, col, offset }; // ADDED
            ({ line, col, offset } = advance2(text, line, col, offset)); // ADDED
            const out = makeToken(TOKEN.TEXT, { value: text }, start, { line, col, offset }, file); // ADDED
            const emitted = emit(out);
            if (emitted) yield emitted; // ADDED
            pos = i; // ADDED
        } // ADDED

        // Dispatch                                                                            // ADDED
        if (kind === "RAW" && buffer.startsWith(rawOpen, pos)) {
            // ADDED
            const openStart = { line, col, offset }; // ADDED
            ({ line, col, offset } = advance2(rawOpen, line, col, offset)); // ADDED
            pos += rawOpen.length; // ADDED
            // {!! [ws] [-]? [ws] body [ws] [-]? [ws] !!}                                        // ADDED
            const leadInfo = consumeWSAndTrimFlag(buffer, pos, trimMark); // ADDED
            pos = leadInfo.pos; // ADDED
            const closeIdx = findRawClose(buffer, pos, rawClose, trimMark); // ADDED
            if (closeIdx < 0) {
                // ADDED
                // Incomplete: emit ERROR (optional) and bail out                                  // ADDED
                if (opt.emitErrorTokens) {
                    // ADDED
                    const errTok = makeToken("ERROR", { message: "Unterminated RAW_ECHO" }, openStart, openStart, file); // ADDED
                    const emitted = emit(errTok);
                    if (emitted) yield emitted; // ADDED
                } // ADDED
                break; // ADDED
            } // ADDED
            const { body, trailing, endPos } = sliceBodyWithTrailing(buffer, pos, closeIdx, trimMark); // ADDED
            const value = body.trim(); // ADDED
            const endBeforeClose = offset + (endPos - pos); // ADDED
            // advance over body                                                                 // ADDED
            const bodySlice = buffer.slice(pos, endPos); // ADDED
            ({ line, col, offset } = advance2(bodySlice, line, col, offset)); // ADDED
            // advance over closer                                                               // ADDED
            ({ line, col, offset } = advance2(rawClose, line, col, offset)); // ADDED
            pos = endPos + rawClose.length; // ADDED
            const out = makeToken(TOKEN.RAW_ECHO, { value, leading: !!leadInfo.leading, trailing: !!trailing }, openStart, { line, col, offset }, file); // ADDED
            const emitted = emit(out);
            if (emitted) yield emitted; // ADDED
        } else if (kind === "ESC" && buffer.startsWith(escOpen, pos)) {
            // ADDED
            const openStart = { line, col, offset }; // ADDED
            ({ line, col, offset } = advance2(escOpen, line, col, offset)); // ADDED
            pos += escOpen.length; // ADDED
            // {{ [ws] [-]? [ws] body [ws] [-]? [ws] }}                                          // ADDED
            // But comment has the same opener; disambiguate                                     // ADDED
            const maybeCom = consumeWS(buffer, pos); // ADDED
            if (buffer.startsWith("--", maybeCom.pos)) {
                // ADDED
                // It's a COMMENT: {{ [ws] -- body -- [ws] }}                                      // ADDED
                pos = maybeCom.pos + 2; // ADDED
                const closeIdx = findCommentClose(buffer, pos, escClose); // ADDED
                if (closeIdx < 0) {
                    // ADDED
                    if (opt.emitErrorTokens) {
                        // ADDED
                        const errTok = makeToken("ERROR", { message: "Unterminated COMMENT" }, openStart, openStart, file); // ADDED
                        const emitted = emit(errTok);
                        if (emitted) yield emitted; // ADDED
                    } // ADDED
                    break; // ADDED
                } // ADDED
                const body = buffer.slice(pos, closeIdx.bodyEnd); // ADDED
                // advance over body + spacer + closer                                             // ADDED
                const consumed = buffer.slice(openStart.offset, closeIdx.afterCloseOffset); // ADDED
                ({ line, col, offset } = advance2(consumed, line, col, openStart.offset)); // ADDED
                pos = closeIdx.afterClosePos; // ADDED
                const out = makeToken(TOKEN.COMMENT, { value: body }, openStart, { line, col, offset }, file); // ADDED
                const emitted = emit(out);
                if (emitted) yield emitted; // ADDED
            } else {
                // ESC_ECHO                                                                        // ADDED
                const leadInfo = consumeWSAndTrimFlag(buffer, pos, trimMark); // ADDED
                pos = leadInfo.pos; // ADDED
                const closeIdx = findEscClose(buffer, pos, escClose, trimMark); // ADDED
                if (closeIdx < 0) {
                    // ADDED
                    if (opt.emitErrorTokens) {
                        // ADDED
                        const errTok = makeToken("ERROR", { message: "Unterminated ESC_ECHO" }, openStart, openStart, file); // ADDED
                        const emitted = emit(errTok);
                        if (emitted) yield emitted; // ADDED
                    } // ADDED
                    break; // ADDED
                } // ADDED
                const { body, trailing, endPos } = sliceBodyWithTrailing(buffer, pos, closeIdx, trimMark); // ADDED
                const value = body.trim(); // ADDED
                const bodySlice = buffer.slice(pos, endPos); // ADDED
                ({ line, col, offset } = advance2(bodySlice + escClose, line, col, offset)); // ADDED
                pos = endPos + escClose.length; // ADDED
                const out = makeToken(TOKEN.ESC_ECHO, { value, leading: !!leadInfo.leading, trailing: !!trailing }, openStart, { line, col, offset }, file); // ADDED
                const emitted = emit(out);
                if (emitted) yield emitted; // ADDED
            }
        } else if (kind === "COM" && buffer.startsWith(commentOpen, pos)) {
            // ADDED
            // If commentOpen === '{{', this path is covered above; keep as generic fallback     // ADDED
            pos += commentOpen.length; // ADDED
        } else if (kind === "DIR" && buffer.charAt(pos) === directiveSigil) {
            // ADDED
            const start = { line, col, offset }; // ADDED
            // Try to parse @componentPlaceholder(n) or @name(args)                              // ADDED
            const parsed = parseDirective(buffer, pos, directiveSigil); // ADDED
            if (!parsed) {
                // ADDED
                // Not a directive (e.g., lone '@' in text) — treat as text                        // ADDED
                const ch = buffer.charAt(pos); // ADDED
                ({ line, col, offset } = advance2(ch, line, col, offset)); // ADDED
                const out = makeToken(TOKEN.TEXT, { value: ch }, start, { line, col, offset }, file); // ADDED
                const emitted = emit(out);
                if (emitted) yield emitted; // ADDED
                pos += 1; // ADDED
            } else {
                const { endPos, name, args, isComponent, index } = parsed; // ADDED
                const consumed = buffer.slice(pos, endPos); // ADDED
                ({ line, col, offset } = advance2(consumed, line, col, offset)); // ADDED
                pos = endPos; // ADDED
                if (isComponent) {
                    // ADDED
                    const out = makeToken(TOKEN.COMPONENT_PLACEHOLDER, { index }, start, { line, col, offset }, file); // ADDED
                    const emitted = emit(out);
                    if (emitted) yield emitted; // ADDED
                } else {
                    // Allow hook to resolve/transform directive before emission                     // ADDED
                    const directive = { name, args: args.trim() }; // ADDED
                    const resolved = runHook(hooks, "resolveDirective", directive, { line, col, offset }) || directive; // ADDED
                    const out = makeToken(TOKEN.DIRECTIVE, resolved, start, { line, col, offset }, file); // ADDED
                    const emitted = emit(out);
                    if (emitted) yield emitted; // ADDED
                } // ADDED
            } // ADDED
        } else {
            // Fallback; advance one char                                                        // ADDED
            const ch = buffer.charAt(pos); // ADDED
            const start = { line, col, offset }; // ADDED
            ({ line, col, offset } = advance2(ch, line, col, offset)); // ADDED
            const out = makeToken(TOKEN.TEXT, { value: ch }, start, { line, col, offset }, file); // ADDED
            const emitted = emit(out);
            if (emitted) yield emitted; // ADDED
            pos++; // ADDED
        } // ADDED
    } // ADDED

    runHook(hooks, "finalize", { mode: "sync" }); // ADDED
} // ADDED

// Helpers used by scanSync                                                                // ADDED
function consumeWS(s, i) {
    // ADDED
    let p = i;
    while (p < s.length && isWS(s.charCodeAt(p))) p++; // ADDED
    return { pos: p }; // ADDED
} // ADDED

function consumeWSAndTrimFlag(s, i, trimMark) {
    // ADDED
    let p = consumeWS(s, i).pos; // ADDED
    let leading = false; // ADDED
    if (s.charAt(p) === trimMark) {
        leading = true;
        p++;
        p = consumeWS(s, p).pos;
    } // ADDED
    return { pos: p, leading }; // ADDED
} // ADDED

function findEscClose(s, from, close, trimMark) {
    // ADDED
    let p = s.indexOf(close, from); // ADDED
    return p; // ADDED
} // ADDED

function findRawClose(s, from, close, trimMark) {
    // ADDED
    let p = s.indexOf(close, from); // ADDED
    return p; // ADDED
} // ADDED

function findCommentClose(s, from, escClose) {
    // ADDED
    // find '}}' where just before it (ignoring WS) we have '--'                             // ADDED
    let p = s.indexOf(escClose, from); // ADDED
    while (p !== -1) {
        // ADDED
        let q = p - 1; // ADDED
        while (q >= from && isWS(s.charCodeAt(q))) q--; // ADDED
        if (q >= 1 && s.charAt(q - 1) === "-" && s.charAt(q) === "-") {
            // ADDED
            const bodyEnd = q - 1; // ADDED
            return { bodyEnd, afterClosePos: p + escClose.length, afterCloseOffset: p + escClose.length }; // ADDED
        } // ADDED
        p = s.indexOf(escClose, p + escClose.length); // ADDED
    } // ADDED
    return -1; // ADDED
} // ADDED

function sliceBodyWithTrailing(s, start, closeIdx, trimMark) {
    // ADDED
    // Between start..closeIdx, strip trailing WS and optional '-'                           // ADDED
    let end = closeIdx; // ADDED
    // walk left over WS                                                                      // ADDED
    let q = end - 1; // ADDED
    while (q >= start && isWS(s.charCodeAt(q))) q--; // ADDED
    let trailing = false; // ADDED
    if (s.charAt(q) === trimMark) {
        trailing = true;
        q--; // ADDED
        while (q >= start && isWS(s.charCodeAt(q))) q--; // ADDED
    } // ADDED
    const body = s.slice(start, q + 1); // ADDED
    return { body, trailing, endPos: closeIdx }; // ADDED
} // ADDED

function parseDirective(s, i, sigil) {
    // ADDED
    // @name(args?)                                                                          // ADDED
    if (s.charAt(i) !== sigil) return null; // ADDED
    let p = i + 1; // ADDED
    const start = p; // ADDED
    if (!/[A-Za-z_]/.test(s.charAt(p))) return null; // ADDED
    p++; // ADDED
    while (p < s.length && /[A-Za-z0-9_]/.test(s.charAt(p))) p++; // ADDED
    const name = s.slice(start, p); // ADDED
    // Special-case @componentPlaceholder(n)                                                 // ADDED
    if (name === "componentPlaceholder" && s.charAt(p) === "(") {
        // ADDED
        p++;
        let q = p;
        while (q < s.length && /[0-9]/.test(s.charAt(q))) q++; // ADDED
        if (s.charAt(q) !== ")") return null; // ADDED
        const index = parseInt(s.slice(p, q), 10); // ADDED
        return { endPos: q + 1, isComponent: true, index }; // ADDED
    } // ADDED
    // Optional arguments in balanced parentheses                                            // ADDED
    if (s.charAt(p) !== "(") {
        // ADDED
        return { endPos: p, name, args: "" }; // ADDED
    } // ADDED
    const open = p; // ADDED
    let depth = 0; // ADDED
    while (p < s.length) {
        // ADDED
        const ch = s.charAt(p); // ADDED
        if (ch === "(") depth++;
        // ADDED
        else if (ch === ")") {
            depth--;
            if (depth === 0) {
                // ADDED
                const args = s.slice(open + 1, p); // ADDED
                return { endPos: p + 1, name, args }; // ADDED
            }
        } // ADDED
        p++; // ADDED
    } // ADDED
    return null; // ADDED
} // ADDED

// ---------------------------------------------------------------------------            // ADDED
// scanAsync: async generator over AsyncIterable<Buffer|string> or Readable                // ADDED
// Natural back-pressure: consumer controls next()                                         // ADDED
// ---------------------------------------------------------------------------            // ADDED
async function* scanAsync(iterable, options) {
    // ADDED
    const opt = Object.assign({}, DEFAULTS, options || {}); // ADDED
    const hooks = opt.hooks; // ADDED
    runHook(hooks, "init", { mode: "async", options: opt }); // ADDED

    const decoder = new StringDecoder("utf8"); // ADDED
    let tail = ""; // ADDED

    const iter =
        typeof iterable[Symbol.asyncIterator] === "function" // ADDED
            ? iterable[Symbol.asyncIterator]() // ADDED
            : typeof iterable[Symbol.iterator] === "function" // ADDED
            ? iterable[Symbol.iterator]() // ADDED
            : (async function* () {
                  /* treat as single chunk */ yield iterable;
              })(); // ADDED

    for await (const chunk of iter) {
        // ADDED
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk); // ADDED
        let fed = tail + text; // ADDED
        fed = runHook(hooks, "onChunk", fed, { tail }) || fed; // ADDED
        // Process all but keep last N chars to avoid tearing delimiters                       // ADDED
        const keep = Math.min(opt.keepTail, fed.length); // ADDED
        const work = fed.slice(0, fed.length - keep); // ADDED
        tail = fed.slice(fed.length - keep); // ADDED

        // Delegate to sync scanner for the chunk                                              // ADDED
        for (const tok of scanSync(work, opt)) {
            // ADDED
            yield tok; // ADDED
        } // ADDED

        const sched = scheduleOnce(opt.schedule); // ADDED
        if (sched) await sched; // ADDED
    } // ADDED

    // Flush remaining tail                                                                  // ADDED
    const rest = tail + decoder.end(); // ADDED
    if (rest.length) {
        // ADDED
        for (const tok of scanSync(rest, options)) {
            // ADDED
            yield tok; // ADDED
        } // ADDED
    } // ADDED

    runHook(hooks, "finalize", { mode: "async" }); // ADDED
} // ADDED

// Convenience: Node Readable -> async generator                                           // ADDED
function fromReadable(readable, options) {
    // ADDED
    return scanAsync(readable, options); // ADDED
} // ADDED

// ---------------------------------------------------------------------------            // ADDED
// Public API surface: attach to main export                                               // ADDED
// ---------------------------------------------------------------------------            // ADDED
module.exports.scanSync = scanSync; // ADDED
module.exports.scan = scanSync; // alias                                            // ADDED
module.exports.scanAsync = scanAsync; // ADDED
module.exports.fromReadable = fromReadable; // ADDED

// Source-friendly code-frame for diagnostics                                              // ADDED
function codeFrame(source, loc, ctxLines = 2) {
    // ADDED
    if (!source || !loc || !loc.start) return ""; // ADDED
    const lines = source.split(/\r?\n/); // ADDED
    const lineIdx = Math.max(0, (loc.start.line | 0) - 1); // ADDED
    const startCol = Math.max(1, loc.start.col | 0); // ADDED
    const from = Math.max(0, lineIdx - ctxLines); // ADDED
    const to = Math.min(lines.length - 1, lineIdx + ctxLines); // ADDED
    const width = (to + 1).toString().length; // ADDED
    const out = []; // ADDED
    for (let i = from; i <= to; i++) {
        // ADDED
        const num = String(i + 1).padStart(width, " "); // ADDED
        out.push(`${num} | ${lines[i]}`); // ADDED
        if (i === lineIdx) {
            // ADDED
            const caret = " ".repeat(startCol - 1) + "^"; // ADDED
            out.push(" ".repeat(width) + " | " + caret); // ADDED
        } // ADDED
    } // ADDED
    return out.join("\n"); // ADDED
} // ADDED

module.exports.codeFrame = codeFrame; // ADDED

// Factory to freeze options + hooks into a bound API                                      // ADDED
function createTokenizer(options) {
    // ADDED
    const bound = (tpl) => Array.from(scanSync(tpl, options)); // ADDED
    bound.scanSync = (tpl) => scanSync(tpl, options); // ADDED
    bound.scan = bound.scanSync; // ADDED
    bound.scanAsync = (it) => scanAsync(it, options); // ADDED
    bound.fromReadable = (r) => fromReadable(r, options); // ADDED
    bound.TOKEN = TOKEN; // ADDED
    bound.codeFrame = codeFrame; // ADDED
    return bound; // ADDED
} // ADDED

module.exports.create = createTokenizer; // ADDED

// expose TOKEN alongside the function export                                              // ADDED
module.exports.TOKEN = TOKEN; // ADDED
