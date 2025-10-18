"use strict";

// src/submodules/middleware/rate-limiter/index.js

const { promises: fs, createReadStream, statSync } = require("fs");
const { join, extname } = require("path");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const http = require("http");
const { performance } = require("perf_hooks");

// Assuming 'http', 'path', 'url', 'events' (implicitly used by streams) are available
const querystring = require("querystring"); // Core Node.js module for URL-encoded parsing

const zlib = require("zlib");
const { promisify } = require("util");
const stream = require("stream"); // Needed for stream.pipeline

// Promisify zlib functions for async buffer compression
const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

// ===== RateLimiter helpers (zero-dep) =====
const RATE_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseRateString(rate) {
    if (typeof rate === "number") return { limit: rate, intervalMs: 1_000 };
    if (typeof rate !== "string") return null;
    const s = rate.trim().toLowerCase();
    // Accept: "100/s", "300/m", "10/h", "1/d"
    const m = s.match(/^(\d+)\s*\/\s*([smhd])$/);
    if (!m) return null;
    const limit = parseInt(m[1], 10);
    const unit = m[2];
    return { limit, intervalMs: RATE_UNIT_MS[unit] };
}
function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
}
function canonicalizeKey(s) {
    if (typeof s !== "string") s = String(s);
    // Unicode NFC is not available without deps; keep ASCII-safe canonicalization
    return s.trim().toLowerCase();
}
function nowMs() {
    return Date.now();
} // wall clock (headers/TTL)
function monoMs() {
    return performance.timeOrigin + performance.now();
} // monotonic (algorithms)
function isFn(x) {
    return typeof x === "function";
}
function isPromise(x) {
    return !!x && typeof x.then === "function" && typeof x.catch === "function";
}

const SYM_POLICY = Symbol("rawnode:ratelimit:policy");
const SYM_DECISION = Symbol("rawnode:ratelimit:decision");

// Default settings (can be overridden in options)
const DEFAULT_COMPRESSION_THRESHOLD = 1024; // Min bytes to compress
const DEFAULT_COMPRESSIBLE_TYPES = new Set(["text/plain", "text/html", "text/css", "text/javascript", "application/javascript", "application/json", "application/xml", "image/svg+xml"]);

class RateLimiter {
    static create(opts = {}) {
        return new RateLimiter(opts);
    }

    /**
     * Creates a RateLimiter instance.
     * @param {object} [options] - Configuration options.
     * @param {number} [options.windowMs=60000] - The time window in milliseconds.
     * @param {number} [options.max=100] - Max requests allowed per IP per windowMs.
     */
    constructor(options = {}) {
        this.windowMs = options.windowMs || 60 * 1000; // 1 minute
        this.max = options.max || 100; // Max requests per window
        this.cleanupInterval = setInterval(() => this.cleanup(), this.windowMs);
        this.cleanupInterval.unref(); // Don't prevent process exit
        this.windowMs = options.windowMs || 60 * 1000; // Default: 1 minute
        this.max = options.max || 100; // Default: 100 requests per window

        /**
         * Stores request timestamps for each IP address.
         * Key: IP Address (string)
         * Value: Array of timestamps (number) within the window.
         * @type {Map<string, number[]>}
         */
        this.store = new Map();
        // ===== New fields (do not remove legacy) =====
        this.trustProxy = options.trustProxy || false; // bool | fn(req)->ip
        this.keyFn = isFn(options.key) ? options.key : null; // optional key derivation
        this.emitHeaders = options.emitHeaders || "on-block"; // "always" | "on-block" | "never"

        this._policies = new Map(); // name -> normalized policy
        this._shadow = []; // array of normalized policies for shadow eval
        this._buckets = new Map(); // key -> state (token bucket / gcra / window)
        this._concurrency = new Map(); // key -> in-flight count

        // Basic metrics (zero-dep counters/hist)
        this._metrics = {
            rl_requests_total: { allow: 0, block: 0, policy: {} },
            rl_block_total: { total: 0, reason: {} },
            rl_remaining_gauge: { policy: {} },
            rl_concurrency_in_flight: { policy: {} },
            rl_check_latency_us: { samples: 0, p50: 0, p95: 0, p99: 0 },
        };

        this._metrics.rl_adapter_latency_ms = {
            get: { samples: 0, p50: 0, p95: 0, p99: 0 },
            put: { samples: 0, p50: 0, p95: 0, p99: 0 },
        };

        // Hooks registry
        this._hooks = {
            beforeKey: [],
            beforeEvaluate: [],
            afterDecision: [],
            onBlock: [],
            onQuotaChange: [],
            onAnomaly: [],
            onError: [],
        };
        this._plugins = [];
        // Ensure adapter latency metrics exist (including 'incr')
        if (!this._metrics.rl_adapter_latency_ms) {
            this._metrics.rl_adapter_latency_ms = {
                get: { samples: 0, p50: 0, p95: 0, p99: 0 },
                put: { samples: 0, p50: 0, p95: 0, p99: 0 },
                incr: { samples: 0, p50: 0, p95: 0, p99: 0 },
            };
        } else if (!this._metrics.rl_adapter_latency_ms.incr) {
            this._metrics.rl_adapter_latency_ms.incr = { samples: 0, p50: 0, p95: 0, p99: 0 };
        }

        this.adapter = options.adapter || null;
        this._adapter = this.adapter ? this._normalizeAdapter(this.adapter) : null;

        this._queues = new Map(); // key -> [{ req,res,next, timer, enqueuedAt, policy }]

        // Normalize default policy
        const defaultPolicyInput = options.default || {
            policy: "sliding-window",
            // from legacy knobs to keep backward behavior if default not provided
            rate: `${this.max}/m`,
            burst: this.max,
        };
        this._policies.set("default", this._normalizePolicy("default", defaultPolicyInput));

        // Maintenance sweep for TTL'd buckets (cooperative)
        this._sweepTimer = setInterval(() => {
            try {
                this._sweep();
            } catch (e) {
                /* swallow to stay non-blocking */
            }
        }, Math.max(5_000, Math.min(this.windowMs, 60_000)));
        this._sweepTimer.unref();
    }

