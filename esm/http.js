"use strict";

import fs from 'fs';

const fsp = fs.promises;

import { join, extname, normalize, sep } from 'path';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import http from 'http';
let http2;
try {
    http2 = require("http2");
} catch (_) {
    http2 = null;
} // optional, core-only

import { performance } from 'perf_hooks';
import { AsyncLocalStorage } from 'async_hooks';

// Optional: integrate first-party static middleware/server (paths may need adjusting in your repo)
let createStaticMiddleware;
let OptimizedStaticFileServer;
let mimeTypes;
try {
    createStaticMiddleware = require("../middleware/static-middleware");
} catch (_) {}
try {
    OptimizedStaticFileServer = require("../non-html-static-file-server");
} catch (_) {}
try {
    const mime = require("../mime-types");

    mimeTypes = mime.types({ as: "object" });
} catch (_) {
    mimeTypes = {};
}

import { once } from 'events';

import NDJSONParser from '../parsers/ndjson-parser';

const NDJSONWriter = NDJSONParser.NDJSONWriter;

function installSSEOnServerResponse(ServerResponse) {
    if (ServerResponse.prototype.sse) return; // idempotent

    ServerResponse.prototype.sse = function sse(options = {}) {
        const res = this;

        // Ensure canonical SSE headers
        NDJSONWriter.sseHeaders(res, options.headers);
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        // Start SSE controller (keep-alives handled inside)
        const ctrl = NDJSONWriter.sseStart(res, options);

        // Keep a weak reference for convenience helpers
        res._sse = ctrl;

        // Auto-cleanup on connection end
        const req = res.req;
        let cleaned = false;
        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            try {
                ctrl.close();
            } catch {}
            if (req && typeof req.removeListener === "function") req.removeListener("aborted", cleanup);
            res.removeListener("close", cleanup);
            res.removeListener("finish", cleanup);
        }
        res.on("close", cleanup);
        res.on("finish", cleanup);
        if (req && typeof req.on === "function") req.on("aborted", cleanup);

        return ctrl;
    };

    ServerResponse.prototype.sseEvent = function sseEvent(event, data, opts) {
        const res = this;
        const ctrl = res._sse || res.sse(opts || {});
        return ctrl.send(data, Object.assign({}, opts, { event }));
    };

    ServerResponse.prototype.sseComment = function sseComment(text) {
        const res = this;
        if (!res._sse) res.sse({});
        return res._sse.comment(text);
    };

    ServerResponse.prototype.sseClose = function sseClose() {
        const res = this;
        if (res._sse) res._sse.close();
    };

    ServerResponse.prototype.sseFrom = async function sseFrom(asyncIterable, opts = {}) {
        const res = this;
        NDJSONWriter.sseHeaders(res, opts.headers);
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        for await (const frame of NDJSONWriter.sseStream(asyncIterable, opts)) {
            if (res.writableEnded || res.destroyed) break;
            res.write(frame);
        }
    };
}

// Install at module load (safe to call multiple times)
installSSEOnServerResponse(http.ServerResponse);

import { Readable, Writable, PassThrough, Transform } from 'stream';

import querystring from 'querystring';

import zlib from 'zlib';
import { promisify } from 'util';
import stream from 'stream';

// Promisify zlib functions for async buffer compression
const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

// Default settings (can be overridden in options)
const DEFAULT_COMPRESSION_THRESHOLD = 1024; // Min bytes to compress
const DEFAULT_COMPRESSIBLE_TYPES = new Set(["text/plain", "text/html", "text/css", "text/javascript", "application/javascript", "application/json", "application/xml", "image/svg+xml"]);

import EventEmitter from 'node:events';

import rs from '../decorators/req-res-decorators';

import RadixRouter from '../radix-router';

import RateLimiter from '../middleware/rate-limiter';
import ContentType from '../content-types';
import responseDecorator from '../response';
import requestDecorator from '../request';

// --- UltraFastServer Class ---

class UltraFastServer extends EventEmitter {
    constructor({ bypassSingleton = false, viewExtension, ...overrides } = {}, ...args) {
        // 1) Singleton guard (unless bypassSingleton is true)
        if (!bypassSingleton && UltraFastServer.instance) {
            return UltraFastServer.instance;
        }
        super();
        Object.assign(this, overrides, ...args); // Assign properties from args to this
        // Trust proxy (Express-style semantic)
        this.trustProxy = Boolean(overrides?.trustProxy || this.trustProxy || false);

        // Lifecycle hooks registry (zero-cost when unused)
        this._hooks = {
            beforeRoute: new Set(),
            afterRoute: new Set(),
            beforeParse: new Set(),
            afterParse: new Set(),
            beforeHandle: new Set(),
            afterHandle: new Set(),
            beforeSend: new Set(),
            afterSend: new Set(),
            onTimeout: new Set(),
            onUpgrade: new Set(),
            onError: new Set(),
        };

        // Per-request context store (propagates across async calls)
        this._als = new AsyncLocalStorage();

        // Route metadata & naming
        this._routeRegistry = new Map(); // key: `${METHOD} ${path}` → { options, coerce }
        this._routeNames = new Map(); // name → { method, path }
        this._pathMethods = new Map(); // path → Set(method)
        this._routeDefs = []; // hot-swap snapshot of route defs

        // Observability (internal counters when no external registry is attached)
        this.metricsRegistry = this.metricsRegistry || null;
        this._metrics = {
            http_requests_total: 0,
            http_errors_total: 0,
            http_timeouts_total: 0,
            http_in_flight: 0,
            http_body_bytes_in_total: 0,
            http_body_bytes_out_total: 0,
            durations_ms: [], // sampled durations for p50/p95/p99 reporting
        };

        // In-flight request tracking
        this._inFlight = new Set();
        this._reqTraces = new Map(); // requestId -> [{t, tag, extra}]

        // --- Server Options ---
        if (!this.port) this.port = 3000;
        if (!this.host) this.host = "localhost";
        // Respect user-provided contentDir; default to ./public
        if (!this.contentDir) {
            this.contentDir = path.resolve("./public");
        } else {
            this.contentDir = path.isAbsolute(this.contentDir) ? this.contentDir : path.resolve(this.contentDir);
        }

        if (this.host) this.host = this.host;
        if (this.debug) this.debug = this.debug;

        if (!this.keepAliveTimeout) this.keepAliveTimeout = 5000;
        if (!this.maxHeaderSize) this.maxHeaderSize = 8192;
        if (!this.maxBodySize) this.maxBodySize = 1 * 1024 * 1024;
        if (!this.maxHeaderCount) this.maxHeaderCount = 2000;
        if (!this.maxRequestsPerSocket) this.maxRequestsPerSocket = 1000;
        if (!this.timeout) this.timeout = 5000;
        if (!this.headersTimeout) this.headersTimeout = 5000;
        if (this.paramTimeoutMs === undefined) this.paramTimeoutMs = 0; // ms; 0 = disabled

        // Leave maxConnections undefined unless explicitly provided.

        // if (this.keepAliveTimeout) this.keepAliveTimeout = 5000;
        // if (this.maxHeaderSize) this.maxHeaderSize = 8192;
        // if (this.maxBodySize) this.maxBodySize = 1 * 1024 * 1024; // Default to 1MB
        // if (this.maxHeaderCount) this.maxHeaderCount = 2000;
        // if (this.maxRequestsPerSocket) this.maxRequestsPerSocket = 1000;
        // if (this.timeout) this.timeout = 5000;
        // if (this.headersTimeout) this.headersTimeout = 5000;
        // if (this.maxConnections) this.maxConnections = this.maxConnections;

        if (this.compressionThreshold) this.compressionThreshold = DEFAULT_COMPRESSION_THRESHOLD;
        if (this.compressibleMimeTypes) this.compressibleMimeTypes = DEFAULT_COMPRESSIBLE_TYPES;
        // --- End Server Options ---
        this.errorHandlers = [];

        this._parent = null;
        this.mountpath = null;

        this._mountpath = null;

        // ─── Express‑style additions ───
        this.settings = new Map(); // app.set()/get()
        this.locals = {}; // app.locals
        this.engines = {}; // app.engine()
        this.paramCallbacks = new Map(); // app.param()

        if (!this.contentType) this.contentType = new ContentType(); // Assuming ContentType is defined/imported
        if (!this.rateLimiter)
            this.rateLimiter = new RateLimiter({
                // Assuming RateLimiter is defined/imported
                windowMs: 60 * 1000,
                max: 1000, // Consider making this configurable via options
            });
        this.eventHistory = new Map();
        this.channelHistory = new Map();
        // === Routing Structures Initialization ===
        /**
         * Stores static routes for fast O(1) lookup.
         * Structure: Map<Method: string, Map<Path: string, Handler: Function>>
         * Example: staticRoutes.get('GET').get('/about') -> aboutHandler
         */
        this.staticRoutes = new Map();
        this.socketMiddlewares = new Map();

        /**
         * The root node of the Trie used for storing and looking up
         * dynamic routes (those containing parameters like :id).
         */
        //this.dynamicRootNode = new TrieNode();
        this.regexRoutes = [];
        // Reverse routing registry
        this._namedRoutes = new Map(); // name -> { method, path }

        // Track allowed methods per path pattern (for OPTIONS/HEAD)
        this._pathMethods = new Map(); // pathPattern -> Set(methods)
        this._optionsMaterialized = new Set(); // Set of pathPatterns that already have an OPTIONS route
        this.autoOptionsMaterialize = overrides?.autoOptionsMaterialize !== undefined ? !!overrides.autoOptionsMaterialize : true; // default ON

        // Radix: dynamic router (prefix-compressed)
        this.radix = new RadixRouter({
            // mirror your server defaults
            caseSensitive: false,
            autoHead: true,
            autoOptions: true,
            // If you want Radix to do the same decode/normalize choices as your URL parser:
            strictTrailingSlash: false,
        });

        // Back-compat alias so legacy helpers use the same router
        if (!this.dynamicRouter) this.dynamicRouter = this.radix;

        // Route registries (metadata + reverse lookups)
        this._routeRegistry = new Map(); // key: `${METHOD} ${pathPattern}` -> { options, coerce }
        this._pathMethods = new Map(); // pathPattern -> Set(methods)

        // Per-route rate limiter store (token-bucket buckets)
        this._routeRateStore = new Map();

        // === End Routing Structures ===
        this._addAndMountHTTPMethods(); // <<< CALL THE DYNAMIC METHOD CREATOR

        // --- End Max Body Size Configuration ---

        this.middlewares = []; // Array to hold middleware functions
        // Default error handler, can be overridden via use() with a 4-arg function
        this.errorHandler = this._defaultErrorHandler.bind(this);
        // Flag: true while core middleware are being registered; affects insertion order in .use()
        this._bootstrappingCore = false;

        this._registerCoreMiddleware();

        // --- Optional: Expose HTTP server options ---
        const serverOptions = {
            // Example: Define keep-alive timeout
            keepAliveTimeout: this.keepAliveTimeout || 5000,
            maxHeadersCount: this.maxHeadersCount || 2000, // Example
        };
        //this.server = http.createServer(serverOptions, this.handleRequest.bind(this));
        this.server = http.createServer(serverOptions, this._runMiddleware.bind(this));

        // Track sockets and in-flight requests for graceful drain
        if (!this._sockets) this._sockets = new Set();
        if (!this._inFlight) this._inFlight = new Set();
        this._draining = false;

        this.server.on("connection", (socket) => {
            this._sockets.add(socket);
            socket.on("close", () => this._sockets.delete(socket));
        });

        //this.websocket = new Websocket();
        //this._serverOnUpgrade();
        this.setMaxListeners(1000); // Disable max listeners warning
        // --- End Optional ---
        // if you haven’t already, hook SIGTERM to execute shutdown hooks
        process.on("SIGTERM", async () => {
            try {
                await this.onShutdown(); // execution mode
            } catch (err) {
                console.error("Error in shutdown hooks:", err);
            } finally {
                process.exit(0);
            }
        });

        // 4) Only stash as the one-and-only instance when not bypassing
        if (!bypassSingleton) {
            UltraFastServer.instance = this;
        }
    }

    errorHandler(err, req, res, next) {
        let idx = 0;
        const run = (error) => {
            if (idx < this.errorHandlers.length) {
                // call the next registered handler
                const handler = this.errorHandlers[idx++];
                try {
                    handler(error, req, res, run);
                } catch (e) {
                    // if a handler throws, keep going
                    run(e);
                }
            } else {
                // no more custom handlers → fall back to the original
                this._defaultErrorHandler(error, req, res, next);
            }
        };
        run(err);
    }

    /**
     * Registers one or more plugins with the server instance.
     * Plugins are expected to be objects with an .apply(app) method.
     * This method allows plugins to extend server functionality (e.g., add routes, middleware).
     *
     * @param {...object|object[]} items - One or more plugin objects, or arrays of plugin objects.
     * @returns {this} The server instance for chaining.
     * @throws {Error} If no plugins are provided.
     * @throws {TypeError} If any provided item is not a valid plugin (missing .apply function).
     * @fires pluginRegistered (Example custom event, could be added)
     */
    usePlugin(...items) {
        // 1. Flatten potential arrays of plugins (e.g., usePlugin([p1, p2], p3))
        const plugins = items.flat(Infinity);
        // Support lightweight signature: usePlugin('name', { hooks:{...} }, { namespace, order })
        if (plugins.length === 3 && typeof plugins[0] === "string" && plugins[1] && typeof plugins[1] === "object" && plugins[1].hooks) {
            const [name, cfg, meta] = plugins;
            const plugin = {
                name,
                apply: (app) => {
                    if (cfg.hooks) app.hooks(cfg.hooks);
                },
            };
            return this.usePlugin(plugin);
        }

        // 2. Validate input
        if (plugins.length === 0) {
            throw new Error("app.usePlugin() requires at least one plugin argument");
        }

        // Initialize plugin storage if it doesn't exist
        if (!this.plugins) this.plugins = [];
        // Assume logger is initialized (e.g., this.logger = options.logger || DEFAULT_LOGGER)
        const logger = this.logger || console; // Fallback safety

        // 3. Iterate and apply each plugin
        for (const plugin of plugins) {
            // Validate plugin structure
            if (!plugin || typeof plugin.apply !== "function") {
                // Log error before throwing?
                console.log(`Invalid plugin object passed to usePlugin. Expected object with an apply function, got:`, plugin);
                throw new TypeError(`app.usePlugin() expected plugin with a .apply() method, got ${typeof plugin}`);
            }

            // 4. Apply the plugin
            try {
                // Execute the plugin's apply method, passing the server instance ('this')
                plugin.apply(this);

                // 5. Store and Log
                this.plugins.push(plugin); // Store reference to the plugin

                // Get a meaningful name for logging
                const pluginName = plugin.name || plugin.constructor?.name || "anonymous";
                console.log(`Plugin registered: ${pluginName}`); // Use configured logger

                // Optional: Emit an event
                // this.emit('pluginRegistered', { plugin, name: pluginName });
            } catch (applyError) {
                // Catch synchronous errors thrown by plugin.apply() during setup
                console.log(`Error applying plugin "${plugin.name || plugin.constructor?.name || "anonymous"}":`, applyError);
                // Re-throw or handle? Re-throwing stops server setup if a plugin fails.
                throw applyError;
            }
        }

        // 6. Return server instance for chaining
        return this;
    }

    /**
     * Recursively load and register all plugins in a folder.
     * Each file must export a plugin object (with an .apply(app) method).
     *
     * @param {string} dirPath — Absolute or relative path to the directory to scan.
     * @returns {Promise<this>} A Promise resolving to the server instance for chaining,
     * after attempting to load all plugins.
     */
    async loadPlugins(dirPath) {
        // Resolve relative to cwd if needed - good for flexibility
        const fullDir = path.isAbsolute(dirPath) ? dirPath : path.join(process.cwd(), dirPath);

        if (this.contentType.debug) console.log(`[Plugin Loader] Scanning directory: ${fullDir}`);

        try {
            // Use async readdir with withFileTypes - Efficient & Non-Blocking I/O
            const entries = await fs.readdir(fullDir, { withFileTypes: true });

            // Process entries sequentially (can be parallelized with Promise.all if order doesn't matter and errors handled carefully)
            for (const entry of entries) {
                const entryPath = path.join(fullDir, entry.name);

                if (entry.isDirectory()) {
                    // Correctly await recursive calls - Non-Blocking
                    if (this.contentType.debug) console.log(`[Plugin Loader] Recursing into subdirectory: ${entryPath}`);
                    await this.loadPlugins(entryPath);
                } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
                    // Allow .mjs?

                    // --- Require the plugin module ---
                    // NOTE: require() is SYNCHRONOUS file I/O.
                    // While common for setup, for a *very large* number of plugins,
                    // this *could* introduce a small delay during startup.
                    // Using async import() is an alternative but adds complexity.
                    // For typical plugin loading at startup, require() is usually acceptable.
                    if (this.contentType.debug) console.log(`[Plugin Loader] Attempting to load plugin: ${entryPath}`);
                    const plugin = require(entryPath);
                    // --- End Require ---

                    // Validate & register using the already reviewed usePlugin
                    try {
                        // usePlugin handles validation and calls plugin.apply()
                        this.usePlugin(plugin);
                    } catch (err) {
                        // Catch errors from usePlugin (invalid format) or plugin.apply() itself
                        console.log(`Failed to register or apply plugin ${entryPath}:`, err);
                        // Continue loading other plugins
                    }
                }
            }
        } catch (err) {
            // Handle errors during directory reading (e.g., path doesn't exist, permissions)
            console.log(`Error scanning plugins directory "${fullDir}":`, err);
            // Optional: Re-throw if directory scanning failure should stop the server?
            // Currently just logs and continues.
        }

