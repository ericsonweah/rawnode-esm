
// Required for http.METHODS if not already globally available in the file
const http = require('http'); 

// Define this class within your UltraFastServer file or import it

class Route {
    /**
     * Represents a specific route path and manages its handlers/middleware.
     * @param {string} path - The route path string.
     * @param {UltraFastServer} serverInstance - A reference back to the main server.
     */
    constructor(path, serverInstance) {
        this.path = path;
        this.server = serverInstance; // Needed to call server.addRoute later
        // Stores middleware added via route.use()
        this.routeMiddleware = []; 
        // Add HTTP methods dynamically
        this._addMethods();
    }

    /**
     * Adds middleware specific to this Route instance (runs for all methods on this path).
     * @param {...Function} handlers - Middleware functions (req, res, next).
     * @returns {this} - The Route instance for chaining.
     */
    use(...handlers) {
        handlers.forEach(handler => {
            if (typeof handler === 'function' && handler.length !== 4) {
                this.routeMiddleware.push(handler); // Store original function
            } else {
                 console.warn(`[Route.use Warning] Invalid middleware passed for path "${this.path}".`);
            }
        });
        return this; // Enable chaining: route.use(mw1).use(mw2)...
    }

    /**
     * Internal helper to dynamically add .get(), .post(), etc. methods.
     * @private
     */
    _addMethods() {
        http.METHODS.forEach(method => {
            const lowerCaseMethod = method.toLowerCase();
            
            /** Dynamically created method (e.g., .get, .post) */
            this[lowerCaseMethod] = (...methodHandlers) => {
                // Combine route-level middleware with method-specific handlers
                // Order: route.use() middleware first, then method-specific handlers
                const allHandlers = [
                    ...this.routeMiddleware, 
                    ...methodHandlers
                ];

                // Validate all handlers are functions before registering
                allHandlers.forEach((h, i) => { 
                    if(typeof h !== 'function') throw new Error(`Invalid handler at index ${i} for ${method} ${this.path}`);
                });

                // Register the combined chain with the main server router
                // Pass the original functions; server.addRoute will handle binding
                this.server.addRoute(method, this.path, ...allHandlers); 
                
                return this; // Enable chaining: route.get(h1).post(h2)...
            };
        });
    }
}
// Export the Route class for use in other modules
module.exports = Route;


// Need to add '.all()' to the Route class for Express parity with param handling
Route.prototype.all = function(...handlers) {
    // Treat '.all' like '.use' - add middleware that runs for any method on this route path
    // OR, less common, register handlers for ALL http methods (more complex).
    // Let's make it alias .use for adding middleware BEFORE method handlers.
    this.use(...handlers); 
    return this;
}