    /**
     * Checks if a request from a given IP is allowed under the sliding window limit.
     * This method also performs cleanup of old timestamps.
     * @param {string} ip - The client IP address.
     * @returns {boolean} - True if the request is allowed, false if it should be rejected.
     */
    check(arg) {
        // === New: advanced signature ===
        if (typeof arg === "object" && arg !== null) {
            try {
                return this._checkAdvanced(arg); // returns decision object
            } catch (err) {
                // Safety: never break hot path; fall back to allow on internal error
                try {
                    this._runHook("onError", { err, where: "checkAdvanced" });
                } catch {}
                return { allowed: true, headers: {}, reason: "internal_error_fallback" };
            }
        }

        // === Legacy behavior preserved: sliding window per-IP, boolean ===
        const ip = String(arg);
        const now = Date.now();
        const windowStart = now - this.windowMs;

        let timestamps = this.store.get(ip);
        let recentTimestamps = [];

        if (timestamps) {
            recentTimestamps = timestamps.filter((ts) => ts >= windowStart);
        }

        if (recentTimestamps.length >= this.max) {
            this.store.set(ip, recentTimestamps);
            return false; // deny (legacy)
        } else {
            recentTimestamps.push(now);
            this.store.set(ip, recentTimestamps);
            return true; // allow (legacy)
        }
    }

    cleanup() {
        const now = nowMs();
        // Legacy sliding-window store cleanup (ip -> [timestamps])
        for (const [ip, timestamps] of this.store) {
            const windowStart = now - this.windowMs;
            const filtered = Array.isArray(timestamps) ? timestamps.filter((ts) => ts >= windowStart) : [];
            if (filtered.length === 0) this.store.delete(ip);
            else this.store.set(ip, filtered);
        }
        // New bucket TTL cleanup
        for (const [key, st] of this._buckets) {
            if (st && typeof st.expiresAt === "number" && st.expiresAt <= now) {
                this._buckets.delete(key);
            }
        }
    }

    // The cleanup() method is no longer needed and can be removed.
    // cleanup() { /* ... REMOVE ... */ }

    // The middleware() method can remain unchanged if you want to keep that pattern available,
    // although the server currently calls check() directly.
    middleware() {
        return (req, res, next) => {
            // ===== Advanced path (policies, cost, concurrency, headers, queue) =====
            try {
                const policy = this._getPolicyForReq(req); // per-route or default
                if (policy) {
                    const key = this._deriveKey(req, policy);
                    const cost = isFn(policy.cost) ? Number(policy.cost(req)) : Number(policy.cost || 1);
                    const start = performance.now();

                    // Shadow policies (evaluate, never block)
                    if (this._shadow.length > 0) {
                        for (const sp of this._shadow) {
                            try {
                                this._checkAdvanced({ key: this._deriveKey(req, sp), cost, policy: sp, now: nowMs(), shadow: true });
                            } catch {}
                        }
                    }

                    // Concurrency queue overflow handling
                    if (policy.concurrency && policy.concurrency > 0 && policy.overflow === "queue") {
                        const acq = this._tryAcquireImmediate(key, policy);
                        if (!acq.acquired) {
                            const ok = this._enqueue(key, policy, { req, res, next, key, policy });
                            if (!ok) {
                                const headers = this._buildHeaders(policy, { limit: policy.limit, remaining: 0, resetMs: policy.intervalMs, now: nowMs() }, "queue_full");
                                res.statusCode = policy.shedStatus || 503;
                                for (const [h, v] of Object.entries(headers)) res.setHeader(h, v);
                                res.end("Service Unavailable");
                                this._incMetricBlock(policy.name, "queue_full");
                                this._runHook("onBlock", { req, policy, decision: { allowed: false, reason: "queue_full" } });
                                return;
                            }
                            // Enqueued; resume later
                            return;
                        }

                        // Acquired immediately: skip concurrency check inside evaluator
                        const maybe = this._checkAdvanced({ key, cost, policy, now: nowMs(), concurrencyAcquired: true });
                        const handle = (decision) => {
                            const dtUs = Math.floor((performance.now() - start) * 1000);
                            this._observeLatency(dtUs);
                            try {
                                req[SYM_DECISION] = decision;
                            } catch {}
                            if (decision.headers && (this.emitHeaders === "always" || (this.emitHeaders === "on-block" && !decision.allowed))) {
                                for (const [h, v] of Object.entries(decision.headers)) res.setHeader(h, v);
                            }
                            if (!decision.allowed) {
                                try {
                                    acq.release();
                                } catch {}
                                this._incMetricBlock(policy.name, decision.reason || "limit");
                                this._runHook("onBlock", { req, policy, decision });
                                res.statusCode = decision.statusCode || 429;
                                if (decision.headers) for (const [h, v] of Object.entries(decision.headers)) res.setHeader(h, v);
                                res.end("Too Many Requests");
                                return;
                            }
                            const releaseFn = decision.release || acq.release;
                            res.once("finish", () => {
                                try {
                                    releaseFn();
                                } catch {}
                                this._drainQueue(key, policy);
                            });
                            res.once("close", () => {
                                try {
                                    releaseFn();
                                } catch {}
                                this._drainQueue(key, policy);
                            });
                            this._runHook("afterDecision", { req, policy, decision });
                            return next();
                        };
                        if (isPromise(maybe))
                            maybe.then(handle).catch((err) => {
                                try {
                                    this._runHook("onError", { err, where: "middleware.queue" });
                                } catch {}
                                try {
                                    acq.release();
                                } catch {}
                                next();
                            });
                        else handle(maybe);
                        return;
                    }

                    // Normal path (reject/503/shed or no concurrency limit)
                    const maybeDecision = this._checkAdvanced({ key, cost, policy, now: nowMs() });
                    const handleDecision = (decision) => {
                        const dtUs = Math.floor((performance.now() - start) * 1000);
                        this._observeLatency(dtUs);
                        try {
                            req[SYM_DECISION] = decision;
                        } catch {}
                        if (decision.headers && (this.emitHeaders === "always" || (this.emitHeaders === "on-block" && !decision.allowed))) {
                            for (const [h, v] of Object.entries(decision.headers)) res.setHeader(h, v);
                        }
                        if (!decision.allowed) {
                            const status = decision.statusCode || 429;
                            this._incMetricBlock(policy.name, decision.reason || "limit");
                            this._runHook("onBlock", { req, policy, decision });
                            res.statusCode = status;
                            if (decision.headers) for (const [h, v] of Object.entries(decision.headers)) res.setHeader(h, v);
                            res.end("Too Many Requests");
                            return;
                        }
                        if (isFn(decision.release)) {
                            res.once("finish", () => {
                                try {
                                    decision.release();
                                } catch {}
                            });
                            res.once("close", () => {
                                try {
                                    decision.release();
                                } catch {}
                            });
                        }
                        this._runHook("afterDecision", { req, policy, decision });
                        return next();
                    };
                    if (isPromise(maybeDecision))
                        maybeDecision.then(handleDecision).catch((err) => {
                            try {
                                this._runHook("onError", { err, where: "middleware.async" });
                            } catch {}
                            next();
                        });
                    else handleDecision(maybeDecision);
                    return;
                }
            } catch (err) {
                try {
                    this._runHook("onError", { err, where: "middleware" });
                } catch {}
                return next();
            }

            // ===== Legacy fallback (unchanged) =====
            const ip = req.socket.remoteAddress; // Or check headers like X-Forwarded-For
            if (this.check(ip)) {
                return next();
            }
            res.writeHead(429, { "Content-Type": "text/plain", Connection: "close" });
            res.end("Too many requests");
        };
    }