        return this; // chainable
    }

    /**
     * Registers one or more listener functions for the 'mount' event.
     * The 'mount' event should be emitted when a sub-app or router is mounted
     * onto this server instance (e.g., via a future implementation of `use(path, subApp)`).
     * Allows listeners to react when the application structure changes dynamically.
     *
     * @param {...Function|Function[]} fns - One or more listener functions, or arrays of functions.
     * Each listener will receive the mounted sub-app/router as an argument.
     * @returns {this} The server instance for chaining.
     * @throws {Error} If no listener functions are provided.
     * @throws {TypeError} If any argument is not a function.
     * @listens mount
     * * @example
     * const subApp = server.createSubApp();
     * server.onMount((mountedApp) => {
     * console.log(`App mounted at: ${mountedApp.mountpath}`);
     * });
     * server.use('/admin', subApp); // Assuming this internally emits 'mount'
     */
    onMount(...fns) {
        // 1. Flatten arguments to handle cases like onMount(fn1, [fn2, fn3])
        const handlers = fns.flat(Infinity);

        // 2. Validate input
        if (handlers.length === 0) {
            throw new Error("app.onMount() requires at least one listener function");
        }
        for (const fn of handlers) {
            if (typeof fn !== "function") {
                throw new TypeError(`app.onMount() only accepts functions; got ${typeof fn}`);
            }
            // 3. Register listener using inherited EventEmitter.on method
            // We assume the 'mount' event will be emitted elsewhere with the mounted app as an argument
            this.on("mount", fn);
        }

        // 4. Return instance for chaining
        return this;
    }

    /**
     * Registers initialization functions (hooks) to be run before the server starts listening,
     * OR executes all registered hooks if called with no arguments.
     * * - Registration Mode: Call with one or more functions to add them to the init queue.
     * - Execution Mode: Call with no arguments (typically `await server.onInit()`)
     * within `server.start()` to run all registered hooks sequentially.
     * * Hooks can be async functions (return a Promise) or synchronous functions. Execution
     * mode will await async hooks, ensuring sequential completion.
     *
     * @param {...Function|Function[]} [fns] - Optional: One or more init functions (or arrays of functions) to register.
     * @returns {Promise<void>|this} Returns `this` (for chaining) in registration mode, or a Promise
     * that resolves when all hooks have completed in execution mode.
     * @throws {Error} If non-function arguments are passed during registration.
     * @throws {Error} If registration is attempted without providing any functions.
     * * @example
     * // Registration
     * server.onInit(connectToDatabase);
     * server.onInit(async () => { await seedCache(); });
     * * // Execution (usually called internally by server.start())
     * await server.onInit();
     */
    async onInit(...fns) {
        // Method is async because execution mode uses await
        // Initialize Set if it doesn't exist (defensive)
        if (!this.initHooks) this.initHooks = new Set();

        // --- Registration Mode ---
        if (fns.length > 0) {
            const handlers = fns.flat(Infinity); // Flatten input arrays
            if (handlers.length === 0) {
                // This case should technically not be hit if fns.length > 0, but belt-and-suspenders
                throw new Error("app.onInit() requires at least one function when registering hooks.");
            }
            for (const fn of handlers) {
                if (typeof fn !== "function") {
                    throw new TypeError(`app.onInit() only accepts functions during registration; got ${typeof fn}`);
                }
                // Add hook to the Set (duplicates are automatically ignored by Set)
                this.initHooks.add(fn);
                if (this.contentType.debug) console.log(`[onInit] Registered hook: ${fn.name || "anonymous"}`);
            }
            return this; // Return server instance for chaining registrations
        }
        // --- End Registration Mode ---

        // --- Execution Mode (Called via await server.onInit()) ---
        if (this.contentType.debug) console.log(`[onInit] Executing ${this.initHooks.size} initialization hooks...`);

        // Sequentially execute hooks, awaiting any Promises
        for (const hook of this.initHooks) {
            if (this.contentType.debug) console.log(`[onInit]   Running hook: ${hook.name || "anonymous"}...`);
            try {
                // Await ensures async hooks complete before the next one starts
                await hook(); // Call the registered hook function
            } catch (err) {
                console.log(`[onInit] Error during initialization hook (${hook.name || "anonymous"}):`, err);
                // Re-throw the error to potentially stop server startup
                throw err;
            }
            if (this.contentType.debug) console.log(`[onInit]   Hook finished: ${hook.name || "anonymous"}`);
        }
        if (this.contentType.debug) console.log(`[onInit] All initialization hooks executed.`);
        // Implicitly returns Promise<void> when execution completes
    } // End onInit

    /**
     * Register lifecycle hooks. Accepts one or more objects:
     * { beforeRoute, afterRoute, beforeParse, afterParse, beforeHandle, afterHandle, beforeSend, afterSend, onTimeout, onUpgrade, onError }
     */
    hooks(...defs) {
        const add = (obj) => {
            if (!obj || typeof obj !== "object") return;
            for (const [k, set] of Object.entries(this._hooks)) {
                const fn = obj[k];
                if (typeof fn === "function") set.add(fn.bind(this));
            }
        };
        defs.flat(Infinity).forEach(add);
        return this;
    }

    /** Internal: run a hook family, swallow errors to keep hot paths safe */
    _callHooks(name, payload) {
        const set = this._hooks && this._hooks[name];
        if (!set || set.size === 0) return;
        for (const fn of set) {
            try {
                fn(payload);
            } catch (_) {}
        }
        return this;
    }

    /**
     * Registers one or more "finally" middleware functions.
     * These functions are executed exactly once per request, *after* the response
     * has finished sending or the connection has closed prematurely.
     * Useful for cleanup, final logging, or releasing request-scoped resources.
     * Requires this.finalMiddlewares Set to be initialized in the constructor.
     * The execution logic is handled within _runMiddleware by listening to
     * the 'finish' and 'close' events on the response object.
     *
     * @param {...Function|Function[]} fns - One or more functions to register.
     * Each function will be called with (req, res) after the response ends.
     * @returns {this} The server instance for chaining.
     * @throws {Error} If no functions are provided.
     * @throws {TypeError} If any argument is not a function.
     *
     * @example
     * server.useFinally((req, res) => {
     * console.log(`Request ${req.method} ${req.originalUrl} finished with status ${res.statusCode}`);
     * });
     */
    useFinally(...fns) {
        // Flatten arguments in case arrays are passed
        const handlers = fns.flat(Infinity);
        if (handlers.length === 0) {
            throw new Error("app.useFinally() requires at least one function");
        }
        // Initialize Set if it doesn't exist (defensive)
        if (!this.finalMiddlewares) this.finalMiddlewares = new Set();

        for (const fn of handlers) {
            if (typeof fn !== "function") {
                throw new TypeError(`app.useFinally() only accepts functions; got ${typeof fn}`);
            }
            // --- Recommended Change: Bind 'this' ---
            // Bind the function to the server instance so 'this' inside the final
            // handler refers to the UltraFastServer instance.
            this.finalMiddlewares.add(fn.bind(this));
            // --- End Recommended Change ---

            // Original code: this.finalMiddlewares.add(fn);
            // (Would require handlers to not rely on 'this' or use arrow functions defined in class scope)
        }
        return this; // Allow chaining
    }

    /**
     * Register middleware to run *after* route handlers but *before* the final 404/static layer.
     * Deterministic placement using internal markers.
     */
    useAfterRoutes(...fns) {
        const handlers = fns.flat(Infinity);
        if (handlers.length === 0) {
            throw new Error("app.useAfterRoutes() requires at least one middleware function");
        }
        handlers.forEach((fn) => {
            if (typeof fn !== "function") {
                throw new TypeError(`app.useAfterRoutes() only accepts functions; got ${typeof fn}`);
            }
            const bound = fn.bind(this);
            const entry = { path: null, handler: bound };

            // Insert just before the final 404 marker if present
            const idx404 = this.middlewares.findIndex((l) => l && String(l.__coreStage || "").startsWith("final"));
            if (idx404 >= 0) {
                this.middlewares.splice(idx404, 0, entry);
            } else {
                // Fallback: right after the router marker, else append
                const idxRouter = this.middlewares.findIndex((l) => l && l.__coreStage === "router");
                if (idxRouter >= 0) this.middlewares.splice(idxRouter + 1, 0, entry);
                else this.middlewares.push(entry);
            }
        });
        return this;
    }

    /**
     * Registers one or more middleware functions to run early in the request chain,
     * typically before route-specific logic or static file serving.
     * * NOTE: In the current implementation, this method functions as an **alias for server.use()**.
     * The "pre-routing" execution order is achieved by calling this method *after* server
     * instantiation but *before* defining routes with methods like server.get(), server.post(), etc.
     * These middleware will be added to the main middleware chain executed by _runMiddleware.
     * * Requires this.preRoutingMiddlewares Set to be initialized if storing separately,
     * but currently delegates directly to this.use().
     *
     * @param {...Function|Function[]} fns - One or more middleware functions (req, res, next).
     * @returns {this} The server instance for chaining.
     * @throws {Error} If no functions are provided.
     * @throws {TypeError} If any argument is not a function.
     *
     * @example
     * server.usePreRouting(checkMaintenanceMode); // Runs before router/static files
     * server.get('/', handleHome);
     */
    usePreRouting(...fns) {
        const handlers = fns.flat(Infinity);
        if (handlers.length === 0) {
            throw new Error("app.usePreRouting() requires at least one function");
        }

        // --- Recommended Approach: Alias to use() ---
        // This leverages the existing middleware chain and execution order.
        // The 'pre-routing' nature comes from *when* the developer calls this method.
        for (const fn of handlers) {
            if (typeof fn !== "function") {
                throw new TypeError(`app.usePreRouting() only accepts functions; got ${typeof fn}`);
            }
            // Call the main use method - this handles binding 'this' and adding
            // to this.middlewares (as a global middleware since no path is specified).
            this.use(fn);
        }
        // --- End Recommended Approach ---

        /* --- Original Code (Stores separately but doesn't execute) ---
            // Initialize Set if it doesn't exist (defensive)
            if (!this.preRoutingMiddlewares) this.preRoutingMiddlewares = new Set(); 
            
            for (const fn of handlers) {
                if (typeof fn !== "function") {
                    throw new TypeError(`app.usePreRouting() only accepts functions; got ${typeof fn}`);
                }
                // Bind 'this' for consistency if handlers expect server context
                this.preRoutingMiddlewares.add(fn.bind(this)); 
            }
            */

        return this; // Allow chaining
    }

    /**
     * Returns the path prefix where this application instance is mounted.
     * If the application is not mounted as a sub-app within another,
     * it returns the default root path "/".
     * Relies on the internal _mountpath property being set correctly during mounting.
     * * @returns {string} The mount path prefix (e.g., "/api", "/admin") or "/".
     * * @example
     * const mainApp = new UltraFastServer();
     * const apiApp = mainApp.createSubApp();
     * // Assuming use('/api', apiApp) sets apiApp._mountpath = '/api' internally:
     * console.log(mainApp.path()); // Output: "/"
     * console.log(apiApp.path());  // Output: "/api"
     */
    path() {
        // Return the internal mount path if set, otherwise default to root '/'
        return this._mountpath || "/";
    }

    /**
     * Maps the specified path parameter name to the given callback function.
     * The callback function is intended to be invoked when a route matching
     * a path containing the named parameter is requested. It allows for
     * pre-processing or validation of parameter values.
     * * NOTE: This method currently ONLY registers the callback. The core routing
     * logic (_routerMiddleware, _findDynamicRoute) has NOT yet been updated
     * to actually EXECUTE these registered callbacks. Implementing the execution
     * requires significant changes to the routing dispatch flow.
     *
     * The callback function typically receives (req, res, next, value, name),
     * where 'value' is the extracted parameter value and 'name' is the parameter name.
     * It should call next() to continue, or next(err) on failure.
     *
     * Requires this.paramCallbacks Map to be initialized in the constructor.
     *
     * @param {string} name - The name of the parameter (e.g., 'id' for '/users/:id').
     * @param {Function} fn - The callback function to execute.
     * @returns {this} The server instance for chaining.
     * @throws {TypeError} If fn is not a function.
     *
     * @example
     * server.param('userId', async (req, res, next, id, paramName) => {
     * // Example: Validate ID format and load user onto req
     * if (!/^\d+$/.test(id)) {
     * return next(new Error('Invalid User ID format'));
     * }
     * try {
     * req.userFromParam = await fetchUserById(id); // Assuming fetchUserById exists
     * if (!req.userFromParam) return next(new Error('User not found'));
     * next(); // Proceed to route handler
     * } catch(err) {
     * next(err);
     * }
     * });
     *
     * // Route that would trigger the 'userId' param callback (if execution was implemented)
     * server.get('/users/:userId', (req, res) => {
     * // req.userFromParam would potentially be available here
     * res.json(req.userFromParam);
     * });
     */
    param(name, fn) {
        // Validate input
        if (typeof fn !== "function") {
            throw new TypeError(`server.param() requires a function but got a ${typeof fn} for param "${name}"`);
        }
        if (typeof name !== "string" || name.length === 0) {
            throw new Error(`server.param() requires a non-empty string name.`);
        }

        // Initialize Map if needed (defensive)
        if (!this.paramCallbacks) this.paramCallbacks = new Map();

        // Store the callback function associated with the parameter name.
        // Note: Express allows multiple callbacks for the same param name,
        // forming a chain. A Map stores only one. To mimic Express fully,
        // we might store an array of functions here instead.
        // Let's stick to one for now as execution isn't implemented.
        if (this.paramCallbacks.has(name) && this.contentType.debug) {
            console.log(`[Param] Overwriting existing callback for parameter "${name}"`);
        }

        const existing = this.paramCallbacks.get(name);
        if (Array.isArray(existing)) {
            existing.push(fn);
        } else if (existing) {
            this.paramCallbacks.set(name, [existing, fn]);
        } else {
            this.paramCallbacks.set(name, [fn]);
        }

        //this.paramCallbacks.set(name, fn); // Store the function

        if (this.contentType.debug) console.log(`[Param] Registered callback for parameter "${name}"`);

        return this; // Enable chaining
    }

    /**
     * Registers the given template engine callback `fn` as `ext`.
     * Used for rendering view files with `res.render()`. By default, Express apps
     * will require() the engine based on the file extension.
     * Requires this.engines object to be initialized in the constructor.
     * The server core remains zero-dependency, but the provided 'fn'
     * will typically come from an external template engine library installed
     * by the application developer.
     *
     * @param {string} ext - The file extension name (e.g., 'ejs', 'pug', '.html').
     * A leading dot is optional.
     * @param {Function} fn - The template engine rendering function. It must adhere
     * to the signature `(filePath, options, callback)` where
     * `callback` has the signature `(err, renderedString)`.
     * @returns {this} The server instance for chaining.
     * @throws {Error} If 'ext' is not a non-empty string.
     * @throws {TypeError} If 'fn' is not a function.
     *
     * @example
     * // Assuming 'ejs' package is installed by the user
     * const ejs = require('ejs');
     * server.engine('ejs', ejs.__express); // Register EJS engine
     * server.set('view engine', 'ejs'); // Set default engine
     * server.set('views', './views');    // Set views directory
     *
     * // In a route handler:
     * res.render('profile', { user: userData }); // Will use EJS engine
     */
    engine(ext, fn) {
        // Validate extension
        if (typeof ext !== "string" || !ext.length) {
            throw new Error("server.engine() requires a non-empty string extension as the first argument");
        }
        // Validate rendering function
        if (typeof fn !== "function") {
            throw new TypeError(`server.engine() requires a function as the second argument; got ${typeof fn} for extension "${ext}"`);
        }

        // Normalize extension to include leading dot
        const e = ext.startsWith(".") ? ext : `.${ext}`;

        // Initialize engines object if needed (defensive)
        if (!this.engines) this.engines = {};

        // Store the engine rendering function
        this.engines[e] = fn;

        if (this.contentType.debug) console.log(`[Engine] Registered engine for extension: "${e}"`);

        return this; // Enable chaining
    }

    static(urlPath, rootDir, opts = {}) {
        const options = { index: "index.html", dotfiles: "ignore", maxAge: 0, ttl: 300_000, ...opts };
        const absoluteRoot = path.resolve(rootDir);
        // Simple TTL cache for stat results: { filePath: { stats, expiry } }
        const statCache = new Map();

        this.use(async (req, res, next) => {
            //let { pathname } = parseUrl(req.url);
            const pathname = req.pathname || new URL(req.url, "http://localhost").pathname;

            if (!pathname.startsWith(urlPath)) return next();

            // Resolve file path
            let rel = decodeURIComponent(pathname.slice(urlPath.length)).replace(/^\/+/, "");
            const filePath = path.join(absoluteRoot, rel);

            if (!filePath.startsWith(absoluteRoot)) return next();

            try {
                const pipelineAsync = promisify(stream.pipeline);
                // Check cache
                let entry = statCache.get(filePath);
                if (!entry || entry.expiry < Date.now()) {
                    const stats = await fsp.stat(filePath);
                    entry = { stats, expiry: Date.now() + options.ttl };
                    statCache.set(filePath, entry);
                }
                let stats = entry.stats;

                // Directory → index
                if (stats.isDirectory()) {
                    if (!options.index) return next();
                    const idx = path.join(filePath, options.index);
                    stats = await fsp.stat(idx);
                    entry = { stats, expiry: Date.now() + options.ttl };
                    statCache.set(idx, entry);
                }

                // Dotfiles
                if (path.basename(filePath).startsWith(".") && options.dotfiles === "ignore") {
                    return next();
                }

                // Headers
                const ext = path.extname(filePath).toLowerCase();
                res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
                if (options.maxAge) {
                    res.setHeader("Cache-Control", `public, max-age=${options.maxAge}`);
                }

                // Stream with pipeline
                //await pipeline(fs.createReadStream(filePath), res);

                await pipelineAsync(fs.createReadStream(filePath), res);

                // success, don’t call next()
            } catch (err) {
                // ENOENT → not found, let next() handle 404
                if (err.code === "ENOENT") return next();
                // real error → bubble up
                return next(err);
            }
        });

        return this;
    }

    /**
     * Renders a view using a registered template engine and sends the output.
     * This is the internal rendering logic, typically called by the res.render() helper.
     * It uses settings like 'view engine' and 'views' and merges server/request locals.
     *
     * @param {string} view - The name or path of the view/template file to render, relative to the 'views' directory. File extension is optional if 'view engine' setting is configured.
     * @param {object} [locals={}] - An object containing local variables/data to be passed to the template during rendering. These override any app.locals with the same name.
     * @param {Function} cb - The final callback function with the signature (err, renderedString). This function is typically provided by res.render() to handle the response or error.
     * @returns {void} - Does not return a value directly, operates via the callback.
     * @throws {Error} - Can potentially throw synchronous errors during setup if callback `cb` itself throws immediately (unlikely). Engine errors are passed to `cb`.
     *
     * @example // Typically called internally by res.render('myview', { user: 'Tobi' });
     * server.render('user/profile', { title: 'Profile', user: { name: 'Jane' } }, (err, html) => {
     * if (err) { console.error(err); return; }
     * // Callback would handle sending the html
     * });
     */
    /**
     * Render a view file using the registered engine.
     * @param {string} view   – e.g. 'index' or 'emails/welcome'
     * @param {object} locals – data to pass into the template
     * @param {function} cb   – callback(err, renderedString)
     */

    render(view, locals = {}, cb) {
        // Ensure required properties exist (initialized in constructor)
        if (!this.settings) this.settings = new Map();
        if (!this.engines) this.engines = {};
        if (!this.locals) this.locals = {};

        try {
            // 1. Get view-related settings
            // Uses the server.get('setting') method which should handle Map lookup
            const viewsDir = this.get("views") || path.resolve("views"); // Default to ./views
            const engineName = this.get("view engine"); // e.g., 'ejs' or '.ejs'

            if (!engineName) {
                // Must configure view engine - use nextTick for async error callback
                return process.nextTick(() => cb(new Error('No view engine specified. Use server.set("view engine", ...)')));
            }
            // Normalize extension from setting to ensure leading dot
            const ext = engineName.startsWith(".") ? engineName : `.${engineName}`;

            // 2. Resolve file path
            // Add the default extension if the view name doesn't already have one
            const fileName = path.extname(view) ? view : view + ext;
            const filePath = path.join(viewsDir, fileName);

            // 3. Get the registered engine callback
            const engineFn = this.engines[ext]; // Lookup using normalized extension (e.g., '.ejs')
            if (!engineFn) {
                return process.nextTick(() => cb(new Error(`No engine registered for extension "${ext}". Use server.engine("${ext}", ...)`)));
            }

            // 4. Merge application locals with per-render locals
            // Per-render locals override application locals if keys conflict
            const context = { ...this.locals, ...locals };

            // 5. Invoke the engine's rendering function
            // The engineFn is responsible for reading the file and calling cb
            if (this.contentType.debug) console.log(`[Render] Rendering view "${view}" using engine for "${ext}" at path "${filePath}"`);
            engineFn(filePath, context, cb); // Engine calls cb(err, html)
        } catch (err) {
            // Catch synchronous errors during setup (e.g., path.join issues)
            console.log(`[Render] Synchronous error during render setup for view "${view}":`, err);
            // Ensure callback is still called asynchronously
            return process.nextTick(() => cb(err));
        }
    }

    /**
     * Emits a specific event (defaulting to 'message') with the provided data
     * and also attempts to store the event in the event history.
     * This acts as a convenience wrapper around `this.emit` and `this.storeEvent`.
     * * Requires `this` to be an EventEmitter (which UltraFastServer is).
     * Requires `this.eventHistory` Map and `this.storeEvent` method to be
     * available for history storage to function.
     *
     * @param {*} data - The data payload to emit with the event.
     * @param {string} [event="message"] - The name of the event to emit. Defaults to 'message'.
     * @returns {void}
     *
     * @example
     * // Emits a 'message' event with { text: 'Hello' }
     * server.message({ text: 'Hello' });
     *
     * // Emits a 'user:updated' event with the user object
     * server.message(userObject, 'user:updated');
     */
    message(data, event = "message") {
        // Emit the event using the inherited EventEmitter method
        this.emit(event, data);

        // Store the event if the history mechanism exists
        // Assumes storeEvent handles the check for this.eventHistory internally
        if (typeof this.storeEvent === "function") {
            this.storeEvent(event, data);
        }
    }

    /**
     * Emits a specific action event (defaulting to 'actionPerformed') and stores
     * the event in the event history.
     * * Note the emission pattern: Listeners for this event will receive **two** arguments:
     * 1. The name of the action performed (`actionPerformed`).
     * 2. The data associated with the action (`data`).
     * * Requires `this` to be an EventEmitter.
     * Requires `this.eventHistory` Map and `this.storeEvent` method to be
     * available for history storage to function.
     *
     * @param {*} data - The data payload associated with the action performed.
     * @param {string} [actionPerformed="actionPerformed"] - The name of the action event to emit.
     * @returns {void}
     *
     * @example
     * // Emits an 'actionPerformed' event with 'actionPerformed' and { details: '...' }
     * server.performAction({ details: 'User logged out' });
     *
     * // Emits a 'task:completed' event with 'task:completed' and taskResult
     * server.performAction(taskResult, 'task:completed');
     * * // Example Listener:
     * server.on('task:completed', (actionName, eventData) => {
     * console.log(`Action '${actionName}' completed with data:`, eventData);
     * });
     */
    performAction(data, actionPerformed = "actionPerformed") {
        // Emit the event name as the first argument, then the data
        this.emit(actionPerformed, actionPerformed, data);

        // Store the event if history is available
        if (typeof this.storeEvent === "function") {
            this.storeEvent(actionPerformed, data);
        }
    }

    /**
     * Stores event data in the event history map (this.eventHistory).
     * If an entry for the eventName doesn't exist, it initializes it with an empty array.
     * * Intended primarily for internal use by event-emitting methods like message() or performAction().
     * Assumes this.eventHistory has been initialized as a Map in the constructor.
     * Note: This implementation does not limit the size of the history stored per event.
     *
     * @param {string} eventName - The name of the event being stored.
     * @param {*} data - The data payload associated with the event instance.
     * @returns {void}
     * @privateRemarks Consider adding logic to limit history size if unbounded growth is a concern.
     */
    storeEvent(eventName, data) {
        // Ensure history map exists and is a Map before proceeding
        if (!(this.eventHistory instanceof Map)) {
            // Log an error or warning if called without proper initialization
            // Using logger if available, otherwise console
            const logger = this.logger || console;
            console.log(`[storeEvent] Attempted to store event "${eventName}" but this.eventHistory is not initialized as a Map.`);
            return; // Stop execution
        }

        // Initialize array for this event if it's the first time
        if (!this.eventHistory.has(eventName)) {
            this.eventHistory.set(eventName, []);
        }

        // Get the array and push the current data
        const historyArray = this.eventHistory.get(eventName);

        // Type guard just in case something else modified the map value
        if (Array.isArray(historyArray)) {
            historyArray.push(data);
        } else {
            // Log error if the value associated with the key is not an array
            const logger = this.logger || console;
            console.log(`[storeEvent] Expected an array for event history key "${eventName}", but found type ${typeof historyArray}.`);
            // Optionally reset it: this.eventHistory.set(eventName, [data]);
        }
    }

    /**
     * Publishes data to a specific channel and stores it in the channel history.
     * This is part of a Pub/Sub pattern implementation using EventEmitter.
     * It emits an event with the name specified by the 'channel' parameter.
     * Requires `this` to be an EventEmitter.
     * Requires `this.channelHistory` Map and `this.storeChannelData` method
     * to be available for history storage to function.
     *
     * @param {string} channel - The name of the channel (event name) to publish to.
     * @param {*} data - The data payload or message to publish on the channel.
     * @returns {void}
     *
     * @example
     * // Publish user data to the 'user:updates' channel
     * server.publisher('user:updates', { userId: 123, status: 'active' });
     *
     * // Publish a simple message to the 'notifications' channel
     * server.publisher('notifications', 'New message received!');
     */
    publisher(channel, data) {
        // 1. Emit the event using the channel name
        // Listeners registered via server.on(channel, ...) or server.subscriber(channel, ...) will receive this.
        this.emit(channel, data);

        // 2. Store the data in the channel history (if mechanism exists)
        // Assumes storeChannelData handles checks for this.channelHistory
        if (typeof this.storeChannelData === "function") {
            this.storeChannelData(channel, data);
        }
    }

    /**
     * Stores data associated with a specific channel in the channel history map (this.channelHistory).
     * If an entry for the channel doesn't exist, it initializes it with an empty array.
     * Used by the `publisher` method and potentially read by the `subscriber` method
     * for replaying history to new subscribers.
     * * Assumes this.channelHistory has been initialized as a Map in the constructor.
     * Note: This implementation does not limit the size of the history stored per channel.
     *
     * @param {string} channel - The name of the channel whose data is being stored.
     * @param {*} data - The data payload published to the channel.
     * @returns {void}
     * @privateRemarks Consider adding logic to limit history size if unbounded growth is a concern.
     */
    storeChannelData(channel, data) {
        // Ensure history map exists and is a Map before proceeding
        if (!(this.channelHistory instanceof Map)) {
            const logger = this.logger || console;
            console.log(`[storeChannelData] Attempted to store data for channel "${channel}" but this.channelHistory is not initialized as a Map.`);
            return; // Stop execution
        }

        // Initialize array for this channel if it's the first message
        if (!this.channelHistory.has(channel)) {
            this.channelHistory.set(channel, []);
        }

        // Get the history array for the channel
        const historyArray = this.channelHistory.get(channel);

        // Type guard and push data
        if (Array.isArray(historyArray)) {
            historyArray.push(data);
        } else {
            const logger = this.logger || console;
            console.log(`[storeChannelData] Expected an array for channel history key "${channel}", but found type ${typeof historyArray}.`);
            // Optionally reset: this.channelHistory.set(channel, [data]);
        }
    }

    /**
     * Subscribes a listener function to a specific channel (event).
     * The listener will be called for all future messages published to that channel.
     * Additionally, upon subscription, this method immediately replays any existing
     * historical messages for that channel to the listener.
     * * NOTE: The immediate history replay iterates synchronously. If a channel has
     * a very large history, this synchronous iteration could potentially block
     * the event loop during the subscription call. Consider limiting history size
     * or alternative replay strategies if this becomes an issue.
     *
     * Requires `this` to be an EventEmitter and `this.channelHistory` Map to be
     * initialized for the history replay feature.
     *
     * @param {string} channel - The name of the channel (event name) to subscribe to.
     * @param {Function} listener - The callback function to execute when data is published
     * or for historical messages. It receives `(channel, data)` as arguments.
     * @returns {void}
     * @throws {TypeError} If listener is not a function.
     *
     * @example
     * server.subscriber('user:updates', (channelName, userData) => {
     * console.log(`Received update on channel [${channelName}]:`, userData);
     * });
     * * // Later...
     * server.publisher('user:updates', { id: 1, status: 'offline' });
     * // The listener above will be called with ('user:updates', { id: 1, status: 'offline' })
     */
    subscriber(channel, listener) {
        if (typeof listener !== "function") {
            throw new TypeError(`Listener provided for channel "${channel}" must be a function.`);
        }
        // Use logger if available
        const logger = this.logger || console;

        // 1. Subscribe to future events
        // Use an arrow function wrapper to ensure the listener receives (channel, data)
        this.on(channel, (data) => {
            try {
                listener(channel, data);
            } catch (err) {
                console.log(`[Subscriber Error] Error in listener during live event for channel "${channel}":`, err);
                // Optionally emit a specific 'subscriberError' event
                this.emit("subscriberError", { err, channel, listener, type: "live" });
            }
        });

        // 2. Replay history (if channelHistory exists and has data)
        if (this.channelHistory instanceof Map && this.channelHistory.has(channel)) {
            const history = this.channelHistory.get(channel);

            if (Array.isArray(history) && history.length > 0) {
                // Check if history is valid array and non-empty
                if (this.contentType.debug) console.log(`[Subscriber] Replaying ${history.length} historical message(s) for channel "${channel}"`);

                // WARNING: Synchronous loop - potentially blocking if history is massive
                history.forEach((data) => {
                    try {
                        // Call listener immediately with historical data
                        listener(channel, data);
                    } catch (err) {
                        console.log(`[Subscriber Error] Error in listener during history replay for channel "${channel}":`, err);
                        // Optionally emit event with different type
                        this.emit("subscriberError", { err, channel, listener, type: "replay", historicalData: data });
                    }
                });
            }
        }
    }

    /**
     * Removes duplicate listener functions for a specified event.
     * It iterates through all registered listeners for the event and removes
     * any subsequent listeners that are identical (by reference) to one
     * already encountered. Only the first instance of each unique listener function
     * reference is kept.
     *
     * @param {string} event - The name of the event whose listeners should be deduplicated.
     * @returns {void}
     *
     * @warning This method can be **computationally expensive**, especially for events
     * with many listeners. It involves iterating through listeners and potentially
     * modifying the internal listener array multiple times (`removeListener`).
     * It should **NOT** be called frequently or within performance-sensitive code
     * paths (like during event emission).
     *
     * @warning Relies on listener reference equality. If the same logical function
     * was bound multiple times (e.g., `fn.bind(this)`) and added separately,
     * this method might not identify them as duplicates unless `rawListeners`
     * consistently returns the original unbound function reference (which isn't guaranteed).
     *
     * @deprecated Consider preventing duplicate listener registration at the point of calling
     * `.on()` or `.addListener()` instead of relying on this cleanup method. Managing
     * listeners explicitly is generally more robust and performant. Use this method
     * only as a specific utility if absolutely necessary for cleanup, not as part
     * of regular event flow.
     *
     * @example
     * // Example: Manually cleanup duplicates for a specific event if needed
     * server.removeDuplicateListeners('userLogin');
     */
    removeDuplicateListeners(event) {
        // Get listeners (rawListeners avoids wrappers from .once if any)
        const listeners = this.rawListeners(event);

        // No need to process if 0 or 1 listener
        if (listeners.length < 2) {
            return;
        }

        const uniqueListeners = new Set(); // Tracks unique listeners encountered

        // Iterate through the listeners
        for (const listener of listeners) {
            // Use the original listener if it's wrapped (e.g., by .once)
            const actualListener = listener.listener || listener;

            if (uniqueListeners.has(actualListener)) {
                // This specific listener's original function has been seen before. Remove this instance.
                // Note: removeListener might iterate internally again.
                this.removeListener(event, listener);
                if (this.contentType.debug) console.log(`[removeDuplicateListeners] Removed duplicate for event "${event}"`);
            } else {
                // First time seeing this listener function, add its original reference to the set.
                uniqueListeners.add(actualListener);
            }
        }
    }

    /**
     * Factory method for creating a fresh, independent instance of UltraFastServer.
     * This explicitly bypasses the singleton pattern implemented in the constructor,
     * ensuring a new instance is created each time this method is called.
     * This is useful for creating sub-applications (to be mounted with `use()`)
     * or for creating isolated instances during testing.
     *
     * @returns {UltraFastServer} A new, independent UltraFastServer instance,
     * configured with default options unless overridden by internal logic
     * triggered by bypassSingleton (if any exists).
     *
     * @example
     * const mainApp = new UltraFastServer(); // Gets/creates the singleton instance
     * const apiApp = mainApp.createSubApp();  // Creates a truly new instance
     * const adminApp = mainApp.createSubApp(); // Creates another new instance
     * console.log(mainApp === apiApp);   // Output: false
     * console.log(adminApp === apiApp);  // Output: false
     */
    createSubApp() {
        // Call the constructor, explicitly passing bypassSingleton: true
        // to ensure the singleton guard is skipped.
        return new UltraFastServer({ bypassSingleton: true });
    }

    /**
     * Sets up a listener for the SIGTERM signal to perform a graceful shutdown
     * of the provided server instance. Attempts to close all connections within a
     * timeout period before forcing an exit.
     * * NOTE: This function adds a global process listener. It should typically be
     * called only ONCE during application setup. Consider also handling SIGINT
     * (Ctrl+C) using a similar pattern. In a clustered setup, signal handling is
     * usually done in the primary process, which then tells workers to disconnect.
     *
     * @param {object} server - The server object to shut down (must have a .close() method, e.g., http.Server or UltraFastServer instance).
     * @param {object} [logger=console] - A logger object with .info() and .error() methods. Defaults to console.
     * @param {number} [timeout=5000] - Timeout in milliseconds to wait for connections to close before forcing exit.
     * @returns {void}
     *
     * @example
     * // In your main application setup (if single process):
     * const server = new UltraFastServer({...});
     * setupGracefulShutdown(server.server, server.logger); // Pass the raw http.Server and logger
     * server.start();
     */
    setupGracefulShutdown(server, logger = console, timeout = 5000) {
        // Flag to prevent running shutdown logic multiple times
        let isShuttingDown = false;

        // --- Unified Shutdown Logic ---
        const performShutdown = async (signal) => {
            if (isShuttingDown) {
                logger.info(`[Shutdown] Already shutting down... (Received ${signal})`);
                return;
            }
            isShuttingDown = true;
            logger.info(`[Shutdown] Received ${signal}. Shutting down gracefully...`);

            // --- Optional: Add other cleanup tasks here ---
            // Example: await closeDatabaseConnection();
            // Example: await AppServiceProvider.shutdown();
            // --- End Optional Cleanup ---

            // Set a timeout to force exit if server.close() hangs
            const forceExitTimeout = setTimeout(() => {
                console.log(`[Shutdown] Timeout (${timeout}ms) reached. Forcing exit.`);
                process.exit(1); // Exit with error code
            }, timeout);

            // Prevent the timeout itself from keeping the process alive
            forceExitTimeout.unref();

            // --- Close the HTTP server ---
            // Stop accepting new connections and wait for existing ones to finish.
            server.close((err) => {
                clearTimeout(forceExitTimeout); // Cancel the force exit timeout
                if (err) {
                    console.log("[Shutdown] Error during server close:", err);
                    process.exit(1); // Exit with error
                } else {
                    logger.info("[Shutdown] Server closed successfully. All connections finished.");
                    process.exit(0); // Clean exit
                }
            });
        };

        // --- Register Signal Listeners ---
        process.on("SIGTERM", () => performShutdown("SIGTERM")); // Termination signal
        process.on("SIGINT", () => performShutdown("SIGINT")); // Interrupt signal (Ctrl+C)
    }

    /**
     * Registers a service instance under a specific name on the server.
     * This allows other parts of the application (like handlers or other services)
     * to potentially access shared services via the server instance.
     * Acts as a simple Service Locator or Dependency Injection mechanism.
     * Requires this.services object to be initialized in the constructor (e.g., this.services = {};).
     *
     * @param {string} name - The name to register the service under. Should be a non-empty string.
     * @param {*} service - The service instance or object to register.
     * @returns {this} The server instance for chaining.
     * @throws {Error} If name is not a valid string or service is null/undefined.
     *
     * @example
     * const dbService = new DatabaseService(config);
     * server.registerService('database', dbService);
     *
     * // Later, in a handler (assuming services are made accessible, e.g., via req.app.services):
     * // const db = req.app.services.database;
     * // await db.query(...);
     */
    registerService(name, service) {
        // --- Validation ---
        if (typeof name !== "string" || name.trim().length === 0) {
            throw new Error("Service name must be a non-empty string.");
        }
        // Allow registering null/undefined intentionally? Usually not.
        if (service === undefined || service === null) {
            // Use logger if available
            (this.logger || console).warn(`[Register Service] Attempted to register null or undefined service for name "${name}".`);
            // Throw an error if null/undefined is invalid
            throw new Error(`Invalid service instance provided for name "${name}". Cannot be null or undefined.`);
        }
        // --- End Validation ---

        // Initialize services object if needed (defensive)
        if (!this.services) this.services = {};

        if (this.services.hasOwnProperty(name) && this.contentType.debug) {
            (this.logger || console).warn(`[Register Service] Overwriting existing service registered under name "${name}".`);
        }

        // Store the service on the services object
        this.services[name] = service;

        if (this.contentType.debug) {
            (this.logger || console).debug(`[Register Service] Registered service "${name}"`);
        }

        // --- Return this for chaining ---
        return this;
    }

    /**
     * Retrieves a previously registered service instance by its name.
     * Assumes services were registered using `registerService(name, service)`
     * and stored in the `this.services` object.
     *
     * @param {string} name - The name of the service to retrieve.
     * @returns {*} The registered service instance, or `undefined` if no service
     * is registered with that name or if `this.services` is not initialized.
     *
     * @example
     * // Assuming dbService was registered earlier:
     * const db = server.getService('database');
     * if (db) {
     * await db.connect();
     * } else {
     * console.error('Database service not found!');
     * }
     */
    getService(name) {
        // Return the service from the services object/map, or undefined if not found
        // Defensive check for services object existence
        return this.services ? this.services[name] : undefined;
    }

    logger(lg) {
        this.logger = lg || console;
        return this;
    }

    metrics(registry) {
        this.metricsRegistry = registry || null;
        return this;
    }

    /**
     * Registers shutdown functions (hooks) to be run during graceful shutdown,
     * OR executes all registered hooks if called with no arguments.
     * * - Registration Mode: Call with one or more functions to add them to the shutdown queue.
     * - Execution Mode: Call with no arguments (typically `await server.onShutdown()`)
     * as part of the graceful shutdown sequence (e.g., within SIGTERM/SIGINT handler,
     * before closing the server). It runs all registered hooks sequentially.
     *
     * Hooks are executed sequentially and awaited if they return Promises, allowing for
     * asynchronous cleanup tasks like closing database connections or saving state.
     * Errors within a hook are caught and logged, allowing subsequent hooks to run.
     *
     * @param {...Function|Function[]} [fns] - Optional: One or more shutdown functions (or arrays of functions) to register.
     * @returns {Promise<void>|this} Returns `this` (for chaining) in registration mode, or a Promise
     * that resolves when all shutdown hooks have completed (or attempted) in execution mode.
     * @throws {Error} If non-function arguments are passed during registration.
     * @throws {Error} If registration is attempted without providing any functions.
     *
     * @example
     * // Registration (e.g., in plugins or setup)
     * server.onShutdown(closeDatabaseConnection);
     * server.onShutdown(async () => { await saveAppState(); });
     *
     * // Execution (e.g., inside SIGTERM handler)
     * process.on('SIGTERM', async () => {
     * console.log('SIGTERM received. Running shutdown hooks...');
     * await server.onShutdown(); // Run registered cleanup
     * console.log('Shutdown hooks complete. Closing server...');
     * server.close(() => process.exit(0));
     * });
     */
    async onShutdown(...fns) {
        // Method is async for execution mode
        // Initialize Set if it doesn't exist (defensive)
        if (!this.shutdownHooks) this.shutdownHooks = new Set();

        // --- Registration Mode ---
        if (fns.length > 0) {
            const handlers = fns.flat(Infinity);
            if (handlers.length === 0) {
                throw new Error("app.onShutdown() requires at least one function when registering hooks.");
            }
            for (const fn of handlers) {
                if (typeof fn !== "function") {
                    throw new TypeError(`app.onShutdown() only accepts functions during registration; got ${typeof fn}`);
                }
                // Recommend binding 'this' if hooks need server instance context
                this.shutdownHooks.add(fn.bind(this));
                if (this.contentType.debug) console.log(`[onShutdown] Registered hook: ${fn.name || "anonymous"}`);
            }
            return this; // Return server instance for chaining
        }
        // --- End Registration Mode ---

        // --- Execution Mode ---
        if (this.contentType.debug) console.log(`[onShutdown] Executing ${this.shutdownHooks.size} shutdown hooks...`);

        // Sequentially execute hooks
        for (const hook of this.shutdownHooks) {
            if (this.contentType.debug) console.log(`[onShutdown]   Running hook: ${hook.name || "anonymous"}...`);
            try {
                // Await supports async hooks (returns Promise) and sync hooks
                await hook();
            } catch (err) {
                // Log error but continue processing other shutdown hooks
                console.log(`[onShutdown] Error during shutdown hook (${hook.name || "anonymous"}):`, err);
                // Optionally emit a 'shutdownHookError' event
                // this.emit('shutdownHookError', { err, hook });
            }
            if (this.contentType.debug) console.log(`[onShutdown]   Hook finished: ${hook.name || "anonymous"}`);
        }

        if (this.contentType.debug) console.log("[onShutdown] All shutdown hooks executed.");
        // Implicitly returns Promise<void> when execution completes
    } // End onShutdown

    /**
     * Registers one or more global middleware functions.
     * These functions are stored separately in `this.globalMiddlewares`.
     * * NOTE: The core `_runMiddleware` function currently iterates through `this.middlewares`.
     * Additional logic would be needed within `_runMiddleware` to decide when and how
     * to execute handlers stored in `this.globalMiddlewares` relative to the main chain.
     * Consider if using `server.use(handler)` (without a path) is sufficient for global middleware,
     * as it adds directly to the main execution chain (`this.middlewares`).
     * * Requires `this.globalMiddlewares` Set to be initialized in the constructor.
     *
     * @param {...Function|Function[]} fns - One or more global middleware functions
     * (or arrays of functions). Each function should have the signature (req, res, next).
     * @returns {this} The server instance for chaining.
     * @throws {Error} If no functions are provided.
     * @throws {TypeError} If any argument is not a function.
     *
     * @example
     * server.useGlobal(globalTimingLogger, checkServerStatus);
     */
    useGlobal(...fns) {
        // Add flattening for consistency with other use* methods
        const handlers = fns.flat(Infinity);
        if (handlers.length === 0) {
            throw new Error("app.useGlobal() requires at least one middleware function");
        }
        // Initialize Set if it doesn't exist (defensive)
        if (!this.globalMiddlewares) this.globalMiddlewares = new Set();

        for (const fn of handlers) {
            if (typeof fn !== "function") {
                throw new TypeError(`app.useGlobal() only accepts functions; got ${typeof fn}`);
            }
            // Check arity - should global middleware also exclude error handlers? Assume yes for now.
            if (fn.length === 4) {
                console.log(`[useGlobal] Attempted to register an error handler globally via useGlobal. Use server.use(errorHandlerFn) instead. Ignoring ${fn.name || "anonymous"}.`);
                continue; // Skip error handlers
            }
            // Recommend binding 'this' if context is needed
            this.globalMiddlewares.add(fn.bind(this));
        }
        return this;
    }
    /**
     * Registers one or more middleware functions specifically for an exact route path,
     * potentially intended to run for any HTTP method matching that path.
     * Stores handlers in `this.routeMiddlewares`.
     * * NOTE: The current server execution logic (`_runMiddleware`, `_routerMiddleware`)
     * does **not** automatically execute middleware stored in `this.routeMiddlewares`.
     * Additional logic would be needed to integrate this specific middleware type
     * into the request processing lifecycle at the desired point (e.g., before or
     * after method-specific handlers).
     * * Consider if `server.route(path).all(mw)` or `server.use(path, mw)`
     * (for prefixes) already covers the intended use case.
     * * Requires `this.routeMiddlewares` object/Map to be initialized in the constructor.
     *
     * @param {string} path - The exact route path string (e.g., '/users/profile'). Must be non-empty.
     * @param {...Function|Function[]} fns - One or more middleware functions (req, res, next).
     * @returns {this} The server instance for chaining.
     * @throws {Error} If path is not a non-empty string or no functions are provided.
     * @throws {TypeError} If any argument after path is not a function.
     *
     * @example
     * server.useRoute('/users/profile', loadUserProfileMiddleware, checkProfileAccess);
     * server.get('/users/profile', showProfileHandler); // loadUserProfileMiddleware might run before this? (Needs execution logic)
     */
    useRoute(path, ...fns) {
        // Validate path
        if (typeof path !== "string" || !path) {
            // Also check for empty string
            throw new TypeError("app.useRoute() first argument must be a non-empty string path");
        }
        // Normalize path? (e.g., trailing slash) - Depends on desired matching behavior
        // const normalizedPath = ... path ... ;

        // Flatten handler arguments
        const handlers = fns.flat(Infinity);
        if (handlers.length === 0) {
            throw new Error("app.useRoute() requires at least one middleware function");
        }

        // Validate handlers and recommend binding 'this'
        const boundHandlers = [];
        for (const fn of handlers) {
            if (typeof fn !== "function") {
                throw new TypeError(`app.useRoute() only accepts functions; got ${typeof fn}`);
            }
            // Bind 'this' context for consistency
            boundHandlers.push(fn.bind(this));
        }

        // Initialize storage if needed (defensive)
        if (!this.routeMiddlewares) this.routeMiddlewares = {}; // Or new Map()

        // Store the array of handlers, keyed by the exact path
        // This appends handlers if useRoute is called multiple times for the same path
        this.routeMiddlewares[path] = this.routeMiddlewares[path] || [];
        this.routeMiddlewares[path].push(...boundHandlers); // Push the newly bound handlers

        if (this.contentType.debug) {
            console.log(`[useRoute] Registered ${boundHandlers.length} handlers for exact path: "${path}"`);
        }

        return this;
    }

    /**
     * Express-style mount for first-party static middleware (if available)
     * Example: app.use('/assets', app.useStatic({ roots:['./public'], immutable:true }))
     */
    useStatic(opts = {}) {
        if (typeof createStaticMiddleware !== "function") {
            throw new Error("createStaticMiddleware module is not available in this build.");
        }
        return createStaticMiddleware(opts);
    }

    /**
     * Registers one or more middleware functions that are intended to run
     * specifically for POST requests.
     * * NOTE: This method registers handlers into a separate collection (`this.postMiddlewares`).
     * The core `_runMiddleware` logic would need to be modified to explicitly check
     * the request method and execute handlers from this collection at the appropriate time
     * (e.g., before or after global `use()` middleware, before the router?).
     * * Alternatively, consider using the standard `server.use()` and checking
     * `req.method === 'POST'` within the middleware function for simpler integration.
     * * Requires `this.postMiddlewares` Set to be initialized in the constructor.
     *
     * @param {...Function|Function[]} fns - One or more middleware functions (req, res, next).
     * @returns {this} The server instance for chaining.
     * @throws {Error} If no functions are provided.
     * @throws {TypeError} If any argument is not a function.
     *
     * @example
     * server.usePost(verifyPostContentType, logPostData);
     * // Assumes logic is added elsewhere to run these for POST requests.
     */
    usePost(...fns) {
        // 1) Flatten any nested arrays of fns
        const handlers = fns.flat(Infinity);

        // 2) Require at least one middleware
        if (handlers.length === 0) {
            throw new Error("app.usePost() requires at least one middleware function");
        }
        // Initialize Set if it doesn't exist (defensive)
        if (!this.postMiddlewares) this.postMiddlewares = new Set();

        // 3) Validate each is actually a function
        for (const fn of handlers) {
            if (typeof fn !== "function") {
                throw new TypeError(`app.usePost() only accepts functions; got ${typeof fn}`);
            }
            // 4) Add to your postMiddlewares set (avoids duplicates automatically)
            // Recommend binding 'this' if handlers need server context
            this.postMiddlewares.add(fn.bind(this));
        }

        return this; // 5) Return this for chaining
    }

    // Add this method to the UltraFastServer class:

    /**
     * Returns a new chainable Route instance for the given path.
     * @param {string} path - The route path (e.g., '/users', '/posts/:id').
     * @returns {Route} An instance of the Route class.
     */
    route(path) {
        // Basic validation (addRoute does more thorough validation)
        if (typeof path !== "string" || !path.startsWith("/")) {
            throw new Error(`Invalid path specified for route(): "${path}"`);
        }
        // Create and return the Route object, passing the path and server instance
        return new Route(path, this);
    }

    /** ADDED: REFACTORE
     * Creates a route group, allowing definition of routes and middleware
     * under a common path prefix using a fluent, callback-based API.
     *
     * @param {string} prefix - The path prefix for all routes defined within this group (e.g., '/api/v1'). Must start with '/'.
     * @param {...Function} args - Optional middleware function(s) followed by a single callback function.
     * Middleware added here will apply to all routes defined inside the callback
     * and any nested groups. The callback function receives a 'scopedRouter'
     * argument with methods like .get(), .post(), .use(), .group().
     * @returns {this} The UltraFastServer instance for potential chaining.
     * @throws {Error} If prefix is invalid or the last argument is not a function.
     *
     * @example
     * server.group('/api', apiAuthMiddleware, (api) => {
     * api.use(apiRequestLogger); // Middleware only for /api/*
     * api.get('/users', listUsersHandler); // Registers GET /api/users
     * api.post('/users', createUserHandler); // Registers POST /api/users
     *
     * api.group('/v1', (v1) => { // Nested group
     * v1.get('/status', statusHandlerV1); // Registers GET /api/v1/status
     * });
     * });
     */
    group(prefix, ...args) {
        // --- Validate Input & Extract Args ---
        if (typeof prefix !== "string" || !prefix.startsWith("/")) {
            throw new Error(`Invalid group prefix: "${prefix}". Must start with '/'.`);
        }
        if (args.length === 0) {
            throw new Error(`group() for prefix "${prefix}" requires a callback function.`);
        }

        const callback = args.pop(); // Last argument is the callback
        const initialGroupMiddleware = args; // Middleware passed directly to group()

        // Validate callback and initial middleware
        if (typeof callback !== "function") {
            throw new Error(`The last argument supplied to group() for prefix "${prefix}" must be a function.`);
        }
        initialGroupMiddleware.forEach((mw, i) => {
            if (typeof mw !== "function") {
                throw new Error(`Middleware at index ${i} for group "${prefix}" is not a function.`);
            }
        });
        // --- End Validation ---

        // Normalize prefix (remove trailing slash unless root '/')
        const normalizedPrefix = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix === "" ? "/" : prefix;

        // --- Scoped Variables for this Group ---
        // Stores ORIGINAL middleware functions added via proxy.use() within this group's callback
        const groupSpecificMiddleware = [];
        const scopedRouter = {}; // The proxy object passed to the callback

        // --- Define Proxy Methods ---

        /** Adds middleware specific to this group and its subgroups, runs after initial group middleware */
        scopedRouter.use = (...handlers) => {
            handlers.forEach((mw) => {
                if (typeof mw === "function" && mw.length !== 4) {
                    // Basic validation
                    groupSpecificMiddleware.push(mw); // Store the original function
                } else {
                    console.log(`[Group "${normalizedPrefix}"] Invalid argument passed to scopedRouter.use().`);
                }
            });
            return scopedRouter; // Allow chaining proxy.use().use()
        };

        // Add HTTP verb methods (get, post, etc.) to the scoped proxy
        http.METHODS.forEach((method) => {
            const lowerCaseMethod = method.toLowerCase();

            /** Scoped route definition method (e.g., .get, .post) */
            scopedRouter[lowerCaseMethod] = (subPath, ...routeHandlers) => {
                if (typeof subPath !== "string") throw new Error(`Invalid subPath "${subPath}" for ${lowerCaseMethod} in group "${normalizedPrefix}".`);

                // Combine prefix and subPath carefully
                const normalizedSubPath = subPath === "" || subPath.startsWith("/") ? subPath : `/${subPath}`;
                let fullPath = normalizedPrefix === "/" ? normalizedSubPath : `${normalizedPrefix}${normalizedSubPath}`;
                if (fullPath.length > 1 && fullPath.endsWith("/")) {
                    fullPath = fullPath.slice(0, -1);
                }
                if (fullPath === "") {
                    fullPath = "/";
                }

                // Allow a route options object (e.g., { params:{...}, rateLimit:'300/m' }) as FIRST item after path.
                let opts = null,
                    restHandlers = routeHandlers;
                if (routeHandlers.length && routeHandlers[0] && typeof routeHandlers[0] === "object" && typeof routeHandlers[0] !== "function" && !Array.isArray(routeHandlers[0])) {
                    opts = routeHandlers[0];
                    restHandlers = routeHandlers.slice(1);
                }

                if (opts) {
                    this.addRoute(method, fullPath, opts, ...initialGroupMiddleware, ...groupSpecificMiddleware, ...restHandlers);
                } else {
                    this.addRoute(method, fullPath, ...initialGroupMiddleware, ...groupSpecificMiddleware, ...routeHandlers);
                }

                // // Combine all handlers in correct order: initial server.group MW -> scopedRouter.use MW -> route-specific MW
                // // Pass ORIGINAL functions to addRoute, which handles binding.
                // const allHandlers = [...initialGroupMiddleware, ...groupSpecificMiddleware, ...routeHandlers];

                // // Delegate route registration to the main server instance
                // this.addRoute(method, fullPath, ...allHandlers);
                // // Return value for proxy methods isn't typically used for chaining across methods.
            };
        });

        // Add nested group capability
        /** Defines a nested route group */
        scopedRouter.group = (subPrefix, ...nestedArgs) => {
            if (typeof subPrefix !== "string") throw new Error(`Invalid nested prefix "${subPrefix}" in group "${normalizedPrefix}".`);

            // Combine prefixes
            const normalizedSubPrefix = subPrefix === "" || subPrefix.startsWith("/") ? subPrefix : `/${subPrefix}`;
            let fullPrefix = normalizedPrefix === "/" ? normalizedSubPrefix : `${normalizedPrefix}${normalizedSubPrefix}`;
            if (fullPrefix.length > 1 && fullPrefix.endsWith("/")) {
                fullPrefix = fullPrefix.slice(0, -1);
            }
            if (fullPrefix === "") {
                fullPrefix = "/";
            }

            // Extract middleware and callback for the nested group
            const innerCallback = nestedArgs.pop();
            const innerGroupMiddleware = nestedArgs; // Middleware passed to this nested group() call
            if (typeof innerCallback !== "function") throw new Error(`Last arg for nested group "${fullPrefix}" must be callback.`);
            innerGroupMiddleware.forEach((mw, i) => {
                if (typeof mw !== "function") throw new Error(`Middleware at index ${i} for nested group "${fullPrefix}" is not a function.`);
            });

            // Combine ALL middleware applicable to the nested group
            // Order: Outer initial MW -> Outer group-specific MW -> Inner initial MW
            const allNestedMiddleware = [
                ...initialGroupMiddleware,
                ...groupSpecificMiddleware, // Inherit middleware added via outer scopedRouter.use()
                ...innerGroupMiddleware,
            ];

            // Call the main server's group method recursively, passing combined middleware
            this.group(fullPrefix, ...allNestedMiddleware, innerCallback);
        };
        // --- End Proxy Methods ---

        // --- Execute User's Callback ---
        try {
            if (this.contentType.debug) console.log(`[Route Group] Entering definition for prefix: "${normalizedPrefix}"`);
            callback(scopedRouter); // Pass the proxy object with .use, .get, .post, .group methods
            if (this.contentType.debug) console.log(`[Route Group] Exiting definition for prefix: "${normalizedPrefix}"`);
        } catch (err) {
            console.log(`[Route Group Error] Error during callback execution for prefix "${normalizedPrefix}":`, err);
            throw err; // Fail fast during setup if callback throws
        }
        // --- End Callback Execution ---

        return this; // Allow chaining server.group(...).group(...) if needed
    } // End group method

    /** Assign a stable name to a route and register with both routers */
    nameRoute(name, method, pathPattern) {
        if (!name || typeof name !== "string") throw new Error("nameRoute(name, method, path) requires a string name.");
        if (!method || typeof method !== "string") throw new Error("nameRoute requires an HTTP method.");
        if (!pathPattern || typeof pathPattern !== "string") throw new Error("nameRoute requires a path pattern.");

        this._namedRoutes.set(name, { method: method.toUpperCase(), path: pathPattern });

        if (this.radix && typeof this.radix.nameRoute === "function") {
            try {
                this.radix.nameRoute(name, method, pathPattern);
            } catch (_) {}
        }
        return this;
    }

    /** Build a URL by name using RadixRouter first; fallback to legacy map */
    urlFor(name, params = {}) {
        if (this.radix && typeof this.radix.urlFor === "function") {
            try {
                return this.radix.urlFor(name, params);
            } catch (_) {}
        }
        if (this.dynamicRouter && typeof this.dynamicRouter.urlFor === "function") {
            try {
                return this.dynamicRouter.urlFor(name, params);
            } catch (_) {
                // fall through to legacy if name unknown to Radix or params incomplete
            }
        }
        const entry = this._namedRoutes.get(name);
        if (!entry) throw new Error(`urlFor: route name "${name}" not found.`);
        let out = entry.path;
        out = out.replace(/:([A-Za-z_]\w*)\??/g, (_, k) => {
            if (!(k in params)) throw new Error(`urlFor("${name}"): missing param "${k}"`);
            const v = params[k];
            delete params[k];
            return encodeURIComponent(String(v));
        });
        const extra = Object.entries(params);
        if (extra.length) {
            const qs = extra.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
            out += (out.includes("?") ? "&" : "?") + qs;
        }
        return out;
    }

    // Add this method to the UltraFastServer class

    /**
     * Registers a middleware function, optionally scoped to a path prefix.
     * Middleware are executed in the order they are added.
     * Error handling middleware (4 arguments) are treated globally.
     * @param {string | Function} path - Optional path prefix string (e.g., '/api'). If omitted, middleware is global.
     * @param {Function} [handler] - The middleware function (req, res, next). Required if path is provided.
     * @returns {this} - The server instance for chaining.
     * @throws {Error} If arguments are invalid.
     */

    use(...args) {
        let path = null;
        let handlers = [];

        // 1. Determine path (optional) and collect handlers
        if (typeof args[0] === "string" && args[0].startsWith("/")) {
            path = args[0];
            // Basic path normalization (e.g., remove trailing slash unless root)
            path = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
            if (path === "") path = "/"; // Handle empty string becoming root
            handlers = args.slice(1).flat(Infinity); // Use rest arguments, flatten arrays
        } else {
            // No path provided, all arguments are handlers
            path = null; // Global
            handlers = args.flat(Infinity); // Use all arguments, flatten arrays
        }

        // 2. Validate that we have at least one handler
        if (handlers.length === 0) {
            throw new Error("app.use() requires at least one middleware function.");
        }

        // 3. Process each handler
        handlers.forEach((handler) => {
            if (typeof handler !== "function") {
                // Ensure we throw if a non-function is encountered
                throw new TypeError(`Middleware must be a function. Received type: ${typeof handler}`);
            }

            // 4. Differentiate between error handlers and regular middleware
            if (handler.length === 4) {
                // Error Handling Middleware
                if (path !== null) {
                    // Path is ignored for error handlers in this design (like Express default)
                    console.warn(`Path argument (${path}) is ignored for error handling middleware: ${handler.name || "anonymous"}. Error handlers are global.`);
                }
                // Ensure the array exists
                if (!this.errorHandlers) this.errorHandlers = [];
                // Add the bound error handler to the dedicated array
                this.errorHandlers.push(handler.bind(this));
                if (this.contentType.debug) console.log(`[Middleware] Global Error Handler Registered: ${handler.name || "anonymous"}`);
            } else {
                // Regular Middleware
                const boundHandler = handler.bind(this);
                // Push an entry for *this specific handler* with the determined path
                // this.middlewares.push({ path: path, handler: boundHandler });
                // const boundHandler = handler.bind(this);
                const entry = { path: path, handler: boundHandler };

                // By default, place user-added middleware *before* the router, so it runs for all routes.
                if (this._bootstrappingCore === true) {
                    // During core bootstrap, just append
                    this.middlewares.push(entry);
                } else {
                    // Find the first router layer and insert right before it
                    const idx = this.middlewares.findIndex((l) => l && l.__coreStage === "router");
                    if (idx >= 0) {
                        this.middlewares.splice(idx, 0, entry);
                    } else {
                        // Fallback: insert before final 404 if present; else append
                        const fidx = this.middlewares.findIndex((l) => l && String(l.__coreStage || "").startsWith("final"));
                        if (fidx >= 0) {
                            this.middlewares.splice(fidx, 0, entry);
                        } else {
                            this.middlewares.push(entry);
                        }
                    }
                }

                if (this.contentType.debug) {
                    const scope = path ? `Path: ${path}` : "Global";
                    console.log(`[Middleware] Registered: ${handler.name || "anonymous"} (${scope})`);
                }
            }
        }); // End forEach handler

        return this; // Enable chaining
    }

    useWorks(path, handler) {
        let routePath = null;
        let middlewareHandler = null;

        // Determine arguments based on signature: use(handler) vs use(path, handler)
        if (typeof path === "function" && handler === undefined) {
            middlewareHandler = path;
            routePath = null;
        } else if (typeof path === "string" && typeof handler === "function") {
            if (!path.startsWith("/")) {
                throw new Error(/*...*/);
            }
            routePath = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
            if (routePath === "") routePath = "/";
            middlewareHandler = handler;
        } else {
            throw new Error("Invalid arguments for server.use()...");
        }

        // Handle error handlers
        if (middlewareHandler.length === 4) {
            if (routePath !== null) {
                /* ... warn ... */
            }
            this.errorHandler = middlewareHandler.bind(this);
            if (this.contentType.debug) console.log(`[Middleware] Error Handler Registered: ${middlewareHandler.name || "anonymous"}`);
        } else {
            // --- Logic for regular middleware ---
            const boundHandler = middlewareHandler.bind(this); // Bind once
            const entryToPush = {
                // Create the object to be pushed
                path: routePath,
                handler: boundHandler,
            };

            // --- CORRECTED DEBUG LOG ---
            // Reference properties directly from the object or the original variables
            // console.log('[use() DEBUG] Object to be pushed:', {
            //     pathValue: entryToPush.path,      // Correct: Use entryToPush.path
            //     handlerExists: typeof entryToPush.handler === 'function', // Correct: Use entryToPush.handler
            //     handlerName: entryToPush.handler.name || 'anonymous'       // Correct: Use entryToPush.handler.name
            // });
            // --- END DEBUG LOG CORRECTION ---

            // Now push the correctly formed object
            this.middlewares.push(entryToPush);

            if (this.contentType.debug) {
                const scope = routePath ? `Path: ${routePath}` : "Global";
                console.log(`[Middleware] Registered: ${middlewareHandler.name || "anonymous"} (${scope})`);
            }
            // --- End regular middleware logic ---
        }
        return this; // Enable chaining
    }

    /** ADDED: REFACTORED
     * Dynamically creates Express-style routing methods (get, post, etc.)
     * based on Node.js's supported http.METHODS list.
     * Also handles the app.get('setting') signature ambiguity.
     * Ensures settings methods (set, enable, etc.) use the Map API.
     * @private
     */
    _addAndMountHTTPMethods() {
        // Add HTTP verb methods dynamically (get, post, put, delete, etc.)
        http.METHODS.forEach((method) => {
            const lowerCaseMethod = method.toLowerCase();
            // Avoid overwriting methods if they already exist (e.g., 'on' from EventEmitter)
            // Or potentially methods like 'get' if we defined it manually for settings first.
            if (this[lowerCaseMethod] === undefined) {
                // This is the function assigned to server.get, server.post etc.
                this[lowerCaseMethod] = function (pathOrName, ...handlers) {
                    // Use rest param for handlers

                    // --- Disambiguate: get('setting') vs get('/path', ...) ---
                    // Check if it's likely a setting getter call:
                    // Method must be GET, only one argument provided (pathOrName),
                    // AND it's a string that doesn't start with '/'.
                    const isLikelySettingGetter =
                        method === "GET" &&
                        handlers.length === 0 && // No further arguments after pathOrName
                        typeof pathOrName === "string" &&
                        !pathOrName.startsWith("/");

                    if (isLikelySettingGetter) {
                        // --- GET Setting ---
                        if (this.contentType.debug) console.log(`[Settings] Getting setting: "${pathOrName}"`);
                        // Use Map#get - Returns undefined if key doesn't exist
                        return this.settings.get(pathOrName);
                    } else {
                        // --- DEFINE Route ---
                        const path = pathOrName; // First arg is the path (string or RegExp)

                        // Validate path type and format
                        if (!(path instanceof RegExp) && (typeof path !== "string" || !path.startsWith("/"))) {
                            throw new Error(`Invalid path specified for ${method} route: ${path}`);
                        }
                        // Validate handlers (collected in ...handlers rest parameter)
                        if (handlers.length === 0) {
                            throw new Error(`Route ${method} ${path} requires at least one handler function.`);
                        }
                        handlers.forEach((h, i) => {
                            if (typeof h !== "function") throw new Error(`Handler ${i} for ${method} ${path} is not a function.`);
                        });

                        // Call addRoute (which uses rest param ...handlers internally now)
                        // No 'options' object in this simplified flow
                        this.addRoute(method, path, ...handlers); // Spread handlers array

                        return this; // Enable chaining for route definitions
                    }
                    // --- End Disambiguation ---
                }; // End of dynamically created function

                if (this.contentType.debug) console.log(`[Server Setup]   Mounted method: ${lowerCaseMethod}()`);
            } // End if method doesn't exist
        }); // End forEach method

        // --- Ensure Settings methods use Map API (Define/Overwrite) ---
        // Use function keyword here to ensure 'this' refers to the server instance when called
        this.set = function (name, value) {
            if (arguments.length !== 2) throw new Error("server.set() requires name and value arguments.");
            if (!this.settings) this.settings = new Map(); // Initialize if called before constructor finishes? Defensive.
            this.settings.set(String(name), value); // Use Map#set
            if (this.contentType.debug) console.log(`[Settings] Set "${name}" =`, value);
            return this;
        };
        this.enable = function (name) {
            return this.set(name, true);
        };
        this.disable = function (name) {
            return this.set(name, false);
        };
        // enabled/disabled rely on the working get(name) call logic defined above in the GET method override
        this.enabled = function (name) {
            return this.get(String(name)) === true;
        }; // Strict check against boolean true
        this.disabled = function (name) {
            return this.get(String(name)) === false;
        }; // Strict check against boolean false
    } // End _addAndMountHTTPMethods

    /**
     * Dynamically creates Express-style routing methods (get, post, etc.).
     * @private
     */

    _registerCoreMiddleware() {
        // this.use(this._rateLimiterMiddleware);
        // this.use(this._urlParsingMiddleware);
        // this.use(this._bodyParserMiddleware);
        // this.use(this._routerMiddleware); // Contains the logic to run handler arrays
        // this.use(this._staticFileMiddleware);
        // this.use(this._notFoundMiddleware);

        // Insert core middleware in a known order and tag each layer,
        // so app.use() can place user middleware before the router by default.
        this._bootstrappingCore = true;

        this.use(this._rateLimiterMiddleware);
        this._markLastLayer("__coreStage", "pre:rateLimiter");

        this.use(this._urlParsingMiddleware);
        this._markLastLayer("__coreStage", "pre:url");

        this.use(this._bodyParserMiddleware);
        this._markLastLayer("__coreStage", "pre:body");

        this.use(this._routerMiddleware); // Contains the logic to run handler arrays
        this._markLastLayer("__coreStage", "router");

        this.use(this._staticFileMiddleware);
        this._markLastLayer("__coreStage", "post:static");

        this.use(this._notFoundMiddleware);
        this._markLastLayer("__coreStage", "final:404");

        this._bootstrappingCore = false;
    }

    /** Tag the most recently added middleware layer (internal use). */
    _markLastLayer(key, value) {
        const arr = this.middlewares;
        if (arr && arr.length > 0) {
            try {
                arr[arr.length - 1][key] = value;
            } catch (_) {}
        }
    }

    // === Register Core Middleware in Order ===

    /** ADDED: REFACTORED
     * Main request listener - runs the middleware chain.
     * This function is bound to the http.createServer callback.
     * It augments the response object, executes middleware sequentially
     * (respecting path scopes), handles errors, and triggers final handlers.
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @private
     */

    _runMiddleware(req, res) {
        const logger = this.logger || console;

        let index = 0; // Track current middleware index
        const serverInstance = this; // Capture server instance for closures

        // --- Augment res object ---
        try {
            // rs.decorate(req, res, { trustProxy: true, mimeTypes, cookieSecret: 'replace-with-strong-secret' }); // Decorate request and response (req-decorator

            // Check for static file handling first

            res.req = req; // Attach request for context within helpers
            res._server = this; // Attach server instance to call helpers like sendApiResponse
            // decorateRequest(req, res);
            // decorateResponse(res, req);
            res.status = rs.setStatusCode;
            res.set = rs.setHeader;
            res.header = rs.setHeader;
            res.send = rs.sendFlexible;
            res.json = rs.sendJson;
            res.sendStatus = rs.sendStatus;
            res.sendFile = rs.sendStaticFile;

            // Stream a JSON array without buffering the whole payload
            if (!res.jsonStream) {
                res.jsonStream = async (iterable, opts = {}) => {
                    try {
                        if (req.method === "HEAD") return res.end();
                        res.setHeader("Content-Type", "application/json; charset=utf-8");
                        if (!res.headersSent && typeof res.flushHeaders === "function") res.flushHeaders();
                        let first = true;
                        res.write("[");
                        const writeChunk = async (chunk) => {
                            const str = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                            const ok = res.write(first ? str : "," + str);
                            first = false;
                            if (!ok) await once(res, "drain");
                        };
                        if (iterable && typeof iterable[Symbol.asyncIterator] === "function") {
                            for await (const item of iterable) {
                                if (res.writableEnded || res.destroyed) break;
                                await writeChunk(item);
                            }
                        } else if (iterable && typeof iterable[Symbol.iterator] === "function") {
                            for (const item of iterable) {
                                if (res.writableEnded || res.destroyed) break;
                                await writeChunk(item);
                            }
                        }
                        res.write("]");
                        res.end();
                    } catch (e) {
                        try {
                            res.destroy(e);
                        } catch (_) {}
                    }
                };
            }

            // Cork small writes into a single packet when possible
            if (!res.cork) {
                res.cork = (fn) => {
                    const s = res.socket;
                    if (!s || typeof s.cork !== "function") return fn && fn();
                    s.cork();
                    try {
                        return fn && fn();
                    } finally {
                        try {
                            s.uncork();
                        } catch (_) {}
                    }
                };
            }

            // Simple cache-control helper
            if (!res.cache) {
                res.cache = (seconds = 0, directives = {}) => {
                    const base = seconds > 0 ? `public, max-age=${Math.floor(seconds)}` : "no-store";
                    const extra = Object.entries(directives)
                        .map(([k, v]) => (v === true ? k : `${k}=${v}`))
                        .join(", ");
                    res.setHeader("Cache-Control", extra ? `${base}, ${extra}` : base);
                    return res;
                };
            }

            // Optional Express-y helpers if present in req-res-decorators
            if (typeof rs.type === "function") res.type = rs.type;
            if (typeof rs.vary === "function") res.vary = rs.vary;
            if (typeof rs.location === "function") res.location = rs.location;
            if (typeof rs.redirect === "function") res.redirect = rs.redirect;
            if (typeof rs.links === "function") res.links = rs.links;
            if (typeof rs.attachment === "function") res.attachment = rs.attachment;

            // rs.decorate(req, res, { trustProxy: true, mimeTypes, cookieSecret: 'replace-with-strong-secret' }); // Decorate request and response (req-decorator

            responseDecorator(res, req);
            requestDecorator(req, res);

            // Early Hints (103) helper (Node >=18 supports res.writeEarlyHints)
            res.earlyHints = function earlyHints(h) {
                try {
                    if (typeof res.writeEarlyHints === "function") res.writeEarlyHints(h || {});
                } catch (_) {}
            };

            // Per-request timeout → onTimeout hook + metric + graceful 504
            if (typeof res.setTimeout === "function" && this.timeout) {
                try {
                    res.setTimeout(this.timeout, () => {
                        this._metrics.http_timeouts_total++;
                        try {
                            this._callHooks("onTimeout", { req, res });
                        } catch (_) {}
                        try {
                            if (!res.writableEnded) {
                                res.writeHead(504, { "Content-Type": "text/plain" });
                                res.end("Gateway Timeout");
                            } else {
                                res.destroy();
                            }
                        } catch (_) {}
                    });
                } catch (_) {}
            }

            if (this.engines && Object.keys(this.engines).length > 0) {
                // Only add render if engines are configured
                res.render = (view, locals = {}) => {
                    this.render(view, locals, (err, html) => {
                        if (err) {
                            return this.errorHandler(err, req, res);
                        }
                        // set HTML content type and send
                        res.setHeader("Content-Type", "text/html");
                        res.end(html);
                    });
                };
            }

            //this._staticFileHandler(req, res);
        } catch (augmentError) {
            console.log("[Middleware Runner Error] Failed to augment response object:", augmentError);
            try {
                // Attempt basic error response if possible
                if (!res.writableEnded) {
                    res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                    res.end("Internal Server Error");
                } else if (!res.destroyed) {
                    res.destroy();
                }
            } catch (_) {
                /* Ignore secondary error */
            }
            return; // Stop processing if augmentation fails
        }
        // --- End Augmentation ---

        // Register this response as in-flight; remove on finish/close
        if (this._inFlight && typeof this._inFlight.add === "function") {
            this._inFlight.add(res);
            const done = () => {
                try {
                    this._inFlight.delete(res);
                } catch {}
            };
            res.on("finish", done);
            res.on("close", done);
        } else {
            // Fallback: support numeric counter if a previous patch used it
            this._inFlight = (this._inFlight | 0) + 1;
            const dec = () => {
                this._inFlight = Math.max(0, (this._inFlight | 0) - 1);
            };
            res.on("finish", dec);
            res.on("close", dec);
        }

        // --- Setup Final Handlers ---
        // ---- Per-request instrumentation ----
        const rid = typeof randomUUID === "function" ? randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
        req.id = rid;
        const t0 = performance.now();

        // Request-scoped context via AsyncLocalStorage
        const _ctx = { requestId: rid, startAt: t0, req, res };
        try {
            this._als.enterWith(_ctx);
        } catch (_) {}
        if (!res.locals) res.locals = {};
        res.locals.requestId = rid;

        this._inFlight.add(rid);
        this._metrics.http_in_flight++;
        this._metrics.http_requests_total++;

        // Trace store (cheap breadcrumbs)
        this._reqTraces.set(rid, [{ t: t0, tag: "start", extra: { method: req.method, url: req.url } }]);

        // beforeSend / afterSend hook bridging: wrap res.end once
        const _end = res.end;
        let _beforeSent = false;
        res.end = (...args) => {
            if (!_beforeSent) {
                _beforeSent = true;
                try {
                    this._callHooks("beforeSend", { req, res });
                } catch (_) {}
            }
            return _end.apply(res, args);
        };

        // afterSend hook on finish
        res.once("finish", () => {
            try {
                this._callHooks("afterSend", { req, res });
            } catch (_) {}
        });

        // Outbound bytes (best-effort: rely on Content-Length if set)
        res.once("finish", () => {
            if (res.getHeader && res.getHeader("Content-Length")) {
                const n = Number(res.getHeader("Content-Length")) || 0;
                this._metrics.http_body_bytes_out_total += n;
            }
        });

        // Complete request metrics
        const complete = () => {
            const t1 = performance.now();
            const dur = Math.max(0, t1 - t0);
            this._metrics.durations_ms.push(dur);
            this._inFlight.delete(rid);
            if (this._metrics.http_in_flight > 0) this._metrics.http_in_flight--;
            this._reqTraces.get(rid)?.push({ t: t1, tag: "end", extra: { status: res.statusCode, dur_ms: dur } });
            // keep last few traces to bound memory (optional)
            if (this._reqTraces.size > 5000) {
                const [first] = this._reqTraces.keys();
                this._reqTraces.delete(first);
            }
        };
        res.once("finish", complete);
        res.once("close", complete);

        let finalHandlersExecuted = false; // Prevent double execution
        const runFinalHandlers = () => {
            if (finalHandlersExecuted) return;
            finalHandlersExecuted = true;

            // Check if the Set exists and has handlers
            if (serverInstance.finalMiddlewares && serverInstance.finalMiddlewares.size > 0) {
                if (serverInstance.contentType.debug) logger.log(`Running ${serverInstance.finalMiddlewares.size} final handlers for ${req.method} ${req.originalUrl || req.url}`);

                serverInstance.finalMiddlewares.forEach((fn) => {
                    try {
                        // Pass req and res for context
                        fn(req, res);
                    } catch (finalErr) {
                        // Cannot send response here, just log
                        console.log(`[Final Middleware Error] Error in useFinally handler for ${req.method} ${req.originalUrl || req.url}:`, finalErr);
                    }
                });
            }
        };
        // Attach listeners to run after response finishes or connection closes
        res.on("finish", runFinalHandlers);
        res.on("close", runFinalHandlers);
        // --- End Final Handler Setup ---

        // Define the 'next' function for this request cycle
        const next = (err) => {
            // Attach next to req for potential use in render error handling?
            // req._originalNext = next; // Maybe needed if res.render error handler uses next(err)

            // --- Error Handling ---
            if (err) {
                // Ensure error handler exists before calling
                if (typeof serverInstance.errorHandler === "function") {
                    // Pass error to the registered error handler
                    return serverInstance.errorHandler(err, req, res, next);
                } else {
                    // Fallback if no valid error handler is configured
                    console.error("[Middleware Runner Error] No valid error handler configured! Error:", err);
                    try {
                        if (!res.writableEnded) {
                            res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                            res.end("Internal Server Error");
                        } else if (!res.destroyed) {
                            res.destroy();
                        }
                    } catch (_) {}
                    return;
                }
            }
            // --- End Error Handling ---

            // --- Normal Flow: Get Next Middleware ---
            const layer = serverInstance.middlewares[index++]; // Get layer and increment index

            // Check if we've run out of middleware layers
            if (!layer) {
                // Should only be reached if the chain ends without response (e.g., no 404 mw)
                console.log(`[Middleware Runner Error] Reached end of chain unexpectedly for ${req.method} ${req.originalUrl || req.url}`);
                try {
                    if (!res.writableEnded) {
                        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                        res.end("Internal Server Error: Incomplete request processing.");
                    } else if (!res.destroyed) {
                        res.destroy();
                    }
                } catch (_) {}
                return;
            }
            // --- End Normal Flow Check ---

            // --- Execute Layer ---
            try {
                const middlewarePath = layer.path;
                const handler = layer.handler;

                // Validate handler (should have been done in use(), but defensive check)
                if (typeof handler !== "function") {
                    console.log(`[Middleware Runner Error] Invalid middleware configured at index ${index - 1}.`);
                    return next(new Error(`Internal Server Error: Invalid middleware configured at index ${index - 1}.`));
                }

                // Check path scope
                if (middlewarePath === null || middlewarePath === "/") {
                    // Global or root middleware always runs
                    if (serverInstance.contentType.debug) console.log(`[Middleware Runner] Executing global/root: ${handler.name || "anonymous"} (Index: ${index - 1})`);
                    //handler(req, res, next); // Execute

                    // Trace enter
                    const traces = serverInstance._reqTraces.get(rid);
                    if (traces) traces.push({ t: performance.now(), tag: "mw:enter", name: handler.name || "anonymous", path: middlewarePath || "/" });

                    // Wrap next to trace exit
                    const tracedNext = (err) => {
                        const tnow = performance.now();
                        const tr = serverInstance._reqTraces.get(rid);
                        if (tr) tr.push({ t: tnow, tag: "mw:next", name: handler.name || "anonymous" });
                        return next(err);
                    };

                    handler(req, res, tracedNext);
                } else {
                    // Path-specific middleware - requires req.pathname
                    const requestPath = req.pathname;
                    if (typeof requestPath !== "string") {
                        // If this happens, _urlParsingMiddleware likely didn't run first or failed
                        logger.log(`[Middleware Runner Error] req.pathname not available at index ${index - 1}. Check middleware order.`);
                        return next(new Error("Internal Server Error: Request path unavailable."));
                    }

                    // Perform the path prefix check
                    if (requestPath.startsWith(middlewarePath)) {
                        if (serverInstance.contentType.debug) console.log(`[Middleware Runner] Path match for "${middlewarePath}", executing ${handler.name || "anonymous"} (Index: ${index - 1})`);
                        // Optional: Could modify req.url here for strict Express parity
                        //handler(req, res, next); // Execute matching path-specific handler

                        // Trace enter
                        const traces = serverInstance._reqTraces.get(rid);
                        if (traces) traces.push({ t: performance.now(), tag: "mw:enter", name: handler.name || "anonymous", path: middlewarePath || "/" });

                        // Wrap next to trace exit
                        const tracedNext = (err) => {
                            const tnow = performance.now();
                            const tr = serverInstance._reqTraces.get(rid);
                            if (tr) tr.push({ t: tnow, tag: "mw:next", name: handler.name || "anonymous" });
                            return next(err);
                        };

                        handler(req, res, tracedNext);
                    } else {
                        // Path doesn't match, skip to the next middleware
                        if (serverInstance.contentType.debug) console.log(`[Middleware Runner] Path miss for "${middlewarePath}" on req path "${requestPath}", skipping ${handler.name || "anonymous"} (Index: ${index - 1})`);
                        next();
                    }
                }
            } catch (error) {
                // Catch synchronous errors thrown *by* the middleware function itself
                logger.log(`[Middleware Runner Error] Sync error in middleware index ${index - 1} (${layer?.handler?.name || "anonymous"}):`, error);
                next(error); // Pass error to the error handler
            }
            // --- End Execute Layer ---
        }; // End next function definition

        // Wrap initial call to start the chain in try/catch
        try {
            next(); // Start the chain execution by calling next() for index 0
        } catch (initialError) {
            // Catch sync errors in the *very first* middleware or the initial next() call
            logger.log("[Middleware Runner Error] Error during initial next() call:", initialError);
            if (typeof serverInstance.errorHandler === "function") {
                serverInstance.errorHandler(initialError, req, res, next);
            } else {
                // Fallback if error handler fails during initial call
                logger.log("[Middleware Runner Error] No valid error handler for initial error!");
                try {
                    if (!res.writableEnded) {
                        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                        res.end("Internal Server Error");
                    } else if (!res.destroyed) {
                        res.destroy();
                    }
                } catch (_) {}
            }
        }
    }
    _runMiddlewareWithoutStaticServer(req, res) {
        const logger = this.logger || console;

        let index = 0; // Track current middleware index
        const serverInstance = this; // Capture server instance for closures

        // --- Augment res object ---
        try {
            // Check for static file handling first

            res.req = req; // Attach request for context within helpers
            res._server = this; // Attach server instance to call helpers like sendApiResponse
            // decorateRequest(req, res);
            // decorateResponse(res, req);
            requestDecorator(req, res);
            responseDecorator(res, req);

            res.status = rs.setStatusCode;
            res.set = rs.setHeader;
            res.header = rs.setHeader;
            res.send = rs.sendFlexible;
            res.json = rs.sendJson;
            res.sendStatus = rs.sendStatus;
            res.sendFile = rs.sendStaticFile;

            if (this.engines && Object.keys(this.engines).length > 0) {
                // Only add render if engines are configured
                res.render = (view, locals = {}) => {
                    this.render(view, locals, (err, html) => {
                        if (err) {
                            return this.errorHandler(err, req, res);
                        }
                        // set HTML content type and send
                        res.setHeader("Content-Type", "text/html");
                        res.end(html);
                    });
                };
            }

            //this._staticFileHandler(req, res);
        } catch (augmentError) {
            console.log("[Middleware Runner Error] Failed to augment response object:", augmentError);
            try {
                // Attempt basic error response if possible
                if (!res.writableEnded) {
                    res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                    res.end("Internal Server Error");
                } else if (!res.destroyed) {
                    res.destroy();
                }
            } catch (_) {
                /* Ignore secondary error */
            }
            return; // Stop processing if augmentation fails
        }
        // --- End Augmentation ---

        // --- Setup Final Handlers ---
        let finalHandlersExecuted = false; // Prevent double execution
        const runFinalHandlers = () => {
            if (finalHandlersExecuted) return;
            finalHandlersExecuted = true;

            // Check if the Set exists and has handlers
            if (serverInstance.finalMiddlewares && serverInstance.finalMiddlewares.size > 0) {
                if (serverInstance.contentType.debug) logger.log(`Running ${serverInstance.finalMiddlewares.size} final handlers for ${req.method} ${req.originalUrl || req.url}`);

                serverInstance.finalMiddlewares.forEach((fn) => {
                    try {
                        // Pass req and res for context
                        fn(req, res);
                    } catch (finalErr) {
                        // Cannot send response here, just log
                        console.log(`[Final Middleware Error] Error in useFinally handler for ${req.method} ${req.originalUrl || req.url}:`, finalErr);
                    }
                });
            }
        };
        // Attach listeners to run after response finishes or connection closes
        res.on("finish", runFinalHandlers);
        res.on("close", runFinalHandlers);
        // --- End Final Handler Setup ---

        // Define the 'next' function for this request cycle
        const next = (err) => {
            // Attach next to req for potential use in render error handling?
            // req._originalNext = next; // Maybe needed if res.render error handler uses next(err)

            // --- Error Handling ---
            if (err) {
                // Ensure error handler exists before calling
                if (typeof serverInstance.errorHandler === "function") {
                    // Pass error to the registered error handler
                    return serverInstance.errorHandler(err, req, res, next);
                } else {
                    // Fallback if no valid error handler is configured
                    console.error("[Middleware Runner Error] No valid error handler configured! Error:", err);
                    try {
                        if (!res.writableEnded) {
                            res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                            res.end("Internal Server Error");
                        } else if (!res.destroyed) {
                            res.destroy();
                        }
                    } catch (_) {}
                    return;
                }
            }
            // --- End Error Handling ---

            // --- Normal Flow: Get Next Middleware ---
            const layer = serverInstance.middlewares[index++]; // Get layer and increment index

            // Check if we've run out of middleware layers
            if (!layer) {
                // Should only be reached if the chain ends without response (e.g., no 404 mw)
                console.log(`[Middleware Runner Error] Reached end of chain unexpectedly for ${req.method} ${req.originalUrl || req.url}`);
                try {
                    if (!res.writableEnded) {
                        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                        res.end("Internal Server Error: Incomplete request processing.");
                    } else if (!res.destroyed) {
                        res.destroy();
                    }
                } catch (_) {}
                return;
            }
            // --- End Normal Flow Check ---

            // --- Execute Layer ---
            try {
                const middlewarePath = layer.path;
                const handler = layer.handler;

                // Validate handler (should have been done in use(), but defensive check)
                if (typeof handler !== "function") {
                    console.log(`[Middleware Runner Error] Invalid middleware configured at index ${index - 1}.`);
                    return next(new Error(`Internal Server Error: Invalid middleware configured at index ${index - 1}.`));
                }

                // Check path scope
                if (middlewarePath === null || middlewarePath === "/") {
                    // Global or root middleware always runs
                    if (serverInstance.contentType.debug) console.log(`[Middleware Runner] Executing global/root: ${handler.name || "anonymous"} (Index: ${index - 1})`);
                    handler(req, res, next); // Execute
                } else {
                    // Path-specific middleware - requires req.pathname
                    const requestPath = req.pathname;
                    if (typeof requestPath !== "string") {
                        // If this happens, _urlParsingMiddleware likely didn't run first or failed
                        logger.log(`[Middleware Runner Error] req.pathname not available at index ${index - 1}. Check middleware order.`);
                        return next(new Error("Internal Server Error: Request path unavailable."));
                    }

                    // Perform the path prefix check
                    if (requestPath.startsWith(middlewarePath)) {
                        if (serverInstance.contentType.debug) console.log(`[Middleware Runner] Path match for "${middlewarePath}", executing ${handler.name || "anonymous"} (Index: ${index - 1})`);
                        // Optional: Could modify req.url here for strict Express parity
                        handler(req, res, next); // Execute matching path-specific handler
                    } else {
                        // Path doesn't match, skip to the next middleware
                        if (serverInstance.contentType.debug) console.log(`[Middleware Runner] Path miss for "${middlewarePath}" on req path "${requestPath}", skipping ${handler.name || "anonymous"} (Index: ${index - 1})`);
                        next();
                    }
                }
            } catch (error) {
                // Catch synchronous errors thrown *by* the middleware function itself
                logger.log(`[Middleware Runner Error] Sync error in middleware index ${index - 1} (${layer?.handler?.name || "anonymous"}):`, error);
                next(error); // Pass error to the error handler
            }
            // --- End Execute Layer ---
        }; // End next function definition

        // Wrap initial call to start the chain in try/catch
        try {
            next(); // Start the chain execution by calling next() for index 0
        } catch (initialError) {
            // Catch sync errors in the *very first* middleware or the initial next() call
            logger.log("[Middleware Runner Error] Error during initial next() call:", initialError);
            if (typeof serverInstance.errorHandler === "function") {
                serverInstance.errorHandler(initialError, req, res, next);
            } else {
                // Fallback if error handler fails during initial call
                logger.log("[Middleware Runner Error] No valid error handler for initial error!");
                try {
                    if (!res.writableEnded) {
                        res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                        res.end("Internal Server Error");
                    } else if (!res.destroyed) {
                        res.destroy();
                    }
                } catch (_) {}
            }
        }
    } // End _runMiddleware

    /** ADDED: REFACTORED ERROR HANDLING MIDDLEWARE
     * The default error handling middleware.
     * It's called when 'next(err)' is invoked in the middleware chain.
     * Logs the error, emits an 'error' event, and sends a generic
     * 500 or other status code response (based on err.statusCode) if possible.
     * @param {*} err - The error passed to next(). Can be anything, typically an Error object.
     * @param {http.IncomingMessage} req - The request object.
     * @param {http.ServerResponse} res - The response object (potentially augmented).
     * @param {Function} next - The next function (rarely used in final error handlers).
     * @private
     */
    async _defaultErrorHandler(err, req, res, next) {
        // Determine status code: use err.statusCode if available and valid HTTP code,
        // handle ENOENT as 404, otherwise default to 500.
        let statusCode = 500; // Default to Internal Server Error
        if (err instanceof Error) {
            if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600) {
                statusCode = err.statusCode;
            } else if (err.code === "ENOENT") {
                // File not found errors from fs often mean 404 for the request
                statusCode = 404;
            }
            // Add more specific error code checks here if needed (e.g., EACCES -> 403)
        } else {
            // If 'err' is not an Error object, log it, but use 500 status
            console.log("[ErrorHandler] Non-Error type passed to error handler:", err);
        }

        // Determine error message
        // Use err.message if it's an Error, otherwise stringify err, default to status code message
        const message = err instanceof Error && err.message ? err.message : typeof err === "string" ? err : http.STATUS_CODES[statusCode] || "Internal Server Error";

        // Log the error server-side (especially for 5xx errors)
        if (statusCode >= 500) {
            console.log(`[ErrorHandler] ${statusCode} ${req.method} ${req.originalUrl || req.url} - Error:`, err.stack || err);
        } else if (this.contentType.debug) {
            // Log client errors only in debug mode
            console.log(`[ErrorHandler] ${statusCode} ${req.method} ${req.originalUrl || req.url} - Message: ${message}`);
        }

        // --- Emit 'error' event ---
        // Allow listeners to observe errors
        try {
            this.emit("error", { err, req, res, statusCode, message });
        } catch (emitError) {
            console.log('[ErrorHandler] Error emitting "error" event:', emitError);
        }
        // --- End Emit ---

        // Check if response headers have already been sent
        if (res.headersSent || res.writableEnded) {
            console.log(`[ErrorHandler] Cannot send error response - headers already sent or stream ended for ${req.method} ${req.originalUrl || req.url}`);
            // Cannot send a new response, just ensure connection is closed if possible
            if (!res.destroyed) {
                res.destroy();
            }
            return; // Stop processing
        }

        // Send a simple plain text error response
        // Avoid using complex helpers like sendApiResponse within the default error handler
        // itself to minimize risk of causing further errors.
        try {
            res.writeHead(statusCode, {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": Buffer.byteLength(message),
                Connection: "close", // Close connection after error
            });
            res.end(message);
        } catch (responseError) {
            // Very unlikely, but catch errors during writeHead/end
            console.log("[ErrorHandler] CRITICAL: Failed to send error response:", responseError);
            if (!res.destroyed) {
                res.destroy();
            }
        }
    } // End _defaultErrorHandler

    // === Core Middleware Implementations ===
    /** ADDED: REFACTORED RATE LIMITER MIDDLEWARE
     * Core middleware to enforce rate limiting.
     * Runs early in the middleware chain for every request.
     * Uses the configured RateLimiter instance (this.rateLimiter).
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @param {Function} next - The next middleware function.
     * @private
     */
    _rateLimiterMiddleware(req, res, next) {
        // Determine IP address.
        // Note: In production behind a reverse proxy (like Nginx, Cloudflare),
        // trust the 'X-Forwarded-For' header (or a similar header) instead.
        // This requires setting app.enable('trust proxy') or similar logic
        // if we were using Express conventions fully, or manually checking here.
        // For now, using the direct socket address.
        const ip = req.socket.remoteAddress;

        // Check the rate limiter
        if (this.rateLimiter && !this.rateLimiter.check(ip)) {
            // If check() returns false, the limit is exceeded.
            if (this.contentType.debug) {
                console.log(`[Rate Limiter] Blocking request from IP: ${ip}`);
            }
            // Send 429 Too Many Requests response
            res.writeHead(429, {
                "Content-Type": "text/plain",
                Connection: "close", // Ask client to close connection
            });
            // End the response cycle here - DO NOT CALL next()
            return res.end("Too many requests, please try again later.");
        }

        // Limit not exceeded, pass control to the next middleware
        next();
    }

    /** ADDED: REFACTORED URL PARSING MIDDLEWARE
     * Core middleware to parse the URL, extract components (pathname, query),
     * normalize the path, and detect preferred content encoding.
     * Attaches properties: pathname, requestSegments, query, preferredEncoding, originalUrl to req.
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @param {Function} next - The next middleware function.
     * @private
     */
    _urlParsingMiddleware(req, res, next) {
        try {
            // Store original URL before potential modifications elsewhere (though we don't modify req.url currently)
            req.originalUrl = req.url;

            // Use URL constructor for robust parsing. Use a dummy base for relative URLs.
            const parsedUrl = new URL(req.url, "http://dummybase");

            // Decode the pathname (e.g., %20 -> space)
            // Use try-catch here specifically for decodeURIComponent errors
            let pathname;
            try {
                pathname = decodeURIComponent(parsedUrl.pathname);
            } catch (decodeError) {
                // If decoding fails (e.g., malformed URI sequences)
                throw new Error("Bad Request: Malformed URI path"); // Throw specific error
            }

            // Normalize pathname: remove trailing slash unless it's the root '/'
            if (pathname.length > 1 && pathname.endsWith("/")) {
                pathname = pathname.slice(0, -1);
            }

            // Attach useful properties to the request object
            req.pathname = pathname;
            req.requestSegments = pathname.split("/").filter(Boolean);

            // --- Query String Parsing ---
            const queryString = parsedUrl.search ? parsedUrl.search.substring(1) : "";
            req.query = querystring.parse(queryString);
            // --- End Query String Parsing ---

            // --- Encoding Detection ---
            const acceptEncoding = req.headers["accept-encoding"] || "";
            req.preferredEncoding = null; // Default to no compression
            if (/\bbr\b/.test(acceptEncoding)) {
                // Prioritize Brotli
                req.preferredEncoding = "br";
            } else if (/\bgzip\b/.test(acceptEncoding)) {
                // Fallback to gzip
                req.preferredEncoding = "gzip";
            }
            // --- End Encoding Detection ---

            if (this.contentType.debug) {
                console.log(`[URL Parse] Path: ${req.pathname}, Query: ${JSON.stringify(req.query)}, Encoding: ${req.preferredEncoding}`);
            }

            // if (this.contentType.debug) {
            //     console.log(`https://play.google.com/store/apps/details?id=uk.videoparse.parse&hl=en Path: ${req.pathname}, Query: ${JSON.stringify(req.query)}, Encoding: ${req.preferredEncoding}`);
            // }

            next(); // Proceed to next middleware
        } catch (e) {
            // Handle errors during URL parsing or initial setup
            // console.log(`https://www.lifewire.com/what-is-parse-error-4689209 URL: ${req.url}`, e);
            console.log(`[URL Parse Error] URL: ${req.url}`, e);

            // Ensure a statusCode is set for the error handler
            const err = e instanceof Error ? e : new Error("Bad Request: Invalid URL");
            if (!err.statusCode) err.statusCode = 400;
            next(err); // Pass error to error handler
        }
    }

    /** DONE: REFACTORED
     * Asynchronous middleware to parse the incoming request body based on Content-Type.
     *
     * This middleware checks the HTTP method and Content-Type header. For methods
     * like POST, PUT, PATCH, it attempts to parse the request body.
     *
     * - If the Content-Type is 'application/x-ndjson', it uses a streaming NDJSON parser
     * (`NDJSONParser`) to handle potentially large payloads efficiently. It collects
     * parsed JSON objects from each line into an array and assigns this array to
     * `req.body`. It enforces the `maxBodySize` limit during streaming.
     * - For other supported Content-Types (intended to be handled by `_parseBody`),
     * it delegates parsing to the `this._parseBody` method, which is expected
     * to buffer the request body up to `maxBodySize` and then parse it.
     * - For HTTP methods that typically do not have bodies (e.g., GET, DELETE),
     * it skips parsing and calls `next()`.
     * - If parsing is successful, it attaches the parsed data (object, array, etc.)
     * to `req.body` and calls `next()`.
     * - If any error occurs during parsing (e.g., invalid format, size limit exceeded,
     * underlying stream error), it calls `next(error)` with an appropriate error
     * object, often including a `statusCode` property (e.g., 400, 413, 500).
     *
     * It relies on `this.maxBodySize` for payload limits and potentially `this.logger`
     * and `this.contentType.debug` for logging.
     *
     * @private
     * @async
     * @function _bodyParserMiddleware
     * @param {object} req - The incoming request object (e.g., Express request). Expected to have `method`, `headers`, and be a readable stream. `req.body` will be populated by this middleware upon successful parsing.
     * @param {object} res - The server response object (e.g., Express response). Used indirectly, for example, to check `writableEnded` status in error handling scenarios.
     * @param {function} next - The callback function to pass control to the next middleware in the chain. It should be called as `next()` on success or `next(err)` on error.
     * @returns {Promise<void>} A promise that resolves when the middleware has finished processing (i.e., when `next()` or `next(err)` is called).
     * @throws {Error} This function does not throw errors directly but passes them to the `next(err)` callback. Potential errors passed include:
     * - {Error} With `statusCode: 400` for bad requests (e.g., invalid NDJSON format).
     * - {Error} With `statusCode: 413` for payloads exceeding `this.maxBodySize`.
     * - {Error} With `statusCode: 500` for request stream errors during processing.
     * - Any errors thrown by the delegated `this._parseBody` method.
     */
    async _bodyParserMiddleware(req, res, next) {
        req.body = null; // Initialize
        this._callHooks("beforeParse", { req, res });

        const methodsWithBody = ["POST", "PUT", "PATCH"];
        const contentType = req.headers["content-type"]?.toLowerCase() || "";

        if (methodsWithBody.includes(req.method)) {
            // --- Check for NDJSON ---
            if (contentType.includes("application/x-ndjson")) {
                if (this.contentType?.debug) console.log(`[Body Parser] Detected NDJSON, using streaming parser.`);
                // Assuming NDJSONParser is imported/available
                const parser = new NDJSONParser();
                const results = []; // Array to collect parsed objects
                let receivedBytes = 0;
                const maxBodySize = this.maxBodySize; // Get limit from server instance

                // Handle parsed objects emitted by the stream
                parser.on("data", (obj) => {
                    results.push(obj);
                    // Optional: Check array size limit if needed (though primary limit is bytes)
                });

                // Handle errors from the parser (e.g., invalid JSON lines)
                parser.on("error", (err) => {
                    console.log("[Body Parser] NDJSON parsing error:", err);
                    // Ensure streams are cleaned up if they weren't already
                    if (req.readable) req.unpipe(parser);
                    if (!parser.destroyed) parser.destroy();
                    // Create a consistent error object only if response not already sent
                    if (!res.writableEnded) {
                        const parseError = new Error("Bad Request: Invalid NDJSON format");
                        parseError.statusCode = 400;
                        parseError.cause = err; // Link original error
                        next(parseError); // Pass error to main error handler
                    }
                });

                // Handle completion of parsing
                parser.on("end", () => {
                    if (!res.writableEnded) {
                        // Check if an error handler already finished the response
                        req.body = results; // Assign the array of parsed objects
                        if (this.contentType?.debug) console.log(`[Body Parser] NDJSON parsing complete. ${results.length} objects parsed.`);
                        next(); // Proceed to next middleware
                    }
                });

                // Handle request stream errors during piping (e.g., connection reset)
                req.on("error", (err) => {
                    console.log("[Body Parser] Request stream error during NDJSON parsing:", err);
                    if (!parser.destroyed) parser.destroy(); // Clean up parser
                    if (!res.writableEnded) {
                        err.statusCode = 500; // Internal server error seems appropriate for stream issues
                        next(err);
                    }
                });

                // Monitor size limit on the raw request stream *before* it hits the parser
                req.on("data", (chunk) => {
                    // Check if we are already over limit or if response ended (e.g., by previous error)
                    if (receivedBytes > maxBodySize || res.writableEnded) {
                        return; // Stop processing if already handled or response is closed
                    }
                    receivedBytes += chunk.length;
                    if (receivedBytes > maxBodySize) {
                        console.log(`[Body Parser] Payload Too Large: Received ${receivedBytes} bytes, limit is ${maxBodySize}.`);
                        req.unpipe(parser); // Stop piping more data
                        // Signal error to parser; it will emit 'error' event which is handled above
                        parser.destroy(new Error("Payload Too Large"));
                        req.destroy(); // Stop the request stream forcefully
                        // Note: We don't call next() here directly. The 'error' event on the parser
                        // or potentially req.on('error') should handle calling next(err).
                        // However, let's create the specific error here in case parser doesn't emit right away.
                        const sizeError = new Error("Payload Too Large");
                        sizeError.statusCode = 413;
                        // Explicitly pass the error if parser/req error handlers haven't already
                        if (!res.writableEnded) {
                            next(sizeError);
                        }
                    }
                });

                // Handle premature closing of the request stream
                req.on("close", () => {
                    if (!parser.writableEnded && !res.writableEnded) {
                        console.log("[Body Parser] Request stream closed prematurely during NDJSON parsing.");
                        // Depending on desired behavior, you might want to signal an error or let the partially parsed data through.
                        // Signaling error is often safer.
                        // parser.destroy(new Error('Incomplete Request')); // This would trigger the parser error handler
                    }
                });

                // Start the process: Pipe request stream into your NDJSON parser
                req.pipe(parser);
            } else {
                // --- Handle other content types using the buffering _parseBody ---
                try {
                    // Assuming _parseBody handles buffering, parsing, and size limits internally
                    req.body = await this._parseBody(req, this.maxBodySize);
                    this._callHooks("afterParse", { req, res });

                    next(); // Proceed after successful buffering/parsing
                } catch (bodyError) {
                    // Ensure statusCode is set if possible, default or based on error type
                    if (!bodyError.statusCode) {
                        // Assign appropriate status code based on error if possible (e.g., 400 for parse errors, 413 for size)
                        // Defaulting to 400 for generic parse issues if not otherwise specified
                        bodyError.statusCode = bodyError.type === "entity.too.large" ? 413 : 400;
                    }
                    console.log("[Body Parser] Error during buffered parsing:", bodyError);
                    next(bodyError); // Pass buffering/parsing errors to error handler
                }
            }
        } else {
            // No body expected for this method
            next();
        }
    }

    /** DONE: REFACTORED
     * Core middleware responsible for matching the request against defined API routes
     * (Static, Dynamic/Trie, RegExp) and executing the corresponding handler chain.
     * If no API route matches, it calls next() to allow fallbacks (like static files).
     * @param {http.IncomingMessage} req - Augmented request object (with pathname, query, etc.)
     * @param {http.ServerResponse} res - Augmented response object (with helpers like .json)
     * @param {Function} next - The next function in the main server middleware chain.
     * @private
     */
    /** DONE: REFACTORED
     * Core middleware responsible for matching the request against defined API routes
     * (Static, Radix dynamic/wildcard, legacy Trie, RegExp) and executing the handler chain.
     * If no route matches, it calls next() to allow fallbacks (like static files).
     */
    async _routerMiddleware(req, res, next) {
        const requestMethod = req.method.toUpperCase();
        if (res.writableEnded || res.destroyed) return;

        this._callHooks("beforeRoute", { req, res });

        // A hook (e.g., Asset Manifest) may have already served the asset
        if (res.writableEnded || res.destroyed || req._assetServed) return;

        // Response cache plugins may have responded in beforeRoute
        if (res.writableEnded || res.destroyed || req._cacheServed) return;

        // Properties attached by _urlParsingMiddleware
        const pathname = req.pathname;
        const requestSegments = req.requestSegments;

        let handlerChain = null; // final array of handlers if matched
        let params = {}; // extracted parameters
        let routeFound = false; // did any router match?
        let dynamicMatch = null; // legacy Trie match (if used)
        let viaRadix = false; // flag: true when RadixRouter matched
        let radixPathPattern = null; // canonical pattern returned by Radix hit (e.g., "/users/:id")

        // ----- OPTIONS handling -----
        // Try Radix first for dynamic/wildcard paths (Radix auto-materializes OPTIONS).
        if (requestMethod === "OPTIONS") {
            if (this.radix) {
                const hostHdr = (req.headers && (req.headers["x-forwarded-host"] || req.headers["host"])) || "";
                const hostOnly = String(hostHdr).split(",")[0].trim().split(":")[0];
                const ctx = {
                    host: hostOnly,
                    headers: req.headers || {},
                    contentType: (req.headers && req.headers["content-type"]) || null,
                };
                try {
                    const hit = this.radix.match("OPTIONS", pathname, ctx);
                    if (hit) {
                        // Treat like a matched route and run through the standard route execution below.
                        viaRadix = true;
                        handlerChain = hit.handler;
                        params = hit.params || {};
                        routeFound = true;
                        radixPathPattern = hit.path || pathname;
                    }
                } catch (_) {
                    // fall through to legacy OPTIONS computation
                }
            }

            // If Radix did NOT handle OPTIONS, compute legacy Allow from static/legacy-dynamic/regex and short-circuit.
            if (!routeFound) {
                const allow = new Set();

                // Static exact matches
                for (const m of http.METHODS) {
                    const mm = m.toUpperCase();
                    const map = this.staticRoutes.get(mm);
                    if (map && map.has(pathname)) allow.add(mm);
                }

                // Legacy dynamic matches (TrieNode) by trying each method
                for (const m of http.METHODS) {
                    const mm = m.toUpperCase();
                    const dyn = this._findDynamicRoute(mm, requestSegments);
                    if (dyn) allow.add(mm);
                }

                // RegExp routes
                for (const rr of this.regexRoutes) {
                    if (rr.regex && rr.regex.exec(pathname)) allow.add(rr.method);
                }

                if (allow.has("GET")) allow.add("HEAD");
                allow.add("OPTIONS");

                const list = Array.from(allow).sort().join(", ");
                res.setHeader("Allow", list);
                res.statusCode = 204;
                return res.end();
            }
        }
        // ----- end OPTIONS handling -----

        // ----- 1) Static Route Lookup (fast path) -----
        const methodMap = this.staticRoutes.get(requestMethod);
        const staticHandlerChain = methodMap ? methodMap.get(pathname) : undefined;
        if (staticHandlerChain) {
            handlerChain = staticHandlerChain;
            routeFound = true;
            if (this.contentType.debug) console.log(`[Router] Static route matched: ${requestMethod} ${pathname}`);
        }

        // ----- 2) RADIX MATCH (before legacy Trie/RegExp) -----
        if (!routeFound && this.radix) {
            const hostHdr = (req.headers && (req.headers["x-forwarded-host"] || req.headers["host"])) || "";
            const hostOnly = String(hostHdr).split(",")[0].trim().split(":")[0];

            const ctx = {
                host: hostOnly,
                headers: req.headers || {},
                contentType: (req.headers && req.headers["content-type"]) || null,
            };

            const hit = this.radix.match(requestMethod, pathname, ctx);
            if (hit) {
                viaRadix = true;
                handlerChain = hit.handler; // array of handlers
                params = hit.params || {}; // object of params (already cast if constraints/coerce were used)
                routeFound = true;
                radixPathPattern = hit.path || pathname; // canonical like "/users/:id"
                if (this.contentType.debug) console.log(`[Router] Radix route matched: ${requestMethod} ${radixPathPattern}`);
            }
        }

        // ----- 3) Legacy Dynamic (Trie) Fallback -----
        if (!routeFound) {
            //dynamicMatch = this._findDynamicRoute(requestMethod, requestSegments);
            dynamicMatch = this._findDynamicRoute(requestMethod, requestSegments, req);
            if (dynamicMatch) {
                handlerChain = dynamicMatch.handler;
                params = dynamicMatch.params;
                routeFound = true;
                if (this.contentType.debug) console.log(`[Router] Dynamic (Trie) route matched: ${requestMethod} ${pathname}`);
            }
        }

        // ----- 4) RegExp Route Fallback -----
        if (!routeFound) {
            if (this.contentType.debug && this.regexRoutes.length > 0) {
                console.log(`[Router] Checking ${this.regexRoutes.length} RegExp routes for ${requestMethod} ${pathname}.`);
            }
            for (const regexRoute of this.regexRoutes) {
                if (regexRoute.method === requestMethod) {
                    const match = regexRoute.regex.exec(pathname);
                    if (match) {
                        routeFound = true;
                        // Extract params from named groups (or numeric fallback)
                        req.params = match.groups || {};
                        if (Object.keys(req.params).length === 0 && match.length > 1) {
                            for (let i = 1; i < match.length; i++) req.params[i - 1] = match[i];
                        }
                        params = req.params;
                        handlerChain = regexRoute.handlerChain;

                        if (this.contentType.debug) console.log(`[Router] RegExp match: ${regexRoute.regex.toString()}. Params:`, req.params);
                        var regexKeyForMeta = `${requestMethod} ${regexRoute.regex.toString()}`;
                        break;
                    }
                }
            }
        }

        // ----- 5) HEAD fallback to GET chain -----
        if (!routeFound && requestMethod === "HEAD") {
            // Static GET
            const getMap = this.staticRoutes.get("GET");
            const staticGet = getMap ? getMap.get(pathname) : undefined;
            if (staticGet) {
                handlerChain = staticGet;
                routeFound = true;
            }

            // Legacy Trie GET
            let dynamicGet = null;
            if (!routeFound) {
                //dynamicGet = this._findDynamicRoute("GET", requestSegments);
                dynamicGet = this._findDynamicRoute("GET", requestSegments, req);
                if (dynamicGet) {
                    handlerChain = dynamicGet.handler;
                    params = dynamicGet.params;
                    routeFound = true;
                }
            }

            // RegExp GET
            if (!routeFound) {
                for (const rr of this.regexRoutes) {
                    if (rr.method === "GET") {
                        const match = rr.regex.exec(pathname);
                        if (match) {
                            handlerChain = rr.handlerChain;
                            params = match.groups || {};
                            if (Object.keys(params).length === 0 && match.length > 1) {
                                for (let i = 1; i < match.length; i++) params[i - 1] = match[i];
                            }
                            routeFound = true;
                            var regexKeyForMeta = `${requestMethod} ${regexRoute.regex.toString()}`;
                            break;
                        }
                    }
                }
            }
        }

        // ----- 6) Execute Handler Chain or Pass On -----
        if (routeFound && handlerChain && handlerChain.length > 0) {
            // Attach params
            req.params = params;

            // Build routeKey for meta lookup (use Radix canonical when applicable)
            let routeKey = null;
            if (handlerChain === staticHandlerChain) {
                routeKey = `${requestMethod} ${pathname}`;
            } else if (viaRadix && radixPathPattern) {
                routeKey = `${requestMethod} ${radixPathPattern}`;
            } else if (dynamicMatch && dynamicMatch.path) {
                routeKey = `${requestMethod} ${dynamicMatch.path}`;
            } else if (typeof regexKeyForMeta === "string") {
                routeKey = regexKeyForMeta;
            }

            const routeMeta = routeKey ? this._routeRegistry.get(routeKey) : null;

            // ---- Gates (guard legacy ones if Radix already enforced) ----

            // Host gating (skip if via Radix; Radix already enforced host)
            if (!viaRadix && routeMeta && routeMeta.options && routeMeta.options.host) {
                const reqHost = (req.headers && (req.headers["x-forwarded-host"] || req.headers["host"])) || "";
                const hostOnly = String(reqHost).split(",")[0].trim().split(":")[0];
                const expect = routeMeta.options.host;
                const ok = expect instanceof RegExp ? expect.test(hostOnly) : typeof expect === "function" ? expect(hostOnly) === true : String(expect).toLowerCase() === String(hostOnly).toLowerCase();
                if (!ok) return next(); // behave as not found under this host
            }

            // Param coercion (skip if via Radix; Radix constraints/coerce already applied)
            if (!viaRadix && routeMeta && routeMeta.coerce && req.params) {
                const r = routeMeta.coerce(req.params);
                if (!r.ok) {
                    const err = new Error(`Bad Request: ${r.error || "Invalid route parameters"}`);
                    err.statusCode = 400;
                    return next(err);
                }
                req.params = r.value;
            }

            // Consumes gating (skip if via Radix; Radix already enforced)
            if (!viaRadix && routeMeta && routeMeta.options && Array.isArray(routeMeta.options.consumes) && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
                const ctype = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
                const ok = routeMeta.options.consumes.some((t) => String(t).toLowerCase() === ctype);
                if (!ok) {
                    const err = new Error("Unsupported Media Type");
                    err.statusCode = 415;
                    return next(err);
                }
            }

            // Produces gating (skip if via Radix; Radix already enforced using accepts)
            if (!viaRadix && routeMeta && routeMeta.options && Array.isArray(routeMeta.options.produces)) {
                const accept = (req.headers["accept"] || "*/*").toLowerCase();
                const ok = routeMeta.options.produces.some((t) => {
                    const tt = String(t).toLowerCase();
                    return accept.includes(tt) || accept.includes("*/*");
                });
                if (!ok) {
                    const err = new Error("Not Acceptable");
                    err.statusCode = 406;
                    return next(err);
                }
            }

            // Per-route rate policy (ALWAYS apply; Radix does not know about your rate policy)
            if (routeMeta && routeMeta.options && (routeMeta.options.rateLimit || routeMeta.options.rate)) {
                const gate = this._rateGate(routeKey || pathname, req, routeMeta.options);
                if (gate.headers) for (const [k, v] of Object.entries(gate.headers)) res.setHeader(k, v);
                if (!gate.ok && !gate.shadow) {
                    if (gate.retryAfter) res.setHeader("Retry-After", String(gate.retryAfter));
                    res.statusCode = 429;
                    return res.end("Too Many Requests");
                }
            }

            // --- app.param() execution (if any) ---
            if (this.paramCallbacks && req.params && typeof req.params === "object") {
                try {
                    const routePatternForParams = viaRadix ? radixPathPattern : dynamicMatch && dynamicMatch.path ? dynamicMatch.path : null;
                    if (routePatternForParams) {
                        const paramResult = await this._runParamCallbacks(req, res, routePatternForParams);
                        if (paramResult && paramResult.skipRoute === true) {
                            // Mimic Express next('route'): skip this matched route entirely
                            return next();
                        }
                    }
                } catch (paramErr) {
                    return next(paramErr);
                }
            }

            this._callHooks("beforeHandle", { req, res, route: routeKey || pathname, params: req.params });
            // A hook (e.g., concurrency limiter) may have ended the response.
            if (res.writableEnded || res.destroyed || req._concurrencyRejected) {
                try {
                    this._callHooks("afterHandle", { req, res, route: routeKey || pathname });
                } catch (_) {}
                return;
            }

            // Emit routeMatched
            try {
                this.emit("routeMatched", {
                    req,
                    res,
                    route: routeKey || pathname,
                    params,
                });
            } catch (emitErr) {
                console.log('[Router] Error emitting "routeMatched" event:', emitErr);
            }

            // Execute this route's handler chain (supports async handlers)
            let routeIndex = 0;
            const routeNext = async (err) => {
                if (err) return next(err);

                if (res.writableEnded) {
                    if (this.contentType.debug) console.log(`[Router] Response ended by handler #${routeIndex}, stopping route chain.`);
                    this._callHooks("afterHandle", { req, res, route: routeKey || pathname });
                    return;
                }

                const current = handlerChain[routeIndex++];
                if (!current) {
                    if (!res.writableEnded && this.contentType.debug) {
                        console.log(`[Router] Route chain for ${requestMethod} ${pathname} completed without sending response.`);
                    }
                    this._callHooks("afterHandle", { req, res, route: routeKey || pathname });
                    return;
                }

                try {
                    if (this.contentType.debug) {
                        console.log(`[Router] Executing route handler #${routeIndex}: ${current.name || "anonymous"} for ${requestMethod} ${pathname}`);
                    }
                    await current(req, res, routeNext);
                } catch (handlerError) {
                    routeNext(handlerError);
                }
            };

            try {
                this._callHooks("afterRoute", { req, res, route: routeKey || pathname, found: true });
                await routeNext(); // kick off the chain
            } catch (initialError) {
                next(initialError);
            }
            // Do NOT call next() here — the route handled it (or errored to next()).
        } else {
            // No route matched — pass to next middleware (e.g., static files / 404)
            try {
                this.emit("routeNotFound", { req, res, route: pathname });
            } catch (emitErr) {
                console.log('[Router] Error emitting "routeNotFound" event:', emitErr);
            }
            if (this.contentType.debug) console.log(`[Router] No API route matched. Passing to next middleware.`);
            this._callHooks("afterRoute", { req, res, route: pathname, found: false });
            next();
        }
    }

    /** ADDED: REFACTORED
     * Core middleware to serve static files as a fallback if no API route matches.
     * Handles GET and HEAD requests. Delegates actual file sending to ContentType.serveFile.
     * @param {http.IncomingMessage} req - Augmented request object
     * @param {http.ServerResponse} res - Augmented response object
     * @param {Function} next - The next function in the main server middleware chain.
     * @private
     */
    async _staticFileMiddleware(req, res, next) {
        // Only handle GET and HEAD requests for static files
        if (req.method !== "GET" && req.method !== "HEAD") {
            // Not a method we serve static files for, pass to next middleware (likely 404)
            return next();
        }

        let filePath;
        try {
            // Use original req.url for resolving path to handle index files etc. correctly
            // resolvePath also handles security checks (directory traversal)
            filePath = this.resolvePath(req.url);

            if (this.contentType.debug) {
                console.log(`[Static Fallback] Attempting to serve static file for path: ${filePath}`);
            }

            // Delegate ALL file serving aspects (stat, 304, cache, range, compression, send)
            // to contentType.serveFile.
            // We don't pass stats; serveFile will get them if needed (cache miss).
            await this.contentType.serveFile(
                filePath,
                req,
                res,
                req.preferredEncoding, // Pass encoding preference
                this.compressionThreshold,
                this.compressibleMimeTypes
            );
            // If serveFile completes successfully, it sends the response.
            // We do not call next() here.
        } catch (error) {
            // Catch errors from resolvePath OR serveFile

            // If file not found (ENOENT), this is NOT a server error.
            // Pass control to the next middleware (usually _notFoundMiddleware)
            // WITHOUT an error object.
            if (error.code === "ENOENT") {
                if (this.contentType.debug) console.log(`[Static Fallback] File not found (ENOENT): "${error.path || filePath}". Passing to 404 handler.`);
                return next(); // <<< Call next() WITHOUT error for ENOENT
            }

            // For other errors (permissions EACCES, read errors, traversal from resolvePath, etc.),
            // pass the error object to the main error handler middleware.
            if (this.contentType.debug || error.statusCode >= 500) {
                // Log unexpected errors
                console.log(`[Static Fallback] Error serving file "${filePath}":`, error);
            }
            return next(error);
        }
    } // End _staticFileMiddleware

    /**
     * Core middleware to handle requests that did not match any API route
     * or static file. It creates a 404 error and passes it to the error handler.
     * This should be the last middleware registered in the main chain via `use()`.
     * @param {http.IncomingMessage} req - Augmented request object
     * @param {http.ServerResponse} res - Augmented response object
     * @param {Function} next - The next function (used to pass the error).
     * @private
     */
    _notFoundMiddleware(req, res, next) {
        // If we reach here, no previous middleware or route handler
        // has sent a response for this request.
        if (this.contentType.debug) {
            console.log(`[Not Found] No route or static file matched: ${req.method} ${req.pathname}`);
        }

        // Create a new Error object representing the 404 status
        const err = new Error(`Not Found: The requested resource ${req.pathname} could not be found for method ${req.method}.`);
        err.statusCode = 404; // Set standard property for error handler

        // Pass the error to the next middleware, which should be the error handler
        next(err);
    }

    /** DONE: REFACTORED
     * Central helper method to send API responses, applying security headers,
     * conditional HSTS, and compression if applicable.
     * Handlers should call this (or use res.send/res.json which delegate here).
     *
     * @param {http.IncomingMessage} req - The request object (augmented with preferredEncoding).
     * @param {http.ServerResponse} res - The response object (augmented with helpers).
     * @param {number} statusCode - The HTTP status code for the response.
     * @param {object} headers - Custom headers set by the handler (e.g., Content-Type).
     * @param {string|Buffer} [body] - The response body content.
     * @private
     */
    async sendApiResponse(req, res, statusCode, headers, body) {
        // Ensure defaults for safety
        statusCode = statusCode || 200;
        headers = headers || {};
        body = body || ""; // Default to empty string if no body

        // Ensure body is a buffer for consistent size checking and compression
        const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); // Ensure stringification
        const bodySize = bodyBuffer.length;

        // Retrieve necessary info attached earlier
        const preferredEncoding = req.preferredEncoding; // 'br', 'gzip', or null
        // Ensure Content-Type exists for compression check, default if necessary
        const contentType = headers["Content-Type"]?.toLowerCase() || headers["content-type"]?.toLowerCase() || "application/octet-stream";
        // Make sure Content-Type is reflected in the headers object if defaulted
        if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = contentType;
        }

        let actualEncoding = null; // Will be 'br' or 'gzip' if compressed

        // --- Decide whether to compress ---
        const shouldCompress =
            preferredEncoding && // Client supports br or gzip?
            bodySize > this.compressionThreshold && // Body large enough?
            this.compressibleMimeTypes.has(contentType.split(";")[0].trim()); // Check MIME type (ignore charset etc.)

        if (shouldCompress) {
            actualEncoding = preferredEncoding;
        }
        // --- End Decision ---

        try {
            let finalBody = bodyBuffer;
            // Start with base security headers
            const baseSecurityHeaders = this.contentType.getSecurityHeaders();
            // Create final headers object: Security defaults < Handler headers < Compression headers
            const finalHeaders = { ...baseSecurityHeaders, ...headers };

            // --- Conditional HSTS ---
            const isSecure = req.connection?.encrypted || req.socket?.encrypted;
            if (isSecure) {
                finalHeaders["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
            } else {
                delete finalHeaders["Strict-Transport-Security"]; // Ensure not present on HTTP
            }
            // --- End Conditional HSTS ---

            // --- Apply Compression (if decided) ---
            if (actualEncoding) {
                if (this.contentType.debug) {
                    console.log(`[API Compress] Compressing ${bodySize} bytes with ${actualEncoding} for ${contentType}`);
                }
                // Perform async compression on the buffered body
                if (actualEncoding === "br") {
                    finalBody = await brotliCompress(bodyBuffer);
                } else {
                    // gzip
                    finalBody = await gzipCompress(bodyBuffer);
                }

                // Update headers for compressed response
                finalHeaders["Content-Encoding"] = actualEncoding;
                finalHeaders["Vary"] = "Accept-Encoding";
                finalHeaders["Content-Length"] = finalBody.length; // Set length to COMPRESSED size
            } else {
                // --- Set Uncompressed Length ---
                // Set length only if not HEAD request and body has size or is explicitly empty
                if (req.method !== "HEAD") {
                    finalHeaders["Content-Length"] = bodySize;
                } else if (!finalHeaders["Content-Length"]) {
                    // Ensure 0 for HEAD if not already set (e.g. by handler)
                    finalHeaders["Content-Length"] = 0;
                }

                // Ensure compression headers are removed if not compressing
                delete finalHeaders["Content-Encoding"];
                // Keep Vary? If other things vary (like Accept), it might still be needed.
                // Let's keep Vary for now if compression *could* have happened based on Accept-Encoding.
                // Or only add Vary if actualEncoding is set? Let's only add Vary if compressing.
                // delete finalHeaders['Vary']; // Remove if not compressing
            }
            // --- End Compression Handling ---

            // --- Send the Response ---
            res.writeHead(statusCode, finalHeaders);

            // Don't send body for HEAD requests
            if (req.method === "HEAD") {
                res.end();
            } else {
                res.end(finalBody); // Send original or compressed body
            }
        } catch (error) {
            // Handle errors during compression or sending
            console.log(`[API Send Error] Failed to compress/send response for ${req.method} ${req.originalUrl || req.url}:`, error);
            // Avoid sending another error if response already started/ended
            if (!res.writableEnded && !res.destroyed) {
                // Send a generic 500 if something failed badly - use basic methods
                try {
                    res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
                    res.end("Internal Server Error while generating response.");
                } catch (_) {
                    res.destroy();
                } // Final fallback
            } else if (!res.destroyed) {
                res.destroy(); // If already started, just destroy
            }
        }
    } // End sendApiResponse

    /** DONE: REFACTORED
     * Asynchronously reads and parses the request body stream.
     * Handles application/json, application/x-www-form-urlencoded, and text/*.
     * Enforces maximum body size defined in this.maxBodySize.
     * @param {http.IncomingMessage} req - The request object.
     * @param {number} maxBodySize - The maximum allowed size in bytes.
     * @returns {Promise<object|string|Buffer|null>} - Resolves with the parsed body, raw buffer, or null.
     * @rejects {Error} - Rejects on size limit exceeded, stream errors, or parsing errors (with statusCode property).
     * @private
     */
    async _parseBody(req, maxBodySize) {
        return new Promise((resolve, reject) => {
            // Get headers (lowercase by Node)
            const contentType = req.headers["content-type"]?.toLowerCase() || "";
            const contentLengthHeader = req.headers["content-length"];
            const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;

            // 1. Check Content-Length Header against limit (quick rejection)
            if (!isNaN(contentLength) && contentLength > maxBodySize) {
                const err = new Error("Payload Too Large (Content-Length exceeds limit)");
                err.statusCode = 413; // Payload Too Large
                // Reject the promise immediately
                return reject(err);
            }

            const chunks = [];
            let receivedBytes = 0;

            // 2. Listen for Data Chunks
            req.on("data", (chunk) => {
                receivedBytes += chunk.length;
                // Check size limit during streaming (important if Content-Length is wrong/missing)
                if (receivedBytes > maxBodySize) {
                    req.destroy(); // Stop receiving data immediately
                    const err = new Error("Payload Too Large (Stream exceeded limit)");
                    err.statusCode = 413;
                    // Reject the promise; the error handler middleware will catch this
                    return reject(err);
                }
                chunks.push(chunk);
            });

            // 3. Listen for End of Stream
            req.on("end", () => {
                // Concatenate all received chunks
                const bodyBuffer = Buffer.concat(chunks);
                let parsedBody;

                try {
                    // Choose parser based on Content-Type
                    if (contentType.includes("application/json")) {
                        if (bodyBuffer.length === 0) {
                            // Handle empty body for JSON - return null or {}? Let's use null.
                            parsedBody = null;
                        } else {
                            parsedBody = JSON.parse(bodyBuffer.toString("utf8"));
                        }
                    } else if (contentType.includes("application/x-www-form-urlencoded")) {
                        parsedBody = querystring.parse(bodyBuffer.toString("utf8"));
                    } else if (contentType.startsWith("text/")) {
                        parsedBody = bodyBuffer.toString("utf8");
                    } else if (bodyBuffer.length > 0) {
                        // Unknown Content-Type but body exists, provide the raw buffer
                        parsedBody = bodyBuffer;
                        if (this.contentType.debug) console.log(`[Body Parser] Unknown Content-Type '${contentType}', providing raw buffer.`);
                    } else {
                        // No Content-Type and empty body
                        parsedBody = null;
                    }
                    // Successfully parsed or handled as buffer/null
                    resolve(parsedBody);
                } catch (parseError) {
                    // Handle JSON.parse errors or potential querystring errors
                    let err;
                    if (parseError instanceof SyntaxError && contentType.includes("application/json")) {
                        err = new Error("Bad Request: Invalid JSON format");
                        err.statusCode = 400; // Bad Request
                    } else {
                        // Unexpected parsing error
                        err = new Error("Bad Request: Could not parse body");
                        err.statusCode = 400;
                        err.cause = parseError; // Attach original error if needed
                    }
                    reject(err); // Reject promise with parsing error
                }
            });

            // 4. Listen for Underlying Stream Errors
            req.on("error", (streamError) => {
                console.log("[Request Stream Error] Error reading request body:", streamError);
                // Add statusCode for consistent error handling?
                streamError.statusCode = 500; // Indicate server-side stream issue
                reject(streamError); // Propagate underlying stream errors
            });
        });
    } // End _parseBody

    /** ADDED: REFACTORED
     * Registers one or more handler functions for a given method and path.
     * This is the core internal method called by .get(), .post(), .all(), .route().METHOD().
     * It determines the route type, binds handlers, and stores the route definition.
     *
     * @param {string} method - The uppercase HTTP method (e.g., 'GET').
     * @param {string|RegExp} path - The route path string (e.g., '/users', '/posts/:id') or a RegExp object.
     * @param {...Function} handlers - One or more handler/middleware functions provided as arguments.
     * @throws {Error} If path type is invalid, or if no handlers are provided, or if any handler is not a function.
     * @fires routeAdded
     */

    // ... inside your UltraFastServer class ...

    /**
     * Central routing with optional options object:
     * addRoute('GET','/users/:id', { name:'user.show', params:{id:'int'}, rateLimit:'300/m', consumes:['application/json'], produces:['application/json'] }, ...handlers)
     * Handlers may be functions or "Controller@method" strings (resolved via this.container).
     */

    addRoute(method, path, ...handlers) {
        if (!(path instanceof RegExp) && (typeof path !== "string" || !path.startsWith("/"))) {
            throw new Error(`Invalid path specified for route: "${path}".`);
        }
        if (handlers.length === 0) {
            throw new Error(`Route definition for ${method} ${path} requires at least one handler function.`);
        }

        // Optional options object as first element
        let routeOptions = null;
        if (handlers.length && typeof handlers[0] === "object" && handlers[0] && typeof handlers[0] !== "function" && !Array.isArray(handlers[0])) {
            routeOptions = handlers.shift();
        }

        // Map handler strings to proxy functions
        const execHandlers = handlers.map((handler) => {
            if (typeof handler === "function") return handler;
            if (typeof handler === "string") {
                return async (req, res, next) => {
                    try {
                        const container = this.container;
                        if (!container) throw new Error("Service container is not attached to the app instance.");
                        const [controllerAlias, methodName] = handler.split("@");
                        if (!controllerAlias || !methodName) throw new Error(`Invalid controller-action string format: "${handler}"`);
                        const controllerInstance = container.resolve(controllerAlias);
                        const fn = controllerInstance[methodName];
                        if (typeof fn !== "function") throw new Error(`Method "${methodName}" does not exist on controller "${controllerAlias}".`);
                        await fn.call(controllerInstance, req, res, next);
                    } catch (e) {
                        next(e);
                    }
                };
            }
            throw new Error(`Route handler must be a function or a string. Received: ${typeof handler}`);
        });

        const routeMethod = method.toUpperCase();

        // Keep your name registry for urlFor()
        if (routeOptions && routeOptions.name && !(path instanceof RegExp)) {
            this.nameRoute(routeOptions.name, routeMethod, path);
        }

        // Bind now (server 'this' context)
        const boundHandlers = execHandlers.map((h) => h.bind(this));

        // Decide if this pattern should live in Radix: anything with :param, * or **.
        const isRadixPattern = typeof path === "string" && (path.includes(":") || path.includes("*"));

        const keyFor = (p) => `${routeMethod} ${p}`;

        if (path instanceof RegExp) {
            // RegExp routes stay as-is
            this.regexRoutes.push({ method: routeMethod, regex: path, handlerChain: boundHandlers });

            // Preserve _routeRegistry; allow legacy param coercion for regex if provided
            const meta = {
                options: routeOptions || null,
                coerce: routeOptions && routeOptions.params ? this._compileParamCoercers(routeOptions.params) : null,
            };
            this._routeRegistry.set(keyFor(path), meta);
            // (No _pathMethods tracking for RegExp)
        } else if (isRadixPattern) {
            // Feed into RadixRouter
            const radixOpts = {
                name: routeOptions?.name || null,
                host: routeOptions?.host || null, // host gate enforced by Radix at match time
                coerce: true, // cast builtins when possible
                // Radix uses 'constraints' (paramName -> builtin/regex/fn); map from your 'params'
                constraints: routeOptions?.params || null,
                // Radix uses 'accepts' to gate Accept; your option is 'produces'
                accepts: Array.isArray(routeOptions?.produces) ? routeOptions.produces.slice() : routeOptions?.produces ? [routeOptions.produces] : null,
                // Radix uses 'consumes' to gate Content-Type (POST/PUT/PATCH)
                consumes: Array.isArray(routeOptions?.consumes) ? routeOptions.consumes.slice() : routeOptions?.consumes ? [routeOptions.consumes] : null,
                meta: routeOptions?.meta || null,
            };

            this.radix.add(routeMethod, path, boundHandlers, radixOpts);

            // Keep central registry so rate limiting & any other routeOptions still work.
            const meta = { options: routeOptions || null, coerce: null }; // no legacy coercion; Radix handles constraints/coercion
            this._routeRegistry.set(keyFor(path), meta);

            // Track methods for this path pattern (useful for Allow/HEAD bookkeeping if needed)
            const set = this._pathMethods.get(path) || new Set();
            set.add(routeMethod);
            this._pathMethods.set(path, set);
        } else {
            // Pure static route → keep the fast map
            let methodMap = this.staticRoutes.get(routeMethod);
            if (!methodMap) {
                methodMap = new Map();
                this.staticRoutes.set(routeMethod, methodMap);
            }
            methodMap.set(path, boundHandlers);

            // Preserve _routeRegistry; (coerce makes no difference for static, but keep parity)
            const meta = {
                options: routeOptions || null,
                coerce: routeOptions && routeOptions.params ? this._compileParamCoercers(routeOptions.params) : null,
            };
            this._routeRegistry.set(keyFor(path), meta);

            // Track allowed methods for this static pattern
            const set = this._pathMethods.get(path) || new Set();
            set.add(routeMethod);
            this._pathMethods.set(path, set);
        }

        // Pre-materialize OPTIONS only for non-Radix static paths (Radix auto-handles OPTIONS)
        if (!(path instanceof RegExp) && !isRadixPattern && routeMethod !== "OPTIONS") {
            this._ensureOptionsForPath(path);
        }

        // Keep snapshot entry
        this._routeDefs.push({
            method: routeMethod,
            path,
            handlers: execHandlers, // store original (unbound) in snapshot
            options: routeOptions || null,
        });

        this.emit("routeAdded", { method: routeMethod, path, handlerCount: handlers.length, options: routeOptions || null });
        return this;
    }

    addRouteOLD(method, path, ...handlers) {
        if (!(path instanceof RegExp) && (typeof path !== "string" || !path.startsWith("/"))) {
            throw new Error(`Invalid path specified for route: "${path}".`);
        }
        if (handlers.length === 0) {
            throw new Error(`Route definition for ${method} ${path} requires at least one handler function.`);
        }

        // Optional options object as first element
        let routeOptions = null;
        if (handlers.length && typeof handlers[0] === "object" && handlers[0] && typeof handlers[0] !== "function" && !Array.isArray(handlers[0])) {
            routeOptions = handlers.shift();
        }

        // Map handler strings to proxy functions
        const execHandlers = handlers.map((handler) => {
            if (typeof handler === "function") return handler;
            if (typeof handler === "string") {
                return async (req, res, next) => {
                    try {
                        const container = this.container;
                        if (!container) throw new Error("Service container is not attached to the app instance.");
                        const [controllerAlias, methodName] = handler.split("@");
                        if (!controllerAlias || !methodName) throw new Error(`Invalid controller-action string format: "${handler}"`);
                        const controllerInstance = container.resolve(controllerAlias);
                        const fn = controllerInstance[methodName];
                        if (typeof fn !== "function") throw new Error(`Method "${methodName}" does not exist on controller "${controllerAlias}".`);
                        await fn.call(controllerInstance, req, res, next);
                    } catch (e) {
                        next(e);
                    }
                };
            }
            throw new Error(`Route handler must be a function or a string. Received: ${typeof handler}`);
        });

        const routeMethod = method.toUpperCase();
        // Auto-register name if provided
        if (routeOptions && routeOptions.name && !(path instanceof RegExp)) {
            this.nameRoute(routeOptions.name, routeMethod, path);
        }

        const boundHandlers = execHandlers.map((h) => h.bind(this));

        // Track allowed methods for this (non-regex) path pattern
        if (!(path instanceof RegExp)) {
            const set = this._pathMethods.get(path) || new Set();
            set.add(routeMethod);
            this._pathMethods.set(path, set);
        }

        // Build metadata record
        const keyFor = (p) => `${routeMethod} ${p}`;
        const meta = { options: routeOptions || null, coerce: null };
        if (routeOptions && routeOptions.params) {
            meta.coerce = this._compileParamCoercers(routeOptions.params);
        }

        // Store the route
        if (path instanceof RegExp) {
            this.regexRoutes.push({ method: routeMethod, regex: path, handlerChain: boundHandlers });
        } else if (path.includes(":") || path.includes("*")) {
            this._addDynamicRoute(routeMethod, path, boundHandlers, routeOptions);
            this._routeRegistry.set(keyFor(path), meta);
        } else {
            // } else if (path.includes(":")) {
            //     this._addDynamicRoute(routeMethod, path, boundHandlers);
            //     this._routeRegistry.set(keyFor(path), meta);
            // } else {

            let methodMap = this.staticRoutes.get(routeMethod);
            if (!methodMap) {
                methodMap = new Map();
                this.staticRoutes.set(routeMethod, methodMap);
            }
            methodMap.set(path, boundHandlers);
            this._routeRegistry.set(keyFor(path), meta);
        }

        // Pre-register OPTIONS for this path pattern (save runtime checks)
        // if (!(path instanceof RegExp) && routeMethod !== "OPTIONS") {
        //     this._ensureOptionsForPath(path);
        // }

        if (!(path instanceof RegExp) && routeMethod !== "OPTIONS") {
            // RadixRouter auto-handles OPTIONS for dynamic patterns
            if (!path.includes(":") && !path.includes("*")) {
                this._ensureOptionsForPath(path);
            }
        }

        this._routeDefs.push({
            method: routeMethod,
            path,
            handlers: execHandlers, // original (unbound) is fine for snapshot
            options: routeOptions || null,
        });

        this.emit("routeAdded", { method: routeMethod, path, handlerCount: handlers.length, options: routeOptions || null });
        return this;
    }

    /** Compute final Allow list for a given path pattern (adds HEAD if GET, always OPTIONS). */
    _allowedMethodsForPath(pathPattern) {
        const set = this._pathMethods.get(pathPattern) || new Set();
        const allow = new Set(set);
        if (allow.has("GET")) allow.add("HEAD");
        allow.add("OPTIONS");
        return Array.from(allow).sort();
    }

    /** Ensure a single materialized OPTIONS route exists for the given path pattern. */
    _ensureOptionsForPath(pathPattern) {
        if (!this.autoOptionsMaterialize) return;
        if (pathPattern instanceof RegExp) return; // not supported for regex
        if (typeof pathPattern !== "string") return;
        if (this._optionsMaterialized.has(pathPattern)) return; // already created

        // If user already defined an explicit OPTIONS route for this path, skip.
        const existingSet = this._pathMethods.get(pathPattern);
        if (existingSet && existingSet.has("OPTIONS")) {
            this._optionsMaterialized.add(pathPattern);
            return;
        }

        const handler = (req, res) => {
            const list = this._allowedMethodsForPath(pathPattern).join(", ");
            res.setHeader("Allow", list);
            res.statusCode = 204;
            // 204 doesn't need a body; set length explicitly for clarity.
            try {
                res.setHeader("Content-Length", 0);
            } catch (_) {}
            res.end();
        };

        // Register OPTIONS for the same path pattern (static vs dynamic)
        if (pathPattern.includes(":")) {
            // Dynamic route → use trie
            this._addDynamicRoute("OPTIONS", pathPattern, [handler.bind(this)]);
        } else {
            // Static path → store in static map
            let optMap = this.staticRoutes.get("OPTIONS");
            if (!optMap) {
                optMap = new Map();
                this.staticRoutes.set("OPTIONS", optMap);
            }
            optMap.set(pathPattern, [handler.bind(this)]);
        }

        // Mark and update method set for this pattern
        const mset = this._pathMethods.get(pathPattern) || new Set();
        mset.add("OPTIONS");
        this._pathMethods.set(pathPattern, mset);
        this._optionsMaterialized.add(pathPattern);
    }

    /** Runtime toggle (optional): enable/disable materialization. */
    setAutoOptionsMaterialize(enabled = true) {
        this.autoOptionsMaterialize = !!enabled;
        return this;
    }

    /** Retroactively materialize OPTIONS for all known paths. */
    materializeAllOptions() {
        for (const pathPattern of this._pathMethods.keys()) {
            this._ensureOptionsForPath(pathPattern);
        }
        return this;
    }

    /**  ADDED => REFACTORED
     * Private helper method to find a dynamic route handler chain by traversing the Trie.
     * It matches path segments against static children and parameter children,
     * extracting parameter values along the way.
     * Prioritizes static segment matches over parameter matches at each node.
     *
     * @param {string} method - The uppercase HTTP method (e.g., 'GET').
     * @param {string[]} segments - The request path split into segments (e.g., ['users', '123', 'profile']).
     * @returns {{ handler: Function[], params: object } | null} - An object containing the
     * matched bound handler array and extracted parameters object, or null if no matching
     * route is found for the given method and path structure.
     * @private
     */

    /** Match a dynamic route via RadixRouter */

    _findDynamicRoute(method, segments, req) {
        // Reconstitute path from segments – our URL parser already decoded safely.
        const path = "/" + segments.join("/");

        const hostHdr = (req && ((req.headers && (req.headers["x-forwarded-host"] || req.headers["host"])) || "")) || "";
        const hostOnly = hostHdr ? hostHdr.split(",")[0].trim().split(":")[0] : null;

        const ctx = {
            host: hostOnly,
            headers: (req && req.headers) || {},
            contentType: (req && req.headers && req.headers["content-type"]) || null,
        };

        // Use the same Radix instance the app registers routes on
        const router = this.radix || this.dynamicRouter;
        if (!router || typeof router.match !== "function") return null;

        const hit = router.match(method, path, ctx);
        if (!hit) return null;

        // Shape to match what the rest of the server expects
        return { handler: hit.handler, params: hit.params || {}, path: hit.path, meta: hit.meta || null };
    }

    /** Build a param coercer from route options (e.g., { id:'int', when:/regex/ } ) */
    _compileParamCoercers(spec) {
        if (!spec || typeof spec !== "object") return null;
        const intRe = /^-?\d+$/;
        const floatRe = /^-?\d+(?:\.\d+)?$/;
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const coerce = {};
        for (const [k, v] of Object.entries(spec)) {
            if (v === "int") coerce[k] = (s) => (intRe.test(s) ? [true, parseInt(s, 10)] : [false]);
            else if (v === "float" || v === "number") coerce[k] = (s) => (floatRe.test(s) ? [true, parseFloat(s)] : [false]);
            else if (v === "uuid") coerce[k] = (s) => [uuidRe.test(s), s];
            else if (v === "date")
                coerce[k] = (s) => {
                    const t = Date.parse(s);
                    return [!Number.isNaN(t), new Date(t)];
                };
            else if (v instanceof RegExp) coerce[k] = (s) => [v.test(s), s];
            else if (typeof v === "function")
                coerce[k] = (s) => {
                    try {
                        const out = v(s);
                        return [out !== false && out != null, out];
                    } catch {
                        return [false];
                    }
                };
            else if (typeof v === "string" && v.startsWith("regex:")) {
                try {
                    const re = new RegExp(v.slice(6));
                    coerce[k] = (s) => [re.test(s), s];
                } catch {}
            }
        }
        return (params) => {
            const next = Object.create(null);
            for (const [k, fn] of Object.entries(coerce)) {
                const raw = params[k];
                const [ok, val] = fn(String(raw));
                if (!ok) return { ok: false, error: `Invalid param "${k}"` };
                next[k] = val;
            }
            for (const [k, v] of Object.entries(params)) if (!(k in next)) next[k] = v;
            return { ok: true, value: next };
        };
    }

    /** Execute registered app.param() callbacks for matched route parameters.
     * Returns { ok:true } or { skipRoute:true } when next('route') is invoked.
     */
    async _runParamCallbacks(req, res, routePattern) {
        const map = this.paramCallbacks;
        const params = req.params || {};
        if (!map || map.size === 0 || !params || Object.keys(params).length === 0) {
            return { ok: true };
        }

        const names = this._extractParamNamesFromPattern(routePattern, params);
        for (const name of names) {
            const cbs = map.get(name);
            if (!cbs) continue;
            const value = params[name];
            const list = Array.isArray(cbs) ? cbs : [cbs];
            for (const fn of list) {
                const r = await this._invokeParamCallback(fn, req, res, value, name);
                if (r === "route") {
                    return { skipRoute: true }; // Express-style next('route')
                }
            }
        }
        return { ok: true };
    }

    /** Internal: call a param resolver with optional timeout and promise support. */
    _invokeParamCallback(fn, req, res, value, name) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const clear = () => {
                if (timer) {
                    try {
                        clearTimeout(timer);
                    } catch (_) {}
                    timer = null;
                }
            };

            if (this.paramTimeoutMs && this.paramTimeoutMs > 0) {
                timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    const err = new Error(`Param "${name}" resolver timed out`);
                    err.statusCode = 503;
                    clear();
                    reject(err);
                }, this.paramTimeoutMs);
                if (typeof timer.unref === "function") timer.unref();
            }

            const next = (err) => {
                if (settled) return;
                settled = true;
                clear();
                if (err === "route") return resolve("route");
                if (err) return reject(err);
                resolve();
            };

            try {
                const p = fn(req, res, next, value, name);
                if (p && typeof p.then === "function") {
                    p.then(() => next()).catch(next);
                }
            } catch (e) {
                next(e);
            }
        });
    }

    /** Determine parameter order from the route pattern; fallback to Object.keys(params). */
    _extractParamNamesFromPattern(pattern, params) {
        const out = [];
        if (typeof pattern === "string") {
            const re = /:([A-Za-z_]\w*)\??/g;
            let m;
            while ((m = re.exec(pattern))) {
                const k = m[1];
                if (!out.includes(k)) out.push(k);
            }
        }
        for (const k of Object.keys(params || {})) {
            if (!out.includes(k)) out.push(k);
        }
        return out;
    }

    /** Token-bucket per-route rate gate. Supports:
     * options.rateLimit or options.rate → '300/m', '100/s', '1000/h', '500/d'
     * options.burst (number), options.cost(req) (number), options.key(req) | 'header:X-Id' | 'ip'
     * options.shadow (dry-run), options.headers (emit RateLimit-* headers)
     */
    _rateGate(routeKey, req, options = {}) {
        const policy = options.rateLimit || options.rate;
        if (!policy) return { ok: true };

        const cfg = typeof policy === "string" ? { rate: policy } : policy;
        const rateStr = String(cfg.rate || "60/m").trim();
        const m = rateStr.match(/^(\d+)\s*\/\s*([smhd])$/i);
        if (!m) return { ok: true }; // unrecognized policy => do not block
        const limit = parseInt(m[1], 10);
        const unit = m[2].toLowerCase();
        const periodMs = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
        const burst = typeof cfg.burst === "number" ? cfg.burst : limit;
        const costFn = typeof cfg.cost === "function" ? cfg.cost : () => 1;

        // identity key
        let id;
        if (typeof cfg.key === "function") {
            id = String(cfg.key(req) ?? "");
        } else if (cfg.key && String(cfg.key).toLowerCase().startsWith("header:")) {
            const hn = String(cfg.key).slice(7).toLowerCase();
            id = String((req.headers && req.headers[hn]) || "");
        } else if (cfg.key === "ip") {
            let ip = req.socket && req.socket.remoteAddress;
            if (this.trustProxy) {
                const xff = req.headers && req.headers["x-forwarded-for"];
                if (xff) ip = xff.split(",")[0].trim();
            }
            id = ip || "unknown";
        } else {
            // default: ip
            let ip = req.socket && req.socket.remoteAddress;
            if (this.trustProxy) {
                const xff = req.headers && req.headers["x-forwarded-for"];
                if (xff) ip = xff.split(",")[0].trim();
            }
            id = ip || "unknown";
        }

        const key = `${routeKey}::${id}`;
        const now = Date.now();
        const cost = Math.max(1, Number(costFn(req)) || 1);

        let bucket = this._routeRateStore.get(key);
        if (!bucket) {
            bucket = { tokens: burst, last: now };
            this._routeRateStore.set(key, bucket);
        } else {
            const elapsed = now - bucket.last;
            const refill = (elapsed / periodMs) * limit;
            bucket.tokens = Math.min(burst, bucket.tokens + refill);
            bucket.last = now;
        }

        const allowed = bucket.tokens >= cost;
        if (allowed && !cfg.shadow) {
            bucket.tokens -= cost;
        }

        const headers = {};
        if (cfg.headers) {
            headers["RateLimit-Limit"] = String(limit);
            headers["RateLimit-Remaining"] = String(Math.max(0, Math.floor(bucket.tokens)));
            headers["RateLimit-Policy"] = `${limit};w=${Math.floor(periodMs / 1000)}`;
        }
        let retryAfter = undefined;
        if (!allowed) {
            const needed = cost - bucket.tokens;
            const sec = Math.ceil((needed / limit) * (periodMs / 1000));
            retryAfter = sec > 0 ? sec : 1;
        }
        return { ok: allowed || cfg.shadow === true, shadow: !!cfg.shadow, retryAfter, headers };
    }

    /** ADDE: REFACTORED
     * Inserts a dynamic route handler chain into the Trie structure.
     * This is called internally by addRoute for paths containing parameters like ':id'.
     * @param {string} method - The uppercase HTTP method (e.g., 'GET').
     * @param {string} path - The route path string containing parameters (e.g., '/users/:id/posts').
     * @param {Function[]} boundHandlers - The pre-bound array of handler functions for this route.
     * @private
     * @throws {Error} If a routing conflict is detected (e.g., defining two different
     * parameter names at the same path level like /users/:id and /users/:name).
     * @throws {Error} If an invalid parameter name (e.g., ':') is used.
     */

    /** Insert a dynamic route into the RadixRouter */
    _addDynamicRoute(method, path, boundHandlers, routeOptions = null) {
        const opts = {};
        if (routeOptions) {
            if (routeOptions.name) opts.name = routeOptions.name;
            if (routeOptions.host) opts.host = routeOptions.host;
            // Map UltraFastServer route options → RadixRouter meta
            if (routeOptions.params) opts.constraints = routeOptions.params; // { id:'int', ... }
            if (routeOptions.produces) opts.accepts = Array.isArray(routeOptions.produces) ? routeOptions.produces : [routeOptions.produces];
            if (routeOptions.consumes) opts.consumes = Array.isArray(routeOptions.consumes) ? routeOptions.consumes : [routeOptions.consumes];
            if (routeOptions.coerce != null) opts.coerce = !!routeOptions.coerce; // cast built-ins on match
            if (routeOptions.meta) opts.meta = routeOptions.meta; // carry any custom metadata
        }
        this.dynamicRouter.add(method, path, boundHandlers, opts);
    }

    _addDynamicRouteOLD(method, path, boundHandlers) {
        // Use the server's logger instance
        if (this.contentType.debug) {
            console.log(`[Dynamic Route Add] Start: ${method} ${path}`);
        }

        // Split path into segments, removing empty strings
        const segments = path.split("/").filter(Boolean);
        let currentNode = this.dynamicRootNode; // Start traversal from root

        // Iterate through each segment to build/traverse the Trie
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];

            if (segment.startsWith(":")) {
                // --- Parameter Segment ---
                const paramName = segment.substring(1);
                if (!paramName) {
                    // Handle case like "/:" which is invalid
                    throw new Error(`Invalid parameter name in path "${path}" at segment "${segment}"`);
                }

                if (currentNode.paramChild === null) {
                    // No parameter child exists yet, create it
                    const newNode = new TrieNode();
                    currentNode.paramChild = newNode;
                    currentNode.paramName = paramName; // Store the name
                    currentNode = newNode; // Move to the new parameter node
                    if (this.contentType.debug) console.log(`[Dynamic Route Add]   Created param node :${paramName}`);
                } else {
                    // Parameter child already exists. Check if names conflict.
                    if (currentNode.paramName !== paramName) {
                        throw new Error(`Routing conflict: Cannot define parameter ":${paramName}" at path "${path}". ` + `A different parameter ":${currentNode.paramName}" already exists at this level.`);
                    }
                    // Names match, just move to the existing parameter child node
                    currentNode = currentNode.paramChild;
                    if (this.contentType.debug) console.log(`[Dynamic Route Add]   Matched existing param node :${paramName}`);
                }
            } else {
                // --- Static Segment ---
                let childNode = currentNode.children.get(segment);
                if (!childNode) {
                    // Create new static node
                    childNode = new TrieNode();
                    currentNode.children.set(segment, childNode);
                    if (this.contentType.debug) console.log(`[Dynamic Route Add]   Created static node '${segment}'`);
                } else {
                    if (this.contentType.debug) console.log(`[Dynamic Route Add]   Matched existing static node '${segment}'`);
                }
                // Move to static child node
                currentNode = childNode;
            }
        } // End loop through segments

        // --- Add Handler Chain to Terminal Node ---
        // 'currentNode' is the node representing the end of this path.
        if (currentNode.handlers.has(method)) {
            // Overwriting existing handlers for the same method/path
            console.log(`[Route Warning] Overwriting handler chain for dynamic route: ${method} ${path}`);
        }
        // Store the already-bound handler array directly
        currentNode.handlers.set(method, boundHandlers);

        // Persist canonical route pattern on terminal node for reverse lookup / meta
        currentNode.fullPath = path;

        if (this.contentType.debug) {
            console.log(`[Dynamic Route Added] ${method} ${path} (${boundHandlers.length} handlers) - Chain attached.`);
        }
    } // End _addDynamicRoute

    /** ADDED: REFACTORED
     * Resolves a request URL path to a secure, absolute filesystem path
     * within the configured content directory. Handles index files and
     * prevents directory traversal.
     * @param {string} requestUrl - The raw URL from the request (req.url).
     * @returns {string} The absolute filesystem path.
     * @throws {Error} If the URL is malformed, or a directory traversal attempt is detected.
     * @private
     */
    resolvePath(requestUrl) {
        try {
            // Use URL constructor for robust parsing. Use dummy base for relative paths.
            const parsedUrl = new URL(requestUrl, "http://dummybase");
            let pathname = parsedUrl.pathname;

            // Decode URI components like %20 -> space, %C3%A9 -> é etc.
            // Catch potential URIErrors from malformed sequences during decode.
            try {
                pathname = decodeURIComponent(pathname);
            } catch (uriError) {
                console.log(`[Resolve Path] Malformed URI encountered: ${requestUrl}`);
                throw new Error("Malformed URI"); // Throw specific error type
            }

            // Default to index.html for root path requests (common convention)
            // Assumes this.contentType.indexFile = 'index.html' or similar, or hardcode
            const indexFile = "index.html"; // Make configurable?
            if (pathname === "/" || pathname === "") {
                pathname = `/${indexFile}`;
            }

            // Prevent directory traversal:
            // 1. Join the DECODED pathname with the base content directory.
            // 2. Normalize the resulting path (collapses '..', '.', '//').
            // 3. Ensure the final normalized path STILL starts with the base content directory.

            // Ensure contentDir is absolute (should be done in constructor)
            const absoluteContentDir = this.contentDir;

            // Create potential path - IMPORTANT: Use the decoded/cleaned pathname
            const potentialPath = path.join(absoluteContentDir, pathname);

            // Normalize the path
            const requestedPath = path.normalize(potentialPath);

            // SECURITY CHECK: Does the normalized path still start with the content directory?
            // Add path.sep to ensure '/base/dir' doesn't allow '/base/directory'.
            // Also allow the base directory itself.
            if (!requestedPath.startsWith(absoluteContentDir + path.sep) && requestedPath !== absoluteContentDir) {
                console.log(`[Security] Directory traversal attempt blocked: URL="${requestUrl}", Resolved="${requestedPath}", Base="${absoluteContentDir}"`);
                throw new Error("Directory traversal attempt detected");
            }

            // Path is considered safe and resolved
            if (this.contentType.debug) {
                console.log(`[Resolve Path] Resolved "${requestUrl}" to "${requestedPath}"`);
            }
            // Add this log right before returning:
            // console.log("[Resolve Path DEBUG] Final calculated path:", requestedPath);
            if (this.contentType.debug) {
                console.log("[Resolve Path] Final calculated path:", requestedPath);
            }

            return requestedPath;
        } catch (e) {
            // Handle potential errors during URL parsing itself if not URIError caught above
            if (e instanceof TypeError && e.message.includes("Invalid URL")) {
                console.log(`[Resolve Path] Invalid URL format: ${requestUrl}`);
                throw new Error("ERR_INVALID_URL"); // Specific error
            }
            // Re-throw other errors (like the ones we threw deliberately)
            throw e;
        }
    } // End resolvePath

    logTraversalAttempt(url, resolvedPath) {
        // Optional: Implement logging for security events
        console.warn(`[Security] Potential directory traversal attempt: URL="${url}", Resolved="${resolvedPath}"`);
    }

    /**
     * Attach an existing server or create one (optionally http2) and bind request handler.
     * opts: { http2: 'off'|'on'|'auto', trustProxy?: boolean }
     */
    attach(server, opts = {}) {
        this.trustProxy = opts.trustProxy === true ? true : this.trustProxy;
        this.http2 = opts.http2 || this.http2 || "off";

        if (server) {
            this.server = server;
            this.server.on("request", this._runMiddleware.bind(this));
        } else {
            const policy = String(this.http2 || "off");
            if (policy !== "off" && http2 && typeof http2.createServer === "function") {
                this.server = http2.createServer({}, (req, res) => this._runMiddleware(req, res));
            } else {
                const serverOptions = {
                    keepAliveTimeout: this.keepAliveTimeout || 5000,
                    maxHeadersCount: this.maxHeadersCount || 2000,
                };
                this.server = http.createServer(serverOptions, this._runMiddleware.bind(this));
            }
        }

        if (typeof this.server.setTimeout === "function" && this.timeout) {
            this.server.setTimeout(this.timeout);
        }

        if (typeof this.server.on === "function") {
            this.server.on("upgrade", (req, socket, head) => {
                this._callHooks("onUpgrade", { req, socket, head });
                // integrate RawWebsocket outside if needed
            });
        }

        return this;
    }

    /**
     * Gracefully stop accepting and wait for in-flight requests.
     * Usage: await app.drain({ timeoutMs: 10000 })
     */
    /**
     * Gracefully stop accepting and wait for in-flight requests, then close idle sockets.
     * Usage: await app.drain({ timeoutMs: 10000 })
     */
    async drain({ timeoutMs = 10000 } = {}) {
        if (!this.server) return this;
        if (this._draining) return this; // idempotent
        this._draining = true;

        // Stop accepting new connections (existing keep-alives remain)
        try {
            this.server.close();
        } catch {}

        const endAt = Date.now() + timeoutMs;

        // Wait until in-flight completes or timeout
        const hasSet = this._inFlight && typeof this._inFlight.size === "number";
        while ((hasSet ? this._inFlight.size : this._inFlight | 0) > 0 && Date.now() < endAt) {
            await new Promise((r) => {
                const t = setTimeout(r, 50);
                if (t && typeof t.unref === "function") t.unref();
            });
        }

        // Best-effort close of any lingering sockets (idle keep-alives)
        if (this._sockets && this._sockets.size) {
            for (const s of this._sockets) {
                try {
                    s.end();
                } catch {}
            }
            await new Promise((r) => setImmediate(r));
            for (const s of this._sockets) {
                try {
                    s.destroy();
                } catch {}
            }
        }

        this._draining = false;
        return this;
    }

    snapshot() {
        return {
            routes: this._routeDefs.slice().map((r) => ({
                method: r.method,
                path: r.path,
                handlers: r.handlers,
                options: r.options || null,
            })),
            middlewares: this.middlewares.slice(),
            settings: Array.from(this.settings.entries()),
        };
    }

    restore(snap) {
        if (!snap) return this;

        // reset route stores
        this.staticRoutes = new Map();
        this.regexRoutes = [];
        this._routeRegistry.clear();
        this._namedRoutes.clear();
        this._pathMethods.clear();
        this._routeDefs = [];

        // rebuild Radix router
        this.radix = new RadixRouter({
            caseSensitive: false,
            autoHead: true,
            autoOptions: true,
            strictTrailingSlash: false,
        });
        this.dynamicRouter = this.radix; // alias

        // restore settings/middleware
        if (Array.isArray(snap.settings)) this.settings = new Map(snap.settings);
        if (Array.isArray(snap.middlewares)) this.middlewares = snap.middlewares.slice();

        // restore routes
        if (Array.isArray(snap.routes)) {
            for (const r of snap.routes) {
                this.addRoute(r.method, r.path, ...(r.options ? [r.options] : []), ...r.handlers);
            }
        }
        return this;
    }

    start() {
        if (this.settings.has("cluster") && this.settings.get("cluster") === true) {
        } else {
            const beginListening = () => {
                this.server.listen(this.port, () => {
                    console.log(`🚀 Server running on port ${this.port}`);
                    console.log(`📁 Serving content from ${this.contentDir}`);
                });

                if (this.io && typeof this.io.handleUpgrade === "function") {
                    this.server.on("upgrade", (request, socket, head) => {
                        this.io.handleUpgrade(request, socket, head);
                    });
                }
                process.on("SIGTERM", () => this.stop());
                process.on("SIGINT", () => this.stop());
            };

            try {
                // Run init hooks first if any (non-blocking for callers)
                if (this.initHooks && this.initHooks.size > 0) {
                    Promise.resolve(this.onInit())
                        .then(beginListening)
                        .catch((err) => {
                            console.log("[Start] onInit error:", err);
                            beginListening(); // still start the server
                        });
                } else {
                    beginListening();
                }
            } catch (e) {
                console.log("[Start] Unexpected error scheduling onInit:", e);
                beginListening();
            }
        }
    }

    stop(callback) {
        // Accept optional callback
        console.log(`[Server Instance ${process.pid}] Stopping server listening on port ${this.port}...`);

        // Check if server is actually listening before trying to close
        if (this.server.listening) {
            this.server.close((err) => {
                if (err) {
                    console.error(`[Server Instance ${process.pid}] Error closing server:`, err);
                } else {
                    console.log(`[Server Instance ${process.pid}] Server closed successfully.`);
                }
                // Execute callback AFTER server is closed
                if (typeof callback === "function") {
                    callback(err);
                }
            });
        } else {
            console.log(`[Server Instance ${process.pid}] Server was not listening, nothing to close.`);
            if (typeof callback === "function") {
                // Call callback immediately if nothing to close
                callback();
            }
        }
        // REMOVE process.exit() from here - let the cluster/worker logic handle exiting.
    }

    getMetrics() {
        const snap = {
            http_requests_total: this._metrics.http_requests_total,
            http_errors_total: this._metrics.http_errors_total,
            http_timeouts_total: this._metrics.http_timeouts_total,
            http_in_flight: this._metrics.http_in_flight,
            http_body_bytes_in_total: this._metrics.http_body_bytes_in_total,
            http_body_bytes_out_total: this._metrics.http_body_bytes_out_total,
        };

        // basic percentiles from sampled durations
        const d = this._metrics.durations_ms.slice().sort((a, b) => a - b);
        const pct = (p) => (d.length ? d[Math.min(d.length - 1, Math.floor((p / 100) * d.length))] : 0);
        snap.http_request_duration_ms = { p50: pct(50), p95: pct(95), p99: pct(99) };

        // Merge ContentType metrics if available
        try {
            const ct = this.contentType?.getMetrics?.();
            if (ct && typeof ct === "object") Object.assign(snap, { contentType: ct });
        } catch (_) {}

        return snap;
    }

    /** Access the AsyncLocalStorage store for the current request (if any). */
    getRequestStore() {
        return this._als ? this._als.getStore() : undefined;
    }
    /** Convenience: current request id (when called within a request context). */
    getRequestId() {
        const s = this.getRequestStore();
        return s && (s.requestId || s.id);
    }
    /** Explain a request by id (timings/traces gathered during processing). */
    explain(requestId) {
        const traces = this._reqTraces.get(requestId);
        if (!traces) return null;
        const start = traces[0]?.t || 0;
        const timeline = traces.map((x) => Object.assign({}, x, { dt_ms: Math.max(0, x.t - start) }));
        return { id: requestId, timeline };
    }
    /** Cooperative yield: let the event loop breathe without blocking. */
    cooperate(minDelayMs = 0) {
        return new Promise((resolve) => {
            if (minDelayMs > 0) {
                const t = setTimeout(resolve, minDelayMs);
                if (t && typeof t.unref === "function") t.unref();
            } else {
                setImmediate(resolve);
            }
        });
    }
}

