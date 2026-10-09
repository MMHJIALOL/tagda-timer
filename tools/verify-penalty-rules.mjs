/* Changing a penalty after the time was submitted, checked against the database emulator.
       node tools/verify-penalty-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-penalty-rules.mjs

   A race room's result and a Scramble of the Day result are both write-once,
   so a +2 or DNF added after the solve used to stay on your own times list
   and never reach the room or the board. The `penalty` child now takes one
   more write from its owner: a heavier penalty at any time, and a lighter
   one (or clearing it) only within 15 s of submitting — a correction, not a
   way to take back a +2 once everybody else's times are in front of you.

   Loads firebase.rules.json into a namespace of its own (`penalty-rules`).
   Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'penalty-rules';
const IST = 19800000, DAY = 86400000;
const TS = { '.sv': 'timestamp' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'anonymous') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const users = { alice: token('alice'), bob: token('bob') };

async function call(method, path, body, who) {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
}

let failed = 0;
function expect(name, res, ok) {
  const pass = res.ok === ok;
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`}`);
}

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');

/* ---------------- a race room ---------------- */

const room = 'rooms/PEN1';
await call('PUT', room, {
  meta: { phase: 'racing', round: 1, createdAt: Date.now() },
  players: { alice: { name: 'alice', joinedAt: Date.now(), lastSeen: Date.now() }, bob: { name: 'bob', joinedAt: Date.now(), lastSeen: Date.now() } },
  rounds: { 1: { info: { scramble: 'R U', hash: 'h1', startedAt: Date.now() } } },
}, 'owner');
const res = (uid) => `${room}/rounds/1/results/${uid}`;

expect('race: alice submits 10.00 with no penalty',
  await call('PUT', res('alice'), { timeMs: 10000, penalty: 'none', hash: 'h1', submittedAt: TS }, 'alice'), true);
expect('race: the result itself is still write-once',
  await call('PUT', res('alice'), { timeMs: 8000, penalty: 'none', hash: 'h1', submittedAt: TS }, 'alice'), false);
expect('race: nor can the time be changed on its own',
  await call('PUT', `${res('alice')}/timeMs`, 8000, 'alice'), false);
expect('race: alice adds a +2 afterwards',
  await call('PUT', `${res('alice')}/penalty`, '+2', 'alice'), true);
expect('race: and turns it into a DNF',
  await call('PUT', `${res('alice')}/penalty`, 'DNF', 'alice'), true);
expect('race: and, inside 15 s, clears it again',
  await call('PUT', `${res('alice')}/penalty`, 'none', 'alice'), true);
expect('race: bob cannot touch alice’s penalty',
  await call('PUT', `${res('alice')}/penalty`, 'DNF', 'bob'), false);
expect('race: a penalty cannot be written before there is a result',
  await call('PUT', `${res('bob')}/penalty`, '+2', 'bob'), false);
expect('race: nor deleted',
  await call('DELETE', `${res('alice')}/penalty`, undefined, 'alice'), false);
expect('race: nor set to something that is not a penalty',
  await call('PUT', `${res('alice')}/penalty`, 'x', 'alice'), false);

// Past the 15 s window: pretend the result went in a minute ago.
await call('PUT', `${res('alice')}/submittedAt`, Date.now() - 60000, 'owner');
await call('PUT', `${res('alice')}/penalty`, '+2', 'owner');
expect('race: after 15 s a +2 can still become a DNF',
  await call('PUT', `${res('alice')}/penalty`, 'DNF', 'alice'), true);
expect('race: but a DNF cannot be taken back to a +2',
  await call('PUT', `${res('alice')}/penalty`, '+2', 'alice'), false);
expect('race: or cleared',
  await call('PUT', `${res('alice')}/penalty`, 'none', 'alice'), false);
await call('PUT', `${res('alice')}/penalty`, '+2', 'owner');
expect('race: nor a +2 cleared once everybody’s times are in front of you',
  await call('PUT', `${res('alice')}/penalty`, 'none', 'alice'), false);

/* ---------------- Scramble of the Day ---------------- */

const now = Date.now();
const today = String(now - ((now + IST) % DAY));
const day = (uid) => `daily/${today}/333/results/${uid}`;

expect('sotd: bob submits 9.00',
  await call('PUT', day('bob'), { timeMs: 9000, penalty: 'none', name: 'bob', submittedAt: TS }, 'bob'), true);
expect('sotd: bob adds a +2 afterwards',
  await call('PUT', `${day('bob')}/penalty`, '+2', 'bob'), true);
expect('sotd: alice cannot',
  await call('PUT', `${day('bob')}/penalty`, 'DNF', 'alice'), false);
expect('sotd: no penalty before a result exists',
  await call('PUT', `${day('alice')}/penalty`, 'DNF', 'alice'), false);
await call('PUT', `${day('bob')}/submittedAt`, Date.now() - 60000, 'owner');
expect('sotd: after 15 s a +2 cannot be cleared',
  await call('PUT', `${day('bob')}/penalty`, 'none', 'bob'), false);
expect('sotd: but it can still become a DNF',
  await call('PUT', `${day('bob')}/penalty`, 'DNF', 'bob'), true);
await call('PUT', `bans/bob`, { until: Date.now() + DAY, by: 'x', at: Date.now() }, 'owner');
await call('PUT', `${day('bob')}/penalty`, '+2', 'owner');
expect('sotd: a banned account cannot edit its row',
  await call('PUT', `${day('bob')}/penalty`, 'DNF', 'bob'), false);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
