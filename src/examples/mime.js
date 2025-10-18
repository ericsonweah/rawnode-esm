"use strict";

// src/submodules/mime-types/index.js
// Zero‑dependency, event‑loop friendly MIME registry + RFC 7231 negotiation.

// ================
// Typed errors
// ================
class MimeTypeError extends Error {
    constructor(message, meta) {
        super(message);
        this.name = "MimeTypeError";
        this.meta = meta || null;
    }
}
class NegotiationError extends Error {
    constructor(message, meta) {
        super(message);
        this.name = "NegotiationError";
        this.meta = meta || null;
    }
}
class RegistryConflictError extends Error {
    constructor(message, meta) {
        super(message);
        this.name = "RegistryConflictError";
        this.meta = meta || null;
    }
}

// ================
// Built‑ins (curated) — extension → type
// Keys may include a leading '.' for back‑compat; we normalize to bare ext internally.
// ================
const BUILTIN_EXT_TO_TYPE = Object.freeze({
    // Core from previous version (kept intact)
    ".mpeg": "video/mpeg",
    ".mp3": "audio/mpeg",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".midi": "audio/midi",
    ".jsonld": "application/ld+json",
    ".json": "application/json",
    ".aac": "audio/aac",
    ".abw": "application/x-abiword",
    ".arc": "application/x-freearc",
    ".avi": "video/x-msvideo",
    ".azw": "application/vnd.amazon.ebook",
    ".bin": "application/octet-stream",
    ".bmp": "image/bmp",
    ".bz": "application/x-bzip",
    ".bz2": "application/x-bzip2",
    ".csh": "application/x-csh",
    ".css": "text/css",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".eot": "application/vnd.ms-fontobject",
    ".epub": "application/epub+zip",
    ".gz": "application/gzip",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".ico": "image/vnd.microsoft.icon",
    ".ics": "text/calendar",
    ".jar": "application/java-archive",
    ".mpkg": "application/vnd.apple.installer+xml",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".oga": "audio/ogg",
    ".ogv": "video/ogg",
    ".ogx": "application/ogg",
    ".opus": "audio/opus",
    ".otf": "font/otf",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".php": "application/x-httpd-php",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rar": "application/vnd.rar",
    ".rtf": "application/rtf",
    ".sh": "application/x-sh",
    ".svg": "image/svg+xml",
    ".swf": "application/x-shockwave-flash",
    ".tar": "application/x-tar",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".ts": "video/mp2t",
    ".ttf": "font/ttf",
    ".txt": "text/plain",
    ".vsd": "application/vnd.visio",
    ".wav": "audio/wav",
    ".weba": "audio/webm",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xhtml": "application/xhtml+xml",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
    ".xul": "application/vnd.mozilla.xul+xml",
    ".zip": "application/zip",
    ".3gp_67": "video/3gpp",
    ".3gp_68": "audio/3gpp",
    ".3g2_68": "video/3gpp2",
    ".3g2_69": "audio/3gpp",
    ".7z": "application/x-7z-compressed",
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".m4a": "audio/mp4",
    ".mov": "video/quicktime",
    ".flac": "audio/flac",
    ".wasm": "application/wasm",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".md": "text/markdown",
    ".yaml": "application/x-yaml",
    ".yml": "application/x-yaml",

    // Curated modern additions / aliases (widely used)
    ".avif": "image/avif",
    ".apng": "image/apng",
    ".svga": "image/svg+xml", // pragmatic alias
    ".ndjson": "application/x-ndjson",
    ".json5": "application/json", // pragmatic; still JSON family
    ".cjs": "text/javascript",
    ".tsv": "text/tab-separated-values",
    ".webpki": "application/pkix-cert",
    ".pem": "application/x-pem-file",
    ".crt": "application/x-x509-ca-cert",
    ".der": "application/x-x509-ca-cert",
    ".tgz": "application/gzip",
    ".tar.gz": "application/gzip", // compound
    ".tar.bz2": "application/x-bzip2",
    ".tar.xz": "application/x-xz",
    ".xz": "application/x-xz",
    ".br": "application/x-brotli",
    ".avro": "application/avro",
    ".parquet": "application/octet-stream",
    ".geojson": "application/geo+json",
    ".topojson": "application/json",
    ".wasm.map": "application/json",
});