// ---- metrics bridge (optional, zero-dep; no-ops if registry absent) ----
function getMetricsRegistry(app) {
    // Try common places; stay conservative and zero-dep
    return (app && (app.metrics || app.metricsRegistry || app.registry)) || undefined;
}
function metricsInc(reg, name, labels, value = 1) {
    try {
        if (reg && typeof reg.inc === "function") reg.inc(name, labels, value);
    } catch {}
}
function metricsObserve(reg, name, labels, value) {
    try {
        if (reg && typeof reg.observe === "function") reg.observe(name, labels, value);
    } catch {}
}

// Install app.sse() / router.sse() sugar on UltraFastServer prototypes
function installSSEOnApp(UltraFastServer) {
    const define = (Proto) => {
        if (!Proto || typeof Proto.get !== "function" || Proto.sse) return;

        /**
         * app.sse(path, handler, options)
         * app.sse(path, options, handler)
         * Handler signatures supported:
         *   (req, res, sse)  // recommended
         *   (sse, req, res)  // alternative
         * If the handler returns an AsyncIterable, it will be streamed via res.sseFrom().
         */
        Proto.sse = function sse(path, a, b) {
            let options, handler;
            if (typeof a === "function") {
                handler = a;
                options = {};
            } else {
                options = a || {};
                handler = b;
            }
            if (typeof handler !== "function") throw new TypeError("app.sse(path, handler[, options]) requires a handler function");

            const wrapper = (req, res, next) => {
                try {
                    const ctrl = res.sse(options);
                    let ret;
                    try {
                        // Prefer (req, res, sse); fallback to (sse, req, res)
                        if (handler.length >= 3) ret = handler(req, res, ctrl);
                        else ret = handler(ctrl, req, res);
                    } catch (e) {
                        if (next) return next(e);
                        return res.sseClose();
                    }

                    // If handler returns a promise, observe its resolution
                    if (ret && typeof ret.then === "function") {
                        ret.then((out) => {
                            if (out && typeof out[Symbol.asyncIterator] === "function") {
                                return res.sseFrom(out, options);
                            }
                        }).catch((err) => {
                            if (next) return next(err);
                            res.sseClose();
                        });
                        return;
                    }

                    // If handler returns an AsyncIterable, stream it
                    if (ret && typeof ret[Symbol.asyncIterator] === "function") {
                        res.sseFrom(ret, options).catch((err) => {
                            if (next) return next(err);
                            res.sseClose();
                        });
                        return;
                    }
                } catch (err) {
                    if (next) return next(err);
                    res.sseClose();
                }
            };

            // Register as GET route
            return this.get(path, wrapper);
        };
    };

    // Patch main app
    define(UltraFastServer && UltraFastServer.prototype);
    // Patch embedded Router, if present
    if (UltraFastServer && UltraFastServer.Router && UltraFastServer.Router.prototype) {
        define(UltraFastServer.Router.prototype);
    }
}

