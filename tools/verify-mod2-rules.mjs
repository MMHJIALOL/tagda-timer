/* Moderation, round two (ban scopes, race and 1v1 bans, report triage, the moderation log;
   ADMIN.md §5, §6 and §19), checked against the database emulator.
       node tools/verify-mod2-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-mod2-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`mod2-rules`), and the rules
   from before this phase into another (`mod2-old`). Users are unsigned tokens. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOD_ACTIONS } from '../js/moderation.js';
import { BAN_SCOPES } from '../js/config-rules.js';

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
const users = { admin: token('boss'), ann: token('ann'), bo: token('bo'), cy: token('cy'), anonboss: token('anonboss', 'anonymous') };

let NS = 'mod2-rules';
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
  await call('PUT', 'admins', { boss: true, anonboss: true }, 'owner');
}
function oldRules() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const marker = '"modLog"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 12');
  return text;
}

const now = Date.now();
const today = now - ((now + IST) % DAY);
let n = 0;
const id = () => `-k${String(++n).padStart(4, '0')}`;
/** An admin's action and its log entry, in one update, as js/moderation.js logged() sends it. */
const act = (who, updates, entry) => call('PATCH', '', { ...updates, [`modLog/${id()}`]: { by: who === 'admin' ? 'boss' : who, at: TS, ...entry } }, who);
const ban = (scope, extra = {}) => ({ at: TS, by: 'boss', reason: 'test', ...(scope ? { scope } : {}), ...extra });
const setBan = (uid, scope) => act('admin', { [`bans/${uid}`]: ban(scope) }, { action: 'ban', path: `bans/${uid}`, uid });

/* What each scope stops, tried as `who`. Each makes a fresh row, so a refusal is the ban's. */
const D = `daily/${today}/333`;
const tries = {
  chat: (who) => call('PATCH', `rooms/OPEN1`, { [`chat/c${++n}`]: { uid: who, name: who, text: 'hi', at: TS }, [`chatLast/${who}`]: TS }, who),
  sotdChat: (who) => call('PATCH', `${D}/chat`, { [`m/c${++n}`]: { uid: who, name: who, text: 'hi', at: TS }, [`last/${who}`]: TS }, who),
  note: (who) => call('PUT', `${D}/results/${who}/note`, 'nice', who),
  sotd: (who) => call('PUT', `daily/${today}/222/results/${who}`, { timeMs: 3000, name: who, submittedAt: now }, who),
  race: (who) => call('PUT', `rooms/OPEN1/players/${who}`, { name: who, joinedAt: now, lastSeen: TS }, who),
  raceTime: (who) => call('PUT', `rooms/OPEN1/rounds/1/results/${who}`, { timeMs: 9000, hash: 'h1', submittedAt: TS }, who),
  duel: (who) => call('PUT', `rooms/DUEL1/players/${who}`, { name: who, joinedAt: now, lastSeen: TS }, who),
  seat: (who) => call('PUT', 'rooms/_1v1_333/meta/waiting', { uid: who, code: 'ABCDE', at: TS }, who),
  replays: (who) => call('PUT', `${D}/replayClaim/${who}`, TS, who),
  reports: (who) => call('PATCH', '', { [`reports/r${++n}`]: { by: who, at: TS, kind: 'raceChat', path: 'rooms/OPEN1/chat/m0' },
    [`reportOnce/${who}/raceChat|rooms|OPEN1|chat|m0`]: `r${n}` }, who),
};
async function seed() {
  await call('PATCH', '', {
    'rooms/OPEN1': { meta: { createdAt: now, event: '333', mode: 'wca', round: 1 }, rounds: { 1: { info: { scramble: "R U R'", hash: 'h1', startedAt: now } } },
      chat: { m0: { uid: 'cy', name: 'cy', text: 'spam', at: now } } },
    'rooms/DUEL1': { meta: { createdAt: now, event: '333', mode: 'wca', round: 1, kind: 'duel' } },
    [`${D}/scramble`]: "R U R'",
  }, 'owner');
  // Everybody already has a 3x3 time (for the day's chat, their note and a share), so only the ban can refuse.
  for (const u of ['ann', 'bo', 'cy']) await call('PUT', `${D}/results/${u}`, { timeMs: 9000, name: u, submittedAt: now }, 'owner');
}

