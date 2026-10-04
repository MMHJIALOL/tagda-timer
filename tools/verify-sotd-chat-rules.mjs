/* The Scramble of the Day chat rules, checked against the database emulator.
       node tools/verify-sotd-chat-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-sotd-chat-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`sotd-chat-rules`),
   so a running `tools/sotd-replay-dev.mjs` and the app's data are not
   touched. Users are unsigned tokens: the emulator reads the claims without
   checking a signature, which is how a Google account and an anonymous one
   are told apart here without signing anybody in. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'sotd-chat-rules';
const ADMIN = '8lSr96LEO1cdHDVlMDv8tCCFQag1';
const IST = 19800000, DAY = 86400000;
const TS = { '.sv': 'timestamp' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'google.com') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const users = {
  alice: token('alice'), bob: token('bob'), carol: token('carol'),
  anon: token('anon', 'anonymous'), admin: token(ADMIN),
};

async function call(method, path, body, who, query = '') {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}${query}`, {
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');

// The server's day, the same arithmetic the rules do. Seconds from a reset
// would make this flaky; checked rather than guessed.
const now = Date.now();
if ((now + IST) % DAY > DAY - 30_000) { console.error('within 30 s of 00:00 IST: run it again in a minute'); process.exit(1); }
const today = String(now - ((now + IST) % DAY));
const yday = String(Number(today) - DAY);
const base = `daily/${today}/333`;
let n = 0;
const msg = (uid, text = 'gg', extra = {}) => ({ uid, name: uid, text, at: TS, ...extra });
const send = (who, uid = who, fields = {}, { last = true, day = today, event = '333' } = {}) => {
  const id = `m${++n}`;
  const body = { [`m/${id}`]: { ...msg(uid), ...fields } };
  if (last) body[`last/${uid}`] = TS;
  return call('PATCH', `daily/${day}/${event}/chat`, body, who).then(r => Object.assign(r, { id }));
};

console.log(`rules from firebase.rules.json, namespace ${NS}, today ${today}\n`);

// ---- before your attempt
expect('reading the chat before submitting is refused', await call('GET', `${base}/chat/m`, undefined, 'alice'), false);
expect('posting before submitting is refused', await send('alice'), false);

// Results, the way the app writes them.
for (const u of ['alice', 'bob', 'anon']) {
  await call('PUT', `${base}/results/${u}`, { timeMs: 9000, penalty: 'none', name: u, submittedAt: TS }, u);
}
expect('the result itself still lands (ancestor rules unaffected)',
  await call('GET', `${base}/results/alice`, undefined, 'alice'), true);
expect('progress still writes', await call('PATCH', `${base}/progress/alice`, { status: 'done', submitted: true }, 'alice'), true);

// ---- after it
expect('reading after submitting is allowed', await call('GET', `${base}/chat/m`, undefined, 'alice', '&orderBy="$key"&limitToLast=60'), true);
const first = await send('alice');
expect('posting after submitting is allowed', first, true);
expect('a second message straight away is refused (rate limit)', await send('alice'), false);
await sleep(1600);
expect('…and allowed again after 1.5 s', await send('alice'), true);
await sleep(1600);
expect('a message without the matching last/<uid> is refused', await send('alice', 'alice', {}, { last: false }), false);
expect('a client-chosen timestamp is refused', await send('alice', 'alice', { at: Date.now() - 5000 }), false);
expect('someone else\'s uid is refused', await send('alice', 'bob'), false);
expect('201 characters is refused', await send('alice', 'alice', { text: 'x'.repeat(201) }), false);
expect('an empty message is refused', await send('alice', 'alice', { text: '' }), false);
expect('an unknown field is refused', await send('alice', 'alice', { color: 3 }), false);
expect('a photo that is not a Google avatar is refused',
  await send('alice', 'alice', { photo: 'https://evil.example/x.png' }), false);
expect('a Google avatar is allowed',
  await send('alice', 'alice', { photo: 'https://lh3.googleusercontent.com/a/x' }), true);
expect('an anonymous account with a result cannot post', await send('anon'), false);
expect('carol, who has not submitted, cannot read it', await call('GET', `${base}/chat`, undefined, 'carol'), false);
expect('nobody signed out can read it', await call('GET', `${base}/chat`, undefined, null), false);
expect('a stray node under chat is refused', await call('PUT', `${base}/chat/other`, 1, 'alice'), false);
expect('writing somebody else\'s last/ is refused', await call('PUT', `${base}/chat/last/bob`, TS, 'alice'), false);
expect('a message cannot be edited',
  await call('PUT', `${base}/chat/m/${first.id}/text`, 'edited', 'alice'), false);

// ---- deleting
const bobs = await send('bob', 'bob', { text: 'hi' });
expect('bob posts', bobs, true);
expect('alice cannot delete bob\'s message', await call('DELETE', `${base}/chat/m/${bobs.id}`, undefined, 'alice'), false);
expect('bob can delete his own', await call('DELETE', `${base}/chat/m/${bobs.id}`, undefined, 'bob'), true);
expect('the admin can delete anybody\'s, without a result of their own',
  await call('DELETE', `${base}/chat/m/${first.id}`, undefined, 'admin'), true);
expect('nobody can delete today\'s whole chat', await call('DELETE', `${base}/chat`, undefined, 'bob'), false);

// ---- other days
await call('PUT', `daily/${yday}/333/results/alice`, { timeMs: 9000, name: 'alice' }, 'owner');
await call('PUT', `daily/${yday}/333/chat`, { m: { old: { uid: 'alice', name: 'alice', text: 'yesterday', at: 1 } }, last: { alice: 1 } }, 'owner');
await call('PUT', `daily/${yday}/444/chat`, { m: { old: { uid: 'bob', name: 'bob', text: 'yesterday', at: 1 } } }, 'owner');
await sleep(1600);
expect('posting into yesterday\'s chat is refused', await send('alice', 'alice', {}, { day: yday }), false);
const tomorrow = String(Number(today) + DAY);
await call('PUT', `daily/${tomorrow}/333/results/alice`, { timeMs: 9000, name: 'alice' }, 'owner');
expect('posting into tomorrow\'s chat is refused', await send('alice', 'alice', {}, { day: tomorrow }), false);

// ---- the sweep: one blind write per past day, every event at once
const events = ['333', '222', '444', '555', 'sq1'];
const sweep = Object.fromEntries(events.map(e => [`${e}/chat`, null]));
expect('signed out, the sweep is refused', await call('PATCH', `daily/${yday}`, sweep, null), false);
expect('a signed-in user sweeps yesterday (missing chats included)', await call('PATCH', `daily/${yday}`, sweep, 'carol'), true);
const left = await call('GET', `daily/${yday}`, undefined, 'owner');
expect('yesterday\'s chats are gone, its results are not',
  { ok: !left.body?.['333']?.chat && !left.body?.['444']?.chat && !!left.body?.['333']?.results?.alice, status: 0, body: left.body }, true);
expect('sweeping today is refused', await call('PATCH', `daily/${today}`, sweep, 'carol'), false);
expect('a pre-planted chat in tomorrow\'s key can be swept',
  await call('PATCH', `daily/${tomorrow}`, sweep, 'carol'), true);
const still = await call('GET', `${base}/chat/m`, undefined, 'owner');
expect('today\'s chat survived all of that', { ok: Object.keys(still.body || {}).length > 0, status: 0, body: still.body }, true);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
