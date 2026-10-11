/* The admin console's phase 7 switches (ADMIN.md §4), checked against the database emulator.
       node tools/verify-switches-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-switches-rules.mjs

   What the rules enforce of them: Random 1v1's switch (duel.enabled) on the
   one waiting seat and on a room becoming a 1v1, the 1v1's cam and mic
   (duel.camEnabled) on the call's setup under rtc/, and every new setting's
   type and range. The rest (read-only, the features, the tuning) is the
   app's and the Worker's, and is tested there.

   Loads firebase.rules.json into a namespace of its own (`switches-rules`),
   and the rules from before this phase into another (`switches-old`) to show
   that nothing changes until they are published. Users are unsigned tokens,
   as in verify-admin-rules.mjs. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const TS = { '.sv': 'timestamp' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'google.com') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const UIDS = { admin: 'boss', alice: 'alice', bob: 'bob', google: 'gina', anon: 'anonboss' };
const users = {
  admin: token('boss'), alice: token('alice', 'anonymous'), bob: token('bob', 'anonymous'),
  google: token('gina'), anon: token('anonboss', 'anonymous'),
};

let NS = 'switches-rules';
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

let seq = 0;
/** The admin page's Save for one setting: the value, its configMeta pointer and its configLog entry. */
async function change(who, path, to) {
  const id = `L${String(++seq).padStart(4, '0')}`;
  const uid = UIDS[who] || 'nobody';
  const cur = await call('GET', `config/${path}`, undefined, 'owner');
  const entry = { uid, at: TS, path };
  if (cur.body !== null) entry.from = cur.body;
  if (to !== null) entry.to = to;
  return call('PATCH', '', {
    [`config/${path}`]: to,
    [`configMeta/${path}`]: { at: TS, by: uid, log: id },
    [`configLog/${id}`]: entry,
  }, who);
}

/* The rules from before this phase: the parent of the commit that first put
   duel's switch into firebase.rules.json, or HEAD's while that is uncommitted. */
function oldRules() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const intro = git('log', '-S', "config/duel/enabled", '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes('config/duel/enabled')) throw new Error('could not find the rules from before phase 7');
  return text;
}

const room = (id, extra = {}) => ({
  meta: { createdAt: TS, event: '333', mode: 'wca', round: 1, ...extra },
});
const seat = (uid, code) => ({ uid, code, at: TS });

/* ================= the new rules ================= */