// Known compound extensions (rightmost match first)
const COMPOUND_EXTS = [".wasm.map", ".tar.gz", ".tar.bz2", ".tar.xz"];

// Suffix families for matching like application/*+json
const SUFFIX_FAMILIES = new Set(["json", "xml", "protobuf", "zip"]);

// Sniff‑sensitive types → recommend X-Content-Type-Options: nosniff
const SNIFF_SENSITIVE = new Set(["text/html", "application/xhtml+xml", "application/xml", "text/xml", "image/svg+xml"]);

// Commonly compressible families
function defaultCompressible(type) {
    if (!type) return false;
    const t = baseType(type);
    if (t.startsWith("text/")) return true;
    if (t === "application/json" || t === "application/manifest+json") return true;
    if (t.endsWith("+json") || t.endsWith("+xml")) return true;
    if (t === "application/javascript" || t === "text/javascript") return true;
    if (t === "image/svg+xml") return true;
    // Often already compressed / not worth compressing:
    if (t.startsWith("image/") || t.startsWith("audio/") || t.startsWith("video/")) return false;
    if (t === "application/zip" || t === "application/gzip" || t === "application/x-7z-compressed" || t === "application/x-rar-compressed" || t === "application/wasm" || t === "application/pdf") return false;
    return true;
}

// Charset defaults
function defaultCharset(type) {
    if (!type) return null;
    const t = baseType(type);
    if (t.startsWith("text/")) return "utf-8";
    if (t === "application/json" || t.endsWith("+json")) return "utf-8";
    if (t === "application/xml" || t.endsWith("+xml") || t === "text/xml") return "utf-8";
    return null;
}

// ================
// Internal state / registry
// ================
const _state = {
    frozen: false,
    // ext (no dot) -> type
    extToType: new Map(),
    // type -> canonical ext (no dot) + weight
    typeToExt: new Map(), // type -> { ext, weight }
    // type meta
    typeMeta: new Map(), // type -> { compressible?: boolean, charset?: string, source?: string, weight?: number, nosniff?: boolean }
    // hooks
    hooks: {
        beforeLookup: [],
        afterLookup: [],
        onMiss: [],
        beforeNegotiate: [],
        afterNegotiate: [],
        onRegister: [],
        onConflict: [],
        onError: [],
    },
    plugins: [],
    counters: {
        mime_lookups_total_hit: 0,
        mime_lookups_total_miss: 0,
        mime_negotiate_total_result: 0,
        mime_negotiate_total_null: 0,
        mime_accept_parse_us_acc: 0,
        mime_accept_parse_count: 0,
    },
    policy: {
        allowTypes: null, // Set or null
        allowExts: null,
        denyTypes: null,
        denyExts: null,
    },
};

// ================
// Utilities
// ================
function asciiLower(s) {
    return s.toLowerCase();
}
function isValidTokenChar(code) {
    // RFC 7230 tchar: "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
    // Exclude separators and CTLs
    return (
        (code >= 48 && code <= 57) || // 0-9
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122) || // a-z
        code === 33 ||
        code === 35 ||
        code === 36 ||
        code === 37 ||
        code === 38 ||
        code === 39 ||
        code === 42 ||
        code === 43 ||
        code === 45 ||
        code === 46 ||
        code === 94 ||
        code === 95 ||
        code === 96 ||
        code === 124 ||
        code === 126
    );
}
function isValidTypeName(s) {
    if (!s) return false;
    // quick path
    const slash = s.indexOf("/");
    if (slash <= 0 || slash === s.length - 1) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (i === slash) {
            if (c !== 47) return false;
            continue;
        }
        if (!isValidTokenChar(c)) return false;
    }
    return true;
}
function baseType(type) {
    // strip params; lowercase; trim
    const semi = type.indexOf(";");
    const raw = (semi === -1 ? type : type.slice(0, semi)).trim().toLowerCase();
    return raw;
}
function typeSuffix(t) {
    const b = baseType(t);
    const plus = b.lastIndexOf("+");
    return plus === -1 ? null : b.slice(plus + 1);
}
function normalizeParams(params) {
    // params: array of [k,v] unquoted values
    if (!params || params.length === 0) return "";
    params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return "; " + params.map(([k, v]) => `${k}=${v}`).join("; ");
}
function normalizeType(input) {
    if (typeof input !== "string") throw new MimeTypeError("Type must be a string");
    let s = input.trim().toLowerCase();
    const semi = s.indexOf(";");
    const t = (semi === -1 ? s : s.slice(0, semi)).trim();
    if (!isValidTypeName(t)) throw new MimeTypeError(`Invalid media type "${input}"`);
    // parse params (if any)
    let params = [];
    if (semi !== -1) {
        let rest = s.slice(semi + 1);
        const parts = rest.split(";");
        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i].trim();
            if (!seg) continue;
            const eq = seg.indexOf("=");
            if (eq <= 0) continue;
            const k = seg.slice(0, eq).trim().toLowerCase();
            let v = seg.slice(eq + 1).trim();
            if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
            params.push([k, v]);
        }
    }
    return t + normalizeParams(params);
}

