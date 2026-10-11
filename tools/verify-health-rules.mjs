/* The client health rules (health/, errors/, errorsKnown/; ADMIN.md "Health"), checked against the database emulator.
       node tools/verify-health-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-health-rules.mjs

   A heartbeat is the owner's own, today's, a Google account's, at most once a
   minute, every field its type and range, nothing else. An error report: its
   message and place written once (the same again is fine), each person's own
   entry under it. Only admins read any of it, and sweep past days.

   Loads firebase.rules.json into a namespace of its own (`health-rules`), and
   the rules from before this phase into another (`health-old`). Users are
   unsigned tokens, as in verify-admin-rules.mjs. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const TS = { '.sv': 'timestamp' };
const IST = 19800000, DAY = 86400000;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'google.com') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const users = { admin: token('boss'), ann: token('ann'), bo: token('bo'), anon: token('racer', 'anonymous') };

let NS = 'health-rules';
async function call(method, path, body, who) {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}
let failed = 0, passed = 0;
function expect(name, res, ok) {
  const pass = res.ok === ok;
  if (pass) passed++; else failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`}`);
}
async function load(ns, text) {
  NS = ns;
  const r = await fetch(`${DB}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text });
  if (!r.ok) { console.error('could not load the rules:', r.status, await r.text()); process.exit(1); }
  await call('DELETE', '', undefined, 'owner');
  await call('PUT', 'admins', { boss: true }, 'owner');
}
function oldRules() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const marker = '"errorsKnown"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 9');
  return text;
}

const now = Date.now();
const today = now - ((now + IST) % DAY);
const beat = (extra = {}) => ({
  at: TS, ver: 117, ua: 'firefox', os: 'windows', phone: false, q: 2, qOldestMin: 75, dropped: 1, lastErr: 'PERMISSION_DENIED',
  sw: 'on', swHeals: 0, scr: { '333': 412, sq1: 15200 }, lang: 'en', ...extra,
});
const hp = (uid, day = today) => `health/${day}/${uid}`;

await load('health-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- the heartbeat ---------------- */
expect('ann sends today\'s heartbeat', await call('PUT', hp('ann'), beat(), 'ann'), true);
expect('…not again within a minute', await call('PUT', hp('ann'), beat({ q: 0 }), 'ann'), false);
await call('PUT', `${hp('ann')}/at`, now - 120000, 'owner');
expect('…but after a minute, yes', await call('PUT', hp('ann'), beat({ q: 0 }), 'ann'), true);
expect('bo cannot send ann\'s', await call('PUT', hp('ann'), beat(), 'bo'), false);
expect('an anonymous race account sends nothing', await call('PUT', hp('racer'), beat(), 'anon'), false);
expect('nobody signed in sends nothing', await call('PUT', hp('x'), beat(), null), false);
expect('not into yesterday', await call('PUT', hp('bo', today - DAY), beat(), 'bo'), false);
expect('not with a made-up time', await call('PUT', hp('bo'), beat({ at: now }), 'bo'), false);
expect('not a browser it does not know', await call('PUT', hp('bo'), beat({ ua: 'opera' }), 'bo'), false);
expect('not a system it does not know', await call('PUT', hp('bo'), beat({ os: 'beos' }), 'bo'), false);
expect('not a language it does not have', await call('PUT', hp('bo'), beat({ lang: 'fr' }), 'bo'), false);
expect('not a scramble time past 10 minutes', await call('PUT', hp('bo'), beat({ scr: { '333': 700000 } }), 'bo'), false);
expect('not a scramble key that is not an event id', await call('PUT', hp('bo'), beat({ scr: { 'Bad Key': 5 } }), 'bo'), false);
expect('not a version that is not a whole number', await call('PUT', hp('bo'), beat({ ver: 1.5 }), 'bo'), false);
expect('not an error code past 40 characters', await call('PUT', hp('bo'), beat({ lastErr: 'x'.repeat(41) }), 'bo'), false);
expect('not a field the rules do not know (a user agent)', await call('PUT', hp('bo'), beat({ uaString: 'Mozilla/5.0' }), 'bo'), false);
expect('not without its version', await call('PUT', hp('bo'), { at: TS }, 'bo'), false);
expect('bo\'s own, valid', await call('PUT', hp('bo'), beat({ ua: 'chrome', os: 'android', phone: true }), 'bo'), true);
expect('ann cannot read even her own', await call('GET', hp('ann'), undefined, 'ann'), false);
expect('an admin reads the day', await call('GET', `health/${today}`, undefined, 'admin'), true);
expect('a non-admin does not', await call('GET', 'health', undefined, 'bo'), false);
await call('PUT', hp('old', today - 20 * DAY), beat({ at: 5 }), 'owner');
expect('an admin sweeps a past day', await call('DELETE', `health/${today - 20 * DAY}`, undefined, 'admin'), true);
expect('…but not today', await call('DELETE', `health/${today}`, undefined, 'admin'), false);
expect('a person sweeps nothing', await call('DELETE', hp('ann'), undefined, 'ann'), false);

