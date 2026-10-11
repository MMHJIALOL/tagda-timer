/* Moderators and the console's own record (mods/, adminSeen/, and the moderation paths a
   moderator's scope opens; ADMIN.md §22), checked against the database emulator.
       node tools/verify-roles-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-roles-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`roles-rules`), and the rules
   from before this phase into another (`roles-old`). Users are unsigned tokens. */

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
const users = { admin: token('boss'), mo: token('mo'), rc: token('rc'), ann: token('ann'), anonmod: token('anonmod', 'anonymous') };

let NS = 'roles-rules';
async function call(method, path, body, who, query = '') {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const marker = '"adminSeen"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 15');
  return text;
}

const now = Date.now();
const today = now - ((now + IST) % DAY);
const D = `daily/${today}/333`;
let n = 0;
async function seed() {
  await call('PATCH', '', {
    [`${D}/scramble`]: "R U R'",
    [`${D}/results/zed`]: { timeMs: 2500, name: 'Zed', submittedAt: now - 60000, replay: true },
    [`${D}/results/kim`]: { timeMs: 9800, name: 'Kim', submittedAt: now - 3600000 },
    [`${D}/replayClaim/zed`]: now - 60000,
    [`${D}/chat/m/m1`]: { uid: 'zed', name: 'Zed', text: 'spam', at: now },
    'rooms/R1': { meta: { createdAt: now, event: '333', mode: 'wca', round: 1 }, players: { p1: { name: 'p1', joinedAt: now } },
      rounds: { 1: { info: { scramble: "R U R'", hash: 'h1', startedAt: now }, results: { p1: { timeMs: 9000, hash: 'h1', submittedAt: now } } } },
      chat: { c1: { uid: 'p1', name: 'p1', text: 'spam', at: now } } },
    'reports/X1': { by: 'kim', at: now, kind: 'chat', path: `${D}/chat/m/m1`, text: 'spam' },
  }, 'owner');
}
const mod = (can, extra = {}) => ({ at: TS, by: 'boss', can, ...extra });
const log = (who, extra = {}) => call('PUT', `modLog/-x${++n}`, { by: who === 'admin' ? 'boss' : who, at: TS, action: 'deleteMessage', path: 'x', ...extra }, who);
const seen = (role, extra = {}) => ({ at: TS, role, ver: 128, ua: 'firefox', ...extra });

await load('roles-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);
await seed();

/* ---------------- mods/ ---------------- */
expect('an admin makes mo a moderator of chats and the board', await call('PUT', 'mods/mo', mod('chat,sotd', { name: 'Mo' }), 'admin'), true);
expect('…and rc of race rooms and reports', await call('PUT', 'mods/rc', mod('race,reports'), 'admin'), true);
expect('…an anonymous account too, which can still do nothing', await call('PUT', 'mods/anonmod', mod('chat'), 'admin'), true);
expect('not a scope the rules do not know', await call('PUT', 'mods/x1', mod('chat,settings'), 'admin'), false);
expect('not in somebody else\'s name', await call('PUT', 'mods/x1', mod('chat', { by: 'mo' }), 'admin'), false);
expect('not a field the rules do not know', await call('PUT', 'mods/x1', mod('chat', { admin: true }), 'admin'), false);
expect('a moderator cannot make another', await call('PUT', 'mods/ann', mod('chat', { by: 'mo' }), 'mo'), false);
expect('…nor change their own', await call('PUT', 'mods/mo/can', 'chat,sotd,race,reports', 'mo'), false);
expect('mo reads his own', await call('GET', 'mods/mo', undefined, 'mo'), true);
expect('…not the list', await call('GET', 'mods', undefined, 'mo'), false);
expect('an admin reads the list', await call('GET', 'mods', undefined, 'admin'), true);

/* ---------------- adminSeen/ ---------------- */
expect('an admin says when they were last here', await call('PUT', 'adminSeen/boss', seen('admin'), 'admin'), true);
expect('…a moderator too', await call('PUT', 'adminSeen/mo', seen('mod'), 'mo'), true);
expect('ann, neither, cannot', await call('PUT', 'adminSeen/ann', seen('mod'), 'ann'), false);
expect('not for somebody else', await call('PUT', 'adminSeen/boss', seen('mod'), 'mo'), false);
expect('not a role the rules do not know', await call('PUT', 'adminSeen/mo', seen('owner'), 'mo'), false);
expect('not at a made-up time', await call('PUT', 'adminSeen/mo', seen('mod', { at: now }), 'mo'), false);
expect('an admin reads them', await call('GET', 'adminSeen', undefined, 'admin'), true);
expect('a moderator does not', await call('GET', 'adminSeen', undefined, 'mo'), false);

/* ---------------- mo: chats and the board ---------------- */
expect('mo reads the day\'s chat', await call('GET', `${D}/chat`, undefined, 'mo'), true);
expect('mo deletes a day-chat message', await call('DELETE', `${D}/chat/m/m1`, undefined, 'mo'), true);
expect('mo deletes a race-chat message', await call('DELETE', 'rooms/R1/chat/c1', undefined, 'mo'), true);
expect('mo reads the day\'s board', await call('GET', `${D}/results`, undefined, 'mo'), true);
expect('mo keeps a held time', await call('PUT', `${D}/results/zed/review`, { by: 'mo', at: TS, keep: true }, 'mo'), true);
expect('mo re-times one', await call('PUT', `${D}/results/kim/penalty`, '+2', 'mo'), true);
expect('mo features a shared replay', await call('PUT', `sotdFeaturedReplay/${today}`, { event: '333', uid: 'zed' }, 'mo'), true);
expect('mo takes a replay down', await call('DELETE', `${D}/results/zed/replay`, undefined, 'mo'), true);
expect('mo removes a time, the usual removal', await call('PATCH', D, { 'results/kim': null, 'removed/kim': { at: TS, final: false }, 'progress/kim/submitted': null, 'replayClaim/kim': null }, 'mo'), true);
expect('mo logs what he does', await log('mo'), true);
expect('…but cannot read the log', await call('GET', 'modLog', undefined, 'mo'), false);
expect('mo cannot close a race room (not his)', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'mo' }, 'mo'), false);
expect('mo cannot read reports (not his)', await call('GET', 'reports', undefined, 'mo'), false);