// Extract lowercase extension (no dot) from path or ext; supports compound extensions.
function extractExt(pathOrExt) {
    if (!pathOrExt) return null;
    let s = String(pathOrExt);
    // strip query/fragment
    const q = s.indexOf("?");
    if (q !== -1) s = s.slice(0, q);
    const h = s.indexOf("#");
    if (h !== -1) s = s.slice(0, h);
    // basename
    const slash = s.lastIndexOf("/");
    if (slash !== -1) s = s.slice(slash + 1);
    try {
        s = decodeURIComponent(s);
    } catch (_) {
        /* ignore */
    }
    s = s.normalize("NFC");
    const lower = s.toLowerCase();

    // compound first (longest wins)
    for (const comp of COMPOUND_EXTS) {
        if (lower.endsWith(comp)) return comp.slice(1); // remove leading dot
    }
    // single ext
    const i = lower.lastIndexOf(".");
    if (i === -1) {
        if (lower.startsWith(".")) return lower.slice(1);
        return null;
    }
    return lower.slice(i + 1);
}

// Emit hooks safely
function emit(hook, payload) {
    const arr = _state.hooks[hook];
    if (!arr || arr.length === 0) return;
    for (let i = 0; i < arr.length; i++) {
        try {
            arr[i](payload);
        } catch (err) {
            const e = new MimeTypeError("Hook error", { hook, err });
            if (_state.hooks.onError.length) emit("onError", e);
        }
    }
}

// Back‑compat mirror: keep mime[".json"] style keys in sync with registry
function rebuildExportMirror(obj) {
    // remove old extension keys
    for (const k of Object.keys(obj)) {
        if (k.startsWith(".")) {
            try {
                delete obj[k];
            } catch (_) {}
        }
    }
    for (const [ext, type] of _state.extToType.entries()) {
        Object.defineProperty(obj, "." + ext, {
            value: type,
            configurable: true,
            enumerable: true,
            writable: false,
        });
    }
}

// Build initial registry
function resetToBuiltins() {
    _state.extToType.clear();
    _state.typeToExt.clear();
    _state.typeMeta.clear();

    for (const [k, v] of Object.entries(BUILTIN_EXT_TO_TYPE)) {
        const ext = (k[0] === "." ? k.slice(1) : k).toLowerCase();
        const type = v.toLowerCase();
        _state.extToType.set(ext, type);
        // pick the first seen as canonical, weight 0
        if (!_state.typeToExt.has(type)) _state.typeToExt.set(type, { ext, weight: 0 });
        _state.typeMeta.set(type, {
            compressible: defaultCompressible(type),
            charset: defaultCharset(type),
            source: "iana",
            weight: 0,
            nosniff: SNIFF_SENSITIVE.has(type),
        });
    }
}

// Initialize
resetToBuiltins();

