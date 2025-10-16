import * as __ns_node_worker_threads from 'node:worker_threads';
(async function main() {
  import tmp_hash from "./modules/parser/utils/hash.js";
  import * as __tmp_raw from "node:fs";
  import fs from "node:fs";
  import path from "node:path";
  import crypto from "crypto";
  import SimpleLRUCache from "./modules/caches/simple-lru-cache.js";
  import tokenize from "./modules/parser/tokenizer.js";
  import buildAST from "./modules/parser/ast-builder.js";
  import generateJS from "./modules/parser/codegen.js";
  import pathWorker from "node:path";
  import helpers from "./modules/helper.js";
  import componentPluginRegistration from "./modules/register-component-plugins.js";
  import macroPluginRegistration from "./modules/register-macro-plugins.js";
  import coreDirectiveRegistration from "./modules/register-core-directives.js";
  import coreFilterRegistration from "./modules/register-core-filters.js";
  import coreMicroRegistration from "./modules/register-core-macros.js";
  import EventEmitter from "node:events";
  import CompilePool from "./modules/worker/compile-pool.js";
  import { use } from "#use";
  import { promises } from "node:fs";
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";
  
  
  // moved import for { use }
  
  // moved import for fs
  // moved import for { promises }
  // moved import for path
  // moved import for crypto
  // moved import for { EventEmitter }
  // moved import for SimpleLRUCache
  // moved import for tokenize // ADDED
  
  // moved import for buildAST // ADDED
  // moved import for generateJS // ADDED
  
  // moved import for pathWorker // ADDED
  const workerAvail = (() => {
      // ADDED
      try {
          /* TODO dynamic require → await import("node:worker_threads".js) */ /* TODO dynamic require → await import("node:worker_threads".js) */ __ns_node_worker_threads;
          return true;
      } catch {
          return false;
      } // ADDED
  })(); // ADDED
  
  const mainHelpers = use("@core/helpers");
  
  const TARGET_DIR_PATHS = [
      path.join(process.cwd(), "views"),
      path.join(process.cwd(), "views", "macros"),
      path.join(process.cwd(), "views", "components"),
      path.join(process.cwd(), "views", "mails"),
      path.join(process.cwd(), "views", "phones"),
      path.join(process.cwd(), "views", "sms"),
      path.join(process.cwd(), "views", "layouts"),
      path.join(process.cwd(), "views", "partials"),
      path.join(process.cwd(), "views", "pages"),
      path.join(process.cwd(), "views", "widgets"),
      path.join(process.cwd(), "views", "auth"),
      path.join(process.cwd(), "views", "assets"),
  ];
  
  // moved import for helpers
  const viewHelpers = {}; // use('@core/helpers');
  // moved import for componentPluginRegistration
  // moved import for macroPluginRegistration
  // moved import for coreDirectiveRegistration
  // moved import for coreFilterRegistration
  // moved import for coreMicroRegistration
  
  // const filter = {}
  
  Object.keys(mainHelpers).forEach((key) => {
      Object.keys(mainHelpers[key]).forEach((method) => {
          if (!viewHelpers[method]) {
              viewHelpers[method] = mainHelpers[key][method];
          }
      });
  });
  
  class TemplateEngine extends EventEmitter {
      /**
       * Constructor for the TemplateEngine class.
       * @param {Object} [options] - Configuration options for the TemplateEngine.
       * @param {Object} [options.config] - Configuration options to be merged with the default configuration.
       * @param {Object} [options.helpers] - Additional helpers to be merged with the default helpers.
       * @param {string} [options.viewsPath] - Path to the views directory.
       * @param {string} [options.componentsPath] - Path to the components directory.
       * @param {boolean} [options.cache] - Whether to enable caching.
       * @param {boolean} [options.autoEscape] - Whether to enable auto-escaping.
       * @param {Function} [options.escapeFunction] - Custom escape function to use.
       * @param {boolean} [options.debug] - Whether to enable debug mode.
       * @param {boolean} [options.watch] - Whether to watch for file changes and reload templates.
       * @param {string} [options.locale] - Locale to use for i18n.
       * @param {Object} [options.translations] - Translation dictionary to use for i18n.
       * @param {string} [options.viewExtension] - File extension to use for views.
       */
      constructor(options = {}) {
          super();
          // Define default configuration
          // const defaultConfig = {
          //     defaultLayout: null,
          //     cache: false,
          //     autoEscape: false,
          //     precompile: false,
          //     cacheMaxSize: 500, // Default LRU cache size
          // };
  
          const defaultConfig = {
              defaultLayout: null,
              cache: false,
              autoEscape: true, // 🔹 NOW ON BY DEFAULT
              precompile: false,
              cacheMaxSize: 500,
          };
  
          // Merge defaults with user-supplied configuration
          this.config = Object.assign({}, defaultConfig, options.config);
  
          // Do similar merging for helpers:
          // const defaultHelpers = { ...helpers }; // 'helpers' imported from your module
  
          this._dateTimeFormatters = new Map(); // Cache for Intl formatters
          this._numberFormatters = new Map(); // <<< Add Cache for NumberFormat
  
          // --- Helpers Setup ---
          const engineInstance = this; // Capture 'this' for helper context
  
          const defaultHelpers = {
              ...helpers, // Spread any existing default helpers from './modules/helper'
              ...viewHelpers,
  
              // Default translation helper '__'
              __: function (key, replacements = {}, localeOverride = null) {
                  // 'this' inside this function might depend on how it's called.
                  // We use 'engineInstance' captured from the outer scope for reliability.
                  const targetLocale = localeOverride || engineInstance.locale;
                  const translations = engineInstance.translations;
  
                  let message = translations[targetLocale]?.[key] ?? key; // Get message or fallback to key
  
                  // Basic placeholder replacement (e.g., "Welcome :name")
                  if (typeof replacements === "object" && replacements !== null) {
                      for (const placeholder in replacements) {
                          // Use a regex to replace :placeholder globally
                          message = message.replace(new RegExp(":" + placeholder, "g"), replacements[placeholder]);
                      }
                  }
                  return message;
              },
  
              // Alias 'translate'
              translate: function (key, replacements = {}, localeOverride = null) {
                  // Delegate to '__'. Need 'engineInstance' here too.
                  return engineInstance.__(key, replacements, localeOverride);
              },
          };
  
          this.helpers = Object.assign({}, defaultHelpers, options.helpers); // ADDED
          /* expose to template scope */ this.helpers.rawLivePush = this._pushFn; // ADDED
  
          // Set default paths if not provided
          this.viewsPath = options.viewsPath || path.join(process.cwd(), "views");
          this.componentsDir = options.componentsPath || path.join(process.cwd(), "views", "components");
  
          // Other properties…
          this.cacheEnabled = options.cache ?? this.config.cache;
          this.cacheMaxSize = options.cacheMaxSize ?? this.config.cacheMaxSize;
          this.debug = options.debug ?? false; // Set debug early for cache logging
          //this.templateCache = new Map();
  
          if (this.cacheEnabled) {
              if (this.debug) console.log(`[Cache] Enabling LRU Cache with max size: ${this.cacheMaxSize}`);
              this.templateCache = new SimpleLRUCache(this.cacheMaxSize);
              this.templateCache.debug = this.debug; // Pass debug setting to cache instance
  
              /* ------------------------------------------------------------------
               * File‑source cache – keeps raw template text in memory and avoids
               * repeated synchronous disk reads on every render. 100 % compatible
               * with the current synchronous compile pipeline.                    // ADDED
               * ------------------------------------------------------------------ */
              // this.fileContentCache       = new SimpleLRUCache(options.fileCacheMaxSize || 1000); // ADDED
              // this.fileContentCache.debug = this.debug;
  
              if (!this.fileContentCache) {
                  // UPDATED
                  this.fileContentCache = new SimpleLRUCache(options.fileCacheMaxSize || 1000); // ADDED
                  this.fileContentCache.debug = this.debug; // ADDED
              }
          } else {
              if (this.debug) console.log(`[Cache] Caching is disabled.`);
              // If disabled, use a dummy object with matching methods but does nothing.
              // This avoids checks for 'this.templateCache' later.
              this.templateCache = {
                  get: () => undefined,
                  set: () => {},
                  delete: () => false,
                  has: () => false,
                  clear: () => {},
                  getSize: () => 0,
              };
          }
          // Use HybridCache for caching
          // this.cache =
          //     options.cacheInstance ||
          //     new HybridCache({
          //         ttl: options.ttl || 3600,
          //         maxInMemoryItems: options.maxInMemoryItems || 1000,
          //         evictionPolicy: options.evictionPolicy || "LRU",
          //         // You can pass other cache options here...
          //         debug: options.debug || false,
          //     });
          this.inlineMacros = {};
          this.templateCacheBlocks = {};
          this._sectionCache = new Map(); // ADDED
          this._depGraph = new Map(); // template → Set(dependencies)   // ADDED
          this._depDirty = false; // ADDED
          const depFile = path.join(process.cwd(), "compiled_views", ".rnv-deps.json"); // ADDED
          this._depFilePath = depFile; // ADDED
          try {
              // ADDED
              const raw = __tmp_raw.readFileSync(depFile, "utf8");; // ADDED
              const obj = JSON.parse(raw); // ADDED
              for (const [k, v] of Object.entries(obj)) this._depGraph.set(k, new Set(v)); // ADDED
              if (this.debug) console.log("[DepGraph] loaded", this._depGraph.size, "entries"); // ADDED
          } catch (_) {
              /* fresh start */
          } // ADDED
          this.onceRegistry = {};
          this.customDirectives = {};
          // this.debug = options.debug || false;
          this.watch = options.watch || false;
          if (this.watch) {
              this.setupFileWatcher();
          }
          this.macros = {};
          this.plugins = [];
  
          // ---- Hooks & plug‑in bus ---------------------------------------------- // ADDED
          this._hooks = new Map(); // name -> Set<fn>
          this._knownHooks = new Set(["beforeTokenize", "afterTokenize", "beforeCompile", "afterCompile", "beforeInstantiate", "afterInstantiate", "beforeRender", "afterRender", "beforeInclude", "afterInclude", "fileChanged"]);
  
          // ---- Hot-path caches for tokenizer/AST/codegen (LRU) ------------------ // ADDED
          if (this.cacheEnabled && this.useTokenizer) {
              this.tokenCache = new SimpleLRUCache(options.tokenCacheMaxSize || 2000);
              this.astCache = new SimpleLRUCache(options.astCacheMaxSize || 1000);
              this.codegenCache = new SimpleLRUCache(options.codegenCacheMaxSize || 1000);
          }
  
          // ---- CSP nonce support (optional, per-render) ------------------------- // ADDED
          this.cspNonceFn = typeof options.cspNonceFn === "function" ? options.cspNonceFn : null;
  
          // ---- Dev reload flag -------------------------------------------------- // ADDED
          this.devReload = !!options.devReload;
  
          // ---- Security: context-aware escape helpers & default filters --------- // ADDED
          if (!this.helpers.escapeAttr) this.helpers.escapeAttr = escapeAttr;
          if (!this.helpers.sanitizeUri) this.helpers.sanitizeUri = sanitizeUri;
          if (!this.helpers.escapeJS) this.helpers.escapeJS = escapeJS;
          if (!this.helpers.escapeCSS) this.helpers.escapeCSS = escapeCSS;
  
          // Make them available as filters too (non-breaking)                      // ADDED
          this.filter("attr", (v) => escapeAttr(v));
          this.filter("url", (v) => sanitizeUri(v));
          this.filter("js", (v) => escapeJS(v));
          this.filter("css", (v) => escapeCSS(v));
  
          // ---- Islands storage is per-render via rnv bag; no global state. ------ // ADDED
  
          this.viewExtension = options.viewExtension || ".rnv";
  
          // --- Translation Setup ---
          this.locale = options.locale || options.config?.locale || "en";
          this.translations = options.translations || options.config?.translations || {};
          if (this.debug && Object.keys(this.translations).length > 0) {
              console.log(`[i18n] Loaded translations for locales: ${Object.keys(this.translations).join(", ")}`);
          } else if (this.debug) {
              console.log(`[i18n] No initial translations loaded.`);
          }
          // --- End Translation Setup ---
  
          // Auto-escape and escape function.
          // this.autoEscape = options.autoEscape !== undefined ? options.autoEscape : this.config.autoEscape;
          // use explicit option if given, otherwise fallback to (new) default true
          this.autoEscape = typeof options.autoEscape === "boolean" ? options.autoEscape : this.config.autoEscape;
          this.escapeFunction = options.escapeFunction || defaultEscape; // ADDED
  
          /* ------------  Parser‑refactor feature flags --------------- */ this.useTokenizer = !!options.useTokenizer; // ADDED
  
          /* ---------------------------------------------------------------
           * Optional worker‑thread compile pool
           * ------------------------------------------------------------- */
          this.workerCompile = !!options.workerCompile; // ADDED
          this.compileThresholdByte = options.compileThresholdByte ?? 8192; // ADDED
          this.enableStreaming = !!options.enableStreaming; // ADDED // ADDED
  
          /* ------------------ live‑push gateway ------------------ */ // moved import for EventEmitter // ADDED
          this._pushBus = new EventEmitter(); // ADDED
          this._pushFn = (id, html) => this._pushBus.emit("push", { id, html }); // ADDED // ADDED
  
          /* allow user‑supplied adapter (e.g. WebSocket, SSE) */ if (typeof options.rawLiveAdapter === "function")
              // ADDED
              this._pushBus.on("push", options.rawLiveAdapter); // ADDED
          if (this.workerCompile && !workerAvail) {
              // ADDED
              console.warn("[Worker] worker_threads not available in this runtime – falling back to main‑thread compilation."); // ADDED
              this.workerCompile = false; // ADDED
          } // ADDED
          if (this.workerCompile) {
              // ADDED
              // moved import for CompilePool // ADDED
              const workerPath = pathWorker.join(__dirname, "modules", "worker", "compile-worker.js"); // ADDED
              this._compilePool = new CompilePool(workerPath, { debug: this.debug, autoDispose: true }); // ADDED
          }
  
          if (this.autoEscape && !this.helpers.escapeHTML) {
              // this.helpers.escapeHTML = this.escapeFunction;
              this.helpers.escapeHTML = this.escapeFunction; // defaultEscape already assigned above
          }
  
          // Ensure filters container exists.
          this.filters = {};
          // if (!this.helpers.filters) {
          //     this.helpers.filters = this.filters;
          // }
  
          // Ensure 'filters' object exists on helpers if needed by compileTemplate setup
          if (!this.helpers.filters) this.helpers.filters = {};
          Object.assign(this.helpers.filters, this.filters); // Merge registered filters
  
          // Load macros if provided.
          if (options.macrosPath) {
              this._macrosLoadedPromise = this.loadMacrosFromDirectory(options.macrosPath);
          }
  
          if (this.config.precompile) {
              this.precompileAll().catch((err) => {
                  if (this.debug) console.error("Precompilation error:", err);
              });
          }
  
          // Register plugins and core directives/filters.
          this.registerMacroPlugin();
          this.registerComponentPlugin();
          this.registerCoreDirectives();
          this.registerCoreFilters();
          this.registerCoreMicros();
          this.ensureStandardDirectories();
          // --- NEW: Initialize an object to hold global data ---
          this.globals = {};
          // --- END: Initialize an object to hold global data ---
  
          // TemplateEngine.js  (constructor bottom)
          this.live = {
              push: (id, html) => this._pushBus.emit("push", { id, html }),
              on: (...args) => this._pushBus.on(...args),
          };
  
          // Default context-aware helpers
          if (!this.helpers.escapeAttr) this.helpers.escapeAttr = escapeAttr;
          if (!this.helpers.sanitizeUri) this.helpers.sanitizeUri = sanitizeUri;
          if (!this.helpers.escapeJS) this.helpers.escapeJS = escapeJS;
          if (!this.helpers.escapeCSS) this.helpers.escapeCSS = escapeCSS;
  
          // Register as filters without going through registerFilter (safe at boot)
          if (!this.helpers.filters.attr) this.helpers.filters.attr = (v) => escapeAttr(v);
          if (!this.helpers.filters.url) this.helpers.filters.url = (v) => sanitizeUri(v);
          if (!this.helpers.filters.js) this.helpers.filters.js = (v) => escapeJS(v);
          if (!this.helpers.filters.css) this.helpers.filters.css = (v) => escapeCSS(v);
      }
  
      /**
  +   * True streaming renderer based on per‑token async generator.                 // ADDED
  +   */
  
      renderStream(templateName, data = {}) {
          // moved import for { Readable }
          const stream = new Readable({ read() {} });
  
          // If tokenizer streaming is off, keep your current fallback:
          if (!this.enableStreaming || !this.useTokenizer) {
              this.render(templateName, data)
                  .then((html) => {
                      stream.push(html);
                      stream.push(null);
                  })
                  .catch((e) => stream.destroy(e));
              return stream;
          }
  
          // UPDATED — use compiled renderer but provide a flush hook
          (async () => {
              try {
                  // per-render bag for streaming path
                  const rnv = {
                      islands: [],
                      nonce: this.cspNonceFn ? this.cspNonceFn(data) : null,
                      __flush: (chunk) => {
                          if (chunk) stream.push(chunk);
                      },
                  };
                  // get compiled just like render(), but call directly to keep simple
                  const compiled = (await this.workerCompile) ? this.getCompiledTemplateAsync(templateName) : this.getCompiledTemplate(templateName);
  
                  const inheritedSectionsMap = new Map();
                  const currentStacks = {};
                  this.extractStacks(this.getTemplateContent(templateName.replace(/\.rnv$/, "")), currentStacks);
                  const mergedStacks = mergeStacks(data.stacks || {}, currentStacks);
  
                  const html = await compiled.compiledFunc(data, this.helpers, mergedStacks, this.macros || {}, this, compiled.extractedComponents, inheritedSectionsMap, compiled.sectionFuncs, compiled.rawBlocks, rnv);
                  // push tail and runtime
                  stream.push(html);
                  if (rnv.islands.length) stream.push(this._emitIslandsRuntime(rnv));
                  stream.push(null);
              } catch (err) {
                  stream.destroy(err);
              }
          })();
  
          return stream;
      }
  
      /**
       * Returns a token array for a template string. Primarily for the upcoming  // ADDED
       * parser refactor and for debugging / test‑harnesses.                      // ADDED
       */
      tokenize(templateStr) {
          // ADDED
          //return tokenize(templateStr);                                           // ADDED
          if (this.workerCompile && templateStr.length >= this.compileThresholdByte) {
              return this._compilePool.tokenize("inline", templateStr); // ADDED
          }
          return tokenize(templateStr); // UPDATED
      } // ADDED
  
      /**
       * NEW: A method to add global data available to all templates.
       * @param {object} data - An object of data to merge with existing globals.
       */
      share(data) {
          Object.assign(this.globals, data);
          return this; // Allow chaining
      }
  
      // Add this method inside the TemplateEngine class
      /**
       * Gets a cached Intl.NumberFormat instance for the given locale and options.
       * @param {string} [locale='en-US'] BCP 47 language tag string.
       * @param {object} [options={}] Intl.NumberFormat options object.
       * @returns {Intl.NumberFormat}
       * @private
       */
      _getNumberFormatter(locale = "en-US", options = {}) {
          const safeLocale = typeof locale === "string" ? locale : "en-US";
          const safeOptions = typeof options === "object" && options !== null ? options : {};
          // Create a consistent cache key (order of option keys shouldn't matter)
          let optionsKeyPart = "{}";
          try {
              optionsKeyPart = JSON.stringify(safeOptions, Object.keys(safeOptions).sort());
          } catch (e) {
              console.warn(`[Intl Cache] Could not stringify NumberFormat options for key:`, safeOptions);
              optionsKeyPart = "_complex_options_";
          }
          const cacheKey = `${safeLocale}||${optionsKeyPart}`;
  
          if (!this._numberFormatters.has(cacheKey)) {
              try {
                  const formatter = new Intl.NumberFormat(safeLocale, safeOptions);
                  this._numberFormatters.set(cacheKey, formatter);
                  if (this.debug) console.log(`[Intl Cache] Created NumberFormat formatter for: ${cacheKey}`);
                  // Optional: Add cache eviction logic if map grows too large
              } catch (err) {
                  console.error(`[Intl Cache] Failed to create NumberFormat for locale "${safeLocale}" with options ${optionsKeyPart}:`, err);
                  // Return a default formatter on error
                  return new Intl.NumberFormat("en-US"); // Basic fallback
              }
          }
          return this._numberFormatters.get(cacheKey);
      }
  
      /**
       * Gets a cached Intl.DateTimeFormat instance for the given locale and options.
       * Creates a new formatter if one is not cached.
       * @param {string} [locale='en-US'] BCP 47 language tag string.
       * @param {object} [options={}] Intl.DateTimeFormat options object.
       * @returns {Intl.DateTimeFormat} A configured formatter instance.
       * @private
       */
      _getDateTimeFormatter(locale = "en-US", options = {}) {
          // Ensure locale is string, options is object
          const safeLocale = typeof locale === "string" ? locale : "en-US";
          const safeOptions = typeof options === "object" && options !== null ? options : {};
  
          // Create a consistent cache key (order of option keys shouldn't matter)
          let optionsKeyPart = "{}";
          try {
              // Sort keys for consistent caching regardless of option order
              optionsKeyPart = JSON.stringify(safeOptions, Object.keys(safeOptions).sort());
          } catch (e) {
              // Handle potential stringify errors with complex options (e.g., functions)
              // Use a less precise key in this rare case
              console.warn(`[Intl Cache] Could not stringify options for key:`, safeOptions);
              optionsKeyPart = "_complex_options_";
          }
  
          const cacheKey = `${safeLocale}||${optionsKeyPart}`;
  
          if (!this._dateTimeFormatters.has(cacheKey)) {
              try {
                  const formatter = new Intl.DateTimeFormat(safeLocale, safeOptions);
                  this._dateTimeFormatters.set(cacheKey, formatter);
                  if (this.debug) console.log(`[Intl Cache] Created formatter for: ${cacheKey}`);
                  // Optional: Add cache eviction logic if map grows too large
                  // if (this._dateTimeFormatters.size > 1000) { /* remove oldest */ }
              } catch (err) {
                  console.error(`[Intl Cache] Failed to create DateTimeFormat for locale "${safeLocale}" with options ${optionsKeyPart}. Using default. Error:`, err);
                  // Return a default formatter on error to prevent crashes
                  // Cache the default under this key to avoid repeated errors? Maybe not.
                  return new Intl.DateTimeFormat("en-US"); // Basic fallback
              }
          }
          return this._dateTimeFormatters.get(cacheKey);
      }
  
      /**
       * Generates JS code for a text segment, replacing raw block placeholders.
       * @param {string} text The text segment potentially containing placeholders.
       * @param {string} [rawBlocksVarName='rawBlocks'] The name of the variable holding the rawBlocks array in the compiled function's scope.
       * @returns {string} Generated JavaScript code string.
       * @private
       */
      _generateCodeForTextSegment(text, rawBlocksVarName = "rawBlocks") {
          let segmentCode = "";
          let textCursor = 0;
          const placeholderRegex = /__RAW_BLOCK__(\d+)__/g; // Matches __RAW_BLOCK__0__ etc.
          let placeholderMatch;
  
          // Find all placeholders in the text segment
          while ((placeholderMatch = placeholderRegex.exec(text)) !== null) {
              // Add text before the placeholder (if any)
              if (placeholderMatch.index > textCursor) {
                  segmentCode += "output += " + JSON.stringify(text.substring(textCursor, placeholderMatch.index)) + ";\n";
              }
              // Add code to append the raw block content from the passed array
              const blockIndex = parseInt(placeholderMatch[1], 10);
              // Access the array passed into the compiled function (e.g., 'rawBlocks')
              // Use nullish coalescing for safety, although index should be valid
              segmentCode += `output += (${rawBlocksVarName}[${blockIndex}] ?? '');\n`;
              textCursor = placeholderRegex.lastIndex; // Move cursor past the placeholder
          }
          // Add any remaining text after the last placeholder
          if (textCursor < text.length) {
              segmentCode += "output += " + JSON.stringify(text.substring(textCursor)) + ";\n";
          }
          return segmentCode;
      }
  
      /**
       * Express-compatible rendering function interface.
       * This function conforms to the (filePath, options, callback) signature
       * expected by frameworks like Express or compatible APIs like our server.engine().
       * It calls the internal async render method and bridges the Promise result
       * to the callback pattern.
       *
       * @param {string} filePath - Absolute path to the template file provided by the caller (e.g., server.render).
       * @param {object} options - Data/locals object (typically includes merged app locals and render-specific locals).
       * @param {Function} callback - The final callback function with the signature (err, renderedString).
       */
  
      __express(filePath, options, callback) {
          // Prepare the initial data object, merging engine helpers with request-specific data
          const templateData = { ...this.helpers, ...options };
  
          // Clean up data to avoid passing framework internals to the template scope
          delete templateData.settings;
          delete templateData._locals;
          delete templateData.cache;
          delete templateData.res;
          delete templateData.req;
  
          // Call the main async render method and handle the promise for the callback
          this.render(filePath, templateData)
              .then((html) => callback(null, html))
              .catch((err) => callback(err));
      }
  
      /**
       * Express-compatible rendering function interface.
       * This function conforms to the (filePath, options, callback) signature
       * expected by frameworks like Express or compatible APIs like our server.engine().
       * It calls the internal async render method and bridges the Promise result
       * to the callback pattern.
       *
       * @param {string} filePath - Absolute path to the template file provided by the caller (e.g., server.render).
       * @param {object} options - Data/locals object (typically includes merged app locals and render-specific locals).
       * @param {Function} callback - The final callback function with the signature (err, renderedString).
       */
  
      /**
       * Alias for __express for other potential framework integrations.
       */
      __native(filePath, options, callback) {
          this.__express(filePath, options, callback);
      }
  
      /**
       * Generates the JavaScript code string for a given template body (or section content).
       * Processes template tags including whitespace control and enhanced loops.
       * Handles @parent and @yield conditionally based on isSection flag.
       * @param {string} bodyContent - The template string content to compile.
       * @param {string} sourceName - Name of the source template/section (for error messages).
       * @param {string} [rawBlocksVarName='rawBlocks'] - The name of the variable holding the rawBlocks array in the compiled function's scope.
       * @param {boolean} [isSection=false] - True if compiling section content, false for main body/layout.
       * @returns {string} The generated JavaScript code string (function body).
       * @private
       */
      /**
       * Generates the JavaScript code string for a template's body or section.
       * THIS IS THE PRIMARY CODE GENERATOR.
       * @private
       */
      _generateCodeForTemplateBody(bodyContent, sourceName, rawBlocksVarName = "rawBlocks", isSection = false) {
          let code = "let output = '';\n";
          let cursor = 0;
          let inSwitch = false;
          // ← add this line:
          let currentLoopIndexVar = null;
          // Uses the corrected regex that handles comments
          // const regex = /{!!\s*(-)?\s*([\s\S]*?)\s*(-)?\s*!!}|{{\s*--([\s\S]*?)--\s*}}|{{\s*(-)?\s*([\s\S]*?)\s*(-)?\s*}}|@componentPlaceholder\((\d+)\)|@([a-zA-Z_]\w*)(?:\s*\(([\s\S]*?)\))?/g;
  
          const regex = /{!!\s*(-)?\s*([\s\S]*?)\s*(-)?\s*!!}|{{\s*--([\s\S]*?)--\s*}}|{{\s*(-)?\s*([\s\S]*?)\s*(-)?\s*}}|@componentPlaceholder\((\d+)\)|@([a-zA-Z_]\w*)(?:\s*\(((?:[^()]*|\([^()]*\))*)\))?/g;
  
          regex.lastIndex = 0;
  
          const getLineNumber = (index) => {
              let line = 0,
                  count = 0;
              const lines = bodyContent.split("\n");
              while (line < lines.length && count <= index) {
                  count += lines[line].length + 1;
                  line++;
              }
              return line;
          };
  
          let match;
          let trimNextLeading = false;
  
          while ((match = regex.exec(bodyContent)) !== null) {
              const hasLeadingHyphen = !!(match[1] || match[5]);
              const hasTrailingHyphen = !!(match[3] || match[7]);
  
              let text = bodyContent.slice(cursor, match.index);
              if (trimNextLeading) {
                  text = text.replace(/^\s+/, "");
                  trimNextLeading = false;
              }
              if (hasLeadingHyphen) {
                  text = text.replace(/\s+$/, "");
              }
              if (!(inSwitch && /^\s*$/.test(text) && text !== "")) {
                  code += this._generateCodeForTextSegment(text, rawBlocksVarName);
              }
  
              cursor = regex.lastIndex;
              const currentLine = getLineNumber(match.index);
              let generatedSegment = "";
  
              try {
                  if (match[4] !== undefined) {
                      // Comment (Group 4)
                      generatedSegment = "";
                  } else if (match[2] !== undefined) {
                      // Raw {!! !!} (Group 2)
                      generatedSegment = `output += ((${match[2].trim()}) ?? '');\n`;
                  } else if (match[6] !== undefined) {
                      // Escaped {{ }} (Group 6)
                      const expr = match[6].trim();
                      if (expr.includes("|")) {
                          // Filtered
                          generatedSegment += `{\n  let temp = ((${expr.split("|")[0].trim()}) ?? '');\n`;
                          expr.split("|")
                              .slice(1)
                              .forEach((filterStr) => {
                                  const filterMatch = filterStr.trim().match(/^(\w+)(?:\((.*)\))?$/);
                                  const filterName = filterMatch ? filterMatch[1] : "";
                                  const filterArgs = filterMatch && filterMatch[2] ? `, ${filterMatch[2]}` : "";
                                  if (filterName) generatedSegment += `  temp = (typeof filters?.${filterName} === 'function') ? await filters['${filterName}'](temp${filterArgs}) : temp;\n`;
                              });
                          generatedSegment += this.autoEscape ? `  output += escapeHTML(temp);\n` : `  output += temp;\n`;
                          generatedSegment += `}\n`;
                      } else {
                          // Unfiltered
                          generatedSegment += this.autoEscape ? `output += escapeHTML((${expr}) ?? '');\n` : `output += ((${expr}) ?? '');\n`;
                      }
                  } else if (match[8] !== undefined) {
                      // Component Placeholder (Group 8)
                      generatedSegment = `{\n  const compInfo = extractedComponents[${match[8]}];\n  if(compInfo) { output += await engineInstance._includeComponent(compInfo, data); } else { console.error("Component placeholder found but no matching component data was available in section scope."); }\n}\n`;
                  } else if (match[9] !== undefined) {
                      const directive = match[9];
                      const args = (match[10] || "").trim();
  
                      // Handle @parent / @yield in sections/layouts as before…
                      if (isSection && directive === "parent") {
                          generatedSegment = `
        if (typeof parentSectionFunc === 'function') {
          output += await parentSectionFunc();
        } else {
          console.warn('[@parent] used in section without a parent layout section.');
        }\n`;
                      } else if (!isSection && directive === "yield") {
                          const sectionName = args.replace(/^['"]|['"]$/g, "");
                          generatedSegment = `
  {
    const sectionInfo = sectionsMap.get('${sectionName}');
    if (sectionInfo?.func) {
      const parentFunc = layoutSectionFuncs?.['${sectionName}'] || null;
      output += await sectionInfo.func(
        data,
        helpers,
        engineInstance,
        parentFunc,
        rawBlocks,
        extractedComponents,
        rnv // ADDED
      );
    } else {
      output += '';
    }
  }\n`;
                      } else if (isSection && directive === "yield") {
                          // ignore
                      } else if (!isSection && directive === "section") {
                          // ignore
                      }
                      // All other built-in directives:
                      else {
                          switch (directive) {
                              case "if":
                                  generatedSegment = `if(${args}){\n`;
                                  break;
                              case "elseif":
                                  generatedSegment = `} else if(${args}){\n`;
                                  break;
                              case "else":
                                  generatedSegment = `} else {\n`;
                                  break;
                              case "endif":
                                  generatedSegment = `}\n`;
                                  break;
  
                              case "foreach": {
                                  // parse "itemVar[, keyVar] in collectionExpr"
                                  const parts = args.match(/^\s*([\w.]+)(?:\s*,\s*([\w.]+))?\s+in\s+([\s\S]+)$/);
                                  if (!parts) throw new Error(`Invalid @foreach syntax: ${args}`);
                                  const [, itemVar, keyVar, collectionExpr] = parts;
  
                                  const idxVar = `__idx_${cursor}`;
                                  const entriesVar = `__entries_${cursor}`;
                                  const collVar = `__coll_${cursor}`;
                                  const lenVar = `__len_${cursor}`;
  
                                  generatedSegment =
                                      `const ${collVar} = (${collectionExpr}) ?? [];\n` +
                                      `let ${entriesVar};\n` +
                                      `if (Array.isArray(${collVar})) ${entriesVar} = Array.from(${collVar}.entries());\n` +
                                      `else if (${collVar} && typeof ${collVar} === 'object') ${entriesVar} = Object.entries(${collVar});\n` +
                                      `else ${entriesVar} = [];\n` +
                                      `const ${lenVar} = ${entriesVar}.length;\n` +
                                      `let ${idxVar} = 0;\n` +
                                      `for (const __pair of ${entriesVar}) {\n` +
                                      `  const loop = { index0: ${idxVar}, index: ${idxVar}+1, first: ${idxVar}===0, last: ${idxVar}===${lenVar}-1, length: ${lenVar} };\n` +
                                      `  const ${keyVar || `__key_${cursor}`} = __pair[0];\n` +
                                      `  const ${itemVar} = __pair[1];\n`;
                                  // remember to track currentLoopIndexVar = idxVar for @endforeach
                                  currentLoopIndexVar = idxVar;
                                  break;
                              }
  
                              case "endforeach":
                                  if (!currentLoopIndexVar) {
                                      console.warn(`[WARN ${sourceName}] @endforeach without matching @foreach.`);
                                      generatedSegment = `}\n`;
                                  } else {
                                      generatedSegment = `  ${currentLoopIndexVar}++;\n}\n`;
                                      currentLoopIndexVar = null;
                                  }
                                  break;
  
                              case "include": {
                                  // const partial = args.replace(/^['"]|['"]$/g, "");
                                  // generatedSegment = `output += await engineInstance._include('${partial}', data);\n`;
  
                                  // split only on the first comma that separates path and arg object
                                  const [pathPart, argPart] = args.split(/,(.+)/); // .split(/,(.+)/) keeps rhs intact
                                  const partialPath = pathPart.trim().replace(/^['"]|['"]$/g, "");
                                  const dataExpr = argPart ? argPart.trim() : "data"; // default to current scope
                                  generatedSegment = `output += await engineInstance._include('${partialPath}', ${dataExpr});\n`;
                                  break;
                              }
  
                              case "stack": {
                                  const stackName = args.replace(/^['"]|['"]$/g, "");
                                  generatedSegment = `output += (Array.isArray(stacks?.${stackName}) ? stacks['${stackName}'].join('') : '');\n`;
                                  break;
                              }
  
                              // …add other built-ins: @switch/@case/@default/@break/@endswitch/@set/@ternary as needed…
  
                              default:
                                  // finally, custom directives
                                  if (this.customDirectives[directive]) {
                                      generatedSegment = this.customDirectives[directive](args);
                                  } else {
                                      console.warn(`Unknown directive @${directive} in ${sourceName}`);
                                  }
                          }
                      }
                  }
  
                  // else if (match[9] !== undefined) {
                  //     // Directive (Group 9)
                  //     const directive = match[9];
                  //     const args = (match[10] || "").trim();
  
                  //     if (isSection && directive === "parent") {
                  //         generatedSegment = ` if (typeof parentSectionFunc === 'function') { output += await parentSectionFunc(); } else { console.warn('[@parent] used in section without a parent layout section.'); }\n`;
                  //     } else if (!isSection && directive === "yield") {
                  //         const sectionName = args.replace(/^['"]|['"]$/g, "");
                  //         // THIS IS THE KEY FIX: We add `extractedComponents` as the last argument
                  //         // when calling the section function.
                  //         generatedSegment = `{\n  const sectionInfo = sectionsMap.get('${sectionName}');\n  if (sectionInfo?.func) {\n    const parentFunc = layoutSectionFuncs?.['${sectionName}'] || null;\n    output += await sectionInfo.func(data, helpers, engineInstance, parentFunc, rawBlocks, extractedComponents);\n  } else { output += ''; }\n}\n`;
                  //     } else if (isSection && directive === "yield") {
                  //         console.warn(`@yield is ignored inside @section: ${directive} in ${sourceName}`);
                  //     } else if (!isSection && directive === "section") {
                  //         // This case is handled by compileTemplate, so this part should not be hit for @section blocks
                  //     } else {
                  //         // Handle other built-in directives or custom directives
                  //         if (this.customDirectives[directive]) {
                  //             generatedSegment = this.customDirectives[directive](args);
                  //         } else {
                  //             console.warn(`Unknown directive @${directive} in ${sourceName}`);
                  //         }
                  //     }
                  // }
              } catch (genError) {
                  console.error(`Error processing tag in ${sourceName}:`, genError);
                  throw genError;
              }
  
              code += generatedSegment;
              if (hasTrailingHyphen) {
                  trimNextLeading = true;
              }
          }
  
          let remainder = bodyContent.slice(cursor);
          if (trimNextLeading) {
              remainder = remainder.replace(/^\s+/, "");
          }
          if (!(inSwitch && /^\s*$/.test(remainder) && remainder === "")) {
              code += this._generateCodeForTextSegment(remainder, rawBlocksVarName);
          }
  
          code += "return output;";
          return code;
      }
  
      /**
       * Internal helper method to include and render a partial template.
       * Uses the current engine instance's context and cache.
       * @param {string} partialName - Name/relative path of the partial (relative to viewsPath).
       * @param {object} data - Current data scope for the partial.
       * @returns {Promise<string>} Rendered partial content.
       * @private
       */
      /**
       * Includes a partial (buffered).
       * @private
       */
  
      async _include(partialName, callerData) {
          await this._runHooks("beforeInclude", { partialName, callerData });
          const deps = this._depGraph.get(callerData.__currentTpl || "root") || new Set();
          deps.add(partialName);
          this._depGraph.set(callerData.__currentTpl || "root", deps);
          this._depDirty = true;
          const partialData = { ...callerData };
          const out = await this.render(partialName, partialData);
          await this._runHooks("afterInclude", { partialName, callerData, length: out.length });
          return out;
      }
  
      // Modify _includeComponent to use propsVarName and create 'attributes'
      /**
       * Internal helper method to include and render a component template.
       * Retrieves props from parentData based on propsVarName, passes slots,
       * and makes props available under the 'attributes' key.
       * @param {object} compInfo - Component details { name, propsVarName, content, slots }.
       * @param {object} parentData - Current data scope from the calling template.
       * @returns {Promise<string>} Rendered component content.
       * @private
       */
      /**
       * Includes a component (buffered).
       * @private
       */
      async _includeComponent(compInfo, parentData) {
          const { name, propsVarName, content: defaultSlotContent, slots: namedSlots } = compInfo;
          const compPath = path.join("components", name);
  
          let attributes = {};
          if (propsVarName) {
              const getProp = this.helpers?.getPropertySafely || getPropertySafely;
              const propsObject = getProp(parentData, propsVarName);
              if (typeof propsObject === "object" && propsObject !== null) {
                  attributes = propsObject;
              }
          }
  
          const componentData = {
              ...parentData,
              attributes,
              slot: defaultSlotContent || "",
              slots: namedSlots || {},
          };
  
          return this.render(compPath, componentData);
      }
  
      /**
       * Ensures a predefined list of standard view subdirectories exists
       * within the configured viewsPath. Creates them recursively if missing.
       * This is a utility method, intended to be called manually by the user
       * after initializing the engine if they want these standard directories created.
       * @param {string[]} [subDirs = [...]] Optional array of relative subdirectories. Defaults to common ones.
       * @returns {Promise<void>} A promise that resolves when all checks/creations are done.
       */
      async ensureStandardDirectories(subDirs = null) {
          const standardDirs = subDirs || [
              "", // Ensures the root viewsPath itself exists
              "components",
              "layouts",
              "macros",
              "partials",
              "pages",
              "phones",
              "sms",
              "assets",
              "mails",
              "auth",
              "widgets",
              // Add any other directories your framework commonly uses/expects
              // 'pages', 'emails', 'auth', 'widgets', etc.
          ];
  
          if (!this.viewsPath) {
              console.warn("[Dir] Cannot ensure directories: viewsPath is not configured.");
              return;
          }
  
          if (this.debug) console.log(`[Dir] Ensuring standard directories exist under: ${this.viewsPath}`);
  
          // Create directories concurrently
          await Promise.all(
              standardDirs.map((subDir) => {
                  const fullDirPath = path.join(this.viewsPath, subDir);
                  // Use the existing async method which handles 'EEXIST' correctly
                  return this.createDirectoryAsync(fullDirPath);
              })
          );
  
          // Also ensure componentsDir exists if it's custom and different
          const defaultComponentsDir = path.join(this.viewsPath, "components");
          if (this.componentsDir && path.resolve(this.componentsDir) !== path.resolve(defaultComponentsDir)) {
              if (this.debug) console.log(`[Dir] Ensuring custom components directory exists: ${this.componentsDir}`);
              await this.createDirectoryAsync(this.componentsDir);
          }
          // Add similar logic for a custom macrosPath if applicable
  
          if (this.debug) console.log(`[Dir] Standard directory check complete.`);
      }
  
      async createDirectoryAsync(dirPath) {
          const fullPath = path.resolve(dirPath);
          try {
              await promises.mkdir(fullPath, { recursive: true });
              //console.log(`Directory created at: ${fullPath}`);
          } catch (error) {
              console.error(`Failed to create directory: ${error.message}`);
          }
      }
  
      registerCoreDirectives() {
          coreDirectiveRegistration(this);
      }
      registerCoreFilters() {
          coreFilterRegistration(this);
      }
      registerCoreMicros() {
          coreMicroRegistration(this);
      }
  
      // Inside TemplateEngine class
  
      setupFileWatcher() {
          // const dependents = []; // ADDED
          // for (const [tpl, deps] of this._depGraph.entries()) // ADDED
          //     if (deps.has(cacheKey) || deps.has(noExt)) dependents.push(tpl);
          // dependents.forEach((t) => this.templateCache.delete(t)); // ADDED
          // Prevent setup if caching isn't enabled or path doesn't exist
          if (!this.cacheEnabled) {
              if (this.debug) console.log("[Watcher] Watch disabled: Caching is not enabled.");
              return;
          }
          try {
              // Check if viewsPath exists before watching
              if (!fs.existsSync(this.viewsPath)) {
                  console.warn(`[Watcher] Watch disabled: Views directory not found at "${this.viewsPath}"`);
                  return;
              }
          } catch (err) {
              console.error(`[Watcher] Error checking viewsPath "${this.viewsPath}":`, err);
              return;
          }
  
          try {
              const watcher = fs.watch(this.viewsPath, { recursive: true }, (eventType, filename) => {
                  if (this.debug) {
                      // Log raw event details for diagnostics
                      console.log(`[Watcher] Event received: type='${eventType}', filename='${filename || "<null>"}'`);
                  }
  
                  // --- Handle missing filename ---
                  if (!filename) {
                      // This often happens on macOS with recursive watch. We don't know which file changed.
                      // Simply logging is the safest default action.
                      // Clearing the *entire* cache might be an option but could impact performance significantly
                      // if directory changes trigger this frequently.
                      console.warn(`[Watcher] Received '${eventType}' event with no filename (common on some platforms or for directory changes). Cannot invalidate specific cache entry.`);
                      // Example of more drastic action (use with caution):
                      // if (someConditionToClearCache) { this.templateCache.clear(); }
                      return;
                  }
  
                  // --- Process filename ---
                  try {
                      // Normalize path separators, treat as relative for cache key lookup
                      let cacheKey = filename.replace(/\\/g, "/");
  
                      // Basic check: Is it likely a template file based on extension?
                      if (!cacheKey.endsWith(this.viewExtension)) {
                          if (this.debug) console.log(`[Watcher] Ignoring event for non-template or directory: ${filename}`);
                          return;
                      }
  
                      // Check if this key exists in the cache and delete it
                      // if (this.templateCache.has(cacheKey)) {
                      //     const deleted = this.templateCache.delete(cacheKey); // Use LRU delete
                      //     if (deleted && this.debug) {
                      //         console.log(`[Watcher] Cache invalidated for: ${cacheKey}`);
                      //     } // ADDED
  
                      //     /* Also drop the raw‑source entry (with and without extension) */ const noExt = cacheKey.endsWith(this.viewExtension) ? cacheKey.slice(0, -this.viewExtension.length) : cacheKey; // ADDED
                      //     this.fileContentCache.delete(noExt); // ADDED
                      //     this.fileContentCache.delete(cacheKey);
                      // } else {
                      // The key might not be found if:
                      // 1. The file wasn't cached yet.
                      // 2. The 'filename' provided by fs.watch doesn't exactly match the
                      //    templateName used for caching (e.g., absolute vs relative path issues).
                      // Resolving this robustly across platforms is complex. This simple check is a starting point.
                      const noExt = cacheKey.endsWith(this.viewExtension) ? cacheKey.slice(0, -this.viewExtension.length) : cacheKey;
  
                      /* 1️⃣ Invalidate the template itself */
                      if (this.templateCache.has(cacheKey)) {
                          const deleted = this.templateCache.delete(cacheKey);
                          if (deleted && this.debug) console.log(`[Watcher] Cache invalidated for: ${cacheKey}`);
                          this.fileContentCache.delete(noExt);
                          this.fileContentCache.delete(cacheKey);
                      } else {
                          if (this.debug) {
                              console.log(`[Watcher] Cache key "${cacheKey}" not found for deletion (file might not be cached or path mismatch).`);
                          }
                      }
  
                      /* 2️⃣ Invalidate every cached template that *depends* on this file */
                      const dependents = [];
                      for (const [tpl, deps] of this._depGraph.entries()) {
                          if (deps.has(cacheKey) || deps.has(noExt)) dependents.push(tpl);
                      }
                      dependents.forEach((t) => {
                          this.templateCache.delete(t);
                          if (this.debug) console.log(`[Watcher] Cascade invalidation → ${t}`);
                      });
  
                      // ADDED — notify live dev clients
                      if (this.devReload) {
                          this._pushBus.emit("dev:reload", { file: filename, eventType });
                      }
                  } catch (processingError) {
                      // Catch errors during path processing or cache interaction
                      console.error(`[Watcher] Error processing file change event for "${filename}":`, processingError);
                  }
              });
  
              // Handle errors occurring on the watcher itself
              watcher.on("error", (error) => {
                  console.error(`[Watcher] File system watcher encountered an error:`, error);
                  // Consider logging this more seriously or potentially stopping the watch/server
              });
  
              // Handle watcher close event (optional)
              watcher.on("close", () => {
                  if (this.debug) console.log(`[Watcher] File system watcher closed for: ${this.viewsPath}`);
              });
  
              if (this.debug) console.log(`[Watcher] Watching for file changes in: ${this.viewsPath}`);
          } catch (watchSetupError) {
              // Catch errors during the initial fs.watch setup call
              console.error("[Watcher] Error setting up file system watcher:", watchSetupError);
          }
      }
  
      // Register a directive.
      registerDirective(name, handler) {
          this.customDirectives[name] = handler;
      }
  
      // Register a plugin.
      registerPlugin(pluginFunction) {
          pluginFunction(this);
          this.plugins.push(pluginFunction);
      }
  
      // Register a filter.
      registerFilterOLD(name, fn) {
          this.filters[name] = fn;
          if (!this.helpers.filters) {
              this.helpers.filters = {};
          }
          // this.helpers.filters[name] = fn;
          this.helpers.filters[name] = fn; // UPDATED
          return this; // ADDED (chainable)
      } // ADDED
  
      // UPDATED (defensive guards; no removals)
      registerFilter(name, fn) {
          if (this.filters === undefined || this.filters === null || typeof this.filters !== "object") {
              this.filters = {}; // ADDED: ensure container
          }
          if (this.helpers === undefined || this.helpers === null || typeof this.helpers !== "object") {
              this.helpers = {}; // ADDED: ensure helpers
          }
          if (this.helpers.filters === undefined || this.helpers.filters === null || typeof this.helpers.filters !== "object") {
              this.helpers.filters = {}; // ADDED: ensure nested container
          }
          this.filters[name] = fn; // original line kept
          this.helpers.filters[name] = fn; // original line kept
          return this; // original line kept
      }
  
      // ADDED: public hook registration
      onHook(name, fn) {
          if (!this._knownHooks.has(name)) this._knownHooks.add(name);
          if (!this._hooks.has(name)) this._hooks.set(name, new Set());
          this._hooks.get(name).add(fn);
          return this;
      }
      // ADDED: remove hook
      offHook(name, fn) {
          const set = this._hooks.get(name);
          if (set) set.delete(fn);
          return this;
      }
      // ADDED: async runner (render path can await)
      async _runHooks(name, payload) {
          const set = this._hooks.get(name);
          if (!set || set.size === 0) return payload;
          let current = payload;
          for (const fn of set) {
              try {
                  const res = fn.length >= 2 ? await fn(current, this) : await fn(current);
                  if (res !== undefined) current = res;
              } catch (e) {
                  if (this.debug) console.warn(`[Hook:${name}] error:`, e.message);
              }
          }
          return current;
      }
      // ADDED: sync runner (compile path must remain sync)
      _runHooksSync(name, payload) {
          const set = this._hooks.get(name);
          if (!set || set.size === 0) return payload;
          let current = payload;
          for (const fn of set) {
              try {
                  const res = fn.length >= 2 ? fn(current, this) : fn(current);
                  if (res !== undefined) current = res;
              } catch (e) {
                  if (this.debug) console.warn(`[HookSync:${name}] error:`, e.message);
              }
          }
          return current;
      }
  
      /* ---------- DX convenience aliases ---------- */
  
      directive(name, handler) {
          return this.registerDirective(name, handler);
      } // ADDED
      filter(name, fn) {
          return this.registerFilter(name, fn);
      } // ADDED
  
      // Built-in Macro Plugin.
      registerMacroPlugin() {
          macroPluginRegistration(this);
      }
  
      // Built-in Component Plugin.
      registerComponentPlugin() {
          componentPluginRegistration(this);
      }
  
      // Macro loader.
      async loadMacros(filePath) {
          try {
              const content = await fs.promises.readFile(filePath, "utf8");
              const macroRegex = /@macro\s*\(\s*['"](.*?)['"]\s*\)([\s\S]*?)@endmacro/g;
              let match;
  
              while ((match = macroRegex.exec(content)) !== null) {
                  const macroName = match[1].trim();
                  const macroContent = match[2];
  
                  // Compile the macro template into a real function:
                  const { compiledFunc } = this.getCompiledTemplate(`macro:${macroName}`, macroContent);
  
                  // Register it under your macro name:
                  this.registerMacro(macroName, async (params = {}) => {
                      return await compiledFunc(
                          // 1) data
                          params,
                          // 2) helpers
                          this.helpers,
                          // 3) stacks
                          {},
                          // 4) macros (so nested macros still work)
                          this.macros,
                          // 5) engine instance
                          this,
                          // 6) extractedComponents
                          [],
                          // 7) sectionsMap
                          new Map(),
                          // 8) layoutSectionFuncs
                          {},
                          // 9) rawBlocks
                          []
                      );
                  });
              }
  
              if (this.debug) {
                  console.log("Macros loaded from file:", filePath, this.macros);
              }
          } catch (err) {
              console.error("Error loading macros from file:", err);
          }
      }
  
      // --- UPDATE loadMacrosFromDirectory ---
      async loadMacrosFromDirectory(dirPath) {
          try {
              const entries = await promises.readdir(dirPath, { withFileTypes: true });
              // Use Promise.all for potentially faster concurrent processing of directory entries
              await Promise.all(
                  entries.map(async (entry) => {
                      const fullPath = path.join(dirPath, entry.name);
                      if (entry.isDirectory()) {
                          await this.loadMacrosFromDirectory(fullPath); // Recursive call
                      } else if (entry.isFile() && entry.name.endsWith(this.viewExtension)) {
                          await this.loadMacros(fullPath); // Load macros from file
                      }
                  })
              );
  
              // if (this.debug) { // Optional success log per directory
              //     console.log(`[Macros] Successfully scanned for macros in: ${dirPath}`);
              // }
          } catch (err) {
              // --- Refined Error Handling for ENOENT ---
              if (err.code === "ENOENT") {
                  // The specific directory path for macros wasn't found.
                  if (this.debug) {
                      // Use console.warn for non-critical issues during development
                      console.warn(`[Macros] Warning: Macro directory not found: ${dirPath}. Attempting to create.`);
                  }
                  // Try creating just the specific missing directory.
                  await this.createDirectoryAsync(dirPath);
                  // After creation, the directory is likely empty. We probably don't need to
                  // re-attempt reading immediately within this load cycle.
                  // The directory will be present for subsequent operations or restarts.
              } else {
                  // Log other potential errors (permissions, etc.)
                  console.error(`[Macros] Error scanning/loading macros from directory ${dirPath}:`, err);
                  // Consider if these errors should halt the engine initialization
                  // throw err;
              }
              // --- End Refined Error Handling ---
          }
      }
  
      // New method to extract slot blocks from a component's content.
      extractSlots(componentContent) {
          let slots = {};
          // Regex to match @slot('name') ... @endslot
          const slotRegex = /@slot\s*\(\s*['"](.*?)['"]\s*\)([\s\S]*?)@endslot/g;
          // Remove slot blocks from componentContent while storing them.
          componentContent = componentContent.replace(slotRegex, (match, slotName, content) => {
              slots[slotName] = content.trim();
              return ""; // Remove the slot block from the main content.
          });
          return { content: componentContent.trim(), slots };
      }
  
      // Inside TemplateEngine class
  
      // --- Inside TemplateEngine class ---
  
      extractComponents(templateStr) {
          // Regex captures: 1=name, 2=optional props VARIABLE NAME (dot notation allowed), 3=content
          // Updated regex to only allow a variable name for the props argument.
          const compRegex = /@component\s*\(\s*['"](.*?)['"](?:,\s*(\b[_$a-zA-Z][\w$.]*\b))?\s*\)([\s\S]*?)@endcomponent/g;
          // Example matches: @component('card'), @component('card', myProps), @component('card', user.data.cardProps)
          // Does NOT match: @component('card', {title: 'x'})
  
          let index = 0;
          // Ensure instance array exists for storing component details for the current template
          // This should be handled/reset by compileTemplate correctly now.
          // if (!this._currentComponents) this._currentComponents = [];
  
          const finalTemplate = templateStr.replace(compRegex, (match, name, propsVarName, content) => {
              let { content: mainContent, slots } = this.extractSlots(content);
              // Store the variable name specified for props, or null if none.
              this._currentComponents.push({
                  name: name.trim(),
                  propsVarName: propsVarName ? propsVarName.trim() : null, // Store variable name string or null
                  content: mainContent, // Default slot content
                  slots: slots, // Named slots object
              });
              // Replace with a placeholder including the index
              return `@componentPlaceholder(${index++})`;
          });
          return finalTemplate; // Return template string with placeholders
      }
  
      // Extract sections.
      extractSections(templateStr, sections) {
          const sectionRegex = /@section\s*\(\s*['"](.*?)['"]\s*\)([\s\S]*?)@endsection/g;
          let match;
          while ((match = sectionRegex.exec(templateStr)) !== null) {
              let sectionName = match[1];
              // let sectionContent = match[2];
              if (yielded && !yielded.has(sectionName)) continue; // SKIP unused        // ADDED
              let sectionContent = match[2];
              sections[sectionName] = sectionContent;
          }
          return templateStr.replace(sectionRegex, "");
      }
  
      // Extract stacks.
      extractStacks(templateStr, stacks) {
          const pushRegex = /@push\s*\(\s*['"](.*?)['"]\s*\)([\s\S]*?)@endpush/g;
          let match;
          while ((match = pushRegex.exec(templateStr)) !== null) {
              let stackName = match[1];
              let content = match[2];
              if (!stacks[stackName]) {
                  stacks[stackName] = [];
              }
              stacks[stackName].push(content);
          }
          templateStr = templateStr.replace(pushRegex, "");
          const prependRegex = /@prepend\s*\(\s*['"](.*?)['"]\s*\)([\s\S]*?)@endprepend/g;
          while ((match = prependRegex.exec(templateStr)) !== null) {
              let stackName = match[1];
              let content = match[2];
              if (!stacks[stackName]) {
                  stacks[stackName] = [];
              }
              stacks[stackName].unshift(content);
          }
          return templateStr.replace(prependRegex, "");
      }
  
      /**
       * Retrieves a compiled template representation, potentially from cache or precompiled file.
       * If not found, compiles the template string dynamically.
       * Instantiates executable functions from code strings using new Function().
       * @param {string} templateName - The identifier/cache key for the template (usually relative path).
       * @param {string | null} templateStr - The template content string (needed for dynamic compilation fallback).
       * @returns {object} An object containing { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks }.
       * @throws {Error} If compilation fails or required data is missing.
       */
  
      // Inside TemplateEngine class
  
      /**
       * Retrieves a compiled template representation, potentially from cache or precompiled file.
       * If not found, compiles the template string dynamically using the refactored compileTemplate.
       * Instantiates executable functions from code strings using new Function().
       * @param {string} templateName - The identifier/cache key for the template (usually relative path).
       * @param {string | null} templateStr - The template content string (needed for dynamic compilation fallback).
       * @returns {object} An object containing { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks }.
       * @throws {Error} If compilation fails or required data is missing.
       */
      /**
       * Gets or compiles a template into executable functions.
       */
  
      /**
       * Gets or compiles a template into executable functions. (SYNC path)
       */
      getCompiledTemplate(templateName, templateStr = null) {
          const cacheKey = templateName;
  
          if (this.cacheEnabled) {
              const cachedResult = this.templateCache.get(cacheKey);
              if (cachedResult && typeof cachedResult.compiledFunc === "function") {
                  if (this.debug) console.log(`[Cache] HIT for template: ${templateName}`);
                  return cachedResult;
              }
          }
          if (this.debug) console.log(`[Cache] MISS for template: ${templateName}`);
  
          if (!templateStr) {
              templateStr = this.getTemplateContent(templateName);
          }
  
          const { mainCodeString, sectionDefinitions, extractedComponents, rawBlocks, layoutName } = this.compileTemplate(templateStr, templateName);
  
          // UPDATED — add 'rnv' param (per-render bag) at the end
          const mainFuncParams = [
              "data",
              "helpers",
              "stacks",
              "macros",
              "engineInstance",
              "extractedComponents",
              "sectionsMap",
              "layoutSectionFuncs",
              "rawBlocks",
              "rnv", // ADDED
          ];
  
          // Sections do not need 'rnv' unless you changed your @yield generator to pass it.
          // const sectionFuncParams = [
          //     "data",
          //     "helpers",
          //     "engineInstance",
          //     "parentSectionFunc",
          //     "rawBlocks",
          //     "extractedComponents"
          // ];
  
          const sectionFuncParams = ["data", "helpers", "engineInstance", "parentSectionFunc", "rawBlocks", "extractedComponents", "rnv"]; // ADDED
  
          // Make escapes + helpers available inside compiled scope (no globals needed)
          const setupCode =
              `const escapeHTML  = helpers.escapeHTML  || ${defaultEscape.toString()};\n` +
              `const escapeAttr  = helpers.escapeAttr  || ${escapeAttr.toString()};\n` +
              `const sanitizeUri = helpers.sanitizeUri || ${sanitizeUri.toString()};\n` +
              `const escapeJS    = helpers.escapeJS    || ${escapeJS.toString()};\n` +
              `const escapeCSS   = helpers.escapeCSS   || ${escapeCSS.toString()};\n` +
              `const filters     = helpers.filters     || {};\n` +
              `const __include   = engineInstance._include.bind(engineInstance);\n` +
              `const __includeComponent = engineInstance._includeComponent.bind(engineInstance);\n` +
              `const __flush     = (typeof rnv !== 'undefined' && rnv && rnv.__flush) ? rnv.__flush : null;\n`;
          // `const __flush     = rnv && rnv.__flush ? rnv.__flush : null;\n`;
  
          // UPDATED — include 'rnv' in the with-scope
          const wrapperStart = `return (async function() {\n` + `  try {\n` + `    with(Object.assign({}, data, helpers, { stacks, macros, layoutSectionFuncs, rawBlocks, rnv })) {\n`;
  
          // IMPORTANT — keep wrapperEnd defined
          const wrapperEnd = `\n    }\n` + `  } catch (err) { console.error('[RUNTIME ERROR in ${templateName.replace(/`/g, "\\`")}]', err); throw err; }\n` + `})();`;
  
          // Sections: do not need rnv unless you also change yield code to pass it
          // const sectionWrapperStart =
          //     `return (async function() {\n` +
          //     `  try {\n` +
          //     `    with(Object.assign({}, data, helpers, { rawBlocks })) {\n`;
          const sectionWrapperStart = `return (async function() {\n  try {\n    with(Object.assign({}, data, helpers, { rawBlocks, rnv })) {\n`; // ADDED
          const sectionWrapperEnd = `\n    }\n` + `  } catch (err) { console.error('[RUNTIME ERROR in Section]', err); throw err; }\n` + `})();`;
  
          // Build main compiled function
          const compiledFunc = new Function(...mainFuncParams, setupCode + wrapperStart + mainCodeString + wrapperEnd);
  
          // Build section functions
          const sectionFuncs = {};
          const sectionUsesParent = {};
          for (const name in sectionDefinitions) {
              sectionFuncs[name] = new Function(...sectionFuncParams, setupCode + sectionWrapperStart + sectionDefinitions[name].codeString + sectionWrapperEnd);
              sectionUsesParent[name] = sectionDefinitions[name].usesParent;
          }
  
          const finalResult = { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks, layoutName };
          if (this.cacheEnabled) {
              this.templateCache.set(cacheKey, finalResult);
          }
          return finalResult;
      }
  
      getCompiledTemplateOLD(templateName, templateStr = null) {
          const cacheKey = templateName;
          if (this.cacheEnabled) {
              const cachedResult = this.templateCache.get(cacheKey);
              if (cachedResult && typeof cachedResult.compiledFunc === "function") {
                  if (this.debug) console.log(`[Cache] HIT for template: ${templateName}`);
                  return cachedResult;
              }
          }
          if (this.debug) console.log(`[Cache] MISS for template: ${templateName}`);
  
          if (!templateStr) {
              templateStr = this.getTemplateContent(templateName);
          }
  
          const { mainCodeString, sectionDefinitions, extractedComponents, rawBlocks, layoutName } = this.compileTemplate(templateStr, templateName);
  
          // const mainFuncParams = ["data", "helpers", "stacks", "macros", "engineInstance", "extractedComponents", "sectionsMap", "layoutSectionFuncs", "rawBlocks"];
          // UPDATED — add 'rnv' as the last param to compiled function
          const mainFuncParams = [
              "data",
              "helpers",
              "stacks",
              "macros",
              "engineInstance",
              "extractedComponents",
              "sectionsMap",
              "layoutSectionFuncs",
              "rawBlocks",
              "rnv", // ADDED
          ];
          // const sectionFuncParams = ["data", "helpers", "engineInstance", "parentSectionFunc", "rawBlocks", "extractedComponents"];
          const sectionFuncParams = ["data", "helpers", "engineInstance", "parentSectionFunc", "rawBlocks", "extractedComponents"];
  
          // const setupCode = `const escapeHTML = helpers.escapeHTML || ((s) => String(s ?? '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"));\nconst filters = helpers.filters || {};\n`;
          // const setupCode =
          //     `const escapeHTML          = helpers.escapeHTML || ((s) => String(s ?? '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"));\n` +
          //     `const filters             = helpers.filters    || {};\n` +
          //     `// make the old-style include() helper available:\n` +
          //     `const __include           = engineInstance._include.bind(engineInstance);\n` +
          //     `const __includeComponent  = engineInstance._includeComponent.bind(engineInstance);\n`;
  
          // const wrapperStart = `return (async function() {\n  try {\n    with(Object.assign({}, data, helpers, { stacks, macros, layoutSectionFuncs, rawBlocks })) {\n`;
          // const wrapperEnd = `\n    }\n  } catch (err) { console.error('[RUNTIME ERROR in ${templateName.replace(/`/g, "\\`")}]', err); throw err; }\n})();`;
  
          // const sectionWrapperStart = `return (async function() {\n  try {\n    with(Object.assign({}, data, helpers, { rawBlocks })) {\n`;
          // const sectionWrapperEnd = `\n    }\n  } catch (err) { console.error('[RUNTIME ERROR in Section]', err); throw err; }\n})();`;
  
          // UPDATED — bring 'rnv' into the with-scope (per-render bag)
          const wrapperStart = `return (async function(){\n  try {\n` + `    with(Object.assign({}, data, helpers, { stacks, macros, layoutSectionFuncs, rawBlocks, rnv })) {\n`;
  
          // UPDATED — expose contextual escapes, sanitizer, and optional flush
          const setupCode =
              `const escapeHTML  = helpers.escapeHTML  || ${defaultEscape.toString()};\n` +
              `const escapeAttr  = helpers.escapeAttr  || ${escapeAttr.toString()};\n` +
              `const sanitizeUri = helpers.sanitizeUri || ${sanitizeUri.toString()};\n` +
              `const escapeJS    = helpers.escapeJS    || ${escapeJS.toString()};\n` +
              `const escapeCSS   = helpers.escapeCSS   || ${escapeCSS.toString()};\n` +
              `const filters     = helpers.filters     || {};\n` +
              `const __include   = engineInstance._include.bind(engineInstance);\n` +
              `const __includeComponent = engineInstance._includeComponent.bind(engineInstance);\n` +
              `const __flush     = rnv && rnv.__flush ? rnv.__flush : null;\n`;
  
          const compiledFunc = new Function(...mainFuncParams, setupCode + wrapperStart + mainCodeString + wrapperEnd);
  
          const sectionFuncs = {};
          const sectionUsesParent = {};
          for (const name in sectionDefinitions) {
              sectionFuncs[name] = new Function(...sectionFuncParams, setupCode + sectionWrapperStart + sectionDefinitions[name].codeString + sectionWrapperEnd);
              sectionUsesParent[name] = sectionDefinitions[name].usesParent;
          }
  
          const finalResult = { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks, layoutName };
  
          if (this.cacheEnabled) {
              this.templateCache.set(cacheKey, finalResult);
          }
          return finalResult;
      }
  
      /**
       * Async variant that can off‑load heavy compile work to the pool.
       */
      async getCompiledTemplateAsync(templateName) {
          // 1) Cache probe
          const cached = this.cacheEnabled ? this.templateCache.get(templateName) : null;
          if (cached) {
              if (this.debug) console.log(`[Cache] HIT (async) for template: ${templateName}`);
              return cached;
          }
  
          // 2) Load raw
          const templateStr = this._getTemplateSource(templateName);
  
          // 3) Decide worker vs main thread
          const useWorker = this.workerCompile && templateStr.length >= this.compileThresholdByte;
          let compileResult;
          if (useWorker) {
              if (this.debug) console.log(`[Worker] Off‑loading compile of ${templateName} (${templateStr.length} bytes)`);
              const hash = tmp_hash(templateStr);
              compileResult = await this._compilePool.compile(templateName, templateStr, hash);
          } else {
              compileResult = this.compileTemplate(templateStr, templateName);
          }
  
          const { mainCodeString, sectionDefinitions, extractedComponents, rawBlocks, layoutName } = compileResult;
  
          // UPDATED — add 'rnv' param
          const mainFuncParams = [
              "data",
              "helpers",
              "stacks",
              "macros",
              "engineInstance",
              "extractedComponents",
              "sectionsMap",
              "layoutSectionFuncs",
              "rawBlocks",
              "rnv", // ADDED
          ];
  
          const sectionFuncParams = ["data", "helpers", "engineInstance", "parentSectionFunc", "rawBlocks", "extractedComponents"];
  
          const setupCode =
              `const escapeHTML  = helpers.escapeHTML  || ${defaultEscape.toString()};\n` +
              `const escapeAttr  = helpers.escapeAttr  || ${escapeAttr.toString()};\n` +
              `const sanitizeUri = helpers.sanitizeUri || ${sanitizeUri.toString()};\n` +
              `const escapeJS    = helpers.escapeJS    || ${escapeJS.toString()};\n` +
              `const escapeCSS   = helpers.escapeCSS   || ${escapeCSS.toString()};\n` +
              `const filters     = helpers.filters     || {};\n` +
              `const __include   = engineInstance._include.bind(engineInstance);\n` +
              `const __includeComponent = engineInstance._includeComponent.bind(engineInstance);\n` +
              `const __flush     = rnv && rnv.__flush ? rnv.__flush : null;\n`;
  
          // Keep the async wrapper style you had, just include rnv
          const wrapperStart = `return (async function(){with(Object.assign({},data,helpers,{stacks,macros,layoutSectionFuncs,rawBlocks,rnv})){`;
          const wrapperEnd = `}})();`;
  
          const sectionWrapperStart = `return (async function(){with(Object.assign({},data,helpers,{rawBlocks})){`;
          const sectionWrapperEnd = `}})();`;
  
          // Build functions
          const compiledFunc = new Function(...mainFuncParams, setupCode + wrapperStart + mainCodeString + wrapperEnd);
  
          const sectionFuncs = {};
          const sectionUsesParent = {};
          for (const name in sectionDefinitions) {
              sectionFuncs[name] = new Function(...sectionFuncParams, setupCode + sectionWrapperStart + sectionDefinitions[name].codeString + sectionWrapperEnd);
              sectionUsesParent[name] = sectionDefinitions[name].usesParent;
          }
  
          const final = { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks, layoutName };
          if (this.cacheEnabled) this.templateCache.set(templateName, final);
          return final;
      }
  
      /**
       * Async variant that can off‑load heavy compile work to the pool.                  // ADDED
       */
      async getCompiledTemplateAsyncOLD(templateName) {
          // ADDED
          // 1. Try normal (sync) cache first                                               // ADDED
          const cached = this.cacheEnabled ? this.templateCache.get(templateName) : null; // ADDED
          if (cached) {
              // ADDED
              if (this.debug) console.log(`[Cache] HIT (async) for template: ${templateName}`); // ADDED
              return cached; // ADDED
          } // ADDED
          // ADDED
          // 2. Load raw text (could be cached in fileContentCache)                         // ADDED
          const templateStr = this._getTemplateSource(templateName); // ADDED
          // ADDED
          // 3. Decide whether to off‑load based on size threshold                          // ADDED
          const useWorker = this.workerCompile && templateStr.length >= this.compileThresholdByte; // ADDED
          // ADDED
          let compileResult; // ADDED
          // if (useWorker) {
          if (useWorker) {
              // ADDED
              if (this.debug) console.log(`[Worker] Off‑loading compile of ${templateName} (${templateStr.length} bytes)`); // ADDED
              //compileResult = await this._compilePool.compile(templateName, templateStr);    // ADDED
              const hash = tmp_hash(templateStr); // ADDED
              compileResult = await this._compilePool.compile(templateName, templateStr, hash); // ADDED
          } else {
              // ADDED
              compileResult = this.compileTemplate(templateStr, templateName); // ADDED
          } // ADDED
          // ADDED
          // 4. Build real functions on the main thread (can’t transfer functions).         // ADDED
          const { mainCodeString, sectionDefinitions, extractedComponents, rawBlocks, layoutName } = compileResult; // ADDED
          // ADDED
          // const mainFuncParams = ["data", "helpers", "stacks", "macros", "engineInstance", "extractedComponents", "sectionsMap", "layoutSectionFuncs", "rawBlocks"]; // ADDED
          // UPDATED — add 'rnv' as the last param to compiled function
          const mainFuncParams = [
              "data",
              "helpers",
              "stacks",
              "macros",
              "engineInstance",
              "extractedComponents",
              "sectionsMap",
              "layoutSectionFuncs",
              "rawBlocks",
              "rnv", // ADDED
          ];
          const sectionFuncParams = ["data", "helpers", "engineInstance", "parentSectionFunc", "rawBlocks", "extractedComponents"]; // ADDED
          // const setupCode = `const escapeHTML = helpers.escapeHTML || ((s)=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'));\nconst filters=helpers.filters||{};\nconst __include=engineInstance._include.bind(engineInstance);\nconst __includeComponent=engineInstance._includeComponent.bind(engineInstance);\n`; // ADDED
          // UPDATED — expose contextual escapes, sanitizer, and optional flush
          const setupCode =
              `const escapeHTML  = helpers.escapeHTML  || ${defaultEscape.toString()};\n` +
              `const escapeAttr  = helpers.escapeAttr  || ${escapeAttr.toString()};\n` +
              `const sanitizeUri = helpers.sanitizeUri || ${sanitizeUri.toString()};\n` +
              `const escapeJS    = helpers.escapeJS    || ${escapeJS.toString()};\n` +
              `const escapeCSS   = helpers.escapeCSS   || ${escapeCSS.toString()};\n` +
              `const filters     = helpers.filters     || {};\n` +
              `const __include   = engineInstance._include.bind(engineInstance);\n` +
              `const __includeComponent = engineInstance._includeComponent.bind(engineInstance);\n` +
              `const __flush     = rnv && rnv.__flush ? rnv.__flush : null;\n`;
          // const wrapperStart = `return (async function(){with(Object.assign({},data,helpers,{stacks,macros,layoutSectionFuncs,rawBlocks})){`; // ADDED
          // UPDATED — bring 'rnv' into the with-scope (per-render bag)
          const wrapperStart = `return (async function(){\n  try {\n` + `    with(Object.assign({}, data, helpers, { stacks, macros, layoutSectionFuncs, rawBlocks, rnv })) {\n`;
          const wrapperEnd = `}})();`; // ADDED
          const sectionWrapperStart = `return (async function(){with(Object.assign({},data,helpers,{rawBlocks})){`; // ADDED
          const sectionWrapperEnd = `}})();`; // ADDED
          // ADDED
          const compiledFunc = new Function(...mainFuncParams, setupCode + wrapperStart + mainCodeString + wrapperEnd); // ADDED
          const sectionFuncs = {}; // ADDED
          const sectionUsesParent = {}; // ADDED
          for (const name in sectionDefinitions) {
              // ADDED
              sectionFuncs[name] = new Function(...sectionFuncParams, setupCode + sectionWrapperStart + sectionDefinitions[name].codeString + sectionWrapperEnd); // ADDED
              sectionUsesParent[name] = sectionDefinitions[name].usesParent; // ADDED
          } // ADDED
          // ADDED
          const final = { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks, layoutName }; // ADDED
          if (this.cacheEnabled) this.templateCache.set(templateName, final); // ADDED
          return final; // ADDED
      } // ADDED
  
      /**
       * Helper to read template content from file.
       * @private
       */
  
      getTemplateContent(templateName) {
          // UPDATED
          /* Hot‑path optimisation: serve from mtime‑aware in‑memory cache. */ // UPDATED
          return this._getTemplateSource(templateName); // UPDATED
      }
  
      // Inside TemplateEngine class
      // Inside TemplateEngine class
      /**
       * Renders a template and returns the complete HTML string (buffered).
       * This is the main orchestrator for handling layouts and sections.
       */
  
      /**
       * Renders a template and returns the complete HTML string (buffered).
       * This is the main orchestrator for handling layouts and sections.
       */
      async render(templateNameOrPath, data = {}, inheritedSectionsMap = new Map()) {
          const initialTemplateNameForErrors = templateNameOrPath;
          data.__currentTpl = initialTemplateNameForErrors; // ADDED (existing line kept)
          if (this.debug) console.log(`[Render] Starting: ${initialTemplateNameForErrors}`);
  
          // --- THIS IS THE KEY CHANGE (PART 1) ---
          // 1. Merge global data (.share()) with the local data.
          //    Data passed directly to render() overrides globals.
          const finalData = { ...this.globals, ...data }; // (existing from your file)
          // --- END OF CHANGE ---
  
          // Ensure macros are loaded before any rendering proceeds
          if (this._macrosLoadedPromise) {
              await this._macrosLoadedPromise;
          }
  
          // ADDED — beforeRender (async hook)
          try {
              if (typeof this._runHooks === "function") {
                  await this._runHooks("beforeRender", {
                      templateName: initialTemplateNameForErrors,
                      data: finalData,
                  });
              }
          } catch (e) {
              if (this.debug) console.warn("[Hook:beforeRender] error:", e.message);
          }
          // END ADDED
  
          try {
              // Normalize the template name to be relative to the views path
              let resolvedTemplateName;
              if (path.isAbsolute(templateNameOrPath)) {
                  resolvedTemplateName = path.relative(this.viewsPath, templateNameOrPath);
              } else {
                  resolvedTemplateName = templateNameOrPath;
              }
              resolvedTemplateName = resolvedTemplateName.replace(/\\/g, "/");
              if (resolvedTemplateName.endsWith(this.viewExtension)) {
                  resolvedTemplateName = resolvedTemplateName.slice(0, -this.viewExtension.length);
              } // ADDED
  
              /* Use worker pool if enabled, compilation needed and template is “big”. */
              const compileGetter = this.workerCompile ? this.getCompiledTemplateAsync.bind(this) : this.getCompiledTemplate.bind(this);
  
              const { compiledFunc, sectionFuncs, sectionUsesParent, extractedComponents, rawBlocks, layoutName } = await compileGetter(resolvedTemplateName);
  
              if (layoutName) {
                  const sectionsToPassUp = new Map(inheritedSectionsMap);
  
                  // Wrap each section so it always sees the child’s blocks & components
                  for (const name in sectionFuncs) {
                      const original = sectionFuncs[name];
                      const childRawBlocks = rawBlocks;
                      const childComponents = extractedComponents;
                      const boundSectionFunc = (...args) => {
                          // args: [data, helpers, engineInstance, parentSectionFunc, rawBlocks, extractedComponents, rnv?]
                          const maybeRnv = args.length >= 7 ? args[6] : undefined; // ADDED
                          return original(
                              args[0],
                              args[1],
                              args[2],
                              args[3],
                              /* force child’s */ childRawBlocks,
                              childComponents,
                              maybeRnv // ADDED
                          );
                      };
  
                      // const boundSectionFunc = (...args) => {
                      //     // args: [data, helpers, engineInstance, parentSectionFunc]
                      //     return original(args[0], args[1], args[2], args[3], /* force child’s */ childRawBlocks, childComponents);
                      // };
                      sectionsToPassUp.set(name, {
                          func: boundSectionFunc,
                          sourceTemplate: resolvedTemplateName,
                          usesParent: sectionUsesParent[name],
                      });
                  }
  
                  const currentStacks = {};
                  this.extractStacks(this.getTemplateContent(resolvedTemplateName), currentStacks);
  
                  // UPDATED — use finalData so globals also flow into the layout
                  const layoutData = {
                      ...finalData, // UPDATED
                      stacks: mergeStacks(finalData.stacks || {}, currentStacks), // UPDATED
                  };
  
                  // NOTE: afterRender is handled at the leaf render; we return the layout’s result.
                  return await this.render(layoutName, layoutData, sectionsToPassUp);
              } else {
                  const finalSectionsMap = new Map(inheritedSectionsMap);
                  for (const name in sectionFuncs) {
                      if (!finalSectionsMap.has(name)) {
                          finalSectionsMap.set(name, {
                              func: sectionFuncs[name],
                              sourceTemplate: resolvedTemplateName,
                              usesParent: sectionUsesParent[name],
                          });
                      }
                  }
  
                  const currentStacks = {};
                  this.extractStacks(this.getTemplateContent(resolvedTemplateName), currentStacks);
  
                  // UPDATED — merge stacks using finalData (so globals are preserved)
                  const mergedStacks = mergeStacks(finalData.stacks || {}, currentStacks); // UPDATED
  
                  // ADDED — per-render bag for islands & (optionally) streaming flush
                  const rnv = {
                      islands: [],
                      nonce: this.cspNonceFn ? this.cspNonceFn(finalData) : null,
                      __flush: null, // (renderStream will set this; buffered mode leaves null)
                      registerIsland: function (rec) {
                          this.islands.push(rec);
                      },
                  };
                  // END ADDED
  
                  // UPDATED — pass finalData and rnv as the last argument
                  const executionArgs = [
                      finalData, // UPDATED (was: data)
                      this.helpers,
                      mergedStacks,
                      this.macros || {},
                      this,
                      extractedComponents,
                      finalSectionsMap,
                      sectionFuncs,
                      rawBlocks,
                      rnv, // ADDED
                  ];
  
                  const html = await compiledFunc(...executionArgs);
  
                  // Keep your existing stack diagnostics intact
                  if (this.debug && mergedStacks) {
                      const usedStacks = executionArgs[2];
                      for (const key of Object.keys(mergedStacks)) {
                          if (!usedStacks[key]?.length) {
                              console.warn(`[Stack] '${key}' was pushed/prepended but never @stack‑ed in '${resolvedTemplateName}'.`);
                          }
                      }
                  }
  
                  // ADDED — append islands runtime if any islands were registered
                  let finalHtml = html; // ADDED
                  if (rnv.islands.length) {
                      // ADDED
                      finalHtml += this._emitIslandsRuntime(rnv); // ADDED
                  } // ADDED
  
                  // ADDED — afterRender (async hook)
                  try {
                      if (typeof this._runHooks === "function") {
                          await this._runHooks("afterRender", {
                              templateName: initialTemplateNameForErrors,
                              islands: rnv.islands.length,
                              htmlLength: finalHtml.length,
                          });
                      }
                  } catch (e) {
                      if (this.debug) console.warn("[Hook:afterRender] error:", e.message);
                  }
                  // END ADDED
  
                  return finalHtml; // UPDATED (was: return html)
              }
          } catch (err) {
              console.error(`[Render Error] Failed to render "${initialTemplateNameForErrors}":`, err.message);
              throw new Error(`Failed to render template "${initialTemplateNameForErrors}": ${err.message}`, { cause: err });
          }
      }
  
      /* ---------------------------------------------------------------
       *  Phase-out tokenizer: when disabled we use legacy regexes.
  
      // Inside TemplateEngine class
  
      /**
       * Compiles a template string into executable code strings for the main body
       * and any defined sections. Handles component placeholders and raw blocks.
       * @param {string} template - The raw template string content.
       * @param {string} templateName - Identifier for the template (for error messages).
       * @returns {{ mainCodeString: string, sectionDefinitions: object, extractedComponents: object[], rawBlocks: string[] }}
       * An object containing the compiled code string for the main body,
       * an object mapping section names to their { codeString, usesParent } definitions,
       * an array of extracted component info, and an array of raw block contents.
       * @throws {Error} If compilation fails.
       */
      /**
       * Primary compiler. Orchestrates extraction and code generation.
       */
      compileTemplate(template, templateName) {
          if (this.debug) console.log(`[Compile] Starting: ${templateName}`); // existing
  
          /* ---------------------------------------------------------------
           *  RNV-NEXT: fast-path caches & hooks (BEGIN)
           * ------------------------------------------------------------- */
          // Allow plugins to tweak source or name before we do anything.
          try {
              if (typeof this._runHooksSync === "function") {
                  const hookIn = this._runHooksSync("beforeCompile", { template, templateName });
                  if (hookIn && typeof hookIn === "object") {
                      template = hookIn.template ?? template;
                      templateName = hookIn.templateName ?? templateName;
                  }
              }
          } catch (e) {
              if (this.debug) console.warn("[HookSync:beforeCompile] error:", e.message);
          }
  
          // Helpers for cached tokenizer/AST/codegen (only used when tokenizer is enabled)
          const computeHash = this.useTokenizer ? /* TODO dynamic require → await import("./modules/parser/utils/hash".js) */ /* TODO dynamic require → await import("./modules/parser/utils/hash".js) */ require("./modules/parser/utils/hash") : null; // RNV-NEXT
  
          // Cached token getter
          const getTokens = (src) => {
              // RNV-NEXT
              if (!this.useTokenizer) return null;
              const h = computeHash(src);
              const hit = this.tokenCache?.get(h);
              if (hit) return hit;
  
              // beforeTokenize hook can transform the source
              let input = src;
              try {
                  if (typeof this._runHooksSync === "function") {
                      const r = this._runHooksSync("beforeTokenize", { templateName, template: src });
                      if (r && typeof r === "object" && typeof r.template === "string") input = r.template;
                  }
              } catch (e) {
                  if (this.debug) console.warn("[HookSync:beforeTokenize] error:", e.message);
              }
  
              const t = tokenize(input);
              this.tokenCache && this.tokenCache.set(h, t);
  
              try {
                  if (typeof this._runHooksSync === "function") {
                      this._runHooksSync("afterTokenize", { templateName, tokens: t });
                  }
              } catch (e) {
                  if (this.debug) console.warn("[HookSync:afterTokenize] error:", e.message);
              }
              return t;
          };
  
          // Cached AST getter
          const getAst = (src) => {
              // RNV-NEXT
              if (!this.useTokenizer) return null;
              const h = computeHash(src);
              const aHit = this.astCache?.get(h);
              if (aHit) return aHit;
              const toks = getTokens(src) || tokenize(src); // fallback
              const a = buildAST(toks);
              this.astCache && this.astCache.set(h, a);
              return a;
          };
  
          // Cached codegen (JS string) getter
          const getCodeFrom = (src, opts) => {
              // RNV-NEXT
              if (!this.useTokenizer) {
                  // Legacy path uses your regex-based generator elsewhere; we only call this when tokenizer is ON.
                  return generateJS(buildAST(tokenize(src)), opts);
              }
              const id = src + "::" + (opts?.templateName || "");
              const h = computeHash(id);
              const cHit = this.codegenCache?.get(h);
              if (cHit) return cHit;
              const code = generateJS(getAst(src), opts);
              this.codegenCache && this.codegenCache.set(h, code);
              return code;
          };
  
          // (Optional) dev log of token count using the cache
          if (this.useTokenizer && this.debug) {
              // UPDATED from your original debug block
              try {
                  const dbgTokens = getTokens(template);
                  console.log(`[Tokenizer] ${dbgTokens.length} tokens generated for ${templateName}`);
              } catch (_) {}
          }
          /* ---------------------------------------------------------------
           *  RNV-NEXT: fast-path caches & hooks (END)
           * ------------------------------------------------------------- */
  
          // ====== your existing logic below remains, with tiny replacements ======
  
          // Legacy raw‑block handling remains for now
          const rawBlocks = [];
          let processedTemplate = template.replace(/@raw([\s\S]*?)@endraw/gs, (match, content) => {
              rawBlocks.push(content);
              return `__RAW_BLOCK__${rawBlocks.length - 1}__`;
          });
  
          this._currentComponents = [];
          processedTemplate = this.extractComponents(processedTemplate);
          const extractedComponents = this._currentComponents;
          this._currentComponents = [];
  
          const layoutMatch = processedTemplate.match(/@extends\s*\(\s*['"](.*?)['"]\s*\)/);
          const layoutName = layoutMatch ? layoutMatch[1] : null; // existing
  
          /* collect yields from parent layout so we only keep sections that are used */
          let yielded = null; // existing
          if (layoutName && this.useTokenizer) {
              // existing
              try {
                  const parentStr = this._getTemplateSource(layoutName); // existing
                  // RNV-NEXT: use cached tokenize for parent
                  const parentToks = getTokens(parentStr) || tokenize(parentStr);
                  yielded = new Set(parentToks.filter((t) => t.type === "DIRECTIVE" && t.name === "yield").map((t) => t.args.replace(/^['"]|['"]$/g, "")));
              } catch (e) {
                  yielded = null;
              }
          }
          if (layoutName) {
              processedTemplate = processedTemplate.replace(layoutMatch[0], "").trim();
              const deps = this._depGraph.get(templateName) || new Set();
              deps.add(layoutName);
              this._depGraph.set(templateName, deps);
              this._depDirty = true;
          }
  
          const sectionDefinitions = {}; // existing
          const parentRegex = /@parent/; // existing
  
          const mainBodyTemplate = processedTemplate.replace(/@section\s*\(\s*['"](.*?)['"]\s*\)([\s\S]*?)@endsection/gs, (_, sectionName, sectionContent) => {
              const usesParent = parentRegex.test(sectionContent);
  
              // Keep your section-level hot cache by content hash
              const hash = tmp_hash(sectionContent);
              const cached = this._sectionCache.get(hash);
              if (cached) {
                  sectionDefinitions[sectionName] = cached;
              } else {
                  // RNV-NEXT: swap direct generateJS(...) with cached getCodeFrom(...)
                  const codeString = this.useTokenizer
                      ? getCodeFrom(sectionContent, { engine: this, templateName }) // RNV-NEXT
                      : this._generateCodeForTemplateBody(sectionContent, `section:${templateName}:${sectionName}`, "rawBlocks", true);
                  const def = { codeString, usesParent };
                  this._sectionCache.set(hash, def);
                  sectionDefinitions[sectionName] = def;
              }
              return "";
          });
  
          // RNV-NEXT: when tokenizer is on, get main body code from the codegen cache
          const usedStackSet = new Set(); // existing
          const mainCodeString = this.useTokenizer
              ? getCodeFrom(mainBodyTemplate, { engine: this, templateName, usedStacks: usedStackSet }) // RNV-NEXT
              : this._generateCodeForTemplateBody(mainBodyTemplate, templateName, "rawBlocks", false);
  
          // RNV-NEXT: post-compile hook (sync)
          try {
              if (typeof this._runHooksSync === "function") {
                  this._runHooksSync("afterCompile", {
                      templateName,
                      layoutName,
                      sectionCount: Object.keys(sectionDefinitions).length,
                  });
              }
          } catch (e) {
              if (this.debug) console.warn("[HookSync:afterCompile] error:", e.message);
          }
  
          return { mainCodeString, sectionDefinitions, extractedComponents, rawBlocks, layoutName };
      }
  
      // Inside TemplateEngine class compileTemplate method
  
      // Optional Helper to recursively find all view files
      async findAllViewFiles(startPath, currentPath = "", files = []) {
          const absolutePath = path.join(startPath, currentPath);
          try {
              const entries = await promises.readdir(absolutePath, { withFileTypes: true });
              await Promise.all(
                  entries.map(async (entry) => {
                      const entryRelativePath = path.join(currentPath, entry.name).replace(/\\/g, "/"); // Use POSIX paths
                      if (entry.isDirectory()) {
                          await this.findAllViewFiles(startPath, entryRelativePath, files);
                      } else if (entry.isFile() && entry.name.endsWith(this.viewExtension)) {
                          files.push(entryRelativePath);
                      }
                  })
              );
          } catch (err) {
              // Handle cases where a directory might not exist during scan
              if (err.code !== "ENOENT") {
                  console.error(`Error scanning directory ${absolutePath}: ${err.message}`);
              } else {
                  if (this.debug) console.log(`Directory not found during scan, skipping: ${absolutePath}`);
              }
          }
          return files;
      }
  
      async precompileAll() {
          // Use a distinct directory for precompiled output
          const compiledDir = path.join(process.cwd(), "compiled_views");
          console.log(`[Precompile] Starting precompilation into: ${compiledDir}`);
  
          try {
              await promises.mkdir(compiledDir, { recursive: true });
  
              // Find all template files recursively
              const viewFiles = await this.findAllViewFiles(this.viewsPath);
              console.log(`[Precompile] Found ${viewFiles.length} template files to process.`);
  
              let successCount = 0;
              let failCount = 0;
  
              for (const relativePath of viewFiles) {
                  const fullPath = path.join(this.viewsPath, relativePath);
                  const templateName = relativePath; // Use relative path as identifier
  
                  if (this.debug) console.log(`[Precompile] Processing: ${templateName}`);
  
                  try {
                      const templateStr = await promises.readFile(fullPath, "utf8");
  
                      // Compile using the NEW refactored compileTemplate
                      const {
                          mainCodeString, // Get main code
                          sectionDefinitions, // Get section definitions
                          extractedComponents, // Get components
                          rawBlocks, // Get raw blocks
                      } = this.compileTemplate(templateStr, templateName); // Pass templateName
  
                      // *** UPDATED Output Data Structure ***
                      const outputData = {
                          mainCodeString: mainCodeString, // Save main code string
                          sectionDefinitions: sectionDefinitions, // Save section definitions object
                          components: extractedComponents || [], // Save components array (ensure consistent naming)
                          rawBlocks: rawBlocks || [], // Save raw blocks array
                      };
  
                      // Prepare output path (e.g., compiled_views/pages/home.rnv.js)
                      const outFile = path.join(compiledDir, relativePath + ".js");
                      // ... (rest of directory creation, stringify, write file) ...
                      const moduleCode = `// Precompiled template data for: ${templateName}\nexport default ${JSON.stringify(outputData, null, 2)};`;
                      await promises.writeFile(outFile, moduleCode, "utf8");
                      // ... (logging) ...
                      successCount++;
                      //
                  } catch (compileError) {
                      failCount++;
                      // Log specific compilation errors for each file
                      console.error(`\n[Precompile] FAILED to compile ${templateName}: ${compileError.message}`);
                      // Optionally log the stack trace for more detail
                      // console.error(compileError.stack);
                      // Log the problematic code string if available from the error (our modified compileTemplate should throw it)
                      if (compileError.cause && compileError.message.includes("Generated code")) {
                          console.error("--- Failing Code String ---");
                          console.error(compileError.message.substring(compileError.message.indexOf("Generated code:") + 15));
                          console.error("--- End Failing Code ---");
                      }
                  }
              }
              console.log(`[Precompile] Precompilation finished. ${successCount} succeeded, ${failCount} failed.`);
          } catch (err) {
              // Catch errors related to setup (reading directories, etc.)
              console.error(`[Precompile] Error during precompilation process:`, err);
          }
      }
  
      // ADDED: emit minimal client runtime + manifest
      _emitIslandsRuntime(rnv) {
          const nonceAttr = rnv.nonce ? ` nonce="${String(rnv.nonce)}"` : "";
          const manifest = JSON.stringify(rnv.islands);
          // Tiny runtime: no deps, handles load/idle/visible/interaction
          const runtime = `<script${nonceAttr}>(function(){
    var M=${manifest};
    if(!M||!M.length)return;
    function h(mod,el,props){
      if(!mod||!mod.default) return;
      try{ mod.default(el, props||{}); }catch(e){ console.error('[RNV] hydrate error',e); }
    }
    function lazy(cb){ if('requestIdleCallback' in window) requestIdleCallback(cb); else setTimeout(cb,0); }
    function onVisible(el,fn){
      if(!('IntersectionObserver' in window)) return fn();
      var io=new IntersectionObserver(function(es){
        es.forEach(function(e){ if(e.isIntersecting){ io.disconnect(); fn(); }});
      });
      io.observe(el);
    }
    M.forEach(function(rec){
      var el=document.getElementById(rec.id); if(!el) return;
      var props={}; try{ props=JSON.parse(el.getAttribute('data-rnv-props')||'{}'); }catch(_){}
      function mount(){ if(!rec.src){ console.warn('[RNV] missing src for',rec.name); return; }
        var d=document.createElement('script'); d.type='module';
        d.textContent="import * as m from '"+rec.src+"'; window.__rnv_hydrate && __rnv_hydrate('"+rec.id+"', m);";
        document.head.appendChild(d);
      }
      switch(rec.strategy){
        case 'load': return mount();
        case 'idle': return lazy(mount);
        case 'visible': return onVisible(el, mount);
        case 'interaction': 
          if(!rec.on) rec.on='click';
          el.addEventListener(rec.on, function once(){ el.removeEventListener(rec.on, once); mount(); });
          return;
        default: return lazy(mount);
      }
    });
    // bridge for module scripts to call back
    window.__rnv_hydrate=function(id,mod){
      var el=document.getElementById(id); if(!el) return;
      var props={}; try{ props=JSON.parse(el.getAttribute('data-rnv-props')||'{}'); }catch(_){}
      h(mod, el, props);
    }
  })();</script>`;
          return runtime;
      }
  }
  
  // --- Add this helper function (can be outside the class or static) ---
  /**
   * Safely retrieves a nested property from an object using a dot-notation string path.
   * @param {object} obj The object to query.
   * @param {string} path Dot-notation path (e.g., 'user.details.name').
   * @returns {*} The value found at the path, or undefined if path is invalid or not found.
   */
  function getPropertySafely(obj, path) {
      if (!path || typeof path !== "string" || !obj) {
          return undefined;
      }
      const keys = path.split(".");
      let current = obj;
      for (const key of keys) {
          if (current === null || typeof current !== "object") {
              return undefined; // Path is invalid
          }
          current = current[key]; // Move deeper
          if (current === undefined) {
              return undefined; // Property not found at this level
          }
      }
      return current; // Return the final value
  }
  
  // Default HTML escape function.
  function defaultEscape(html) {
      return String(html).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  
  // ADDED: attribute-safe escape
  function escapeAttr(v) {
      const s = String(v ?? "");
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
  }
  
  // ADDED: strict URI sanitizer (http(s), mailto, tel only)
  function sanitizeUri(v) {
      const s = String(v ?? "").trim();
      const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
      if (!m) return encodeURI(s); // relative URL: safe to encode
      const scheme = m[1].toLowerCase();
      if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") {
          return encodeURI(s);
      }
      return "#"; // drop dangerous schemes (javascript:, data:, vbscript:, etc.)
  }
  
  // ADDED: minimal JS/CSS escapers for inlined contexts (keep them tiny)
  function escapeJS(v) {
      const s = String(v ?? "");
      return s
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/"/g, '\\"')
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029")
          .replace(/\r/g, "\\r")
          .replace(/\n/g, "\\n")
          .replace(/\t/g, "\\t");
  }
  function escapeCSS(v) {
      const s = String(v ?? "");
      // Escape anything not alnum; keep it short and safe for style attributes
      return s.replace(/[^a-zA-Z0-9]/g, function (ch) {
          const hex = ch.charCodeAt(0).toString(16).toUpperCase();
          return "\\" + hex + " ";
      });
  }
  
  // Utility function to merge stacks.
  function mergeStacks(parentStacks, childStacks) {
      const result = {};
      if (parentStacks) {
          for (let key in parentStacks) {
              result[key] = parentStacks[key].slice();
          }
      }
      if (childStacks) {
          for (let key in childStacks) {
              if (result.hasOwnProperty(key)) {
                  result[key] = result[key].concat(childStacks[key]);
              } else {
                  result[key] = childStacks[key].slice();
              }
          }
      }
      return result;
  } // ADDED
  
  /* === New code, add anywhere after `export default TemplateEngine;` === */ TemplateEngine.prototype._getTemplateSource = function (templateName) {
      // ADDED
      const filePath = path.join(this.viewsPath, templateName + this.viewExtension); // ADDED
      const cacheKey = templateName; // ADDED
      try {
          // ADDED
          const stat = fs.statSync(filePath); // ADDED
          // const cached = this.fileContentCache.get(cacheKey);                       // ADDED
          const cache = this.fileContentCache; // ADDED
          const cached = cache ? cache.get(cacheKey) : undefined; // ADDED
          if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content; // ADDED
          const content = fs.readFileSync(filePath, "utf8").replace(/\\/g, "/"); // ADDED
          // this.fileContentCache.set(cacheKey, { content, mtimeMs: stat.mtimeMs });  // ADDED
          cache && cache.set(cacheKey, { content, mtimeMs: stat.mtimeMs }); // ADDED
          return content; // ADDED
      } catch (err) {
          // ADDED
          if (err.code === "ENOENT")
              // ADDED
              throw new Error(`Template file not found: "${templateName}" at ${filePath}`); // ADDED
          throw err; // ADDED
      } // ADDED
  }; // ADDED
  
  export default TemplateEngine;
  
  
})();