// Install at module load (safe if called multiple times)
installSSEOnApp(UltraFastServer);

// Install app.sseJson() / router.sseJson() sugar on UltraFastServer prototypes
function installSSEJsonOnApp(UltraFastServer) {
    const define = (Proto) => {
        if (!Proto || typeof Proto.get !== "function" || Proto.sseJson) return;

        /**
         * app.sseJson(path, sourceFactory, options)
         * app.sseJson(path, options, sourceFactory)
         *
         * - sourceFactory signatures supported:
         *   (req, res, sse) => AsyncIterable | Iterable | Promise<AsyncIterable|Iterable>
         *   If it returns an Iterable, it will be wrapped as AsyncIterable.
         *
         * - options:
         *   { event?: string | (obj, i, ctx) => string,
         *     idFn?: (obj, i, ctx) => string|number,
         *     map?: (obj, i, ctx) => any,        // transform before send
         *     retry?: number,
         *     keepAliveMs?: number,               // default inherited by res.sse()
         *     headers?: object                    // extra response headers
         *   }
         *
         * Metrics (if registry present on app: app.metrics | metricsRegistry | registry):
         *   - sse_events_total{route,tenant,event}
         *   - sse_bytes_out_total{route,tenant}
         *   - sse_write_us{route,tenant}
         *   - sse_stream_us{route,tenant}
         *   - sse_errors_total{route,tenant,code}
         */
        Proto.sseJson = function sseJson(path, a, b) {
            let options, sourceFactory;
            if (typeof a === "function") {
                sourceFactory = a;
                options = {};
            } else {
                options = a || {};
                sourceFactory = b;
            }
            if (typeof sourceFactory !== "function") {
                throw new TypeError("app.sseJson(path, sourceFactory[, options]) requires a function");
            }

            const wrapper = async (req, res, next) => {
                // Labels for observability
                const routeLbl = (req.route && (req.route.path || req.route)) || req.originalUrl || req.url;
                const tenantLbl = (req.headers && (req.headers["x-tenant-id"] || req.headers["x-tenant"] || req.headers["x-tenantid"])) || undefined;

                const labels = { route: routeLbl, tenant: tenantLbl };
                const registry = getMetricsRegistry(this);

                // Start SSE (headers + keep-alives handled inside)
                const sseCtrl = res.sse({
                    retry: options.retry,
                    keepAliveMs: options.keepAliveMs,
                    headers: options.headers,
                });

                let it;
                try {
                    const src = await Promise.resolve(sourceFactory(req, res, sseCtrl));
                    if (!src) return; // handler took over manually

                    if (src && typeof src[Symbol.asyncIterator] === "function") {
                        it = src[Symbol.asyncIterator]();
                    } else if (src && typeof src[Symbol.iterator] === "function") {
                        // Wrap sync iterable as async
                        it = (async function* () {
                            for (const v of src) yield v;
                        })();
                    } else {
                        // Nothing to stream; just return
                        return;
                    }

                    const tStart = process.hrtime.bigint();
                    let idx = 0;
                    let bytesOut = 0;
                    const baseEventOpt = options.event;

                    while (true) {
                        // Check connection
                        if (res.writableEnded || res.destroyed) break;

                        const { value, done } = await it.next();
                        if (done) break;

                        const ctx = { index: idx, route: routeLbl, tenant: tenantLbl, req, res };
                        const data = typeof options.map === "function" ? options.map(value, idx, ctx) : value;
                        const id = typeof options.idFn === "function" ? options.idFn(data, idx, ctx) : undefined;
                        const ev = typeof baseEventOpt === "function" ? baseEventOpt(data, idx, ctx) : baseEventOpt;

                        const frame = NDJSONWriter.sseFrame(data, Object.assign({ retry: options.retry }, ev ? { event: ev } : {}, id != null ? { id } : {}));

                        const t0 = process.hrtime.bigint();
                        const ok = res.write(frame);
                        const t1 = process.hrtime.bigint();

                        bytesOut += frame.length;
                        metricsObserve(registry, "sse_write_us", labels, Number(t1 - t0) / 1000);
                        metricsInc(registry, "sse_events_total", Object.assign({ event: ev || "message" }, labels), 1);

                        if (!ok) await once(res, "drain");

                        idx++;
                    }

                    const tEnd = process.hrtime.bigint();
                    metricsInc(registry, "sse_bytes_out_total", labels, bytesOut);
                    metricsObserve(registry, "sse_stream_us", labels, Number(tEnd - tStart) / 1000);
                } catch (err) {
                    metricsInc(registry, "sse_errors_total", Object.assign({ code: (err && (err.code || err.name)) || "ERR" }, labels), 1);
                    if (next) return next(err);
                    try {
                        sseCtrl.close();
                    } catch {}
                }
            };

            // Register as GET route
            return this.get(path, wrapper);
        };
    };

    // Patch main app
    define(UltraFastServer && UltraFastServer.prototype);
    // Patch embedded Router, if present
    if (UltraFastServer && UltraFastServer.Router && UltraFastServer.Router.prototype) {
        define(UltraFastServer.Router.prototype);
    }
}

