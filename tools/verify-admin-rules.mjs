/* The admin console's rules (admins/, config/, configMeta/, configLog/),
   checked against the database emulator.
       node tools/verify-admin-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-admin-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`admin-rules`), so a
   running `tools/sotd-replay-dev.mjs` and the app's data are not touched.
   Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs: the
   emulator reads the claims without checking a signature, which is how a
   Google account and an anonymous one are told apart without signing in.

   Every write is tried four ways: an admin, a signed-in Google account that
   is not one, an anonymous race account (one listed under admins/ by
   mistake, which must still count for nothing), and nobody signed in. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allSettings } from '../js/config-table.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'admin-rules';
const TS = { '.sv': 'timestamp' };
const IST = 19800000, DAY = 86400000;
/* The uid that firebase.rules.json used to hard-code. It is an ordinary
   account now unless admins/<uid> says otherwise. */
const OLD_ADMIN = '8lSr96LEO1cdHDVlMDv8tCCFQag1';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'google.com') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const UIDS = { admin: 'boss', alice: 'alice', anon: 'anonboss', old: OLD_ADMIN, stringy: 'stringy' };
const users = {
  admin: token('boss'), alice: token('alice'), anon: token('anonboss', 'anonymous'),
  old: token(OLD_ADMIN), stringy: token('stringy'),
};

async function call(method, path, body, who) {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}

let failed = 0, passed = 0;
function expect(name, res, ok) {
  const pass = res.ok === ok;
  if (pass) passed++; else failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`}`);
}
const check = (ok, body) => ({ ok, status: 0, body });

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');
// What the owner adds by hand in the console. The anonymous one and the
// string are mistakes the rules must shrug off.
await call('PUT', 'admins', { boss: true, anonboss: true, stringy: 'yes' }, 'owner');

console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- admins/ ---------------- */

expect('an admin reads the admins list', await call('GET', 'admins', undefined, 'admin'), true);
expect('a signed-in non-admin cannot read the list', await call('GET', 'admins', undefined, 'alice'), false);
expect('…but can read their own entry (null: not an admin)', await call('GET', 'admins/alice', undefined, 'alice'), true);
expect('…and not somebody else\'s', await call('GET', 'admins/boss', undefined, 'alice'), false);
expect('an anonymous account listed by mistake cannot read the list', await call('GET', 'admins', undefined, 'anon'), false);
expect('signed out, nothing is readable', await call('GET', 'admins/boss', undefined, null), false);
expect('a non-true entry ("yes") is not an admin', await call('GET', 'admins', undefined, 'stringy'), false);
for (const who of ['admin', 'alice', 'anon', null]) {
  expect(`${who || 'signed out'}: writing admins/ from the client is refused`,
    await call('PUT', `admins/${who ? UIDS[who] : 'x'}`, true, who), false);
}
expect('nobody adds an admin, even an admin adding somebody else', await call('PUT', 'admins/alice', true, 'admin'), false);
expect('nobody removes an admin from the client', await call('DELETE', 'admins/boss', undefined, 'admin'), false);

/* ---------------- config/ ---------------- */

let seq = 0;
/**
 * The admin page's Save for one setting: the value, its configMeta pointer
 * and the configLog entry, in one update at the root. `opts` breaks one part.
 */
function change(who, path, to, from, opts = {}) {
  const id = opts.id || `L${String(++seq).padStart(4, '0')}`;
  const uid = who ? UIDS[who] : 'nobody';
  const entry = { uid: opts.logUid || uid, at: opts.logAt ?? TS, path: opts.logPath || path };
  if (from !== undefined) entry.from = from;
  if ((opts.logTo ?? to) !== null) entry.to = opts.logTo ?? to;
  if (opts.logFrom !== undefined) entry.from = opts.logFrom;
  if (opts.undo) entry.undo = opts.undo;
  const body = { [`config/${path}`]: to };
  if (!opts.noMeta) body[`configMeta/${path}`] = { at: opts.metaAt ?? TS, by: uid, log: opts.metaLog || id };
  if (!opts.noLog) body[`configLog/${id}`] = entry;
  if (opts.noLog && opts.noMeta) delete body[`configMeta/${path}`];
  return call('PATCH', '', body, who).then(r => Object.assign(r, { id }));
}

expect('signed out, the config is public to read', await call('GET', 'config', undefined, null), true);
expect('…and so is it to a non-admin', await call('GET', 'config', undefined, 'alice'), true);

