/* The 1v1's signed-in cam and mic and its opponent report (RACE.md §9,
   ADMIN.md §6), checked against the database emulator.
       node tools/verify-duel-signin-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-duel-signin-rules.mjs

   rooms/<id>/acct/<uid>: a seat claims a Google account, the account
   confirms it, and only then (while duel.camSignedIn is on) may the seat
   set up a call under rtc/. A banned account confirms nothing and calls
   nobody. reports/ kind 'duel': an opponent, from the reporter's own linked
   seat in the same 1v1.

   Loads firebase.rules.json into a namespace of its own (`duel-signin`), and
   the rules from before the link into another (`duel-signin-old`). Users are
   unsigned tokens, as in verify-rooms-rules.mjs. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const TS = { '.sv': 'timestamp' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'anonymous') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
// Race seats are anonymous; gina, gail and bad are Google accounts.
const users = {
  admin: token('boss', 'google.com'),
  alice: token('alice'), bob: token('bob'), carol: token('carol'),
  gina: token('gina', 'google.com'), gail: token('gail', 'google.com'), bad: token('bad', 'google.com'),
};

let NS = 'duel-signin';
async function call(method, path, body, who) {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}
const set = (path, value) => call('PUT', path, value, 'owner');

let failed = 0, passed = 0;
function expect(name, res, ok) {
  const pass = res.ok === ok;
  if (pass) passed++; else failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`}`);
}
const check = (name, cond, got) => expect(name, { ok: !!cond, status: 0, body: got }, true);

async function load(ns, text) {
  NS = ns;
  const r = await fetch(`${DB}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text });
  if (!r.ok) { console.error('could not load the rules:', r.status, await r.text()); process.exit(1); }
  await call('DELETE', '', undefined, 'owner');
  await set('admins', { boss: true });
}

function oldRules() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const text = git('show', 'origin/main:firebase.rules.json');
  if (text.includes('camSignedIn')) throw new Error('origin/main already has the link; nothing to compare with');
  return text;
}

async function seed(id, kind = 'duel') {
  const now = Date.now();
  await set(`rooms/${id}`, {
    meta: { createdAt: now, event: '333', mode: 'wca', round: 1, phase: 'racing', ...(kind ? { kind } : {}) },
    players: { alice: { name: 'alice', joinedAt: now, lastSeen: now }, bob: { name: 'bob', joinedAt: now, lastSeen: now } },
  });
}

const report = (room, target, from, extra = {}) => {
  const path = `rooms/${room}/players/${target}`;
  const id = `r${Math.random().toString(36).slice(2, 10)}`;
  return { id, path, body: {
    [`reports/${id}`]: { by: extra.by || 'gina', at: TS, kind: 'duel', path, room: extra.room ?? room, from, text: 'Cam or mic · bob · round 2' },
    [`reportOnce/${extra.by || 'gina'}/duel|${path.split('/').join('|')}`]: id,
  } };
};

/* ---------------- the current rules ---------------- */
await load('duel-signin', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
await seed('DUEL1');
await seed('RACE1', null);
await set('bans/bad', { at: Date.now(), by: 'boss', reason: 'test' });

console.log('— the link —');
expect('a seat claims its account', await call('PUT', 'rooms/DUEL1/acct/alice/claim', 'gina', 'alice'), true);
expect('the same claim again is fine (a reload)', await call('PUT', 'rooms/DUEL1/acct/alice/claim', 'gina', 'alice'), true);
expect('a claim cannot be changed to another account', await call('PUT', 'rooms/DUEL1/acct/alice/claim', 'gail', 'alice'), false);
expect('nobody claims for another seat', await call('PUT', 'rooms/DUEL1/acct/bob/claim', 'gail', 'alice'), false);
expect('nobody outside the room claims', await call('PUT', 'rooms/DUEL1/acct/carol/claim', 'gail', 'carol'), false);
expect('no claim in a room that is not a 1v1', await call('PUT', 'rooms/RACE1/acct/alice/claim', 'gina', 'alice'), false);
expect('another account cannot confirm the claim', await call('PUT', 'rooms/DUEL1/acct/alice/ok', true, 'gail'), false);
expect('the seat cannot confirm itself', await call('PUT', 'rooms/DUEL1/acct/alice/ok', true, 'alice'), false);
expect('the claimed account confirms it', await call('PUT', 'rooms/DUEL1/acct/alice/ok', true, 'gina'), true);
expect('confirming takes only true', await call('PUT', 'rooms/DUEL1/acct/alice/ok', 'yes', 'gina'), false);
expect('nothing else under a seat', await call('PUT', 'rooms/DUEL1/acct/alice/email', 'x', 'alice'), false);
expect('bob claims a banned account', await call('PUT', 'rooms/DUEL1/acct/bob/claim', 'bad', 'bob'), true);
expect('…which cannot confirm it', await call('PUT', 'rooms/DUEL1/acct/bob/ok', true, 'bad'), false);

console.log('— who reads it —');
expect('a seat reads its own claim', await call('GET', 'rooms/DUEL1/acct/alice/claim', undefined, 'alice'), true);
expect('the opponent cannot read which account it is', await call('GET', 'rooms/DUEL1/acct/alice/claim', undefined, 'bob'), false);
expect('the opponent reads whether it is linked', await call('GET', 'rooms/DUEL1/acct/alice/ok', undefined, 'bob'), true);
expect('somebody outside the room cannot', await call('GET', 'rooms/DUEL1/acct/alice/ok', undefined, 'carol'), false);
expect('an admin reads all of it', await call('GET', 'rooms/DUEL1/acct', undefined, 'admin'), true);

console.log('— the call needs it —');
expect('a linked seat sets up the call', await call('PUT', 'rooms/DUEL1/rtc/alice/media', { cam: true, mic: false }, 'alice'), true);
expect('an unlinked seat cannot', await call('PUT', 'rooms/DUEL1/rtc/bob/media', { cam: true, mic: false }, 'bob'), false);
expect('…nor send an offer', await call('PUT', 'rooms/DUEL1/rtc/bob/desc', { sid: 's1', type: 'offer', sdp: 'v=0' }, 'bob'), false);
expect('an unlinked seat can still delete its own node', await call('DELETE', 'rooms/DUEL1/rtc/bob', undefined, 'bob'), true);
await set('config/duel/camSignedIn', false);
expect('with duel.camSignedIn off, the unlinked seat can', await call('PUT', 'rooms/DUEL1/rtc/bob/media', { cam: true, mic: false }, 'bob'), true);
await set('config/duel/camSignedIn', true);
expect('back on, it cannot again', await call('PUT', 'rooms/DUEL1/rtc/bob/media', { cam: false, mic: true }, 'bob'), false);
await set('bans/gina', { at: Date.now(), by: 'boss', reason: 'test', until: Date.now() + 3600e3 });
expect('a linked seat whose account is banned now cannot', await call('PUT', 'rooms/DUEL1/rtc/alice/media', { cam: false, mic: true }, 'alice'), false);
await set('bans/gina', { at: Date.now() - 7200e3, by: 'boss', reason: 'test', until: Date.now() - 1000 });
expect('once the ban has run out, it can', await call('PUT', 'rooms/DUEL1/rtc/alice/media', { cam: false, mic: true }, 'alice'), true);
await set('bans/gina', null);
await set('config/duel/camEnabled', false);
expect('duel.camEnabled off still refuses a linked seat', await call('PUT', 'rooms/DUEL1/rtc/alice/media', { cam: true, mic: true }, 'alice'), false);
await set('config/duel/camEnabled', null);

console.log('— reporting the opponent —');
let r = report('DUEL1', 'bob', 'alice');
expect('a linked player reports the opponent', await call('PATCH', '', r.body, 'gina'), true);
const got = await call('GET', `reports/${r.id}`, undefined, 'admin');
check('…and the admin sees the room and the seat', got.body?.room === 'DUEL1' && got.body?.from === 'alice' && got.body?.kind === 'duel', got.body);
r = report('DUEL1', 'bob', 'alice');
expect('only once per opponent', await call('PATCH', '', r.body, 'gina'), false);
r = report('DUEL1', 'alice', 'alice');
expect('not yourself', await call('PATCH', '', r.body, 'gina'), false);
r = report('DUEL1', 'alice', 'alice', { by: 'gail' });
expect('not from a seat linked to somebody else', await call('PATCH', '', r.body, 'gail'), false);
r = report('DUEL1', 'bob', 'bob', { by: 'bad' });
expect('not from a seat whose account never confirmed', await call('PATCH', '', r.body, 'bad'), false);
r = report('DUEL1', 'bob', 'alice', { room: 'RACE1' });
expect('the room must be the one in the path', await call('PATCH', '', r.body, 'gina'), false);
await set('rooms/RACE1/acct/alice', { claim: 'gina', ok: true });
r = report('RACE1', 'bob', 'alice');
expect('only in a 1v1', await call('PATCH', '', r.body, 'gina'), false);
r = report('DUEL1', 'carol', 'alice');
const anon = { ...r.body };
expect('an anonymous account cannot report', await call('PATCH', '', anon, 'alice'), false);

console.log('— reports from before still work —');
await set('rooms/RACE1/chat/m1', { uid: 'bob', name: 'bob', text: 'hi', at: Date.now() });
const cid = 'rchat1';
expect('a race chat message is still reported', await call('PATCH', '', {
  [`reports/${cid}`]: { by: 'gail', at: TS, kind: 'raceChat', path: 'rooms/RACE1/chat/m1', text: 'hi' },
  [`reportOnce/gail/raceChat|rooms|RACE1|chat|m1`]: cid,
}, 'gail'), true);
expect('…but not one that is not there', await call('PATCH', '', {
  [`reports/rchat2`]: { by: 'gail', at: TS, kind: 'raceChat', path: 'rooms/RACE1/chat/m9', text: 'hi' },
  [`reportOnce/gail/raceChat|rooms|RACE1|chat|m9`]: 'rchat2',
}, 'gail'), false);

/* ---------------- the rules from before ---------------- */
console.log('— rules from before the link (not yet published) —');
await load('duel-signin-old', oldRules());
await seed('DUEL1');
expect('the claim is refused, so the app knows not to gate', await call('PUT', 'rooms/DUEL1/acct/alice/claim', 'gina', 'alice'), false);
expect('…and an unlinked seat calls as before', await call('PUT', 'rooms/DUEL1/rtc/bob/media', { cam: true, mic: false }, 'bob'), true);
expect('…and its opponent cannot read a link', await call('GET', 'rooms/DUEL1/acct/alice/ok', undefined, 'bob'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
