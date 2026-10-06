/* The admin console's moderation rules (reports/, admins reading the day's
   boards and chats, taking down race chat, race results and replay flags),
   checked against the database emulator.
       node tools/verify-moderation-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-moderation-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`moderation-rules`),
   so a running `tools/sotd-replay-dev.mjs` and the app's data are not
   touched. Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'moderation-rules';
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

async function call(method, path, body, who, query = '') {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}${query}`, {
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
const set = (path, value) => call('PUT', path, value, 'owner');

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');
await set('admins/boss', true);

const now = Date.now();
const today = String(now - ((now + IST) % DAY));
const base = `daily/${today}/333`;
await set(`${base}/results/alice`, { timeMs: 9000, penalty: 'none', name: 'alice', replay: true });
await set(`${base}/results/bob`, { timeMs: 9500, penalty: 'none', name: 'bob', suspect: true });
await set(`${base}/chat/m/m1`, { uid: 'alice', name: 'alice', text: 'hello', at: 1 });
await set(`${base}/chat/m/m2`, { uid: 'bob', name: 'bob', text: 'rude words', at: 2 });
await set('rooms/ABCDE', {
  meta: { createdAt: now, event: '333', round: 1 },
  players: { anon: { name: 'Anon', joinedAt: 1 } },
  chat: { c1: { uid: 'anon', name: 'Anon', text: 'spam spam', at: 1 } },
  rounds: { 1: { info: { scramble: 'R U', hash: 'h' }, results: { anon: { timeMs: 1200, hash: 'h', suspect: true } } } },
});
await set('rooms/OLDER', { meta: { createdAt: now - 3 * DAY, event: '333', round: 1 } });

console.log(`rules from firebase.rules.json, namespace ${NS}, today ${today}\n`);

/* ---------------- an admin reads what the queue needs ---------------- */

expect('an admin reads the day’s chat without having solved', await call('GET', `${base}/chat/m`, undefined, 'boss'), true);
expect('carol, who has not solved, still cannot', await call('GET', `${base}/chat/m`, undefined, 'carol'), false);
expect('an anonymous account cannot', await call('GET', `${base}/chat/m`, undefined, 'anon'), false);
expect('an admin reads the day’s board without having solved', await call('GET', `${base}/results`, undefined, 'boss'), true);
expect('carol still cannot', await call('GET', `${base}/results`, undefined, 'carol'), false);
expect('alice, who solved, still can', await call('GET', `${base}/results`, undefined, 'alice'), true);
const recent = await call('GET', 'rooms', undefined, 'boss', `&orderBy=${encodeURIComponent('"meta/createdAt"')}&startAt=${now - DAY}`);
expect('an admin lists the rooms made in the last day, by meta/createdAt', check(recent.ok && Object.keys(recent.body || {}).join() === 'ABCDE', recent.body && Object.keys(recent.body)), true);
expect('a racer cannot list rooms', await call('GET', 'rooms', undefined, 'anon', '&shallow=true'), false);
expect('a signed-in non-admin cannot either', await call('GET', 'rooms', undefined, 'alice', '&shallow=true'), false);
expect('a racer still reads a room’s chat', await call('GET', 'rooms/ABCDE/chat', undefined, 'anon2'), true);

/* ---------------- an admin takes things down ---------------- */

expect('a racer cannot delete a race message, even their own', await call('DELETE', 'rooms/ABCDE/chat/c1', undefined, 'anon'), false);
expect('a non-admin cannot', await call('DELETE', 'rooms/ABCDE/chat/c1', undefined, 'alice'), false);
expect('an admin deletes a race message', await call('DELETE', 'rooms/ABCDE/chat/c1', undefined, 'boss'), true);
expect('a racer cannot take down their own race result', await call('DELETE', 'rooms/ABCDE/rounds/1/results/anon', undefined, 'anon'), false);
expect('…nor somebody else’s', await call('DELETE', 'rooms/ABCDE/rounds/1/results/anon', undefined, 'anon2'), false);
expect('an admin takes a race result down', await call('DELETE', 'rooms/ABCDE/rounds/1/results/anon', undefined, 'boss'), true);
expect('an admin cannot write a race result for somebody', await call('PUT', 'rooms/ABCDE/rounds/1/results/anon', { timeMs: 1, hash: 'h' }, 'boss'), false);
expect('bob cannot clear alice’s replay flag', await call('DELETE', `${base}/results/alice/replay`, undefined, 'bob'), false);
expect('an admin clears alice’s replay flag', await call('DELETE', `${base}/results/alice/replay`, undefined, 'boss'), true);
expect('an admin cannot set it', await call('PUT', `${base}/results/alice/replay`, true, 'boss'), false);
await set(`${base}/results/alice/replay`, true);