    // ===== Public API (Express DX) =====
    policy(nameOrOpts) {
        const p = typeof nameOrOpts === "string" ? this._policies.get(nameOrOpts) || this._policies.get("default") : this._normalizePolicy(undefined, nameOrOpts);
        return (req, _res, next) => {
            try {
                req[SYM_POLICY] = p;
            } catch {}
            next();
        };
    }
    updatePolicy(name, opts) {
        const P = this._normalizePolicy(name, opts);
        this._policies.set(P.name || name || "default", P);
        this._runHook("onQuotaChange", { policy: P, action: "update" });
        return P;
    }
    removePolicy(name) {
        this._policies.delete(name);
        this._runHook("onQuotaChange", { name, action: "remove" });
    }
    shadow(nameOrOpts) {
        const P = typeof nameOrOpts === "string" ? this._policies.get(nameOrOpts) || this._policies.get("default") : this._normalizePolicy(undefined, nameOrOpts);
        this._shadow.push(P);
        return this;
    }
    async refund({ key, cost = 1, policyName = "default" }) {
        const p = this._policies.get(policyName) || this._policies.get("default");
        if (!p) return false;
        const st = this._getBucket(key, p, nowMs());
        switch (p.policy) {
            case "token-bucket":
                st.tokens = clamp(st.tokens + cost, 0, p.capacity);
                break;
            case "fixed-window":
                st.count = Math.max(0, (st.count || 0) - cost);
                break;
            case "sliding-window":
                // approximate refund by decrementing current window counter
                st.count = Math.max(0, (st.count || 0) - cost);
                break;
            case "gcra":
                // refund not naturally defined; conservatively reduce TAT
                st.tat = Math.max(0, st.tat - p.EI * cost);
                break;
        }
        this._setBucket(key, st, p, nowMs());
        return true;
    }
    explain(reqOrKey) {
        if (typeof reqOrKey === "string") {
            const key = canonicalizeKey(reqOrKey);
            const p = this._policies.get("default");
            const st = this._buckets.get(key);
            return { key, policy: p?.name || "default", state: st || null };
        }
        const d = reqOrKey && reqOrKey[SYM_DECISION];
        if (!d) return { info: "no-decision-attached" };
        return {
            policy: d.policy?.name,
            allowed: d.allowed,
            reason: d.reason,
            remaining: d.remaining,
            reset: d.reset,
            limit: d.limit,
            headers: d.headers,
        };
    }
    use(plugin, { namespace, order } = {}) {
        if (!plugin) return this;
        const ns = namespace || plugin.name || `plugin-${this._plugins.length}`;
        this._plugins.push({ ns, order: order || 0, plugin });
        if (isFn(plugin.register)) {
            try {
                plugin.register(this);
            } catch (err) {
                this._runHook("onError", { err, where: "plugin.register" });
            }
        }
        return this;
    }
    stats() {
        // shallow snapshot; keep zero-dep
        return JSON.parse(JSON.stringify(this._metrics));
    }