// ================
// Accept parser (single‑pass, no regex, allocation‑light)
// ================
function parseAccept(header) {
    const start = process.hrtime.bigint();
    const out = [];
    if (header == null || header === "") return out;

    const s = String(header);
    let i = 0,
        n = s.length,
        itemStart = 0;
    let parts = [];
    // split on commas not inside quotes (Accept rarely uses quoted strings, but we handle simply)
    while (i <= n) {
        const c = i === n ? "," : s[i];
        if (c === ",") {
            parts.push(s.slice(itemStart, i).trim());
            itemStart = i + 1;
        }
        i++;
    }
    let order = 0;
    for (let p = 0; p < parts.length; p++) {
        const seg = parts[p];
        if (!seg) continue;
        const tokens = seg.split(";"); // params are tiny; safe
        const range = tokens[0].trim().toLowerCase();
        if (!range) continue;

        let type = range;
        let wildType = false,
            wildSub = false,
            suffix = null;

        // Interpret media range
        const slash = type.indexOf("/");
        if (slash === -1) continue; // skip invalid
        const main = type.slice(0, slash);
        const sub = type.slice(slash + 1);
        if (main === "*" && sub === "*") {
            wildType = true;
            wildSub = true;
        } else if (sub === "*") {
            wildSub = true;
        } else {
            const plus = sub.lastIndexOf("+");
            if (plus !== -1) suffix = sub.slice(plus + 1);
        }

        let q = 1;
        const params = [];
        for (let t = 1; t < tokens.length; t++) {
            const kv = tokens[t].trim();
            if (!kv) continue;
            const eq = kv.indexOf("=");
            if (eq === -1) {
                params.push([kv.toLowerCase(), ""]);
                continue;
            }
            const k = kv.slice(0, eq).trim().toLowerCase();
            let v = kv.slice(eq + 1).trim();
            if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
            if (k === "q") {
                const qq = parseFloat(v);
                if (!Number.isNaN(qq)) q = Math.min(1, Math.max(0, qq));
            } else {
                params.push([k, v]);
            }
        }

        // Specificity: exact(3) > subtype wildcard(2) > suffix wildcard(1.5) > full wildcard(1)
        let specificity = 3;
        if (wildType && wildSub) specificity = 1;
        else if (wildSub) specificity = 2;
        else if (!wildSub && suffix && SUFFIX_FAMILIES.has(suffix)) specificity = 2.5; // prefer over simple subtype wildcard

        out.push({
            type: range,
            main,
            sub,
            suffix,
            q,
            params,
            specificity,
            order: order++,
        });
    }

    const dur = process.hrtime.bigint() - start;
    const us = Number(dur / 1000n);
    _state.counters.mime_accept_parse_us_acc += us;
    _state.counters.mime_accept_parse_count += 1;
    return out.sort((a, b) => {
        // Most preferred first: q desc, specificity desc, order asc
        if (b.q !== a.q) return b.q - a.q;
        if (b.specificity !== a.specificity) return b.specificity - a.specificity;
        return a.order - b.order;
    });
}

// ================
// Negotiation
// ================
function matchScore(offeredType, acc) {
    const t = baseType(offeredType);
    const slash = t.indexOf("/");
    if (slash === -1) return -1;
    const tMain = t.slice(0, slash);
    const tSub = t.slice(slash + 1);
    if (acc.main === "*" && acc.sub === "*") return 1;
    if (acc.main === tMain && acc.sub === "*") return 2;
    if (acc.main === tMain && acc.sub === tSub) return 3;
    if (acc.main === tMain && acc.suffix && tSub.endsWith("+" + acc.suffix)) return 2.5;
    return -1;
}

