/* ===========================================================
   Tagda Timer — the generated rules, made from js/config.js

   Three top-level blocks of firebase.rules.json come from the settings
   table rather than by hand: `config` (the values), `configScheduled`
   (changes waiting for their time, ADMIN.md §10) and `sotdFeatured` (a
   day's featured event, whose list is the table's SOTD_EVENTS).

   Pure text in, text out, so the same code runs in node
   (tools/config-rules.mjs, which writes it) and in test.html (which checks
   that the committed firebase.rules.json still matches the table).
   =========================================================== */

import { CONFIG, SOTD_EVENTS } from './config-table.js';

/**
 * An admin, in the rules: a Google sign-in whose uid is true under admins/.
 * Race mode's anonymous accounts never count, even if one were added by
 * mistake. The same words are written by hand everywhere else in
 * firebase.rules.json that an admin may do something.
 */
export const ADMIN = "auth != null && auth.token.firebase.sign_in_provider === 'google.com' && root.child('admins/' + auth.uid).val() === true";

/**
 * The Worker's cron, applying a scheduled change (ADMIN.md §10): signed in
 * with a custom token only the service account's key can make, so no person
 * and no browser can be it. It may do exactly one thing, apply a change that
 * is due, which the configLog rules check field by field.
 */
export const SCHEDULER_UID = 'tagda-scheduler';
export const SCHEDULER = `auth != null && auth.uid === '${SCHEDULER_UID}' && auth.token.firebase.sign_in_provider === 'custom'`;

/** A tester (testers/<uid>, ADMIN.md §9), or an admin, who has everything a tester has. */
export const TESTER = "auth != null && (root.child('testers/' + auth.uid).exists() || (auth.token.firebase.sign_in_provider === 'google.com' && root.child('admins/' + auth.uid).val() === true))";

/** Whether this account has a feature whose section has an `audience` key. Nothing stored is everybody. */
export function audienceRule(section) {
  const a = `root.child('config/${section}/audience')`;
  return `(!${a}.exists() || ${a}.val() === 'everyone' || (${a}.val() === 'testers' && ${TESTER}) || (${a}.val() === 'admins' && ${ADMIN}))`;
}

/** The day that starts at 00:00 IST, for `now` moved by `ms`, as a $dayStart string compares. */
export const dayOf = (ms = 0) => {
  const t = ms ? `now ${ms > 0 ? '+' : '-'} ${Math.abs(ms)}` : 'now';
  return `'' + (${t} - ((${t} + 19800000) % 86400000))`;
};

/** What a key may hold, from its type and range. */
export function validateFor(sp) {
  if (sp.type === 'bool') return 'newData.isBoolean()';
  if (sp.type === 'int' || sp.type === 'time') return `newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= ${sp.min} && newData.val() <= ${sp.max}`;
  if (sp.type === 'text') {
    const https = sp.pattern === 'https' ? ` && newData.val().matches(/^https:[/][/][^ ]+$/)` : '';
    const floors = sp.pattern === 'floors' ? ` && newData.val().matches(/^([a-z0-9]{2,12}:[0-9]{1,7}(,[a-z0-9]{2,12}:[0-9]{1,7})*)?$/)` : '';
    return `newData.isString() && newData.val().length <= ${sp.max}${https}${floors}`;
  }
  if (sp.type === 'choice') return `newData.isString() && newData.val().matches(/^(${sp.options.join('|')})$/)`;
  if (sp.type === 'set') {
    // Some of the options, comma-separated, or none. Repeats are the app's to tidy.
    const one = `(${sp.options.join('|')})`;
    return `newData.isString() && newData.val().matches(/^(${one}(,${one})*)?$/)`;
  }
  throw new Error(`unknown setting type ${sp.type}`);
}

/** Who may write it: an admin or the scheduler, and only together with its configMeta pointer (ADMIN.md). */
export function writeFor(section, key) {
  return `(${ADMIN} || ${SCHEDULER}) && newData.parent().parent().parent().child('configMeta/${section}/${key}/at').val() === now`;
}

