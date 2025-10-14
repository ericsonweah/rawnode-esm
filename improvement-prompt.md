You know, in commonjs when we have things like these: 

```js
const SimpleLRUCache = require("./modules/caches/simple-lru-cache");
const tokenize = require("./modules/parser/tokenizer"); // ADDED

const buildAST = require("./modules/parser/ast-builder"); // ADDED
const generateJS = require("./modules/parser/codegen"); // ADDED
```
taking this const SimpleLRUCache = require("./modules/caches/simple-lru-cache"); as an example

it means at least one of the then two things
 case 1. the actually file is ./modules/caches/simple-lru-cache.js 
 case 2. or ./modules/caches/simple-lru-cache/index.js

Knowing this then, our conversion from commonjs to esm becomes a little tricky. So for this: 
const SimpleLRUCache = require("./modules/caches/simple-lru-cache") we have two possible ways.

We can produce this (convert it to this): const SimpleLRUCache = require("./modules/caches/simple-lru-cache") to this: import SimpleLRUCache from "./modules/caches/simple-lru-cache.js";  only is if we have case 1 above, meaning if the actual file is: ./modules/caches/simple-lru-cache.js  else we will have to convert it to this: import SimpleLRUCache from "./modules/caches/simple-lru-cache/index.js";if we have case 2 above, meaning the actual file is : ./modules/caches/simple-lru-cache/index.js

So I think when converting something like this: const SimpleLRUCache = require("./modules/caches/simple-lru-cache"); there are more than one way to check for case 1 or case 2 above: 

 when reading  or traversing directories and reaching this const SimpleLRUCache = require("./modules/caches/simple-lru-cache"), meaning this: ./modules/caches/simple-lru-cache, if this: simple-lru-cache is a directory that means the file is: ./modules/caches/simple-lru-cache/index.js (case 2)
if ./modules/caches/simple-lru-cache is file, then that means the file is ./modules/caches/simple-lru-cache.js (case 1)