// Install at module load (safe to call multiple times)
installSSEJsonOnApp(UltraFastServer);

// Install app.sseText() / router.sseText() sugar on UltraFastServer prototypes
function installSSETextOnApp(UltraFastServer) {
    const define = (Proto) => {
        if (!Proto || typeof Proto.get !== "function" || Proto.sseText) return;

        /**
         * app.sseText(path, sourceFactory, options)
         * app.sseText(path, options, sourceFactory)
         *
         * - sourceFactory signatures:
         *   (req, res, sse) => AsyncIterable<string|any> | Iterable<string|any> | Promise<...>
         *
         * - options:
         *   { event?: string | (val, i, ctx) => string,
         *     idFn?: (val, i, ctx) => string|number,
         *     map?: (val, i, ctx) => string, // coerces with String() if not provided
         *     retry?: number,
         *     keepAliveMs?: number,
         *     headers?: object
         *   }
         *
         * Metrics (if registry present on app: app.metrics|metricsRegistry|registry):
         *   - sse_events_total{route,tenant,event}
         *   - sse_bytes_out_total{route,tenant}
         *   - sse_write_us{route,tenant}
         *   - sse_stream_us{route,tenant}
         *   - sse_errors_total{route,tenant,code}
         */
        Proto.sseText = function sseText(path, a, b) {
            let options, sourceFactory;
            if (typeof a === "function") {
                sourceFactory = a;
                options = {};
            } else {
                options = a || {};
                sourceFactory = b;
            }
            if (typeof sourceFactory !== "function") {
                throw new TypeError("app.sseText(path, sourceFactory[, options]) requires a function");
            }

            const wrapper = async (req, res, next) => {
                const routeLbl = (req.route && (req.route.path || req.route)) || req.originalUrl || req.url;
                const tenantLbl = (req.headers && (req.headers["x-tenant-id"] || req.headers["x-tenant"] || req.headers["x-tenantid"])) || undefined;

                const labels = { route: routeLbl, tenant: tenantLbl };
                const registry = getMetricsRegistry(this);

                // Start SSE and send headers (uses existing res.sse controller)
                const sseCtrl = res.sse({
                    retry: options.retry,
                    keepAliveMs: options.keepAliveMs,
                    headers: options.headers,
                });

                let it;
                try {
                    const src = await Promise.resolve(sourceFactory(req, res, sseCtrl));
                    if (!src) return;

                    if (src && typeof src[Symbol.asyncIterator] === "function") {
                        it = src[Symbol.asyncIterator]();
                    } else if (src && typeof src[Symbol.iterator] === "function") {
                        it = (async function* () {
                            for (const v of src) yield v;
                        })();
                    } else {
                        return;
                    }

                    const tStart = process.hrtime.bigint();
                    let idx = 0;
                    let bytesOut = 0;
                    const baseEventOpt = options.event;

                    while (true) {
                        if (res.writableEnded || res.destroyed) break;
                        const { value, done } = await it.next();
                        if (done) break;

                        const ctx = { index: idx, route: routeLbl, tenant: tenantLbl, req, res };
                        const mapped = typeof options.map === "function" ? options.map(value, idx, ctx) : value;
                        const str = mapped == null ? "" : String(mapped);
                        const id = typeof options.idFn === "function" ? options.idFn(str, idx, ctx) : undefined;
                        const ev = typeof baseEventOpt === "function" ? baseEventOpt(str, idx, ctx) : baseEventOpt;

                        const frame = NDJSONWriter.sseFrame(str, Object.assign({ retry: options.retry }, ev ? { event: ev } : {}, id != null ? { id } : {}));

                        const t0 = process.hrtime.bigint();
                        const ok = res.write(frame);
                        const t1 = process.hrtime.bigint();

                        bytesOut += frame.length;
                        metricsObserve(registry, "sse_write_us", labels, Number(t1 - t0) / 1000);
                        metricsInc(registry, "sse_events_total", Object.assign({ event: ev || "message" }, labels), 1);

                        if (!ok) await once(res, "drain");
                        idx++;
                    }

                    const tEnd = process.hrtime.bigint();
                    metricsInc(registry, "sse_bytes_out_total", labels, bytesOut);
                    metricsObserve(registry, "sse_stream_us", labels, Number(tEnd - tStart) / 1000);
                } catch (err) {
                    metricsInc(registry, "sse_errors_total", Object.assign({ code: (err && (err.code || err.name)) || "ERR" }, labels), 1);
                    if (next) return next(err);
                    try {
                        sseCtrl.close();
                    } catch {}
                }
            };

            return this.get(path, wrapper);
        };
    };

    define(UltraFastServer && UltraFastServer.prototype);
    if (UltraFastServer && UltraFastServer.Router && UltraFastServer.Router.prototype) {
        define(UltraFastServer.Router.prototype);
    }
}

