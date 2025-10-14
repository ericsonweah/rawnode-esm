Improve this prompt for the best possible outcome "I have implemented run.js, the main run module for  rawnode-esm module.  It works great as it is right now but I want to take it to the next level: making it for feature reached, advanced, performant, hooks, plugins, extensibility, and importantly non-event-loop blocking, etc. 


I want it to do not only the following but far much more t: 
1. Convert entire codebases (like RawNode’s backend) from CommonJS to modern ESM.
2. Understand *real-world* patterns beyond what any existing tool handles.
3. Operate deterministically, without external packages or AST toolchains. 

* Detect `require()` scope automatically (top-level vs local).
* Identify directory vs file imports through stat caching.
* Preserve formatting and comments (string-aware replacements).
* Gracefully handle conditional exports (e.g., environment-specific).

 I also want it to be very use (developer) friendly with a very fluent api that is a easier and a joy to work with. I also want simplicity and elegance (beauty, easier to read, and pleasure and inspiration to look at) without trading off performance. Can you help expend it, push the boundaries, add every needful thing, and take it to the next level?