    // ===== Check Advanced (core evaluator) =====
    _checkAdvanced({ key, cost = 1, now = nowMs(), policy, policyName, shadow = false, concurrencyAcquired = false }) {
        const p = policy || this._policies.get(policyName || "default");
        if (!p) return { allowed: true, headers: {}, reason: "no_policy" };

        // Hooks
        this._runHook("beforeKey", { key, policy: p });
        this._runHook("beforeEvaluate", { key, policy: p, cost });

        const _key = canonicalizeKey(key);
        // === Fixed-window atomic fast path (distributed): use adapter.incrWithTTL when available ===
        if (p.policy === "fixed-window" && this._adapter && this._adapter.incrWithTTL) {
            const startMono = monoMs();
            const promise = this._evalFixedWindowAtomic(_key, p, cost, now)
                .then((res) => {
                    const elapsedUs = (monoMs() - startMono) * 1000;
                    this._observeLatency(Math.floor(elapsedUs));

                    const headers = this._buildHeaders(p, res, res.reason, res.now || now);

                    if (!shadow) {
                        const pol = p.name;
                        this._metrics.rl_requests_total.policy[pol] = (this._metrics.rl_requests_total.policy[pol] || 0) + 1;
                        if (res.allowed) this._metrics.rl_requests_total.allow++;
                        else {
                            this._metrics.rl_requests_total.block++;
                            this._incMetricBlock(pol, res.reason || "limit");
                        }
                        this._metrics.rl_remaining_gauge.policy[pol] = res.remaining;
                    }

                    const decision = {
                        allowed: res.allowed,
                        statusCode: res.allowed ? 200 : 429,
                        headers,
                        reason: res.reason || (res.allowed ? "ok" : "limit"),
                        remaining: res.remaining,
                        reset: Math.ceil((res.resetMs || p.intervalMs) / 1000),
                        limit: p.limit,
                        policy: p,
                    };

                    if (p.concurrency && p.concurrency > 0 && !shadow && !concurrencyAcquired) {
                        // We pre-acquired above (non-queue overflow); hand back a release hook
                        decision.release = () => this._releaseConcurrency(_key, p);
                    }
                    if (!res.allowed && p.concurrency && p.concurrency > 0 && !shadow && !concurrencyAcquired) {
                        // Blocked; free the slot immediately
                        this._releaseConcurrency(_key, p);
                    }
                    return decision;
                })
                .catch((err) => {
                    try {
                        this._runHook("onError", { err, where: "checkAdvanced.fixedWindowAtomic" });
                    } catch {}
                    // Soft-fail: allow on adapter error
                    return { allowed: true, headers: {}, reason: "adapter_error_allow", limit: p.limit, remaining: p.limit, reset: Math.ceil(p.intervalMs / 1000), policy: p };
                });
            return promise;
        }

        const stOrPromise = this._getBucket(_key, p, now);
        const evaluate = (st) => {
            // Policy algorithms
            let res;
            const start = monoMs();
            switch (p.policy) {
                case "token-bucket":
                    res = this._evalTokenBucket(st, p, cost, now);
                    break;
                case "gcra":
                    res = this._evalGCRA(st, p, cost, now);
                    break;
                case "fixed-window":
                    res = this._evalFixedWindow(st, p, cost, now);
                    break;
                case "sliding-window":
                    res = this._evalSlidingWindow(st, p, cost, now);
                    break;
                default:
                    res = this._evalSlidingWindow(st, p, cost, now);
                    break;
            }
            const elapsedUs = (monoMs() - start) * 1000;
            this._observeLatency(Math.floor(elapsedUs));

            // Persist & headers
            this._setBucket(_key, st, p, now);
            const headers = this._buildHeaders(p, res, res.reason, res.now || now);

            // Metrics
            if (!shadow) {
                const pol = p.name;
                this._metrics.rl_requests_total.policy[pol] = (this._metrics.rl_requests_total.policy[pol] || 0) + 1;
                if (res.allowed) this._metrics.rl_requests_total.allow++;
                else {
                    this._metrics.rl_requests_total.block++;
                    this._incMetricBlock(pol, res.reason || "limit");
                }
                this._metrics.rl_remaining_gauge.policy[pol] = res.remaining;
            }

            // Decision
            const decision = {
                allowed: res.allowed,
                statusCode: res.allowed ? 200 : res.reason === "concurrency" ? (p.overflow === "503" || p.overflow === "shed" ? p.shedStatus || 503 : 429) : 429,
                headers,
                reason: res.reason || (res.allowed ? "ok" : "limit"),
                remaining: res.remaining,
                reset: Math.ceil((res.resetMs || p.intervalMs) / 1000),
                limit: p.limit,
                policy: p,
            };
            if (p.concurrency && p.concurrency > 0 && !shadow && !concurrencyAcquired) {
                decision.release = release;
            }
            if (concurrencyAcquired && !decision.release) {
                decision.release = () => this._releaseConcurrency(_key, p);
            }
            if (!res.allowed && p.concurrency && p.concurrency > 0 && !shadow && !concurrencyAcquired) {
                // If blocked and we pre-incremented concurrency, release immediately
                release();
            }
            return decision;
        };
        if (isPromise(stOrPromise)) {
            return stOrPromise.then(evaluate).catch((err) => {
                try {
                    this._runHook("onError", { err, where: "checkAdvanced.getBucket" });
                } catch {}
                return { allowed: true, headers: {}, reason: "adapter_error_allow" };
            });
        }
        const st = stOrPromise;
        //return evaluate(st);

        // Concurrency gate (pre-check)
        // Concurrency gate (pre-check) — skip if already acquired or queue-mode handled in middleware
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this._releaseConcurrency(_key, p);
        };
        if (p.concurrency && p.concurrency > 0 && !shadow && !concurrencyAcquired && p.overflow !== "queue") {
            const cur = this._concurrency.get(_key) || 0;
            if (cur >= p.concurrency) {
                const headers = this._buildHeaders(p, { limit: p.limit, remaining: 0, resetMs: p.intervalMs, now }, "concurrency");
                const status = p.overflow === "503" || p.overflow === "shed" ? p.shedStatus || 503 : 429;
                return { allowed: false, statusCode: status, reason: "concurrency", headers };
            }
            this._concurrency.set(_key, cur + 1);
            const gauge = this._metrics.rl_concurrency_in_flight.policy[p.name] || 0;
            this._metrics.rl_concurrency_in_flight.policy[p.name] = gauge + 1;
        }

        // Policy algorithms
        let res;
        const start = monoMs();
        switch (p.policy) {
            case "token-bucket":
                res = this._evalTokenBucket(st, p, cost, now);
                break;
            case "gcra":
                res = this._evalGCRA(st, p, cost, now);
                break;
            case "fixed-window":
                res = this._evalFixedWindow(st, p, cost, now);
                break;
            case "sliding-window":
                res = this._evalSlidingWindow(st, p, cost, now);
                break;
            default:
                res = this._evalSlidingWindow(st, p, cost, now);
                break;
        }
        const elapsedUs = (monoMs() - start) * 1000;
        this._observeLatency(Math.floor(elapsedUs));