/* ---------------- rc: race rooms and reports ---------------- */
expect('rc reads the rooms', await call('GET', 'rooms', undefined, 'rc'), true);
expect('rc closes a room', await call('PUT', 'rooms/R1/mod/closed', { at: TS, by: 'rc' }, 'rc'), true);
expect('rc removes a player', await call('PATCH', 'rooms/R1', { 'mod/kicked/p1': TS, 'players/p1': null }, 'rc'), true);
expect('rc strikes a time', await call('PUT', 'rooms/R1/mod/struck/1/p1', { at: TS, by: 'rc' }, 'rc'), true);
expect('rc removes a race time', await call('DELETE', 'rooms/R1/rounds/1/results/p1', undefined, 'rc'), true);
expect('rc reads reports', await call('GET', 'reports', undefined, 'rc'), true);
expect('…and the board a report points at', await call('GET', `${D}/results`, undefined, 'rc'), true);
expect('rc closes a report', await call('PUT', 'reports/X1/status', { s: 'dismissed', by: 'rc', at: TS }, 'rc'), true);
expect('rc cannot remove a time from the board (not his)', await call('PATCH', D, { 'results/zed': null, 'removed/zed': { at: TS, final: false } }, 'rc'), false);
expect('rc deletes an empty room', await call('DELETE', 'rooms/R1', undefined, 'rc'), true);

/* ---------------- what no moderator may do ---------------- */
expect('no moderator changes a setting', await call('PATCH', '', { 'config/race/enabled': false, 'configMeta/race/enabled': { at: TS, by: 'mo', log: 'L1' },
  'configLog/L1': { uid: 'mo', at: TS, path: 'race/enabled', to: false } }, 'mo'), false);
expect('…bans anybody', await call('PUT', 'bans/ann', { at: TS, by: 'mo', reason: 'x' }, 'mo'), false);
expect('…makes a tester', await call('PUT', 'testers/ann', { at: TS, by: 'rc' }, 'rc'), false);
expect('…reads the directory', await call('GET', 'seen', undefined, 'mo'), false);
expect('…reads the feedback inbox', await call('GET', 'feedback', undefined, 'rc'), false);
expect('…writes What\'s new', await call('PUT', 'changelog/-n1', { at: now, title: 'x', by: 'mo' }, 'mo'), false);
expect('an anonymous account listed as a moderator deletes nothing', await call('DELETE', 'rooms/R1/chat/c1', undefined, 'anonmod'), false);

/* ---------------- removed ---------------- */
await seed();
expect('an admin stops mo moderating', await call('DELETE', 'mods/mo', undefined, 'admin'), true);
expect('…and mo can no longer delete a message', await call('DELETE', `${D}/chat/m/m1`, undefined, 'mo'), false);

/* ================= the rules from before this phase ================= */

await load('roles-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
await seed();
expect('old rules: no moderators to make', await call('PUT', 'mods/mo', mod('chat'), 'admin'), false);
expect('old rules: no adminSeen', await call('PUT', 'adminSeen/boss', seen('admin'), 'admin'), false);
expect('old rules: admins carry on', await call('DELETE', `${D}/chat/m/m1`, undefined, 'admin'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