const first = await change('admin', 'sandbox/n', 7, undefined);
expect('an admin changes a setting, with its log entry, in one update', first, true);
const got = await call('GET', 'config/sandbox/n', undefined, null);
expect('…and the new value is what everybody reads', check(got.body === 7, got.body), true);

for (const who of ['alice', 'anon', 'old', null]) {
  expect(`${who === 'old' ? 'the uid the old rules hard-coded, not in admins/,' : who || 'signed out'}: the same update is refused`,
    await change(who, 'sandbox/n', 8, 7), false);
}
expect('a non-true admins/ entry cannot change anything', await change('stringy', 'sandbox/n', 8, 7), false);

expect('without its configMeta pointer, refused', await change('admin', 'sandbox/n', 8, 7, { noMeta: true }), false);
expect('without the log entry, refused', await change('admin', 'sandbox/n', 8, 7, { noLog: true }), false);
expect('the value alone, refused', await change('admin', 'sandbox/n', 8, 7, { noLog: true, noMeta: true }), false);
expect('a log entry whose `to` is not the new value, refused', await change('admin', 'sandbox/n', 8, 7, { logTo: 9 }), false);
expect('a log entry whose `from` is not the old value, refused', await change('admin', 'sandbox/n', 8, 3), false);
expect('a log entry that says there was no old value, refused', await change('admin', 'sandbox/n', 8, undefined), false);
expect('a log entry for another setting, refused', await change('admin', 'sandbox/n', 8, 7, { logPath: 'sandbox/on' }), false);
expect('a pointer at a log entry that is not in the update, refused', await change('admin', 'sandbox/n', 8, 7, { metaLog: 'L0001' }), false);
expect('a log entry in somebody else\'s name, refused', await change('admin', 'sandbox/n', 8, 7, { logUid: 'alice' }), false);
expect('a log entry with a client clock, refused', await change('admin', 'sandbox/n', 8, 7, { logAt: Date.now() - 60_000 }), false);
expect('a pointer with a client clock, refused', await change('admin', 'sandbox/n', 8, 7, { metaAt: Date.now() - 60_000 }), false);

// The ceilings: the table's min and max, and the type.
expect('the ceiling itself (10) is allowed', await change('admin', 'sandbox/n', 10, 7), true);
expect('one past the ceiling (11) is refused', await change('admin', 'sandbox/n', 11, 10), false);
expect('below the minimum (-1) is refused', await change('admin', 'sandbox/n', -1, 10), false);
expect('a fraction where a whole number goes is refused', await change('admin', 'sandbox/n', 2.5, 10), false);
expect('a string where a number goes is refused', await change('admin', 'sandbox/n', '5', 10), false);
expect('a string where a switch goes is refused', await change('admin', 'sandbox/on', 'true', undefined), false);
expect('a switch is allowed', await change('admin', 'sandbox/on', true, undefined), true);
expect('80 characters of text is allowed', await change('admin', 'sandbox/text', 'x'.repeat(80), undefined), true);
expect('81 is refused', await change('admin', 'sandbox/text', 'y'.repeat(81), 'x'.repeat(80)), false);
expect('a setting that is not in the table is refused', await change('admin', 'sandbox/nope', 1, undefined), false);
expect('a section that is not in the table is refused', await change('admin', 'nowhere/n', 1, undefined), false);
expect('a whole section in one write is refused', await call('PUT', 'config/sandbox', { n: 1 }, 'admin'), false);
expect('the whole config in one write is refused', await call('PUT', 'config', {}, 'admin'), false);

// Two settings in one Save: one entry each.
const two = await call('PATCH', '', {
  'config/sandbox/n': 4, 'configMeta/sandbox/n': { at: TS, by: 'boss', log: 'T1' },
  'configLog/T1': { uid: 'boss', at: TS, path: 'sandbox/n', from: 10, to: 4 },
  'config/sandbox/on': false, 'configMeta/sandbox/on': { at: TS, by: 'boss', log: 'T2' },
  'configLog/T2': { uid: 'boss', at: TS, path: 'sandbox/on', from: true, to: false },
}, 'admin');
expect('two settings in one Save, an entry each', two, true);
const pair = await call('PATCH', '', {
  'config/sandbox/n': 5, 'configMeta/sandbox/n': { at: TS, by: 'boss', log: 'T3' },
  'config/sandbox/on': true, 'configMeta/sandbox/on': { at: TS, by: 'boss', log: 'T3' },
  'configLog/T3': { uid: 'boss', at: TS, path: 'sandbox/n', from: 4, to: 5 },
}, 'admin');
expect('two settings sharing one entry, refused', pair, false);

