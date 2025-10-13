```js
require('dotenv/config');

const x = require('./lib')
const { join, dirname } = require('path');

const p = __dirname + '/data/a.txt';


const { readFile, writeFile } = require('fs/promises')

const m = require('express');


const helloWorld = (req, res) => {
    res.send('Hello World!');
};
module.exports = helloWorld;
```