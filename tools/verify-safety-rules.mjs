/* The admin console's safety switches and bans, checked against the database emulator.
       node tools/verify-safety-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-safety-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`safety-rules`), so a
   running `tools/sotd-replay-dev.mjs` and the app's data are not touched.
   Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs. Settings
   are put straight into config/ as the owner: that they can only get there
   with a log entry is verify-admin-rules.mjs's job; this one checks what the
   other rules do with them, and what they do with nothing there at all. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'safety-rules';
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
const users = {
  boss: token('boss'), alice: token('alice'), bob: token('bob'), carol: token('carol'),
  anon: token('anon', 'anonymous'), anon2: token('anon2', 'anonymous'),
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const set = (path, value) => call(value === null ? 'DELETE' : 'PUT', path, value === null ? undefined : value, 'owner');

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');
await set('admins/boss', true);

const now = Date.now();
if ((now + IST) % DAY > DAY - 60_000) { console.error('within a minute of 00:00 IST: run it again shortly'); process.exit(1); }
const today = String(now - ((now + IST) % DAY));
const yday = String(Number(today) - DAY);
const old = String(Number(today) - 3 * DAY);
const base = `daily/${today}/333`;
let n = 0;

console.log(`rules from firebase.rules.json, namespace ${NS}, today ${today}\n`);

/* ---------------- the day's chat ---------------- */

const say = (who, text = 'gg') => {
  const id = `m${++n}`;
  return call('PATCH', `${base}/chat`, {
    [`m/${id}`]: { uid: who, name: who, text, at: TS }, [`last/${who}`]: TS,
  }, who).then(r => Object.assign(r, { id }));
};
for (const u of ['alice', 'bob', 'carol']) await set(`${base}/results/${u}`, { timeMs: 9000, penalty: 'none', name: u });

expect('no config at all: a message is allowed (today’s rules)', await say('alice'), true);
expect('no config: a second one inside 1.5 s is refused', await say('alice'), false);
await sleep(1600);
expect('no config: 200 characters allowed', await say('alice', 'x'.repeat(200)), true);
await sleep(1600);
expect('no config: 201 refused', await say('alice', 'x'.repeat(201)), false);

await set('config/sotdChat/maxLen', 50);
expect('maxLen 50: 51 characters refused', await say('alice', 'y'.repeat(51)), false);
expect('maxLen 50: 50 allowed', await say('alice', 'y'.repeat(50)), true);
await set('config/sotdChat/gapMs', 4000);
await sleep(1600);
expect('gapMs 4000: 1.6 s later is refused', await say('alice'), false);
await sleep(2600);
expect('gapMs 4000: 4.2 s later is allowed', await say('alice'), true);
await set('config/sotdChat/gapMs', null);

await set('config/sotdChat/enabled', false);
await sleep(1600);
const off = await say('bob');
expect('switched off: nobody can post', off, false);
const kept = await call('GET', `${base}/chat/m`, undefined, 'bob');
expect('switched off: the room is still readable', kept, true);
const anyId = Object.keys(kept.body || {})[0];
expect('switched off: the admin can still delete', await call('DELETE', `${base}/chat/m/${anyId}`, undefined, 'boss'), true);
await set('config/sotdChat/enabled', true);
expect('switched on again: posting works', await say('bob'), true);
await set('config/sotdChat', null);

/* ---------------- bans ---------------- */

const ban = (who, uid, rec) => call('PUT', `bans/${uid}`, rec, who);
expect('a non-admin cannot ban', await ban('alice', 'carol', { at: TS, by: 'alice', reason: 'x' }), false);
expect('an anonymous account cannot ban', await ban('anon', 'carol', { at: TS, by: 'anon', reason: 'x' }), false);
expect('signed out cannot ban', await ban(null, 'carol', { at: TS, by: 'x', reason: 'x' }), false);
expect('a ban needs a reason, now, and the admin’s uid', await ban('boss', 'carol', { at: TS, by: 'alice', reason: 'x' }), false);
expect('a ban that ends in the past is refused', await ban('boss', 'carol', { at: TS, by: 'boss', reason: 'x', until: Date.now() - 1000 }), false);
expect('an admin bans carol', await ban('boss', 'carol', { at: TS, by: 'boss', reason: 'spam in the chat', name: 'Carol' }), true);
expect('carol can read her own ban', await call('GET', 'bans/carol', undefined, 'carol'), true);
expect('alice cannot read carol’s ban', await call('GET', 'bans/carol', undefined, 'alice'), false);
expect('alice can read that she has none (null)', await call('GET', 'bans/alice', undefined, 'alice'), true);
expect('only an admin reads the list', await call('GET', 'bans', undefined, 'alice'), false);
expect('an admin reads the list', await call('GET', 'bans', undefined, 'boss'), true);
expect('carol cannot delete her own ban', await call('DELETE', 'bans/carol', undefined, 'carol'), false);

await sleep(1600);
expect('banned: carol cannot post in the day’s chat', await say('carol'), false);
expect('banned: carol cannot write her note', await call('PUT', `${base}/results/carol/note`, 'hi', 'carol'), false);
expect('banned: carol cannot claim a replay', await call('PUT', `${base}/replayClaim/carol`, TS, 'carol'), false);
await set(`${base}/results/carol`, null);
expect('banned: carol cannot submit a time', await call('PUT', `${base}/results/carol`, { timeMs: 9000, penalty: 'none', name: 'carol' }, 'carol'), false);
expect('…while dave, not banned, can', await call('PUT', `${base}/results/dave`, { timeMs: 9000, penalty: 'none', name: 'dave' },
  (users.dave = token('dave'), 'dave')), true);