function negotiate(acceptHeader, offeredTypes) {
    emit("beforeNegotiate", { acceptHeader, offeredTypes });
    const offered = Array.isArray(offeredTypes) ? offeredTypes : [offeredTypes];
    const normalizedOffered = offered.map(resolveType).filter(Boolean);
    if (normalizedOffered.length === 0) return null;

    // If no Accept, return the first offered (HTTP/1.1 default)
    if (acceptHeader == null || String(acceptHeader).trim() === "") {
        const chosen = normalizedOffered[0];
        _state.counters.mime_negotiate_total_result += 1;
        emit("afterNegotiate", { acceptHeader, offeredTypes, result: { type: chosen, q: 1, from: "default" } });
        return { type: chosen, q: 1, from: "default" };
    }

    const accepted = parseAccept(acceptHeader);
    if (accepted.length === 0) {
        const chosen = normalizedOffered[0];
        _state.counters.mime_negotiate_total_result += 1;
        emit("afterNegotiate", { acceptHeader, offeredTypes, result: { type: chosen, q: 1, from: "default" } });
        return { type: chosen, q: 1, from: "default" };
    }

    // Evaluate scores
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < normalizedOffered.length; i++) {
        const cand = normalizedOffered[i];
        for (let j = 0; j < accepted.length; j++) {
            const acc = accepted[j];
            const m = matchScore(cand, acc);
            if (m < 0) continue;

            // Parameter consideration (e.g., charset=utf-8)
            let paramBonus = 0;
            if (acc.params && acc.params.length) {
                for (let k = 0; k < acc.params.length; k++) {
                    const [kname, kval] = acc.params[k];
                    if (kname === "charset") {
                        const cs = defaultCharset(cand);
                        if (cs && asciiLower(kval) === cs) paramBonus += 0.01; // tiny tie‑breaker
                    }
                }
            }
            // Score: q (0..1) scaled, then specificity, then param bonus and offered order
            const score = acc.q * 100 + m * 10 + paramBonus - i * 1e-6 - acc.order * 1e-9;
            if (score > bestScore) {
                bestScore = score;
                best = { type: cand, q: acc.q, from: acc.type };
            }
        }
    }

    if (best) {
        _state.counters.mime_negotiate_total_result += 1;
        emit("afterNegotiate", { acceptHeader, offeredTypes, result: best });
        return best;
    }

    _state.counters.mime_negotiate_total_null += 1;
    emit("afterNegotiate", { acceptHeader, offeredTypes, result: null });
    return null;
}

