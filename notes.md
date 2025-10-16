1. redeclaring import 


2. converting this: module.exports.create = createTokenizer; // ADDED

// expose TOKEN alongside the function export                                              // ADDED
module.exports.TOKEN = TOKEN; // ADDED to this:  module.export const create = createTokenizer; // ADDED

// expose TOKEN alongside the function export                                              // ADDED
module.export const TOKEN = TOKEN; // ADDED


3. converts this: module.exports.async = async function buildASTAsync(asyncTokens, options) {
    // ADDED
    const opts = normalizeOptions(options); // ADDED
    const highWaterMark = (options && options.highWaterMark) || 8192; // ADDED
    const body = []; // ADDED
    const errors = []; // ADDED

    let count = 0; // ADDED
    for await (const t of asyncTokens) {
        // ADDED
        // Reuse the sync builder per-token by feeding a 1-item iterable               // ADDED
        const partial = module.exports([t], { ...opts }); // ADDED
        for (const n of partial.body) body.push(n); // ADDED
        if (partial.errors && partial.errors.length) errors.push(...partial.errors); // ADDED

        count++; // ADDED
        if (count >= highWaterMark) {
            // ADDED
            count = 0; // ADDED
            await new Promise((r) => setImmediate(r)); // yield to event loop                // ADDED
        } // ADDED
    } // ADDED

    // Final pass to apply pipeline once on whole body                                 // ADDED
    return module.exports(body, options); // ADDED
}; // ADDED
 to this: 


 module.export const async = async function buildASTAsync(asyncTokens, options) {
    // ADDED
    const opts = normalizeOptions(options); // ADDED
    const highWaterMark = (options && options.highWaterMark) || 8192; // ADDED
    const body = []; // ADDED
    const errors = []; // ADDED

    let count = 0; // ADDED
    for await (const t of asyncTokens) {
        // ADDED
        // Reuse the sync builder per-token by feeding a 1-item iterable               // ADDED
        const partial = module.exports([t], { ...opts }); // ADDED
        for (const n of partial.body) body.push(n); // ADDED
        if (partial.errors && partial.errors.length) errors.push(...partial.errors); // ADDED

        count++; // ADDED
        if (count >= highWaterMark) {
            // ADDED
            count = 0; // ADDED
            await new Promise((r) => setImmediate(r)); // yield to event loop                // ADDED
        } // ADDED
    } // ADDED

    // Final pass to apply pipeline once on whole body                                 // ADDED
    return module.exports(body, options); // ADDED
}; // ADDED