/* ---------------- reports ---------------- */

let n = 0;
const key = (kind, path) => `${kind}|${path.split('/').join('|')}`;
const report = (who, kind, path, extra = {}, opts = {}) => {
  const id = opts.id || `r${String(++n).padStart(3, '0')}`;
  const uid = opts.as || who;
  const body = { [`reports/${id}`]: { by: uid, at: TS, kind, path, ...extra } };
  if (!opts.noOnce) body[`reportOnce/${opts.onceFor || uid}/${opts.onceKey || key(kind, path)}`] = opts.onceId || id;
  return call('PATCH', '', body, who).then(r => Object.assign(r, { id }));
};
const msg = `${base}/chat/m/m2`;
const first = await report('alice', 'chat', msg, { text: 'rude words' });
expect('a Google account reports a chat message', first, true);
expect('…once: the same item again is refused', await report('alice', 'chat', msg), false);
expect('carol reports the same message too (one each)', await report('carol', 'chat', msg), true);
expect('an anonymous account cannot report', await report('anon', 'chat', msg), false);
expect('signed out cannot report', await report(null, 'chat', msg, {}, { as: 'x' }), false);
expect('a race message, by kind raceChat', await report('alice', 'raceChat', 'rooms/ABCDE/chat/c2', {}, {}), false);
await set('rooms/ABCDE/chat/c2', { uid: 'anon', name: 'Anon', text: 'more spam', at: 3 });
expect('…allowed once it exists', await report('alice', 'raceChat', 'rooms/ABCDE/chat/c2', { text: 'more spam' }), true);
expect('a shared replay', await report('bob', 'replay', `${base}/results/alice`), true);
expect('a replay where there is none (bob’s row has no flag)', await report('alice', 'replay', `${base}/results/bob`), false);
expect('a result', await report('alice', 'result', `${base}/results/bob`), true);
expect('a path of the wrong shape for its kind', await report('bob', 'chat', `${base}/results/alice`), false);
expect('a path somewhere else entirely', await report('bob', 'chat', 'users/alice/solves/s1'), false);
expect('a kind that does not exist', await report('bob', 'other', msg), false);
expect('without its reportOnce entry', await report('bob', 'chat', msg, {}, { noOnce: true }), false);
expect('with a reportOnce for another item', await report('bob', 'chat', msg, {}, { onceKey: key('chat', `${base}/chat/m/m1`) }), false);
expect('with a reportOnce naming another report', await report('bob', 'chat', msg, {}, { onceId: first.id }), false);
expect('in somebody else’s name', await report('bob', 'chat', `${base}/chat/m/m1`, {}, { as: 'carol', onceFor: 'carol' }), false);
expect('with a client clock', await report('bob', 'chat', `${base}/chat/m/m1`, { at: Date.now() }), false);
expect('with a field that is not allowed', await report('bob', 'chat', `${base}/chat/m/m1`, { mood: 'angry' }), false);
expect('with 201 characters of text', await report('bob', 'chat', `${base}/chat/m/m1`, { text: 'x'.repeat(201) }), false);
await set('bans/bob', { at: now, by: 'boss', reason: 'x' });
expect('a banned account cannot report', await report('bob', 'chat', `${base}/chat/m/m1`), false);
await call('DELETE', 'bans/bob', undefined, 'owner');
expect('a reportOnce on its own is refused', await call('PUT', `reportOnce/bob/${key('chat', `${base}/chat/m/m1`)}`, 'zzz', 'bob'), false);

expect('an admin reads the reports', await call('GET', 'reports', undefined, 'boss'), true);
expect('the reporter cannot', await call('GET', 'reports', undefined, 'alice'), false);
expect('…but can read their own reportOnce (to say “already reported”)', await call('GET', `reportOnce/alice/${key('chat', msg)}`, undefined, 'alice'), true);
expect('…and not somebody else’s', await call('GET', 'reportOnce/carol', undefined, 'alice'), false);
expect('a report cannot be edited', await call('PUT', `reports/${first.id}/text`, 'changed', 'alice'), false);
expect('the reporter cannot withdraw it', await call('DELETE', `reports/${first.id}`, undefined, 'alice'), false);
expect('a reportOnce cannot be deleted (no second report after a dismissal)', await call('DELETE', `reportOnce/alice/${key('chat', msg)}`, undefined, 'alice'), false);
expect('an admin dismisses a report', await call('DELETE', `reports/${first.id}`, undefined, 'boss'), true);
expect('…and alice still cannot report that message again', await report('alice', 'chat', msg), false);
expect('a non-admin cannot dismiss one', await call('DELETE', 'reports/r003', undefined, 'bob'), false);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