// Install at module load (safe to call multiple times)
installSSETextOnApp(UltraFastServer);

// Install app.sseNDJSON() / router.sseNDJSON() sugar (JSON Text Sequences, RFC 7464)
function installSSENDJSONOnApp(UltraFastServer) {
    const define = (Proto) => {
        if (!Proto || typeof Proto.get !== "function" || Proto.sseNDJSON) return;

        /**
         * app.sseNDJSON(path, sourceFactory, options)
         * app.sseNDJSON(path, options, sourceFactory)
         *
         * Streams frames of: RS (0x1E) + JSON + LF ("\n")
         * Content-Type: application/json-seq; charset=utf-8
         *
         * - sourceFactory:
         *   (req, res) => AsyncIterable<any> | Iterable<any> | Promise<...>
         *
         * - options:
         *   { map?: (obj, i, ctx) => any,   // transform before JSON.stringify
         *     headers?: object               // extra response headers (merged)
         *     // NOTE: keepAliveMs intentionally ignored to remain spec-compliant
         *   }
         *
         * Metrics:
         *   - jsonseq_frames_total{route,tenant}
         *   - jsonseq_bytes_out_total{route,tenant}
         *   - jsonseq_write_us{route,tenant}
         *   - jsonseq_stream_us{route,tenant}
         *   - jsonseq_errors_total{route,tenant,code}
         */
        Proto.sseNDJSON = function sseNDJSON(path, a, b) {
            let options, sourceFactory;
            if (typeof a === "function") {
                sourceFactory = a;
                options = {};
            } else {
                options = a || {};
                sourceFactory = b;
            }
            if (typeof sourceFactory !== "function") {
                throw new TypeError("app.sseNDJSON(path, sourceFactory[, options]) requires a function");
            }

            const wrapper = async (req, res, next) => {
                const routeLbl = (req.route && (req.route.path || req.route)) || req.originalUrl || req.url;
                const tenantLbl = (req.headers && (req.headers["x-tenant-id"] || req.headers["x-tenant"] || req.headers["x-tenantid"])) || undefined;

                const labels = { route: routeLbl, tenant: tenantLbl };
                const registry = getMetricsRegistry(this);

                // JSON Text Sequences headers
                if (!res.headersSent) {
                    res.setHeader("Content-Type", "application/json-seq; charset=utf-8");
                    res.setHeader("Cache-Control", "no-cache, no-transform");
                    res.setHeader("Connection", "keep-alive");
                    res.setHeader("X-Accel-Buffering", "no");
                    if (options.headers && typeof options.headers === "object") {
                        for (const k of Object.keys(options.headers)) res.setHeader(k, options.headers[k]);
                    }
                }
                if (typeof res.flushHeaders === "function") res.flushHeaders();

                let it;
                try {
                    const src = await Promise.resolve(sourceFactory(req, res));
                    if (!src) return;

                    if (src && typeof src[Symbol.asyncIterator] === "function") {
                        it = src[Symbol.asyncIterator]();
                    } else if (src && typeof src[Symbol.iterator] === "function") {
                        it = (async function* () {
                            for (const v of src) yield v;
                        })();
                    } else {
                        return;
                    }

                    const writer = new NDJSONWriter({ delimiter: NDJSONParser.RS });
                    const tStart = process.hrtime.bigint();
                    let idx = 0;
                    let bytesOut = 0;

                    while (true) {
                        if (res.writableEnded || res.destroyed) break;
                        const { value, done } = await it.next();
                        if (done) break;

                        const ctx = { index: idx, route: routeLbl, tenant: tenantLbl, req, res };
                        const obj = typeof options.map === "function" ? options.map(value, idx, ctx) : value;

                        const frame = writer.write(obj); // RS + JSON + LF

                        const t0 = process.hrtime.bigint();
                        const ok = res.write(frame);
                        const t1 = process.hrtime.bigint();

                        bytesOut += frame.length;
                        metricsObserve(registry, "jsonseq_write_us", labels, Number(t1 - t0) / 1000);
                        metricsInc(registry, "jsonseq_frames_total", labels, 1);

                        if (!ok) await once(res, "drain");
                        idx++;
                    }

                    const tEnd = process.hrtime.bigint();
                    metricsInc(registry, "jsonseq_bytes_out_total", labels, bytesOut);
                    metricsObserve(registry, "jsonseq_stream_us", labels, Number(tEnd - tStart) / 1000);
                } catch (err) {
                    metricsInc(registry, "jsonseq_errors_total", Object.assign({ code: (err && (err.code || err.name)) || "ERR" }, labels), 1);
                    if (next) return next(err);
                    try {
                        res.end();
                    } catch {}
                }
            };

            return this.get(path, wrapper);
        };
    };

    define(UltraFastServer && UltraFastServer.prototype);
    if (UltraFastServer && UltraFastServer.Router && UltraFastServer.Router.prototype) {
        define(UltraFastServer.Router.prototype);
    }
}