// ================
// Registry control
// ================
function ensureMutable() {
    if (_state.frozen) throw new RegistryConflictError("MIME registry is frozen");
}
function setCanonical(type, ext, weight) {
    const prev = _state.typeToExt.get(type);
    if (!prev || weight > prev.weight) _state.typeToExt.set(type, { ext, weight });
}
function register(map, opts = {}) {
    ensureMutable();
    const source = opts.source || "custom";
    const weight = typeof opts.weight === "number" ? opts.weight : 1;
    const override = opts.override || "prefer-default"; // or "prefer-custom"

    emit("onRegister", { map, opts });

    // Accept both { type: [exts] } and { ".ext": "type" } forms.
    for (const key of Object.keys(map)) {
        const val = map[key];
        if (key.includes("/")) {
            // type -> exts[]
            const type = baseType(key);
            const exts = Array.isArray(val) ? val : [String(val)];
            if (!isValidTypeName(type)) throw new MimeTypeError(`Invalid type "${key}" in register()`);
            for (let i = 0; i < exts.length; i++) {
                const ext = String(exts[i]).replace(/^\./, "").toLowerCase().normalize("NFC");
                const existing = _state.extToType.get(ext);
                if (existing && existing !== type) {
                    emit("onConflict", { ext, existing, incoming: type });
                    if (override === "prefer-custom") {
                        _state.extToType.set(ext, type);
                    }
                    // else keep existing
                } else {
                    _state.extToType.set(ext, type);
                }
                setCanonical(type, ext, weight);
                const meta = _state.typeMeta.get(type) || {};
                meta.source = source;
                meta.weight = Math.max(weight, meta.weight || 0);
                if (meta.compressible == null) meta.compressible = defaultCompressible(type);
                if (meta.charset == null) meta.charset = defaultCharset(type);
                meta.nosniff = SNIFF_SENSITIVE.has(type);
                _state.typeMeta.set(type, meta);
            }
        } else {
            // ext -> type
            const ext = String(key).replace(/^\./, "").toLowerCase().normalize("NFC");
            const type = baseType(String(val));
            if (!isValidTypeName(type)) throw new MimeTypeError(`Invalid type "${val}" in register()`);
            const existing = _state.extToType.get(ext);
            if (existing && existing !== type) {
                emit("onConflict", { ext, existing, incoming: type });
                if (override === "prefer-custom") {
                    _state.extToType.set(ext, type);
                }
            } else {
                _state.extToType.set(ext, type);
            }
            setCanonical(type, ext, weight);
            const meta = _state.typeMeta.get(type) || {};
            meta.source = source;
            meta.weight = Math.max(weight, meta.weight || 0);
            if (meta.compressible == null) meta.compressible = defaultCompressible(type);
            if (meta.charset == null) meta.charset = defaultCharset(type);
            meta.nosniff = SNIFF_SENSITIVE.has(type);
            _state.typeMeta.set(type, meta);
        }
    }
    rebuildExportMirror(mime); // keep mime[".ext"] in sync
}
function remove(typeOrExt) {
    ensureMutable();
    const s = String(typeOrExt).toLowerCase();
    if (s.includes("/")) {
        const type = baseType(s);
        const rec = _state.typeToExt.get(type);
        if (rec) {
            _state.typeToExt.delete(type);
            for (const [ext, t] of _state.extToType.entries()) {
                if (t === type) _state.extToType.delete(ext);
            }
            _state.typeMeta.delete(type);
        }
    } else {
        const ext = s.replace(/^\./, "");
        const t = _state.extToType.get(ext);
        if (t) {
            _state.extToType.delete(ext);
            const rec = _state.typeToExt.get(t);
            if (rec && rec.ext === ext) _state.typeToExt.delete(t);
        }
    }
    rebuildExportMirror(mime);
}
function reset() {
    ensureMutable();
    resetToBuiltins();
    rebuildExportMirror(mime);
}
function freeze() {
    _state.frozen = true;
    Object.freeze(_state);
}
function snapshot() {
    return {
        frozen: _state.frozen,
        extToType: Array.from(_state.extToType.entries()),
        typeToExt: Array.from(_state.typeToExt.entries()),
        typeMeta: Array.from(_state.typeMeta.entries()),
        counters: { ..._state.counters },
        policy: {
            allowTypes: _state.policy.allowTypes ? Array.from(_state.policy.allowTypes) : null,
            allowExts: _state.policy.allowExts ? Array.from(_state.policy.allowExts) : null,
            denyTypes: _state.policy.denyTypes ? Array.from(_state.policy.denyTypes) : null,
            denyExts: _state.policy.denyExts ? Array.from(_state.policy.denyExts) : null,
        },
    };
}
function restore(snap) {
    ensureMutable();
    _state.extToType = new Map(snap.extToType);
    _state.typeToExt = new Map(snap.typeToExt.map(([k, v]) => [k, v]));
    _state.typeMeta = new Map(snap.typeMeta.map(([k, v]) => [k, v]));
    _state.counters = { ...snap.counters };
    _state.policy.allowTypes = snap.policy.allowTypes ? new Set(snap.policy.allowTypes) : null;
    _state.policy.allowExts = snap.policy.allowExts ? new Set(snap.policy.allowExts) : null;
    _state.policy.denyTypes = snap.policy.denyTypes ? new Set(snap.policy.denyTypes) : null;
    _state.policy.denyExts = snap.policy.denyExts ? new Set(snap.policy.denyExts) : null;
    rebuildExportMirror(mime);
}

// ================
// Policy
// ================
function setAllowList({ types = null, exts = null } = {}) {
    ensureMutable();
    _state.policy.allowTypes = types ? new Set(types.map(baseType)) : null;
    _state.policy.allowExts = exts ? new Set(exts.map((e) => String(e).replace(/^\./, "").toLowerCase())) : null;
}
function setDenyList({ types = null, exts = null } = {}) {
    ensureMutable();
    _state.policy.denyTypes = types ? new Set(types.map(baseType)) : null;
    _state.policy.denyExts = exts ? new Set(exts.map((e) => String(e).replace(/^\./, "").toLowerCase())) : null;
}
function allowedType(type) {
    const t = baseType(type);
    const p = _state.policy;
    if (p.denyTypes && p.denyTypes.has(t)) return false;
    if (p.allowTypes && !p.allowTypes.has(t)) return false;
    return true;
}
function allowedExt(ext) {
    const e = String(ext).toLowerCase();
    const p = _state.policy;
    if (p.denyExts && p.denyExts.has(e)) return false;
    if (p.allowExts && !p.allowExts.has(e)) return false;
    return true;
}