        // Persist & headers
        this._setBucket(_key, st, p, now);
        const headers = this._buildHeaders(p, res, res.reason, res.now || now);

        // Metrics
        if (!shadow) {
            const pol = p.name;
            this._metrics.rl_requests_total.policy[pol] = (this._metrics.rl_requests_total.policy[pol] || 0) + 1;
            if (res.allowed) this._metrics.rl_requests_total.allow++;
            else {
                this._metrics.rl_requests_total.block++;
                this._incMetricBlock(pol, res.reason || "limit");
            }
            this._metrics.rl_remaining_gauge.policy[pol] = res.remaining;
        }

        // Decision
        const decision = {
            allowed: res.allowed,
            statusCode: res.allowed ? 200 : res.reason === "concurrency" ? (p.overflow === "503" ? 503 : 429) : 429,
            headers,
            reason: res.reason || (res.allowed ? "ok" : "limit"),
            remaining: res.remaining,
            reset: Math.ceil((res.resetMs || p.intervalMs) / 1000),
            limit: p.limit,
            policy: p,
        };
        if (p.concurrency && p.concurrency > 0 && !shadow) {
            decision.release = release;
        }
        if (!res.allowed && p.concurrency && p.concurrency > 0 && !shadow) {
            // If blocked and we pre-incremented concurrency, release immediately
            release();
        }
        return decision;
    }

    // ===== Evaluation engines (allocation-light) =====
    _evalTokenBucket(st, p, cost, now) {
        // Refill
        const deltaMs = Math.max(0, now - st.last);
        if (deltaMs > 0) {
            const refill = p.ratePerMs * deltaMs;
            st.tokens = clamp(st.tokens + refill, 0, p.capacity);
            st.last = now;
        }
        const need = cost;
        const allowed = st.tokens >= need;
        if (allowed) st.tokens -= need;

        const remaining = Math.floor(st.tokens);
        // time to reset ~ time to fill to capacity
        const deficit = Math.max(0, need - st.tokens);
        const resetMs = deficit > 0 ? Math.ceil(deficit / p.ratePerMs) : Math.ceil((p.capacity - st.tokens) / p.ratePerMs);
        return { allowed, remaining, resetMs, limit: p.limit, reason: allowed ? "ok" : "limit", now };
    }
    _evalGCRA(st, p, cost, now) {
        // GCRA based on TAT (ms), EI = intervalMs / limit
        const arrival = now;
        const tat = st.tat || 0;
        const EI = p.EI * cost;
        const L = p.burstAllowance; // burst * EI

        const allowedAt = tat - L;
        const allowedNow = arrival >= allowedAt;
        const newTat = Math.max(tat, arrival) + EI;

        if (allowedNow) {
            st.tat = newTat;
            const remainingBurst = Math.max(0, Math.floor((st.tat - arrival) / p.EI));
            // reset is time until we’re back to zero burst debt
            const resetMs = Math.max(0, Math.ceil(st.tat - arrival));
            return { allowed: true, remaining: remainingBurst, resetMs, limit: p.limit, reason: "ok", now };
        } else {
            const retryMs = Math.max(0, Math.ceil(allowedAt - arrival));
            return { allowed: false, remaining: 0, resetMs: retryMs, limit: p.limit, reason: "limit", now };
        }
    }
    _evalFixedWindow(st, p, cost, now) {
        const winStart = Math.floor(now / p.intervalMs) * p.intervalMs;
        if (st.windowStart !== winStart) {
            st.windowStart = winStart;
            st.count = 0;
        }
        const allowed = st.count + cost <= p.limit;
        if (allowed) st.count += cost;
        const remaining = Math.max(0, p.limit - st.count);
        const resetMs = st.windowStart + p.intervalMs - now;
        return { allowed, remaining, resetMs, limit: p.limit, reason: allowed ? "ok" : "limit", now };
    }
    _evalFixedWindowAtomic(key, p, cost, now) {
        // Compute current window key and TTL (time to end-of-window + small slack)
        const winStart = Math.floor(now / p.intervalMs) * p.intervalMs;
        const resetMs = winStart + p.intervalMs - now;
        const ttlMs = Math.max(1, resetMs + 250); // add tiny slack to avoid premature expire
        const storageKey = `fw:${key}:${winStart}`;

        const t0 = performance.now();
        const inc = this._adapter.incrWithTTL(storageKey, cost, ttlMs);
        return Promise.resolve(inc)
            .then((val) => {
                this._observeAdapterLatency("incr", performance.now() - t0);
                const newCount = Number(val);
                // If adapter returns undefined/null, conservatively treat as cost
                const count = Number.isFinite(newCount) ? newCount : cost;
                const allowed = count <= p.limit;
                const remaining = Math.max(0, p.limit - count);
                return { allowed, remaining, resetMs, limit: p.limit, reason: allowed ? "ok" : "limit", now };
            })
            .catch((err) => {
                try {
                    this._runHook("onError", { err, where: "adapter.incrWithTTL" });
                } catch {}
                // On adapter error: allow (fail-open) to stay non-blocking
                return { allowed: true, remaining: p.limit, resetMs, limit: p.limit, reason: "adapter_error_allow", now };
            });
    }

    _evalSlidingWindow(st, p, cost, now) {
        // Approximate sliding window with two adjacent fixed windows
        const curStart = Math.floor(now / p.intervalMs) * p.intervalMs;
        if (st.windowStart !== curStart) {
            st.prevCount = st.count || 0;
            st.prevWindowStart = st.windowStart || curStart - p.intervalMs;
            st.windowStart = curStart;
            st.count = 0;
        }
        const weight = (now - st.windowStart) / p.intervalMs;
        const rolling = (st.prevCount || 0) * (1 - weight) + (st.count || 0);
        const allowed = rolling + cost <= p.limit;
        if (allowed) st.count += cost;
        const remaining = Math.max(0, Math.floor(p.limit - ((st.prevCount || 0) * (1 - weight) + (st.count || 0))));
        const resetMs = st.windowStart + p.intervalMs - now;
        return { allowed, remaining, resetMs, limit: p.limit, reason: allowed ? "ok" : "limit", now };
    }

    // ===== Internal: derive policy/key, headers, buckets, hooks, metrics =====
    _getPolicyForReq(req) {
        return req[SYM_POLICY] || this._policies.get("default");
    }
    _deriveKey(req, p) {
        if (this.keyFn) return canonicalizeKey(this.keyFn(req));
        if (isFn(p.key)) return canonicalizeKey(p.key(req));
        // Default: IP scope + method + route path (if present)
        const ip = this._getClientIP(req);
        const routeName = (req.route && req.route.name) || req.path || req.url || "";
        return canonicalizeKey(`${ip}:${req.method}:${routeName}`);
    }
    _getClientIP(req) {
        if (isFn(this.trustProxy)) return this.trustProxy(req);
        if (this.trustProxy === true) {
            const h = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
            if (typeof h === "string" && h.length > 0) return h.split(",")[0].trim();
        }
        return (req.socket && req.socket.remoteAddress) || "";
    }
    _buildHeaders(p, res, reason, now = nowMs()) {
        const headers = Object.create(null);
        const resetSec = Math.max(0, Math.ceil((res.resetMs || p.intervalMs) / 1000));
        headers["RateLimit-Limit"] = String(p.limit);
        headers["RateLimit-Remaining"] = String(Math.max(0, res.remaining));
        headers["RateLimit-Reset"] = String(resetSec);
        if (!res.allowed) {
            headers["Retry-After"] = String(resetSec);
        }
        return headers;
    }
    _getBucket(key, p, now) {
        if (!this._adapter) {
            let st = this._buckets.get(key);
            if (!st) {
                st = { last: now, tokens: p.capacity, tat: 0, count: 0, windowStart: 0, prevCount: 0, prevWindowStart: 0 };
                this._buckets.set(key, st);
            }
            st.expiresAt = now + Math.max(p.intervalMs, 60_000);
            return st;
        }
        const t0 = performance.now();
        const ttlMs = Math.max(p.intervalMs, 60_000);
        const prom = Promise.resolve(this._adapter.get(key))
            .then((state) => {
                this._observeAdapterLatency("get", performance.now() - t0);
                if (!state || typeof state !== "object") {
                    return { last: now, tokens: p.capacity, tat: 0, count: 0, windowStart: 0, prevCount: 0, prevWindowStart: 0, expiresAt: now + ttlMs };
                }
                if (typeof state.last !== "number") state.last = now;
                if (typeof state.tokens !== "number") state.tokens = p.capacity;
                if (typeof state.tat !== "number") state.tat = 0;
                if (typeof state.count !== "number") state.count = 0;
                if (typeof state.windowStart !== "number") state.windowStart = 0;
                if (typeof state.prevCount !== "number") state.prevCount = 0;
                if (typeof state.prevWindowStart !== "number") state.prevWindowStart = 0;
                state.expiresAt = now + ttlMs;
                return state;
            })
            .catch((err) => {
                try {
                    this._runHook("onError", { err, where: "adapter.get" });
                } catch {}
                return { last: now, tokens: p.capacity, tat: 0, count: 0, windowStart: 0, prevCount: 0, prevWindowStart: 0, expiresAt: now + ttlMs };
            });
        return prom;
    }

    _setBucket(key, st, p, now) {
        const ttlMs = Math.max(p.intervalMs, 60_000);
        st.expiresAt = now + ttlMs;
        if (!this._adapter) {
            this._buckets.set(key, st);
            return;
        }
        const t0 = performance.now();
        Promise.resolve(this._adapter.put(key, st, ttlMs))
            .then(() => {
                this._observeAdapterLatency("put", performance.now() - t0);
            })
            .catch((err) => {
                try {
                    this._runHook("onError", { err, where: "adapter.put" });
                } catch {}
            });
    }

    _normalizePolicy(name, input) {
        const out = Object.assign({}, input || {});
        out.name = out.name || name || "default";
        out.policy = (out.policy || "sliding-window").toLowerCase();
        // Rate normalization
        if (out.rate) {
            const pr = parseRateString(out.rate);
            if (!pr) throw new Error(`RateLimiter: invalid rate '${out.rate}'`);
            out.limit = pr.limit;
            out.intervalMs = pr.intervalMs;
        } else {
            // accept explicit limit+intervalMs
            out.limit = typeof out.limit === "number" ? out.limit : 60;
            out.intervalMs = typeof out.intervalMs === "number" ? out.intervalMs : 60_000;
        }
        out.burst = typeof out.burst === "number" ? out.burst : out.limit;
        // Token bucket precompute
        out.capacity = out.burst;
        out.ratePerMs = out.limit / out.intervalMs;
        // GCRA precompute
        out.EI = out.intervalMs / out.limit; // emission interval (ms/token)
        out.burstAllowance = out.EI * out.burst; // burst * EI
        // Concurrency & overflow
        // Concurrency & overflow
        if (typeof out.concurrency !== "number") out.concurrency = 0;
        // overflow: "reject" | "503" | "queue" | "shed"
        const o = (out.overflow || "reject").toString().toLowerCase();
        out.overflow = o === "503" || o === "queue" || o === "shed" ? o : "reject";
        out.queueMax = typeof out.queueMax === "number" ? out.queueMax : Math.max(100, out.limit);
        out.queueTimeoutMs = typeof out.queueTimeoutMs === "number" ? out.queueTimeoutMs : out.intervalMs;
        out.shedStatus = out.shedStatus === 429 ? 429 : 503; // default 503 for shed

        // cost (fn or number)
        if (!("cost" in out)) out.cost = 1;
        // headers emission override
        out.emitHeaders = out.emitHeaders || this.emitHeaders || "on-block";
        return out;
    }
    _runHook(name, payload) {
        const arr = this._hooks[name];
        if (!arr || arr.length === 0) return;
        for (let i = 0; i < arr.length; i++) {
            try {
                arr[i](payload);
            } catch {
                /* never throw */
            }
        }
    }
    _incMetricBlock(policyName, reason) {
        this._metrics.rl_block_total.total++;
        this._metrics.rl_block_total.reason[reason] = (this._metrics.rl_block_total.reason[reason] || 0) + 1;
        const key = `${policyName}:${reason}`;
        this._metrics.rl_block_total.reason[key] = (this._metrics.rl_block_total.reason[key] || 0) + 1;
    }
    _observeLatency(us) {
        // ultra-light: reservoir-less rolling quantiles (cheap approximation)
        const m = this._metrics.rl_check_latency_us;
        m.samples++;
        // p50/p95/p99 naive EMA approximations to avoid allocations
        const alpha = 0.05;
        m.p50 = m.p50 ? (1 - alpha) * m.p50 + alpha * us : us;
        m.p95 = m.p95 ? (1 - alpha) * m.p95 + alpha * Math.max(us, m.p50) : us;
        m.p99 = m.p99 ? (1 - alpha) * m.p99 + alpha * Math.max(us, m.p95) : us;
    }
    _observeAdapterLatency(kind, ms) {
        const m = this._metrics.rl_adapter_latency_ms[kind];
        m.samples++;
        const alpha = 0.05;
        m.p50 = m.p50 ? (1 - alpha) * m.p50 + alpha * ms : ms;
        m.p95 = m.p95 ? (1 - alpha) * m.p95 + alpha * Math.max(ms, m.p50) : ms;
        m.p99 = m.p99 ? (1 - alpha) * m.p99 + alpha * Math.max(ms, m.p95) : ms;
    }
    _normalizeAdapter(adapter) {
        const safe = {
            get: adapter.get ? adapter.get.bind(adapter) : null,
            put: adapter.put ? adapter.put.bind(adapter) : null,
            incrWithTTL: adapter.incrWithTTL ? adapter.incrWithTTL.bind(adapter) : null,
        };
        if (!safe.get || !safe.put) {
            throw new Error("RateLimiter: adapter must implement get(key) and put(key, state, ttlMs)");
        }
        return {
            get: (key) => safe.get(key),
            put: (key, state, ttlMs) => safe.put(key, state, ttlMs),
            incrWithTTL: safe.incrWithTTL ? (key, delta, ttlMs) => safe.incrWithTTL(key, delta, ttlMs) : null,
        };
    }

    _sweep() {
        // Reuse cleanup logic + TTL bucket GC
        this.cleanup();
    }
    _tryAcquireImmediate(key, p) {
        const cur = this._concurrency.get(key) || 0;
        if (cur >= p.concurrency) return { acquired: false };
        this._concurrency.set(key, cur + 1);
        const gauge = this._metrics.rl_concurrency_in_flight.policy[p.name] || 0;
        this._metrics.rl_concurrency_in_flight.policy[p.name] = gauge + 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this._releaseConcurrency(key, p);
        };
        return { acquired: true, release };
    }
    _releaseConcurrency(key, p) {
        const cur = this._concurrency.get(key) || 0;
        const nextVal = Math.max(0, cur - 1);
        this._concurrency.set(key, nextVal);
        const gauge = this._metrics.rl_concurrency_in_flight.policy[p.name] || 0;
        this._metrics.rl_concurrency_in_flight.policy[p.name] = Math.max(0, gauge - 1);
        this._drainQueue(key, p);
    }
    _enqueue(key, p, ctx) {
        const q = this._queues.get(key) || [];
        if (q.length >= p.queueMax) return false;
        const item = { req: ctx.req, res: ctx.res, next: ctx.next, key, policy: p, enqueuedAt: nowMs(), timer: null };
        if (p.queueTimeoutMs && p.queueTimeoutMs > 0) {
            const timer = setTimeout(() => {
                const list = this._queues.get(key);
                if (!list) return;
                const idx = list.indexOf(item);
                if (idx !== -1) {
                    list.splice(idx, 1);
                    try {
                        const headers = this._buildHeaders(p, { limit: p.limit, remaining: 0, resetMs: p.intervalMs, now: nowMs() }, "queue_timeout");
                        ctx.res.statusCode = p.shedStatus || 503;
                        for (const [h, v] of Object.entries(headers)) ctx.res.setHeader(h, v);
                        ctx.res.end("Service Unavailable");
                        this._incMetricBlock(p.name, "queue_timeout");
                        this._runHook("onBlock", { req: ctx.req, policy: p, decision: { allowed: false, reason: "queue_timeout" } });
                    } catch {}
                }
            }, p.queueTimeoutMs);
            if (timer.unref) timer.unref();
            item.timer = timer;
        }
        q.push(item);
        this._queues.set(key, q);
        return true;
    }
    _drainQueue(key, p) {
        const q = this._queues.get(key);
        if (!q || q.length === 0) return;
        while ((this._concurrency.get(key) || 0) < p.concurrency && q.length > 0) {
            const item = q.shift();
            if (item && item.timer) {
                try {
                    clearTimeout(item.timer);
                } catch {}
                item.timer = null;
            }
            const acq = this._tryAcquireImmediate(key, p);
            if (!acq.acquired) break;
            this._resumeQueued(item, p, acq.release);
        }
    }
    _resumeQueued(item, p, release) {
        const req = item.req,
            res = item.res,
            next = item.next;
        const key = item.key;
        const cost = isFn(p.cost) ? Number(p.cost(req)) : Number(p.cost || 1);
        const start = performance.now();
        const maybe = this._checkAdvanced({ key, cost, policy: p, now: nowMs(), concurrencyAcquired: true });
        const handle = (decision) => {
            const dtUs = Math.floor((performance.now() - start) * 1000);
            this._observeLatency(dtUs);
            try {
                req[SYM_DECISION] = decision;
            } catch {}
            if (decision.headers && (this.emitHeaders === "always" || (this.emitHeaders === "on-block" && !decision.allowed))) {
                for (const [h, v] of Object.entries(decision.headers)) res.setHeader(h, v);
            }
            if (!decision.allowed) {
                try {
                    release();
                } catch {}
                this._incMetricBlock(p.name, decision.reason || "limit");
                this._runHook("onBlock", { req, policy: p, decision });
                res.statusCode = decision.statusCode || 429;
                if (decision.headers) for (const [h, v] of Object.entries(decision.headers)) res.setHeader(h, v);
                res.end("Too Many Requests");
                return;
            }
            const releaseFn = decision.release || release;
            res.once("finish", () => {
                try {
                    releaseFn();
                } catch {}
            });
            res.once("close", () => {
                try {
                    releaseFn();
                } catch {}
            });
            this._runHook("afterDecision", { req, policy: p, decision });
            next();
        };
        if (isPromise(maybe))
            maybe.then(handle).catch((err) => {
                try {
                    this._runHook("onError", { err, where: "queue.resume" });
                } catch {}
                try {
                    release();
                } catch {}
                next();
            });
        else handle(maybe);
    }

    // ===== Hook registration =====
    on(hookName, fn) {
        if (!this._hooks[hookName]) this._hooks[hookName] = [];
        this._hooks[hookName].push(fn);
        return this;
    }
}

