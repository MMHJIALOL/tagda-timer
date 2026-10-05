/* The `config` block of firebase.rules.json, written from js/config.js.
       node tools/config-rules.mjs           rewrite the block in place
       node tools/config-rules.mjs --check   exit 1 if it is out of date

   Every setting gets its own rule: who may write it (an admin, and only in
   the same update as its configMeta pointer, which in turn needs a truthful
   configLog entry; see ADMIN.md, "The change log") and what it may hold
   (its type and range from the table, so the database refuses anything
   past a ceiling). Only that block of the file is touched; the rest keeps
   its hand formatting. test.html runs the same comparison in the browser. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configBlock, replaceBlock } from '../js/config-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'firebase.rules.json');

const text = readFileSync(FILE, 'utf8');
const next = replaceBlock(text, configBlock());
JSON.parse(next);   // still valid JSON, or nothing is written

if (process.argv.includes('--check')) {
  if (next !== text) { console.error('firebase.rules.json is out of date: run node tools/config-rules.mjs'); process.exit(1); }
  console.log('firebase.rules.json matches js/config.js');
} else if (next === text) {
  console.log('firebase.rules.json already matches js/config.js');
} else {
  writeFileSync(FILE, next);
  console.log('firebase.rules.json: config block rewritten from js/config.js');
}
