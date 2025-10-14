"use strict";

// /scan.mjs
// Minimal, fast, AST-less scanner for require/exports/__dirname/__filename
export function scanSource(src) {
    const facts = { requires: [], exports: [], uses: { __dirname: false, __filename: false, requireResolve: [], createRequire: false }, amd: false };
    let i = 0,
        line = 1,
        col = 1,
        brace = 0,
        funcDepth = 0,
        prevSig = "BOF";

    const pushReq = (site) => facts.requires.push(site);
    const pushExp = (e) => facts.exports.push(e);

    while (i < src.length) {
        const ch = src.charCodeAt(i);

        // whitespace / newline
        if (ch === 10 /*\n*/ || ch === 13 /*\r*/) {
            i++;
            line++;
            col = 1;
            prevSig = prevSig === "WS" ? prevSig : "WS";
            continue;
        }
        if (ch === 9 || ch === 32) {
            i++;
            col++;
            prevSig = "WS";
            continue;
        }

        // comments
        if (ch === 47 /*/*/ && src[i + 1] === "/") {
            // line comment
            i += 2;
            col += 2;
            while (i < src.length && src[i] !== "\n") {
                i++;
                col++;
            }
            continue;
        }
        if (ch === 47 && src[i + 1] === "*") {
            // block comment
            i += 2;
            col += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
                if (src[i] === "\n") {
                    line++;
                    col = 1;
                    i++;
                    continue;
                }
                i++;
                col++;
            }
            i += 2;
            col += 2;
            continue;
        }

        // strings
        if (ch === 39 || ch === 34) {
            // ' or "
            const q = src[i];
            let j = i + 1;
            let esc = false;
            while (j < src.length) {
                const c = src[j];
                if (!esc && c === q) {
                    j++;
                    break;
                }
                esc = !esc && c === "\\";
                if (c === "\n") {
                    line++;
                    col = 1;
                } else col++;
                j++;
            }
            prevSig = "LIT";
            i = j;
            continue;
        }

        // template literal
        if (src[i] === "`") {
            i++;
            col++;
            while (i < src.length) {
                if (src[i] === "\\") {
                    i += 2;
                    col += 2;
                    continue;
                }
                if (src[i] === "$" && src[i + 1] === "{") {
                    i += 2;
                    col += 2;
                    brace++;
                    break;
                }
                if (src[i] === "`") {
                    i++;
                    col++;
                    break;
                }
                if (src[i] === "\n") {
                    line++;
                    col = 1;
                    i++;
                } else {
                    i++;
                    col++;
                }
            }
            prevSig = "LIT";
            continue;
        }

        // regex vs division: simple heuristic on prevSig
        if (src[i] === "/") {
            const isRegex = /^(BOF|WS|PUNC|OP|KEY)$/.test(prevSig);
            if (isRegex) {
                i++;
                col++;
                let inClass = false,
                    esc = false;
                while (i < src.length) {
                    const c = src[i];
                    if (!esc) {
                        if (c === "[") inClass = true;
                        else if (c === "]") inClass = false;
                        else if (c === "/" && !inClass) {
                            i++;
                            col++;
                            /* flags */ while (/[a-z]/i.test(src[i])) {
                                i++;
                                col++;
                            }
                            break;
                        }
                    }
                    esc = !esc && c === "\\";
                    if (c === "\n") {
                        line++;
                        col = 1;
                    } else col++;
                    i++;
                }
                prevSig = "LIT";
                continue;
            }
        }

        // braces and simple function detection (heuristic)
        if (src[i] === "{") {
            brace++;
            i++;
            col++;
            prevSig = "PUNC";
            continue;
        }
        if (src[i] === "}") {
            if (brace > 0) brace--;
            i++;
            col++;
            prevSig = "PUNC";
            continue;
        }
        if (src.startsWith("function", i)) {
            funcDepth++;
            i += "function".length;
            col += "function".length;
            prevSig = "KEY";
            continue;
        }
        if (src.startsWith("class", i)) {
            funcDepth++;
            i += "class".length;
            col += "class".length;
            prevSig = "KEY";
            continue;
        }

        // identifiers
        if (/[A-Za-z_$]/.test(src[i])) {
            const start = i;
            while (/[A-Za-z0-9_$]/.test(src[i])) i++;
            const ident = src.slice(start, i);
            col += i - start;
            prevSig = "IDENT";

            if (ident === "__dirname") facts.uses.__dirname = true;
            if (ident === "__filename") facts.uses.__filename = true;

            if (ident === "define" && brace === 0) facts.amd = true;

            // require or require.resolve
            if (ident === "require") {
                let j = i,
                    dotResolve = false;
                while (src[j] === " ") j++;
                if (src[j] === ".") {
                    if (src.slice(j, j + 8) === ".resolve") {
                        dotResolve = true;
                        j += 8;
                    }
                }
                while (src[j] === " ") j++;
                if (src[j] === "(") {
                    j++; // inside call
                    while (src[j] === " ") j++;
                    let argStr = undefined,
                        staticArg = false,
                        argStart = j;
                    if (src[j] === "'" || src[j] === '"') {
                        const q = src[j++];
                        let s = "";
                        while (j < src.length) {
                            const c = src[j];
                            if (c === q) {
                                j++;
                                break;
                            }
                            if (c === "\\") {
                                s += c;
                                j++;
                                s += src[j++] ?? "";
                                continue;
                            }
                            s += c;
                            j++;
                        }
                        argStr = s;
                        staticArg = true;
                        while (src[j] === " ") j++;
                        if (src[j] === ")") j++;
                    } else {
                        // dynamic arg: find matching ')'
                        let par = 1;
                        while (j < src.length && par > 0) {
                            if (src[j] === "(") par++;
                            else if (src[j] === ")") par--;
                            j++;
                        }
                    }
                    const end = j;
                    const topLevel = brace === 0 && funcDepth === 0;
                    // naive LHS detection: look behind a small window for '='
                    const before = src.slice(Math.max(0, start - 64), start);
                    const assigned = /=\s*$/.test(before) || /(?:var|let|const)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*$/.test(before);
                    const destructured = /{[^}]*}\s*=\s*$/.test(before);
                    const sideEffect = !assigned && !destructured && topLevel;

                    const pattern = dotResolve ? "resolve" : staticArg ? (sideEffect ? "side-effect" : destructured ? "destructure" : "assign") : "dynamic";

                    const site = { start, end, callee: dotResolve ? "require.resolve" : "require", arg: argStr, topLevel, pattern, idents: [] };
                    facts.requires.push(site);
                    i = j;
                    col += j - start;
                    continue;
                }
            }

            // module.exports = ...
            if (ident === "module") {
                let j = i;
                while (src[j] === " ") j++;
                if (src[j] === "." && src.slice(j + 1, j + 8) === "exports") {
                    j += 8; // "." + "exports"
                    while (src[j] === " ") j++;
                    if (src[j] === "=") {
                        const topLevel = brace === 0 && funcDepth === 0;
                        facts.exports.push({ kind: "module.exports", start, eqPos: j + 1, topLevel });
                    }
                }
            }

            // exports.name = ...
            if (ident === "exports") {
                let j = i;
                while (src[j] === " ") j++;
                if (src[j] === ".") {
                    j++;
                    const nameStart = j;
                    while (/[A-Za-z0-9_$]/.test(src[j])) j++;
                    const name = src.slice(nameStart, j);
                    while (src[j] === " ") j++;
                    if (src[j] === "=") {
                        const topLevel = brace === 0 && funcDepth === 0;
                        facts.exports.push({ kind: "exports.name", name, start, eqPos: j + 1, topLevel });
                    }
                }
            }

            continue;
        }

        // punctuators
        prevSig = "PUNC";
        i++;
        col++;
    }
    return facts;
}
