/* ===========================================================
   Tagda Timer — the `config` rules, made from js/config.js

   Pure text in, text out, so the same code runs in node
   (tools/config-rules.mjs, which writes it) and in test.html (which checks
   that the committed firebase.rules.json still matches the table).
   =========================================================== */

import { CONFIG } from './config-table.js';

/**
 * An admin, in the rules: a Google sign-in whose uid is true under admins/.
 * Race mode's anonymous accounts never count, even if one were added by
 * mistake. The same words are written by hand everywhere else in
 * firebase.rules.json that an admin may do something.
 */
export const ADMIN = "auth != null && auth.token.firebase.sign_in_provider === 'google.com' && root.child('admins/' + auth.uid).val() === true";

/** What a key may hold, from its type and range. */
export function validateFor(sp) {
  if (sp.type === 'bool') return 'newData.isBoolean()';
  if (sp.type === 'int' || sp.type === 'time') return `newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= ${sp.min} && newData.val() <= ${sp.max}`;
  if (sp.type === 'text') {
    const https = sp.pattern === 'https' ? ` && newData.val().matches(/^https:[/][/][^ ]+$/)` : '';
    return `newData.isString() && newData.val().length <= ${sp.max}${https}`;
  }
  if (sp.type === 'set') {
    // Some of the options, comma-separated, or none. Repeats are the app's to tidy.
    const one = `(${sp.options.join('|')})`;
    return `newData.isString() && newData.val().matches(/^(${one}(,${one})*)?$/)`;
  }
  throw new Error(`unknown setting type ${sp.type}`);
}

/** Who may write it: an admin, and only together with its configMeta pointer (ADMIN.md). */
export function writeFor(section, key) {
  return `${ADMIN} && newData.parent().parent().parent().child('configMeta/${section}/${key}/at').val() === now`;
}

/** The whole block, as it sits in firebase.rules.json (four spaces in). */
export function configBlock() {
  const q = JSON.stringify;
  const lines = ['"config": {', '  ".read": true,', ''];
  for (const [s, sec] of Object.entries(CONFIG)) {
    lines.push(`  ${q(s)}: {`);
    for (const [k, sp] of Object.entries(sec.keys)) {
      lines.push(`    ${q(k)}: {`,
        `      ".write": ${q(writeFor(s, k))},`,
        `      ".validate": ${q(validateFor(sp))}`,
        '    },');
    }
    lines.push('    "$other": { ".validate": false }', '  },', '');
  }
  lines.push('  "$other": { ".validate": false }', '}');
  return lines.map((l, i) => (i && l ? `    ${l}` : l)).join('\n');
}

/** The end of the JSON value starting at `from` (a `{`), strings respected. */
function closeOf(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces in firebase.rules.json');
}

/** `text` (firebase.rules.json) with its top-level "config" block swapped for `block`. */
export function replaceBlock(text, block) {
  const m = /\n {4}"config": \{/.exec(text);
  if (!m) throw new Error('firebase.rules.json has no top-level "config" block to replace');
  const start = m.index + 5;
  const end = closeOf(text, text.indexOf('{', start));
  // A Windows checkout has CRLF line ends; the block follows the file.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, start) + block.replace(/\n/g, eol) + text.slice(end + 1);
}
