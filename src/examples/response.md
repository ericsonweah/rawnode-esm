"use strict";

// src/submodules/response/index.js

// --- 1. Core Node.js Modules ---
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs").promises;
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const zlib = require("node:zlib");
// const { Buffer } = require("node:buffer");
const { Transform, pipeline, Readable, Writable } = require("node:stream");
const { promisify } = require("node:util");
const { once } = require("node:events");
const os = require("node:os"); // Only if loadavg is used (recommend removing from helpers)
const querystring = require("node:querystring"); // Or use 'qs' if preferred
const { URL } = require("node:url");
const { StringDecoder } = require("node:string_decoder");

// --- 4. Promisified Utilities ---
const streamPipeline = promisify(pipeline);
const gzipPromise = promisify(zlib.gzip);
// Check Brotli support once
const IS_BROTLI_SUPPORTED_SERVER = typeof zlib.createBrotliCompress === "function";
// Encoding negotiation constants (server-side)
const REGEX_BROTLI_ACCEPT = /\bbr\b/;
const REGEX_GZIP_ACCEPT = /\bgzip\b/;
const ENCODING_TYPE_BROTLI = "br";
const ENCODING_TYPE_GZIP = "gzip";

const brotliCompressPromise = IS_BROTLI_SUPPORTED_SERVER ? promisify(zlib.brotliCompress) : null;

const mime = require("../mime-types");

const MIME_TYPES = mime.types({ as: "object" });

// --- Requires Buffer at TOP ---
const { Buffer } = require("node:buffer");

// Stream & MIME helpers
const DEFAULT_STREAM_CHUNK_SIZE = 64 * 1024;
function lookupMimeType(filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return (ext && MIME_TYPES[ext]) || "application/octet-stream";
}

// --- Define Constants if not already defined ---
const HTTP_STATUS_OK_DEFAULT = 200;
const HTTP_STATUS_INTERNAL_SERVER_ERROR_CODE = 500;
const CONTENT_TYPE_JSON_UTF8 = "application/json; charset=utf-8";
const GENERIC_ERROR_JSON_BODY = JSON.stringify({ success: false, error: "Internal Server Error" });
// ------------------------------------------

/**
 * Initializes response decoration by validating core HTTP objects and setting up
 * response-specific helper methods or properties.
 *
 * @param {http.ServerResponse} response - The Node.js HTTP ServerResponse object.
 * @param {http.IncomingMessage} request - The Node.js HTTP IncomingMessage object.
 * @param {net.Socket | tls.TLSSocket} socket - The underlying network socket (usually request.socket).
 * @throws {TypeError} If provided arguments are not of the expected types.
 */