/* ---------------- error reports ---------------- */
const ep = (hash, day = today) => `errors/${day}/${hash}`;
const report = (uid, hash = 'k3x9a', extra = {}) => ({
  [`${ep(hash)}/msg`]: "Cannot read properties of null (reading 'x')", [`${ep(hash)}/where`]: 'js/race.js:812',
  [`${ep(hash)}/u/${uid}`]: { n: 1, first: now - 1000, last: TS, ver: 117, ua: 'chrome', ...extra },
});
expect('ann reports an error', await call('PATCH', '', report('ann'), 'ann'), true);
expect('bo reports the same one: message and place unchanged, his own entry', await call('PATCH', '', report('bo'), 'bo'), true);
expect('…his second time today', await call('PATCH', '', { ...report('bo'), [`${ep('k3x9a')}/u/bo`]: { n: 2, first: now - 1000, last: TS, ver: 117, ua: 'chrome' } }, 'bo'), true);
expect('nobody can change the message', await call('PUT', `${ep('k3x9a')}/msg`, 'something else', 'bo'), false);
expect('nor write somebody else\'s entry', await call('PUT', `${ep('k3x9a')}/u/ann`, { n: 9, first: 1, last: TS, ver: 117 }, 'bo'), false);
expect('nor a made-up last time', await call('PATCH', '', report('bo', 'k3x9a', { last: now }), 'bo'), false);
expect('nor a count of 0', await call('PATCH', '', report('bo', 'k3x9a', { n: 0 }), 'bo'), false);
expect('nor a field the rules do not know', await call('PATCH', '', report('bo', 'k3x9a', { stack: 'at x' }), 'bo'), false);
expect('nor a message past 200 characters', await call('PATCH', '', { ...report('bo', 'zz1'), [`${ep('zz1')}/msg`]: 'x'.repeat(201) }, 'bo'), false);
expect('nor a key that is not a hash', await call('PATCH', '', report('bo', 'Not-A-Hash'), 'bo'), false);
expect('nor into yesterday', await call('PUT', `${ep('k3x9a', today - DAY)}/msg`, 'x', 'bo'), false);
expect('an anonymous race account reports nothing', await call('PATCH', '', report('racer', 'r1'), 'anon'), false);
expect('a person cannot read errors', await call('GET', `errors/${today}`, undefined, 'ann'), false);
expect('an admin can', await call('GET', `errors/${today}`, undefined, 'admin'), true);

/* ---------------- marked known ---------------- */
expect('an admin marks an error known, with a note', await call('PUT', 'errorsKnown/k3x9a', { by: 'boss', at: TS, note: 'Fixed in 118' }, 'admin'), true);
expect('…not in somebody else\'s name', await call('PUT', 'errorsKnown/k3x9a', { by: 'ann', at: TS }, 'admin'), false);
expect('a person cannot mark one', await call('PUT', 'errorsKnown/zz', { by: 'ann', at: TS }, 'ann'), false);
expect('…nor read the list', await call('GET', 'errorsKnown', undefined, 'ann'), false);
expect('an admin unmarks it', await call('DELETE', 'errorsKnown/k3x9a', undefined, 'admin'), true);

/* ---------------- the rules from before this phase ---------------- */
await load('health-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
expect('old rules: a heartbeat is refused cleanly', await call('PUT', hp('ann'), beat(), 'ann'), false);
expect('old rules: an error report too', await call('PATCH', '', report('ann'), 'ann'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