// ================
// Public API
// ================
function resolveType(nameOrExtOrType) {
    if (!nameOrExtOrType) return null;
    const s = String(nameOrExtOrType).trim();
    if (s.includes("/")) {
        try {
            return normalizeType(s);
        } catch (_) {
            return null;
        }
    }
    const ext = extractExt(s) || s.replace(/^\./, "").toLowerCase();
    return fromExtension(ext);
}

function lookup(pathOrExt) {
    emit("beforeLookup", { input: pathOrExt });
    const ext = extractExt(pathOrExt);
    if (!ext) {
        _state.counters.mime_lookups_total_miss++;
        emit("onMiss", { input: pathOrExt });
        return null;
    }
    const t = fromExtension(ext);
    if (t) {
        _state.counters.mime_lookups_total_hit++;
        emit("afterLookup", { input: pathOrExt, type: t });
        return t;
    }
    _state.counters.mime_lookups_total_miss++;
    emit("onMiss", { input: pathOrExt });
    return null;
}
function byPath(path) {
    return lookup(path);
}

function fromExtension(ext) {
    if (!ext) return null;
    const e = String(ext).replace(/^\./, "").toLowerCase().normalize("NFC");
    if (!allowedExt(e)) return null;
    const t = _state.extToType.get(e);
    if (!t) return null;
    if (!allowedType(t)) return null;
    return t;
}

function extension(type) {
    if (!type) return null;
    const t = baseType(type);
    if (!allowedType(t)) return null;
    const rec = _state.typeToExt.get(t);
    return rec ? rec.ext : null;
}

function charset(type) {
    const t = baseType(type);
    const meta = _state.typeMeta.get(t);
    if (meta && meta.charset) return meta.charset;
    return defaultCharset(t);
}

function contentType(nameOrExt) {
    const t = resolveType(nameOrExt);
    if (!t) return null;
    // If input already had a charset param, respect it; else add defaults for text/json/xml families
    let out = t;
    if (defaultCharset(t)) {
        if (t.indexOf(";") === -1) {
            out = `${t}; charset=${defaultCharset(t)}`;
        } else {
            // preserve existing params; avoid duplicate charset
            if (!/; *charset=/i.test(t)) out = `${t}; charset=${defaultCharset(t)}`;
        }
    }
    return out;
}

function normalize(type) {
    return normalizeType(type);
}

function isText(type) {
    const t = baseType(type);
    return t.startsWith("text/") || t === "application/json" || t.endsWith("+json") || t === "application/xml" || t.endsWith("+xml") || t === "image/svg+xml" || t === "application/javascript" || t === "text/javascript";
}
function isBinary(type) {
    return !isText(type);
}
function isCompressible(type) {
    const t = baseType(type);
    const meta = _state.typeMeta.get(t);
    if (meta && typeof meta.compressible === "boolean") return meta.compressible;
    return defaultCompressible(t);
}

function headersFor(typeLike) {
    const t = resolveType(typeLike);
    if (!t) return {};
    const h = { "Content-Type": contentType(t) };
    if (SNIFF_SENSITIVE.has(baseType(t))) h["X-Content-Type-Options"] = "nosniff";
    return h;
}

function best(ofCandidates, { acceptHeader } = {}) {
    const candidates = Array.isArray(ofCandidates) ? ofCandidates : [ofCandidates];
    const offered = [];
    for (let i = 0; i < candidates.length; i++) {
        const t = resolveType(candidates[i]);
        if (t) offered.push(t);
    }
    const res = negotiate(acceptHeader, offered);
    return res;
}

