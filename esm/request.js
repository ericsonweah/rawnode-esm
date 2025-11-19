"use strict";

import http from 'node:http';

import net from 'node:net';
import url from 'node:url';
import { URL } from 'node:url';
import querystring from 'node:querystring';
import { StringDecoder } from 'node:string_decoder';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
// Stable per-request storage for correlation id
const kReqId = Symbol.for("rawnode.req.id");

// ---- Advanced request decoration symbols & helpers (no deps) ----
let ContentTypeModule = null;
try {
    ContentTypeModule = require("../content-types");
} catch {}
let MimeTypes = null;
try {
    const mime = require("../mime-types");

    MimeTypes = mime.types({ as: "object" });
} catch {}

const kDecorated = Symbol.for("rawnode.req.decorated");
const kCtx = Symbol("rawnode.req.ctx");
const kCache = Symbol("rawnode.req.cache"); // memoized getters: host, ips, path, query, etc.
const kAC = Symbol("rawnode.req.abortctl"); // AbortController
const kDeadlineTimer = Symbol("rawnode.req.deadline"); // deadline timer
const kHooks = Symbol("rawnode.req.hooks"); // request-level plugin hooks

class RequestAbortedError extends Error {
    constructor(msg = "Client aborted") {
        super(msg);
        this.name = "RequestAbortedError";
        this.statusCode = 499;
    }
}
class BodyTooLargeError extends Error {
    constructor(limit) {
        super(`Payload Too Large (>${limit} bytes)`);
        this.name = "BodyTooLargeError";
        this.statusCode = 413;
    }
}
class BodyTimeoutError extends Error {
    constructor(ms) {
        super(`Request body timeout after ${ms}ms`);
        this.name = "BodyTimeoutError";
        this.statusCode = 408;
    }
}
class InvalidRangeHeaderError extends Error {
    constructor(msg = "Invalid Range header") {
        super(msg);
        this.name = "InvalidRangeHeaderError";
        this.statusCode = 416;
    }
}

const lc = (s) => String(s).toLowerCase();

const ipStripPort = (s) => {
    if (!s) return "";
    // Remove bracketed IPv6 port: [::1]:1234 -> [::1]
    s = s.replace(/\]:(\d+)$/, "]");
    // Remove unbracketed :port if present (IPv4)
    if (/:\d+$/.test(s) && s.indexOf(":") === s.lastIndexOf(":")) s = s.replace(/:(\d+)$/, "");
    if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4-mapped IPv6
    if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
    return s;
};

const parseXFF = (val) => {
    if (!val || typeof val !== "string") return [];
    return val
        .split(",")
        .map((v) => ipStripPort(v.trim()))
        .filter(Boolean);
};

const isTrustedProxy = (remoteIP, ctx) => {
    if (!ctx) return false;
    if (ctx.trustProxy === true) return true;
    if (typeof ctx.trustProxy === "function") {
        try {
            return !!ctx.trustProxy(ctx.__req || null);
        } catch {
            return false;
        }
    }
    if (Array.isArray(ctx.proxyIPs)) return ctx.proxyIPs.includes(remoteIP);
    if (typeof ctx.proxyIPs === "function") {
        try {
            return !!ctx.proxyIPs(remoteIP);
        } catch {
            return false;
        }
    }
    return false;
};

const getAuthorityHost = (req) => {
    // HTTP/2 :authority | fallback to host
    const h2Auth = req.headers[":authority"];
    const host = h2Auth || req.headers.host || "";
    return String(host);
};

const parseHostAndName = (req) => {
    const host = getAuthorityHost(req);
    let hostname = host;
    // strip :port for hostname
    const idx = host.lastIndexOf(":");
    if (idx > -1 && !host.includes("]")) hostname = host.slice(0, idx);
    return { host, hostname };
};

const whatwgUrl = (req) => {
    const scheme = req.connection?.encrypted ? "https" : "http";
    const base = `${scheme}://${getAuthorityHost(req) || "localhost"}`;
    // request.url is a path+query string; WHATWG URL handles parsing safely
    return new URL(req.url || "/", base);
};

