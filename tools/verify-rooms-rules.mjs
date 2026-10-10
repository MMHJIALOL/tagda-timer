/* The admin console's race-room actions and the 1v1 relay count (ADMIN.md, "Race rooms and 1v1"),
   checked against the database emulator.
       node tools/verify-rooms-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-rooms-rules.mjs

   rooms/<id>/mod: an admin closes a room, removes a player, strikes a time,
   and the rules then refuse what a closed room or a removed player may no
   longer do. An admin deletes a whole room. A result's penaltyAt, from its
   owner. turnDay/<day>/<uid>: +1 at a time, today only, read by its owner
   and by admins.

   Loads firebase.rules.json into a namespace of its own (`rooms-rules`), and
   the rules from before this phase into another (`rooms-old`). Users are
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
function token(uid, provider = 'anonymous') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const users = {
  admin: token('boss', 'google.com'), google: token('gina', 'google.com'), anonAdmin: token('anonboss'),
  alice: token('alice'), bob: token('bob'), carol: token('carol'),
};

let NS = 'rooms-rules';
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

async function load(ns, text) {
  NS = ns;
  const r = await fetch(`${DB}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text });
  if (!r.ok) { console.error('could not load the rules:', r.status, await r.text()); process.exit(1); }
  await call('DELETE', '', undefined, 'owner');
  await call('PUT', 'admins', { boss: true, anonboss: true }, 'owner');
}

function oldRules() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const marker = '/mod/closed';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 8');
  return text;
}

/** A room with alice and bob in it, round 1 open, alice's time in. */
async function seed(id) {
  const now = Date.now();
  await call('PUT', `rooms/${id}`, {
    meta: { createdAt: now, event: '333', mode: 'wca', round: 1, phase: 'racing' },
    players: { alice: { name: 'alice', joinedAt: now, lastSeen: now }, bob: { name: 'bob', joinedAt: now, lastSeen: now } },
    rounds: { 1: { info: { scramble: "R U R'", hash: 'h1', startedAt: now } } },
  }, 'owner');
  await call('PUT', `rooms/${id}/rounds/1/results/alice`, { timeMs: 9000, penalty: 'none', hash: 'h1', submittedAt: now }, 'owner');
}
const result = (ms = 10000) => ({ timeMs: ms, penalty: 'none', hash: 'h1', submittedAt: TS });
const chat = (id, who, text) => call('PATCH', `rooms/${id}`, {
  [`chat/m${Math.random().toString(36).slice(2, 8)}`]: { uid: who, name: who, text, at: TS }, [`chatLast/${who}`]: TS,
}, who);
const heartbeat = (id, who) => call('PATCH', `rooms/${id}/players/${who}`, { lastSeen: TS }, who);
const enter = (id, who) => call('PUT', `rooms/${id}/players/${who}`, { name: who, joinedAt: Date.now(), lastSeen: TS }, who);

/* ================= the new rules ================= */

await load('rooms-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- closing a room ---------------- */
await seed('R1');
expect('everybody in the room reads its marks', await call('GET', 'rooms/R1/mod', undefined, 'bob'), true);
expect('a racer cannot close a room', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'alice' }, 'alice'), false);
expect('nor a Google account that is not an admin', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'gina' }, 'google'), false);
expect('nor an anonymous account listed under admins/ by mistake', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'anonboss' }, 'anonAdmin'), false);
expect('an admin cannot close it in somebody else\'s name', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'alice' }, 'admin'), false);
expect('nor with a made-up time', await call('PUT', 'rooms/R1/mod/closed', { at: 5, by: 'boss' }, 'admin'), false);
expect('nor with anything else in it', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'boss', why: 'x' }, 'admin'), false);
expect('nor a mark the rules do not know', await call('PUT', 'rooms/R1/mod/frozen', true, 'admin'), false);
expect('an admin closes the room', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'boss' }, 'admin'), true);
expect('closed: bob\'s heartbeat is refused', await heartbeat('R1', 'bob'), false);
expect('closed: carol cannot join', await enter('R1', 'carol'), false);
expect('closed: bob cannot send a time', await call('PUT', 'rooms/R1/rounds/1/results/bob', result(), 'bob'), false);
expect('closed: bob cannot post', await chat('R1', 'bob', 'hello?'), false);
expect('closed: bob can still leave', await call('DELETE', 'rooms/R1/players/bob', undefined, 'bob'), true);
expect('closed: a racer cannot reopen it', await call('DELETE', 'rooms/R1/mod/closed', undefined, 'alice'), false);
expect('…nor by rewriting the marks', await call('PUT', 'rooms/R1/mod', {}, 'alice'), false);
expect('an admin reopens it', await call('DELETE', 'rooms/R1/mod/closed', undefined, 'admin'), true);
expect('reopened: carol joins', await enter('R1', 'carol'), true);
expect('reopened: carol posts', await chat('R1', 'carol', 'hi all'), true);