await load('mod2-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);
await seed();

/* ---------------- the moderation log ---------------- */
expect('an admin bans, with its log entry, in one update', await setBan('bo', 'chat'), true);
expect('every action the console logs is one the rules know', await call('PATCH', '', Object.fromEntries(MOD_ACTIONS.map(a => [`modLog/${id()}`, { by: 'boss', at: TS, action: a, path: 'x' }])), 'admin'), true);
expect('not an action they do not know', await act('admin', {}, { action: 'nuke', path: 'x' }), false);
expect('not in somebody else\'s name', await call('PUT', `modLog/${id()}`, { by: 'ann', at: TS, action: 'ban', path: 'x' }, 'admin'), false);
expect('not at a made-up time', await call('PUT', `modLog/${id()}`, { by: 'boss', at: now - 1000, action: 'ban', path: 'x' }, 'admin'), false);
expect('not a path past 300 characters', await act('admin', {}, { action: 'ban', path: 'x'.repeat(301) }), false);
expect('not a field the rules do not know', await act('admin', {}, { action: 'ban', path: 'x', why: 'y' }), false);
expect('what it was (`before`) can be anything', await act('admin', {}, { action: 'deleteMessage', path: 'x', before: { uid: 'cy', text: 'spam', at: 1, list: [1, 2] } }), true);
const first = Object.keys((await call('GET', 'modLog', undefined, 'admin')).body || {}).sort()[0];
expect('an undo points at an entry that is there', await act('admin', {}, { action: 'unban', path: 'x', undo: first }), true);
expect('…not at one that is not', await act('admin', {}, { action: 'unban', path: 'x', undo: '-nothere' }), false);
expect('an entry cannot be changed', await call('PUT', `modLog/${first}/note`, 'edited', 'admin'), false);
expect('…or deleted, even by an admin', await call('DELETE', `modLog/${first}`, undefined, 'admin'), false);
expect('ann cannot write one', await call('PUT', `modLog/${id()}`, { by: 'ann', at: TS, action: 'ban', path: 'x' }, 'ann'), false);
expect('…nor read the log', await call('GET', 'modLog', undefined, 'ann'), false);
expect('an anonymous account listed in admins cannot write one', await act('anonboss', {}, { action: 'ban', path: 'x' }), false);
expect('an admin reads it, by person too (indexed on uid)', await call('GET', 'modLog', undefined, 'admin', '&orderBy=%22uid%22&equalTo=%22bo%22'), true);

/* ---------------- ban scopes ---------------- */
expect('not a scope the rules do not know', await setBan('cy', 'chat,shouting'), false);
expect('not a scope that is not a list', await setBan('cy', 'chat;race'), false);
expect('every scope at once is a scope', await setBan('cy', BAN_SCOPES.join(',')), true);
await call('DELETE', 'bans/cy', undefined, 'owner');

// bo: chat only.
expect('chat ban: no race chat', await tries.chat('bo'), false);
expect('chat ban: no day chat', await tries.sotdChat('bo'), false);
expect('chat ban: no note', await tries.note('bo'), false);
expect('chat ban: a Scramble of the Day time still', await tries.sotd('bo'), true);
expect('chat ban: racing still', await tries.race('bo'), true);
expect('chat ban: a race time still', await tries.raceTime('bo'), true);
expect('chat ban: a 1v1 still', await tries.duel('bo'), true);
expect('chat ban: sharing a replay still', await tries.replays('bo'), true);
expect('chat ban: reporting still', await tries.reports('bo'), true);

// ann: race and reports.
await setBan('ann', 'race,reports');
expect('race ban: no joining a race room', await tries.race('ann'), false);
expect('race ban: no race time', await tries.raceTime('ann'), false);
expect('race ban: a 1v1 still', await tries.duel('ann'), true);
expect('race ban: leaving a room still', await call('DELETE', 'rooms/OPEN1/players/ann', undefined, 'ann'), true);
expect('reports ban: no report', await tries.reports('ann'), false);
expect('race and reports ban: chatting still', await tries.chat('ann'), true);

// cy: 1v1 and the day's board and replays.
await setBan('cy', 'duel,sotd,replays');
expect('1v1 ban: no joining a 1v1', await tries.duel('cy'), false);
expect('1v1 ban: not the waiting seat', await tries.seat('cy'), false);
expect('…which an admin can still clear', await call('DELETE', 'rooms/_1v1_333/meta/waiting', undefined, 'admin'), true);
expect('1v1 ban: racing still', await tries.race('cy'), true);
expect('board ban: no Scramble of the Day time', await tries.sotd('cy'), false);
expect('board ban: no lighter penalty either', await call('PUT', `${D}/results/cy/penalty`, '+2', 'cy'), false);
expect('replays ban: no share', await tries.replays('cy'), false);
expect('…but the day\'s chat still', await tries.sotdChat('cy'), true);

// A ban with no scope: everything, as before scopes.
await setBan('bo', null);
for (const k of ['chat', 'sotdChat', 'sotd', 'race', 'duel', 'reports']) expect(`no scope: no ${k}`, await tries[k]('bo'), false);
// Ended: nothing.
await call('PUT', 'bans/bo/until', now - 1000, 'owner');
expect('an ended ban stops nothing', await tries.race('bo'), true);

/* ---------------- report triage ---------------- */
await call('DELETE', 'bans', undefined, 'owner');
await call('PATCH', '', { 'reports/R1': { by: 'ann', at: TS, kind: 'raceChat', path: 'rooms/OPEN1/chat/m0' }, 'reportOnce/ann/raceChat|rooms|OPEN1|chat|m0': 'R1' }, 'ann');
const st = (s, extra = {}) => ({ s, by: 'boss', at: TS, ...extra });
expect('an admin dismisses a report, logged', await act('admin', { 'reports/R1/status': st('dismissed') }, { action: 'dismiss', path: 'rooms/OPEN1/chat/m0' }), true);
expect('…reopens it', await act('admin', { 'reports/R1/status': null }, { action: 'reopenReport', path: 'rooms/OPEN1/chat/m0' }), true);
expect('…not as somebody else', await call('PUT', 'reports/R1/status', st('dismissed', { by: 'ann' }), 'admin'), false);
expect('…not a state the rules do not know', await call('PUT', 'reports/R1/status', st('spam'), 'admin'), false);
expect('…not at a made-up time', await call('PUT', 'reports/R1/status', st('dismissed', { at: now }), 'admin'), false);
expect('…not with a field the rules do not know', await call('PUT', 'reports/R1/status', st('dismissed', { why: 'x' }), 'admin'), false);
expect('…with a note', await call('PUT', 'reports/R1/status', st('dismissed', { note: 'banter' }), 'admin'), true);
expect('ann cannot close her own report', await call('PUT', 'reports/R1/status', st('dismissed', { by: 'ann' }), 'ann'), false);
expect('ann cannot change what she reported', await call('PUT', 'reports/R1/path', 'rooms/OPEN1/chat/x', 'ann'), false);
await call('DELETE', 'reports/R1/status', undefined, 'owner');
await act('admin', { 'rooms/OPEN1/chat/m0': null }, { action: 'deleteMessage', path: 'rooms/OPEN1/chat/m0', uid: 'cy' });
expect('the message taken down, its report is closed as acted on', await act('admin', { 'reports/R1/status': st('actioned') }, { action: 'actioned', path: 'rooms/OPEN1/chat/m0' }), true);
expect('…and swept later by an admin', await call('DELETE', 'reports/R1', undefined, 'admin'), true);
expect('a new report about something gone is still refused', await call('PATCH', '', { 'reports/R2': { by: 'bo', at: TS, kind: 'raceChat', path: 'rooms/OPEN1/chat/m0' }, 'reportOnce/bo/raceChat|rooms|OPEN1|chat|m0': 'R2' }, 'bo'), false);

/* ================= the rules from before this phase ================= */

await load('mod2-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
await seed();
await call('PUT', 'bans/bo', { at: now, by: 'boss', reason: 'x' }, 'owner');
expect('old rules: a ban with a log entry is refused…', await setBan('bo', 'chat'), false);
expect('…so the console bans alone, which lands', await call('PUT', 'bans/ann', ban(null), 'admin'), true);
expect('old rules: a scope cannot be written', await call('PUT', 'bans/cy', ban('chat'), 'admin'), false);
expect('old rules: a ban stops chat…', await tries.chat('bo'), false);
expect('…but not racing (no race bans before this phase)', await tries.race('bo'), true);
expect('old rules: no report status', await call('PUT', 'reports/R1/status', st('dismissed'), 'admin'), false);
expect('old rules: no moderation log to read', await call('GET', 'modLog', undefined, 'admin'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