module.exports = (response, request, socket) => {
    // Optional: Add logging for when decorator is applied

    // --- Initial Validation ---
    // if (!(response instanceof http.ServerResponse)) throw new TypeError("Decorator requires http.ServerResponse");
    // if (!(request instanceof http.IncomingMessage)) throw new TypeError("Decorator requires http.IncomingMessage");
    // if (!(socket instanceof net.Socket)) throw new TypeError("Decorator requires net.Socket or tls.TLSSocket");

    // --- Set up Response Helpers ---

    // ---------- Symbol-backed internal state & helpers ----------
    const K_HOOKS = Symbol.for("rawnode.res.hooks");
    const K_START_HR = Symbol.for("rawnode.res.startHr");
    const K_BYTES = Symbol.for("rawnode.res.bytes");
    const K_ORIG_WRITE = Symbol.for("rawnode.res.origWrite");
    const K_ORIG_END = Symbol.for("rawnode.res.origEnd");
    const K_COMPRESS = Symbol.for("rawnode.res.compressEnabled");
    const K_TRAILER_NAMES = Symbol.for("rawnode.res.trailerNames");
    const K_TRAILER_PAIRS = Symbol.for("rawnode.res.trailerPairs");
    const K_CT_CACHE = Symbol.for("rawnode.res.ctCache");

    let ContentTypeMod = null;
    try {
        ContentTypeMod = require("../ContentType");
    } catch (_) {
        /* optional */
    }

    // RFC7230 token & value checks
    const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    const CTRL_RE = /[\0-\x1F\x7F]/;

    function setSafeHeader(res, name, value) {
        if (!TOKEN_RE.test(name)) throw new Error(`Invalid header name: ${name}`);
        if (value === undefined) return res;
        if (Array.isArray(value)) {
            for (const v of value) if (CTRL_RE.test(String(v))) throw new Error(`Invalid header value for ${name}`);
            res.setHeader(name, value);
        } else {
            const v = String(value);
            if (CTRL_RE.test(v)) throw new Error(`Invalid header value for ${name}`);
            res.setHeader(name, v);
        }
        return res;
    }
    function appendSafeHeader(res, name, value) {
        const lc = String(name).toLowerCase();
        if (lc === "set-cookie") {
            const prev = res.getHeader("Set-Cookie");
            const list = [];
            if (prev) Array.isArray(prev) ? list.push(...prev) : list.push(String(prev));
            list.push(String(value));
            return setSafeHeader(res, "Set-Cookie", list);
        }
        const prev = res.getHeader(name);
        if (!prev) return setSafeHeader(res, name, value);
        return setSafeHeader(res, name, String(prev) + ", " + String(value));
    }
    function addVary(res, field) {
        if (!field) return res;
        const prev = res.getHeader("Vary");
        if (!prev) return setSafeHeader(res, "Vary", field);
        const val = String(prev);
        const low = "," + val.toLowerCase() + ",";
        const f = String(field).toLowerCase();
        if (!low.includes("," + f + ",")) setSafeHeader(res, "Vary", val + ", " + field);
        return res;
    }

    function addCharsetIfNeeded(type) {
        const lower = String(type).toLowerCase();
        if (!/;\s*charset=/.test(lower) && (lower.startsWith("text/") || lower.includes("json") || lower.includes("+json") || lower.includes("xml") || lower === "application/javascript")) {
            return type + "; charset=utf-8";
        }
        return type;
    }
    function resolveType(extOrType) {
        if (!extOrType) return null;
        const raw = String(extOrType).trim();
        if (!raw) return null;
        if (ContentTypeMod && typeof ContentTypeMod.contentType === "function") {
            const t = ContentTypeMod.contentType(raw);
            if (t) return addCharsetIfNeeded(t);
        }
        if (raw.indexOf("/") === -1) {
            const ext = raw.replace(/^\./, "").toLowerCase();
            const t = MIME_TYPES[ext] || raw;
            return addCharsetIfNeeded(t);
        }
        return addCharsetIfNeeded(raw);
    }

    // ETag helpers
    function etagFromBuffer(buf, weak = true) {
        const hash = crypto.createHash("sha1").update(buf).digest("hex");
        const tag = `"${hash}-${buf.length}"`;
        return weak ? "W/" + tag : tag;
    }
    function etagFromStat(stat, weak = true) {
        const tag = `"${stat.size.toString(16)}-${Number(stat.mtimeMs | 0).toString(16)}"`;
        return weak ? "W/" + tag : tag;
    }

    // Accept negotiation (simple, suffix-aware)
    function parseAccept(accept) {
        if (!accept || accept === "*/*") return [{ type: "*/*", q: 1 }];
        return accept
            .split(",")
            .map((s) => {
                const [type, ...params] = s.trim().split(";");
                let q = 1;
                for (const p of params) {
                    const [k, v] = p.trim().split("=");
                    if (k === "q") q = parseFloat(v) || 0;
                }
                return { type: type.trim(), q };
            })
            .sort((a, b) => b.q - a.q);
    }
    function matchesOffer(offer, acceptType) {
        if (acceptType === "*/*") return true;
        if (offer === acceptType) return true;
        const [o1, o2] = offer.split("/");
        const [a1, a2] = acceptType.split("/");
        if ((a1 === "*" || a1 === o1) && (a2 === "*" || a2 === o2)) return true;
        // +json / +xml suffix handling
        if (acceptType.endsWith("+json") && (offer.endsWith("+json") || offer.endsWith("/json"))) return true;
        if (acceptType.endsWith("+xml") && (offer.endsWith("+xml") || offer.endsWith("/xml"))) return true;
        return false;
    }
    function negotiateAccept(accept, offers) {
        const accepted = parseAccept(accept);
        for (const a of accepted) {
            for (const off of offers) {
                let t = off.includes("/") ? off : resolveType(off) || off;
                t = t.split(";")[0]; // strip charset
                if (matchesOffer(t, a.type)) return off;
            }
        }
        return null;
    }

    // Cookie serialization (RFC-compliant; optional HMAC signing)
    function base64url(buf) {
        return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function serializeCookie(name, val, opts = {}) {
        if (!TOKEN_RE.test(name)) throw new Error(`Invalid cookie name: ${name}`);
        const value = typeof val === "string" ? val : JSON.stringify(val);
        let enc = encodeURIComponent(value);
        if (CTRL_RE.test(enc)) throw new Error("Invalid cookie value");
        if (opts.signed && opts.signed.secret) {
            const algo = opts.signed.algorithm || "sha256";
            const h = crypto.createHmac(algo, String(opts.signed.secret));
            h.update(enc);
            enc = "s:" + enc + "." + base64url(h.digest());
        }
        let str = `${name}=${enc}`;
        if (opts.maxAge != null) str += `; Max-Age=${Math.floor(opts.maxAge)}`;
        if (opts.expires instanceof Date) str += `; Expires=${opts.expires.toUTCString()}`;
        if (opts.domain) str += `; Domain=${opts.domain}`;
        str += `; Path=${opts.path || "/"}`;
        if (opts.secure === true) str += `; Secure`;
        if (opts.httpOnly === true) str += `; HttpOnly`;
        if (opts.partitioned === true) str += `; Partitioned`;
        if (opts.sameSite) {
            const s = String(opts.sameSite).toLowerCase();
            if (s === "lax" || s === "strict" || s === "none") str += `; SameSite=${s[0].toUpperCase()}${s.slice(1)}`;
        }
        if (opts.priority) {
            const p = String(opts.priority).toLowerCase();
            if (p === "low" || p === "medium" || p === "high") str += `; Priority=${p[0].toUpperCase() + p.slice(1)}`;
        }
        return str;
    }

    // Hooks & plugins (no-cost when unused)
    if (!response[K_HOOKS]) {
        response[K_HOOKS] = {
            beforeHeaders: [],
            afterHeaders: [],
            beforeBody: [],
            afterBody: [],
            beforeSend: [],
            afterSend: [],
            onFinish: [],
            onError: [],
        };
    }
    function emitHook(name, a, b) {
        const list = response[K_HOOKS] && response[K_HOOKS][name];
        if (!list || list.length === 0) return;
        for (const fn of list) {
            try {
                fn(response, a, b);
            } catch (e) {
                /* avoid userland hook crash */
            }
        }
    }
    if (typeof response.use !== "function") {
        response.use = (plugin, { namespace, order } = {}) => {
            const hooks = plugin && (plugin.hooks || plugin);
            if (!hooks) return response;
            for (const [k, fn] of Object.entries(hooks)) {
                if (response[K_HOOKS][k] && typeof fn === "function") response[K_HOOKS][k].push(fn);
            }
            return response;
        };
    }

    // Telemetry: bytes & duration (patch write/end once)
    if (response[K_BYTES] === undefined) {
        response[K_BYTES] = 0n;
        response[K_START_HR] = process.hrtime.bigint();
        const _write = response.write.bind(response);
        const _end = response.end.bind(response);
        response[K_ORIG_WRITE] = _write;
        response[K_ORIG_END] = _end;

        response.write = function (chunk, enc, cb) {
            if (chunk != null) {
                try {
                    response[K_BYTES] += BigInt(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, enc));
                } catch {}
            }
            return _write(chunk, enc, cb);
        };
        response.end = function (chunk, enc, cb) {
            if (chunk != null) {
                try {
                    response[K_BYTES] += BigInt(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, enc));
                } catch {}
            }
            // Add pending trailers just before ending
            try {
                if (response[K_TRAILER_PAIRS] && typeof response.addTrailers === "function") {
                    response.addTrailers(response[K_TRAILER_PAIRS]);
                }
            } catch (_) {
                /* ignore */
            }
            return _end(chunk, enc, cb);
        };

        response.once("finish", () => {
            const durationMs = Number((process.hrtime.bigint() - response[K_START_HR]) / 1000000n);
            emitHook("onFinish", { status: response.statusCode, bytes: Number(response[K_BYTES]), durationMs });
        });
    }
    if (typeof response.stats !== "function") {
        response.stats = () => ({ status: response.statusCode, headersSent: response.headersSent, bytes: Number(response[K_BYTES] || 0n) });
    }

    if (!response.hasOwnProperty("explain")) {
        response.explain = () => {
            return {
                status: response.statusCode,
                headersSent: response.headersSent,
                contentType: response.getHeader("Content-Type") || null,
                bytes: Number(response[K_BYTES] || 0n),
            };
        };
    }

    if (response[K_COMPRESS] === undefined) response[K_COMPRESS] = true; // allow compression by default

    // Attach the onStreamEvent method conditionally
    if (!response.hasOwnProperty("onStreamEvent")) {
        /**
         * Attaches an event listener function for the specified event on the response stream.
         * This is essentially a validated wrapper around the standard 'response.on()' method.
         * @param {string} event - The name of the event to listen for (e.g., 'finish', 'close').
         * @param {Function} callback - The listener function to call when the event is emitted.
         * @returns {http.ServerResponse} The response object itself, allowing for potential chaining.
         * @throws {TypeError} If the event name or callback is invalid.
         */
        response.onStreamEvent = (event, callback) => {
            const funcName = "response.onStreamEvent";
            // Using time/location context: Thursday, April 24, 2025 at 5:40:30 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Validate Inputs
            if (typeof event !== "string" || !event) {
                // Throw error because incorrect usage prevents desired outcome
                throw new TypeError(`${funcName} [Req:${reqIdShort}] requires a non-empty event name string.`);
            }
            if (typeof callback !== "function") {
                // Throw error because incorrect usage prevents desired outcome
                throw new TypeError(`${funcName} [Req:${reqIdShort}] requires a callback function for event "${event}".`);
            }

            // 2. Attach listener using the native method
            try {
                // console.log(`${logPrefix} [Req:${reqIdShort}] Attaching listener for response event: '${event}'`);
                response.on(event, callback);
            } catch (error) {
                // Extremely unlikely for .on() to throw, but good practice
                console.error(`${logPrefix} [Req:${reqIdShort}] Error attaching listener for event "${event}":`, error);
                throw error; // Re-throw unexpected errors
            }

            // 3. Return response object for chaining
            return response;
        };
    }
    // --- End of attachment logic ---

    // Headers API (Express-compatible)
    if (!response.hasOwnProperty("set")) {
        response.set = (name, value) => {
            setSafeHeader(response, name, value);
            return response;
        };
    }
    if (!response.hasOwnProperty("append")) {
        response.append = (name, value) => {
            appendSafeHeader(response, name, value);
            return response;
        };
    }
    if (!response.hasOwnProperty("get")) {
        response.get = (name) => response.getHeader(name);
    }
    if (!response.hasOwnProperty("vary")) {
        response.vary = (name) => {
            addVary(response, name);
            return response;
        };
    }
    if (!response.hasOwnProperty("location")) {
        response.location = (url) => {
            setSafeHeader(response, "Location", url);
            return response;
        };
    }
    if (!response.hasOwnProperty("sendStatus")) {
        response.sendStatus = (code) => {
            response.status(code);
            const msg = http.STATUS_CODES[code] || String(code);
            if (!response.getHeader("Content-Type")) response.setHeader("Content-Type", "text/plain; charset=utf-8");
            const buf = Buffer.from(msg, "utf8");
            response.setHeader("Content-Length", buf.length);
            response.writeHead(code);
            response.end(buf);
            return response;
        };
    }
    if (!response.hasOwnProperty("links")) {
        response.links = (linksObj) => {
            if (!linksObj) return response;
            const parts = [];
            for (const [rel, href] of Object.entries(linksObj)) parts.push(`<${href}>; rel="${rel}"`);
            appendSafeHeader(response, "Link", parts.join(", "));
            return response;
        };
    }
    if (!response.hasOwnProperty("redirect")) {
        response.redirect = (statusOrUrl, maybeUrl) => {
            const status = typeof statusOrUrl === "number" ? statusOrUrl : 302;
            const url = typeof statusOrUrl === "string" ? statusOrUrl : String(maybeUrl);
            response.status(status).location(url);
            const accept = (request && request.headers && request.headers.accept) || "";
            if (accept.includes("html")) {
                const esc = String(url).replace(/"/g, "&quot;");
                const html = `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=${esc}"></head><body>Redirecting to <a href="${esc}">${esc}</a>.</body></html>`;
                return response.html(html, status);
            }
            return response.text(String(url), status);
        };
    }

    // Content negotiation & types
    if (!response.hasOwnProperty("type")) {
        response.type = (extOrType) => {
            const c = resolveType(extOrType);
            if (c) setSafeHeader(response, "Content-Type", c);
            // Security: avoid MIME sniffing for potentially sniff-sensitive types
            const lc = String(response.getHeader("Content-Type") || "").toLowerCase();
            if (lc && (lc.includes("json") || lc.startsWith("text/") || lc.includes("javascript") || lc.includes("xml"))) {
                if (!response.getHeader("X-Content-Type-Options")) setSafeHeader(response, "X-Content-Type-Options", "nosniff");
            }

            return response;
        };
    }
    if (!response.hasOwnProperty("format")) {
        response.format = (map) => {
            addVary(response, "Accept");
            const accept = (request && request.headers && request.headers.accept) || "*/*";
            const keys = Object.keys(map || {});
            const offers = keys.filter((k) => k !== "default").map((k) => (k.includes("/") ? k : resolveType(k) || k));
            let chosen = null;

            if (ContentTypeMod && typeof ContentTypeMod.negotiate === "function") {
                try {
                    chosen = ContentTypeMod.negotiate(accept, offers) || null;
                } catch (_) {
                    /* fallback below */
                }
            }
            if (!chosen) chosen = negotiateAccept(accept, offers);

            if (!chosen) {
                if (typeof map.default === "function") return map.default();
                return response.notAcceptable({ acceptable: offers });
            }
            // normalize chosen key to the original handler key
            let key = keys.find((k) => k === chosen || (resolveType(k) || k).split(";")[0] === chosen);
            if (!key) key = chosen;
            response.type(chosen);
            const handler = map[key];
            if (typeof handler === "function") return handler();
            return response.sendStatus(406);
        };
    }
    if (!response.hasOwnProperty("is")) {
        response.is = (type) => {
            const ct = response.getHeader("Content-Type");
            if (!ct) return false;
            const want = resolveType(type);
            if (!want) return false;
            return String(ct).split(";")[0].trim().toLowerCase() === String(want).split(";")[0].trim().toLowerCase();
        };
    }

    // Attach the setStatus method conditionally
    if (!response.hasOwnProperty("status")) {
        /**
         * Sets the HTTP status code for the response using the standard 'statusCode' property.
         * Provides a chainable method similar to framework APIs.
         * @param {number} statusCode - The HTTP status code (e.g., 200, 404, 500).
         * Defaults to 200 if input is not a valid HTTP status number (100-599).
         * @returns {http.ServerResponse} The response object itself, allowing chaining.
         */
        response.status = (statusCode) => {
            const funcName = "response.status";
            // Using time/location context: Thursday, April 24, 2025 at 5:29:50 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Validate and set the standard statusCode property
            if (typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
                response.statusCode = statusCode; // Set the correct property
            } else {
                const currentStatus = response.statusCode || 200; // Use current or 200 as base
                console.warn(`${logPrefix} [Req:${reqIdShort}] Invalid statusCode (${statusCode}) provided. Keeping existing/default (${currentStatus}).`);
                // Ensure a default is set if statusCode wasn't already set
                if (!response.statusCode) response.statusCode = 200;
            }

            // 2. Return the response object for chaining
            return response;
        };
    }
    // --- End of attachment logic ---

    // Attach the setStatus method conditionally
    if (!response.hasOwnProperty("setStatus")) {
        /**
         * Sets the HTTP status code for the response using the standard 'statusCode' property.
         * Provides a chainable method similar to framework APIs.
         * @param {number} statusCode - The HTTP status code (e.g., 200, 404, 500).
         * Defaults to 200 if input is not a valid HTTP status number (100-599).
         * @returns {http.ServerResponse} The response object itself, allowing chaining.
         */
        response.setStatus = (statusCode) => {
            const funcName = "response.setStatus";
            // Using time/location context: Thursday, April 24, 2025 at 5:29:50 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Validate and set the standard statusCode property
            if (typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
                response.statusCode = statusCode; // Set the correct property
            } else {
                const currentStatus = response.statusCode || 200; // Use current or 200 as base
                console.warn(`${logPrefix} [Req:${reqIdShort}] Invalid statusCode (${statusCode}) provided. Keeping existing/default (${currentStatus}).`);
                // Ensure a default is set if statusCode wasn't already set
                if (!response.statusCode) response.statusCode = 200;
            }

            // 2. Return the response object for chaining
            return response;
        };
    }
    // Attach the core 'json' response helper method conditionally
    if (!response.hasOwnProperty("json")) {
        /**
         * Sends a JSON response. Sets appropriate headers, stringifies the data,
         * handles errors, and ends the response. Used by other status helpers.
         * @param {*} data - The payload to be JSON.stringified and sent.
         * @param {number} [status=200] - The HTTP status code for the response.
         * @throws {Error} If headers were already sent or sending fails critically.
         */
        response.json = (data, status = HTTP_STATUS_OK_DEFAULT) => {
            const funcName = "response.json";
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            if (response.headersSent || response.writableEnded) {
                console.warn(`[${funcName}] [Req:${reqIdShort}] Headers already sent or stream ended.`);
                return;
            }

            let bodyString;
            let responseStatus = status;

            try {
                const isSuccess = responseStatus >= 200 && responseStatus < 400;
                const payload = isSuccess ? { success: true, data } : { success: false, error: data ?? "Error" };
                bodyString = JSON.stringify(payload);
            } catch (e) {
                console.error(`[${funcName}] [Req:${reqIdShort}] JSON.stringify failed:`, e);
                responseStatus = HTTP_STATUS_INTERNAL_SERVER_ERROR_CODE;
                bodyString = GENERIC_ERROR_JSON_BODY;
                setSafeHeader(response, "Cache-Control", "no-cache, no-store, must-revalidate");
                setSafeHeader(response, "Pragma", "no-cache");
                setSafeHeader(response, "Expires", "0");
            }

            const buf = Buffer.from(bodyString, "utf8");

            try {
                emitHook("beforeHeaders", response);
                if (!response.getHeader("Content-Type")) setSafeHeader(response, "Content-Type", CONTENT_TYPE_JSON_UTF8);
                setSafeHeader(response, "Content-Length", buf.length);
                emitHook("afterHeaders", response);

                emitHook("beforeBody", { kind: "json", size: buf.length });
                response.writeHead(responseStatus);
                response.end(buf);
                emitHook("afterBody", { kind: "json", size: buf.length });
                emitHook("afterSend", { kind: "json" });
            } catch (err) {
                emitHook("onError", err);
                console.error(`[${funcName}] [Req:${reqIdShort}] Error sending JSON:`, err);
                if (!response.writableEnded) response.destroy(err);
                throw err;
            }
        };

       
    }
    // --- End of attachment logic ---

    if (!response.hasOwnProperty("setCompress")) {
        /**
         * Coordinates compression with upstream middleware. Pass false to disable compression
         * for this response (avoids double-compress).
         */
        response.setCompress = (on = true) => {
            response[K_COMPRESS] = !!on;
            return response;
        };
    }

    // Attach the getCompressionMethod method conditionally
    if (!response.hasOwnProperty("getCompressionMethod")) {
        /**
         * Determines the best supported compression method (Brotli > Gzip) based on
         * the request's 'Accept-Encoding' header and server capabilities.
         * Creates and returns the appropriate compression stream instance.
         * NOTE: Simplifies negotiation by ignoring q-factors and preferring 'br' if available & accepted.
         * @returns {{stream: zlib.BrotliCompress | zlib.Gzip, encoding: 'br' | 'gzip'} | null}
         * An object with the stream and encoding name, or null if no supported encoding is accepted.
         */
        response.getCompressionMethod = () => {
            const encHeader = (request && request.headers && request.headers["accept-encoding"]) || "";
            if (response.getHeader("Content-Encoding")) return null; // already encoded upstream
            if (response[K_COMPRESS] === false) return null; // compression disabled by coordination
            // Prefer Brotli if supported by server & accepted by client
            if (IS_BROTLI_SUPPORTED_SERVER && REGEX_BROTLI_ACCEPT.test(encHeader)) {
                try {
                    return { stream: zlib.createBrotliCompress(), encoding: ENCODING_TYPE_BROTLI };
                } catch {}
            }
            if (REGEX_GZIP_ACCEPT.test(encHeader)) {
                try {
                    return { stream: zlib.createGzip(), encoding: ENCODING_TYPE_GZIP };
                } catch {}
            }
            return null;
        };


    }

    // Attach the async jsonStream method conditionally
    if (!response.hasOwnProperty("jsonStream")) {
        /**
         * Asynchronously streams an array of JSON objects from an AsyncIterable.
         * Handles compression (br/gzip) based on Accept-Encoding.
         * Writes a streaming JSON array: '[' item1 ',' item2 ... ']'.
         * @param {AsyncIterable<object> | AsyncGenerator<object>} dataGenerator - Source yielding JSON-serializable objects.
         * @param {number} [status=200] - HTTP status code.
         * @returns {Promise<void>} Resolves on completion, rejects on error.
         * @throws {Error} If prerequisites missing, headers sent, generator/stringify/stream errors occur.
         */
        response.jsonStream = async (dataGenerator, status = 200) => {
            const funcName = "response.jsonStream";
            // Using time/location context: Thursday, April 24, 2025 at 6:35:16 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Validate Inputs & Prerequisites
            if (!dataGenerator || typeof dataGenerator[Symbol.asyncIterator] !== "function") {
                throw new TypeError(`${funcName} requires an async iterable/generator.`);
            }
            if (typeof response.getCompressionMethod !== "function") {
                throw new Error(`${funcName} requires 'response.getCompressionMethod'.`);
            }
            if (response.headersSent || response.writableEnded) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Cannot start JSON stream: Headers already sent or stream ended.`);
                throw new Error("Headers already sent or stream ended.");
            }

            // 2. Determine Compression & Set Headers
            const compressionInfo = response.getCompressionMethod(); // {stream, encoding} or null
            let targetStream = response; // Final destination for data stream

            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-cache");
            response.setHeader("Connection", "keep-alive");
            if (compressionInfo) {
                response.setHeader("Content-Encoding", compressionInfo.encoding);
                response.setHeader("Vary", "Accept-Encoding");
                targetStream = compressionInfo.stream; // Write JSON parts INTO the compressor
            }
            // No Content-Length for streams

            // 3. Write Status Code (BEFORE any body/piping)
            response.writeHead(status);
            console.log(`${logPrefix} [Req:${reqIdShort}] Starting JSON array stream. Status: ${status}, Encoding: ${compressionInfo?.encoding || "none"}`);

            // 4. Set up piping: Compressor (if used) -> Response
            let pipelinePromise = null;
            if (compressionInfo) {
                // Important: Pipe the compressor's output to the actual response
                // Use pipeline for error handling, run in background (don't await yet)
                pipelinePromise = streamPipeline(targetStream, response).catch((err) => {
                    console.error(`${logPrefix} [Req:${reqIdShort}] Error in compression pipeline to response:`, err);
                    // Don't re-throw here, let the main try/catch handle generator/write errors
                    // Ensure response is destroyed if pipeline fails
                    if (!response.writableEnded) response.destroy(err);
                    throw err; // Re-throw needed to reject the main function's promise
                });
            }

            // 5. Write the stream content manually to the targetStream (compressor or response)
            let firstItem = true;
            try {
                // Write opening bracket
                if (!targetStream.writableEnded) targetStream.write("[");

                // Iterate and write data
                for await (const item of dataGenerator) {
                    if (targetStream.writableEnded) break; // Stop if stream closed early

                    let itemString;
                    try {
                        itemString = JSON.stringify(item);
                    } catch (stringifyError) {
                        // Log error, potentially write an error marker (carefully!)
                        console.error(`${logPrefix} [Req:${reqIdShort}] Skipping item due to stringify error:`, stringifyError);
                        // Write placeholder error? Be cautious about breaking JSON structure.
                        // targetStream.write(firstItem ? '"stringify_error"' : ',"stringify_error"');
                        // firstItem = false;
                        continue; // Skip invalid item
                    }

                    // Write comma separator then item
                    targetStream.write(firstItem ? itemString : "," + itemString);
                    firstItem = false;
                }

                // Write closing bracket if we started writing items (or if generator was empty)
                if (!targetStream.writableEnded) targetStream.write("]");

                // End the target stream (signals compressor to finish, or ends response directly)
                if (!targetStream.writableEnded) targetStream.end();

                console.log(`${logPrefix} [Req:${reqIdShort}] Generator finished. Stream ended.`);

                // If we had a compression pipeline, wait for it to finish now
                if (pipelinePromise) {
                    await pipelinePromise;
                    console.log(`${logPrefix} [Req:${reqIdShort}] Compression pipeline finished.`);
                }
            } catch (error) {
                // Catches errors from the generator or potentially stream write errors
                console.error(`${logPrefix} [Req:${reqIdShort}] Error during JSON stream generation:`, error);
                // Ensure target stream is destroyed on error
                if (!targetStream.writableEnded) {
                    targetStream.destroy(error); // This should propagate to pipeline if applicable
                }
                // Re-throw the error to reject the main promise
                throw error;
            }
        };
    }

    // Attach the 'notAcceptable' response helper method conditionally
    if (!response.hasOwnProperty("notAcceptable")) {
        /**
         * Sends a 406 Not Acceptable JSON response with a standard error structure.
         * Used when the server cannot generate a response matching the client's Accept* headers.
         * Typically called after content negotiation (e.g., request.format) fails.
         * A shortcut using the response.json() helper method.
         * @param {*} [errorInfo="Not Acceptable"] - Optional payload describing the negotiation failure.
         * @throws {Error} If the required response.json method is not found, or if headers were already sent.
         */
        response.notAcceptable = (errorInfo = "Not Acceptable") => {
            // Default error message
            const funcName = "response.notAcceptable";
            // Using time/location context: Thursday, April 24, 2025 at 5:21:15 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Check if response already started
            if (response.headersSent || response.writableEnded) {
                console.warn(`${logPrefix} [Req:${reqIdShort}] Cannot send Not Acceptable response: Headers already sent or stream ended.`);
                return;
            }

            // 2. Check for prerequisite helper 'response.json'
            if (typeof response.json !== "function") {
                const error = new Error(`Helper 'response.json' is required by '${funcName}' but is not attached.`);
                console.error(`${logPrefix} [Req:${reqIdShort}] ${error.message}`);
                throw error; // Setup problem
            }

            // 3. Construct standard error payload
            const errorPayload = {
                success: false,
                error: errorInfo, // Include the specific error info/message
                // Consider adding acceptable types if known, e.g., from request.format failure
                // acceptable: errorInfo?.acceptable || undefined
            };

            // 4. Delegate to response.json with status 406
            try {
                console.warn(`${logPrefix} [Req:${reqIdShort}] Sending 406 Not Acceptable JSON response:`, errorInfo); // Log warning for negotiation failure
                response.json(errorPayload, 406); // Use the json helper with 406 status
            } catch (error) {
                // Catch immediate errors from calling json (though refined json handles internal errors)
                console.error(`${logPrefix} [Req:${reqIdShort}] Unexpected error calling response.json:`, error);
                if (!response.writableEnded) {
                    response.destroy(error);
                }
                // Optional: re-throw
            }
        };
    }

    // --- Requires Buffer at TOP of module ---
    // (Using the Buffer import declared at the top of the module)
    // ----------------------------------------

    // --- Place this INSIDE module.exports = (response, request /*, socket */) => { ... } ---

    // Attach the 'send' method conditionally (Recommended Robust Version)
    if (!response.hasOwnProperty("send")) {
        /**
         * Sends the response payload, automatically setting appropriate
         * Content-Type and Content-Length headers based on the payload type.
         * Handles Buffers, Strings, and JSON-serializable data (Objects, Arrays, null, etc.).
         * Ends the response stream. Use only once per request-response cycle.
         *
         * NOTE: Does NOT handle streaming Readable streams directly (use response.stream or response.range for files).
         *
         * @param {*} payload - The data to send (string, Buffer, object, array, null, boolean, number).
         * @param {number} [statusCode] - Optional HTTP status code (defaults to response.statusCode if already set, otherwise 200).
         * @throws {Error} If headers were already sent or if critical errors occur during payload preparation or sending.
         */
        response.send = (payload, statusCode) => {
            const funcName = "response.send";
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            if (response.headersSent || response.writableEnded) {
                console.warn(`[${funcName}] [Req:${reqIdShort}] Headers already sent or stream ended.`);
                throw new Error("Cannot send response: Headers already sent or stream ended.");
            }

            let finalBuffer;
            let finalContentType = response.getHeader("content-type");

            try {
                if (Buffer.isBuffer(payload)) {
                    finalBuffer = payload;
                    if (!finalContentType) finalContentType = "application/octet-stream";
                } else if (typeof payload === "string") {
                    finalBuffer = Buffer.from(payload, "utf8");
                    if (!finalContentType) finalContentType = "text/html; charset=utf-8";
                } else {
                    const json = JSON.stringify(payload);
                    finalBuffer = Buffer.from(json, "utf8");
                    if (!finalContentType || String(finalContentType).includes("json")) {
                        finalContentType = "application/json; charset=utf-8";
                    }
                }
            } catch (prepError) {
                console.error(`[${funcName}] [Req:${reqIdShort}] Error preparing payload:`, prepError);
                if (!response.headersSent) {
                    setSafeHeader(response, "Content-Type", "application/json; charset=utf-8");
                    const errBuf = Buffer.from('{"success":false,"error":"Internal Server Error preparing response payload."}', "utf8");
                    setSafeHeader(response, "Content-Length", errBuf.length);
                    response.writeHead(500);
                    response.end(errBuf);
                } else {
                    response.destroy(prepError);
                }
                throw new Error(`Failed to prepare response payload: ${prepError.message}`);
            }

            try {
                emitHook("beforeHeaders", response);
                if (!response.getHeader("content-type") && finalContentType) setSafeHeader(response, "Content-Type", finalContentType);
                setSafeHeader(response, "Content-Length", finalBuffer.length);
                emitHook("afterHeaders", response);

                emitHook("beforeBody", { kind: "send", size: finalBuffer.length });
                const finalStatus = statusCode ?? response.statusCode ?? 200;
                response.writeHead(finalStatus);
                response.end(finalBuffer);
                emitHook("afterBody", { kind: "send", size: finalBuffer.length });
                emitHook("afterSend", { kind: "send" });
            } catch (sendError) {
                emitHook("onError", sendError);
                console.error(`[${funcName}] [Req:${reqIdShort}] Error writing final response:`, sendError);
                if (!response.writableEnded) response.destroy(sendError);
                throw sendError;
            }
        };

  
    }
    // --- End of attachment logic ---

    //   // Attach the 'send' method conditionally (Recommended Robust Version)
    //   if (!response.hasOwnProperty("send")) {
    //     /**
    //      * Sends the response payload, automatically setting Content-Type and Content-Length.
    //      * - Buffers are sent directly (default Content-Type: application/octet-stream).
    //      * - Strings are sent directly (default Content-Type: text/html; charset=utf-8).
    //      * - Objects/Arrays/null are JSON.stringified (Content-Type: application/json).
    //      * - Sets statusCode if not already set (defaults to 200). Ends the response.
    //      * NOTE: Does NOT handle file streaming. Use response.range() for that.
    //      * @param {*} payload - The data to send (string, Buffer, object, array, null).
    //      * @param {number} [statusCode] - Optional HTTP status code (defaults to response.statusCode or 200).
    //      */
    //     response.send = (payload, statusCode) => {
    //         const funcName = "response.send";
    //         // Using time/location context: Thursday, April 24, 2025 at 6:07:26 PM MDT in Salt Lake City, Utah
    //         const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
    //         const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

    //         if (response.headersSent || response.writableEnded) {
    //             console.warn(`${logPrefix} [Req:${reqIdShort}] Cannot send response: Headers already sent or stream ended.`);
    //             return;
    //         }

    //         let finalBuffer;
    //         let finalContentType = response.getHeader("content-type"); // Respect if already set

    //         // 1. Determine payload type and prepare final Buffer
    //         try {
    //             if (Buffer.isBuffer(payload)) {
    //                 finalBuffer = payload;
    //                 if (!finalContentType) finalContentType = "application/octet-stream";
    //             } else if (typeof payload === "string") {
    //                 finalBuffer = Buffer.from(payload, "utf8");
    //                 if (!finalContentType) finalContentType = "text/html; charset=utf-8"; // Default string to HTML
    //             } else {
    //                 // Assume JSON for others
    //                 const jsonString = JSON.stringify(payload); // Can throw
    //                 finalBuffer = Buffer.from(jsonString, "utf8");
    //                 if (!finalContentType || finalContentType.includes("json")) {
    //                     finalContentType = "application/json; charset=utf-8";
    //                 }
    //             }
    //         } catch (error) {
    //             console.error(`${logPrefix} [Req:${reqIdShort}] Error preparing payload:`, error);
    //             if (!response.headersSent) {
    //                 response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    //                 response.end('{"success":false,"error":"Internal Server Error preparing response payload."}');
    //             } else {
    //                 response.destroy(error);
    //             }
    //             return;
    //         }

    //         // Ensure final payload is buffer (already done above)
    //         if (!Buffer.isBuffer(finalBuffer)) {
    //             /* Redundant check now */
    //         }

    //         // 2. Set Headers and Send Response
    //         try {
    //             if (!response.getHeader("content-type") && finalContentType) {
    //                 response.setHeader("Content-Type", finalContentType);
    //             }
    //             response.setHeader("Content-Length", finalBuffer.length);
    //             const finalStatus = statusCode ?? response.statusCode ?? 200;

    //             response.writeHead(finalStatus);
    //             response.end(finalBuffer);
    //             console.log(`${logPrefix} [Req:${reqIdShort}] Response sent. Status: ${finalStatus}, Type: ${response.getHeader("content-type")}, Size: ${finalBuffer.length} bytes.`);
    //         } catch (sendError) {
    //             console.error(`${logPrefix} [Req:${reqIdShort}] Error writing final response:`, sendError);
    //             if (!response.writableEnded) {
    //                 response.destroy(sendError);
    //             }
    //         }
    //     };
    // }
    // Attach the async streamFile method conditionally
    if (!response.hasOwnProperty("streamFile")) {
        /**
         * Asynchronously streams a file to the response, automatically applying
         * compression (gzip/brotli) if supported by the client.
         * Sets Content-Type (attempts lookup), Accept-Ranges, and Content-Encoding/Length appropriately.
         * Uses stream.pipeline for robust transfer and error handling.
         * NOTE: Does not set Content-Disposition (use response.downloadFile for attachments).
         * @param {string} filePath - The absolute path to the file to stream.
         * @param {object} [options={}] - Optional settings.
         * @param {string} [options.contentType] - Explicit Content-Type. If not set, attempts lookup.
         * @param {number} [options.highWaterMark=DEFAULT_STREAM_CHUNK_SIZE] - Read stream buffer size.
         * @param {number} [options.status=200] - HTTP status code.
         * @returns {Promise<void>} A promise that resolves on success or rejects on error.
         * @throws {Error} If file not found/inaccessible, headers already sent, helper methods missing, or pipeline fails.
         */
        response.streamFile = async (filePath, options = {}) => {
            const funcName = "response.streamFile";
            // Using time/location context: Thursday, April 24, 2025 at 6:40:51 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Check prerequisites and response state
            if (typeof response.getCompressionMethod !== "function") {
                throw new Error(`${funcName} requires 'response.getCompressionMethod' to be attached.`);
            }
            if (response.headersSent || response.writableEnded) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Cannot stream file: Headers already sent or stream ended.`);
                throw new Error("Headers already sent or stream ended, cannot initiate file stream.");
            }
            if (!filePath || typeof filePath !== "string") {
                throw new TypeError(`${funcName} requires a valid filePath string.`);
            }

            let fileStat;
            // 2. Get File Stats asynchronously
            try {
                fileStat = await fsp.stat(filePath);
                if (!fileStat.isFile()) throw new Error(`Path is not a file: "${filePath}"`);
            } catch (statError) {
                console.error(`${logPrefix} [Req:${reqIdShort}] File error "${filePath}":`, statError.code === "ENOENT" ? "Not Found" : statError.message);
                if (!response.headersSent) {
                    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                    response.end("Not Found");
                } else {
                    response.destroy(statError);
                }
                // Re-throw so caller knows stat failed
                throw new Error(`File not found or inaccessible: ${filePath}`);
            }

            // 3. Determine Headers and Compression
            const contentType = options.contentType || (lookupMimeType && lookupMimeType(filePath)) || "application/octet-stream";
            const compressionInfo = response.getCompressionMethod(); // {stream, encoding} or null
            const status = options.status || 200;
            const readStreamOptions = { highWaterMark: options.highWaterMark || DEFAULT_STREAM_CHUNK_SIZE };

            response.setHeader("Content-Type", contentType);
            response.setHeader("Accept-Ranges", "bytes"); // Good practice even if not handling ranges here

            if (compressionInfo) {
                response.setHeader("Content-Encoding", compressionInfo.encoding);
                response.setHeader("Vary", "Accept-Encoding");
                // Cannot set Content-Length when compressing via stream
            } else {
                // Set Content-Length only for uncompressed transfer
                response.setHeader("Content-Length", fileStat.size);
            }

            // 4. Create Read Stream
            const fileStream = fs.createReadStream(filePath, readStreamOptions);

            // 5. Write Headers and Execute Pipeline
            console.log(`${logPrefix} [Req:${reqIdShort}] Starting file stream for "${path.basename(filePath)}" (Type: ${contentType}, Size: ${fileStat.size}, Encoding: ${compressionInfo?.encoding || "none"})...`);
            response.writeHead(status); // Write status and collected headers

            try {
                if (compressionInfo) {
                    // Pipe: File -> Compressor -> Response
                    await streamPipeline(fileStream, compressionInfo.stream, response);
                } else {
                    // Pipe: File -> Response
                    await streamPipeline(fileStream, response);
                }
                console.log(`${logPrefix} [Req:${reqIdShort}] File stream finished successfully for "${path.basename(filePath)}".`);
            } catch (pipeError) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Error piping file stream for "${path.basename(filePath)}":`, pipeError);
                // Pipeline handles stream cleanup. Ensure response is closed if possible.
                if (!response.writableEnded) {
                    response.destroy(pipeError);
                }
                // Re-throw error to indicate failure
                throw pipeError;
            }
        };
    }

    function parseRangeHeader(range, size) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || ""));
        if (!m) return null;
        let start = m[1] === "" ? null : Number(m[1]);
        let end = m[2] === "" ? null : Number(m[2]);
        if (start === null && end === null) return null;
        if (start !== null && end !== null && start > end) return null;
        if (start === null) {
            // suffix bytes
            const n = end;
            if (!Number.isFinite(n) || n <= 0) return null;
            start = Math.max(0, size - n);
            end = size - 1;
        } else {
            if (end === null || end >= size) end = size - 1;
        }
        if (start < 0 || start >= size) return null;
        return { start, end };
    }
    function safeJoin(root, p) {
        const full = path.resolve(root ? path.join(root, p) : p);
        if (root) {
            const base = path.resolve(root);
            if (full !== base && !full.startsWith(base + path.sep)) throw new Error("Path traversal");
        }
        return full;
    }
    function contentDispositionAttachment(filename) {
        if (!filename) return "attachment";
        const fallback = filename.replace(/[/\\"]/g, "_");
        // RFC 5987 extended filename*
        const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
        return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
    }

    if (!response.hasOwnProperty("attachment")) {
        response.attachment = (filename) => {
            setSafeHeader(response, "Content-Disposition", contentDispositionAttachment(filename));
            if (filename && !response.getHeader("Content-Type")) response.type(path.extname(filename).slice(1));
            return response;
        };
    }
    if (!response.hasOwnProperty("download")) {
        response.download = (filePath, filename, opts = {}) => {
            response.attachment(filename || path.basename(filePath));
            return response.sendFile(filePath, opts);
        };
    }
    if (!response.hasOwnProperty("sendFile")) {
        /**
         * sendFile with range (single range), validators, HEAD support, and compression (only when not ranged).
         */
        response.sendFile = async (filePath, opts = {}) => {
            const { root, dotfiles = "deny", cacheControl, headers, signal, immutable, maxAge, acceptRanges = true } = opts;
            const abs = safeJoin(root, filePath);
            if (dotfiles === "deny" && path.basename(abs).startsWith(".")) {
                return response.sendStatus(404);
            }
            let stat;
            try {
                stat = await fsp.stat(abs);
                if (!stat.isFile()) throw new Error("Not a file");
            } catch (err) {
                if (!response.headersSent) response.sendStatus(404);
                else response.destroy(err);
                return;
            }

            // Validators
            const etag = etagFromStat(stat, true);
            const lastMod = stat.mtime.toUTCString();
            setSafeHeader(response, "ETag", etag);
            setSafeHeader(response, "Last-Modified", lastMod);
            if (cacheControl) response.cacheControl(cacheControl);
            if (immutable) appendSafeHeader(response, "Cache-Control", "immutable");
            if (maxAge != null) appendSafeHeader(response, "Cache-Control", `max-age=${Math.floor(maxAge)}`);
            if (headers && typeof headers === "object") for (const [k, v] of Object.entries(headers)) setSafeHeader(response, k, v);

            // Freshness (If-None-Match / If-Modified-Since)
            const inm = request && request.headers && request.headers["if-none-match"];
            const ims = request && request.headers && request.headers["if-modified-since"];
            const method = (request && request.method) || "GET";
            const safeMethod = method === "GET" || method === "HEAD";
            let fresh = false;
            if (
                inm &&
                inm
                    .split(",")
                    .map((s) => s.trim())
                    .includes(etag)
            )
                fresh = true;
            if (!fresh && ims) {
                const t = Date.parse(ims);
                if (!isNaN(t) && Math.floor(stat.mtimeMs) <= t) fresh = true;
            }
            if (fresh && safeMethod) {
                return response.notModified();
            }

            // Type
            if (!response.getHeader("Content-Type")) setSafeHeader(response, "Content-Type", lookupMimeType(abs));

            // Ranges
            let range = null;
            if (acceptRanges) {
                setSafeHeader(response, "Accept-Ranges", "bytes");
                range = parseRangeHeader(request && request.headers && request.headers.range, stat.size);
            }
            if (range) {
                const { start, end } = range;
                setSafeHeader(response, "Content-Range", `bytes ${start}-${end}/${stat.size}`);
                const chunkSize = end - start + 1;
                setSafeHeader(response, "Content-Length", chunkSize);
                response.status(206);
                response.writeHead(206);
                const stream = fs.createReadStream(abs, { start, end, highWaterMark: DEFAULT_STREAM_CHUNK_SIZE });
                if (method === "HEAD") {
                    stream.destroy();
                    return response.end();
                }
                try {
                    await streamPipeline(stream, response);
                    emitHook("afterSend", { kind: "file", ranged: true, size: chunkSize });
                } catch (err) {
                    emitHook("onError", err);
                    if (!response.writableEnded) response.destroy(err);
                }
                return;
            }

            // No range: may compress
            const comp = response.getCompressionMethod();
            if (comp) {
                setSafeHeader(response, "Content-Encoding", comp.encoding);
                addVary(response, "Accept-Encoding");
            } else setSafeHeader(response, "Content-Length", stat.size);

            response.writeHead(response.statusCode || 200);
            if (method === "HEAD") {
                return response.end();
            }

            const stream = fs.createReadStream(abs, { highWaterMark: DEFAULT_STREAM_CHUNK_SIZE });
            try {
                if (comp) await streamPipeline(stream, comp.stream, response);
                else await streamPipeline(stream, response);
                emitHook("afterSend", { kind: "file", ranged: false, size: stat.size });
            } catch (err) {
                emitHook("onError", err);
                if (!response.writableEnded) response.destroy(err);
            }
        };
    }

    // Attach the 'setRequestId' response header helper method conditionally
    if (!response.hasOwnProperty("setRequestId")) {
        /**
         * Sets the 'X-Request-ID' header on the response, using the ID already
         * associated with the incoming request (retrieved via request.getId()).
         * Ensures the same ID is used for tracing request/response.
         * @returns {string | null} The request ID that was set, or null if no ID was found or headers were sent.
         */
        response.setRequestId = () => {
            const funcName = "response.setRequestId";
            // Using time/location context: Thursday, April 24, 2025 at 8:00:41 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            // Use existing ID for logging context if possible
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Check if response already started
            if (response.headersSent || response.writableEnded) {
                console.warn(`${logPrefix} [Req:${reqIdShort}] Cannot set X-Request-ID header: Headers already sent or stream ended.`);
                return request._requestId || null; // Return existing ID if possible, even if not set now
            }

            let requestId = null;
            // 2. Get the existing request ID using the request helper
            if (typeof request.getId === "function") {
                try {
                    // Assumes getId() retrieves existing or generates+caches if needed
                    requestId = request.getId();
                } catch (error) {
                    console.error(`${logPrefix} [Req:${reqIdShort}] Error calling request.getId():`, error);
                }
            } else {
                // Fallback: maybe check request._requestId directly if getId isn't attached
                requestId = request._requestId || null;
                if (!requestId) {
                    console.warn(`${logPrefix} [Req:${reqIdShort}] Could not retrieve request ID (request.getId missing?). Cannot set X-Request-ID header.`);
                }
            }

            // 3. Set the header if an ID was successfully obtained
            if (requestId && typeof requestId === "string") {
                try {
                    // console.log(`${logPrefix} [Req:${reqIdShort}] Setting X-Request-ID response header to: ${requestId}`);
                    response.setHeader("X-Request-ID", requestId);
                    return requestId; // Return the ID that was set
                } catch (error) {
                    console.error(`${logPrefix} [Req:${reqIdShort}] Error setting X-Request-ID header:`, error);
                    // Fall through to return null
                }
            } else {
                console.warn(`${logPrefix} [Req:${reqIdShort}] No valid request ID retrieved. X-Request-ID header not set.`);
            }

            // 4. Return null if ID wasn't retrieved or header couldn't be set
            return null;
        };
    }

    // Attach the 'html' response helper method conditionally
    if (!response.hasOwnProperty("html")) {
        /**
         * Sends an HTML response string.
         * Sets Content-Type to text/html; charset=utf-8, calculates Content-Length,
         * and ends the response.
         * @param {string} htmlString - The HTML content string to send.
         * @param {number} [status=200] - Optional HTTP status code.
         * @throws {TypeError} If htmlString is not a string.
         * @throws {Error} If headers were already sent or sending fails.
         */
        response.html = (htmlString, status = 200) => {
            const funcName = "response.html";
            // Using time/location context: Thursday, April 24, 2025 at 10:17:51 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Validate input is a string
            if (typeof htmlString !== "string") {
                throw new TypeError(`${funcName} requires the html payload to be a string. Received ${typeof htmlString}`);
            }

            // 2. Check if response already started
            if (response.headersSent || response.writableEnded) {
                console.warn(`${logPrefix} [Req:${reqIdShort}] Cannot send HTML response: Headers already sent or stream ended.`);
                // Throw error because caller expectation is violated if headers sent
                throw new Error("Headers already sent or stream ended.");
            }

            // 3. Prepare payload as UTF-8 Buffer
            let payloadBuffer;
            try {
                // Use Buffer.from for accurate byte length calculation
                payloadBuffer = Buffer.from(htmlString, "utf8");
            } catch (error) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Error creating buffer from HTML string:`, error);
                if (!response.headersSent) {
                    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                    response.end("Internal Server Error preparing HTML response.");
                } else {
                    response.destroy(error);
                }
                throw new Error(`Failed to prepare HTML payload buffer: ${error.message}`);
            }

            // 4. Set Headers and Send Response
            try {
                // Set headers IF NOT already set by caller (allow override)
                if (!response.getHeader("Content-Type")) {
                    response.setHeader("Content-Type", "text/html; charset=utf-8");
                }
                response.setHeader("Content-Length", payloadBuffer.length);

                // Use provided status or existing response status or default 200
                const finalStatus = status ?? response.statusCode ?? 200;

                response.writeHead(finalStatus);
                response.end(payloadBuffer); // Send buffer

                // console.log(`${logPrefix} [Req:${reqIdShort}] Sent HTML response. Status: ${finalStatus}, Size: ${payloadBuffer.length} bytes.`);
            } catch (sendError) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Error sending HTML response:`, sendError);
                if (!response.writableEnded) {
                    response.destroy(sendError);
                }
                throw sendError; // Re-throw
            }
        };
    }

    // Attach the 'text' response helper method conditionally
    if (!response.hasOwnProperty("text")) {
        /**
         * Sends a plain text response.
         * Sets Content-Type to text/plain;charset=utf-8, calculates Content-Length, and ends the response.
         * Converts non-string payloads to strings using String().
         * @param {*} payload - The data to send as plain text. Will be converted to string.
         * @param {number} [status=200] - Optional HTTP status code.
         * @throws {Error} If headers were already sent or sending fails.
         */
        response.text = (payload, status = 200) => {
            const funcName = "response.text";
            // Using time/location context: Thursday, April 24, 2025 at 10:16:13 PM MDT in Salt Lake City, Utah
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT/SLC
            const reqIdShort = request?._requestId?.substring(0, 8) ?? "N/A";

            // 1. Check if response already started
            if (response.headersSent || response.writableEnded) {
                console.warn(`${logPrefix} [Req:${reqIdShort}] Cannot send text response: Headers already sent or stream ended.`);
                return;
            }

            // 2. Prepare payload as UTF-8 Buffer
            let payloadBuffer;
            try {
                // Convert payload to string safely (handles null, undefined, numbers etc.), then buffer
                const payloadString = String(payload ?? ""); // Default null/undefined to empty string
                payloadBuffer = Buffer.from(payloadString, "utf8");
            } catch (error) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Error preparing text payload:`, error);
                if (!response.headersSent) {
                    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                    response.end("Internal Server Error preparing text response.");
                } else {
                    response.destroy(error);
                }
                throw new Error(`Failed to prepare text payload: ${error.message}`);
            }

            // 3. Set Headers and Send Response
            try {
                // Set headers IF NOT already set by caller
                if (!response.getHeader("Content-Type")) {
                    response.setHeader("Content-Type", "text/plain; charset=utf-8");
                }
                response.setHeader("Content-Length", payloadBuffer.length);

                // Use provided status or existing response status or default 200
                const finalStatus = status ?? response.statusCode ?? 200;

                response.writeHead(finalStatus);
                response.end(payloadBuffer); // Send buffer
            } catch (sendError) {
                console.error(`${logPrefix} [Req:${reqIdShort}] Error sending text response:`, sendError);
                if (!response.writableEnded) {
                    response.destroy(sendError);
                }
                throw sendError; // Re-throw
            }
        };
    }

    if (!response.hasOwnProperty("buffer")) {
        response.buffer = (buf, type) => {
            if (!Buffer.isBuffer(buf)) throw new TypeError("res.buffer(buf) requires a Buffer");
            if (type) response.type(type);
            response.setHeader("Content-Length", buf.length);
            response.writeHead(response.statusCode || 200);
            response.end(buf);
            return response;
        };
    }
    if (!response.hasOwnProperty("noContent")) {
        response.noContent = () => {
            response.status(204);
            // RFC: 204 MUST NOT include a message-body
            response.removeHeader("Content-Type");
            response.removeHeader("Content-Length");
            response.end();
            return response;
        };
    }

    if (!response.hasOwnProperty("earlyHints")) {
        response.earlyHints = (headersOrLinks) => {
            try {
                if (typeof response.writeEarlyHints === "function") {
                    const hints = Array.isArray(headersOrLinks) ? Object.fromEntries(headersOrLinks) : headersOrLinks || {};
                    response.writeEarlyHints(hints);
                }
            } catch (_) {
                /* noop on unsupported */
            }
            return response;
        };
    }
    if (!response.hasOwnProperty("trailer")) {
        response.trailer = (name, value) => {
            // Must announce trailer names before headers are flushed
            response[K_TRAILER_NAMES] = response[K_TRAILER_NAMES] || new Set();
            response[K_TRAILER_PAIRS] = response[K_TRAILER_PAIRS] || {};
            response[K_TRAILER_NAMES].add(name);
            response[K_TRAILER_PAIRS][name] = String(value);
            const list = Array.from(response[K_TRAILER_NAMES]).join(", ");
            if (!response.headersSent) setSafeHeader(response, "Trailer", list);
            return response;
        };
    }

    if (!response.hasOwnProperty("stream")) {
        /**
         * Pipe a Readable to the response with back-pressure & optional AbortSignal.
         */
        response.stream = async (readable, { onError, signal } = {}) => {
            if (!readable || typeof readable.pipe !== "function") throw new TypeError("res.stream(readable) requires a Readable");
            if (signal && signal.aborted) {
                const err = new Error("StreamingAbortedError");
                if (onError) onError(err);
                throw err;
            }
            const comp = response.getCompressionMethod();
            try {
                emitHook("beforeHeaders", response);
                if (comp) {
                    setSafeHeader(response, "Content-Encoding", comp.encoding);
                    addVary(response, "Accept-Encoding");
                }
                response.writeHead(response.statusCode || 200);
                emitHook("afterHeaders", response);
                if (comp) {
                    await streamPipeline(readable, comp.stream, response);
                } else {
                    await streamPipeline(readable, response);
                }
                emitHook("afterSend", { kind: "stream" });
            } catch (err) {
                emitHook("onError", err);
                if (typeof onError === "function") onError(err);
                if (!response.writableEnded) response.destroy(err);
                throw err;
            }
        };
    }

    if (!response.hasOwnProperty("ndjson")) {
        /**
         * Stream JSON objects as newline-delimited JSON (application/x-ndjson).
         */
        response.ndjson = async (iterable, { delimiter = "\n", signal } = {}) => {
            const enc = "application/x-ndjson; charset=utf-8";
            if (signal && signal.aborted) throw new Error("StreamingAbortedError");
            const comp = response.getCompressionMethod();
            setSafeHeader(response, "Content-Type", enc);
            setSafeHeader(response, "Cache-Control", "no-cache");
            setSafeHeader(response, "Connection", "keep-alive");
            if (comp) {
                setSafeHeader(response, "Content-Encoding", comp.encoding);
                addVary(response, "Accept-Encoding");
            }
            response.writeHead(response.statusCode || 200);
            emitHook("beforeBody", { kind: "ndjson" });

            let target = comp ? comp.stream : response;
            if (comp) comp.stream.pipe(response);

            try {
                for await (const obj of iterable) {
                    if (signal && signal.aborted) throw new Error("StreamingAbortedError");
                    let line;
                    try {
                        line = JSON.stringify(obj) + delimiter;
                    } catch {
                        continue;
                    }
                    if (!target.write(line)) await once(target, "drain");
                }
                target.end();
                if (comp) await once(response, "finish");
                emitHook("afterBody", { kind: "ndjson" });
                emitHook("afterSend", { kind: "ndjson" });
            } catch (err) {
                emitHook("onError", err);
                if (!response.writableEnded) response.destroy(err);
                throw err;
            }
        };
    }

    if (!response.hasOwnProperty("sse")) {
        /**
         * Server-Sent Events (text/event-stream).
         */
        response.sse = async (handler) => {
            const headers = {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                // Coordination: disable compression; many intermediaries mishandle SSE + compression
            };
            response.setCompress(false);
            for (const [k, v] of Object.entries(headers)) setSafeHeader(response, k, v);
            if (typeof response.flushHeaders === "function") response.flushHeaders();
            response.writeHead(response.statusCode || 200);

            let closed = false;
            function writeChunk(str) {
                if (closed || response.writableEnded) return;
                response.write(str);
            }
            function eventLine(prefix, value) {
                if (value === undefined || value === null) return "";
                const s = String(value).split(/\r?\n/);
                return s.map((line) => `${prefix}: ${line}\n`).join("");
            }
            const api = {
                send(event, data, id) {
                    if (closed) return;
                    let chunk = "";
                    if (id != null) chunk += eventLine("id", id);
                    if (event != null) chunk += eventLine("event", event);
                    if (data != null) {
                        const d = typeof data === "string" ? data : JSON.stringify(data);
                        chunk += eventLine("data", d);
                    }
                    chunk += "\n";
                    writeChunk(chunk);
                },
                comment(text = "") {
                    writeChunk(`:${String(text)}\n\n`);
                },
                heartbeat(ms = 15000) {
                    const t = setInterval(() => {
                        if (closed) return clearInterval(t);
                        writeChunk(":\n\n");
                    }, ms);
                    return () => clearInterval(t);
                },
                close() {
                    if (closed) return;
                    closed = true;
                    try {
                        response.end();
                    } catch (_) {}
                },
            };
            response.on("close", () => {
                closed = true;
            });
            emitHook("afterHeaders", response);
            return handler(api);
        };
    }

    if (!response.hasOwnProperty("etag")) {
        response.etag = (value) => {
            setSafeHeader(response, "ETag", String(value));
            return response;
        };
    }
    if (!response.hasOwnProperty("weakEtag")) {
        response.weakEtag = (value) => {
            const v = String(value);
            const tag = v.startsWith('W/"') || v.startsWith('"') ? v : 'W/"' + v.replace(/^W\//, "").replace(/^"?|"?$/g, "") + '"';
            setSafeHeader(response, "ETag", tag);
            return response;
        };
    }
    if (!response.hasOwnProperty("lastModified")) {
        response.lastModified = (date) => {
            const d = date instanceof Date ? date : new Date(date);
            setSafeHeader(response, "Last-Modified", d.toUTCString());
            return response;
        };
    }
    if (!response.hasOwnProperty("cacheControl")) {
        response.cacheControl = (value) => {
            if (typeof value === "string") {
                setSafeHeader(response, "Cache-Control", value);
                return response;
            }
            const v = value || {};
            const parts = [];
            if (v.public) parts.push("public");
            if (v.private) parts.push("private");
            if (v.maxAge != null) parts.push(`max-age=${Math.floor(v.maxAge)}`);
            if (v.sMaxAge != null) parts.push(`s-maxage=${Math.floor(v.sMaxAge)}`);
            if (v.immutable) parts.push("immutable");
            if (v.staleWhileRevalidate != null) parts.push(`stale-while-revalidate=${Math.floor(v.staleWhileRevalidate)}`);
            if (v.staleIfError != null) parts.push(`stale-if-error=${Math.floor(v.staleIfError)}`);
            setSafeHeader(response, "Cache-Control", parts.join(", ") || "no-cache");
            return response;
        };
    }
    if (!response.hasOwnProperty("notModified")) {
        response.notModified = () => {
            response.status(304);
            // Preserve validators; drop body if any
            response.removeHeader("Content-Type");
            response.removeHeader("Content-Length");
            response.end();
            return response;
        };
    }

    if (!response.hasOwnProperty("cookie")) {
        response.cookie = (name, value, opts = {}) => {
            const serialized = serializeCookie(name, value, opts);
            appendSafeHeader(response, "Set-Cookie", serialized);
            return response;
        };
    }
    if (!response.hasOwnProperty("clearCookie")) {
        response.clearCookie = (name, opts = {}) => {
            const o = Object.assign({ expires: new Date(1), maxAge: 0 }, opts);
            return response.cookie(name, "", o);
        };
    }
};