/* ---------------- removing a player ---------------- */
await seed('R2');
expect('a racer cannot remove another', await call('DELETE', 'rooms/R2/players/bob', undefined, 'alice'), false);
expect('nor mark somebody removed', await call('PUT', 'rooms/R2/mod/kicked/bob', TS, 'alice'), false);
expect('an admin removes bob: the mark and his row in one update', await call('PATCH', '', {
  'rooms/R2/mod/kicked/bob': TS, 'rooms/R2/players/bob': null,
}, 'admin'), true);
expect('an admin cannot write somebody\'s row, only take it away', await call('PUT', 'rooms/R2/players/carol', { name: 'x', joinedAt: 1 }, 'admin'), false);
expect('removed: bob cannot come back', await enter('R2', 'bob'), false);
expect('removed: bob cannot send a time', await call('PUT', 'rooms/R2/rounds/1/results/bob', result(), 'bob'), false);
expect('removed: bob cannot post', await chat('R2', 'bob', 'let me in'), false);
expect('removed: alice is not affected', await heartbeat('R2', 'alice'), true);
expect('…nor is carol joining', await enter('R2', 'carol'), true);
expect('a removal mark must be a time', await call('PUT', 'rooms/R2/mod/kicked/carol', 'yes', 'admin'), false);
expect('an admin lets bob back in', await call('DELETE', 'rooms/R2/mod/kicked/bob', undefined, 'admin'), true);
expect('back in: bob joins', await enter('R2', 'bob'), true);
expect('back in: bob sends his time', await call('PUT', 'rooms/R2/rounds/1/results/bob', result(), 'bob'), true);

/* ---------------- striking a time ---------------- */
const strike = (by, extra = {}) => ({ at: TS, by, ...extra });
expect('a racer cannot strike a time', await call('PUT', 'rooms/R2/mod/struck/1/alice', strike('bob'), 'bob'), false);
expect('an admin strikes alice\'s time in round 1, with a reason', await call('PUT', 'rooms/R2/mod/struck/1/alice', strike('boss', { reason: 'misfire, she said so' }), 'admin'), true);
expect('…not with a reason past 200 characters', await call('PUT', 'rooms/R2/mod/struck/1/bob', strike('boss', { reason: 'x'.repeat(201) }), 'admin'), false);
expect('…not in a round that is not a number', await call('PUT', 'rooms/R2/mod/struck/one/bob', strike('boss'), 'admin'), false);
expect('…not in somebody else\'s name', await call('PUT', 'rooms/R2/mod/struck/1/bob', strike('gina'), 'admin'), false);
expect('…not with anything else in it', await call('PUT', 'rooms/R2/mod/struck/1/bob', strike('boss', { undo: true }), 'admin'), false);
expect('the time itself is untouched', await call('GET', 'rooms/R2/rounds/1/results/alice', undefined, 'alice'), true);
expect('alice cannot take the strike back', await call('DELETE', 'rooms/R2/mod/struck/1/alice', undefined, 'alice'), false);
expect('an admin can', await call('DELETE', 'rooms/R2/mod/struck/1/alice', undefined, 'admin'), true);

/* ---------------- deleting a room ---------------- */
await seed('R3');
expect('a racer cannot delete a room', await call('DELETE', 'rooms/R3', undefined, 'alice'), false);
expect('nor a Google account that is not an admin', await call('DELETE', 'rooms/R3', undefined, 'google'), false);
expect('an admin cannot write a whole room', await call('PUT', 'rooms/R3', { meta: { round: 1 } }, 'admin'), false);
expect('an admin deletes it', await call('DELETE', 'rooms/R3', undefined, 'admin'), true);
expect('…and it is gone', { ok: (await call('GET', 'rooms/R3', undefined, 'owner')).body === null }, true);