expect('banned: carol can still keep her timer in the cloud', await call('PUT', 'users/carol/solves/s1',
  { id: 's1', createdAt: 1, timeMs: 9000 }, 'carol'), true);

expect('an admin unbans carol', await call('DELETE', 'bans/carol', undefined, 'boss'), true);
expect('unbanned: carol submits', await call('PUT', `${base}/results/carol`, { timeMs: 9100, penalty: 'none', name: 'carol' }, 'carol'), true);
await sleep(1600);
expect('unbanned: carol posts', await say('carol'), true);

expect('a ban with an end date', await ban('boss', 'bob', { at: TS, by: 'boss', reason: 'cool off', until: Date.now() + 2500 }), true);
await sleep(1600);
expect('…holds until then', await say('bob'), false);
await sleep(1500);
expect('…and is over after it, without anybody deleting it', await say('bob'), true);

/* ---------------- replay claims and the day's count ---------------- */

expect('a claim (not banned) is still allowed', await call('PUT', `${base}/replayClaim/alice`, TS, 'alice'), true);
expect('the count entry needs your own claim first', await call('PUT', `replayDay/${today}/333/bob`, TS, 'bob'), false);
expect('your own count entry, with your claim', await call('PUT', `replayDay/${today}/333/alice`, TS, 'alice'), true);
expect('only once', await call('PUT', `replayDay/${today}/333/alice`, TS, 'alice'), false);
expect('not for somebody else', await call('PUT', `replayDay/${today}/333/bob`, TS, 'alice'), false);
expect('not deleted, even by its owner', await call('DELETE', `replayDay/${today}/333/alice`, undefined, 'alice'), false);
expect('anybody signed in reads the day’s count', await call('GET', `replayDay/${today}`, undefined, 'bob'), true);
expect('signed out cannot', await call('GET', `replayDay/${today}`, undefined, null), false);
await set(`replayDay/${old}`, { 333: { alice: 1 } });
await set(`replayDay/${yday}`, { 333: { alice: 1 } });
expect('a day older than yesterday can be swept by anybody signed in', await call('DELETE', `replayDay/${old}`, undefined, 'bob'), true);
expect('yesterday cannot (its replays can still be shared)', await call('DELETE', `replayDay/${yday}`, undefined, 'bob'), false);
expect('today cannot', await call('DELETE', `replayDay/${today}`, undefined, 'bob'), false);

/* ---------------- race rooms ---------------- */

const room = 'rooms/ABCDE';
expect('no config: anybody creates a room', await call('PUT', `${room}/meta`, { createdAt: TS, event: '333', mode: 'normal', round: 1 }, 'anon'), true);
await set('config/race/enabled', false);
expect('switched off: a new room is refused', await call('PUT', 'rooms/FGHJK/meta', { createdAt: TS, event: '333', mode: 'normal', round: 1 }, 'anon'), false);
expect('switched off: an open room carries on (the next round)', await call('PUT', `${room}/meta/round`, 2, 'anon'), true);
expect('switched off: its phase still moves', await call('PATCH', `${room}/meta`, { phase: 'racing' }, 'anon'), true);
expect('switched off: people still join it', await call('PUT', `${room}/players/anon2`, { name: 'Two', joinedAt: 1, lastSeen: 1 }, 'anon2'), true);
await set('config/race', null);

/* ---------------- race chat ---------------- */

const rsay = (who, text = 'gg', { last = true, at = TS } = {}) => {
  const id = `r${++n}`;
  const body = { [`chat/${id}`]: { uid: who, name: who, text, at } };
  if (last) body[`chatLast/${who}`] = TS;
  return call('PATCH', room, body, who);
};
expect('an anonymous racer posts, with chatLast', await rsay('anon'), true);
expect('straight away again: refused (0.5 s with no config)', await rsay('anon'), false);
await sleep(600);
expect('0.6 s later: allowed', await rsay('anon'), true);
await sleep(600);
expect('without chatLast (the old shape): refused', await rsay('anon', 'gg', { last: false }), false);
expect('a client clock in `at`: refused', await rsay('anon', 'gg', { at: Date.now() }), false);
expect('somebody else’s chatLast: refused', await call('PUT', `${room}/chatLast/anon2`, TS, 'anon'), false);
expect('201 characters: refused', await rsay('anon', 'z'.repeat(201)), false);
await set('config/raceChat/maxLen', 30);
await sleep(600);
expect('maxLen 30: 31 refused', await rsay('anon', 'z'.repeat(31)), false);
expect('maxLen 30: 30 allowed', await rsay('anon', 'z'.repeat(30)), true);
await set('config/raceChat/gapMs', 3000);
await sleep(1000);
expect('gapMs 3000: 1 s later refused', await rsay('anon'), false);
await sleep(2200);
expect('gapMs 3000: 3.2 s later allowed', await rsay('anon'), true);
await set('config/raceChat/enabled', false);
await sleep(3200);
expect('switched off: refused', await rsay('anon'), false);
expect('switched off: the room’s chat is still readable', await call('GET', `${room}/chat`, undefined, 'anon2'), true);
await set('config/raceChat', null);
await ban('boss', 'anon2', { at: TS, by: 'boss', reason: 'race spam' });
expect('a banned racer cannot post', await rsay('anon2'), false);
await call('DELETE', 'bans/anon2', undefined, 'boss');
expect('unbanned, they can', await rsay('anon2'), true);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