const weakEtagTag = (tag) => String(tag || "").replace(/^W\//, "");
const etagMatchWeak = (a, b) => weakEtagTag(a) === weakEtagTag(b);

// --- State Persisted Across Requests (In-Memory) ---
const requestCache = new Map(); // Cache for requests
const rateLimit = new Map(); // For basic rate limiting tracking
const requestLogs = []; // For logging requests
const anomalyTracker = new Map(); // For tracking anomalies
const userThrottling = new Map(); // For user-specific throttling
const requestTracker = new Map(); // General request tracking
const predictiveDataCache = new Map(); // Cache for predictive data

// --- Configuration Constants ---

// Anomaly Detection
const ANOMALY_WINDOW_MS = 60000; // 60 seconds
const ANOMALY_LIMIT = 50; // Max requests per window

// Bot Detection
const BOT_PATTERNS = ["bot", "spider", "crawler", "slurp", "baidu", "yandex", "googlebot", "bingbot", "duckduckbot", "facebookexternalhit", "twitterbot", "linkedinbot"];

// Request Structure Tips
const MAX_QUERY_PARAMS_FOR_TIPS = 10;
const TIP_QUERY_PARAMS_PAGINATION = "Consider using pagination or refining filters to reduce the number of query parameters.";
const TIP_MISSING_USER_AGENT = "Consider setting a User-Agent header for better request identification and tracking.";
const TIP_REQUEST_LOOKS_GOOD = "Your request structure looks good!";

// Device Detection
const MOBILE_UA_REGEX = /mobile|android|iphone|ipad|ipod/i; // Basic mobile detection

// Caching
const PREDICTIVE_CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes predictive cache TTL
const MAX_CACHE_ENTRIES = 500; // Max items in general request cache
const DEFAULT_CACHE_ITEM_TTL_MS = 5 * 1000; // Default 5 seconds TTL for general cache

// Validation Messages
const MSG_ERROR_SUMMARY_PREFIX = "Your request has";
const MSG_ERROR_SUMMARY_SUFFIX = "error(s):";
const MSG_NO_VALIDATION_ERRORS = "No validation errors found.";
const MSG_VALIDATION_STATUS_UNKNOWN = "Validation status unknown.";

// Scoring / Risk Assessment
const SCORE_INCREMENT_SUSPICIOUS_IP = 50;
const SCORE_INCREMENT_IS_BOT = 30;
const SCORE_INCREMENT_NO_REFERER = 20; // Note: Missing referer is common

// Geolocation Descriptions
const GEO_DESC_LOCALHOST = "Localhost";
const GEO_DESC_LOCAL_NETWORK = "Private Network";
const GEO_DESC_UNKNOWN_PUBLIC = "Unknown/Public";
const PRIVATE_172_REGEX = /^172\.(1[6-9]|2[0-9]|3[01])\./; // For 172.16.0.0/12 range

// Language
const DEFAULT_LANGUAGE = "en";

// Throttling
const THROTTLE_WINDOW_DURATION_MS = 60 * 1000; // 1 minute
const THROTTLE_REQUEST_LIMIT = 100; // Max requests per window

// HTTP Status Codes & Headers
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_OK_JSON = 200; // Default for JSON response
const HTTP_STATUS_ERROR_JSON = 500; // Status on JSON stringify failure
const CONTENT_TYPE_JSON = { "Content-Type": "application/json" };
const CONTENT_TYPE_JSON_HEADER_OBJ = { "Content-Type": "application/json" }; // Duplicate concept, but maybe used differently? Keeping both as defined.
const VIP_USER_HEADER = "x-vip-user";
const HEADER_X_API_VERSION = "x-api-version";
const HEADER_ACCEPT_VERSION = "accept-version";
const HEADER_X_REQUESTED_WITH_NAME = "x-requested-with";
const HEADER_X_FORWARDED_PROTO = "x-forwarded-proto";

// Request Prioritization
const PRIORITY_LEVEL_HIGH = "high";
const PRIORITY_LEVEL_MEDIUM = "medium";
const PRIORITY_LEVEL_LOW = "low";

// Suspicious Activity Tracking
const SUSPICIOUS_ACTIVITY_WINDOW_MS = 10 * 1000; // 10 seconds
const SUSPICIOUS_ACTIVITY_LIMIT = 10; // Max requests in window

// JSON Handling
const JSON_ERROR_PAYLOAD = JSON.stringify({ success: false, error: "Internal Server Error: Failed to stringify response data." });

// API Versioning
const URL_PATH_VERSION_REGEX = /\/v(\d+)\//; // Captures version digits from URL path
const DEFAULT_API_VERSION_STRING = "1";

// Request Type Identification
const XHR_TARGET_VALUE_LOWERCASE = "xmlhttprequest"; // For checking X-Requested-With
const WEBSOCKET_UPGRADE_VALUE_LOWERCASE = "websocket"; // For checking Upgrade header

// Request Body Handling
const MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024; // 1MB limit (Adjust as needed)
const DEFAULT_BODY_ENCODING = "utf-8";

// MIME Types
const MIME_TYPE_JSON = "application/json";
const MIME_TYPE_FORM_URLENCODED = "application/x-www-form-urlencoded";
const MIME_TYPE_MULTIPART_PREFIX = "multipart/";

// Request Logging Configuration
const MAX_LOG_ENTRIES_IN_MEMORY = 1000; // Max logs to keep in memory

// Rate Limiting Defaults (if using basic map)
const DEFAULT_RATE_LIMIT_THRESHOLD = 100;
const DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS = 60 * 1000; // 1 minute

// Compression
const COMPRESSION_GZIP = "gzip";
const COMPRESSION_BROTLI = "br";
const SUPPORTED_COMPRESSIONS = [COMPRESSION_GZIP, COMPRESSION_BROTLI];

// Protocol Check
const PROTO_HTTPS_LOWERCASE = "https";

// Cookie Signing (CRITICAL SECURITY)
const COOKIE_SIGNING_SECRET = process.env.COOKIE_SECRET; // Load from environment
if (!COOKIE_SIGNING_SECRET && process.env.NODE_ENV === "production") {
    throw new Error("FATAL: COOKIE_SECRET environment variable is not set in production!");
} else if (!COOKIE_SIGNING_SECRET) {
    // MDT context - SLC, UT
    // console.warn(`*** SECURITY WARNING @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })} ***`);
    // console.warn(`*** COOKIE_SECRET environment variable not set. Cookie signing/verification will be insecure/non-functional. ***`);
    // console.warn(`*** For development, set COOKIE_SECRET in your environment (e.g., .env file). ***`);
}

// WebSocket Opcodes & Framing Bits
const WS_OPCODE_TEXT = 0x1; // Used in one definition context
const WS_FIN_BIT = 0x80; // Used in one definition context

const OPCODE_CONT = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
// 0x3-7 reserved
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
// 0xB-F reserved

const FIN_BIT_MASK = 0x80;

const WS_OPCODE_TEXT_FRAME_OUT = 0x1; // Used in another definition context
const WS_FIN_BIT_OUT = 0x80; // Used in another definition context

// --- End of Consolidated Requires and Constants ---

// --- Define Helper function INSIDE the module scope, OUTSIDE module.exports ---
/**
 * Internal utility to read a stream completely into a string with size limit.
 * Not intended to be attached directly to the request object.
 * @param {http.IncomingMessage} stream - The readable stream (e.g., request).
 * @param {number} [sizeLimit=MAX_BODY_SIZE_HELPER] - Max bytes allowed.
 * @param {string} [encoding=DEFAULT_BODY_ENCODING_HELPER] - Target string encoding.
 * @returns {Promise<string>} A promise resolving with the full string or rejecting on error/limit.
 */
function _readStreamToStringHelper(stream, sizeLimit = MAX_BODY_SIZE_HELPER, encoding = DEFAULT_BODY_ENCODING_HELPER) {
    // 1. Basic validation of the input stream
    if (!stream || typeof stream.on !== "function" || typeof stream.destroy !== "function") {
        return Promise.reject(new TypeError("Invalid stream provided to _readStreamToStringHelper"));
    }

    return new Promise((resolve, reject) => {
        const decoder = new StringDecoder(encoding);
        let body = "";
        let receivedBytes = 0;
        let isEnded = false; // Flag to prevent duplicate actions

        const cleanup = () => {
            // Remove listeners to prevent memory leaks after completion/error
            stream.removeListener("data", onData);
            stream.removeListener("end", onEnd);
            stream.removeListener("error", onError);
            stream.removeListener("close", onClose); // Handle abrupt close
        };

        const onError = (err) => {
            if (isEnded) return;
            isEnded = true;
            // console.error(`Stream error in _readStreamToStringHelper:`, err);
            cleanup();
            reject(err); // Reject the promise with the error
        };

        const onData = (chunk) => {
            if (isEnded) return;
            try {
                receivedBytes += chunk.length;
                if (receivedBytes > sizeLimit) {
                    const error = new Error(`Payload Too Large: Body size limit exceeded (${sizeLimit} bytes)`);
                    error.statusCode = 413;
                    stream.destroy(error); // This will trigger the 'error' event
                    return;
                }
                body += decoder.write(chunk);
            } catch (processError) {
                stream.destroy(processError); // Trigger 'error' on processing issues
            }
        };

        const onEnd = () => {
            if (isEnded) return;
            isEnded = true;
            try {
                body += decoder.end(); // Flush decoder
                // console.log(`Stream ended in helper, ${receivedBytes} bytes received.`);
                cleanup();
                resolve(body); // Resolve with the complete string
            } catch (endError) {
                cleanup();
                reject(endError); // Reject if decoder.end() fails
            }
        };

        const onClose = () => {
            // Handle cases where stream closes before 'end' (e.g., premature client disconnect)
            if (!isEnded) {
                isEnded = true;
                cleanup();
                reject(new Error("Stream closed prematurely during body read."));
            }
        };

        // Attach listeners
        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("error", onError);
        stream.on("close", onClose); // Important for handling client disconnects
    });
}

// module.exports = (request, response, socket) => {
export default (request, response, socket, ctx = {}) => {
    // Idempotent, symbol-backed
    if (!request[kCache]) request[kCache] = Object.create(null);
    request[kDecorated] = true;

    // Capture context (logger, metrics, trustProxy, proxyIPs, cookie.secret, maxHeaderBytes, etc.)
    if (!request[kCtx]) request[kCtx] = ctx || {};
    request[kCtx].__req = request; // available in trustProxy predicate

    // Initialize plugin hook storage (no-alloc when unused)
    if (!request[kHooks])
        request[kHooks] = Object.seal({
            beforeParse: [],
            afterParse: [],
            beforeBody: [],
            afterBody: [],
            onAbort: [],
            onError: [],
        });
    // No defaults parameter needed here
    // Type checks
    // if (request && !(request instanceof http.IncomingMessage)) throw new Error("request must be an instance of http.IncomingMessage");
    // if (response && !(response instanceof http.ServerResponse)) throw new Error("response must be an instance of http.ServerResponse");
    // if (socket && !(socket instanceof net.Socket)) throw new Error("socket must be an instance of net.Socket");

    /**
     * Parses query parameters from the URL.
     * @returns {Object} Parsed query parameters as key-value pairs.
     */
    const simpleParseQuery = () => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        return Object.fromEntries(url.searchParams.entries());
    };

    const parseQuery = () => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const params = Object.fromEntries(url.searchParams.entries());

        // Support nested query parameters
        const query = {};
        for (const [key, value] of Object.entries(params)) {
            if (key.includes("[")) {
                const [parent, child] = key.split(/\[|\]/).filter(Boolean);
                query[parent] = query[parent] || {};
                query[parent][child] = value;
            } else {
                query[key] = value;
            }
        }
        return query;
    };

    /**
     * Parses cookies from the request headers.
     * @returns {Object} Parsed cookies as key-value pairs.
     */
    const parseCookies = () => {
        const out = {};
        const cookieHeader = request.headers?.["cookie"];
        if (!cookieHeader || typeof cookieHeader !== "string") return out;
        const parts = cookieHeader.split(";");
        for (const part of parts) {
            const s = part.trim();
            const eq = s.indexOf("=");
            if (eq <= 0) {
                if (s) out[s] = "";
                continue;
            }
            const key = s.slice(0, eq);
            let val = s.slice(eq + 1);
            try {
                val = decodeURIComponent(val.replace(/\+/g, " "));
            } catch {}
            out[key] = val;
        }
        return out;
    };

    /// --- Core Modules Needed ---

    if (!request.hasOwnProperty("params")) {
        request.params = {}; // Or more complex proxy logic
    }

    if (!request.hasOwnProperty("body")) {
        request.body = null; // Or more complex proxy logic
    }
    if (!request.hasOwnProperty("query")) {
        request.query = parseQuery() || {}; // Or more complex proxy logic
    }
    // Assumes parseCookies() is available in the current scope
    if (!request.hasOwnProperty("cookies")) {
        request.cookies = parseCookies() || {}; // Or more complex proxy logic
    }

    if (!request.hasOwnProperty("session")) {
        request.session = {}; // Or more complex proxy logic
    }
    if (!request.hasOwnProperty("_isJson")) {
        request._isJson = request.headers["content-type"] === "application/json";
    }
    if (!request.hasOwnProperty("_isForm")) {
        request._isForm = request.headers["content-type"] === "application/x-www-form-urlencoded";
    }

    if (!request.hasOwnProperty("_isMultipart")) {
        request._isMultipart = typeof request.headers["content-type"] === "string" && request.headers["content-type"].toLowerCase().startsWith("multipart/");
    }
    if (!request.hasOwnProperty("files")) {
        request.files = {};
    }
    if (!request.hasOwnProperty("sessionData")) {
        request.sessionData = {};
    }
    if (!request.hasOwnProperty("validationErrors")) {
        request.validationErrors = [];
    }
    // Ensure preprocessing middleware is an array
    if (!request.hasOwnProperty("preRequestMiddleware")) {
        request.preRequestMiddleware = [];
    }
    // Ensure postprocessing middleware is an array
    if (!request.hasOwnProperty("postResponseMiddleware")) {
        request.postResponseMiddleware = [];
    }
    // Supported languages with default values
    if (!request.hasOwnProperty("supportedLanguages")) {
        request.supportedLanguages = ["en", "fr", "es"];
    }
    // Default language
    if (!request.hasOwnProperty("defaultLanguage")) {
        request.defaultLanguage = "en";
    }
    // Ensure parsers is an object
    if (!request.hasOwnProperty("parsers")) {
        request.parsers = {};
    }
    // Ensure serializers is an object
    if (!request.hasOwnProperty("serializers")) {
        request.serializers = {};
    }

    if (!request.hasOwnProperty("fileAccessMetrics")) {
        request.fileAccessMetrics = {};
    }

    // --- Augment request directly ---
    // Express parity alias
    if (!request.hasOwnProperty("header")) {
        request.header = (name) => {
            if (!name || /[\r\n]/.test(String(name))) return null; // CR/LF injection guard
            return request.headers[String(name).toLowerCase()] ?? null;
        };
    }
    if (!request.hasOwnProperty("get")) {
        request.get = request.header;
    }

    // secure / protocol (trust-proxy aware)
    if (!("secure" in request)) {
        Object.defineProperty(request, "secure", {
            enumerable: true,
            get() {
                const ctx = request[kCtx] || {};
                if (request.connection?.encrypted) return true;
                const xfp = request.headers["x-forwarded-proto"];
                if (xfp && isTrustedProxy(request.socket?.remoteAddress || "", ctx)) {
                    return lc(String(xfp).split(",")[0]).trim() === "https";
                }
                return false;
            },
        });
    }
    if (!("protocol" in request)) {
        Object.defineProperty(request, "protocol", {
            enumerable: true,
            get() {
                if (request.httpVersionMajor === 2) {
                    const h2 = request.headers[":scheme"];
                    if (h2) return lc(h2);
                }
                return request.secure ? "https" : "http";
            },
        });
    }

    // host / hostname (RFC-compliant, HTTP/2 :authority)
    if (!("host" in request)) {
        Object.defineProperty(request, "host", {
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.host) return c.host;
                const { host } = parseHostAndName(request);
                return (c.host = host);
            },
        });
    }
    if (!("hostname" in request)) {
        Object.defineProperty(request, "hostname", {
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.hostname) return c.hostname;
                const { hostname } = parseHostAndName(request);
                return (c.hostname = hostname);
            },
        });
    }

    // upgrade awareness
    if (!("upgrade" in request)) {
        Object.defineProperty(request, "upgrade", {
            enumerable: true,
            get() {
                const up = request.headers["upgrade"];
                return up ? lc(up) : undefined;
            },
        });
    }

    if (!("ips" in request)) {
        Object.defineProperty(request, "ips", {
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.ips) return c.ips;
                const ctx = request[kCtx] || {};
                const remote = ipStripPort(request.socket?.remoteAddress || request.connection?.remoteAddress || "");
                const xff = parseXFF(request.headers["x-forwarded-for"]);
                if (xff.length && isTrustedProxy(remote, ctx)) {
                    // Client IP is first hop; include all in chain
                    return (c.ips = xff.map(ipStripPort).concat(remote ? [remote] : []));
                }
                return (c.ips = remote ? [remote] : []);
            },
        });
    }
    if (!("ip" in request)) {
        Object.defineProperty(request, "ip", {
            enumerable: true,
            get() {
                const arr = request.ips;
                return arr.length ? arr[0] : undefined;
            },
        });
    }

    /// ERROR 1

    //Cannot assign to read only property 'originalUrl' of object '#<IncomingMessage>'

    // Make originalUrl writable/configurable (Express may reassign it), and only
    // define it if it's not already an own property. Snapshot the current url.
    if (!Object.prototype.hasOwnProperty.call(request, "originalUrl")) {
        const snapshot = typeof request.url === "string" ? request.url : "/";
        Object.defineProperty(request, "originalUrl", {
            enumerable: true,
            configurable: true, // allow redefining in middlewares/routers if needed
            writable: true, // prevent "read-only property" TypeError on reassignment
            value: snapshot,
        });
    }

    if (!request.hasOwnProperty("baseUrl")) {
        // Router can set/modify this (Express parity)
        request.baseUrl = "";
    }
    if (!("path" in request)) {
        Object.defineProperty(request, "path", {
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.path) return c.path;
                try {
                    return (c.path = whatwgUrl(request).pathname);
                } catch {
                    return (c.path = "/");
                }
            },
        });
    }

    // Preserve existing request.query if already assigned; otherwise memoize a safe parse.
    if (!request.hasOwnProperty("query") || request.query == null) {
        Object.defineProperty(request, "query", {
            configurable: true,
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.query) return c.query;
                try {
                    const u = whatwgUrl(request);
                    const obj = Object.create(null);
                    for (const [k, v] of u.searchParams) {
                        const key = k;
                        let val = v;
                        // Basic double-decode protection: decode once
                        try {
                            val = decodeURIComponent(v);
                        } catch {
                            val = v;
                        }
                        if (/%/.test(val)) {
                            /* keep single decode to avoid double */
                        }
                        obj[key] = val;
                    }
                    return (c.query = obj);
                } catch {
                    return (c.query = {});
                }
            },
        });
    }

    if (!request.hasOwnProperty("contentType")) {
        request.contentType = () => {
            const raw = request.headers["content-type"] || "";
            if (ContentTypeModule?.parse) {
                try {
                    return ContentTypeModule.parse(raw);
                } catch {
                    return null;
                }
            }
            // Fallback minimal parse
            const [type, ...params] = String(raw).split(";");
            const charset = params.find((p) => p.trim().startsWith("charset="))?.split("=")[1];
            return { type: type.trim().toLowerCase(), parameters: { ...(charset ? { charset } : {}) } };
        };
    }
    // Keep existing request.is; add '+json' suffix support if not present
    if (!request.hasOwnProperty("is")) {
        request.is = (typeOrArray) => {
            const candidates = Array.isArray(typeOrArray) ? typeOrArray : [typeOrArray];
            const ct = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
            if (!ct) return false;
            for (let t of candidates) {
                if (!t) continue;
                t = String(t).toLowerCase();
                if (t === "json") t = "application/json";
                if (t === "html") t = "text/html";
                if (t === "text") t = "text/plain";
                if (t.endsWith("/*")) {
                    const base = t.slice(0, -2);
                    if (ct.startsWith(base + "/")) return t;
                }
                if (t[0] === "+" && ct.endsWith(t)) return t; // +json, +xml
                if (t === "application/json" && ct.endsWith("+json")) return t;
                if (ct === t) return t;
            }
            return false;
        };
    }

    // Parse an Accept-like header into [{value, q, specificity, order}]
    const parseAcceptHeader = (h, wildcard = "*/*") => {
        if (!h || typeof h !== "string") return [{ value: wildcard, q: 1, specificity: 0, order: 0 }];
        return h
            .split(",")
            .map((part, i) => {
                const [raw, ...rest] = part.split(";");
                const v = raw.trim().toLowerCase();
                const qStr = rest.join(";").match(/q=([0-9.]+)/)?.[1];
                const q = qStr ? Math.max(0, Math.min(1, parseFloat(qStr))) : 1;
                let spec = 2;
                if (v === wildcard) spec = 0;
                else if (v.endsWith("/*")) spec = 1;
                return { value: v, q, specificity: spec, order: i };
            })
            .filter((x) => x.q > 0)
            .sort((a, b) => b.q - a.q || b.specificity - a.specificity || a.order - b.order);
    };

    // Extends existing request.accepts if present; otherwise add a compliant one
    if (!request.hasOwnProperty("accepts")) {
        request.accepts = (...types) => {
            const server = types.length === 1 && Array.isArray(types[0]) ? types[0] : types;
            const h = request.headers["accept"] || "*/*";
            const prefs = parseAcceptHeader(h);
            for (const s of server) {
                let t = String(s).toLowerCase();
                if (t === "json") t = "application/json";
                if (t === "html") t = "text/html";
                if (t === "text") t = "text/plain";
                for (const p of prefs) {
                    if (p.value === "*/*") return s;
                    if (p.value.endsWith("/*") && t.startsWith(p.value.slice(0, -2) + "/")) return s;
                    if (p.value === t) return s;
                }
            }
            return false;
        };
    }
    if (!request.hasOwnProperty("acceptsEncodings")) {
        request.acceptsEncodings = (...encs) => {
            const server = encs.length === 1 && Array.isArray(encs[0]) ? encs[0] : encs.length ? encs : ["gzip", "br", "deflate", "identity"];
            const h = request.headers["accept-encoding"] || "";
            const prefs = parseAcceptHeader(h, "*");
            for (const s of server) {
                const t = lc(s);
                for (const p of prefs) {
                    if (p.value === "*" || p.value === t) return s;
                }
            }
            return false;
        };
    }
    if (!request.hasOwnProperty("acceptsCharsets")) {
        request.acceptsCharsets = (...sets) => {
            const server = sets.length === 1 && Array.isArray(sets[0]) ? sets[0] : sets.length ? sets : ["utf-8", "iso-8859-1"];
            const h = request.headers["accept-charset"] || "";
            const prefs = parseAcceptHeader(h, "*");
            for (const s of server) {
                const t = lc(s);
                for (const p of prefs) {
                    if (p.value === "*" || p.value === t) return s;
                }
            }
            return false;
        };
    }
    if (!request.hasOwnProperty("acceptsLanguages")) {
        request.acceptsLanguages = (...langs) => {
            const server = langs.length === 1 && Array.isArray(langs[0]) ? langs[0] : langs;
            const h = request.headers["accept-language"] || "";
            const prefs = parseAcceptHeader(h, "*");
            for (const s of server) {
                const t = lc(s);
                for (const p of prefs) {
                    if (p.value === "*" || p.value.split("-")[0] === t.split("-")[0] || p.value === t) return s;
                }
            }
            return false;
        };
    }

    if (!("ifNoneMatch" in request)) {
        Object.defineProperty(request, "ifNoneMatch", {
            enumerable: true,
            get() {
                return request.headers["if-none-match"] || null;
            },
        });
    }
    if (!("ifModifiedSince" in request)) {
        Object.defineProperty(request, "ifModifiedSince", {
            enumerable: true,
            get() {
                const v = request.headers["if-modified-since"];
                if (!v) return null;
                const d = new Date(v);
                return isNaN(d.getTime()) ? null : d;
            },
        });
    }
    // fresh/stale computed against response validators if present
    if (!("fresh" in request)) {
        Object.defineProperty(request, "fresh", {
            enumerable: true,
            get() {
                const method = (request.method || "").toUpperCase();
                if (method !== "GET" && method !== "HEAD") return false;
                const etag = response?.getHeader ? response.getHeader("etag") : undefined;
                const lm = response?.getHeader ? response.getHeader("last-modified") : undefined;

                const inm = request.ifNoneMatch;
                if (inm) {
                    if (inm.trim() === "*") return !!etag;
                    const etags = inm.split(",").map((s) => s.trim());
                    if (etag && etags.some((e) => etagMatchWeak(e, String(etag)))) return true;
                } else if (lm && request.ifModifiedSince) {
                    try {
                        const last = new Date(String(lm)).getTime();
                        const since = request.ifModifiedSince.getTime();
                        if (!isNaN(last) && !isNaN(since) && since >= last) return true;
                    } catch {}
                }
                return false;
            },
        });
    }
    if (!("stale" in request)) {
        Object.defineProperty(request, "stale", {
            enumerable: true,
            get() {
                return !request.fresh;
            },
        });
    }

    if (!("signal" in request)) {
        const ac = new AbortController();
        request[kAC] = ac;
        Object.defineProperty(request, "signal", {
            enumerable: true,
            get() {
                return request[kAC].signal;
            },
        });
        // Wire to underlying socket/request lifecycle
        const abortOnce = (reason) => {
            try {
                ac.abort(reason instanceof Error ? reason : new RequestAbortedError());
            } catch {}
        };
        request.once("aborted", () => abortOnce(new RequestAbortedError()));
        request.once("close", () => abortOnce(new RequestAbortedError("Socket closed")));
        request.once("error", (e) => abortOnce(e));
    }
    if (!request.hasOwnProperty("onAbort")) {
        request.onAbort = (fn) => {
            if (typeof fn !== "function") return;
            request.signal.addEventListener("abort", fn, { once: true });
            // Also register on our hook slot (for plugins)
            request[kHooks].onAbort.push(fn);
        };
    }
    if (!("deadlineMs" in request)) {
        let _deadline = 0;
        Object.defineProperty(request, "deadlineMs", {
            enumerable: true,
            get() {
                return _deadline;
            },
            set(v) {
                const ms = Math.max(0, Number(v) || 0);
                _deadline = ms;
                if (request[kDeadlineTimer]) clearTimeout(request[kDeadlineTimer]);
                if (ms > 0) {
                    request[kDeadlineTimer] = setTimeout(() => {
                        if (!request.signal.aborted) {
                            request[kAC].abort(new BodyTimeoutError(ms));
                        }
                    }, ms).unref?.();
                }
            },
        });
    }

    request.simpleParseQuery = simpleParseQuery;
    request.parseCookies = parseCookies;
    request.parseQuery = parseQuery;
    // --------------------------------

    // -------------------------------------------

    /**
     * Encodes JavaScript data (via JSON) into a single, unfragmented WebSocket text frame.
     * Server-to-client frames are not masked. Calculates byte length correctly.
     * @param {*} data - The data to be JSON.stringified and encoded.
     * @returns {Buffer | null} A Buffer containing the WebSocket frame, or null if stringification fails.
     * @throws {TypeError} If data contains circular references or cannot be stringified.
     */
    const encodeWebSocketFrame = (data) => {
        let payloadBuffer;

        // 1. Stringify data and create payload Buffer FIRST to get accurate byte length
        try {
            const jsonString = JSON.stringify(data);
            payloadBuffer = Buffer.from(jsonString, "utf8"); // Use explicit UTF-8
        } catch (stringifyError) {
            console.error(`[encodeWebSocketFrame @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to stringify data:`, stringifyError); // MDT Context - SLC, UT
            // Re-throw standard error type
            throw new TypeError(`Data could not be stringified for WebSocket frame: ${stringifyError.message}`);
        }

        // 2. Get the BYTE length of the payload
        const payloadByteLength = payloadBuffer.length;

        // 3. Determine header size and create header Buffer
        let headerBuffer;
        const firstByte = WS_FIN_BIT | WS_OPCODE_TEXT; // FIN=1, Opcode=Text

        try {
            if (payloadByteLength <= 125) {
                headerBuffer = Buffer.alloc(2);
                headerBuffer.writeUInt8(firstByte, 0);
                // Mask bit is 0 (server-to-client) + 7-bit length
                headerBuffer.writeUInt8(payloadByteLength, 1);
            } else if (payloadByteLength <= 65535) {
                // Max value for UInt16
                headerBuffer = Buffer.alloc(4); // 2 bytes base + 2 bytes extended length
                headerBuffer.writeUInt8(firstByte, 0);
                headerBuffer.writeUInt8(126, 1); // Mask bit (0) + 126 marker
                headerBuffer.writeUInt16BE(payloadByteLength, 2); // Write 16-bit length (Big Endian)
            } else {
                headerBuffer = Buffer.alloc(10); // 2 bytes base + 8 bytes extended length
                headerBuffer.writeUInt8(firstByte, 0);
                headerBuffer.writeUInt8(127, 1); // Mask bit (0) + 127 marker
                // Use BigInt for lengths possibly exceeding 2^53 - 1
                headerBuffer.writeBigUInt64BE(BigInt(payloadByteLength), 2); // Write 64-bit length (Big Endian)
            }
        } catch (headerError) {
            // Catch errors during buffer allocation or writing (e.g., length too large for BigInt handling if Node version is old?)
            console.error(`[encodeWebSocketFrame @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error creating frame header:`, headerError); // MDT Context - SLC, UT
            return null; // Indicate failure
        }

        // 4. Combine header and payload buffers
        try {
            // Buffer.concat is efficient
            return Buffer.concat([headerBuffer, payloadBuffer], headerBuffer.length + payloadByteLength);
        } catch (concatError) {
            console.error(`[encodeWebSocketFrame @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error concatenating frame buffers:`, concatError); // MDT Context - SLC, UT
            return null; // Indicate failure
        }
    };

    /**
     * Encodes data (via JSON) into a single WebSocket text frame and attempts
     * to write it to the provided socket stream. Handles different payload lengths.
     * Server-to-client frames are NOT masked. Includes basic error handling.
     * @param {*} data - The data to be JSON.stringified and sent.
     * @param {object} socket - The writable stream socket (e.g., net.Socket, tls.TLSSocket).
     * Must have `.writable` property and `.write()` method.
     * @returns {boolean} True if the frame was successfully constructed and write was initiated,
     * false if an error occurred (stringify, header build, write) or socket invalid.
     * @throws {TypeError} If data cannot be stringified (e.g., circular reference). Re-throws error.
     */
    const encodeAndSendWebSocketFrame = (data, socket) => {
        const funcName = "encodeAndSendWebSocketFrame";
        const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT Context - SLC, UT

        // 1. Validate Socket
        if (!socket || !socket.writable) {
            console.error(`${logPrefix} Cannot send: Socket is invalid or not writable.`);
            return false;
        }

        let payloadBuffer;
        // 2. Stringify and Create Payload Buffer
        try {
            const jsonString = JSON.stringify(data);
            payloadBuffer = Buffer.from(jsonString, "utf8"); // Explicit UTF-8
        } catch (stringifyError) {
            console.error(`${logPrefix} Failed to stringify input data:`, stringifyError);
            // Let the caller handle this type of error, re-throw
            throw new TypeError(`Data could not be stringified for WebSocket frame: ${stringifyError.message}`);
        }

        // 3. Get Payload Byte Length and Prepare Header
        const payloadByteLength = payloadBuffer.length;
        let headerBuffer;
        const firstByte = WS_FIN_BIT_OUT | WS_OPCODE_TEXT_FRAME_OUT; // FIN=1, Opcode=Text

        try {
            if (payloadByteLength <= 125) {
                headerBuffer = Buffer.alloc(2);
                headerBuffer.writeUInt8(firstByte, 0);
                headerBuffer.writeUInt8(payloadByteLength, 1); // Mask bit=0
            } else if (payloadByteLength <= 65535) {
                headerBuffer = Buffer.alloc(4);
                headerBuffer.writeUInt8(firstByte, 0);
                headerBuffer.writeUInt8(126, 1); // Mask bit=0, Len=126
                headerBuffer.writeUInt16BE(payloadByteLength, 2);
            } else {
                headerBuffer = Buffer.alloc(10);
                headerBuffer.writeUInt8(firstByte, 0);
                headerBuffer.writeUInt8(127, 1); // Mask bit=0, Len=127
                headerBuffer.writeBigUInt64BE(BigInt(payloadByteLength), 2);
            }
        } catch (headerError) {
            console.error(`${logPrefix} Failed to create frame header:`, headerError);
            return false; // Indicate failure
        }

        // 4. Combine Header and Payload
        let frameBuffer;
        try {
            frameBuffer = Buffer.concat([headerBuffer, payloadBuffer], headerBuffer.length + payloadByteLength);
        } catch (concatError) {
            console.error(`${logPrefix} Failed to concatenate frame buffers:`, concatError);
            return false; // Indicate failure
        }

        // 5. Write Frame to Socket
        try {
            const flushed = socket.write(frameBuffer);
            if (!flushed) {
                // Basic backpressure notification. Full handling requires listening for 'drain'.
                console.warn(`${logPrefix} Socket buffer full, write queued (backpressure) for ${socket.remoteAddress}.`);
            }
            return true; // Write initiated
        } catch (writeError) {
            console.error(`${logPrefix} Failed to write frame to socket for ${socket.remoteAddress}:`, writeError);
            // Optionally attempt to close/destroy the socket on write error
            // if (socket.destroy) socket.destroy(writeError); else if (socket.end) socket.end();
            return false; // Indicate failure
        }
    };

    // --- How it might be used (assuming 'ws' is the socket) ---
    // const success = encodeAndSendWebSocketFrame({ message: 'hello' }, ws);
    // if (!success) { /* Handle failure */ }

    // --- Or attached to request (if socket stored on request) ---
    /*
// Inside module.exports = (request, response) => { ... }
if (!request.hasOwnProperty('sendWsMessage')) {
    request.sendWsMessage = (data) => {
        if (!request.webSocket) return false; // Check if socket exists on request
        return encodeAndSendWebSocketFrame(data, request.webSocket); // Call utility
    };
}
*/

    /**
     * Decodes a single WebSocket frame (Buffer) according to RFC 6455.
     * WARNING: This is a basic implementation.
     * - Supports unfragmented Text frames (opcode 0x1).
     * - Recognizes Close, Ping, Pong control frames (extracts their payload).
     * - Does NOT support fragmented messages (FIN=0) - throws error.
     * - Does NOT support Binary frames (opcode 0x2) - throws error.
     * - Assumes client-to-server masking; performs unmasking.
     *
     * @param {Buffer} frameBuffer - The raw Buffer containing the WebSocket frame.
     * @returns {string | {type: 'close'|'ping'|'pong', payload: Buffer}}
     * - Decoded UTF-8 string for Text frames.
     * - Object indicating type and payload Buffer for known control frames.
     * @throws {TypeError} If input is not a Buffer or buffer is too short.
     * @throws {Error} For malformed frames, unsupported opcodes/fragmentation, or masking issues.
     */
    const decodeWebSocketFrameImproved = (frameBuffer) => {
        // Renamed locally
        if (!Buffer.isBuffer(frameBuffer)) {
            throw new TypeError("WebSocket frame data must be a Buffer.");
        }
        if (frameBuffer.length < 2) {
            // Need at least 2 bytes for basic header
            throw new Error("Invalid WebSocket frame: insufficient length (< 2 bytes).");
        }

        const firstByte = frameBuffer[0];
        const isFinalFrame = (firstByte & FIN_BIT_MASK) === FIN_BIT_MASK; // FIN bit
        // Could check RSV bits: if (firstByte & 0x70) !== 0 throw new Error("RSV bits must be 0");
        const opcode = firstByte & 0x0f; // Opcode bits

        const secondByte = frameBuffer[1];
        const isMasked = (secondByte & 0x80) === 0x80; // MASK bit
        let payloadLength7 = secondByte & 0x7f; // 7-bit payload length

        let currentOffset = 2; // Start after first two bytes
        let payloadTotalLength = 0;

        // --- Handle Control Frames (Close, Ping, Pong) ---
        if (opcode >= 0x8) {
            if (!isFinalFrame) throw new Error("Invalid WebSocket control frame: FIN bit must be 1.");
            if (payloadLength7 > 125) throw new Error(`Invalid WebSocket control frame: payload length (${payloadLength7}) exceeds 125 bytes.`);

            const minCtrlLen = currentOffset + (isMasked ? 4 : 0); // Min length needed for headers + mask key
            if (frameBuffer.length < minCtrlLen) throw new Error(`Invalid WebSocket control frame: insufficient buffer length for mask key (${frameBuffer.length} < ${minCtrlLen}).`);

            let payloadOffset = currentOffset;
            let maskingKey = null;
            if (isMasked) {
                maskingKey = frameBuffer.slice(currentOffset, currentOffset + 4);
                payloadOffset += 4;
            }

            const finalExpectedCtrlLen = payloadOffset + payloadLength7;
            if (frameBuffer.length < finalExpectedCtrlLen) throw new Error(`Invalid WebSocket control frame: insufficient buffer length for payload (${frameBuffer.length} < ${finalExpectedCtrlLen}).`);

            let controlPayload = Buffer.alloc(payloadLength7); // Allocate even if length is 0
            if (payloadLength7 > 0) {
                if (isMasked) {
                    for (let i = 0; i < payloadLength7; i++) {
                        controlPayload[i] = frameBuffer[payloadOffset + i] ^ maskingKey[i % 4];
                    }
                } else {
                    // Server->Client control frames might not be masked
                    frameBuffer.copy(controlPayload, 0, payloadOffset, payloadOffset + payloadLength7);
                }
            }

            switch (opcode) {
                case OPCODE_CLOSE:
                    // Could further parse controlPayload for status code (first 2 bytes) and reason
                    console.log(`[WebSocket @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Received CLOSE frame.`); // MDT Context
                    return { type: "close", payload: controlPayload };
                case OPCODE_PING:
                    console.log(`[WebSocket @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Received PING frame.`); // MDT Context
                    return { type: "ping", payload: controlPayload }; // Return payload so it can be Pong'd back
                case OPCODE_PONG:
                    console.log(`[WebSocket @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Received PONG frame.`); // MDT Context
                    return { type: "pong", payload: controlPayload };
                default:
                    throw new Error(`Unsupported control frame opcode: 0x${opcode.toString(16)}`);
            }
        }

        // --- Handle Data Frames (Text, Binary, Continuation) ---

        // Determine full payload length
        if (payloadLength7 === 126) {
            // 16-bit length follows
            if (frameBuffer.length < currentOffset + 2) throw new Error("Invalid frame: insufficient length for 16-bit payload size.");
            payloadTotalLength = frameBuffer.readUInt16BE(currentOffset);
            currentOffset += 2;
        } else if (payloadLength7 === 127) {
            // 64-bit length follows
            if (frameBuffer.length < currentOffset + 8) throw new Error("Invalid frame: insufficient length for 64-bit payload size.");
            const payloadBigInt = frameBuffer.readBigUInt64BE(currentOffset);
            // Check if length exceeds safe integer limits for JS numbers if necessary
            if (payloadBigInt > Number.MAX_SAFE_INTEGER) {
                throw new Error("WebSocket frame payload length exceeds Number.MAX_SAFE_INTEGER.");
            }
            payloadTotalLength = Number(payloadBigInt);
            currentOffset += 8;
        } else {
            payloadTotalLength = payloadLength7;
        }

        // Check MASK bit (Client->Server frames MUST be masked according to RFC 6455 Sec 5.1)
        if (!isMasked) {
            // Note: You might disable this check if decoding server-to-client frames
            throw new Error("Invalid frame from client: Mask bit not set.");
        }

        // Check buffer length for masking key
        if (frameBuffer.length < currentOffset + 4) throw new Error("Invalid frame: insufficient length for masking key.");
        const maskingKey = frameBuffer.slice(currentOffset, currentOffset + 4);
        currentOffset += 4;

        // Check buffer length for declared payload length
        const finalExpectedLen = currentOffset + payloadTotalLength;
        if (frameBuffer.length < finalExpectedLen) {
            throw new Error(`Invalid frame: insufficient length for payload (${frameBuffer.length} < ${finalExpectedLen}). Declared length: ${payloadTotalLength}.`);
        }

        // Unmask the payload data
        const payloadData = Buffer.alloc(payloadTotalLength);
        for (let i = 0; i < payloadTotalLength; i++) {
            payloadData[i] = frameBuffer[currentOffset + i] ^ maskingKey[i % 4];
        }

        // Handle based on opcode
        switch (opcode) {
            case OPCODE_TEXT:
                if (!isFinalFrame) {
                    // Explicitly reject fragmented frames
                    throw new Error("Unsupported operation: Fragmented WebSocket frames (FIN=0) are not handled.");
                }
                try {
                    // Decode as UTF-8 string (most common for text frames)
                    return payloadData.toString("utf8");
                } catch (e) {
                    throw new Error("Invalid UTF-8 sequence in WebSocket text frame payload.");
                }
            case OPCODE_BINARY:
                throw new Error("Unsupported frame opcode: Binary (0x2). This decoder only handles Text frames.");
            case OPCODE_CONT:
                throw new Error("Unsupported frame opcode: Continuation (0x0). Fragmentation not supported.");
            default:
                throw new Error(`Unsupported data frame opcode: 0x${opcode.toString(16)}`);
        }
    };

    // Note: This function assumes it's a standalone utility. If you intended to attach it:
    // --- Place this INSIDE module.exports = (request, response) => { ... } ---
    /*
if (!request.hasOwnProperty('encodeWebSocketFrame')) {
    request.encodeWebSocketFrame = encodeWebSocketFrame; // Assign the function defined above
}
*/
    // --- End attachment logic ---

    // Attach the getSignedCookie method conditionally
    if (!request.hasOwnProperty("getSignedCookie")) {
        /**
         * Retrieves the original value of a signed cookie after verifying its HMAC signature.
         * Assumes cookie value format: 'originalValue.signature'.
         * Requires a COOKIE_SECRET environment variable matching the signing key.
         * Uses timing-safe comparison to prevent timing attacks.
         * @param {string} name - The name of the signed cookie.
         * @returns {string | null} The original unsigned value if signature is valid, otherwise null.
         */
        request.getSignedCookie = (name) => {
            const funcName = "request.getSignedCookie";
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT Context - SLC, UT

            // 1. Validate input name
            if (!name || typeof name !== "string") {
                console.warn(`${logPrefix} Invalid cookie name requested.`);
                return null;
            }

            // 2. Check if secret is available (critical)
            if (!COOKIE_SIGNING_SECRET) {
                console.error(`${logPrefix} Cannot verify cookie "${name}": COOKIE_SECRET is not configured.`);
                return null;
            }

            // 3. Check if cookies are parsed and available
            const cookies = request.cookies;
            if (!cookies || typeof cookies !== "object" || cookies === null) {
                // console.warn(`${logPrefix} request.cookies object not found for cookie "${name}".`);
                return null;
            }

            // 4. Get the signed value
            const signedValue = cookies[name];
            if (typeof signedValue !== "string" || !signedValue.includes(".")) {
                // console.log(`${logPrefix} Signed cookie "${name}" not found or has invalid format.`);
                return null; // Not found or doesn't contain potential signature separator
            }

            // 5. Split value and signature (basic '.' split)
            // WARNING: Assumes original value does not contain '.'
            // Consider Base64 encoding value before signing for more robustness
            const separatorIndex = signedValue.lastIndexOf("."); // Use lastIndexOf for safety
            if (separatorIndex === -1) return null; // Should be caught by includes check above, but safe

            const value = signedValue.substring(0, separatorIndex);
            const signature = signedValue.substring(separatorIndex + 1);

            if (!value || !signature) {
                // Check parts are not empty
                console.warn(`${logPrefix} Invalid parts for signed cookie "${name}".`);
                return null;
            }

            // 6. Verify the signature using HMAC and timing-safe comparison
            try {
                const hmac = crypto.createHmac("sha256", COOKIE_SIGNING_SECRET);
                const expectedSignatureBuffer = hmac.update(value).digest(); // Get buffer directly
                const providedSignatureBuffer = Buffer.from(signature, "hex"); // Assume hex encoding

                // Ensure buffers have the same length before comparing
                if (providedSignatureBuffer.length === expectedSignatureBuffer.length && crypto.timingSafeEqual(providedSignatureBuffer, expectedSignatureBuffer)) {
                    // SIGNATURE VALID! Return the original value.
                    return value;
                } else {
                    // Signature Mismatch
                    console.warn(`${logPrefix} Invalid signature for cookie "${name}".`);
                    return null;
                }
            } catch (error) {
                console.error(`${logPrefix} Error verifying signed cookie "${name}":`, error);
                return null; // Error during verification
            }
        };
    }
    // --- End of attachment logic ---

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the initLogging method conditionally
    if (!request.hasOwnProperty("initLogging")) {
        /**
         * Initializes request logging: gets/assigns a request ID, starts a timer,
         * logs the request start, and sets up a listener on the RESPONSE 'finish'
         * event to log request completion and duration.
         */
        request.initLogging = () => {
            const logTime = new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver", hour12: false }); // MDT Context - SLC, UT (24hr format)
            let requestId = "unknown-" + Date.now().toString().slice(-6); // Basic fallback ID

            // 1. Get Request ID using the dedicated helper
            if (typeof request.getId === "function") {
                try {
                    requestId = request.getId() ?? requestId; // Use helper, keep fallback if it returns null
                } catch (error) {
                    console.error(`[initLogging @ ${logTime}] Error calling request.getId():`, error);
                }
            } else {
                console.warn(`[initLogging @ ${logTime}] request.getId() function not found. Using fallback ID.`);
            }
            // Store it for easy access during logging (optional, could call getId() again)
            request._requestId = requestId;

            // Propagate correlation id to response headers (idempotent; set only if not sent)
            try {
                if (response && !response.headersSent) {
                    response.setHeader("x-request-id", requestId);
                    // mirror for upstream systems that expect correlation id
                    if (!response.getHeader("x-correlation-id")) {
                        response.setHeader("x-correlation-id", requestId);
                    }
                }
            } catch {}

            // --- Do NOT modify request.headers here ---

            // 2. Log Request Start
            const method = request.method ?? "METHOD?";
            const url = request.url ?? "";
            const ip = request.ip ?? "IP?";
            // Use substring for brevity if ID is long (like UUID)
            const reqIdShort = typeof requestId === "string" ? requestId.substring(0, 8) : "N/A";
            console.log(`[Req:${reqIdShort}] ${logTime} --> ${method} ${url} from ${ip}`);

            // 3. Start the Timer (assuming it exists)
            if (typeof request.startTimer === "function") {
                try {
                    request.startTimer();
                } catch (error) {
                    console.error(`[initLogging @ ${logTime}] Error calling request.startTimer():`, error);
                }
            } else {
                console.warn(`[initLogging @ ${logTime}] request.startTimer() function not found.`);
            }

            // 4. Log Request Completion when RESPONSE finishes sending
            if (response && typeof response.on === "function" && typeof response.once === "function") {
                // Use 'once' to prevent listener leaks if finish/close fire multiple times (shouldn't happen but safe)
                response.once("finish", () => {
                    const finishTime = new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver", hour12: false }); // MDT Context - SLC, UT
                    let durationStr = "N/A";
                    // Use the numeric duration getter
                    if (typeof request.getResponseTimeMs === "function") {
                        try {
                            const durationMs = request.getResponseTimeMs();
                            if (durationMs !== null) {
                                durationStr = `${durationMs.toFixed(2)}ms`;
                            }
                        } catch (error) {
                            console.error(`[initLogging @ ${finishTime}] Error calling request.getResponseTimeMs():`, error);
                        }
                    }
                    const statusCode = response.statusCode ?? "???"; // Get status AFTER response finishes
                    console.log(`[Req:${reqIdShort}] ${finishTime} <-- ${method} ${url} ${statusCode} ${durationStr}`);
                });

                // Optional: Log if connection closed before 'finish'
                response.once("close", () => {
                    if (!response.writableEnded) {
                        // Check if finish didn't fire
                        const closeTime = new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver", hour12: false }); // MDT Context - SLC, UT
                        console.log(`[Req:${reqIdShort}] ${closeTime} C-- ${method} ${url} (Connection closed prematurely)`);
                    }
                });
            } else {
                console.warn(`[initLogging @ ${logTime}] Cannot attach response finish/close logger: Invalid response object.`);
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getId, request.startTimer, request.getResponseTimeMs being attached.
    // Uses the 'response' object passed into the decorator scope for 'finish'/'close' events.
    // Assumes request.ip, request.method, request.url are populated.
    // Best called once near the beginning of request processing.
    // ---------------------------------

    // Attach the format method conditionally
    if (!request.hasOwnProperty("format")) {
        /**
         * Performs content negotiation using request.accepts() based on the request's
         * Accept header and executes the corresponding handler function from the 'formats' object.
         * Throws an error (intended for 406 Not Acceptable) if no suitable handler matches.
         * @param {object} formats - An object where keys are MIME type strings or shortcuts
         * (e.g., 'json', 'html', 'text/plain') acceptable by the server, and values are
         * the corresponding handler functions to execute.
         * @returns {*} The return value from the executed handler function.
         * @throws {Error} If no acceptable format is found (includes statusCode 406 hint).
         * @throws {TypeError} If formats object is invalid or a handler is not a function.
         */
        request.format = (formats) => {
            const funcName = "request.format"; // For logging context
            const logPrefix = `[${funcName} @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}]`; // MDT Context - SLC, UT

            // 1. Validate 'formats' input
            if (!formats || typeof formats !== "object" || formats === null || Object.keys(formats).length === 0) {
                throw new TypeError(`${funcName} requires a non-empty formats object.`);
            }

            // 2. Ensure request.accepts exists
            if (typeof request.accepts !== "function") {
                throw new Error(`${funcName} requires 'request.accepts' method to be available.`);
            }

            // 3. Get the list of types offered by the server (keys of the formats object)
            const serverOfferedTypes = Object.keys(formats);

            // 4. Use request.accepts() to find the best match based on client's Accept header
            // request.accepts returns the key from serverOfferedTypes that matched, or false
            const bestMatch = request.accepts(serverOfferedTypes);

            console.log(`${logPrefix} Offered: [${serverOfferedTypes.join(", ")}]. Client Accepts Header: "${request.headers["accept"] || ""}". Best Match: ${bestMatch || "None"}.`);

            // 5. Execute handler for the best match, or throw 406 error
            if (bestMatch && formats[bestMatch]) {
                const handler = formats[bestMatch];
                if (typeof handler === "function") {
                    try {
                        // Execute the chosen handler
                        return handler(); // Return its result
                    } catch (handlerError) {
                        console.error(`${logPrefix} Error executing handler for format "${bestMatch}":`, handlerError);
                        // Re-throw the handler error for upstream handling (e.g., 500 error page)
                        throw handlerError;
                    }
                } else {
                    // This indicates a configuration error - the value in the formats object wasn't a function
                    throw new TypeError(`${funcName}: Handler for format "${bestMatch}" is not a function.`);
                }
            } else {
                // No match found between client Accept and server Formats
                // Throw an error that can be caught to send a 406 response
                const error = new Error(`Not Acceptable: Client cannot accept any of the supported media types: ${serverOfferedTypes.join(", ")}`);
                error.statusCode = 406; // Hint for error handler
                error.acceptable = serverOfferedTypes; // Provide context
                console.warn(`${logPrefix} ${error.message}`);
                throw error;
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies heavily on request.accepts() being attached and functional.
    // Expects 'formats' object with keys as MIME types/shortcuts and values as functions.
    // Executes the matched function. May throw errors (especially a 406-style error).
    // Calling code should wrap request.format() in try...catch to handle 406 or handler errors.
    // ---------------------------------

    // Attach the getCachedRequest method conditionally
    // Consider scope: General cache utility vs. request-specific helper?
    if (!request.hasOwnProperty("getCachedRequest")) {
        /**
         * Retrieves an item from the shared in-memory cache by its hash key,
         * respecting a Time-To-Live (TTL). Automatically removes stale entries when accessed.
         * @param {string} hash - The unique key for the cache entry.
         * @param {number} [ttlMs=DEFAULT_CACHE_ITEM_TTL_MS] - Max age in milliseconds for the item to be valid.
         * @returns {* | null} The cached data ('data' property of the stored entry) if found and fresh, otherwise null.
         */
        request.getCachedRequest = (hash, ttlMs = DEFAULT_CACHE_ITEM_TTL_MS) => {
            // 1. Validate Inputs
            if (!hash || typeof hash !== "string" || hash.trim() === "") {
                console.warn(`[getCachedRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid cache hash provided.`); // MDT Context - SLC, UT
                return null;
            }
            if (typeof ttlMs !== "number" || ttlMs < 0) {
                console.warn(`[getCachedRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid TTL (${ttlMs}ms) provided for hash "${hash}". Using default ${DEFAULT_CACHE_ITEM_TTL_MS}ms.`); // MDT Context - SLC, UT
                ttlMs = DEFAULT_CACHE_ITEM_TTL_MS;
            }

            try {
                // 2. Access module-scoped cache
                const cachedEntry = requestCache.get(hash);

                // 3. Check if entry exists and seems valid
                // Checks if it's an object with the expected properties set by cacheRequest
                if (cachedEntry && typeof cachedEntry === "object" && cachedEntry !== null && cachedEntry.hasOwnProperty("timestamp") && typeof cachedEntry.timestamp === "number" && cachedEntry.hasOwnProperty("data")) {
                    // 4. Check if entry is within its Time-To-Live (TTL)
                    const now = Date.now();
                    const ageMs = now - cachedEntry.timestamp;

                    if (ageMs < ttlMs) {
                        // Cache Hit & Fresh! Return the data.
                        // console.log(`[getCachedRequest] Cache hit for hash "${hash.substring(0,10)}..."`);
                        return cachedEntry.data;
                    } else {
                        // Cache Hit BUT STALE. Remove it and return null.
                        console.log(`[getCachedRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Stale cache entry removed for hash "${hash.substring(0, 10)}..." (Age: ${ageMs}ms, TTL: ${ttlMs}ms).`); // MDT Context - SLC, UT
                        requestCache.delete(hash);
                        return null;
                    }
                } else if (cachedEntry) {
                    // Entry exists but has unexpected format - treat as invalid and remove
                    console.warn(`[getCachedRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Removing malformed cache entry for hash "${hash.substring(0, 10)}..."`); // MDT Context - SLC, UT
                    requestCache.delete(hash);
                    return null;
                } else {
                    // Cache Miss - Key not found
                    return null;
                }
            } catch (error) {
                console.error(`[getCachedRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error retrieving cache for hash "${hash}":`, error); // MDT Context - SLC, UT
                return null; // Return null on any error
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on module-scoped 'requestCache' Map being defined.
    // Expects cache entries to be objects structured like { data: any, timestamp: number }
    // (as created by the improved request.cacheRequest function).
    // ---------------------------------

    // Attach the cacheRequest method conditionally
    // Consider if this should be a standalone utility function instead of attached to request.
    if (!request.hasOwnProperty("cacheRequest")) {
        /**
         * Stores data in a simple, module-level, in-memory cache with a basic size limit.
         * Includes a timestamp with the cached data. Evicts the oldest entry when full.
         * @param {string} hash - The unique key (e.g., derived from request details) for the cache entry.
         * @param {*} data - The data payload to cache. Avoid caching undefined.
         * @returns {boolean} True if the data was successfully cached, false otherwise.
         */
        request.cacheRequest = (hash, data) => {
            // 1. Validate inputs
            if (!hash || typeof hash !== "string" || hash.trim() === "") {
                console.warn(`[cacheRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid or empty cache hash provided.`); // MDT Context - SLC, UT
                return false;
            }
            // Avoid caching undefined, as it might indicate an error state elsewhere
            if (data === undefined) {
                console.warn(`[cacheRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Attempted to cache 'undefined' value for hash "${hash}". Caching skipped.`); // MDT Context - SLC, UT
                return false;
            }

            try {
                // 2. Basic Size Limit / Eviction (FIFO/Oldest Entry for Map)
                if (requestCache.size >= MAX_CACHE_ENTRIES) {
                    // Maps maintain insertion order. keys().next().value gets the first (oldest) key.
                    const oldestKey = requestCache.keys().next().value;
                    if (oldestKey) {
                        requestCache.delete(oldestKey);
                        console.log(`[cacheRequest] Cache limit (${MAX_CACHE_ENTRIES}) hit. Evicted oldest key: ${oldestKey.substring(0, 10)}...`);
                    }
                }

                // 3. Store the data along with a timestamp
                const cacheEntry = {
                    data: data,
                    timestamp: Date.now(), // Store timestamp for potential TTL checks later
                };
                requestCache.set(hash, cacheEntry);
                // console.log(`[cacheRequest @ ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/Denver'})}] Data cached for hash "${hash.substring(0, 10)}...". Size: ${requestCache.size}`); // MDT Context - SLC, UT
                return true; // Indicate success
            } catch (error) {
                // Catch potential errors during Map operations (though rare)
                console.error(`[cacheRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error setting cache entry for hash "${hash}":`, error); // MDT Context - SLC, UT
                return false; // Indicate failure
            }
        };
    }

    // --- Optional: Companion function to retrieve from cache (attach similarly or keep separate) ---
    /*
if (!request.hasOwnProperty('getCachedRequest')) {
    request.getCachedRequest = (hash, maxAgeMs = 5 * 60 * 1000) => { // Default 5 min TTL
        const entry = requestCache.get(hash);
        if (entry) {
            const age = Date.now() - entry.timestamp;
            if (age < maxAgeMs) {
                return entry.data; // Cache hit and fresh
            } else {
                // Stale entry found, remove it
                requestCache.delete(hash);
                console.log(`[getCachedRequest] Removed stale cache entry for hash "${hash.substring(0,10)}..."`);
            }
        }
        return null; // Not found or stale
    };
}
*/
    // --- End of attachment logic ---

    // Attach the isSecure method conditionally (renamed from 'secure' getter)
    if (!request.hasOwnProperty("isSecure")) {
        /**
         * Checks if the request was made over a secure (HTTPS) connection.
         * It checks for direct TLS encryption or the presence of a valid
         * X-Forwarded-Proto header set by a trusted proxy.
         * @returns {boolean} True if the request is considered secure, false otherwise.
         */
        request.isSecure = () => {
            // 1. Check for direct TLS connection (most reliable indicator)
            // Use optional chaining on 'connection' for robustness
            if (request.connection?.encrypted) {
                return true;
            }

            // 2. Check the X-Forwarded-Proto header (case-insensitive)
            // This relies on trusting the immediate upstream proxy.
            let xForwardedProto = null;
            const getHeaderFunc = request.getHeader; // Use helper if available

            if (typeof getHeaderFunc === "function") {
                try {
                    // Use getHeader for consistent case-insensitivity of lookup *name*
                    xForwardedProto = getHeaderFunc(HEADER_X_FORWARDED_PROTO);
                } catch (error) {
                    console.error(`Error reading ${HEADER_X_FORWARDED_PROTO} header for isSecure check near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context - SLC, UT
                }
            } else {
                // Fallback if getHeader not attached (less safe for header name casing)
                xForwardedProto = request.headers[HEADER_X_FORWARDED_PROTO];
            }

            if (typeof xForwardedProto === "string") {
                // Handle potential comma-separated values (take the first one)
                // Compare case-insensitively
                return xForwardedProto.split(",")[0].trim().toLowerCase() === PROTO_HTTPS_LOWERCASE;
            }

            // 3. If neither condition is met, consider it not secure
            return false;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES & NOTES ---
    // Relies on native request.connection.encrypted property.
    // Optionally uses request.getHeader if attached, otherwise direct header access.
    // ** The reliability of the X-Forwarded-Proto check depends entirely on whether
    // ** you trust your reverse proxy setup to set this header correctly and exclusively.
    // ** Misconfigured proxies can make this check insecure.
    // ---------------------------------------

    // Attach the 'accepts' method conditionally
    if (!request.hasOwnProperty("accepts")) {
        /**
         * Checks if the request's Accept header indicates compatibility with one or more
         * of the server-provided MIME types. Returns the best match based on client preference order
         * (simplified q-factor handling via sorting). Handles common shortcuts.
         * @param {...string|string[]} types - Server-supported MIME types, either as multiple string arguments
         * or a single array argument, listed in order of server preference.
         * @returns {string|false} The best matching type from the input list that the client accepts,
         * or false if none match. Returns the original string format provided by the caller.
         */
        request.accepts = (...types) => {
            // 1. Normalize function arguments into a single array 'serverPreferences'
            let serverPreferences = [];
            if (types.length === 1 && Array.isArray(types[0])) {
                serverPreferences = types[0]; // accepts(['a', 'b'])
            } else {
                serverPreferences = types; // accepts('a', 'b')
            }
            // Filter out any non-string types just in case
            serverPreferences = serverPreferences.filter((t) => typeof t === "string");

            if (serverPreferences.length === 0) {
                console.warn(`[accepts @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] No valid server types provided.`); // MDT Context - Salt Lake City, Utah
                return false;
            }

            // 2. Safely get and parse the client's Accept header
            let clientPreferences = []; // Array of { type: string, q: number, specificity: number }
            try {
                const acceptHeader = request.headers["accept"] || "*/*"; // Default to accepting anything if header missing

                clientPreferences = acceptHeader
                    .split(",")
                    .map((part, index) => {
                        const [typePart, ...qParts] = part.split(";");
                        const mimeType = typePart.trim().toLowerCase();
                        let q = 1.0;
                        // Basic q-factor parsing
                        const qStr = qParts.join(";").match(/q=([0-9\.]+)/)?.[1];
                        if (qStr !== undefined) {
                            q = parseFloat(qStr);
                            if (isNaN(q) || q > 1 || q < 0) q = 1.0; // Ignore invalid q
                        }

                        // Determine specificity for sorting when q is equal
                        let specificity = 3; // type/subtype
                        if (mimeType === "*/*") specificity = 1;
                        else if (mimeType.endsWith("/*")) specificity = 2;

                        return { type: mimeType, q: q, specificity: specificity, originalIndex: index };
                    })
                    .filter((item) => item.type && item.q > 0) // Remove invalid entries or q=0
                    .sort((a, b) => {
                        // Sort by q (desc), then specificity (desc), then original order (asc)
                        if (b.q !== a.q) return b.q - a.q;
                        if (b.specificity !== a.specificity) return b.specificity - a.specificity;
                        return a.originalIndex - b.originalIndex;
                    });
            } catch (error) {
                console.error(`[accepts @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error parsing Accept header:`, error); // MDT Context
                clientPreferences = [{ type: "*/*", q: 1.0, specificity: 1, originalIndex: 0 }]; // Default to accepting anything on error
            }

            // 3. Find the first server preference that matches a client preference
            for (const serverPref of serverPreferences) {
                if (!serverPref) continue; // Skip empty/invalid server types

                // Normalize server preference (handle shortcuts)
                let normalizedServerPref = serverPref.toLowerCase();
                if (normalizedServerPref === "json") normalizedServerPref = "application/json";
                else if (normalizedServerPref === "html") normalizedServerPref = "text/html";
                else if (normalizedServerPref === "text") normalizedServerPref = "text/plain";
                // Add more...

                // Check against sorted client preferences
                for (const clientPref of clientPreferences) {
                    // Direct match
                    if (clientPref.type === normalizedServerPref) return serverPref; // Return original case

                    // Client accepts type/* (e.g., 'text/*')
                    if (clientPref.type.endsWith("/*")) {
                        const clientBase = clientPref.type.slice(0, -2);
                        if (normalizedServerPref.startsWith(clientBase + "/")) return serverPref;
                    }

                    // Client accepts */*
                    if (clientPref.type === "*/*") return serverPref;

                    // Basic suffix match (e.g., '+json') - Limited usefulness in Accept
                    // if (normalizedServerPref.includes('+') && clientPref.type.includes(normalizedServerPref.substring(normalizedServerPref.indexOf('+')))) {
                    //     return serverPref;
                    // }
                }
            }

            // 4. No suitable match found
            return false;
        };
    }

    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies only on the native request.headers object.
    // Provides simplified Accept header negotiation. Ignores complex MIME ranges.
    // Handles basic q-factor sorting but doesn't implement full weighting logic.
    // ---------------------------------

    // Attach the 'is' method conditionally
    if (!request.hasOwnProperty("is")) {
        /**
         * Checks if the request's Content-Type header matches one of the given MIME types.
         * Performs basic MIME type parsing (ignores parameters like charset) and case-insensitive comparison.
         * Handles common shortcuts (e.g., 'json', 'html'). Supports basic suffix ('+json') and wildcard ('image/*') matching.
         * @param {string | string[]} type - A MIME type string (e.g., 'application/json', 'json') or an array of types.
         * @returns {string | false} The first matching type string from the input if found, otherwise false.
         */
        request.is = (type) => {
            // 1. Normalize input 'type' argument to an array
            let typesToCheck = [];
            if (typeof type === "string") {
                typesToCheck = [type];
            } else if (Array.isArray(type)) {
                typesToCheck = type;
            }

            if (typesToCheck.length === 0) {
                console.warn(`[is @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] No valid type(s) provided to check against.`); // MDT Context - Salt Lake City, Utah
                return false; // No types provided by caller
            }

            // 2. Safely get and parse the Content-Type header from the request
            let requestMimeType = ""; // Default to empty string
            try {
                const contentTypeHeader = request.headers["content-type"]; // Already lowercase from Node
                if (typeof contentTypeHeader === "string") {
                    // Take only the part before any ';' parameters and trim/lowercase
                    requestMimeType = contentTypeHeader.split(";")[0].trim().toLowerCase();
                }
            } catch (error) {
                console.error(`[is @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error accessing content-type header:`, error); // MDT Context - Salt Lake City, Utah
                return false; // Cannot determine type on error
            }

            // If no Content-Type header present, no match is possible
            if (!requestMimeType) {
                return false;
            }

            // 3. Iterate through the types provided by the caller
            for (const typeToCheck of typesToCheck) {
                if (typeof typeToCheck !== "string" || !typeToCheck) continue; // Skip invalid entries

                const normalizedCheck = typeToCheck.toLowerCase();

                // a. Handle common shortcuts explicitly
                let finalCheckType = normalizedCheck;
                if (normalizedCheck === "json") finalCheckType = "application/json";
                else if (normalizedCheck === "html") finalCheckType = "text/html";
                else if (normalizedCheck === "text") finalCheckType = "text/plain";
                else if (normalizedCheck === "urlencoded") finalCheckType = "application/x-www-form-urlencoded";
                else if (normalizedCheck === "multipart") finalCheckType = "multipart/form-data"; // Special handling below

                // b. Direct comparison
                if (requestMimeType === finalCheckType) return typeToCheck; // Return original provided type on match

                // c. Suffix check (e.g., application/vnd.api+json matching '+json' or 'json')
                if (normalizedCheck.startsWith("+")) {
                    // e.g., '+json'
                    if (requestMimeType.endsWith(normalizedCheck) || requestMimeType.endsWith("/" + normalizedCheck.substring(1))) {
                        return typeToCheck;
                    }
                } else if (normalizedCheck === "json" && requestMimeType.endsWith("+json")) {
                    // Handle shortcut matching suffix
                    return typeToCheck;
                } // Add similar for '+xml' etc. if needed

                // d. Wildcard check (e.g., 'image/*' matching 'image/png')
                if (finalCheckType.endsWith("/*")) {
                    const baseType = finalCheckType.slice(0, -2); // e.g., 'image'
                    if (requestMimeType.startsWith(baseType + "/")) {
                        return typeToCheck;
                    }
                }

                // e. Multipart check (needs special handling due to boundary)
                // Check if normalizedCheck was 'multipart/form-data' AND actual type starts with 'multipart/'
                if (finalCheckType === "multipart/form-data" && requestMimeType.startsWith("multipart/")) {
                    return typeToCheck;
                }
            } // End loop

            // 4. No match found after checking all provided types
            return false;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies only on the native request.headers object.
    // Provides more robust checking than simple string 'includes', but does not handle q-factors.
    // ---------------------------------

    // Attach the async compressResponse method conditionally
    // Note: Consider if this utility belongs on 'request', 'response', or standalone.
    if (!request.hasOwnProperty("compressResponse")) {
        /**
         * Asynchronously compresses the provided data using gzip or brotli.
         * @param {string | Buffer} data - The data to compress.
         * @param {string} [encoding='gzip'] - The compression type ('gzip' or 'br').
         * @returns {Promise<Buffer|null>} A promise resolving with the compressed Buffer,
         * or null if input/encoding is invalid or compression fails.
         */
        request.compressResponse = async (data, encoding = COMPRESSION_GZIP) => {
            // 1. Validate data input type
            if (typeof data !== "string" && !Buffer.isBuffer(data)) {
                const inputType = data === null ? "null" : typeof data;
                console.error(`[compressResponse @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid data type: Expected string or Buffer, received ${inputType}.`); // MDT Context
                return null; // Indicate failure
            }

            // 2. Validate encoding and create compressor
            const normalizedEncoding = String(encoding).toLowerCase();
            let compressor;
            try {
                if (normalizedEncoding === COMPRESSION_GZIP) {
                    compressor = zlib.createGzip();
                } else if (normalizedEncoding === COMPRESSION_BROTLI) {
                    if (typeof zlib.createBrotliCompress !== "function") {
                        throw new Error("Brotli compression (createBrotliCompress) is not supported in this Node.js environment.");
                    }
                    compressor = zlib.createBrotliCompress();
                } else {
                    throw new Error(`Unsupported encoding: '${encoding}'. Supported: ${SUPPORTED_COMPRESSIONS.join(", ")}.`);
                }
            } catch (initError) {
                console.error(`[compressResponse @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to initialize compressor:`, initError); // MDT Context
                return null; // Indicate failure
            }

            // 3. Use Promise to handle stream events
            return new Promise((resolve, reject) => {
                const compressedChunks = [];
                let streamError = null; // Hold error to reject after cleanup

                const cleanup = () => {
                    compressor.removeAllListeners();
                };

                compressor.on("data", (chunk) => compressedChunks.push(chunk));

                // Use 'finish' for writable/transform stream completion
                compressor.on("finish", () => {
                    cleanup();
                    if (streamError) {
                        reject(streamError); // Reject with error captured by 'error' listener
                    } else {
                        try {
                            resolve(Buffer.concat(compressedChunks)); // Resolve with concatenated Buffer
                        } catch (concatErr) {
                            reject(concatErr); // Reject if concat fails
                        }
                    }
                });

                compressor.on("error", (err) => {
                    streamError = err; // Capture error
                    // Don't reject immediately, let 'finish' handle it after cleanup
                });

                // 4. Write data and end the compression stream
                try {
                    compressor.end(data);
                } catch (writeError) {
                    // Catch rare synchronous errors during end()
                    cleanup(); // Ensure cleanup happens
                    reject(writeError);
                }
            });
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Requires the 'zlib' module. Checks for Brotli support.
    // Expects input data as string or Buffer. Returns Promise<Buffer|null>.
    // Callers MUST use await: `const compressed = await request.compressResponse(data, 'gzip');`
    // Consider the scope: Does this logically belong on the request object?
    // ---------------------------------

    // Attach the getDecompressedStream method conditionally
    if (!request.hasOwnProperty("getDecompressedStream")) {
        /**
         * Returns the appropriate readable stream for consuming the request body,
         * handling 'gzip' and 'br' Content-Encoding automatically.
         * If no encoding or unsupported encoding, returns the original request stream.
         * IMPORTANT: Body parsing logic must read from THIS stream.
         * @returns {Readable} The readable stream to consume for the request body.
         */
        request.getDecompressedStream = () => {
            const encoding = request.headers["content-encoding"]?.toLowerCase();

            try {
                if (encoding === "gzip") {
                    console.log(`[getDecompressedStream @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Providing gunzip stream.`); // MDT Context
                    const gunzip = zlib.createGunzip();
                    request.pipe(gunzip); // Pipe original request INTO gunzip
                    // Consumer must handle errors on 'gunzip' stream
                    return gunzip; // Return the gunzip stream
                } else if (encoding === "br") {
                    if (typeof zlib.createBrotliDecompress !== "function") {
                        console.error("Brotli decompression not supported in this Node.js version. Returning original stream.");
                        return request;
                    }
                    console.log(`[getDecompressedStream @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Providing brotli stream.`); // MDT Context
                    const brotli = zlib.createBrotliDecompress();
                    request.pipe(brotli); // Pipe original request INTO brotli
                    // Consumer must handle errors on 'brotli' stream
                    return brotli; // Return the brotli stream
                } else {
                    // No or unsupported encoding, return the original request stream
                    return request;
                }
            } catch (error) {
                console.error(`[getDecompressedStream @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error creating decompression stream:`, error); // MDT Context
                return request; // Fallback to original stream
            }
        };
    }
    // --- End of attachment logic ---

    // ---- Streaming body readers (DoS-safe, backpressure-aware) ----
    if (!request.hasOwnProperty("_readStreamToBuffer")) {
        request._readStreamToBuffer = ({ limit = MAX_REQUEST_BODY_SIZE, signal = request.signal } = {}) => {
            return new Promise((resolve, reject) => {
                const src = typeof request.getDecompressedStream === "function" ? request.getDecompressedStream() : request;
                const chunks = [];
                let size = 0;
                const onAbort = () => reject(request.signal.reason || new RequestAbortedError());
                if (signal?.aborted) return reject(signal.reason || new RequestAbortedError());
                signal?.addEventListener("abort", onAbort, { once: true });

                const cleanup = () => {
                    src.removeListener("data", onData);
                    src.removeListener("end", onEnd);
                    src.removeListener("error", onErr);
                    signal?.removeEventListener?.("abort", onAbort);
                };
                const onErr = (e) => {
                    cleanup();
                    reject(e);
                };
                const onData = (c) => {
                    size += c.length;
                    if (size > limit) {
                        cleanup();
                        return reject(new BodyTooLargeError(limit));
                    }
                    chunks.push(c);
                };
                const onEnd = () => {
                    cleanup();
                    resolve(Buffer.concat(chunks));
                };

                src.on("error", onErr);
                src.on("data", onData);
                src.on("end", onEnd);
            });
        };
    }
    if (!request.hasOwnProperty("raw")) {
        request.raw = async ({ limit = MAX_REQUEST_BODY_SIZE } = {}) => {
            const buf = await request._readStreamToBuffer({ limit, signal: request.signal });
            request._bytesRead = (request._bytesRead || 0) + buf.length;
            return buf;
        };
    }
    if (!request.hasOwnProperty("text")) {
        request.text = async ({ limit = MAX_REQUEST_BODY_SIZE, encoding = DEFAULT_BODY_ENCODING } = {}) => {
            const buf = await request._readStreamToBuffer({ limit, signal: request.signal });
            request._bytesRead = (request._bytesRead || 0) + buf.length;
            return buf.toString(encoding);
        };
    }
    if (!request.hasOwnProperty("json")) {
        request.json = async ({ limit = MAX_REQUEST_BODY_SIZE, strict = true, reviver = undefined, encoding = DEFAULT_BODY_ENCODING } = {}) => {
            const str = await request.text({ limit, encoding });
            if (!str || !str.trim()) return {};
            if (strict && /^[\u0000-\u001F]/.test(str)) throw new SyntaxError("Invalid JSON: leading control char");
            return JSON.parse(str, reviver);
        };
    }
    if (!request.hasOwnProperty("ndjson")) {
        request.ndjson = ({ mode = "loose" } = {}) => {
            const src = typeof request.getDecompressedStream === "function" ? request.getDecompressedStream() : request;
            const signal = request.signal;
            let buf = "";
            const decoder = new StringDecoder("utf8");
            const asyncIter = (async function* () {
                for await (const chunk of src) {
                    if (signal?.aborted) throw signal.reason || new RequestAbortedError();
                    buf += decoder.write(chunk);
                    let idx;
                    while ((idx = buf.indexOf("\n")) !== -1) {
                        const line = buf.slice(0, idx);
                        buf = buf.slice(idx + 1);
                        if (!line) continue;
                        try {
                            yield JSON.parse(line);
                        } catch (e) {
                            if (mode === "strict") throw e; /* else skip */
                        }
                    }
                }
                const rem = (buf + decoder.end()).trim();
                if (rem) {
                    if (mode === "strict") yield JSON.parse(rem);
                    else {
                        try {
                            yield JSON.parse(rem);
                        } catch {}
                    }
                }
            })();
            return asyncIter;
        };
    }

    if (!request.hasOwnProperty("range")) {
        request.range = (size, { combine = false, limit = 16 } = {}) => {
            const hdr = request.headers["range"];
            if (!hdr || typeof hdr !== "string") return null;
            const m = /^bytes=(.*)$/i.exec(hdr.trim());
            if (!m) throw new InvalidRangeHeaderError("Unsupported unit (only 'bytes')");
            const parts = m[1]
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            if (!parts.length) throw new InvalidRangeHeaderError();
            if (parts.length > limit) throw new InvalidRangeHeaderError("Too many ranges");
            const ranges = [];
            for (const p of parts) {
                const mm = /^(\d*)-(\d*)$/.exec(p);
                if (!mm) throw new InvalidRangeHeaderError(`Bad syntax: ${p}`);
                let start = mm[1] === "" ? NaN : Number(mm[1]);
                let end = mm[2] === "" ? NaN : Number(mm[2]);
                if (isNaN(start) && isNaN(end)) throw new InvalidRangeHeaderError(`Invalid pair: ${p}`);
                if (isNaN(start)) {
                    // suffix range - last 'end' bytes
                    const len = end;
                    if (len <= 0) continue;
                    start = Math.max(0, size - len);
                    end = size - 1;
                } else {
                    if (isNaN(end)) end = size - 1;
                    if (start > end) continue;
                    start = Math.max(0, start);
                    end = Math.min(size - 1, end);
                }
                if (start <= end) ranges.push({ start, end });
            }
            if (!ranges.length) return -1; // unsatisfiable
            if (combine && ranges.length > 1) {
                ranges.sort((a, b) => a.start - b.start);
                const merged = [ranges[0]];
                for (let i = 1; i < ranges.length; i++) {
                    const prev = merged[merged.length - 1];
                    const cur = ranges[i];
                    if (cur.start <= prev.end + 1) prev.end = Math.max(prev.end, cur.end);
                    else merged.push(cur);
                }
                return merged;
            }
            return ranges;
        };
    }

    if (!("cookies" in request) || request.cookies == null) {
        Object.defineProperty(request, "cookies", {
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.cookies) return c.cookies;
                return (c.cookies = parseCookies());
            },
        });
    }
    if (!("signedCookies" in request)) {
        Object.defineProperty(request, "signedCookies", {
            enumerable: true,
            get() {
                const c = request[kCache];
                if (c.signedCookies) return c.signedCookies;
                const out = Object.create(null);
                const secret = request[kCtx]?.cookie?.secret || process.env.COOKIE_SECRET || null;
                if (!secret) return (c.signedCookies = out);
                const cookies = request.cookies || {};
                for (const [k, v] of Object.entries(cookies)) {
                    const dot = v.lastIndexOf(".");
                    if (dot === -1) continue;
                    const raw = v.slice(0, dot);
                    const sigHex = v.slice(dot + 1);
                    try {
                        const h = crypto.createHmac("sha256", secret).update(raw).digest();
                        const provided = Buffer.from(sigHex, "hex");
                        if (provided.length === h.length && crypto.timingSafeEqual(provided, h)) out[k] = raw;
                    } catch {}
                }
                return (c.signedCookies = out);
            },
        });
    }

    if (!request.hasOwnProperty("stats")) {
        request.stats = () => {
            return {
                id: request.id ?? request.getId?.(),
                method: request.method,
                path: request.path,
                ip: request.ip,
                ips: request.ips,
                secure: request.secure,
                protocol: request.protocol,
                bytesRead: request._bytesRead || 0,
                deadlineMs: request.deadlineMs || 0,
                httpVersion: request.httpVersion,
            };
        };
    }
    if (!request.hasOwnProperty("explain")) {
        request.explain = () => {
            const remote = ipStripPort(request.socket?.remoteAddress || "");
            const xff = parseXFF(request.headers["x-forwarded-for"]);
            const ctx = request[kCtx] || {};
            const tp = isTrustedProxy(remote, ctx);
            const { host, hostname } = parseHostAndName(request);
            const bestAccept = typeof request.accepts === "function" ? request.accepts(["application/json", "text/html", "*/*"]) : null;
            return {
                ip: { remote, xff, trustProxy: !!ctx.trustProxy, proxyIsTrusted: tp, decided: request.ip },
                host: { authority: request.headers[":authority"], host, hostname },
                accepts: { header: request.headers["accept"] || "*/*", best: bestAccept },
                conditional: {
                    ifNoneMatch: request.ifNoneMatch || null,
                    ifModifiedSince: request.ifModifiedSince ? request.ifModifiedSince.toUTCString() : null,
                },
            };
        };
    }

    // --- How to USE this ---
    // Modify your body reading helpers (like _readStreamToStringHelper)
    // to accept a stream argument, and call getDecompressedStream first:

    /* Example inside request.parseBodyString:
       ...
       const streamToRead = request.getDecompressedStream(); // <<< Get the correct stream
       request._parsingBodyPromise = _readStreamToStringHelper(streamToRead, ...) // <<< Pass it to the reader
           .then(...)
           .catch(...);
       return request._parsingBodyPromise;
       ...
    */

    // Attach the getValidationErrors method conditionally
    if (!request.hasOwnProperty("getValidationErrors")) {
        /**
         * Retrieves the array of validation error messages recorded for the request.
         * Guarantees an array is returned (empty if no errors or if not initialized).
         * @returns {Array<string>} An array of validation error messages.
         */
        request.getValidationErrors = () => {
            // 1. Check if validationErrors exists and is an array
            if (Array.isArray(request.validationErrors)) {
                // If yes, return the actual array
                return request.validationErrors;
            } else {
                // 2. If not an array (e.g., undefined, null, or something else),
                //    return an empty array to provide a consistent return type.
                console.warn(`[getValidationErrors @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] request.validationErrors was not found or not an array. Returning [].`); // MDT Context - Salt Lake City
                return [];
            }

            // Alternate concise version:
            // return Array.isArray(request.validationErrors) ? request.validationErrors : [];
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.validationErrors being initialized (usually as []) and potentially populated
    // by other methods like request.validateSchema. For best results, ensure request.validationErrors = []
    // is set before validation logic runs.
    // ---------------------------------

    // Attach the hasValidationErrors method conditionally
    if (!request.hasOwnProperty("hasValidationErrors")) {
        /**
         * Checks if the `request.validationErrors` array exists and contains any errors.
         * @returns {boolean} True if one or more validation errors have been recorded, false otherwise.
         */
        request.hasValidationErrors = () => {
            // 1. Safely check if validationErrors is an array and has elements
            // Array.isArray() handles null/undefined checks implicitly
            if (Array.isArray(request.validationErrors)) {
                // If it's an array, check its length
                return request.validationErrors.length > 0;
            }

            // 2. If request.validationErrors isn't an array (or doesn't exist),
            //    then there are no recorded validation errors.
            return false;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.validationErrors being initialized (e.g., as an empty array [])
    // and potentially populated by other methods like request.validateSchema.
    /* Example prerequisite during initialization or validation:
       // Ensures the array exists even if no validation runs or adds errors
       request.validationErrors = request.validationErrors || [];
       // ... validation logic potentially pushes errors ...
    */
    // ---------------------------------

    // Attach the hashData method conditionally
    // Consider if this utility belongs on 'request' or as a standalone helper.
    if (!request.hasOwnProperty("hashData")) {
        /**
         * Creates a SHA-256 hash of the provided data (string or Buffer).
         * Suitable for checksums, simple data integrity checks.
         * !!! NOT suitable for password hashing without proper salting and key derivation !!!
         * @param {string | Buffer} data - The data to be hashed.
         * @returns {string | null} The resulting SHA-256 hash as a hexadecimal string, or null on error/invalid input.
         */
        request.hashData = (data) => {
            // 1. Validate Input Data Type
            if (typeof data !== "string" && !Buffer.isBuffer(data)) {
                const inputType = data === null ? "null" : typeof data;
                console.warn(`[hashData @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid input type: Expected string or Buffer, received ${inputType}.`); // MDT Context
                return null; // Cannot hash non-string/non-buffer
            }

            // 2. Generate Hash Safely
            try {
                const hash = crypto
                    .createHash("sha256")
                    .update(data) // data is now confirmed string or Buffer
                    .digest("hex");
                return hash;
            } catch (error) {
                console.error(`[hashData @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error during SHA-256 hashing:`, error); // MDT Context
                return null; // Return null on hashing failure
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Requires the 'crypto' module to be imported.
    // Expects input to be a string or Buffer.
    // ---------------------------------

    // Attach the getCookie method conditionally
    if (!request.hasOwnProperty("getCookie")) {
        /**
         * Retrieves the value of a specific cookie by its name.
         * Assumes request.cookies object has already been populated (e.g., by parseCookies).
         * @param {string} name - The name of the cookie to retrieve.
         * @returns {string | null} The cookie's value (decoded string), or null if not found or name/cookies invalid.
         */
        request.getCookie = (name) => {
            // 1. Validate input name
            if (!name || typeof name !== "string") {
                console.warn(`[getCookie @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid cookie name requested:`, name); // MDT Context
                return null;
            }

            // 2. Check if the cookies object exists and is valid
            const cookies = request.cookies; // Assumes populated earlier
            if (!cookies || typeof cookies !== "object" || cookies === null) {
                // console.warn(`[getCookie @ ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/Denver'})}] request.cookies object not found or invalid.`); // MDT Context
                return null;
            }

            // 3. Retrieve the value using the name
            const cookieValue = cookies[name];

            // 4. Return the value or null if it's undefined or null
            // Using ?? ensures existing empty strings "" are returned correctly.
            return cookieValue ?? null;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.cookies object being populated beforehand, typically by calling
    // request.parseCookies() during request initialization.
    /* Example prerequisite within initialization:
    if (!request.hasOwnProperty('parseCookies')) { // Define parser first... }
    if (!request.hasOwnProperty('cookies')) {
        request.cookies = request.parseCookies(); // ...then call it here.
    }
    */
    // ---------------------------------

    // Attach the getHeader method conditionally
    if (!request.hasOwnProperty("getHeader")) {
        /**
         * Retrieves a specific request header's value by its name (case-insensitive lookup).
         * @param {string} name - The name of the header (e.g., 'Content-Type', 'User-Agent').
         * @returns {string | null} The value of the header, or null if the header is not found or the name is invalid.
         */
        request.getHeader = (name) => {
            // 1. Validate the input header name
            if (!name || typeof name !== "string") {
                console.warn(`[getHeader @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid header name requested:`, name); // MDT Context
                return null; // Return null for invalid names
            }

            // 2. Access the native headers object (Node.js stores keys as lowercase)
            //    Convert the input name to lowercase for the lookup.
            const headerValue = request.headers[name.toLowerCase()];

            // 3. Return the value found, or null if it was undefined (header not present)
            //    Using nullish coalescing (??) is a concise way to do this.
            return headerValue ?? null;
            // Equivalent to: return headerValue !== undefined ? headerValue : null;
        };
    }

    if (!request.hasOwnProperty("get")) request.get = request.header || request.getHeader;

    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies only on the native request.headers object provided by Node.js http.
    // ---------------------------------

    // Attach the async parseMultipartData method conditionally
    if (!request.hasOwnProperty("parseMultipartData")) {
        /**
         * Asynchronously parses multipart/form-data request bodies.
         * >>> WARNING <<<: Implementing a robust, secure, and efficient multipart parser
         * without external libraries is EXTREMELY COMPLEX and generally NOT recommended.
         * This function provides the basic structure but OMITS the core stream parsing logic.
         * Consider using a library like 'busboy' if multipart support is needed.
         * Attempts to cache the result/promise.
         * @returns {Promise<{fields: object, files: object}|null>} A promise resolving
         * with an object containing 'fields' and 'files', or null on error/unimplemented.
         */
        request.parseMultipartData = async () => {
            // 1. Idempotency Check (Return cached result or promise)
            if (request._multipartData !== undefined) return request._multipartData;
            if (request._parsingMultipartPromise) return request._parsingMultipartPromise;

            // 2. Validate Content-Type and Extract Boundary Safely
            let boundary = null;
            try {
                const contentTypeHeader = request.getHeader ? request.getHeader("content-type") || "" : request.headers["content-type"] || "";
                if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
                    throw new Error("Content-Type is not multipart/form-data.");
                }
                // Regex to find boundary=value, handling optional quotes around value
                const boundaryMatch = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^";\s]+))/i);
                if (!boundaryMatch) {
                    throw new Error("Boundary not found in Content-Type header.");
                }
                boundary = "--" + (boundaryMatch[1] || boundaryMatch[2]); // Use captured group
            } catch (error) {
                console.error(`[parseMultipartData @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid Content-Type or boundary:`, error.message); // MDT Context
                request._multipartData = null; // Cache null
                return null;
            }

            // 3. Create and store the promise
            request._parsingMultipartPromise = new Promise(async (resolve, reject) => {
                const fields = {};
                const files = {}; // Structure would contain file streams, paths, info etc.

                // !!! --- CORE MULTIPART STREAM PARSING LOGIC --- !!!
                // !!! --- OMITTED - HIGHLY COMPLEX & ERROR-PRONE --- !!!
                // !!! ---     REQUIRES STATE MACHINE, BUFFER       --- !!!
                // !!! ---     HANDLING, BOUNDARY DETECTION IN      --- !!!
                // !!! ---     CHUNKS, PART HEADER PARSING, FILE    --- !!!
                // !!! ---     STREAMING/BUFFERING WITH LIMITS.     --- !!!
                // !!! --- STRONGLY RECOMMEND USING A LIBRARY       --- !!!
                // !!! -------------------------------------------- !!!

                // Rejecting immediately as it's not implemented
                const notImplementedError = new Error("Robust zero-dependency multipart stream parsing is not implemented. Use a library.");
                console.error(`[parseMultipartData @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] ${notImplementedError.message}`); // MDT Context
                reject(notImplementedError);

                // --- If you were to attempt it (pseudo-code, very simplified): ---
                /*
                let state = 'START'; // State machine state
                let currentHeaders = {};
                let currentFieldName = null;
                let currentFileStream = null; // e.g., fs.createWriteStream
                let buffer = Buffer.alloc(0);
    
                request.on('data', chunk => {
                    buffer = Buffer.concat([buffer, chunk]);
                    // Process buffer to find boundaries, headers, data parts
                    // Update state, extract fields, pipe file data to streams
                    // Apply size limits!
                });
                request.on('end', () => {
                    // Process any remaining buffer
                    // Close file streams etc.
                    resolve({ fields, files });
                });
                request.on('error', reject);
                */
                // --- End Pseudo-code ---
            })
                .then((result) => {
                    request._multipartData = result; // Cache result on success
                    delete request._parsingMultipartPromise;
                    return result;
                })
                .catch((error) => {
                    request._multipartData = null; // Cache null on error
                    delete request._parsingMultipartPromise;
                    throw error; // Re-throw error for the caller
                });

            return request._parsingMultipartPromise;
        };
    }
    // --- End of attachment logic ---

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the async parseUrlEncodedForm method conditionally
    if (!request.hasOwnProperty("parseUrlEncodedForm")) {
        /**
         * Asynchronously parses the request body as x-www-form-urlencoded data.
         * Relies on request.parseBodyString() to read the complete body stream first.
         * Handles parsing errors gracefully.
         * @returns {Promise<object|null>} A promise resolving to the parsed form data object
         * (e.g., { key: 'value' }), an empty object for an empty body, or null on error.
         */
        request.parseUrlEncodedForm = async () => {
            // 1. Check for prerequisite string parser helper
            if (typeof request.parseBodyString !== "function") {
                const err = new Error("Dependency 'request.parseBodyString' is missing.");
                console.error(`[parseUrlEncodedForm @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] ${err.message}`); // MDT Context
                return null; // Cannot proceed without it
            }

            let parsedResult = null;

            try {
                // 2. Get the full body string via the helper (handles stream errors, size limits, cache)
                const bodyString = await request.parseBodyString();

                // 3. Handle cases where body string couldn't be retrieved
                if (bodyString === null || bodyString === undefined) {
                    console.log(`[parseUrlEncodedForm] Body string was null or undefined. Returning null.`);
                    return null; // Indicate failure to get body
                }

                // 4. Attempt to parse the string as form data
                try {
                    // querystring.parse handles empty string gracefully, returning {}
                    parsedResult = querystring.parse(bodyString);
                    // console.log(`[parseUrlEncodedForm] Successfully parsed form body.`);
                } catch (parseError) {
                    // Although querystring.parse is robust, catch potential edge cases
                    console.error(`[parseUrlEncodedForm @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error parsing form body string:`, parseError); // MDT Context
                    request.validationErrors = request.validationErrors || [];
                    request.validationErrors.push(`Invalid Form URL Encoded body format: ${parseError.message}`);
                    parsedResult = {}; // Default to empty object on error for forms? Or null? Let's use {}
                }
            } catch (bodyError) {
                // Handle errors from awaiting parseBodyString() itself
                console.error(`[parseUrlEncodedForm @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to get body string via parseBodyString:`, bodyError.message); // MDT Context
                parsedResult = null; // Indicate failure to get body
            }

            // 5. Return the parsed object ({}, actual data, or null)
            return parsedResult;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.parseBodyString being attached and functional (async).
    // Requires the 'querystring' module (built-in) or the 'qs' library.
    // Does NOT populate request.body directly; the caller (e.g., handleDataParsing) should do that.
    // Callers MUST use await: `const formData = await request.parseUrlEncodedForm();`
    // ---------------------------------

    // Attach the async parseJsonBody method conditionally
    if (!request.hasOwnProperty("parseJsonBody")) {
        /**
         * Asynchronously parses the request body as JSON.
         * Relies on request.parseBodyString() to read the complete body stream first.
         * Handles JSON parsing errors and empty body strings.
         * Adds errors to request.validationErrors on parse failure.
         * @returns {Promise<object|null>} A promise resolving to the parsed JSON object,
         * an empty object for an empty body, or null if body reading/parsing fails.
         */
        request.parseJsonBody = async () => {
            // 1. Check for prerequisite string parser
            if (typeof request.parseBodyString !== "function") {
                const err = new Error("Dependency 'request.parseBodyString' is missing.");
                console.error(`[parseJsonBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] ${err.message}`); // MDT Context
                return null;
            }

            let parsedResult = null;

            try {
                // 2. Get the full body string via the helper (handles stream errors, size limits, caching)
                const bodyString = await request.parseBodyString();

                // 3. Handle cases where body string retrieval failed or body was empty
                if (bodyString === null || bodyString === undefined) {
                    // Error likely occurred in parseBodyString (already logged)
                    return null;
                }
                if (bodyString.trim() === "") {
                    // Treat empty body as an empty JSON object
                    return {};
                }

                // 4. Attempt to parse the JSON string
                try {
                    parsedResult = JSON.parse(bodyString);
                } catch (parseError) {
                    // Handle JSON.parse errors specifically
                    console.error(`[parseJsonBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error parsing JSON body string:`, parseError.message); // MDT Context
                    request.validationErrors = request.validationErrors || [];
                    request.validationErrors.push(`Invalid JSON format in request body: ${parseError.message}`);
                    parsedResult = null; // Indicate parsing failure
                }
            } catch (bodyError) {
                // Handle errors from awaiting parseBodyString itself
                console.error(`[parseJsonBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to get body string via parseBodyString:`, bodyError.message); // MDT Context
                parsedResult = null;
            }

            // 5. Return the final result
            return parsedResult;
        };
    }
    // --- End of attachment logic ---
    // Attach the parseQuery method conditionally
    if (!request.hasOwnProperty("parseQuery")) {
        /**
         * Parses the URL query string into an object.
         * Provides *basic* support for *only one level* of nesting using the
         * exact format 'parentKey[childKey]=value'. Deeper nesting or array
         * formats ('key[]=value') are NOT supported by this basic parser.
         * For complex query strings, consider using a dedicated library if dependencies allow.
         * @returns {object} The parsed query object. Returns empty {} if URL parsing fails.
         */
        request.parseQuery = () => {
            const finalQuery = {};

            try {
                // 1. Safely construct the URL object
                // Use native request properties, provide fallbacks
                const host = request.headers?.host || "localhost";
                const baseUrl = `http://${host}`; // Base required by URL constructor if request.url is just a path
                const urlString = request.url || "/";
                const parsedUrlObject = new URL(urlString, baseUrl);

                // 2. Use URLSearchParams for robust flat parameter extraction
                const flatParams = Object.fromEntries(parsedUrlObject.searchParams.entries());

                // 3. Process flat params for basic 'key[child]' nesting
                // This regex specifically looks for key[child] pattern
                const nestingRegex = /^([^\[\]]+)\[([^\[\]]+)\]$/;

                for (const [key, value] of Object.entries(flatParams)) {
                    const match = key.match(nestingRegex);

                    if (match && match[1] && match[2]) {
                        // Simple nesting detected: key is like 'parent[child]'
                        const parentKey = match[1]; // e.g., 'user'
                        const childKey = match[2]; // e.g., 'name'

                        // Ensure the parent object exists in the result
                        if (!finalQuery[parentKey] || typeof finalQuery[parentKey] !== "object") {
                            finalQuery[parentKey] = {};
                        }
                        // Assign the nested value
                        finalQuery[parentKey][childKey] = value;
                    } else {
                        // No nesting pattern matched, assign directly
                        finalQuery[key] = value;
                    }
                }
            } catch (error) {
                console.error(`[parseQuery @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error parsing URL or query string for "${request.url}": ${error.message}`); // MDT Context
                // Return an empty object in case of errors to prevent downstream issues
                return {};
            }

            return finalQuery;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT USAGE NOTE ---
    // Like parseCookies, this function *calculates* the query object.
    // Call it once during initialization to populate request.query.
    /* Example inside module.exports = (request, response) => { ...
        // ... other init ...
        if (!request.hasOwnProperty('query')) {
            request.query = request.parseQuery(); // Call the function
        }
        // ... now request.query is available ...
    };
    */
    // ---------------------------

    // Attach the parseCookies method conditionally
    if (!request.hasOwnProperty("parseCookies")) {
        /**
         * Parses the 'Cookie' header string into an object of key-value pairs.
         * Handles basic URL-decoding of values and trims whitespace.
         * Returns an empty object if the header is missing or invalid.
         * Note: Does not handle complex cookie attributes or advanced syntax.
         * @returns {object} The parsed cookies.
         */
        request.parseCookies = () => {
            const cookieData = {};
            // Node.js automatically makes request.headers keys lowercase
            const cookieHeader = request.headers["cookie"];

            if (typeof cookieHeader === "string") {
                cookieHeader.split(";").forEach((cookieString) => {
                    const trimmedString = cookieString.trim();
                    // Find the index of the first '='
                    const separatorIndex = trimmedString.indexOf("=");

                    // If '=' is found and it's not the first character
                    if (separatorIndex > 0) {
                        const key = trimmedString.substring(0, separatorIndex);
                        // Everything after the first '=' is the value
                        let value = trimmedString.substring(separatorIndex + 1);

                        // Attempt to decode the value, handling potential errors
                        try {
                            // Replace '+' with space before decoding (common in cookies/forms)
                            value = value.replace(/\+/g, " ");
                            value = decodeURIComponent(value);
                        } catch (e) {
                            // Log the error but keep the original (undecoded) value?
                            console.error(`[parseCookies @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to decode cookie value for key "${key}". Using raw value. Error: ${e.message}`); // MDT Context
                            // Value remains the original substring if decode fails
                        }
                        // Allow later cookies to overwrite earlier ones with the same name (standard behavior)
                        cookieData[key] = value;
                    } else if (trimmedString.length > 0) {
                        // Handle cookie flags (keys without values) - assign empty string or true? Empty string is common.
                        cookieData[trimmedString] = "";
                    }
                });
            }

            // Return the parsed object (will be {} if header was missing/empty)
            return cookieData;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT USAGE NOTE ---
    // This function *calculates* the cookies. To use them easily, you should call
    // this once during initialization and attach the result to the request:
    /* Example inside module.exports = (request, response) => { ...
        // ... other init ...
        if (!request.hasOwnProperty('cookies')) {
            // Define the parser method first (as above)
            // Then call it to populate request.cookies
            request.cookies = request.parseCookies();
        }
        // Now other methods can access request.cookies directly
        // ...
    };
    */
    // ---------------------------
    // Attach the async parseBodyFromJsonOrForm method conditionally
    // Renamed to be more specific about what it handles based on flags
    if (!request.hasOwnProperty("parseBodyFromJsonOrForm")) {
        /**
         * Asynchronously parses the request body as JSON or x-www-form-urlencoded,
         * determined by the request._isJson flag (assumes _isForm if not _isJson).
         * It retrieves the full body string using request.parseBodyString first.
         * Returns null if the body cannot be retrieved or parsed correctly,
         * or if the type flags indicate neither JSON nor Form.
         * Adds validation errors on parse failure.
         * @returns {Promise<object|null>} A promise resolving to the parsed object or null.
         */
        request.parseBodyFromJsonOrForm = async () => {
            // 1. Check prerequisite helper function
            if (typeof request.parseBodyString !== "function") {
                const err = new Error("Dependency 'request.parseBodyString' is missing.");
                console.error(`[parseBodyFromJsonOrForm @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] ${err.message}`); // MDT Context
                // Cannot proceed without the body string parser
                return null;
            }

            // 2. Determine expected type based on flags (assumed to be set)
            const isJson = request._isJson ?? false;
            const isForm = request._isForm ?? false; // Check this flag too

            // This function only handles these two types based on flags
            if (!isJson && !isForm) {
                console.log(`[parseBodyFromJsonOrForm] Flags indicate body is neither JSON nor Form. Skipping specific parsing.`);
                return null; // Or perhaps return raw string? For now, null.
            }

            let parsedResult = null;

            try {
                // 3. Get the full, cached body string (handles stream reading/errors/size limit)
                const bodyString = await request.parseBodyString();

                // 4. Attempt parsing only if body string exists and isn't empty
                if (bodyString && typeof bodyString === "string") {
                    // Check non-empty? bodyString.trim() !== ''
                    try {
                        if (isJson) {
                            parsedResult = JSON.parse(bodyString);
                            console.log(`[parseBodyFromJsonOrForm] Parsed JSON body.`);
                        } else {
                            // isForm
                            parsedResult = querystring.parse(bodyString);
                            console.log(`[parseBodyFromJsonOrForm] Parsed Form URL Encoded body.`);
                        }
                    } catch (parseError) {
                        // Handle JSON.parse or qs.parse errors
                        console.error(`[parseBodyFromJsonOrForm @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error parsing body string as ${isJson ? "JSON" : "Form"}:`, parseError.message); // MDT Context
                        request.validationErrors = request.validationErrors || [];
                        request.validationErrors.push(`Invalid ${isJson ? "JSON" : "Form"} body format.`);
                        parsedResult = null; // Indicate failure
                    }
                } else if (bodyString === "") {
                    // Body was explicitly empty, provide default empty object
                    parsedResult = {};
                    console.log(`[parseBodyFromJsonOrForm] Body string was empty, returning empty object.`);
                }
                // else: bodyString is null (error handled by parseBodyString), parsedResult remains null
            } catch (bodyStringError) {
                // Handle errors from awaiting parseBodyString() itself (e.g., size limit exceeded)
                console.error(`[parseBodyFromJsonOrForm @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to get body string via parseBodyString:`, bodyStringError.message); // MDT Context
                parsedResult = null;
            }

            // 5. Return the parsed result (or null)
            return parsedResult;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on flags like request._isJson / request._isForm being set correctly.
    // Relies crucially on request.parseBodyString being attached and functional (async).
    // Requires 'querystring' module for form parsing.
    // Callers MUST use await: `const parsed = await request.parseBodyFromJsonOrForm();`
    // This function likely duplicates logic now better placed within the improved handleDataParsing.
    // Consider consolidating unless a specific separate trigger is needed.
    // ---------------------------------

    // Attach the async handleDataParsing method conditionally
    if (!request.hasOwnProperty("handleDataParsing")) {
        /**
         * Asynchronously determines the body parser based on Content-Type flags,
         * parses the request body using appropriate helpers, and populates `request.body`.
         * Idempotent due to underlying parser caching.
         * @returns {Promise<void>} A promise that resolves when parsing is attempted,
         * allowing caller to await completion. `request.body` holds the result.
         */
        request.handleDataParsing = async () => {
            // 1. Check if body has potentially already been parsed (optional, relies on underlying cache mainly)
            // Use undefined check to distinguish from explicitly parsed null body
            if (request.body !== undefined) {
                // console.log(`[handleDataParsing @ ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/Denver'})}] Body already processed/cached. Current value:`, request.body); // MDT Context
                return; // Already handled
            }

            // Initialize body to null before parsing attempt
            request.body = null;

            // 2. Get Content-Type flags (assumed to be set earlier)
            const isJson = request._isJson ?? false;
            const isForm = request._isForm ?? false;
            const isMultipart = request._isMultipart ?? false;

            console.log(`[handleDataParsing @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Attempting to parse based on flags - Json:${isJson}, Form:${isForm}, Multipart:${isMultipart}`); // MDT Context

            try {
                // 3. Handle JSON or Form types (require reading the raw body string first)
                if (isJson || isForm) {
                    if (typeof request.parseBodyString !== "function") {
                        throw new Error("Required helper 'parseBodyString' not found on request object.");
                    }
                    // Await the raw body string (handles stream reading, size limits, caching)
                    const bodyString = await request.parseBodyString();

                    // Proceed only if body string was successfully retrieved
                    if (bodyString !== null && bodyString !== undefined) {
                        try {
                            if (isJson) {
                                // Handle potentially empty JSON string
                                request.body = bodyString.trim() === "" ? {} : JSON.parse(bodyString);
                            } else {
                                // isForm
                                request.body = querystring.parse(bodyString);
                            }
                            console.log(`[handleDataParsing] Successfully parsed ${isJson ? "JSON" : "Form"} body.`);
                        } catch (parseError) {
                            console.error(`[handleDataParsing @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error parsing ${isJson ? "JSON" : "Form"} body string:`, parseError); // MDT Context
                            request.validationErrors = request.validationErrors || [];
                            request.validationErrors.push(`Invalid ${isJson ? "JSON" : "Form"} body format.`);
                            request.body = null; // Set body to null on parse failure
                        }
                    } else {
                        // parseBodyString returned null (e.g., stream error, empty body?)
                        // Set body based on content type for empty body
                        console.log(`[handleDataParsing] Body string was null or undefined for ${isJson ? "JSON" : "Form"}. Setting body to empty object.`);
                        request.body = {}; // Treat empty body as empty object for JSON/Form
                    }
                }
                // 4. Handle Multipart (delegate to a dedicated async parser)
                else if (isMultipart) {
                    if (typeof request.parseMultipartData === "function") {
                        console.log(`[handleDataParsing] Delegating to parseMultipartData...`);
                        // This assumes parseMultipartData reads the stream and returns { fields, files }
                        // It should also handle its own caching/idempotency if needed
                        request.body = await request.parseMultipartData();
                    } else {
                        console.warn(`[handleDataParsing] Multipart request detected but 'parseMultipartData' function not found.`);
                        request.body = null;
                    }
                }
                // 5. Handle other types (leave body as null, or potentially parse raw string)
                else {
                    console.log(`[handleDataParsing] No specific parser for Content-Type flags. Body remains null.`);
                    // If you wanted the raw string for text/plain etc., you could call parseBodyString here:
                    // request.body = await request.parseBodyString();
                    request.body = null; // Keep null if not JSON, Form, or Multipart handled
                }
            } catch (error) {
                // Catch errors from awaiting helpers (e.g., parseBodyString stream error)
                console.error(`[handleDataParsing @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error during body parsing process for IP ${request.ip}:`, error); // MDT Context
                request.body = null; // Ensure body is null on error
            }
            // No explicit value needs to be returned, caller awaits completion, then checks request.body
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on flags like request._isJson, _isForm, _isMultipart being set correctly.
    // Relies on helper methods like request.parseBodyString (async) and potentially
    // request.parseMultipartData (async) being attached and functional.
    // Requires 'querystring' module for form parsing.
    // Populates request.body with the parsed result or null.
    // Callers MUST use await: `await request.handleDataParsing(); const body = request.body;`
    // ---------------------------------

    // --- Example of how request.parseBodyString could use this helper ---
    // --- Place this INSIDE module.exports = (request, response) => { ... } ---
    /*
    if (!request.hasOwnProperty('parseBodyString')) {
        request.parseBodyString = async (encoding = DEFAULT_BODY_ENCODING_HELPER) => {
            // Check cache/existing promise first (lazy loading)
            if (request._rawBodyString !== undefined) return request._rawBodyString;
            if (request._parsingBodyPromise) return request._parsingBodyPromise;
    
            // Use the helper, store the promise
            request._parsingBodyPromise = _readStreamToStringHelper(request, MAX_BODY_SIZE_HELPER, encoding)
                .then(bodyStr => {
                    request._rawBodyString = bodyStr; // Cache result
                    delete request._parsingBodyPromise; // Clean up promise ref
                    return bodyStr;
                })
                .catch(err => {
                    request._rawBodyString = null; // Cache null on error
                    delete request._parsingBodyPromise;
                    throw err; // Re-throw error for caller to handle
                });
    
            return request._parsingBodyPromise;
        };
    }
    */
    // Attach the initializeRequest method conditionally
    if (!request.hasOwnProperty("initializeRequest")) {
        /**
         * Performs initial synchronous setup on the request object:
         * - Normalizes request.method to uppercase.
         * - Parses the URL and attaches query parameters to request.query.
         * IMPORTANT: This does NOT parse the request body (use async methods like autoParseBody for that).
         */
        request.initializeRequest = () => {
            console.log(`[initializeRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Initializing request...`); // MDT Context

            // 1. Normalize HTTP Method (store uppercase version)
            // Ensures consistent checks later (e.g., request.method === 'GET')
            request.method = (request.method || "").toUpperCase();

            // 2. Parse URL and Query Parameters safely
            try {
                // Use request.headers (native), provide fallback for host
                const host = request.headers?.host || "localhost";
                // Construct a valid base URL - assume http unless you have logic for https
                const baseUrl = `http://${host}`;
                // Use request.url (native), provide fallback
                const urlString = request.url || "/";

                const parsedUrl = new URL(urlString, baseUrl);

                // Attach parsed query parameters object to the request
                request.query = Object.fromEntries(parsedUrl.searchParams.entries());

                // Optionally attach other useful URL parts:
                // request.pathname = parsedUrl.pathname;
                // request.hostname = parsedUrl.hostname;
                // request.port = parsedUrl.port;
            } catch (error) {
                console.error(`[initializeRequest @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to parse URL "${request.url}":`, error); // MDT Context
                // Ensure request.query is at least an empty object on failure
                request.query = {};
            }

            // 3. Optional: Check if the method is standard (using normalized method)
            // const isStandardMethod = http.METHODS.includes(request.method);
            // You could store this if needed: request._isStandardMethod = isStandardMethod;

            // --- Body parsing is ASYNCHRONOUS and should NOT be triggered here ---
            // Call `await request.autoParseBody()` or specific parser later when body is needed.
            // console.log(`[initializeRequest] Request ${request.method} ${request.url} initialized (body not parsed yet).`);
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on native request.url, request.method, request.headers.
    // Attaches request.query object.
    // Normalizes request.method to uppercase.
    // It does NOT parse the request body.
    // ---------------------------------
    // Attach the isRateLimited method conditionally
    if (!request.hasOwnProperty("isRateLimited")) {
        /**
         * Checks if a given identifier has exceeded a request rate limit within a time window.
         * Uses a sliding window approach based on timestamps stored in memory.
         * @param {string} identifier - A unique string for the entity being limited (e.g., IP, API key).
         * @param {number} [limit=DEFAULT_RATE_LIMIT_THRESHOLD] - Max requests allowed in the window.
         * @param {number} [windowMs=DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS] - Window duration in ms.
         * @returns {boolean} True if the rate limit is exceeded (should block), false otherwise.
         */
        request.isRateLimited = (identifier, limit = DEFAULT_RATE_LIMIT_THRESHOLD, windowMs = DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS) => {
            // 1. Validate the identifier
            if (!identifier || typeof identifier !== "string" || identifier.trim() === "") {
                console.warn(`[isRateLimited @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Invalid identifier provided: "${identifier}". Cannot rate limit.`); // MDT Context
                // Decide behavior: block unknown or allow? Allow seems safer.
                return false;
            }

            const now = Date.now();

            // 2. Get previous timestamps for this identifier
            const previousTimestamps = rateLimit.get(identifier) || [];

            // 3. Filter out timestamps older than the window duration
            const recentTimestamps = previousTimestamps.filter((time) => now - time < windowMs);

            // 4. Add the timestamp for the current request
            recentTimestamps.push(now);

            // 5. Update the stored timestamps for this identifier
            rateLimit.set(identifier, recentTimestamps);

            // 6. Check if the count NOW exceeds the limit
            const isExceeded = recentTimestamps.length > limit;

            // Optional logging when limit is first exceeded
            if (isExceeded && recentTimestamps.length === limit + 1) {
                console.warn(
                    `[isRateLimited @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Rate limit exceeded for identifier "${identifier}" (Limit: ${limit}/${windowMs}ms, Count: ${recentTimestamps.length})`
                ); // MDT Context
            }

            return isExceeded; // Return true if limit is exceeded by this request
        };
    }

    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Uses module-scoped 'rateLimit' Map for state.
    // Requires a valid non-empty string 'identifier'. Caller needs to provide this
    // (e.g., request.isRateLimited(request.ip) or request.isRateLimited(apiKey)).
    // In-memory state limitations apply (per-process, lost on restart).
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the logRequest method conditionally
    if (!request.hasOwnProperty("logRequest")) {
        /**
         * Logs essential request details to a capped, in-memory array.
         * Note: This logs synchronously to memory. For production / persistent logging,
         * consider using a dedicated logging library and asynchronous transports (file, DB, service).
         */
        request.logRequest = () => {
            let userAgent = null;
            let requestId = null; // Initialize requestId

            // 1. Safely get supporting info
            const getHeaderFunc = request.getHeader;
            if (typeof getHeaderFunc === "function") {
                try {
                    userAgent = getHeaderFunc("user-agent"); // Will be null if header missing
                } catch (error) {
                    console.error(`Error reading user-agent for logging near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                }
            } else {
                // console.warn("request.getHeader not available for logging user-agent.");
            }

            const getIdFunc = request.getId; // Use the getId method/getter
            if (typeof getIdFunc === "function") {
                try {
                    requestId = getIdFunc(); // Get the request ID
                } catch (error) {
                    console.error(`Error getting request ID for logging near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                }
            } else {
                // console.warn("request.getId not available for logging.");
            }

            // 2. Construct the log entry with safe defaults
            const logEntry = {
                requestId: requestId ?? null, // Include the request ID
                timestamp: new Date().toISOString(), // Use ISO format for consistency
                method: request.method ?? "UNKNOWN",
                url: request.url ?? "",
                ip: request.ip ?? null,
                userAgent: userAgent ?? null, // Ensure null if not found
                // Add any other fields available on `request` at this time
            };

            // 3. Push to the shared log array and cap its size
            try {
                requestLogs.push(logEntry);

                // Remove the oldest log entry if the array exceeds the maximum size
                if (requestLogs.length > MAX_LOG_ENTRIES_IN_MEMORY) {
                    requestLogs.shift(); // Removes the element at index 0
                }
            } catch (logError) {
                console.error(`Error managing in-memory request log array near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, logError); // MDT Context
            }

            // 4. If you needed to persist asynchronously, you'd initiate it here
            // Example: writeLogToFile(logEntry).catch(err => console.error('Async log write failed:', err));

            // No explicit return needed for a logging side-effect function
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on module-scoped 'requestLogs' array.
    // Relies on request.method, request.url, request.ip, request.getHeader, request.getId
    // being available/attached beforehand.
    // Logging is synchronous to the in-memory array. Size is capped.
    // ---------------------------------

    // --- Optional helper to retrieve logs (export separately if needed) ---
    /*
function getMemoryLogs(limit = 50) {
    return requestLogs.slice(-limit); // Get the last 'limit' logs
}
*/

    // Attach the autoParseBody async method conditionally
    if (!request.hasOwnProperty("autoParseBody")) {
        /**
         * Asynchronously parses the request body based on its Content-Type header,
         * delegating to the appropriate parsing method attached to the request.
         * Caches the result in request._parsedBody.
         * @returns {Promise<object|string|null>} A promise resolving to the parsed body (type depends on parser), or null if parsing fails or no suitable parser found.
         */
        request.autoParseBody = async () => {
            // 1. Check cache first (improves idempotency)
            // Using undefined check allows caching 'null' or empty results
            if (request._parsedBody !== undefined) {
                return request._parsedBody;
            }

            let contentType = "";
            const getHeaderFunc = request.getHeader;

            // 2. Safely get and normalize Content-Type header
            if (typeof getHeaderFunc === "function") {
                try {
                    // Get header, default '', lowercase, take only type part before ';'
                    contentType = (getHeaderFunc("content-type") || "").toLowerCase().split(";")[0].trim();
                } catch (error) {
                    console.error(`Error reading content-type header for autoParseBody near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                    contentType = ""; // Default on error
                }
            } else {
                // console.warn("request.getHeader function not available for autoParseBody.");
                contentType = ""; // Default if function missing
            }

            let parsedResult = null; // Default result

            // 3. Dispatch to and AWAIT the appropriate asynchronous parser
            try {
                if (contentType === MIME_TYPE_JSON && typeof request.parseJsonBody === "function") {
                    console.log(`[autoParseBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Parsing as JSON...`); // MDT Context
                    parsedResult = await request.parseJsonBody();
                } else if (contentType === MIME_TYPE_FORM_URLENCODED && typeof request.parseUrlEncodedForm === "function") {
                    console.log(`[autoParseBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Parsing as Form URL Encoded...`); // MDT Context
                    parsedResult = await request.parseUrlEncodedForm();
                } else if (contentType.startsWith(MIME_TYPE_MULTIPART_PREFIX) && typeof request.parseMultipartData === "function") {
                    console.log(`[autoParseBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Parsing as Multipart...`); // MDT Context
                    parsedResult = await request.parseMultipartData(); // Should return { fields: {}, files: {} } typically
                } else if (typeof request.parseBodyString === "function") {
                    // Fallback to raw string if no specific parser matched or was available
                    console.log(`[autoParseBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Falling back to raw string parsing for type "${contentType}"...`); // MDT Context
                    parsedResult = await request.parseBodyString(); // Use the refined string parser
                } else {
                    console.warn(`[autoParseBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] No suitable body parser found for Content-Type: "${contentType}" or default parser missing.`); // MDT Context
                    parsedResult = null; // No parser available
                }
            } catch (parseError) {
                console.error(`[autoParseBody @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error during body parsing delegation for IP ${request.ip}:`, parseError); // MDT Context
                parsedResult = null; // Ensure null on error
            }

            // 4. Cache the result (even if null) and return it
            request._parsedBody = parsedResult;
            return request._parsedBody;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getHeader being attached.
    // Relies on specific ASYNCHRONOUS parsing methods being attached:
    //   - request.parseJsonBody()
    //   - request.parseUrlEncodedForm()
    //   //   - request.parseMultipartData() // Note: Multipart is complex without dependencies
    //   - request.parseBodyString() (as a fallback)
    // These underlying methods should ideally handle their own internal caching if needed,
    // but this function adds a top-level cache (_parsedBody) for idempotency.
    // Callers MUST use await: `const body = await request.autoParseBody();`
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the parseBodyString method conditionally
    // Renamed to reflect string output
    if (!request.hasOwnProperty("parseBodyString")) {
        /**
         * Asynchronously reads and parses the entire request body stream into a string.
         * Lazily executed and caches the result on request._rawBodyString.
         * Includes a maximum body size limit.
         * WARNING: Buffers the entire body in memory - potentially memory-intensive.
         * @param {string} [encoding=utf-8] - The encoding to use for the string conversion.
         * @returns {Promise<string|null>} A promise resolving to the body string, or null on error/empty. Rejects on size limit.
         */
        request.parseBodyString = async (encoding = DEFAULT_BODY_ENCODING) => {
            // 1. Check cache: Return immediately if already parsed
            // Use 'undefined' check allows caching null/empty string results
            if (request._rawBodyString !== undefined) {
                return request._rawBodyString;
            }

            // 2. Check if parsing is already in progress (prevent race conditions)
            if (request._parsingBodyPromise) {
                return request._parsingBodyPromise;
            }

            // 3. Start the parsing process - create and store the promise
            request._parsingBodyPromise = new Promise((resolve, reject) => {
                const bodyChunks = [];
                let receivedBytes = 0;

                // --- Listen on the 'request' object itself ---
                request.on("data", (chunk) => {
                    receivedBytes += chunk.length;
                    // Check against size limit
                    if (receivedBytes > MAX_REQUEST_BODY_SIZE) {
                        const error = new Error(`Request body size limit exceeded (${MAX_REQUEST_BODY_SIZE} bytes)`);
                        error.statusCode = 413; // Payload Too Large
                        console.warn(`[parseBodyString @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] ${error.message} for IP ${request.ip}`); // MDT Context
                        request.unpipe(); // Stop data flow if applicable
                        request.destroy(error); // Destroy stream, triggers 'error' event
                        // No need to reject here, the 'error' handler below will do it
                        return;
                    }
                    bodyChunks.push(chunk);
                });

                request.on("end", () => {
                    try {
                        const completeBody = Buffer.concat(bodyChunks);
                        const bodyString = completeBody.toString(encoding);
                        request._rawBodyString = bodyString; // Cache result
                        // console.log(`[parseBodyString] Parsed ${receivedBytes} bytes.`);
                        resolve(bodyString);
                    } catch (parseError) {
                        console.error(`[parseBodyString @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error converting body buffer:`, parseError); // MDT Context
                        request._rawBodyString = null; // Cache null on processing error
                        reject(parseError);
                    } finally {
                        delete request._parsingBodyPromise; // Clean up promise ref
                    }
                });

                request.on("error", (err) => {
                    console.error(`[parseBodyString @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Request stream error for IP ${request.ip}:`, err); // MDT Context
                    request._rawBodyString = null; // Cache null on stream error
                    delete request._parsingBodyPromise; // Clean up promise ref
                    reject(err);
                });
                // --- End listeners ---
            });

            return request._parsingBodyPromise;
        };
    }

    // Optional: If you need the raw buffer sometimes, add a similar helper
    /*
if (!request.hasOwnProperty('parseBodyBuffer')) {
    request.parseBodyBuffer = async () => {
        // Check cache request._rawBodyBuffer first
        // Check request._parsingBodyPromise (maybe adapt to store buffer promise?)
        // Use new Promise logic similar to above, but resolve(Buffer.concat(bodyChunks))
        // Store result in request._rawBodyBuffer
    }
}
*/
    // --- End of attachment logic ---
    // Attach the isWebSocket method conditionally
    if (!request.hasOwnProperty("isWebSocket")) {
        /**
         * Checks if the request includes an 'Upgrade: websocket' header,
         * indicating a WebSocket connection request (case-insensitive).
         * @returns {boolean} True if the request is a WebSocket upgrade attempt, false otherwise.
         */
        request.isWebSocket = () => {
            // 1. Safely access the native 'upgrade' header and lowercase it.
            // The optional chaining (?.) means if 'upgrade' is missing, the result is undefined.
            const upgradeHeader = request.headers.upgrade?.toLowerCase();

            // 2. Compare the lowercased value with the target.
            // If upgradeHeader is undefined, undefined === 'websocket' is false.
            return upgradeHeader === WEBSOCKET_UPGRADE_VALUE_LOWERCASE;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies directly on the native request.headers object provided by Node.js http.
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the isXhr method conditionally (renamed from xhr getter)
    if (!request.hasOwnProperty("isXhr")) {
        /**
         * Checks if the request seems to be an AJAX (XMLHttpRequest) request
         * based on the presence and value of the 'X-Requested-With' header.
         * Performs a case-insensitive comparison.
         * Note: This header is non-standard but commonly added by JS libraries.
         * @returns {boolean} True if the header indicates an XHR request, false otherwise.
         */
        request.isXhr = () => {
            let headerValue = null;
            const getHeaderFunc = request.getHeader;

            // 1. Safely get the header value
            if (typeof getHeaderFunc === "function") {
                try {
                    headerValue = getHeaderFunc(HEADER_X_REQUESTED_WITH_NAME);
                } catch (error) {
                    console.error(`Error reading ${HEADER_X_REQUESTED_WITH_NAME} header for isXhr check near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                    headerValue = null; // Treat as missing on error
                }
            } else {
                // console.warn("request.getHeader function not available for isXhr check.");
                headerValue = null; // Treat as missing if function unavailable
            }

            // 2. Perform case-insensitive check if header value is a string
            if (typeof headerValue === "string") {
                return headerValue.toLowerCase() === XHR_TARGET_VALUE_LOWERCASE;
            }

            // 3. Return false if header was missing, null, or not a string
            return false;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getHeader being attached and functional.
    /* Example prerequisite:
if (!request.hasOwnProperty('getHeader')) {
    request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
}
*/
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the getApiVersion method conditionally
    if (!request.hasOwnProperty("getApiVersion")) {
        /**
         * Determines the API version requested through headers or URL path.
         * Checks headers 'x-api-version', then 'accept-version', then URL path for '/v<number>/'.
         * Defaults to '1'.
         * @returns {string} The determined API version string.
         */
        request.getApiVersion = () => {
            let version = null;
            const getHeaderFunc = request.getHeader;
            const url = request.url; // Native property

            // 1. Check 'x-api-version' Header
            if (typeof getHeaderFunc === "function") {
                try {
                    version = getHeaderFunc(HEADER_X_API_VERSION);
                    // Use trim() in case of extra whitespace, return if non-empty string found
                    if (version && typeof version === "string" && version.trim()) {
                        return version.trim();
                    }
                } catch (error) {
                    console.error(`Error checking ${HEADER_X_API_VERSION} near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                }
            } else {
                // console.warn("request.getHeader function not available for API version check.");
            }

            // 2. Check 'accept-version' Header if first wasn't found
            if (typeof getHeaderFunc === "function") {
                try {
                    version = getHeaderFunc(HEADER_ACCEPT_VERSION);
                    if (version && typeof version === "string" && version.trim()) {
                        return version.trim();
                    }
                } catch (error) {
                    console.error(`Error checking ${HEADER_ACCEPT_VERSION} near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                }
            }

            // 3. Check URL Path using modern regex exec and capture group access
            if (typeof url === "string") {
                try {
                    // Use exec() which returns null or an array with capture groups
                    const matchResult = URL_PATH_VERSION_REGEX.exec(url);
                    // Check if matchResult is not null AND group 1 (the digits) exists
                    if (matchResult && matchResult[1]) {
                        return matchResult[1]; // Return the captured version number string
                    }
                } catch (regexError) {
                    console.error(`Error executing URL regex for API version near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, regexError); // MDT Context
                }
            }

            // 4. If no version found via headers or URL, return the default
            return DEFAULT_API_VERSION_STRING;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getHeader being attached and functional.
    // Relies on request.url being available (which it always is on IncomingMessage).
    // ---------------------------------

    // --- Dependency Requirement & Warning ---
    // >>> WARNING <<<: This function REQUIRES an external dependency/setup for 'RedisClient'.
    // This conflicts with a strict "zero core dependency" approach.
    // Robust session management usually necessitates external state stores like Redis.
    // Ensure 'RedisClient' is properly required, configured, and connected.
    // Example Placeholder: const RedisClient = require('./my-redis-client'); // Or however it's made available
    // --------------------------------------------------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the async getSession method conditionally
    if (!request.hasOwnProperty("getSession")) {
        /**
         * Asynchronously retrieves the session object for the request, lazy-loading
         * from Redis based on the 'session_id' cookie. Initializes an empty session
         * if no cookie/data is found or if an error occurs.
         * WARNING: Requires a configured RedisClient. See dependency notes above.
         * @returns {Promise<object>} A promise that resolves to the session object ({} if empty/error).
         */
        request.getSession = async () => {
            // 1. Return cached session if already loaded onto the request object
            // Use a check that confirms it's an object to avoid issues if it was somehow set to null/etc.
            if (request.session && typeof request.session === "object" && request.session !== null) {
                return request.session;
            }

            // 2. Safely get the session ID from parsed cookies
            const cookies = request.cookies ?? {}; // Default to empty object if cookies missing
            const sessionId = cookies["session_id"]; // Use your actual session cookie name

            // 3. If no session ID found, initialize an empty session and store it
            if (!sessionId) {
                console.log(`[getSession @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] No session ID cookie. Initializing empty session.`); // MDT Context
                request.session = {}; // Initialize on the request object
                return request.session;
            }

            // 4. Attempt to load session from Redis (requires RedisClient)
            try {
                // Basic check if client seems available (replace with your actual client check)
                if (!globalThis.RedisClient || typeof globalThis.RedisClient.get !== "function") {
                    throw new Error("RedisClient is not available or configured correctly.");
                }

                console.log(`[getSession @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Attempting to load session from Redis: ${sessionId.substring(0, 6)}...`); // MDT Context
                // Use your actual Redis key prefix/pattern
                const sessionDataString = await globalThis.RedisClient.get(`session:${sessionId}`);

                if (sessionDataString === null || sessionDataString === undefined) {
                    // Key not found in Redis (e.g., expired, invalid ID)
                    console.log(`[getSession] Session data not found in Redis for ID: ${sessionId.substring(0, 6)}... Initializing empty session.`);
                    request.session = {};
                } else {
                    // Assume data is stored as JSON string in Redis
                    try {
                        request.session = JSON.parse(sessionDataString);
                        console.log(`[getSession] Successfully loaded and parsed session for ID: ${sessionId.substring(0, 6)}...`);
                    } catch (parseError) {
                        console.error(`[getSession @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Failed to parse session data from Redis for ID ${sessionId.substring(0, 6)}... Error:`, parseError); // MDT Context
                        request.session = {}; // Initialize empty on parse error
                    }
                }
            } catch (redisError) {
                console.error(`[getSession @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Redis error for IP ${request.ip}:`, redisError); // MDT Context
                // Default to an empty session object on any Redis error
                request.session = {};
            }

            // 5. Return the loaded or initialized session
            return request.session;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.cookies being populated (e.g., by parseCookies).
    // ** CRITICALLY requires a properly configured RedisClient. **
    // This function is ASYNCHRONOUS, so callers must use await: `const session = await request.getSession();`
    // Attaches/mutates request.session.
    // ---------------------------------
    // Attach the json helper method conditionally
    if (!request.hasOwnProperty("json")) {
        /**
         * Helper method to send a JSON response, automatically setting Content-Type,
         * stringifying the data within a { success: true, data: ... } wrapper,
         * and ending the response. Handles JSON.stringify errors.
         * @param {*} data - The payload to be included in the 'data' field of the response.
         * @param {number} [status=200] - The HTTP status code.
         */
        request.json = (data, status = HTTP_STATUS_OK_JSON) => {
            // 1. Check if response object is usable
            if (!response || typeof response.writeHead !== "function" || typeof response.end !== "function") {
                console.error(`[json @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Critical: Invalid response object.`); // MDT Context
                // Cannot send response
                return;
            }

            // 2. Don't attempt to send if headers are already sent
            if (response.headersSent) {
                console.warn(`[json @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Attempted to send JSON after headers were already sent for IP ${request.ip}.`); // MDT Context
                return;
            }

            let responseBody;
            let responseStatus = status;
            const responseHeaders = { ...CONTENT_TYPE_JSON_HEADER_OBJ }; // Start with JSON content type

            // 3. Try to stringify the data within the standard wrapper
            try {
                // NOTE: This enforces the { success: true, data: ... } structure
                responseBody = JSON.stringify({ success: true, data: data });
                // Optional: Set Content-Length for non-chunked transfer
                // responseHeaders['Content-Length'] = Buffer.byteLength(responseBody);
            } catch (error) {
                // 4. Handle stringification errors (e.g., circular references)
                console.error(`[json @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error stringifying JSON response for IP ${request.ip}:`, error); // MDT Context
                responseStatus = HTTP_STATUS_ERROR_JSON;
                responseBody = JSON_ERROR_PAYLOAD; // Send a generic error message
                // responseHeaders['Content-Length'] = Buffer.byteLength(responseBody);
            }

            // 5. Send the response headers and body
            try {
                response.writeHead(responseStatus, responseHeaders);
                response.end(responseBody);
            } catch (sendError) {
                // Catch rare errors during writeHead/end (e.g., socket closed)
                console.error(`[json @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Error sending response for IP ${request.ip}:`, sendError); // MDT Context
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Uses the 'response' object passed into the main decorator function scope.
    // Should only be called *once* per request lifecycle, as it ends the response.
    // Assumes response headers have not already been sent.
    // Enforces a { success: true, data: ... } structure unless stringify fails.
    // ---------------------------------
    // Attach the getId method conditionally
    if (!request.hasOwnProperty("getId")) {
        /**
         * Gets or generates a unique ID for the request.
         * Prioritizes the 'x-request-id' header if present,
         * otherwise generates and stores a new UUID for the duration of the request.
         * Lazily initialized and stored in request._id.
         * @returns {string | null} The request ID string, or null if unavailable/error.
         */
        request.getId = () => request.id;
    }

    /// ERROR 2
    // --- End of attachment logic ---

    // Attach the id getter conditionally using Object.defineProperty
    if (!Object.prototype.hasOwnProperty.call(request, "id")) {
        const readHeader = (name) => {
            try {
                if (typeof request.getHeader === "function") return request.getHeader(name);
                const v = request.headers?.[String(name).toLowerCase()];
                return Array.isArray(v) ? v[0] : v ?? null;
            } catch {
                return null;
            }
        };

        const deriveId = () => {
            let id = readHeader("x-request-id") || readHeader("x-correlation-id");
            if (typeof id === "string") {
                id = id.trim().replace(/[\r\n]+/g, " ");
                if (id.length > 128) id = id.slice(0, 128);
                if (id) return id;
            }
            try {
                return typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : crypto
                          .createHash("sha256")
                          .update(String(Math.random()) + Date.now())
                          .digest("hex")
                          .slice(0, 32);
            } catch {
                return String(Date.now());
            }
        };

        Object.defineProperty(request, "id", {
            configurable: true,
            enumerable: true,
            get() {
                if (this[kReqId]) return this[kReqId];
                if (typeof this._id === "string" && this._id) {
                    this[kReqId] = this._id;
                    return this[kReqId];
                }
                const v = deriveId();
                this[kReqId] = v;
                this._id = v; // keep Express-style compatibility
                return v;
            },
            set(v) {
                if (v == null) return;
                let s = String(v)
                    .trim()
                    .replace(/[\r\n]+/g, " ");
                if (s.length > 128) s = s.slice(0, 128);
                this[kReqId] = s;
                this._id = s;
            },
        });
    } else {
        // If an accessor already exists but has no setter, add one so assignments won't throw.
        const d = Object.getOwnPropertyDescriptor(request, "id");
        if (d && d.configurable && d.get && !d.set) {
            Object.defineProperty(request, "id", {
                configurable: true,
                enumerable: d.enumerable !== false,
                get: d.get.bind(request),
                set(v) {
                    if (v == null) return;
                    let s = String(v)
                        .trim()
                        .replace(/[\r\n]+/g, " ");
                    if (s.length > 128) s = s.slice(0, 128);
                    this[kReqId] = s;
                    this._id = s;
                },
            });
        }
    }

    // Attach the prefers method conditionally
    if (!request.hasOwnProperty("prefers")) {
        /**
         * Checks the request's Accept header and returns the best match from the
         * provided list of types, based on order and basic parsing.
         * Defaults to the first type provided if no match is found or header is missing.
         * NOTE: This is a simplified implementation - it ignores q-factor weighting
         * and complex MIME ranges beyond basic wildcards like 'text/*' or '*/
        //  * @param {...string} types - One or more MIME types or shortcuts (e.g., 'json', 'html', 'text/plain')
        //  * listed in order of server preference.
        //  * @returns {string | undefined} The best matching type from the input list, the first input type
        //  * as default, or undefined if no types were provided.
        //  */
        request.prefers = (...types) => {
            // 1. Handle edge case: no types provided by caller
            if (!types || types.length === 0) {
                return undefined;
            }

            // 2. Safely get and normalize the Accept header
            let acceptHeader = "";
            const getHeaderFunc = request.getHeader;
            if (typeof getHeaderFunc === "function") {
                try {
                    acceptHeader = getHeaderFunc("accept") || "";
                } catch (error) {
                    console.error(`Error reading accept header for IP ${request.ip} near ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}:`, error); // MDT Context
                    acceptHeader = ""; // Default to empty on error
                }
            } else {
                // console.warn("request.getHeader function not available for prefers check.");
                acceptHeader = ""; // Default to empty if function missing
            }

            // 3. Basic parse of accepted types from header (ignore q-factors)
            // Example: "text/html, application/xhtml+xml, application/xml;q=0.9" -> ["text/html", "application/xhtml+xml", "application/xml"]
            const clientAcceptedTypes = acceptHeader
                .split(",")
                .map((part) => part.split(";")[0].trim()) // Take part before ';', trim
                .filter(Boolean); // Remove empty entries

            // 4. If client specifies no types (or header was empty/invalid), default to server's first choice
            if (clientAcceptedTypes.length === 0) {
                return types[0];
            }

            // 5. Iterate through server's preferred types (`types` array)
            //    Find the first one that the client accepts.
            const foundType = types.find((serverPrefType) => {
                // Normalize common shortcuts (e.g., 'json' -> 'application/json')
                let normalizedServerPref = serverPrefType;
                if (serverPrefType === "json") normalizedServerPref = "application/json";
                else if (serverPrefType === "html") normalizedServerPref = "text/html";
                else if (serverPrefType === "text") normalizedServerPref = "text/plain";
                // Add other common shortcuts if needed

                // Check if this normalized server type is accepted by the client
                return clientAcceptedTypes.some((clientAcceptsType) => {
                    // Direct match? (e.g., 'application/json' === 'application/json')
                    if (clientAcceptsType === normalizedServerPref) return true;

                    // Client accepts wildcard? (e.g., client 'text/*' matches server 'text/html')
                    if (clientAcceptsType.endsWith("/*")) {
                        const clientBaseType = clientAcceptsType.slice(0, -2); // e.g., 'text'
                        if (normalizedServerPref.startsWith(clientBaseType + "/")) return true;
                    }

                    // Client accepts anything?
                    if (clientAcceptsType === "*/*") return true;

                    return false;
                });
            });

            // 6. Return the found type, or default to the server's first preference
            return foundType || types[0];
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getHeader being attached and functional.
    /* Example prerequisite:
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    */
    // ---------------------------------

    // Attach the sanitize method conditionally
    if (!request.hasOwnProperty("sanitize")) {
        /**
         * Recursively performs basic HTML entity escaping on string values within
         * nested objects or arrays. Non-string values are returned untouched.
         * Creates new objects and arrays (immutable approach).
         *
         * >>> WARNING <<<: This provides basic escaping for outputting data within
         * HTML *content* (e.g., inside <p>...</p> or <div>...</div>).
         * It is *NOT* a comprehensive XSS sanitizer. Do NOT use it for sanitizing
         * user-provided HTML, URLs, or inserting data into HTML attributes or
         * <script> tags without further context-specific encoding/validation.
         * Consider dedicated libraries (like DOMPurify - requires dependency) for robust sanitization.
         *
         * @param {*} input - The value, object, or array to escape.
         * @returns {*} A new value, object, or array with string values HTML-escaped.
         */
        request.sanitize = function sanitizeForHtmlOutput(input) {
            // Using named function expression for clarity in recursion
            // 1. Handle primitives, null, undefined directly
            if (input === null || (typeof input !== "object" && typeof input !== "string")) {
                return input; // Return numbers, booleans, undefined, null as is
            }

            // 2. Handle Strings: Basic HTML entity escaping
            if (typeof input === "string") {
                // Replace characters crucial for HTML context
                return input
                    .replace(/&/g, "&amp;") // Must be first
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&#039;"); // Use &#039; for better compatibility than &apos;
            }

            // 3. Handle Arrays: Create NEW array, sanitize elements recursively
            if (Array.isArray(input)) {
                return input.map((item) => sanitizeForHtmlOutput(item)); // Recurse on items
            }

            // 4. Handle Objects (Plain Objects): Create NEW object, sanitize values recursively
            // Final check ensures it's a non-null, non-array object
            if (typeof input === "object") {
                const sanitizedObj = {};
                for (const key in input) {
                    // Use hasOwnProperty to avoid iterating over prototype properties
                    if (Object.prototype.hasOwnProperty.call(input, key)) {
                        sanitizedObj[key] = sanitizeForHtmlOutput(input[key]); // Recurse on values
                    }
                }
                return sanitizedObj;
            }

            // Fallback (should be unreachable if logic above is correct)
            return input;
        };
    }
    // --- End of attachment logic ---

    // Attach the validateSchema method conditionally
    if (!request.hasOwnProperty("validateSchema")) {
        /**
         * Validates the request body against a provided schema definition.
         * Populates the `request.validationErrors` array with any validation failure messages.
         * Note: This provides basic validation (required, type, regex). Complex rules need extension.
         * @param {object} schema - An object where keys are field names expected in `request.body`,
         * and values are objects defining validation rules like
         * `{ type: 'string'|'number'|'boolean'|'object'|'array', required?: boolean, regex?: RegExp }`.
         * @returns {boolean} True if the body passes validation according to the schema, false otherwise.
         */
        request.validateSchema = (schema) => {
            // 1. Always initialize/reset the errors array for this validation run
            request.validationErrors = [];

            // 2. Validate prerequisites: schema and request body
            const body = request.body; // Assumes body parsing occurred earlier
            if (!body || typeof body !== "object" || body === null) {
                const message = `Cannot validate: request.body is missing or not an object.`;
                console.warn(`[validateSchema @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] ${message}`); // MDT Context
                request.validationErrors.push(message);
                return false; // Cannot proceed
            }
            if (!schema || typeof schema !== "object" || schema === null) {
                // Log as a setup error, don't add to request.validationErrors
                console.error(`[validateSchema @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Cannot validate: Invalid schema provided.`); // MDT Context
                // Throwing an error might be appropriate here, as it's a developer/config error
                // For now, return false to indicate validation didn't truly pass
                return false;
            }

            // 3. Iterate through fields defined in the schema
            for (const field in schema) {
                if (!schema.hasOwnProperty(field)) continue; // Only check own properties of schema

                const rules = schema[field];
                // Basic check on rule format
                if (!rules || typeof rules !== "object") {
                    console.warn(`[validateSchema] Invalid schema rule for field '${field}'. Skipping.`);
                    continue;
                }

                const { type, required, regex /*, minLength, etc... */ } = rules;
                const value = body[field];

                // --- Required Field Check ---
                const isMissing = value === undefined || value === null || String(value).trim() === "";
                if (required && isMissing) {
                    request.validationErrors.push(`Field '${field}' is required.`);
                    continue; // If required and missing, skip other checks for this field
                }

                // If field is not required and is missing, skip further checks for it
                if (!required && isMissing) {
                    continue;
                }

                // --- Type Check (More Robust) ---
                if (type) {
                    let typeOK = false;
                    switch (type.toLowerCase()) {
                        case "string":
                            typeOK = typeof value === "string";
                            break;
                        case "number":
                            typeOK = typeof value === "number" && !isNaN(value);
                            break; // Strict check
                        case "boolean":
                            typeOK = typeof value === "boolean";
                            break;
                        case "object":
                            typeOK = typeof value === "object" && value !== null && !Array.isArray(value);
                            break;
                        case "array":
                            typeOK = Array.isArray(value);
                            break;
                        case "integer":
                            typeOK = Number.isInteger(value);
                            break; // Example: integer check
                        // Add more types like 'date' if needed
                        default:
                            console.warn(`[validateSchema] Unknown type '${type}' specified for field '${field}'.`);
                            typeOK = true; // Treat unknown types as passing? Or fail? Defaulting to pass.
                            break;
                    }
                    if (!typeOK) {
                        request.validationErrors.push(`Field '${field}' must be type '${type}', but received type '${Array.isArray(value) ? "array" : typeof value}'.`);
                        // Often useful to skip regex check if type is wrong
                        // continue;
                    }
                }

                // --- Regex Check (Safer) ---
                if (regex instanceof RegExp) {
                    // Only test if the value is a string, otherwise regex is likely inappropriate
                    if (typeof value === "string") {
                        if (!regex.test(value)) {
                            request.validationErrors.push(`Field '${field}' has an invalid format.`);
                        }
                    } else if (type === "string" && value !== undefined && value !== null) {
                        // If schema expected a string, but we got something else, flag it for regex context
                        request.validationErrors.push(`Field '${field}' could not be regex tested (expected string, got ${typeof value}).`);
                    }
                } else if (regex !== undefined) {
                    // Log schema error if 'regex' exists but isn't a RegExp object
                    console.warn(`[validateSchema] Invalid 'regex' provided for field '${field}' in schema (must be a RegExp object).`);
                }
            }

            // 4. Return true if the errors array is empty, false otherwise
            return request.validationErrors.length === 0;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.body being populated correctly (e.g., by an async body parser).
    // Relies on a well-defined schema object being passed to the function.
    // The function populates request.validationErrors with an array of error strings.
    // ---------------------------------
    // Attach the isSuspicious method conditionally
    if (!request.hasOwnProperty("isSuspicious")) {
        /**
         * Checks if the request rate from the IP address is considered suspicious
         * based on exceeding a defined limit within a short time window.
         * Uses module-level in-memory tracking.
         * @returns {boolean} True if the request rate is suspicious, false otherwise.
         */
        request.isSuspicious = () => {
            // 1. Safely get the IP address from the request object
            const ip = request.ip;
            if (!ip) {
                // If IP is unknown, default to not suspicious
                console.warn(`[isSuspicious @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Cannot check suspicion: request.ip not available.`); // Using MDT timezone approximation
                return false;
            }

            const now = Date.now();

            // 2. Get previous timestamps for this IP, default to empty array
            const previousTimestamps = anomalyTracker.get(ip) || [];

            // 3. Filter out timestamps older than the defined window
            const recentTimestamps = previousTimestamps.filter((time) => now - time < SUSPICIOUS_ACTIVITY_WINDOW_MS);

            // 4. Add the current request's timestamp to the recent list
            recentTimestamps.push(now);

            // 5. Update the tracker with the latest list (pruned + current)
            anomalyTracker.set(ip, recentTimestamps);

            // 6. Determine if the count of recent requests exceeds the limit
            const isOverLimit = recentTimestamps.length > SUSPICIOUS_ACTIVITY_LIMIT;

            // Optional: Log when an IP first triggers the suspicious flag in a cycle
            if (isOverLimit && recentTimestamps.length === SUSPICIOUS_ACTIVITY_LIMIT + 1) {
                console.warn(`[isSuspicious @ ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Denver" })}] Suspicious activity detected for IP ${ip} (Count: ${recentTimestamps.length})`); // Using MDT
            }

            return isOverLimit;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.ip being populated correctly beforehand by earlier decorator logic.
    /* Example prerequisite:
    if (!request.hasOwnProperty('ip')) {
        request.ip = request.socket.remoteAddress; // Or handle X-Forwarded-For etc.
    }
    */
    // ---------------------------------
    // Attach the priority method conditionally
    if (!request.hasOwnProperty("priority")) {
        /**
         * Determines a basic priority level for the request based on certain criteria.
         * @returns {string} The calculated priority level ('high', 'medium', or 'low').
         */
        request.priority = () => {
            // 1. Check for VIP status via header
            const getHeaderFunc = request.getHeader;
            let isVip = false;
            if (typeof getHeaderFunc === "function") {
                try {
                    // Check if the VIP header exists and has a truthy value
                    if (getHeaderFunc(VIP_USER_HEADER)) {
                        isVip = true;
                    }
                } catch (error) {
                    console.error(`Error checking header ${VIP_USER_HEADER} for priority for IP ${request.ip} near ${new Date().toLocaleTimeString()} MDT:`, error);
                    // Proceed without VIP status if header check fails
                }
            } else {
                // console.warn("request.getHeader function not available for priority check.");
            }

            // Return high priority immediately if VIP
            if (isVip) {
                return PRIORITY_LEVEL_HIGH;
            }

            // 2. Check request method (assuming request.method is available and normalized)
            const method = request.method; // Already attached/normalized earlier
            if (typeof method === "string" && method === "GET") {
                // Assign medium priority to GET requests (example logic)
                return PRIORITY_LEVEL_MEDIUM;
            }

            // 3. Add other conditions here if needed (e.g., based on URL path, user role)

            // 4. Default to low priority if no other conditions met
            return PRIORITY_LEVEL_LOW;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getHeader being attached and functional.
    // Relies on request.method being available (and preferably normalized, e.g., uppercase).
    /* Example prerequisites:
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    // Ensure method is normalized if necessary:
    // request.method = request.method.toUpperCase();
    */
    // ---------------------------------
    // Attach the autoRespond method conditionally
    if (!request.hasOwnProperty("autoRespond")) {
        /**
         * Attempts to automatically handle and end certain types of requests
         * (e.g., OPTIONS preflights, cache hits) early in the lifecycle.
         * IMPORTANT: If this function returns true, the response has been ended.
         * @returns {boolean} True if a response was sent and ended, false otherwise.
         */
        request.autoRespond = () => {
            // 1. Basic check on the response object's usability
            if (!response || typeof response.writeHead !== "function" || typeof response.end !== "function") {
                console.error(`[autoRespond @ ${new Date().toLocaleTimeString()} MDT] Cannot operate: Invalid response object.`);
                return false; // Cannot handle
            }

            // 2. Handle OPTIONS requests (Common for CORS preflight)
            // Assumes request.method is available (and ideally normalized, e.g., uppercase)
            if (request.method === "OPTIONS") {
                console.log(`[autoRespond] Handling OPTIONS request for ${request.url} at ${new Date().toLocaleTimeString()} MDT.`);
                // Note: For actual CORS preflight, you MUST set appropriate
                // Access-Control-Allow-* headers here BEFORE writeHead/end.
                // Example: response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                // Example: response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                // Example: response.setHeader('Access-Control-Allow-Origin', '*'); // Or specific origin
                response.writeHead(HTTP_STATUS_NO_CONTENT);
                response.end();
                return true; // Indicate response was handled and ended
            }

            // 3. Handle based on a custom header like X-Cache-Hit
            const getHeaderFunc = request.getHeader;
            if (typeof getHeaderFunc === "function") {
                try {
                    // Check if the header exists and is truthy
                    if (getHeaderFunc("x-cache-hit")) {
                        console.log(`[autoRespond] Handling X-Cache-Hit for ${request.url} at ${new Date().toLocaleTimeString()} MDT.`);
                        response.writeHead(HTTP_STATUS_OK, CONTENT_TYPE_JSON);
                        // Sending a minimal placeholder response
                        response.end(JSON.stringify({ status: "served_from_cache_placeholder" }));
                        return true; // Indicate response was handled and ended
                    }
                } catch (error) {
                    console.error(`Error checking headers in autoRespond for IP ${request.ip} near ${new Date().toLocaleTimeString()} MDT:`, error);
                    // Proceed as if header wasn't found
                }
            } else {
                // console.warn("request.getHeader function not available for autoRespond checks.");
            }

            // 4. Add other auto-response conditions here if needed...

            // 5. If no conditions were met, return false
            return false;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.method being available.
    // Relies on request.getHeader being attached and functional.
    // Uses the 'response' object passed into the main decorator function scope.
    // NOTE: Call this function EARLY in your request handling if you intend for it
    //       to short-circuit processing for OPTIONS or cache hits.
    // Example Usage:
    // const handled = request.autoRespond();
    // if (handled) return; // Stop further processing
    // // ... continue with routing/other logic ...
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the getFingerprint method conditionally
    if (!request.hasOwnProperty("getFingerprint")) {
        /**
         * Generates a VERY BASIC request fingerprint based on IP and User-Agent.
         * WARNING: This fingerprint is highly unstable, changes easily (e.g., changing IP),
         * and can be easily spoofed (User-Agent). It is NOT suitable for reliable
         * user identification or tracking across sessions. Use for simple, non-critical logging only.
         * @returns {string | null} A SHA-256 hash string representing the basic fingerprint, or null on error.
         */
        request.getFingerprint = () => {
            let ipPart = "unknown_ip"; // Default placeholder
            let uaPart = "unknown_ua"; // Default placeholder

            // 1. Safely get IP Address
            // Provide a default string if request.ip is null/undefined
            ipPart = request.ip ?? ipPart;

            // 2. Safely get User-Agent Header
            const getHeaderFunc = request.getHeader;
            if (typeof getHeaderFunc === "function") {
                try {
                    // Provide a default string if header is missing
                    uaPart = getHeaderFunc("user-agent") || uaPart;
                } catch (error) {
                    console.error(`Error calling request.getHeader('user-agent') for fingerprint near ${new Date().toLocaleTimeString()} MDT:`, error);
                    uaPart = "error_ua"; // Indicate error
                }
            } else {
                // console.warn("request.getHeader function not available for fingerprinting.");
                uaPart = "missing_header_func_ua"; // Indicate missing function
            }

            // 3. Construct the input string for hashing (separator helps)
            const fingerprintInput = `${ipPart}|${uaPart}`;

            // 4. Generate the SHA-256 hash
            try {
                const hash = crypto.createHash("sha256").update(fingerprintInput).digest("hex");
                return hash;
            } catch (hashError) {
                console.error(`Error generating fingerprint hash near ${new Date().toLocaleTimeString()} MDT for input "${fingerprintInput}":`, hashError);
                return null; // Return null on failure
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.ip being populated and request.getHeader being attached.
    // Requires the 'crypto' module to be imported at the top.
    /* Example prerequisites:
    if (!request.hasOwnProperty('ip')) {
        request.ip = request.socket.remoteAddress; // Or handle X-Forwarded-For etc.
    }
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    */
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the dynamicThrottle method conditionally
    if (!request.hasOwnProperty("dynamicThrottle")) {
        /**
         * Checks if the current request exceeds the defined throttling limit for its IP.
         * Uses module-level in-memory tracking with a sliding window reset.
         * @returns {boolean} True if the request should be throttled (limit exceeded), false otherwise.
         */
        request.dynamicThrottle = () => {
            // 1. Safely get the IP address from the request object
            const ip = request.ip;
            if (!ip) {
                // Decide behavior if IP is missing: don't throttle, or throttle to be safe?
                // Returning false (don't throttle) seems reasonable if identity is unknown.
                console.warn(`[dynamicThrottle @ ${new Date().toLocaleTimeString()} MDT] Cannot throttle: request.ip not available.`);
                return false;
            }

            const now = Date.now();

            // 2. Get current state for the IP, or initialize a new state
            const currentState = userThrottling.get(ip) || { count: 0, lastRequest: now };

            // 3. Check if the time window has elapsed since the last tracked request
            const timeElapsed = now - currentState.lastRequest;

            if (timeElapsed > THROTTLE_WINDOW_DURATION_MS) {
                // Outside the window: Reset count to 1 (for the current request)
                currentState.count = 1;
            } else {
                // Still inside the window: Increment the count
                currentState.count++;
            }

            // 4. Always update the last request timestamp for this IP
            currentState.lastRequest = now;

            // 5. Store the updated state back into the map
            userThrottling.set(ip, currentState);

            // 6. Determine if the current count exceeds the limit
            const shouldBeThrottled = currentState.count > THROTTLE_REQUEST_LIMIT;

            // Optional: Log when throttling first triggers for an IP in a window
            if (shouldBeThrottled && currentState.count === THROTTLE_REQUEST_LIMIT + 1) {
                console.warn(`[dynamicThrottle @ ${new Date().toLocaleTimeString()} MDT] Throttling IP ${ip} (Count: ${currentState.count})`);
            }

            return shouldBeThrottled;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.ip being populated correctly beforehand by earlier decorator logic.
    /* Example prerequisite:
    if (!request.hasOwnProperty('ip')) {
        request.ip = request.socket.remoteAddress; // Or handle X-Forwarded-For etc.
    }
    */
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the detectLanguage method conditionally
    if (!request.hasOwnProperty("detectLanguage")) {
        /**
         * Detects the user's preferred language from the 'Accept-Language' header.
         * Returns the first language tag found (e.g., "en-US", "fr").
         * Defaults to a predefined language code if the header is missing, empty, or invalid.
         * Note: This is a basic implementation and does not parse q-factors.
         * @returns {string} The detected language tag or the default.
         */
        request.detectLanguage = () => {
            let detectedLanguage = DEFAULT_LANGUAGE; // Start with default
            const getHeaderFunc = request.getHeader;

            if (typeof getHeaderFunc === "function") {
                try {
                    // Safely get header value using optional chaining
                    const headerValue = getHeaderFunc("accept-language"); // e.g., "de, en-US;q=0.9, en;q=0.8"

                    // Get the first part before any comma
                    const firstPart = headerValue?.split(",")[0]; // e.g., "de" or undefined

                    // Use it only if it's a non-empty string after trimming whitespace
                    if (firstPart && typeof firstPart === "string" && firstPart.trim()) {
                        detectedLanguage = firstPart.trim();

                        // Optional: If you ONLY want the primary language code (e.g., "en" from "en-GB")
                        // detectedLanguage = detectedLanguage.split('-')[0];
                    }
                    // Otherwise, stick with DEFAULT_LANGUAGE
                } catch (error) {
                    console.error(`Error reading/parsing accept-language header near ${new Date().toLocaleTimeString()} MDT for IP ${request.ip}:`, error);
                    // Fallback to default on error
                    detectedLanguage = DEFAULT_LANGUAGE;
                }
            } else {
                // console.warn("request.getHeader function not available for detectLanguage.");
                // Stick with default if function is missing
                detectedLanguage = DEFAULT_LANGUAGE;
            }

            return detectedLanguage;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.getHeader being attached beforehand.
    /* Example prerequisite:
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    */
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the geoLocation method conditionally
    if (!request.hasOwnProperty("geoLocation")) {
        /**
         * Provides basic network location classification (localhost, private, public/unknown).
         * IMPORTANT: This does NOT perform true GeoIP lookup based on public IP address location.
         * @returns {string} A classification like "Localhost", "Private Network", or "Unknown/Public".
         */
        request.geoLocation = () => {
            // 1. Safely get the IP address, default to empty string if missing
            const ip = request.ip ?? "";

            // 2. Handle missing IP
            if (!ip) {
                // console.warn(`[geoLocation @ ${new Date().toLocaleTimeString()} MDT] Cannot determine location: request.ip is not set.`);
                return GEO_DESC_UNKNOWN_PUBLIC;
            }

            // 3. Check for Loopback Addresses (::1 is IPv6 loopback)
            if (ip === "127.0.0.1" || ip === "::1") {
                return GEO_DESC_LOCALHOST;
            }

            // 4. Check for common Private IPv4 Ranges (RFC 1918)
            // Using more specific 192.168. prefix
            if (ip.startsWith("192.168.") || ip.startsWith("10.") || PRIVATE_172_REGEX.test(ip)) {
                return GEO_DESC_LOCAL_NETWORK;
            }

            // 5. Add checks for IPv6 Private Ranges (ULA fc00::/7) if needed - more complex regex required

            // 6. If none of the above, assume it's Public or an unknown type
            // This includes all routable public IPs and potentially other special ranges.
            return GEO_DESC_UNKNOWN_PUBLIC;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.ip being populated correctly beforehand (e.g., from socket or headers).
    /* Example prerequisite:
    if (!request.hasOwnProperty('ip')) {
        request.ip = request.socket.remoteAddress; // Or handle X-Forwarded-For etc.
    }
    */
    // ---------------------------------

    // -------------------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the securityRiskScore method conditionally
    if (!request.hasOwnProperty("securityRiskScore")) {
        request.securityRiskScore = () => {
            let currentScore = 0;
            const ipAddress = request.ip ?? "N/A"; // Get IP safely for logging

            // 1. Check if IP is suspicious (using attached method)
            const isSuspiciousFunc = request.isSuspicious;
            if (typeof isSuspiciousFunc === "function") {
                try {
                    if (isSuspiciousFunc()) {
                        // Call without arguments
                        currentScore += SCORE_INCREMENT_SUSPICIOUS_IP;
                    }
                } catch (error) {
                    console.error(`Error calling request.isSuspicious for IP ${ipAddress} around ${new Date().toLocaleTimeString()} MDT:`, error);
                }
            } else {
                // console.warn("request.isSuspicious function not available for security scoring.");
            }

            // 2. Check if request is identified as a bot (using attached method)
            const isBotFunc = request.isBot;
            if (typeof isBotFunc === "function") {
                try {
                    if (isBotFunc()) {
                        currentScore += SCORE_INCREMENT_IS_BOT;
                    }
                } catch (error) {
                    console.error(`Error calling request.isBot for IP ${ipAddress} around ${new Date().toLocaleTimeString()} MDT:`, error);
                }
            } else {
                // console.warn("request.isBot function not available for security scoring.");
            }

            // 3. Check for missing Referer header (using attached method)
            const getHeaderFunc = request.getHeader;
            if (typeof getHeaderFunc === "function") {
                try {
                    // Check if the referer header is missing or empty (falsy)
                    if (!getHeaderFunc("referer")) {
                        currentScore += SCORE_INCREMENT_NO_REFERER;
                    }
                } catch (error) {
                    console.error(`Error calling request.getHeader('referer') for IP ${ipAddress} around ${new Date().toLocaleTimeString()} MDT:`, error);
                }
            } else {
                // console.warn("request.getHeader function not available for security scoring.");
            }

            // --- Add other risk factors here ---
            // Example: Check for unusual User-Agent?
            // const ua = (request.getHeader('user-agent') || '');
            // if (ua.length < 10 && ua.length > 0) currentScore += 5; // Very short UA?

            // Example: High request count? (requires access to rate limiters)
            // Need access to the maps or results from dynamicThrottle/detectAnomalies

            console.log(`Security score calculated for IP ${ipAddress} at ${new Date().toLocaleTimeString()} MDT: ${currentScore}`); // Added log
            return currentScore;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.isSuspicious, request.isBot, request.getHeader being attached
    // and functional beforehand. Assumes request.ip is populated.
    // Note: This scoring logic is very basic and for illustrative purposes.
    // Real-world security scoring is significantly more complex.
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the autoCorrect method conditionally
    if (!request.hasOwnProperty("autoCorrect")) {
        /**
         * Attempts to automatically correct fields in an input object based on a schema.
         * Warning: Mutates the input object directly. Email correction is highly opinionated.
         * @param {object} input - The data object to correct (e.g., request.body or request.query).
         * @param {object} schema - An object where keys match input fields,
         * and values are objects like { type: 'email' | 'number' | ... }.
         * @returns {object} The potentially modified input object.
         */
        request.autoCorrect = (input, schema) => {
            // 1. Validate input arguments
            if (!input || typeof input !== "object" || input === null) {
                console.warn(`[autoCorrect at ${new Date().toLocaleTimeString()} MDT] Invalid 'input' provided.`);
                return input; // Return original if invalid
            }
            if (!schema || typeof schema !== "object" || schema === null) {
                console.warn(`[autoCorrect at ${new Date().toLocaleTimeString()} MDT] Invalid 'schema' provided.`);
                return input; // Return original if schema invalid
            }

            // Optional: Create a shallow copy to avoid mutating the original
            // const correctedInput = { ...input }; // Then modify/return correctedInput

            console.log(`[autoCorrect at ${new Date().toLocaleTimeString()} MDT] Starting auto-correction...`); // Added log

            for (const field in schema) {
                // Check if field exists in input before attempting correction
                if (!input.hasOwnProperty(field)) {
                    continue;
                }

                const fieldSchema = schema[field];
                const currentValue = input[field]; // Use correctedInput[field] if not mutating

                // 2. Email Correction Logic (Use with extreme caution!)
                if (fieldSchema?.type === "email") {
                    if (typeof currentValue === "string" && currentValue.length > 0 && !currentValue.includes("@")) {
                        // >>> DANGEROUS ASSUMPTION <<<
                        // This default domain is likely wrong. Consider removing this auto-correction
                        // or making the domain configurable and clearly documented.
                        // Validation + user feedback is generally better than guessing.
                        console.warn(`[autoCorrect] WARNING: Appending default domain to field '${field}'. Original: "${currentValue}"`);
                        input[field] = `${currentValue}@gmail.com`; // Mutates input
                    }
                }

                // 3. Number Correction Logic
                else if (fieldSchema?.type === "number") {
                    const numValue = Number(currentValue); // Try converting first

                    // Correct if the conversion results in NaN, OR if the original was a string
                    // that *should* be a number according to the schema.
                    if (isNaN(numValue)) {
                        if (typeof currentValue === "string") {
                            const digits = currentValue.replace(/\D/g, ""); // Extract digits
                            if (digits) {
                                const parsed = parseInt(digits, 10);
                                input[field] = isNaN(parsed) ? null : parsed; // Mutates input, use null if parsing fails
                            } else {
                                input[field] = null; // Mutates input: No digits found, set to null
                            }
                        } else if (currentValue !== null && currentValue !== undefined) {
                            // It wasn't a string but resulted in NaN (could be NaN, object, etc.)
                            input[field] = null; // Mutates input: Set non-parseable non-strings to null
                        }
                        // else: if currentValue was null/undefined, leave it as is or set to null?
                        // input[field] = null; // Uncomment to force null for initially null/undefined fields needing numbers
                    } else if (typeof currentValue === "string") {
                        // Value was a string but Number() conversion worked - store the number
                        input[field] = numValue; // Mutates input
                    }
                    // else: It was already a valid number, do nothing.
                }

                // Add more type corrections (boolean, date standardization, etc.) here if needed
            }

            return input; // Return the (potentially) mutated input
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on the 'input' object (e.g., request.body from successful parsing)
    // and a correctly structured 'schema' being available.
    // Its usefulness is highly dependent on the schema and the correction logic.
    // ---------------------------------

    // -------------------------------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the getErrorSummary method conditionally
    if (!request.hasOwnProperty("getErrorSummary")) {
        request.getErrorSummary = () => {
            // 1. Safely access request.validationErrors
            const errors = request.validationErrors;

            // 2. Check if it's actually an array
            if (Array.isArray(errors)) {
                const errorCount = errors.length;

                if (errorCount > 0) {
                    // 3. Format the summary string if errors exist
                    // Ensure all items are strings before joining
                    const errorString = errors.map((e) => String(e)).join("; ");
                    return `${MSG_ERROR_SUMMARY_PREFIX} ${errorCount} ${MSG_ERROR_SUMMARY_SUFFIX} ${errorString}`;
                } else {
                    // 4. Return specific message if array is empty
                    return MSG_NO_VALIDATION_ERRORS;
                }
            } else {
                // 5. Return specific message if validationErrors wasn't a valid array
                // This might indicate validation logic didn't run or attach results properly.
                // console.warn(`request.validationErrors not available or not an array at ${new Date().toLocaleTimeString()} MDT.`);
                return MSG_VALIDATION_STATUS_UNKNOWN;
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies on request.validationErrors being populated as an Array (even if empty)
    // by preceding validation logic within the decorator.
    /* Example prerequisite:
       // (Somewhere earlier in the decorator)
       request.validationErrors = []; // Initialize
       // ... validation logic potentially pushes strings or error objects onto request.validationErrors ...
    */
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the debugInfo method conditionally
    if (!request.hasOwnProperty("debugInfo")) {
        request.debugInfo = () => {
            // This function provides a snapshot based on properties potentially
            // added by earlier steps in this decorator.

            const info = {
                // Native properties (generally safe)
                method: request.method, // Already likely normalized (e.g., uppercase)
                url: request.url,
                headers: request.headers, // Note: Headers might contain sensitive info (e.g., Authorization, Cookie)

                // Properties added by your decorator (use nullish coalescing for safety)
                ip: request.ip ?? null,
                query: request.query ?? {},
                cookies: request.cookies ?? {}, // Note: Cookies might contain sensitive info
                body: request.body ?? null, // Will be null if body parsing hasn't run or failed

                // Example: Add related native info
                remoteAddress: request.socket?.remoteAddress ?? null, // Actual socket address

                // Example: Add timing info if available
                _hrtimeStartRaw: request._hrtimeStart ?? null, // Raw hrtime tuple if needed

                // ** IMPORTANT: Do NOT include request.session unless you have fully
                // ** implemented a working session mechanism. It's misleading otherwise.
            };

            // CONSIDER REDACTION: If logging this object, you might want to
            // redact sensitive parts of headers, cookies, or body.
            // Example (basic):
            // if (info.headers?.authorization) { info.headers = { ...info.headers, authorization: '[REDACTED]' }; }
            // if (info.cookies?.sessionId) { info.cookies = { ...info.cookies, sessionId: '[REDACTED]' }; }

            return info;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // Relies heavily on previous steps in the decorator having run successfully
    // to populate request.ip, request.query, request.cookies, request.body, etc.
    // Relies on request.startTimer() setting request._hrtimeStart for timing info.
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the predictiveFetch method conditionally
    // Renamed to 'predictiveFetch' as it initiates the fetch action
    if (!request.hasOwnProperty("predictiveFetch")) {
        request.predictiveFetch = (nextUrl) => {
            // 1. Basic validation of the URL input
            if (!nextUrl || typeof nextUrl !== "string") {
                console.warn(`[Predictive Fetch] Invalid or missing nextUrl provided.`);
                return; // Don't proceed
            }

            // 2. Check cache - Use module-scoped cache
            const cachedItem = predictiveDataCache.get(nextUrl);
            const now = Date.now();

            // Optional: Check if item exists and is still valid based on timestamp/TTL
            if (cachedItem && now - cachedItem.timestamp < PREDICTIVE_CACHE_DURATION_MS) {
                // console.log(`[Predictive Fetch] Cache hit and fresh for ${nextUrl}.`);
                return; // Already cached and valid, do nothing
            }
            if (cachedItem) {
                console.log(`[Predictive Fetch] Cache stale for ${nextUrl}, re-fetching.`);
            }

            // 3. Initiate fetch (fire-and-forget style)
            // Ensure fetch is available in your Node.js environment
            console.log(`[Predictive Fetch] Initiating fetch for ${nextUrl} around ${new Date().toLocaleTimeString()} MDT.`);
            fetch(nextUrl)
                .then((response) => {
                    // 4. Check for network/HTTP errors
                    if (!response.ok) {
                        // Don't cache non-successful responses unless intended
                        throw new Error(`HTTP error for ${nextUrl}! Status: ${response.status}`);
                    }
                    // 5. Process the response body (e.g., assuming JSON)
                    // Add content-type checks if responses vary
                    return response.json(); // or response.text(), response.buffer() etc.
                })
                .then((data) => {
                    // 6. Store processed data and timestamp in cache
                    predictiveDataCache.set(nextUrl, { data: data, timestamp: now });
                    console.log(`[Predictive Fetch] Successfully fetched and cached data for ${nextUrl}.`);
                    // Optional: Add logic here to limit cache size if needed
                })
                .catch((error) => {
                    // 7. Crucial: Catch errors from fetch or processing
                    console.error(`[Predictive Fetch] Failed for ${nextUrl}:`, error.message);
                    // Optional: remove potentially stale/failed entry
                    // predictiveDataCache.delete(nextUrl);
                });
        };
    }
    // --- End of attachment logic ---

    // -------------------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the deviceType method conditionally
    if (!request.hasOwnProperty("deviceType")) {
        request.deviceType = () => {
            // 1. Safely get the User-Agent header function
            const getHeaderFunc = request.getHeader;
            let userAgent = ""; // Default to empty string

            if (typeof getHeaderFunc === "function") {
                try {
                    // Safely get the header, default to '' if null/undefined
                    userAgent = getHeaderFunc("user-agent") || "";
                    // No need for .toLowerCase() here if the regex is case-insensitive (/i flag)
                } catch (error) {
                    console.error(`Error executing request.getHeader('user-agent') for IP ${request.ip} around ${new Date().toLocaleTimeString()} MDT:`, error);
                    // Keep userAgent as '', will result in 'desktop' below
                }
            } else {
                // console.warn("request.getHeader function not found when determining device type.");
                // Keep userAgent as '', will result in 'desktop' below
            }

            // 2. Test the userAgent against the regex
            // An empty userAgent string will correctly return false for .test()
            if (MOBILE_UA_REGEX.test(userAgent)) {
                return "mobile";
            } else {
                return "desktop";
            }
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // This relies on request.getHeader being attached beforehand.
    /* Example prerequisite:
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    */
    // ---------------------------------

    // ------------------------------------------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the getUsageTips method conditionally
    if (!request.hasOwnProperty("getUsageTips")) {
        request.getUsageTips = () => {
            const tips = [];

            // 1. Safely check query parameter count
            // Assumes request.query was populated earlier
            const queryParams = request.query;
            if (queryParams && typeof queryParams === "object" && queryParams !== null) {
                try {
                    if (Object.keys(queryParams).length > MAX_QUERY_PARAMS_FOR_TIPS) {
                        tips.push(TIP_QUERY_PARAMS_PAGINATION);
                    }
                } catch (error) {
                    // Log error if Object.keys fails unexpectedly
                    console.error(`Error processing request.query keys for usage tips near ${new Date().toLocaleTimeString()} MDT:`, error);
                }
            } else {
                // Optionally log if query params aren't available as expected
                // console.warn("request.query not available or not an object when generating usage tips.");
            }

            // 2. Safely check for User-Agent header
            // Assumes request.getHeader was attached earlier
            const getHeaderFunc = request.getHeader;
            if (typeof getHeaderFunc === "function") {
                try {
                    if (!getHeaderFunc("user-agent")) {
                        tips.push(TIP_MISSING_USER_AGENT);
                    }
                } catch (error) {
                    console.error(`Error checking user-agent via request.getHeader near ${new Date().toLocaleTimeString()} MDT:`, error);
                }
            } else {
                // Optionally log if getHeader isn't available
                // console.warn("request.getHeader function not found when generating usage tips.");
            }

            // 3. Return the collected tips or a default positive message
            return tips.length > 0 ? tips : [TIP_REQUEST_LOOKS_GOOD];
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // This relies on request.query being populated (e.g., by a parseQuery function)
    // and request.getHeader being attached beforehand.
    /* Example prerequisites:
    if (!request.hasOwnProperty('query')) {
        request.query = parseQuery(); // Assuming parseQuery is defined
    }
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    */
    // ---------------------------------

    // -------------------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the isBot method conditionally
    if (!request.hasOwnProperty("isBot")) {
        request.isBot = () => {
            // 1. Safely get the User-Agent header function
            const getHeaderFunc = request.getHeader;
            let userAgent = ""; // Default to empty string

            if (typeof getHeaderFunc === "function") {
                try {
                    // Safely get the header, default to '', then lowercase
                    userAgent = (getHeaderFunc("user-agent") || "").toLowerCase();
                } catch (error) {
                    console.error(`Error executing request.getHeader('user-agent') for IP ${request.ip} around ${new Date().toLocaleTimeString()} MDT:`, error);
                    // Keep userAgent as '', will result in 'false' below
                }
            } else {
                // console.warn("request.getHeader function not found when checking isBot.");
                // Keep userAgent as '', will result in 'false' below
            }

            // 2. If no user agent, assume not a bot (or handle as needed)
            if (!userAgent) {
                return false;
            }

            // 3. Check if the lowercased UA contains any of the patterns
            // .some() is efficient as it stops on the first match
            const isMatch = BOT_PATTERNS.some((pattern) => userAgent.includes(pattern));

            return isMatch;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // This relies on request.getHeader being attached beforehand.
    /* Example prerequisite:
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    */
    // ---------------------------------

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach a method to get the response time as a NUMBER (in milliseconds)
    // Renamed for clarity about the return type.
    if (!request.hasOwnProperty("getResponseTimeMs")) {
        request.getResponseTimeMs = () => {
            // 1. Check if the start timer value exists
            if (!request._hrtimeStart) {
                // Log potentially, or just return null/undefined
                // console.warn(`getResponseTimeMs called before startTimer was initiated for request: ${request.url} from ${request.ip}`);
                return null; // Indicate timer wasn't started or value is missing
            }

            try {
                // 2. Calculate the high-resolution time difference [seconds, nanoseconds]
                const hrtimeDiff = process.hrtime(request._hrtimeStart);

                // 3. Convert the difference to milliseconds
                // (seconds * 1000) + (nanoseconds / 1,000,000)
                const durationMs = hrtimeDiff[0] * 1000 + hrtimeDiff[1] / 1e6;

                // 4. Return the numeric value
                return durationMs;
            } catch (error) {
                // Catch potential errors, e.g., if _hrtimeStart was somehow invalid
                console.error(`Error calculating response time near ${new Date().toLocaleTimeString()} MDT for IP ${request.ip}:`, error);
                return null; // Indicate an error occurred
            }
        };
    }

    if (!request.hasOwnProperty("getResponseTimeString")) {
        request.getResponseTimeString = (precision = 3) => {
            const durationMs = request.getResponseTimeMs(); // Use the numeric getter

            if (durationMs === null) {
                return "N/A"; // Or however you want to represent unknown time
            }
            // Format the number to a fixed precision string
            return `${durationMs.toFixed(precision)}ms`;
        };
    }

    // --- Optional: If you frequently need the formatted string version ---
    /*
    if (!request.hasOwnProperty('getResponseTimeString')) {
        request.getResponseTimeString = (precision = 3) => {
            const durationMs = request.getResponseTimeMs(); // Use the numeric getter
    
            if (durationMs === null) {
                return 'N/A'; // Or however you want to represent unknown time
            }
            // Format the number to a fixed precision string
            return `${durationMs.toFixed(precision)}ms`;
        };
    }
    */
    // --- End of attachment logic ---

    // --- NOTE ---
    // This relies on request.startTimer() having been called earlier in the request
    // lifecycle to set the request._hrtimeStart property.

    // Example: Add IP (assuming it's not already added)
    if (!request.hasOwnProperty("autoPrioritize")) {
        request.autoPrioritize = () => {
            if (request.getHeader("x-vip-user")) return "high";
            if (request.method === "GET") return "medium";
            return "low";
        };
    }

    if (!request.hasOwnProperty("autoFill")) {
        request.autoFill = () => {
            // 1. Check if session exists, return unmodified request if not
            if (!request.session) return request;

            // 2. Get history from session
            const history = request.session.get("lastRequest") || {};

            // 3. Iterate and potentially MUTATE request.body
            Object.keys(history).forEach((key) => {
                // Assumes request.body exists and is an object here
                if (request.body && !request.body.hasOwnProperty(key) && history[key]) {
                    request.body[key] = history[key];
                }
            });

            // 4. Return the request object
            return request;
        };
    }

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the startTimer method conditionally
    if (!request.hasOwnProperty("startTimer")) {
        request.startTimer = () => {
            // Store the high-resolution start time directly on the request object.
            // Using a name like _hrtimeStart makes its purpose clear.
            // The underscore conventionally suggests it's for internal use within your decorator logic.
            request._hrtimeStart = process.hrtime();

            // Optional: You could add a simple timestamp for logging if needed
            // request._startTimeMs = Date.now();
            // console.log(`Request timer started for IP ${request.ip} around ${new Date().toLocaleTimeString()} MDT.`);
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT NOTE ---
    // This 'startTimer' function only records the start time.
    // You need a corresponding function to calculate the duration when needed.
    // Example companion function:
    /*
    
    
    
    
    if (!request.hasOwnProperty('getDuration')) {
        request.getDuration = () => {
            // Check if the timer was actually started
            if (!request._hrtimeStart) {
                console.warn("getDuration called before startTimer for request:", request.url);
                return null; // Or 0, or throw an error, depending on desired behavior
            }
            // Get the difference [seconds, nanoseconds] from the start time
            const hrtimeEnd = process.hrtime(request._hrtimeStart);
            // Convert to milliseconds: (seconds * 1000) + (nanoseconds / 1,000,000)
            const durationMs = (hrtimeEnd[0] * 1000) + (hrtimeEnd[1] / 1e6);
            return durationMs;
        };
    }
    
    // --- Example Usage Later in Request Lifecycle (e.g., just before sending response) ---
    // request.startTimer(); // Call early in the request
    // ... process request ...
    // const duration = request.getDuration();
    // if (duration !== null) {
    //     console.log(`Request took ${duration.toFixed(3)} ms`);
    //     response.setHeader('X-Response-Time', `${duration.toFixed(3)}ms`);
    // }
    */

    if (!request.hasOwnProperty("getDuration")) {
        request.getDuration = () => {
            // Check if the timer was actually started
            if (!request._hrtimeStart) {
                console.warn("getDuration called before startTimer for request:", request.url);
                return null; // Or 0, or throw an error, depending on desired behavior
            }
            // Get the difference [seconds, nanoseconds] from the start time
            const hrtimeEnd = process.hrtime(request._hrtimeStart);
            // Convert to milliseconds: (seconds * 1000) + (nanoseconds / 1,000,000)
            const durationMs = hrtimeEnd[0] * 1000 + hrtimeEnd[1] / 1e6;
            return durationMs;
        };
    }

    // --- Place this INSIDE module.exports = (request, response) => { ... } ---

    // Attach the method conditionally (using the pattern you chose)
    if (!request.hasOwnProperty("smartRoute")) {
        request.smartRoute = () => {
            // Define constants for paths for clarity and maintainability
            const MOBILE_ROUTE = "/mobile-dashboard";
            const INTERNAL_ROUTE = "/internal-network";
            const DEFAULT_ROUTE = "/default-home";

            // 1. Safely get dependencies (assuming they were attached earlier)
            // Use nullish coalescing (??) to provide defaults if properties are null/undefined
            const ipAddress = request.ip ?? "";
            const deviceTypeFunc = request.deviceType; // Reference the function

            // 2. Determine device type safely
            let calculatedDeviceType = "unknown"; // Default value
            if (typeof deviceTypeFunc === "function") {
                try {
                    // Call the function, provide default if it returns null/undefined
                    calculatedDeviceType = deviceTypeFunc() ?? "unknown";
                } catch (error) {
                    console.error(`Error executing request.deviceType for IP ${ipAddress} around ${new Date().toLocaleTimeString()} MDT:`, error);
                    // Keep 'unknown', or implement other error handling
                }
            } else {
                // Log if the expected function isn't there
                // console.warn("request.deviceType function not found when determining smart route.");
            }

            // 3. Apply routing logic
            if (calculatedDeviceType === "mobile") {
                return MOBILE_ROUTE;
            }

            // Check IP (using the safe ipAddress variable)
            // Note: startsWith('192.') is broad. '192.168.' targets common private networks more specifically.
            // Adjust this check based on your actual definition of "internal-network"
            if (ipAddress.startsWith("192.168.")) {
                return INTERNAL_ROUTE;
            }

            // 4. Return default if no other condition met
            return DEFAULT_ROUTE;
        };
    }
    // --- End of attachment logic ---

    // --- IMPORTANT PRE-REQUISITES ---
    // For request.smartRoute to work, make sure request.ip and request.deviceType
    // (which itself might depend on request.getHeader) are attached *before* this point
    // in your decorator function. For example:
    /*
    if (!request.hasOwnProperty('ip')) {
        request.ip = request.socket.remoteAddress;
    }
    if (!request.hasOwnProperty('getHeader')) {
        request.getHeader = (name) => request.headers[name.toLowerCase()] || null;
    }
    if (!request.hasOwnProperty('deviceType')) {
        request.deviceType = () => {
            const ua = (request.getHeader('user-agent') || '').toLowerCase();
            return /mobile|android|iphone|ipad|ipod/.test(ua) ? "mobile" : "desktop";
        };
    }
    */
    // ---------------------------------

    // Attach the method conditionally (using the pattern you chose)
    if (!request.hasOwnProperty("detectAnomalies")) {
        request.detectAnomalies = () => {
            // 1. Get IP (ensure it's populated correctly beforehand)
            const ip = request.ip;
            if (!ip) {
                // Cannot perform check without IP
                console.warn("[Security] Cannot detect anomalies: request.ip is not set.");
                return "allow"; // Default to allow if IP is missing? Or throw error?
            }

            const now = Date.now();

            // 2. Get previous timestamps, defaulting to empty array
            const previousTimestamps = requestTracker.get(ip) || [];

            // 3. Filter out timestamps older than the defined window
            //    It's slightly more efficient to filter *before* adding the new one
            const recentTimestamps = previousTimestamps.filter((time) => now - time < ANOMALY_WINDOW_MS);

            // 4. Add the current request's timestamp
            recentTimestamps.push(now);

            // 5. Update the tracker with the latest list (pruned + current)
            requestTracker.set(ip, recentTimestamps);

            // 6. Check the count of *recent* requests against the limit
            if (recentTimestamps.length > ANOMALY_LIMIT) {
                // Optional: Log less frequently to avoid spamming logs in an attack
                // if (recentTimestamps.length === ANOMALY_LIMIT + 1) { // Log only when limit first exceeded
                console.warn(`[Security] Anomaly detected for IP ${ip}: ${recentTimestamps.length} requests seen in the last ${ANOMALY_WINDOW_MS / 1000} seconds (around ${new Date(now).toLocaleTimeString()} MDT).`);
                // }
                return "block"; // Indicate blocking is needed
            }

            // 7. If limit not exceeded, allow
            return "allow";
        };
    }
    // --- End of attachment logic ---

    // Example: Add IP (assuming it's not already added)
    if (!request.hasOwnProperty("ip")) {
        request.ip = request.socket.remoteAddress; // Or more complex proxy logic
    }

    // Attach methods directly - 'request' inside refers correctly to the current request object
    if (!request.hasOwnProperty("isSuspicious")) {
        // Check is optional for custom methods
        request.isSuspicious = () => {
            const ip = request.ip; // Uses the 'ip' attached to this request
            const now = Date.now();
            const requests = anomalyTracker.get(ip) || [];
            const recentRequests = requests.filter((t) => now - t < 10000);
            recentRequests.push(now);
            anomalyTracker.set(ip, recentRequests);
            return recentRequests.length > 10;
        };
    }
};