// ===== Adaptive Defense Plugin (EWMA spikes -> temporary burst clamp) =====
 function AdaptiveDefensePlugin(options = {}) {
    const alpha = typeof options.alpha === "number" ? options.alpha : 0.1; // EWMA smoothing
    const spikeFactor = typeof options.spikeFactor === "number" ? options.spikeFactor : 2.0; // how many x over baseline RPS to clamp
    const clampFactor = typeof options.clampFactor === "number" ? options.clampFactor : 0.5; // burst *= clampFactor
    const minBurst = typeof options.minBurst === "number" ? options.minBurst : 5;
    const clampDurationMs = typeof options.clampDurationMs === "number" ? options.clampDurationMs : 30_000;
    const relaxOnStableMs = typeof options.relaxOnStableMs === "number" ? options.relaxOnStableMs : 15_000;

    return {
        name: "adaptive-defense",
        register(limiter) {
            const state = new Map(); // policyName -> { last, emaRps, clamped, originalBurst, timer, stableTs }

            const getState = (name, policy) => {
                let s = state.get(name);
                if (!s) {
                    s = {
                        last: nowMs(),
                        emaRps: 0,
                        clamped: false,
                        originalBurst: policy.burst || policy.limit,
                        timer: null,
                        stableTs: nowMs(),
                    };
                    state.set(name, s);
                }
                return s;
            };

            // Allow path: track EMA of RPS and clamp on spikes
            limiter.on("afterDecision", ({ policy }) => {
                if (!policy || !policy.name) return;
                const n = nowMs();
                const s = getState(policy.name, policy);
                const dt = n - (s.last || n);
                if (dt > 0) {
                    const rps = 1000 / dt;
                    s.emaRps = s.emaRps ? (1 - alpha) * s.emaRps + alpha * rps : rps;
                }
                s.last = n;

                const baselineRps = policy.limit / (policy.intervalMs / 1000);
                if (!s.clamped && s.emaRps > baselineRps * spikeFactor) {
                    const newBurst = Math.max(minBurst, Math.floor((policy.burst || policy.limit) * clampFactor));
                    try {
                        limiter.updatePolicy(policy.name, { burst: newBurst });
                    } catch {}
                    s.clamped = true;
                    s.stableTs = n;
                    if (s.timer) {
                        try {
                            clearTimeout(s.timer);
                        } catch {}
                        s.timer = null;
                    }
                    s.timer = setTimeout(() => {
                        try {
                            limiter.updatePolicy(policy.name, { burst: s.originalBurst });
                        } catch {}
                        s.clamped = false;
                        s.timer = null;
                        s.stableTs = nowMs();
                    }, clampDurationMs);
                    if (s.timer && s.timer.unref) s.timer.unref();
                } else if (s.clamped && s.emaRps <= baselineRps) {
                    if (n - s.stableTs >= relaxOnStableMs) {
                        try {
                            limiter.updatePolicy(policy.name, { burst: s.originalBurst });
                        } catch {}
                        s.clamped = false;
                        if (s.timer) {
                            try {
                                clearTimeout(s.timer);
                            } catch {}
                            s.timer = null;
                        }
                        s.stableTs = n;
                    }
                }
            });

            // Block path: immediate clamp if we start blocking (burn)
            limiter.on("onBlock", ({ policy }) => {
                if (!policy || !policy.name) return;
                const n = nowMs();
                const s = getState(policy.name, policy);
                if (!s.clamped) {
                    const newBurst = Math.max(minBurst, Math.floor((policy.burst || policy.limit) * clampFactor));
                    try {
                        limiter.updatePolicy(policy.name, { burst: newBurst });
                    } catch {}
                    s.clamped = true;
                    s.stableTs = n;
                    if (s.timer) {
                        try {
                            clearTimeout(s.timer);
                        } catch {}
                        s.timer = null;
                    }
                    s.timer = setTimeout(() => {
                        try {
                            limiter.updatePolicy(policy.name, { burst: s.originalBurst });
                        } catch {}
                        s.clamped = false;
                        s.timer = null;
                        s.stableTs = nowMs();
                    }, clampDurationMs);
                    if (s.timer && s.timer.unref) s.timer.unref();
                }
            });
        },
    };
}
RateLimiter.AdaptiveDefensePlugin = AdaptiveDefensePlugin;

module.exports = RateLimiter;