/** How far ahead a change may be scheduled: a year and a day. */
export const SCHEDULE_AHEAD_MS = 366 * 86_400_000;

/**
 * configScheduled/<section>/<key>/<id>: an admin writes, edits or deletes
 * one; the scheduler only deletes one, in the same update that applies it
 * (its configMeta pointer, now, names a configLog entry whose `sched` is it).
 */
export function scheduledWriteFor(section, key) {
  const root = 'newData.parent().parent().parent().parent()';
  return `(${ADMIN}) || (${SCHEDULER} && !newData.exists() && ${root}.child('configMeta/${section}/${key}/at').val() === now`
    + ` && ${root}.child('configLog/' + ${root}.child('configMeta/${section}/${key}/log').val() + '/sched').val() === $id)`;
}

const q = JSON.stringify;
const indent = (lines) => lines.map((l, i) => (i && l ? `    ${l}` : l)).join('\n');

/** The whole block, as it sits in firebase.rules.json (four spaces in). */
export function configBlock() {
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
  return indent(lines);
}

/** The configScheduled block: per setting, a change waiting for its time. */
export function scheduledBlock() {
  const lines = ['"configScheduled": {', '  ".read": true,', ''];
  for (const [s, sec] of Object.entries(CONFIG)) {
    lines.push(`  ${q(s)}: {`);
    for (const [k, sp] of Object.entries(sec.keys)) {
      lines.push(`    ${q(k)}: {`, '      "$id": {',
        `        ".write": ${q(scheduledWriteFor(s, k))},`,
        `        ".validate": ${q("$id.matches(/^[A-Za-z0-9_-]{1,32}$/) && newData.hasChildren(['at', 'by', 'createdAt']) && ((newData.hasChild('to') && !newData.hasChild('def')) || (!newData.hasChild('to') && newData.hasChild('def')))")},`,
        `        "to": { ".validate": ${q(validateFor(sp))} },`,
        '        "def": { ".validate": "newData.val() === true" },',
        `        "at": { ".validate": ${q(`newData.isNumber() && newData.val() > now && newData.val() <= now + ${SCHEDULE_AHEAD_MS}`)} },`,
        '        "by": { ".validate": "newData.val() === auth.uid" },',
        '        "createdAt": { ".validate": "newData.val() === now" },',
        '        "$other": { ".validate": false }',
        '      }',
        '    },');
    }
    lines.push('    "$other": { ".validate": false }', '  },', '');
  }
  lines.push('  "$other": { ".validate": false }', '}');
  return indent(lines);
}

/** sotdFeatured/<dayStart>: one event, set by an admin for today or a day ahead (DAILY.md §3). */
export function featuredBlock() {
  return indent(['"sotdFeatured": {', '  ".read": true,', '  "$dayStart": {',
    `    ".write": ${q(`${ADMIN} && $dayStart >= ${dayOf()}`)},`,
    `    ".validate": ${q(`$dayStart.matches(/^[0-9]{13}$/) && newData.isString() && newData.val().matches(/^(${SOTD_EVENTS.join('|')})$/)`)}`,
    '  }', '}']);
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

/** `text` (firebase.rules.json) with its top-level `name` block ("config" unless said) swapped for `block`. */
export function replaceBlock(text, block, name = 'config') {
  const m = new RegExp(`\\n {4}"${name}": \\{`).exec(text);
  if (!m) throw new Error(`firebase.rules.json has no top-level "${name}" block to replace`);
  const start = m.index + 5;
  const end = closeOf(text, text.indexOf('{', start));
  // A Windows checkout has CRLF line ends; the block follows the file.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, start) + block.replace(/\n/g, eol) + text.slice(end + 1);
}

/** `text` with every generated block rewritten: what `node tools/config-rules.mjs` writes and test.html checks. */
export function generatedRules(text) {
  let out = replaceBlock(text, configBlock(), 'config');
  out = replaceBlock(out, scheduledBlock(), 'configScheduled');
  return replaceBlock(out, featuredBlock(), 'sotdFeatured');
}