// Install at module load (safe to call multiple times)
installSSENDJSONOnApp(UltraFastServer);

// Install app.sseNDJSONKeepAlive() / router.sseNDJSONKeepAlive()
// Streams JSON Text Sequences (RS + JSON + LF) and injects periodic valid JSON keep-alive frames.
// NOTE: Requires NDJSONWriter (already imported above) and `once` from 'events'.
function installSSENDJSONKeepAliveOnApp(UltraFastServer) {
    const define = (Proto) => {
        if (!Proto || typeof Proto.get !== "function" || Proto.sseNDJSONKeepAlive) return;

        /**
         * app.sseNDJSONKeepAlive(path, sourceFactory, options)
         * app.sseNDJSONKeepAlive(path, options, sourceFactory)
         *
         * Streams frames of: RS (0x1E) + JSON + LF ("\n") with periodic keep-alive JSON frames.
         * Content-Type: application/json-seq; charset=utf-8
         *
         * sourceFactory:
         *   (req, res) => AsyncIterable<any> | Iterable<any> | Promise<...>
         *
         * options:
         *   {
         *     map?: (obj, i, ctx) => any,                 // transform prior to JSON.stringify
         *     headers?: object,                           // extra response headers
         *     keepAliveMs?: number,                       // default 15000 (15s); if <=0, disabled
         *     keepAlivePayload?: object | (i, ctx) => any // default { __ka: true }
         *   }
         *
         * Metrics (if registry present on app: app.metrics|metricsRegistry|registry):
         *   - jsonseq_frames_total{route,tenant}
         *   - jsonseq_bytes_out_total{route,tenant}
         *   - jsonseq_write_us{route,tenant}
         *   - jsonseq_stream_us{route,tenant}
         *   - jsonseq_keepalive_total{route,tenant}
         *   - jsonseq_keepalive_bytes_total{route,tenant}
         *   - jsonseq_errors_total{route,tenant,code}
         */
        Proto.sseNDJSONKeepAlive = function sseNDJSONKeepAlive(path, a, b) {
            let options, sourceFactory;
            if (typeof a === "function") {
                sourceFactory = a;
                options = {};
            } else {
                options = a || {};
                sourceFactory = b;
            }
            if (typeof sourceFactory !== "function") {
                throw new TypeError("app.sseNDJSONKeepAlive(path, sourceFactory[, options]) requires a function");
            }

            const wrapper = async (req, res, next) => {
                const routeLbl = (req.route && (req.route.path || req.route)) || req.originalUrl || req.url;
                const tenantLbl = (req.headers && (req.headers["x-tenant-id"] || req.headers["x-tenant"] || req.headers["x-tenantid"])) || undefined;

                const labels = { route: routeLbl, tenant: tenantLbl };
                const registry = getMetricsRegistry(this);

                // JSON Text Sequences headers
                if (!res.headersSent) {
                    res.setHeader("Content-Type", "application/json-seq; charset=utf-8");
                    res.setHeader("Cache-Control", "no-cache, no-transform");
                    res.setHeader("Connection", "keep-alive");
                    res.setHeader("X-Accel-Buffering", "no");
                    if (options.headers && typeof options.headers === "object") {
                        for (const k of Object.keys(options.headers)) res.setHeader(k, options.headers[k]);
                    }
                }
                if (typeof res.flushHeaders === "function") res.flushHeaders();

                let it;
                try {
                    const src = await Promise.resolve(sourceFactory(req, res));
                    if (!src) return;

                    if (src && typeof src[Symbol.asyncIterator] === "function") {
                        it = src[Symbol.asyncIterator]();
                    } else if (src && typeof src[Symbol.iterator] === "function") {
                        it = (async function* () {
                            for (const v of src) yield v;
                        })();
                    } else {
                        return;
                    }

                    const writer = new NDJSONWriter({ delimiter: NDJSONParser.RS });
                    const tStart = process.hrtime.bigint();
                    let idx = 0;
                    let bytesOut = 0;
                    let kaBytesOut = 0;

                    let closed = false;
                    res.on("close", () => {
                        closed = true;
                    });
                    res.on("finish", () => {
                        closed = true;
                    });

                    const keepAliveMs = Number(options.keepAliveMs == null ? 15000 : options.keepAliveMs);
                    const kaPayloadFn = typeof options.keepAlivePayload === "function" ? options.keepAlivePayload : () => (options.keepAlivePayload != null ? options.keepAlivePayload : { __ka: true });

                    // keep-alive loop (valid JSON frames)
                    async function keepAliveLoop() {
                        if (!keepAliveMs || keepAliveMs <= 0) return;
                        while (!closed && !res.writableEnded && !res.destroyed) {
                            // non-blocking sleep with unref
                            await new Promise((r) => {
                                const t = setTimeout(r, keepAliveMs);
                                if (t && typeof t.unref === "function") t.unref();
                            });
                            if (closed || res.writableEnded || res.destroyed) break;

                            const payload = kaPayloadFn(idx, { route: routeLbl, tenant: tenantLbl, req, res });
                            const frame = writer.write(payload); // RS + JSON + LF
                            const t0 = process.hrtime.bigint();
                            const ok = res.write(frame);
                            const t1 = process.hrtime.bigint();

                            kaBytesOut += frame.length;
                            metricsObserve(registry, "jsonseq_write_us", labels, Number(t1 - t0) / 1000);
                            metricsInc(registry, "jsonseq_keepalive_total", labels, 1);

                            if (!ok) await once(res, "drain");
                        }
                    }

                    const kaTask = keepAliveLoop();

                    try {
                        while (!closed) {
                            if (res.writableEnded || res.destroyed) break;
                            const { value, done } = await it.next();
                            if (done) break;

                            const ctx = { index: idx, route: routeLbl, tenant: tenantLbl, req, res };
                            const obj = typeof options.map === "function" ? options.map(value, idx, ctx) : value;

                            const frame = writer.write(obj); // RS + JSON + LF
                            const t0 = process.hrtime.bigint();
                            const ok = res.write(frame);
                            const t1 = process.hrtime.bigint();

                            bytesOut += frame.length;
                            metricsObserve(registry, "jsonseq_write_us", labels, Number(t1 - t0) / 1000);
                            metricsInc(registry, "jsonseq_frames_total", labels, 1);

                            if (!ok) await once(res, "drain");
                            idx++;
                        }
                    } finally {
                        closed = true;
                        await kaTask;
                    }

                    const tEnd = process.hrtime.bigint();
                    metricsInc(registry, "jsonseq_bytes_out_total", labels, bytesOut);
                    if (kaBytesOut) metricsInc(registry, "jsonseq_keepalive_bytes_total", labels, kaBytesOut);
                    metricsObserve(registry, "jsonseq_stream_us", labels, Number(tEnd - tStart) / 1000);
                    if (!res.writableEnded) {
                        try {
                            res.end();
                        } catch {}
                    }
                } catch (err) {
                    metricsInc(registry, "jsonseq_errors_total", Object.assign({ code: (err && (err.code || err.name)) || "ERR" }, labels), 1);
                    if (next) return next(err);
                    try {
                        res.end();
                    } catch {}
                }
            };

            return this.get(path, wrapper);
        };
    };

    define(UltraFastServer && UltraFastServer.prototype);
    if (UltraFastServer && UltraFastServer.Router && UltraFastServer.Router.prototype) {
        define(UltraFastServer.Router.prototype);
    }
}

// Install at module load (safe to call multiple times)
installSSENDJSONKeepAliveOnApp(UltraFastServer);

UltraFastServer.SSEWriter = NDJSONWriter;

/** Static Asset Manifest + precompressed variant hinting (zero-dep). */
function createAssetManifestPluginOLD(opts = {}) {
    const cfg = Object.assign(
        {
            roots: null, // default: app.contentDir
            preload: true, // build at startup via onInit()
            shortCircuit404: true, // fast 404 when manifest says "missing"
            prefer: "auto", // 'auto' | 'br' | 'gzip' | 'identity'
            indexNames: ["index.html"], // used by app.resolvePath already
            immutablePattern: /\.[0-9a-f]{8,}\./i, // foo.3d1b9a2c.js => immutable
            cacheControlImmutable: "public, max-age=31536000, immutable",
            cacheControlDefault: "public, max-age=0",
            exposeRoute: null, // e.g. '/_assets' to inspect the manifest
            verbose: false,
        },
        opts || {}
    );

    const manifest = new Map(); // key '/path' -> { abs, size, mtimeMs, etag, type, variants:{ br|gzip:{...} } }
    const byAbs = new Map();
    let built = false;
    let building = null;

    const scanDir = async (rootDir) => {
        const out = [];
        const stack = [rootDir];
        while (stack.length) {
            const dir = stack.pop();
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const ent of entries) {
                const abs = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    stack.push(abs);
                    continue;
                }
                if (ent.isFile()) out.push(abs);
            }
        }
        return out;
    };

    const toRoute = (abs, base) => "/" + path.relative(base, abs).split(path.sep).join("/");

    async function build(app) {
        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

        const files = await scanDir(base);

        // identity files
        for (const abs of files) {
            const name = path.basename(abs);
            if (name.endsWith(".br") || name.endsWith(".gz")) continue;
            let st;
            try {
                st = await fsp.stat(abs);
            } catch {
                continue;
            }
            if (!st.isFile()) continue;

            const key = toRoute(abs, base);
            const ext = path.extname(name).toLowerCase();
            const type = (mimeTypes && mimeTypes[ext]) || "application/octet-stream";
            const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
            const entry = { key, abs, size: st.size, mtimeMs: st.mtimeMs, etag, type, variants: {} };
            manifest.set(key, entry);
            byAbs.set(abs, entry);
        }

        // attach precompressed variants
        for (const abs of files) {
            const name = path.basename(abs);
            if (!(name.endsWith(".br") || name.endsWith(".gz"))) continue;
            const baseAbs = abs.replace(/\.br$|\.gz$/, "");
            const entry = byAbs.get(baseAbs);
            if (!entry) continue;
            let st;
            try {
                st = await fsp.stat(abs);
            } catch {
                continue;
            }
            const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
            const kind = name.endsWith(".br") ? "br" : "gzip";
            entry.variants[kind] = { abs, size: st.size, mtimeMs: st.mtimeMs, etag, encoding: kind };
        }

        built = true;
        return manifest;
    }

    async function ensure(app) {
        if (built) return manifest;
        if (building) return building;
        building = build(app).finally(() => {
            building = null;
        });
        return building;
    }

    const aeIncludes = (req, token) =>
        String((req.headers && req.headers["accept-encoding"]) || "")
            .toLowerCase()
            .includes(token);
    const shouldImmutable = (urlPath) => cfg.immutablePattern && cfg.immutablePattern.test(urlPath);

    const maybeQuick404 = (req, res, key) => {
        if (!built) return false;
        if (!cfg.shortCircuit404) return false;
        if (manifest.has(key)) return false;

        res.statusCode = 404;
        try {
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } catch (_) {}
        res.end("Not Found");
        return true;
    };

    const serveVariant = async (app, req, res, baseEntry, variant) => {
        // If-None-Match
        const inm = req.headers && req.headers["if-none-match"];
        if (inm && variant.etag) {
            const tags = inm.split(",").map((s) => s.trim());
            if (tags.includes(variant.etag)) {
                const h = {
                    ETag: variant.etag,
                    "Content-Type": baseEntry.type,
                    "Content-Encoding": variant.encoding,
                    Vary: "Accept-Encoding",
                    "Last-Modified": new Date(variant.mtimeMs).toUTCString(),
                };
                if (shouldImmutable(baseEntry.key)) h["Cache-Control"] = cfg.cacheControlImmutable;
                else h["Cache-Control"] = cfg.cacheControlDefault;
                res.writeHead(304, h);
                res.end();
                return true;
            }
        }

        // If Range requested, let identity path handle it (range-aware)
        if (req.headers && req.headers["range"]) return false;

        const headers = {
            "Content-Type": baseEntry.type,
            "Content-Encoding": variant.encoding,
            Vary: "Accept-Encoding",
            ETag: variant.etag,
            "Last-Modified": new Date(variant.mtimeMs).toUTCString(),
            "Content-Length": variant.size,
        };
        if (shouldImmutable(baseEntry.key)) headers["Cache-Control"] = cfg.cacheControlImmutable;
        else headers["Cache-Control"] = cfg.cacheControlDefault;

        try {
            res.writeHead(200, headers);
            if (req.method === "HEAD") {
                res.end();
                return true;
            }
            const pipelineAsync = promisify(stream.pipeline);
            await pipelineAsync(fs.createReadStream(variant.abs), res);
            return true;
        } catch (_) {
            try {
                if (!res.writableEnded) res.end();
            } catch (_) {}
            return true; // treat as served; client may have closed
        }
    };

    return {
        name: "assetManifest",
        apply(app) {
            if (cfg.preload) {
                app.onInit(async () => {
                    try {
                        await ensure(app);
                    } catch (e) {
                        if (cfg.verbose) console.log("[AssetManifest] preload error:", e);
                    }
                });
            }

            app.assetManifestSnapshot = () => {
                const out = {};
                for (const [k, v] of manifest) {
                    out[k] = { size: v.size, mtimeMs: v.mtimeMs, type: v.type, variants: Object.keys(v.variants) };
                }
                return out;
            };
            app.refreshAssetManifest = async () => {
                built = false;
                manifest.clear();
                byAbs.clear();
                return ensure(app);
            };

            if (cfg.exposeRoute && typeof app.get === "function") {
                app.get(cfg.exposeRoute, (req, res) => res.json(app.assetManifestSnapshot()));
            }

            app.hooks({
                // Serve known static assets *before* routing & the fallback static middleware
                beforeRoute: async ({ req, res }) => {
                    try {
                        if (req.method !== "GET" && req.method !== "HEAD") return;

                        await ensure(app);

                        // Resolve safely (guards traversal + applies index.html default)
                        let abs;
                        try {
                            abs = app.resolvePath(req.url);
                        } catch {
                            return;
                        }

                        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

                        const rel = path.relative(base, abs);
                        const key = "/" + rel.split(path.sep).join("/");

                        // Fast 404 for known misses
                        if (maybeQuick404(req, res, key)) {
                            req._assetServed = true;
                            return;
                        }

                        const entry = manifest.get(key);
                        if (!entry) return; // let _routerMiddleware / _staticFileMiddleware work

                        // Prefer precompressed variant if available and accepted
                        let usedVariant = null;
                        if (cfg.prefer === "br" || cfg.prefer === "auto") {
                            if (entry.variants.br && aeIncludes(req, "br")) usedVariant = entry.variants.br;
                        }
                        if (!usedVariant && (cfg.prefer === "gzip" || cfg.prefer === "auto")) {
                            if (entry.variants.gzip && aeIncludes(req, "gzip")) usedVariant = entry.variants.gzip;
                        }

                        if (usedVariant) {
                            const ok = await serveVariant(app, req, res, entry, usedVariant);
                            if (ok) {
                                req._assetServed = true;
                                return;
                            }
                            // Not OK → probably Range; fall through to identity
                        }

                        // Identity: delegate to ContentType (range, etag, compression-if-needed)
                        if (res.writableEnded || res.destroyed) return;
                        if (shouldImmutable(entry.key)) {
                            try {
                                res.setHeader("Cache-Control", cfg.cacheControlImmutable);
                            } catch (_) {}
                        } else {
                            try {
                                res.setHeader("Cache-Control", cfg.cacheControlDefault);
                            } catch (_) {}
                        }

                        await app.contentType.serveFile(entry.abs, req, res, req.preferredEncoding, app.compressionThreshold, app.compressibleMimeTypes);
                        req._assetServed = true;
                    } catch (e) {
                        if (cfg.verbose) console.log("[AssetManifest] beforeRoute error:", e);
                    }
                },
            });
        },
    };
}

/** Static Asset Manifest + precompressed variant hinting + optional watcher + Link:preload (zero-dep). */
function createAssetManifestPlugin(opts = {}) {
    const cfg = Object.assign(
        {
            roots: null, // default: app.contentDir
            preload: true, // build at startup via onInit()
            shortCircuit404: true, // fast 404 when manifest says "missing"
            prefer: "auto", // 'auto' | 'br' | 'gzip' | 'identity'
            indexNames: ["index.html"],
            immutablePattern: /\.[0-9a-f]{8,}\./i,
            cacheControlImmutable: "public, max-age=31536000, immutable",
            cacheControlDefault: "public, max-age=0",
            exposeRoute: null, // e.g. '/_assets'
            verbose: false,

            // NEW: auto-refresh manifest on FS changes
            watch: false, // false | true | { debounceMs?:number, ignore?:RegExp }
            // NEW: Link: rel=preload header injection
            preloadLinks: {
                // 'off' | 'auto' | { mode:'auto'|'rules', rules?:Record<string,string[]>, max?:number, crossorigin?:boolean }
                mode: "off",
                rules: null,
                max: 6,
                crossorigin: false,
            },
        },
        opts || {}
    );

    // --- Normalize linker/watch configs ---
    const watchCfg = cfg.watch && typeof cfg.watch === "object" ? cfg.watch : cfg.watch === true ? {} : null;
    const debounceMs = watchCfg ? Number(watchCfg.debounceMs || 250) : 250;
    const ignoreRe = watchCfg && watchCfg.ignore instanceof RegExp ? watchCfg.ignore : null;

    const linkCfg =
        cfg.preloadLinks && typeof cfg.preloadLinks === "object"
            ? Object.assign({ mode: "off", rules: null, max: 6, crossorigin: false }, cfg.preloadLinks)
            : typeof cfg.preloadLinks === "string"
            ? { mode: cfg.preloadLinks }
            : { mode: "off" };
    linkCfg.max = Number(linkCfg.max || 6);
    linkCfg.crossorigin = !!linkCfg.crossorigin;

    // --- Manifest state ---
    const manifest = new Map(); // key '/path' -> { abs, size, mtimeMs, etag, type, variants:{ br|gzip:{...} } }
    const byAbs = new Map();
    let built = false;
    let building = null;

    // --- Helpers: scanning ---
    const scanDir = async (rootDir) => {
        const out = [];
        const stack = [rootDir];
        while (stack.length) {
            const dir = stack.pop();
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const ent of entries) {
                const abs = path.join(dir, ent.name);
                if (ignoreRe && ignoreRe.test(abs)) continue;
                if (ent.isDirectory()) {
                    stack.push(abs);
                    continue;
                }
                if (ent.isFile()) out.push(abs);
            }
        }
        return out;
    };
    const toRoute = (abs, base) => "/" + path.relative(base, abs).split(path.sep).join("/");

    // --- Build manifest ---
    async function build(app) {
        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

        const files = await scanDir(base);
        manifest.clear();
        byAbs.clear();

        // identity files
        for (const abs of files) {
            const name = path.basename(abs);
            if (name.endsWith(".br") || name.endsWith(".gz")) continue;
            let st;
            try {
                st = await fsp.stat(abs);
            } catch {
                continue;
            }
            if (!st.isFile()) continue;

            const key = toRoute(abs, base);
            const ext = path.extname(name).toLowerCase();
            const type = (mimeTypes && mimeTypes[ext]) || "application/octet-stream";
            const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
            const entry = { key, abs, size: st.size, mtimeMs: st.mtimeMs, etag, type, variants: {} };
            manifest.set(key, entry);
            byAbs.set(abs, entry);
        }

        // precompressed variants
        for (const abs of files) {
            const name = path.basename(abs);
            if (!(name.endsWith(".br") || name.endsWith(".gz"))) continue;
            const baseAbs = abs.replace(/\.br$|\.gz$/, "");
            const entry = byAbs.get(baseAbs);
            if (!entry) continue;
            let st;
            try {
                st = await fsp.stat(abs);
            } catch {
                continue;
            }
            const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
            const kind = name.endsWith(".br") ? "br" : "gzip";
            entry.variants[kind] = { abs, size: st.size, mtimeMs: st.mtimeMs, etag, encoding: kind };
        }

        built = true;
        return manifest;
    }

    async function ensure(app) {
        if (built) return manifest;
        if (building) return building;
        building = build(app).finally(() => {
            building = null;
        });
        return building;
    }

    // --- Linker: figure preload targets for an HTML key or path ---
    const aeIncludes = (req, token) =>
        String((req.headers && req.headers["accept-encoding"]) || "")
            .toLowerCase()
            .includes(token);
    const shouldImmutable = (urlPath) => cfg.immutablePattern && cfg.immutablePattern.test(urlPath);

    const makeRegexFromGlob = (g) => {
        if (!g || typeof g !== "string") return null;
        let s = g.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        s = s.replace(/\*\*/g, ".*"); // ** => any depth
        s = s.replace(/\*/g, "[^/]*"); // *  => segment chars
        if (!s.startsWith("/")) s = "/" + s;
        return new RegExp("^" + s + "$", "i");
    };

    function chooseAutoLinks(htmlKey) {
        // Simple heuristic: same directory .css first, then .js; prefer hashed (immutable) files
        const dir = htmlKey.slice(0, htmlKey.lastIndexOf("/") + 1);
        const css = [];
        const js = [];
        for (const [k, v] of manifest) {
            if (!k.startsWith(dir)) continue;
            const ext = path.extname(k).toLowerCase();
            if (ext === ".css") css.push(k);
            else if (ext === ".js") js.push(k);
        }
        const stable = (arr) => {
            // prefer immutable filenames; secondary sort by name asc
            return arr.sort((a, b) => {
                const ai = shouldImmutable(a) ? 0 : 1;
                const bi = shouldImmutable(b) ? 0 : 1;
                if (ai !== bi) return ai - bi;
                return a.localeCompare(b);
            });
        };
        const out = [];
        for (const k of stable(css)) {
            if (out.length < linkCfg.max) out.push(k);
            else break;
        }
        for (const k of stable(js)) {
            if (out.length < linkCfg.max) out.push(k);
            else break;
        }
        return out;
    }

    function chooseRuleLinks(reqPath) {
        if (!linkCfg.rules) return [];
        // Longest-prefix match on rule keys
        const prefixes = Object.keys(linkCfg.rules).sort((a, b) => b.length - a.length);
        let match = null;
        for (const p of prefixes) {
            if (reqPath.startsWith(p)) {
                match = p;
                break;
            }
        }
        if (!match) return [];
        const patterns = linkCfg.rules[match] || [];
        const regs = patterns.map(makeRegexFromGlob).filter(Boolean);
        const out = [];
        for (const [k] of manifest) {
            if (regs.some((re) => re.test(k))) {
                out.push(k);
                if (out.length >= linkCfg.max) break;
            }
        }
        return out;
    }

    function buildLinkHeaderValues(keys) {
        const items = [];
        for (const k of keys) {
            const ext = path.extname(k).toLowerCase();
            if (ext === ".css") {
                items.push(`<${k}>; rel=preload; as=style${linkCfg.crossorigin ? "; crossorigin" : ""}`);
            } else if (ext === ".js") {
                items.push(`<${k}>; rel=preload; as=script${linkCfg.crossorigin ? "; crossorigin" : ""}`);
            } else if (ext === ".woff2" || ext === ".woff") {
                items.push(`<${k}>; rel=preload; as=font; type="font/${ext.slice(1)}"; crossorigin`);
            } else if (ext === ".svg") {
                items.push(`<${k}>; rel=preload; as=image; type="image/svg+xml"`);
            } else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".avif") {
                items.push(`<${k}>; rel=preload; as=image`);
            }
        }
        return items.slice(0, linkCfg.max);
    }

    function mergeLinkHeadersOnRes(res, linkVals) {
        if (!linkVals || !linkVals.length) return;
        try {
            const prev = res.getHeader && res.getHeader("Link");
            if (!prev) {
                res.setHeader("Link", linkVals);
            } else if (Array.isArray(prev)) {
                res.setHeader("Link", prev.concat(linkVals));
            } else {
                res.setHeader("Link", [prev].concat(linkVals));
            }
        } catch (_) {}
    }

    // --- Variant sender (with linker support) ---
    const serveVariant = async (app, req, res, baseEntry, variant) => {
        // If-None-Match
        const inm = req.headers && req.headers["if-none-match"];
        if (inm && variant.etag) {
            const tags = inm.split(",").map((s) => s.trim());
            if (tags.includes(variant.etag)) {
                const h = {
                    ETag: variant.etag,
                    "Content-Type": baseEntry.type,
                    "Content-Encoding": variant.encoding,
                    Vary: "Accept-Encoding",
                    "Last-Modified": new Date(variant.mtimeMs).toUTCString(),
                };
                if (shouldImmutable(baseEntry.key)) h["Cache-Control"] = cfg.cacheControlImmutable;
                else h["Cache-Control"] = cfg.cacheControlDefault;

                // Linker for HTML (preload hints)
                if (linkCfg.mode !== "off" && String(baseEntry.type).startsWith("text/html")) {
                    const keys = linkCfg.mode === "auto" ? chooseAutoLinks(baseEntry.key) : chooseRuleLinks(req.pathname || baseEntry.key);
                    const linkVals = buildLinkHeaderValues(keys);
                    if (linkVals.length) h["Link"] = linkVals;
                }

                res.writeHead(304, h);
                res.end();
                return true;
            }
        }

        // If Range requested, let identity path handle it (range-aware)
        if (req.headers && req.headers["range"]) return false;

        const headers = {
            "Content-Type": baseEntry.type,
            "Content-Encoding": variant.encoding,
            Vary: "Accept-Encoding",
            ETag: variant.etag,
            "Last-Modified": new Date(variant.mtimeMs).toUTCString(),
            "Content-Length": variant.size,
        };
        if (shouldImmutable(baseEntry.key)) headers["Cache-Control"] = cfg.cacheControlImmutable;
        else headers["Cache-Control"] = cfg.cacheControlDefault;

        // Linker for HTML (preload hints)
        if (linkCfg.mode !== "off" && String(baseEntry.type).startsWith("text/html")) {
            const keys = linkCfg.mode === "auto" ? chooseAutoLinks(baseEntry.key) : chooseRuleLinks(req.pathname || baseEntry.key);
            const linkVals = buildLinkHeaderValues(keys);
            if (linkVals.length) headers["Link"] = headers["Link"] ? [].concat(headers["Link"]).concat(linkVals) : linkVals;
        }

        try {
            res.writeHead(200, headers);
            if (req.method === "HEAD") {
                res.end();
                return true;
            }
            const pipelineAsync = promisify(stream.pipeline);
            await pipelineAsync(fs.createReadStream(variant.abs), res);
            return true;
        } catch (_) {
            try {
                if (!res.writableEnded) res.end();
            } catch (_) {}
            return true; // treat as served; client may have closed
        }
    };

    // --- Quick 404 for known misses ---
    const maybeQuick404 = (req, res, key) => {
        if (!built) return false;
        if (!cfg.shortCircuit404) return false;
        if (manifest.has(key)) return false;

        res.statusCode = 404;
        try {
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } catch (_) {}
        res.end("Not Found");
        return true;
    };

    // --- Watcher (optional) ---
    const watchers = new Set();
    let refreshTimer = null;

    async function listDirs(rootDir) {
        const dirs = [rootDir];
        for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[i];
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const ent of entries) {
                if (ent.isDirectory()) {
                    const p = path.join(dir, ent.name);
                    if (ignoreRe && ignoreRe.test(p)) continue;
                    dirs.push(p);
                }
            }
        }
        return dirs;
    }

    function scheduleRefresh(app) {
        if (!watchCfg) return;
        if (refreshTimer) {
            try {
                clearTimeout(refreshTimer);
            } catch (_) {}
        }
        refreshTimer = setTimeout(async () => {
            refreshTimer = null;
            try {
                if (cfg.verbose) console.log("[AssetManifest] FS change detected → refreshing manifest...");
                await build(app);
                // re-arm watchers in case new dirs appeared
                await restartWatchers(app);
            } catch (e) {
                if (cfg.verbose) console.log("[AssetManifest] refresh error:", e);
            }
        }, debounceMs);
        if (refreshTimer && typeof refreshTimer.unref === "function") refreshTimer.unref();
    }

    async function startWatching(app) {
        if (!watchCfg) return;
        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

        const dirs = await listDirs(base);
        for (const dir of dirs) {
            try {
                const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
                    if (ignoreRe && filename && ignoreRe.test(path.join(dir, String(filename)))) return;
                    scheduleRefresh(app);
                });
                w.on("error", () => {
                    try {
                        w.close();
                    } catch (_) {}
                    watchers.delete(w);
                });
                watchers.add(w);
            } catch (_) {}
        }
        if (cfg.verbose) console.log(`[AssetManifest] Watching ${watchers.size} directories under ${base}`);
    }

    async function restartWatchers(app) {
        for (const w of watchers) {
            try {
                w.close();
            } catch (_) {}
        }
        watchers.clear();
        await startWatching(app);
    }

    // --- Plugin surface ---
    return {
        name: "assetManifest",
        apply(app) {
            // preload on startup
            if (cfg.preload) {
                app.onInit(async () => {
                    try {
                        await ensure(app);
                    } catch (e) {
                        if (cfg.verbose) console.log("[AssetManifest] preload error:", e);
                    }
                    try {
                        await startWatching(app);
                    } catch (_) {}
                });
            } else if (watchCfg) {
                // still set up watchers if asked
                app.onInit(async () => {
                    try {
                        await startWatching(app);
                    } catch (_) {}
                });
            }

            // expose ops helpers
            app.assetManifestSnapshot = () => {
                const out = {};
                for (const [k, v] of manifest) {
                    out[k] = { size: v.size, mtimeMs: v.mtimeMs, type: v.type, variants: Object.keys(v.variants) };
                }
                return out;
            };
            app.refreshAssetManifest = async () => {
                built = false;
                manifest.clear();
                byAbs.clear();
                return ensure(app);
            };

            // close watchers on shutdown
            app.onShutdown(() => {
                for (const w of watchers) {
                    try {
                        w.close();
                    } catch (_) {}
                }
                watchers.clear();
            });

            if (cfg.exposeRoute && typeof app.get === "function") {
                app.get(cfg.exposeRoute, (req, res) => res.json(app.assetManifestSnapshot()));
            }

            // Serve assets early (and add Link hints for HTML)
            app.hooks({
                beforeRoute: async ({ req, res }) => {
                    try {
                        if (req.method !== "GET" && req.method !== "HEAD") return;

                        await ensure(app);

                        let abs;
                        try {
                            abs = app.resolvePath(req.url);
                        } catch {
                            return;
                        }

                        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

                        const rel = path.relative(base, abs);
                        const key = "/" + rel.split(path.sep).join("/");

                        if (maybeQuick404(req, res, key)) {
                            req._assetServed = true;
                            return;
                        }

                        const entry = manifest.get(key);
                        if (!entry) return;

                        // prefer precompressed variant when safe
                        let usedVariant = null;
                        if (cfg.prefer === "br" || cfg.prefer === "auto") {
                            if (entry.variants.br && aeIncludes(req, "br")) usedVariant = entry.variants.br;
                        }
                        if (!usedVariant && (cfg.prefer === "gzip" || cfg.prefer === "auto")) {
                            if (entry.variants.gzip && aeIncludes(req, "gzip")) usedVariant = entry.variants.gzip;
                        }
                        if (usedVariant) {
                            const ok = await serveVariant(app, req, res, entry, usedVariant);
                            if (ok) {
                                req._assetServed = true;
                                return;
                            }
                        }

                        // Identity: set Cache-Control and optional Link:preload for HTML, then delegate
                        if (res.writableEnded || res.destroyed) return;

                        if (shouldImmutable(entry.key)) {
                            try {
                                res.setHeader("Cache-Control", cfg.cacheControlImmutable);
                            } catch (_) {}
                        } else {
                            try {
                                res.setHeader("Cache-Control", cfg.cacheControlDefault);
                            } catch (_) {}
                        }

                        if (linkCfg.mode !== "off" && String(entry.type).startsWith("text/html")) {
                            const keys = linkCfg.mode === "auto" ? chooseAutoLinks(entry.key) : chooseRuleLinks(req.pathname || entry.key);
                            const linkVals = buildLinkHeaderValues(keys);
                            mergeLinkHeadersOnRes(res, linkVals);
                        }

                        await app.contentType.serveFile(entry.abs, req, res, req.preferredEncoding, app.compressionThreshold, app.compressibleMimeTypes);
                        req._assetServed = true;
                    } catch (e) {
                        if (cfg.verbose) console.log("[AssetManifest] beforeRoute error:", e);
                    }
                },

                // Add Link:preload for dynamic HTML responses (e.g., res.render) using rule-based hints
                beforeSend: ({ req, res }) => {
                    try {
                        if (res.headersSent || res.writableEnded) return;
                        if (linkCfg.mode === "off") return;

                        const ct = (res.getHeader && res.getHeader("Content-Type")) || "";
                        if (!String(ct).toLowerCase().startsWith("text/html")) return;

                        // if a Link header already exists, do nothing (don’t duplicate)
                        if (res.getHeader && res.getHeader("Link")) return;

                        const keys = linkCfg.mode === "rules" ? chooseRuleLinks(req.pathname || req.url || "/") : [];
                        const linkVals = buildLinkHeaderValues(keys);
                        mergeLinkHeadersOnRes(res, linkVals);
                    } catch (_) {}
                },
            });
        },
    };
}