/* ---------------- when a penalty changed ---------------- */
await seed('R4');
await call('PUT', 'rooms/R4/rounds/1/results/bob', result(12000), 'bob');
expect('bob adds a +2, with the time it changed', await call('PATCH', 'rooms/R4/rounds/1/results/bob', { penalty: '+2', penaltyAt: TS }, 'bob'), true);
expect('…the time must be the server\'s', await call('PATCH', 'rooms/R4/rounds/1/results/bob', { penalty: 'DNF', penaltyAt: 5 }, 'bob'), false);
expect('…and only his own', await call('PATCH', 'rooms/R4/rounds/1/results/alice', { penaltyAt: TS }, 'bob'), false);
expect('…and only on a time that is in', await call('PUT', 'rooms/R4/rounds/1/results/carol/penaltyAt', TS, 'carol'), false);
expect('the penalty alone still works, as on the old rules', await call('PUT', 'rooms/R4/rounds/1/results/bob/penalty', 'DNF', 'bob'), true);

/* ---------------- the relay count ---------------- */
const now = Date.now();
const today = now - ((now + IST) % DAY);
const td = (uid, day = today) => `turnDay/${day}/${uid}`;
expect('alice counts her first relay login today', await call('PUT', td('alice'), 1, 'alice'), true);
expect('…and her second', await call('PUT', td('alice'), 2, 'alice'), true);
expect('…but cannot skip ahead', await call('PUT', td('alice'), 5, 'alice'), false);
expect('…nor go back', await call('PUT', td('alice'), 1, 'alice'), false);
expect('…nor take it away', await call('DELETE', td('alice'), undefined, 'alice'), false);
expect('…nor count yesterday', await call('PUT', td('alice', today - DAY), 1, 'alice'), false);
expect('…nor start anywhere but 1', await call('PUT', td('carol'), 3, 'carol'), false);
expect('bob cannot count for alice', await call('PUT', td('alice'), 3, 'bob'), false);
expect('alice reads her own count', await call('GET', td('alice'), undefined, 'alice'), true);
expect('…but not the day\'s', await call('GET', `turnDay/${today}`, undefined, 'alice'), false);
expect('an admin reads the day\'s', await call('GET', `turnDay/${today}`, undefined, 'admin'), true);
expect('a non-admin Google account does not', await call('GET', 'turnDay', undefined, 'google'), false);
await call('PUT', td('zed', today - 20 * DAY), 4, 'owner');
expect('an admin sweeps a day long gone', await call('DELETE', `turnDay/${today - 20 * DAY}`, undefined, 'admin'), true);
expect('…but not today', await call('DELETE', `turnDay/${today}`, undefined, 'admin'), false);
expect('a racer sweeps nothing', await call('DELETE', `turnDay/${today - 20 * DAY}`, undefined, 'alice'), false);

/* ================= the rules from before this phase ================= */

await load('rooms-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
await seed('R5');
expect('old rules: closing a room is refused cleanly', await call('PUT', 'rooms/R5/mod/closed', { at: TS, by: 'boss' }, 'admin'), false);
expect('old rules: the marks cannot be read, which reads as none', await call('GET', 'rooms/R5/mod', undefined, 'alice'), false);
expect('old rules: a penalty with its time is refused…', await call('PATCH', 'rooms/R5/rounds/1/results/alice', { penalty: '+2', penaltyAt: TS }, 'alice'), false);
expect('…so the app sends the penalty alone, which lands', await call('PUT', 'rooms/R5/rounds/1/results/alice/penalty', '+2', 'alice'), true);
expect('old rules: counting a relay login is refused, and the app shrugs', await call('PUT', td('alice'), 1, 'alice'), false);
expect('old rules: joining, times and chat as before', (await enter('R5', 'carol')).ok && (await chat('R5', 'carol', 'hi')).ok
  ? { ok: true } : { ok: false }, true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