// Back to the default: the value goes, and the entry has no `to`.
expect('back to the default (deleted), with its entry', await change('admin', 'sandbox/n', null, 4), true);
const gone = await call('GET', 'config/sandbox/n', undefined, null);
expect('…and nothing is stored any more', check(gone.body === null, gone.body), true);
expect('deleting without an entry, refused', await call('DELETE', 'config/sandbox/on', undefined, 'admin'), false);
expect('deleting with an entry that still has a `to`, refused', await change('admin', 'sandbox/on', null, false, { logTo: false }), false);

// Undo is an ordinary change that names the entry it undoes.
const u = await change('admin', 'sandbox/on', true, false, { undo: 'T2' });
expect('an undo naming the entry it undoes', u, true);
expect('an undo naming an entry that does not exist, refused', await change('admin', 'sandbox/on', false, true, { undo: 'nope' }), false);

// Every number in the table: its ceiling and floor are the rules' too.
for (const [s, k, sp] of allSettings()) {
  if (sp.type !== 'int') continue;
  const path = `${s}/${k}`;
  const was = (await call('GET', `config/${path}`, undefined, null)).body ?? undefined;
  const top = await change('admin', path, sp.max, was);
  const over = await change('admin', path, sp.max + 1, sp.max);
  const under = await change('admin', path, sp.min - 1, sp.max);
  expect(`${path}: ${sp.max} (the ceiling) allowed, ${sp.max + 1} and ${sp.min - 1} refused`,
    { ok: top.ok && !over.ok && !under.ok, status: 0, body: [top.status, over.status, under.status] }, true);
  await change('admin', path, null, sp.max);
}

/* ---------------- configLog/ and configMeta/ ---------------- */

expect('an admin reads the change log', await call('GET', 'configLog', undefined, 'admin'), true);
for (const who of ['alice', 'anon', null]) {
  expect(`${who || 'signed out'}: the change log is unreadable`, await call('GET', 'configLog', undefined, who), false);
  expect(`${who || 'signed out'}: the pointers are unreadable`, await call('GET', 'configMeta', undefined, who), false);
}
expect('an admin reads the pointers', await call('GET', 'configMeta', undefined, 'admin'), true);
expect('a log entry cannot be edited, even by an admin',
  await call('PUT', `configLog/${first.id}/to`, 9, 'admin'), false);
expect('a log entry cannot be deleted', await call('DELETE', `configLog/${first.id}`, undefined, 'admin'), false);
expect('a pointer cannot be deleted', await call('DELETE', 'configMeta/sandbox/n', undefined, 'admin'), false);
expect('a lone log entry with no change behind it, refused', await call('PUT', 'configLog/X9', {
  uid: 'boss', at: TS, path: 'sandbox/text', from: 'x'.repeat(80), to: 'x'.repeat(80),
}, 'admin'), false);
const log = await call('GET', 'configLog', undefined, 'admin');
const entries = Object.values(log.body || {});
expect('every change that landed has exactly one entry',
  check(entries.length >= 8 && entries.every(e => e.uid === 'boss' && typeof e.at === 'number'), entries.length), true);

/* ---------------- the powers that used to be hard-coded ---------------- */

const now = Date.now();
const today = String(now - ((now + IST) % DAY));
const base = `daily/${today}/333`;
await call('PUT', `${base}/results/alice`, { timeMs: 9000, penalty: 'none', name: 'alice' }, 'owner');
await call('PUT', `${base}/chat`, { m: { a1: { uid: 'alice', name: 'alice', text: 'hi', at: 1 }, a2: { uid: 'alice', name: 'alice', text: 'hi', at: 2 } } }, 'owner');
expect('the old hard-coded uid, not in admins/, cannot delete a message',
  await call('DELETE', `${base}/chat/m/a1`, undefined, 'old'), false);
expect('an anonymous account in admins/ cannot either', await call('DELETE', `${base}/chat/m/a1`, undefined, 'anon'), false);
expect('an admin from admins/ can', await call('DELETE', `${base}/chat/m/a1`, undefined, 'admin'), true);
const removal = (uid, final) => ({
  [`results/${uid}`]: null, [`removed/${uid}`]: { at: TS, final },
  [`progress/${uid}/submitted`]: null, [`replayClaim/${uid}`]: null,
});
expect('the old hard-coded uid cannot remove a time', await call('PATCH', base, removal('alice', false), 'old'), false);
expect('an admin from admins/ can', await call('PATCH', base, removal('alice', false), 'admin'), true);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