UltraFastServer.AssetManifestPlugin = createAssetManifestPlugin;

/** HTML Dependency Mapper + Early Hints (103) scheduler (zero-dep, async). */
function createHTMLDepsEarlyHintsPlugin(opts = {}) {
    const cfg = Object.assign(
        {
            roots: null, // default: app.contentDir
            preload: true, // build at startup via onInit()
            watch: false, // false | true | { debounceMs?:number, ignore?:RegExp }
            maxHints: 8, // cap number of Link: preload items
            crossorigin: false, // add crossorigin to fonts/scripts/styles if needed
            rules: null, // dynamic HTML → asset globs
            verbose: false,

            // NEW:
            css: true, // scan CSS for url(...) fonts at build time
            preconnect: true, // emit rel=preconnect for off-origin assets
            maxPreconnect: 3, // cap number of preconnect origins
            preconnectSchemes: ["https:"], // which schemes to preconnect
        },
        opts || {}
    );

    // Normalize watch config
    const watchCfg = cfg.watch && typeof cfg.watch === "object" ? cfg.watch : cfg.watch === true ? {} : null;
    const debounceMs = watchCfg ? Number(watchCfg.debounceMs || 250) : 250;
    const ignoreRe = watchCfg && watchCfg.ignore instanceof RegExp ? watchCfg.ignore : null;

    // Internal state
    const htmlDeps = new Map(); // key '/page.html' -> array of keys ['/app.css','/app.js',...]
    const htmlOrigins = new Map(); // key '/page.html' -> Set('https://cdn.example.com', ...)

    let built = false;
    let building = null;
    const watchers = new Set();
    let refreshTimer = null;

    // Helpers
    const toRoute = (abs, base) => "/" + path.relative(base, abs).split(path.sep).join("/");
    const posixJoin = (a, b) => ("/" + path.posix.join(a.replace(/\/+$/, ""), b)).replace(/\/{2,}/g, "/");
    const stripQueryHash = (u) => u.replace(/[?#].*$/, "");
    const isExternal = (u) => /^(data:|https?:\/\/|\/\/)/i.test(u);
    const makeRegexFromGlob = (g) => {
        if (!g || typeof g !== "string") return null;
        let s = g.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        s = s.replace(/\*\*/g, ".*"); // ** => any depth
        s = s.replace(/\*/g, "[^/]*"); // *  => segment
        if (!s.startsWith("/")) s = "/" + s;
        return new RegExp("^" + s + "$", "i");
    };
    const guessAs = (k) => {
        const ext = path.extname(k).toLowerCase();
        if (ext === ".css") return { as: "style" };
        if (ext === ".js" || ext === ".mjs") return { as: "script" };
        if (ext === ".woff2") return { as: "font", type: "font/woff2", crossorigin: true };
        if (ext === ".woff") return { as: "font", type: "font/woff", crossorigin: true };
        if (ext === ".svg") return { as: "image", type: "image/svg+xml" };
        if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".avif") return { as: "image" };
        return null;
    };
    const buildLinkItems = (keys) => {
        const out = [];
        for (const k of keys.slice(0, cfg.maxHints)) {
            const meta = guessAs(k) || {};
            const parts = [`<${k}>; rel=preload; as=${meta.as || "fetch"}`];
            if (meta.type) parts.push(`type="${meta.type}"`);
            const needCo = meta.crossorigin || cfg.crossorigin || false;
            if (needCo && meta.as !== "image") parts.push("crossorigin");
            out.push(parts.join("; "));
        }
        return out;
    };

    // Extract absolute origin from an external URL (http(s) or protocol-relative)
    function originFromURL(u) {
        try {
            if (!u || typeof u !== "string") return null;
            if (u.startsWith("data:")) return null;
            if (u.startsWith("//")) {
                const host = u.slice(2).split("/")[0];
                return host ? `https://${host}` : null;
            }
            const url = new URL(u);
            if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
        } catch (_) {}
        return null;
    }

    function buildPreconnectItems(hosts, cfg) {
        if (!hosts) return [];
        const uniq = Array.from(new Set(Array.from(hosts))).slice(0, cfg.maxPreconnect);
        const allowed = new Set((cfg.preconnectSchemes || []).map(String));
        const out = [];
        for (const origin of uniq) {
            try {
                const u = new URL(origin);
                if (allowed.size && !allowed.has(u.protocol)) continue;
                const parts = [`<${u.origin}>; rel=preconnect`];
                // crossOrigin is recommended when credentials might be needed; harmless otherwise
                parts.push("crossorigin");
                out.push(parts.join("; "));
            } catch (_) {}
        }
        return out;
    }

    function mergeLinkHeadersOnRes(res, linkVals) {
        if (!linkVals || !linkVals.length) return;
        try {
            const prev = res.getHeader && res.getHeader("Link");
            if (!prev) res.setHeader("Link", linkVals);
            else if (Array.isArray(prev)) res.setHeader("Link", prev.concat(linkVals));
            else res.setHeader("Link", [prev].concat(linkVals));
        } catch (_) {}
    }

    // Scan a single HTML file (streaming) and collect referenced deps (href/src)
    async function scanHTMLFile(htmlAbs, base) {
        const dirKey = ("/" + path.relative(base, path.dirname(htmlAbs))).split(path.sep).join("/");
        const fileKey = toRoute(htmlAbs, base);
        const depsSet = new Set();

        const originSet = new Set();
        const recordOrigin = (u) => {
            const o = originFromURL(u);
            if (o) originSet.add(o);
        };

        const TAG_RE = /<(link|script)\b[^>]*>/gi;
        const ATTR = (s, name) => {
            const re = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
            const m = re.exec(s);
            return m ? m[1] ?? m[2] ?? m[3] ?? "" : "";
        };

        await new Promise((resolve) => {
            const rs = fs.createReadStream(htmlAbs, { encoding: "utf8" });
            let buf = "";
            rs.on("data", (chunk) => {
                buf += chunk;
                let m;
                while ((m = TAG_RE.exec(buf))) {
                    const tag = m[0];
                    const name = m[1].toLowerCase();

                    if (name === "link") {
                        const rel = (ATTR(tag, "rel") || "").toLowerCase();
                        // const href = stripQueryHash(ATTR(tag,'href') || '');
                        // if (!href || isExternal(href)) continue;

                        const href = stripQueryHash(ATTR(tag, "href") || "");
                        if (!href) continue;
                        if (isExternal(href)) {
                            recordOrigin(href);
                            continue;
                        }

                        if (rel.includes("stylesheet")) {
                            // <link rel="stylesheet" href="...">
                            const key = href.startsWith("/") ? stripQueryHash(href) : posixJoin(dirKey, href);
                            depsSet.add(key);
                        } else if (rel.includes("preload")) {
                            // <link rel="preload" href="..." as="...">
                            const key = href.startsWith("/") ? stripQueryHash(href) : posixJoin(dirKey, href);
                            depsSet.add(key);
                        } else if (rel.includes("modulepreload")) {
                            const key = href.startsWith("/") ? stripQueryHash(href) : posixJoin(dirKey, href);
                            depsSet.add(key);
                        }
                    } else if (name === "script") {
                        // const src = stripQueryHash(ATTR(tag,'src') || '');
                        // if (!src || isExternal(src)) continue;

                        const src = stripQueryHash(ATTR(tag, "src") || "");
                        if (!src) continue;
                        if (isExternal(src)) {
                            recordOrigin(src);
                            continue;
                        }

                        const key = src.startsWith("/") ? src : posixJoin(dirKey, src);
                        depsSet.add(key);
                    }
                }
                // keep a tail for split tags
                if (buf.length > 8192) buf = buf.slice(-4096);
            });
            rs.on("end", resolve);
            rs.on("error", resolve); // best-effort
        });

        // Filter to existing files under base (best effort, async)
        const checked = [];
        for (const k of depsSet) {
            const abs = path.join(base, k.replace(/^\//, ""));
            try {
                const st = await fsp.stat(abs);
                if (st.isFile()) checked.push(k);
            } catch {} // ignore
        }

        htmlOrigins.set(fileKey, originSet); // store off-origin hosts for preconnect

        htmlDeps.set(fileKey, checked);
    }

    // Stream-parse a CSS file for url(...) font references; collect same-origin keys and external origins
    async function scanCSSFile(cssAbs, base) {
        const fonts = new Set();
        const origins = new Set();
        const cssDirKey = "/" + path.relative(base, path.dirname(cssAbs)).split(path.sep).join("/");

        const URL_RE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))\s*\)/gi;
        const stripQH = (s) => s.replace(/[?#].*$/, "");
        const isFont = (u) => /\.(woff2?|ttf|otf)(?:$|\?|\#)/i.test(u);

        await new Promise((resolve) => {
            const rs = fs.createReadStream(cssAbs, { encoding: "utf8" });
            let buf = "";
            rs.on("data", (chunk) => {
                buf += chunk;
                // remove comments safely (/* ... */) within current window
                const safe = buf.replace(/\/\*[\s\S]*?\*\//g, " ");
                let m;
                while ((m = URL_RE.exec(safe))) {
                    const raw = m[1] ?? m[2] ?? m[3] ?? "";
                    if (!raw) continue;
                    const u = stripQH(raw.trim());
                    if (!isFont(u)) continue;

                    if (isExternal(u)) {
                        const o = originFromURL(u);
                        if (o) origins.add(o);
                    } else {
                        const key = u.startsWith("/") ? u : ("/" + path.posix.join(cssDirKey.replace(/\/+$/, ""), u)).replace(/\/{2,}/g, "/");
                        fonts.add(key);
                    }
                }
                // keep tail to handle split tokens
                if (buf.length > 16384) buf = buf.slice(-8192);
            });
            rs.on("end", resolve);
            rs.on("error", resolve); // best-effort
        });

        // Verify existence of same-origin font files
        const checked = [];
        for (const k of fonts) {
            try {
                const abs = path.join(base, k.replace(/^\//, ""));
                const st = await fsp.stat(abs);
                if (st.isFile()) checked.push(k);
            } catch (_) {}
        }
        return { fonts: checked, origins };
    }

    // Post-process: look at CSS referenced by each HTML page, pull font deps + extra origins
    async function augmentFromCSS(app, base) {
        if (!cfg.css) return;
        for (const [htmlKey, depsArr] of htmlDeps.entries()) {
            const cssList = depsArr.filter((k) => k.toLowerCase().endsWith(".css"));
            if (!cssList.length) continue;

            const addFonts = new Set();
            const originSet = htmlOrigins.get(htmlKey) || new Set();

            for (const cssKey of cssList) {
                const cssAbs = path.join(base, cssKey.replace(/^\//, ""));
                try {
                    const { fonts, origins } = await scanCSSFile(cssAbs, base);
                    for (const f of fonts) addFonts.add(f);
                    for (const o of origins) originSet.add(o);
                } catch (e) {
                    if (cfg.verbose) console.log("[HTMLDeps] CSS scan error:", cssKey, e);
                }
            }

            if (addFonts.size) {
                const merged = Array.from(new Set(depsArr.concat(Array.from(addFonts))));
                htmlDeps.set(htmlKey, merged);
            }
            htmlOrigins.set(htmlKey, originSet);
        }
    }

    // Build deps map (all HTML under base)
    async function build(app) {
        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

        // Walk tree
        const stack = [base];
        const htmlFiles = [];
        while (stack.length) {
            const dir = stack.pop();
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const ent of entries) {
                const abs = path.join(dir, ent.name);
                if (ignoreRe && ignoreRe.test(abs)) continue;
                if (ent.isDirectory()) {
                    stack.push(abs);
                    continue;
                }
                if (ent.isFile() && ent.name.toLowerCase().endsWith(".html")) htmlFiles.push(abs);
            }
        }

        // Scan each HTML (in series to keep mem small; could parallelize if needed)
        htmlDeps.clear();
        for (const abs of htmlFiles) {
            try {
                await scanHTMLFile(abs, base);
            } catch (e) {
                if (cfg.verbose) console.log("[HTMLDeps] scan error:", abs, e);
            }
        }
        await augmentFromCSS(app, base);

        built = true;
        return htmlDeps;
    }

    async function ensure(app) {
        if (built) return htmlDeps;
        if (building) return building;
        building = build(app).finally(() => {
            building = null;
        });
        return building;
    }

    // Rules → keys via globs (optionally intersect with asset manifest)
    function chooseRuleKeys(app, reqPath) {
        if (!cfg.rules) return [];
        const prefixes = Object.keys(cfg.rules).sort((a, b) => b.length - a.length);
        let match = null;
        for (const p of prefixes) {
            if (reqPath.startsWith(p)) {
                match = p;
                break;
            }
        }
        if (!match) return [];

        const patterns = cfg.rules[match] || [];
        const regs = patterns.map(makeRegexFromGlob).filter(Boolean);

        // If AssetManifest is present, restrict to its known keys; otherwise best-effort
        let candidates = [];
        if (typeof app.assetManifestSnapshot === "function") {
            const snap = app.assetManifestSnapshot();
            candidates = Object.keys(snap);
        } else {
            // fallback: rough pass by scanning contentDir quickly (only top-level if no manifest)
            candidates = []; // empty → we’ll just return globs as-is (not ideal, but harmless)
        }
        if (candidates.length) {
            return candidates.filter((k) => regs.some((re) => re.test(k))).slice(0, cfg.maxHints);
        }
        // Return sanitized globs (they’ll likely be valid manifest keys)
        return patterns.map((p) => (p.startsWith("/") ? p : "/" + p)).slice(0, cfg.maxHints);
    }

    // Watchers for HTML changes
    async function listDirs(rootDir) {
        const dirs = [rootDir];
        for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[i];
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const ent of entries) {
                if (ent.isDirectory()) {
                    const p = path.join(dir, ent.name);
                    if (ignoreRe && ignoreRe.test(p)) continue;
                    dirs.push(p);
                }
            }
        }
        return dirs;
    }

    function scheduleRefresh(app) {
        if (!watchCfg) return;
        if (refreshTimer) {
            try {
                clearTimeout(refreshTimer);
            } catch (_) {}
        }
        refreshTimer = setTimeout(async () => {
            refreshTimer = null;
            try {
                if (cfg.verbose) console.log("[HTMLDeps] FS change detected → refreshing map...");
                await build(app);
                await restartWatchers(app);
            } catch (e) {
                if (cfg.verbose) console.log("[HTMLDeps] refresh error:", e);
            }
        }, debounceMs);
        if (refreshTimer && typeof refreshTimer.unref === "function") refreshTimer.unref();
    }

    async function startWatching(app) {
        if (!watchCfg) return;
        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

        const dirs = await listDirs(base);
        for (const dir of dirs) {
            try {
                const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
                    //if (filename && !String(filename).toLowerCase().endsWith('.html')) return;
                    const lower = String(filename || "").toLowerCase();
                    if (!(lower.endsWith(".html") || lower.endsWith(".css"))) return;

                    if (ignoreRe && filename && ignoreRe.test(path.join(dir, String(filename)))) return;
                    scheduleRefresh(app);
                });
                w.on("error", () => {
                    try {
                        w.close();
                    } catch (_) {}
                    watchers.delete(w);
                });
                watchers.add(w);
            } catch (_) {}
        }
        if (cfg.verbose) console.log(`[HTMLDeps] Watching ${watchers.size} directories for .html changes`);
    }

    async function restartWatchers(app) {
        for (const w of watchers) {
            try {
                w.close();
            } catch (_) {}
        }
        watchers.clear();
        await startWatching(app);
    }

    return {
        name: "htmlDepsEarlyHints",
        apply(app) {
            // Build and optionally watch
            if (cfg.preload) {
                app.onInit(async () => {
                    try {
                        await ensure(app);
                    } catch (e) {
                        if (cfg.verbose) console.log("[HTMLDeps] preload error:", e);
                    }
                    try {
                        await startWatching(app);
                    } catch (_) {}
                });
            } else if (watchCfg) {
                app.onInit(async () => {
                    try {
                        await startWatching(app);
                    } catch (_) {}
                });
            }

            // Expose ops helpers
            app.htmlDepsSnapshot = () => {
                const out = {};
                for (const [k, v] of htmlDeps) out[k] = v.slice();
                return out;
            };

            app.htmlPreconnectSnapshot = () => {
                const out = {};
                for (const [k, set] of htmlOrigins) out[k] = Array.from(set || []);
                return out;
            };

            app.refreshHTMLDeps = async () => {
                built = false;
                htmlDeps.clear();
                return ensure(app);
            };

            // Send Early Hints as soon as we can for static HTML paths
            app.hooks({
                // For static HTML (served by asset middleware/manifest), fire 103 before streaming
                beforeRoute: async ({ req, res }) => {
                    try {
                        if (req.method !== "GET" && req.method !== "HEAD") return;

                        await ensure(app);

                        // Resolve to absolute file then back to route key to look up deps
                        let abs;
                        try {
                            abs = app.resolvePath(req.url);
                        } catch {
                            return;
                        }

                        const base = cfg.roots && Array.isArray(cfg.roots) && cfg.roots[0] ? (path.isAbsolute(cfg.roots[0]) ? cfg.roots[0] : path.join(process.cwd(), cfg.roots[0])) : app.contentDir;

                        const key = toRoute(abs, base);
                        if (!key.toLowerCase().endsWith(".html")) return;

                        const deps = htmlDeps.get(key) || [];
                        if (!deps.length) return;

                        const preloadVals = buildLinkItems(deps);
                        const origins = htmlOrigins.get(key) || new Set();
                        const preconnectVals = cfg.preconnect ? buildPreconnectItems(origins, cfg) : [];
                        const allLinks = preloadVals.concat(preconnectVals);
                        if (!allLinks.length) return;

                        if (typeof res.earlyHints === "function") {
                            try {
                                res.earlyHints({ link: allLinks });
                            } catch (_) {}
                        }
                        mergeLinkHeadersOnRes(res, allLinks);

                        // const linkVals = buildLinkItems(deps);
                        // if (!linkVals.length) return;

                        // // Fire Early Hints (103) if supported
                        // if (typeof res.earlyHints === 'function') {
                        //     try { res.earlyHints({ link: linkVals }); } catch (_) {}
                        // }

                        // // Ensure final response also carries Link header (in case client missed 103)
                        // mergeLinkHeadersOnRes(res, linkVals);
                    } catch (e) {
                        if (cfg.verbose) console.log("[HTMLDeps] beforeRoute error:", e);
                    }
                },

                // For dynamic HTML (SSR): use rules to send hints at the beginning of handler phase
                beforeHandle: async ({ req, res }) => {
                    try {
                        if (req.method !== "GET" && req.method !== "HEAD") return;
                        const accept = String((req.headers && req.headers["accept"]) || "*/*").toLowerCase();
                        // Heuristic: only hint for html-ish requests
                        if (!accept.includes("text/html") && !accept.includes("*/*")) return;
                        if (!cfg.rules) return;

                        await ensure(app);

                        const keys = chooseRuleKeys(app, req.pathname || req.url || "/");
                        if (!keys.length) return;

                        const linkVals = buildLinkItems(keys);
                        if (!linkVals.length) return;

                        if (typeof res.earlyHints === "function") {
                            try {
                                res.earlyHints({ link: linkVals });
                            } catch (_) {}
                        }
                        mergeLinkHeadersOnRes(res, linkVals);
                    } catch (e) {
                        if (cfg.verbose) console.log("[HTMLDeps] beforeHandle error:", e);
                    }
                },

                // Safety net: if dynamic handlers render HTML, ensure Link header is present
                beforeSend: ({ req, res }) => {
                    try {
                        if (res.headersSent || res.writableEnded) return;
                        const ct = (res.getHeader && res.getHeader("Content-Type")) || "";
                        if (!String(ct).toLowerCase().startsWith("text/html")) return;
                        // If Link header already exists (e.g., from beforeRoute/Handle), skip
                        if (res.getHeader && res.getHeader("Link")) return;

                        const keys = cfg.rules ? chooseRuleKeys(app, req.pathname || req.url || "/") : [];
                        const linkVals = buildLinkItems(keys);
                        mergeLinkHeadersOnRes(res, linkVals);
                    } catch (_) {}
                },
            });

            // Close watchers on shutdown
            app.onShutdown(() => {
                for (const w of watchers) {
                    try {
                        w.close();
                    } catch (_) {}
                }
                watchers.clear();
            });
        },
    };
}

UltraFastServer.HTMLDepsEarlyHintsPlugin = createHTMLDepsEarlyHintsPlugin;

/** Zero-dep per-route concurrency limiter (quick-fail, no queues). */
function createConcurrencyLimiterPlugin(opts = {}) {
    const cfg = Object.assign(
        {
            // default per-route cap (Infinity = disabled)
            default: Infinity,
            // explicit caps by route key (use the canonical "METHOD /pattern", e.g. "GET /users/:id")
            routes: {
                /* 'GET /': 50, 'POST /api/upload': 2 */
            },
            // optional: cap by prefix (matches route key prefix)
            prefixes: {
                /* 'GET /api/': 100 */
            },
            // status/headers for rejections
            statusCode: 503,
            headers: { "Retry-After": "1" },
            // telemetry only if true (do not actually block)
            shadow: false,
            // optionally exclude methods (e.g., do not limit OPTIONS/HEAD)
            excludeMethods: ["OPTIONS"],
        },
        opts || {}
    );

    // in-flight counters per route key
    const inflight = new Map();

    // resolve a limit for a route key like "GET /users/:id" or "GET /foo/bar"
    function limitFor(routeKey) {
        if (!routeKey || typeof routeKey !== "string") return Infinity;
        const m = routeKey.split(" ")[0];
        if (cfg.excludeMethods && cfg.excludeMethods.includes(m)) return Infinity;
        if (cfg.routes && Object.prototype.hasOwnProperty.call(cfg.routes, routeKey)) {
            const n = Number(cfg.routes[routeKey]);
            return Number.isFinite(n) ? n : Infinity;
        }
        if (cfg.prefixes) {
            for (const [pref, cap] of Object.entries(cfg.prefixes)) {
                if (routeKey.startsWith(pref)) {
                    const n = Number(cap);
                    return Number.isFinite(n) ? n : Infinity;
                }
            }
        }
        const def = Number(cfg.default);
        return Number.isFinite(def) ? def : Infinity;
    }

    // helpers to read/dec counters
    function inc(routeKey) {
        const c = inflight.get(routeKey) || 0;
        inflight.set(routeKey, c + 1);
        return c + 1;
    }
    function dec(routeKey) {
        if (!routeKey) return;
        const c = inflight.get(routeKey) || 0;
        const nx = c > 0 ? c - 1 : 0;
        inflight.set(routeKey, nx);
    }

    return {
        name: "concurrencyLimiter",
        apply(app) {
            const registry = getMetricsRegistry(app);

            app.hooks({
                // Executes right before the route handler chain starts
                beforeHandle: ({ req, res, route }) => {
                    if (!route) return; // no route key → ignore
                    const cap = limitFor(route);
                    if (!Number.isFinite(cap) || cap === Infinity || cap <= 0) return;

                    const current = inflight.get(route) || 0;
                    if (current >= cap) {
                        // record reject metric
                        metricsInc(registry, "http_concurrency_rejects_total", { route }, 1);

                        if (!cfg.shadow) {
                            try {
                                res.statusCode = cfg.statusCode || 503;
                                if (cfg.headers && typeof cfg.headers === "object") {
                                    for (const [k, v] of Object.entries(cfg.headers)) res.setHeader(k, v);
                                }
                                res.setHeader("X-Concurrency-Limit", String(cap));
                                res.setHeader("X-Concurrency-In-Flight", String(current));
                                res.end("Server busy"); // quick-fail
                            } catch (_) {}
                            // mark so router won't run the chain
                            req._concurrencyRejected = true;
                        }
                        return;
                    }

                    // admit and remember for safe decrement
                    const after = inc(route);
                    req._concurrencyRouteKey = route;

                    // final safety: always decrement on finish/close
                    const cleanup = () => {
                        try {
                            dec(route);
                        } catch (_) {}
                    };
                    res.once("finish", cleanup);
                    res.once("close", cleanup);

                    // tiny metric
                    metricsObserve(registry, "http_concurrency_inflight", { route }, after);
                },
            });

            // Optional snapshot API for ops/debug
            app.concurrencySnapshot = () => {
                const out = {};
                for (const [k, v] of inflight.entries()) out[k] = v;
                return out;
            };
        },
    };
}

UltraFastServer.ConcurrencyLimiterPlugin = createConcurrencyLimiterPlugin;

/** Tiny zero-dep response cache plugin (GET/HEAD). */
function createResponseCachePlugin(opts = {}) {
    const cfg = Object.assign(
        {
            ttl: 30000, // ms
            maxEntries: 500,
            maxBytes: 10 * 1024 * 1024, // 10MB total
            respectCacheControl: true, // skip caching when 'no-store'/'private'
            cacheHeader: "X-Cache", // annotate HIT/MISS on responses we serve
            varyAcceptEncoding: true, // ensure client can accept stored variant
            captureMaxBytes: 512 * 1024, // per-entry capture limit
        },
        opts || {}
    );
    const store = new Map(); // key -> { status, headers, body, etag, encoding, size, expires, createdAt }
    let totalBytes = 0;

    const now = () => Date.now();

    const makeKey = (req) => {
        if (!req || (req.method !== "GET" && req.method !== "HEAD")) return null;
        if (req.headers && req.headers["authorization"]) return null; // default: don't cache auth'd
        if (req.headers && req.headers["range"]) return null; // no range support in cache
        return `${req.method} ${req.originalUrl || req.url}`;
    };

    const canServeVariant = (req, entry) => {
        if (!cfg.varyAcceptEncoding) return true;
        const enc = (entry && entry.encoding) || "identity";
        if (enc === "identity") return true;
        const ae = String((req.headers && req.headers["accept-encoding"]) || "").toLowerCase();
        return ae.includes(enc);
    };

    const setAgeHeader = (headers, ageMs) => {
        try {
            headers["Age"] = Math.max(0, Math.floor(ageMs / 1000));
        } catch (_) {}
    };

    const evictIfNeeded = () => {
        while (store.size > cfg.maxEntries || totalBytes > cfg.maxBytes) {
            const it = store.entries().next();
            if (it.done) break;
            const [k, v] = it.value;
            store.delete(k);
            totalBytes -= v.size || 0;
        }
    };

    const shouldSkipByCacheControl = (resLike) => {
        if (!cfg.respectCacheControl) return false;
        const cc = resLike.getHeader && resLike.getHeader("Cache-Control");
        if (!cc) return false;
        const s = String(cc).toLowerCase();
        return s.includes("no-store") || s.includes("private");
    };

    const parseMaxAge = (h) => {
        if (!h) return NaN;
        const m = String(h)
            .toLowerCase()
            .match(/max-age\s*=\s*(\d+)/);
        return m ? parseInt(m[1], 10) * 1000 : NaN;
    };

    const computeEtag = (buf) => {
        const h = createHash("sha1").update(buf).digest("hex");
        return `W/"${buf.length.toString(16)}-${h.slice(0, 32)}"`;
    };

    return {
        name: "responseCache",
        apply(app) {
            app.hooks({
                // Serve cache hits BEFORE routing
                beforeRoute: ({ req, res }) => {
                    const key = makeKey(req);
                    if (!key) return;

                    const entry = store.get(key);
                    if (!entry) return;
                    if (!canServeVariant(req, entry)) return;

                    if (entry.expires > now()) {
                        // Conditional GET
                        const inm = req.headers && req.headers["if-none-match"];
                        if (inm && entry.etag) {
                            const tags = inm.split(",").map((s) => s.trim());
                            if (tags.includes(entry.etag)) {
                                const headers = Object.assign({}, entry.headers);
                                headers[cfg.cacheHeader] = "HIT";
                                headers["ETag"] = entry.etag;
                                setAgeHeader(headers, now() - entry.createdAt);
                                res.writeHead(304, headers);
                                res.end();
                                req._cacheServed = true;
                                return;
                            }
                        }
                        // Serve body
                        const headers = Object.assign({}, entry.headers);
                        headers[cfg.cacheHeader] = "HIT";
                        setAgeHeader(headers, now() - entry.createdAt);
                        if (req.method === "HEAD") {
                            res.writeHead(entry.status, headers);
                            res.end();
                        } else {
                            headers["Content-Length"] = entry.body.length;
                            res.writeHead(entry.status, headers);
                            res.end(entry.body);
                        }
                        req._cacheServed = true;
                    } else {
                        // Stale -> evict
                        store.delete(key);
                        totalBytes -= entry.size || 0;
                    }
                },

                // Capture successful responses to populate the cache
                beforeHandle: ({ req, res }) => {
                    const key = makeKey(req);
                    if (!key) return;

                    if (res._rcWrapped) return;
                    res._rcWrapped = true;

                    const originalWrite = res.write;
                    const originalEnd = res.end;
                    const originalWriteHead = res.writeHead;

                    let chunks = [];
                    let capturedBytes = 0;

                    res.writeHead = function (...args) {
                        return originalWriteHead.apply(this, args);
                    };

                    res.write = function (chunk, enc, cb) {
                        try {
                            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
                            capturedBytes += buf.length;
                            if (capturedBytes <= cfg.captureMaxBytes) {
                                chunks.push(buf);
                            } else {
                                chunks = null; // stop capturing if too big
                            }
                        } catch (_) {}
                        return originalWrite.call(this, chunk, enc, cb);
                    };

                    res.end = function (chunk, enc, cb) {
                        if (chunk && chunks) {
                            try {
                                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
                                capturedBytes += buf.length;
                                if (capturedBytes <= cfg.captureMaxBytes) {
                                    chunks.push(buf);
                                } else {
                                    chunks = null;
                                }
                            } catch (_) {}
                        }

                        try {
                            const status = res.statusCode || 200;
                            if (status === 200 && chunks && !shouldSkipByCacheControl(res)) {
                                const body = Buffer.concat(chunks);
                                const cc = res.getHeader && res.getHeader("Cache-Control");
                                let ttl = !Number.isNaN(parseMaxAge(cc)) ? parseMaxAge(cc) : cfg.ttl;

                                // Basic eligibility checks
                                if (ttl > 0 && body.length > 0 && !(res.getHeader && res.getHeader("Set-Cookie"))) {
                                    // Snapshot headers
                                    const headers = {};
                                    if (typeof res.getHeaderNames === "function") {
                                        for (const name of res.getHeaderNames()) {
                                            headers[name] = res.getHeader(name);
                                        }
                                    }

                                    // ETag – create if missing
                                    let etag = headers["ETag"] || headers["etag"];
                                    if (!etag) {
                                        etag = computeEtag(body);
                                        try {
                                            res.setHeader("ETag", etag);
                                            headers["etag"] = etag;
                                        } catch (_) {}
                                    } else {
                                        headers["etag"] = etag;
                                    }

                                    const encoding = (headers["content-encoding"] || headers["Content-Encoding"] || "identity").toLowerCase();
                                    const entry = {
                                        status,
                                        headers,
                                        body,
                                        etag,
                                        encoding,
                                        size: body.length,
                                        createdAt: now(),
                                        expires: now() + ttl,
                                    };

                                    store.set(key, entry);
                                    totalBytes += entry.size;
                                    evictIfNeeded();
                                }
                            }
                        } catch (_) {}

                        return originalEnd.call(this, chunk, enc, cb);
                    };
                },
            });
        },
    };
}

UltraFastServer.ResponseCachePlugin = createResponseCachePlugin;

export default UltraFastServer;