await load('switches-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- the settings themselves ---------------- */

expect('an admin switches Random 1v1 off, with its log entry', await change('admin', 'duel/enabled', false), true);
expect('…and back on', await change('admin', 'duel/enabled', true), true);
expect('a Google account that is not an admin cannot', await change('google', 'duel/enabled', false), false);
expect('nor an anonymous one listed under admins/ by mistake', await change('anon', 'duel/enabled', false), false);
expect('duel.enabled must be a switch', await change('admin', 'duel/enabled', 'off'), false);
expect('duel.audience: testers', await change('admin', 'duel/audience', 'testers'), true);
expect('duel.audience: not an audience', await change('admin', 'duel/audience', 'friends'), false);
expect('duel.turnTtlMin at its ceiling, 240', await change('admin', 'duel/turnTtlMin', 240), true);
expect('duel.turnTtlMin past it, 241', await change('admin', 'duel/turnTtlMin', 241), false);
expect('duel.turnTtlMin at its floor, 10', await change('admin', 'duel/turnTtlMin', 10), true);
expect('duel.turnTtlMin under it, 9', await change('admin', 'duel/turnTtlMin', 9), false);
expect('duel.searchSec 300', await change('admin', 'duel/searchSec', 300), true);
expect('duel.searchSec 301', await change('admin', 'duel/searchSec', 301), false);
expect('duel.refreshSec 4.5 (a whole number only)', await change('admin', 'duel/refreshSec', 4.5), false);
expect('duel.message of 200 characters', await change('admin', 'duel/message', 'x'.repeat(200)), true);
expect('duel.message of 201', await change('admin', 'duel/message', 'x'.repeat(201)), false);
expect('a duel key the table does not have', await change('admin', 'duel/rating', true), false);
expect('competition.enabled off', await change('admin', 'competition/enabled', false), true);
expect('competition.enabled as a string', await change('admin', 'competition/enabled', 'false'), false);
expect('features.webcamReplay off', await change('admin', 'features/webcamReplay', false), true);
expect('features.stackmatAudience: admins', await change('admin', 'features/stackmatAudience', 'admins'), true);
expect('features.webcamReplayAudience: not an audience', await change('admin', 'features/webcamReplayAudience', 'everybody'), false);
expect('a feature the table does not have', await change('admin', 'features/learn', false), false);
expect('app.banner of 200 characters', await change('admin', 'app/banner', 'b'.repeat(200)), true);
expect('app.banner of 201', await change('admin', 'app/banner', 'b'.repeat(201)), false);
expect('app.bannerKind: down', await change('admin', 'app/bannerKind', 'down'), true);
expect('app.bannerKind: not a colour it has', await change('admin', 'app/bannerKind', 'red'), false);
expect('app.readOnly on', await change('admin', 'app/readOnly', true), true);
expect('…and off again', await change('admin', 'app/readOnly', false), true);
expect('everybody reads the switches, signed out too', await call('GET', 'config/duel', undefined, null), true);
await call('DELETE', 'config', undefined, 'owner');

/* ---------------- the waiting seat ---------------- */

const LOBBY = 'rooms/_1v1_333/meta/waiting';
expect('nothing stored: alice takes the waiting seat', await call('PUT', LOBBY, seat('alice', 'AAAAA'), 'alice'), true);
expect('…and re-stamps it', await call('PATCH', LOBBY, { at: TS }, 'alice'), true);
await change('admin', 'duel/enabled', false);
expect('1v1 off: alice\'s next re-stamp is refused', await call('PATCH', LOBBY, { at: TS }, 'alice'), false);
expect('…and bob cannot take the seat', await call('PATCH', LOBBY, { takenBy: 'bob', takenAt: TS }, 'bob'), false);
expect('…nor put himself in it', await call('PUT', LOBBY, seat('bob', 'BBBBB'), 'bob'), false);
expect('…nor through the whole meta', await call('PATCH', 'rooms/_1v1_333/meta', { waiting: seat('bob', 'BBBBB') }, 'bob'), false);
expect('clearing the seat is never refused', await call('DELETE', LOBBY, undefined, 'alice'), true);
await change('admin', 'duel/enabled', true);
expect('1v1 back on: bob takes the seat', await call('PUT', LOBBY, seat('bob', 'BBBBB'), 'bob'), true);
expect('…and alice takes it from him, a match', await call('PATCH', LOBBY, { takenBy: 'alice', takenAt: TS }, 'alice'), true);

/* ---------------- 1v1 rooms ---------------- */

expect('1v1 on: a match room is made with kind duel', await call('PUT', 'rooms/DUELA/meta', room('DUELA', { kind: 'duel' }).meta, 'alice'), true);
await change('admin', 'duel/enabled', false);
expect('1v1 off: a new match room is refused', await call('PUT', 'rooms/DUELB/meta', room('DUELB', { kind: 'duel' }).meta, 'bob'), false);
expect('…an ordinary room is not', await call('PUT', 'rooms/RACEA/meta', room('RACEA').meta, 'bob'), true);
expect('…nor one of some other kind', await call('PUT', 'rooms/RACEB/meta', room('RACEB', { kind: 'group' }).meta, 'bob'), true);
expect('…but an ordinary room cannot become a 1v1', await call('PATCH', 'rooms/RACEA/meta', { kind: 'duel' }, 'bob'), false);
expect('a 1v1 already running plays on: its next round', await call('PATCH', 'rooms/DUELA/meta', { round: 2, phase: 'racing' }, 'alice'), true);
expect('…its whole meta written again, still a 1v1', await call('PUT', 'rooms/DUELA/meta', { createdAt: 1, event: '333', mode: 'wca', round: 3, kind: 'duel' }, 'bob'), true);
await change('admin', 'duel/enabled', null);
expect('the switch back on its default: a match room again', await call('PUT', 'rooms/DUELB/meta', room('DUELB', { kind: 'duel' }).meta, 'bob'), true);

/* ---------------- cam and mic ---------------- */

await call('PUT', 'rooms/DUELA/players', {
  alice: { name: 'alice', joinedAt: Date.now(), lastSeen: Date.now() },
  bob: { name: 'bob', joinedAt: Date.now(), lastSeen: Date.now() },
}, 'owner');
// Both seats linked to a Google account, as duel.camSignedIn wants (tools/verify-duel-signin-rules.mjs).
await call('PUT', 'rooms/DUELA/acct', { alice: { claim: 'ga', ok: true }, bob: { claim: 'gb', ok: true } }, 'owner');
const rtc = (uid) => `rooms/DUELA/rtc/${uid}`;
expect('nothing stored: alice says her camera is on', await call('PUT', `${rtc('alice')}/media`, { cam: true, mic: false }, 'alice'), true);
expect('…and offers a call', await call('PUT', `${rtc('alice')}/desc`, { sid: 's1', type: 'offer', sdp: 'v=0' }, 'alice'), true);
await change('admin', 'duel/camEnabled', false);
expect('cam off: bob\'s answer is refused', await call('PUT', `${rtc('bob')}/desc`, { sid: 's1', type: 'answer', sdp: 'v=0' }, 'bob'), false);
expect('…and his candidates', await call('PUT', `${rtc('bob')}/ice/s1/c1`, { candidate: 'candidate:1' }, 'bob'), false);
expect('…and alice turning her mic on', await call('PATCH', `${rtc('alice')}/media`, { mic: true }, 'alice'), false);
expect('…but alice can still clear her own', await call('DELETE', rtc('alice'), undefined, 'alice'), true);
expect('…but never bob\'s', await call('DELETE', rtc('bob'), undefined, 'alice'), false);
await change('admin', 'duel/camEnabled', true);
expect('cam on again: bob answers', await call('PUT', `${rtc('bob')}/desc`, { sid: 's1', type: 'answer', sdp: 'v=0' }, 'bob'), true);
expect('the cam rule still wants a 1v1: not in an ordinary room', await call('PUT', 'rooms/RACEA/rtc/bob/media', { cam: true }, 'bob'), false);

/* ================= the rules from before this phase ================= */

await load('switches-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
expect('old rules: saving duel.enabled is refused cleanly', await change('admin', 'duel/enabled', false), false);
expect('old rules: app.readOnly too', await change('admin', 'app/readOnly', true), false);
expect('old rules: the waiting seat works as before', await call('PUT', LOBBY, seat('alice', 'AAAAA'), 'alice'), true);
expect('old rules: a match room is made as before', await call('PUT', 'rooms/DUELC/meta', room('DUELC', { kind: 'duel' }).meta, 'alice'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