function explain({ accept, offered }) {
    const accepted = parseAccept(accept || "");
    const cand = (Array.isArray(offered) ? offered : [offered]).map(resolveType).filter(Boolean);
    const traces = [];
    for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        const v = [];
        for (let j = 0; j < accepted.length; j++) {
            const a = accepted[j];
            v.push({ accept: a.type, score: matchScore(c, a), q: a.q, specificity: a.specificity, order: a.order });
        }
        traces.push({ candidate: c, scores: v });
    }
    const chosen = negotiate(accept, cand);
    return { accepted, candidates: cand, scores: traces, chosen };
}

// Hooks & plugins
function use(plugin, { namespace = "plugin", order = 0 } = {}) {
    if (!plugin || typeof plugin !== "object") return;
    const hooks = plugin.hooks || {};
    for (const k of Object.keys(_state.hooks)) {
        const fn = hooks[k];
        if (typeof fn === "function") _state.hooks[k].push(fn);
        else if (Array.isArray(fn)) for (let i = 0; i < fn.length; i++) if (typeof fn[i] === "function") _state.hooks[k].push(fn[i]);
    }
    _state.plugins.push({ namespace, order, plugin });
    // Deterministic order (stable)
    for (const k of Object.keys(_state.hooks)) {
        // plugins already appended; no per‑hook order needed beyond append in load order
    }
}

function stats() {
    const cnt = _state.counters;
    const avgParseUs = cnt.mime_accept_parse_count ? cnt.mime_accept_parse_us_acc / cnt.mime_accept_parse_count : 0;
    return {
        registry: { types: _state.typeToExt.size, exts: _state.extToType.size },
        counters: {
            http: {
                mime_lookups_total: { hit: cnt.mime_lookups_total_hit, miss: cnt.mime_lookups_total_miss },
                mime_negotiate_total: { result: cnt.mime_negotiate_total_result, null: cnt.mime_negotiate_total_null },
                mime_accept_parse_us: { avg: avgParseUs },
            },
        },
    };
}

// Return all registered media types or an ext->type object.
// Options:
//   - { sorted: true }            → sort keys ascending
//   - { as: "object" }            → return { ".ext": "type", ... }
//   - { object: true }            → alias for { as: "object" }
//   - { leadingDot: false }       → when as=object, use bare ext keys (default: true)
function types(options) {
  const opts = options || {};
  const sorted = opts.sorted === true;
  const asObject = opts.as === "object" || opts.object === true;
  const leadingDot = opts.leadingDot === false ? false : true;

  if (!asObject) {
    // Default: list of canonical media types
    const list = Array.from(_state.typeToExt.keys());
    if (sorted) list.sort();
    return list;
  }

  // Object form: extension → type (includes compound extensions like "tar.gz")
  const entries = Array.from(_state.extToType.entries());
  if (sorted) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const obj = {};
  for (let i = 0; i < entries.length; i++) {
    const ext = entries[i][0];  // bare ext (no dot) in registry
    const type = entries[i][1];
    const key = leadingDot ? ("." + ext) : ext;
    obj[key] = type;
  }
  return obj;
}


// Public object
const mime = {
    // Lookups
    lookup,
    fromExtension,
    extension,
    contentType,
    charset,
    normalize,
    byPath,
    // Negotiation
    parseAccept,
    negotiate,
    best,
    // Traits
    isText,
    isBinary,
    isCompressible,
    // Registry control
    register,
    remove,
    reset,
    freeze,
    snapshot,
    restore,
    // Policy
    setAllowList,
    setDenyList,
    // Hooks & plugins
    use,
    // Telemetry
    stats,
    // QoL headers
    headers: { for: headersFor },

    // Types 

    types,
    // Errors
    MimeTypeError,
    NegotiationError,
    RegistryConflictError,
    // For DX/compatibility: expose a live view of ext->type on the root object (updated on changes)
    // (Properties with keys like ".json" are added by rebuildExportMirror)
};

// Initial mirror build for mime[".ext"] direct access
rebuildExportMirror(mime);

// Export
export default mime;
// Optional: build-time serializer (not used at runtime unless you call it)
// Generates a compact JSON you can embed and freeze for even faster cold starts.
export const _emitCompact = function _emitCompact() {
    const exts = Array.from(_state.extToType.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const types = Array.from(_state.typeToExt.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const meta = Array.from(_state.typeMeta.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return JSON.stringify({ exts, types, meta });
};
