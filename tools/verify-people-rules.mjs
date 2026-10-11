/* The People rules (seen/, support/, supportLast/, deletion/, and an admin's deletes for a
   deletion request; ADMIN.md §17), checked against the database emulator.
       node tools/verify-people-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-people-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`people-rules`), and the rules
   from before this phase into another (`people-old`). Users are unsigned tokens. */

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

let NS = 'people-rules';
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
  const marker = '"supportLast"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 10');
  return text;
}

const now = Date.now();
const today = now - ((now + IST) % DAY);

await load('people-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- seen/ ---------------- */
const seen = (extra = {}) => ({ name: 'Ann', pfp: 'https://lh3.googleusercontent.com/a/x', provider: 'google', lastAt: TS, ver: 118, lang: 'en', ...extra });
expect('ann writes her directory entry', await call('PATCH', 'seen/ann', seen(), 'ann'), true);
expect('…and when she was first seen, once', await call('PUT', 'seen/ann/firstAt', TS, 'ann'), true);
expect('…not again', await call('PUT', 'seen/ann/firstAt', TS, 'ann'), false);
expect('…but she can write it unchanged inside a whole entry', await call('PATCH', 'seen/ann', seen({ name: 'Ann B' }), 'ann'), true);
expect('not an empty name', await call('PATCH', 'seen/ann', seen({ name: '' }), 'ann'), false);
expect('not a picture that is not https', await call('PATCH', 'seen/ann', seen({ pfp: 'http://x.test/a.png' }), 'ann'), false);
expect('not an email', await call('PATCH', 'seen/ann', seen({ email: 'ann@x.test' }), 'ann'), false);
expect('not a made-up time', await call('PATCH', 'seen/ann', seen({ lastAt: now }), 'ann'), false);
expect('bo cannot write ann\'s', await call('PATCH', 'seen/ann', seen(), 'bo'), false);
expect('an anonymous race account writes nothing', await call('PATCH', 'seen/racer', seen(), 'anon'), false);
expect('ann cannot read the directory, even herself', await call('GET', 'seen/ann', undefined, 'ann'), false);
expect('nor take herself out of it', await call('DELETE', 'seen/ann', undefined, 'ann'), false);
expect('an admin reads it', await call('GET', 'seen', undefined, 'admin'), true);

/* ---------------- support/ ---------------- */
const ticket = (uid, extra = {}) => ({
  uid, at: TS, note: 'My Competition set vanished after a sync', ver: 118, ua: 'firefox', os: 'windows',
  queue: { 0: { path: `users/${uid}/competitionSets/c1`, op: 'update', ageMin: 75 } },
  counts: { solves: 1200, sessions: 4, competitionSets: 3, discardedSets: 1 },
  competition: { 0: { id: 'c1', status: 'discarded', event: '333', size: 5, done: 5, createdAt: 1, discardedAt: 2 } },
  health: { local: 'saved', cloud: 'retrying', pending: 1, online: true, lastErr: 'PERMISSION_DENIED' },
  ...extra,
});
const send = (who, id, body, last = TS) => call('PATCH', '', { [`support/${id}`]: body, [`supportLast/${who}`]: last }, who);
expect('ann sends a request, with its snapshot', await send('ann', 'T1', ticket('ann')), true);
expect('…not another within ten minutes', await send('ann', 'T2', ticket('ann')), false);
await call('PUT', 'supportLast/ann', now - 700000, 'owner');
expect('…but after ten, yes', await send('ann', 'T2', ticket('ann')), true);
expect('not without the ten-minute stamp', await call('PUT', 'support/T3', ticket('bo'), 'bo'), false);
expect('not in somebody else\'s name', await send('bo', 'T3', ticket('ann')), false);
expect('not a note past 500 characters', await send('bo', 'T3', ticket('bo', { note: 'x'.repeat(501) })), false);
expect('not a queue entry with a value in it', await send('bo', 'T3', ticket('bo', { queue: { 0: { path: 'users/bo/x', op: 'set', value: 12 } } })), false);
expect('not a change kind it does not know', await send('bo', 'T3', ticket('bo', { queue: { 0: { path: 'users/bo/x', op: 'push' } } })), false);
expect('not a field the rules do not know', await send('bo', 'T3', ticket('bo', { email: 'bo@x.test' })), false);
expect('an anonymous race account sends nothing', await send('racer', 'T4', ticket('racer')), false);
expect('ann reads her own request', await call('GET', 'support/T1', undefined, 'ann'), true);
expect('bo does not', await call('GET', 'support/T1', undefined, 'bo'), false);
expect('nor the list', await call('GET', 'support', undefined, 'ann'), false);
expect('ann cannot change her request once sent', await call('PUT', 'support/T1/note', 'never mind', 'ann'), false);
expect('nor reply to herself', await call('PUT', 'support/T1/reply', { text: 'fixed', by: 'ann', at: TS }, 'ann'), false);
expect('nor mark a reply read before there is one', await call('PUT', 'support/T1/replySeen', TS, 'ann'), false);
expect('an admin reads every request', await call('GET', 'support', undefined, 'admin'), true);
expect('an admin replies', await call('PUT', 'support/T1/reply', { text: 'Restored from the discarded record — check now.', by: 'boss', at: TS }, 'admin'), true);
expect('…not in somebody else\'s name', await call('PUT', 'support/T2/reply', { text: 'x', by: 'ann', at: TS }, 'admin'), false);
expect('ann marks the reply read', await call('PUT', 'support/T1/replySeen', TS, 'ann'), true);
expect('bo cannot mark it for her', await call('PUT', 'support/T1/replySeen', TS, 'bo'), false);
expect('an admin deletes a request', await call('DELETE', 'support/T2', undefined, 'admin'), true);

/* ---------------- deletion/ ---------------- */
expect('ann asks for her data to be deleted', await call('PUT', 'deletion/ann', { at: TS, name: 'Ann' }, 'ann'), true);
expect('…once', await call('PUT', 'deletion/ann', { at: TS, name: 'Ann' }, 'ann'), false);
expect('bo cannot ask for ann', await call('PUT', 'deletion/ann', { at: TS }, 'bo'), false);
expect('ann reads her request', await call('GET', 'deletion/ann', undefined, 'ann'), true);
expect('…not the list', await call('GET', 'deletion', undefined, 'ann'), false);
expect('ann cannot mark it done', await call('PATCH', 'deletion/ann', { doneAt: TS, doneBy: 'ann' }, 'ann'), false);

/* ---------------- an admin carries it out ---------------- */
await call('PUT', 'users/ann', { settings: { raceName: 'Ann' }, solves: { s1: { id: 's1', createdAt: 1 } } }, 'owner');
await call('PUT', `health/${today}/ann`, { at: 1, ver: 118 }, 'owner');
await call('PUT', `errors/${today}/abc/u/ann`, { n: 1, first: 1, last: 1, ver: 118 }, 'owner');
expect('an admin cannot read ann\'s synced data', await call('GET', 'users/ann', undefined, 'admin'), false);
expect('…nor write it', await call('PUT', 'users/ann/settings/raceName', 'x', 'admin'), false);
expect('…but deletes all of it, her directory entry, heartbeat, error entry, requests, and marks it done, in one update', await call('PATCH', '', {
  'users/ann': null, 'seen/ann': null, [`health/${today}/ann`]: null, [`errors/${today}/abc/u/ann`]: null, 'support/T1': null,
  'deletion/ann/doneAt': TS, 'deletion/ann/doneBy': 'boss',
}, 'admin'), true);
expect('…and it is gone', { ok: (await call('GET', 'users/ann', undefined, 'owner')).body === null }, true);
expect('a non-admin Google account deletes nobody', await call('DELETE', 'users/bo', undefined, 'ann'), false);
expect('nor somebody\'s heartbeat', await call('DELETE', `health/${today}/bo`, undefined, 'ann'), false);

/* ---------------- the rules from before this phase ---------------- */
await load('people-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
expect('old rules: a directory entry is refused cleanly', await call('PATCH', 'seen/ann', seen(), 'ann'), false);
expect('old rules: a support request too', await send('ann', 'T1', ticket('ann')), false);
expect('old rules: a deletion request too', await call('PUT', 'deletion/ann', { at: TS }, 'ann'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
