import { fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = __dirname_fn(__filename);
import * as __ns_lib from './lib';
import * as __ns_node_path from 'node:path';
import * as __ns_node_fs_promises from 'node:fs/promises';
import * as __ns_express from 'express';
import 'dotenv/config';;

const x = __ns_lib.default ?? __ns_lib
const { join, dirname } = require('path');

const p = __dirname + '/data/a.txt';


const { readFile, writeFile } = require('fs/promises')

const m = __ns_express.default ?? __ns_express;


const helloWorld = (req, res) => {
    res.send('Hello World!');
};
module.exports = helloWorld;