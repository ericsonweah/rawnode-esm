const { EventEmitter } = require("events");
const crypto = require("crypto"); // Ensure this is at the top of your file
const fs = require("fs");
const path = require("path");
class Sample extends EventEmitter {
    constructor(...args) {
        super();
        // Assign additional options to the Transformer class
        args.forEach((option) => {
            if (Object.keys(option).length > 0) {
                Object.keys(option).forEach((key) => {
                    if (!this[key] && Object.prototype.toString.call(option) === "[object Object]") this[key] = option[key];
                });
            }
        });
        if (!this.cache || typeof this.cache !== "object") this.cache = {}; // Ensure in-memory cache is an object
        if (!this.filters) this.filters = {}; // Default directory for cached files on disk
        if (!this.tags || typeof this.tags !== "object") this.tags = {}; // Ensure custom tags is an object
        if (!this.globalContext || typeof this.globalContext !== "object") this.globalContext = {};
    }
}
module.exports = Sample;
