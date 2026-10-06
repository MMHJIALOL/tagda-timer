/* The admin console's phase 5 rules: testers and audiences, scheduled
   changes and the scheduler that applies them, a day's scramble set ahead,
   and the featured event. Checked against the database emulator.
       node tools/verify-live-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-live-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`live-rules`).
   Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs; the
   scheduler is one too, with the custom sign-in provider the Worker's real
   token has (worker.js, schedulerToken). */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'live-rules';
const TS = { '.sv': 'timestamp' };
const DAY = 86_400_000, IST = 19_800_000;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'google.com') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const users = {
  boss: token('boss'), alice: token('alice'), tess: token('tess'), anon: token('anon', 'anonymous'),
  anonboss: token('anonboss', 'anonymous'),
  sched: token('tagda-scheduler', 'custom'),
  googleSched: token('tagda-scheduler'),            // a Google account that happens to have that uid
  anonSched: token('tagda-scheduler', 'anonymous'),
  otherCustom: token('somebody', 'custom'),
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
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body ?? null).slice(0, 120)})`}`);
}

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');
await call('PUT', 'admins', { boss: true, anonboss: true }, 'owner');

console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

const now = Date.now();
const today = Math.floor((now + IST) / DAY) * DAY - IST;
let n = 0;
const id = (p) => `${p}${String(++n).padStart(4, '0')}`;

/* ---------------- testers ---------------- */

console.log('testers/');
const tester = (name) => ({ at: TS, by: 'boss', name });
expect('an admin adds a tester', await call('PUT', 'testers/tess', tester('Tess'), 'boss'), true);
expect('a signed-in non-admin cannot', await call('PUT', 'testers/alice', { ...tester('Alice'), by: 'alice' }, 'alice'), false);
expect('an anonymous account listed in admins/ cannot', await call('PUT', 'testers/x', { ...tester('X'), by: 'anonboss' }, 'anonboss'), false);
expect('signed out cannot', await call('PUT', 'testers/x', tester('X'), null), false);
expect('“by” somebody else: refused', await call('PUT', 'testers/x', { ...tester('X'), by: 'alice' }, 'boss'), false);
expect('a field that is not allowed: refused', await call('PUT', 'testers/x', { ...tester('X'), role: 'qa' }, 'boss'), false);
expect('a tester reads their own entry', await call('GET', 'testers/tess', undefined, 'tess'), true);
expect('…anybody reads their own, even when it is not there', await call('GET', 'testers/alice', undefined, 'alice'), true);
expect('…but not somebody else’s', await call('GET', 'testers/tess', undefined, 'alice'), false);
expect('an admin reads the list', await call('GET', 'testers', undefined, 'boss'), true);
expect('nobody else does', await call('GET', 'testers', undefined, 'tess'), false);
await call('PUT', 'testers/gone', { at: now, by: 'boss' }, 'owner');
expect('an admin removes a tester', await call('DELETE', 'testers/gone', undefined, 'boss'), true);
expect('a tester cannot remove another', await call('DELETE', 'testers/tess', undefined, 'alice'), false);

/* ---------------- an audience (the SOTD chat's) ---------------- */

console.log('\nconfig/<section>/audience, here the Scramble of the Day chat');
const cfg = (who, path, to, from) => {
  const lid = id('C');
  const entry = { uid: who, at: TS, path };
  if (from !== undefined) entry.from = from;
  if (to !== null) entry.to = to;
  return call('PATCH', '', { [`config/${path}`]: to, [`configMeta/${path}`]: { at: TS, by: who, log: lid }, [`configLog/${lid}`]: entry }, who);
};
expect('an admin sets an audience', await cfg('boss', 'sotdChat/audience', 'testers'), true);
expect('…only one of the three: refused', await cfg('boss', 'sotdChat/audience', 'friends', 'testers'), false);
expect('a non-admin cannot', await cfg('alice', 'sotdChat/audience', 'everyone', 'testers'), false);
for (const uid of ['alice', 'tess', 'boss']) await call('PUT', `daily/${today}/333/results/${uid}`, { timeMs: 9000, name: uid }, 'owner');
const post = (who) => call('PATCH', `daily/${today}/333/chat`, {
  [`m/${id('m')}`]: { uid: who, name: who, text: 'hello', at: TS }, [`last/${who}`]: TS }, who);
expect('testers: a non-tester cannot post', await post('alice'), false);
expect('testers: a tester can', await post('tess'), true);
expect('testers: an admin can', await post('boss'), true);
await call('PUT', 'config/sotdChat/audience', 'admins', 'owner');
await new Promise(r => setTimeout(r, 1600));     // the chat's gap between messages
expect('admins: a tester cannot', await post('tess'), false);
expect('admins: an admin can', await post('boss'), true);
await call('PUT', 'config/sotdChat/audience', 'everyone', 'owner');
expect('everyone: anybody who solved can', await post('alice'), true);
await call('DELETE', 'config/sotdChat/audience', undefined, 'owner');
await new Promise(r => setTimeout(r, 1600));
expect('nothing set: everybody, as before', await post('alice'), true);

/* ---------------- scheduled changes ---------------- */

console.log('\nconfigScheduled/');
const plan = (who, path, rec, sid = id('S')) => call('PUT', `configScheduled/${path}/${sid}`, { by: who, createdAt: TS, ...rec }, who);
const soon = now + 3600_000;
expect('an admin schedules a change', await plan('boss', 'sandbox/n', { to: 7, at: soon }), true);
expect('…back to the default', await plan('boss', 'sandbox/n', { def: true, at: soon }), true);
expect('everybody reads what is scheduled, signed out too', await call('GET', 'configScheduled', undefined, null), true);
expect('a signed-in non-admin cannot schedule', await plan('alice', 'sandbox/n', { to: 7, at: soon }), false);
expect('an anonymous account listed in admins/ cannot', await plan('anonboss', 'sandbox/n', { to: 7, at: soon }), false);
expect('signed out cannot', await call('PUT', `configScheduled/sandbox/n/${id('S')}`, { by: 'x', createdAt: TS, to: 7, at: soon }, null), false);
expect('the scheduler cannot schedule anything itself', await call('PUT', `configScheduled/sandbox/n/${id('S')}`, { by: 'tagda-scheduler', createdAt: TS, to: 7, at: soon }, 'sched'), false);
expect('a time already past: refused', await plan('boss', 'sandbox/n', { to: 7, at: now - 1000 }), false);
expect('more than a year ahead: refused', await plan('boss', 'sandbox/n', { to: 7, at: now + 400 * DAY }), false);
expect('a value past the setting’s range: refused', await plan('boss', 'sandbox/n', { to: 11, at: soon }), false);
expect('a value of the wrong type: refused', await plan('boss', 'sandbox/on', { to: 1, at: soon }), false);
expect('both a value and “default”: refused', await plan('boss', 'sandbox/n', { to: 3, def: true, at: soon }), false);
expect('neither: refused', await plan('boss', 'sandbox/n', { at: soon }), false);
expect('a setting that does not exist: refused', await plan('boss', 'sandbox/nope', { to: 1, at: soon }), false);
expect('a money ceiling cannot be scheduled past either', await plan('boss', 'replays/maxPerDay', { to: 1001, at: soon }), false);
const cancel = id('S');
await plan('boss', 'sandbox/text', { to: 'later', at: soon }, cancel);
expect('an admin cancels one', await call('DELETE', `configScheduled/sandbox/text/${cancel}`, undefined, 'boss'), true);

console.log('\nthe scheduler applying one');
/** Plant a change as if it had been scheduled earlier and is now due (the owner skips the rules). */
const due = async (path, rec) => {
  const sid = id('D');
  await call('PUT', `configScheduled/${path}/${sid}`, { by: 'boss', createdAt: now - 7200_000, at: now - 1000, ...rec }, 'owner');
  return sid;
};
/** What the Worker sends: the value, its pointer, its log entry naming the schedule, and the schedule gone. */
const apply = (who, path, sid, { to, from, by = 'boss', keep = false, logTo = to, noSched = false } = {}) => {
  const lid = id('L');
  const uid = who === 'sched' || who === 'googleSched' || who === 'anonSched' ? 'tagda-scheduler' : who;
  const entry = { uid, at: TS, path, by };
  if (!noSched) entry.sched = sid;
  if (from !== undefined) entry.from = from;
  if (logTo !== undefined) entry.to = logTo;
  const body = {
    [`config/${path}`]: to === undefined ? null : to,
    [`configMeta/${path}`]: { at: TS, by: uid, log: lid },
    [`configLog/${lid}`]: entry,
  };
  if (!keep) body[`configScheduled/${path}/${sid}`] = null;
  return call('PATCH', '', body, who);
};
let sid = await due('sandbox/n', { to: 7 });
expect('a Google account with the scheduler’s uid cannot apply it', await apply('googleSched', 'sandbox/n', sid, { to: 7 }), false);
expect('an anonymous one cannot', await apply('anonSched', 'sandbox/n', sid, { to: 7 }), false);
expect('another custom-token account cannot', await apply('otherCustom', 'sandbox/n', sid, { to: 7 }), false);
expect('a different value from the one scheduled: refused', await apply('sched', 'sandbox/n', sid, { to: 8 }), false);
expect('leaving the schedule behind: refused', await apply('sched', 'sandbox/n', sid, { to: 7, keep: true }), false);
expect('“by” not the admin who scheduled it: refused', await apply('sched', 'sandbox/n', sid, { to: 7, by: 'alice' }), false);
expect('a log entry not naming the schedule: refused', await apply('sched', 'sandbox/n', sid, { to: 7, noSched: true }), false);
expect('the scheduler applies a due change, in the log', await apply('sched', 'sandbox/n', sid, { to: 7 }), true);
expect('…the value is there', { ok: (await call('GET', 'config/sandbox/n', undefined, null)).body === 7 }, true);
expect('…and the schedule is gone', { ok: (await call('GET', `configScheduled/sandbox/n/${sid}`, undefined, null)).body === null }, true);
expect('applying the same one twice: refused', await apply('sched', 'sandbox/n', sid, { to: 7, from: 7 }), false);
sid = await due('sandbox/n', { def: true });
expect('back to the default: the value goes, the log has no “to”', await apply('sched', 'sandbox/n', sid, { from: 7 }), true);
const early = id('S');
await call('PUT', `configScheduled/sandbox/n/${early}`, { by: 'boss', createdAt: now, at: now + 3600_000, to: 4 }, 'owner');
expect('a change that is not due yet: refused', await apply('sched', 'sandbox/n', early, { to: 4 }), false);
sid = await due('sandbox/n', { to: 2 });
await call('PUT', `configScheduled/sandbox/n/${sid}/by`, 'alice', 'owner');
expect('scheduled by somebody no longer an admin: refused', await apply('sched', 'sandbox/n', sid, { to: 2, by: 'alice' }), false);
expect('the scheduler cannot delete a schedule without applying it', await call('DELETE', `configScheduled/sandbox/n/${sid}`, undefined, 'sched'), false);
expect('…nor change a setting the way an admin does', await (() => {
  const lid = id('C');
  return call('PATCH', '', { 'config/sandbox/n': 5, 'configMeta/sandbox/n': { at: TS, by: 'tagda-scheduler', log: lid },
    [`configLog/${lid}`]: { uid: 'tagda-scheduler', at: TS, path: 'sandbox/n', to: 5 } }, 'sched');
})(), false);
expect('…nor ban anybody', await call('PUT', 'bans/alice', { at: TS, by: 'tagda-scheduler', reason: 'x' }, 'sched'), false);
expect('…nor write an announcement', await call('PATCH', '', { 'announcements/x': { title: 'x', style: 'card', audience: 'everyone', startAt: 0, maxShows: 0, version: 1, log: 'Q1', by: 'tagda-scheduler', updatedAt: TS },
  'configLog/Q1': { uid: 'tagda-scheduler', at: TS, path: 'ann/x', action: 'create' } }, 'sched'), false);
sid = await due('sandbox/n', { to: 3 });
expect('an admin’s own change cannot claim a schedule', await (async () => {
  const lid = id('L');
  return call('PATCH', '', { 'config/sandbox/n': 3, 'configMeta/sandbox/n': { at: TS, by: 'boss', log: lid },
    [`configLog/${lid}`]: { uid: 'boss', at: TS, path: 'sandbox/n', to: 3, sched: sid, by: 'boss' }, [`configScheduled/sandbox/n/${sid}`]: null }, 'boss');
})(), false);
expect('an admin’s ordinary change still works (unchanged)', await cfg('boss', 'sandbox/n', 4), true);

/* ---------------- a day's scramble, set ahead ---------------- */

console.log('\ndaily/<day>/<event>/scramble');
const scr = (who, day, ev, val, method = 'PUT') => call(method, `daily/${day}/${ev}/scramble`, val, who);
expect('anybody signed in publishes today’s, as before', await scr('alice', today, '333', "R U R' U'"), true);
expect('…once', await scr('tess', today, '333', 'F'), false);
expect('…an anonymous race account too, as before', await scr('anon', today, '222', 'R U'), true);
expect('signed out cannot', await scr(null, today, '444', 'R'), false);
expect('a non-admin cannot publish tomorrow’s', await scr('alice', today + DAY, '333', 'R'), false);
expect('…or next week’s', await scr('alice', today + 7 * DAY, '333', 'R'), false);
expect('…or yesterday’s', await scr('alice', today - DAY, '555', 'R'), false);
expect('an admin sets tomorrow’s', await scr('boss', today + DAY, '333', "D2 F' L"), true);
expect('…and next week’s', await scr('boss', today + 7 * DAY, 'pyram', "U R' l"), true);
expect('…changes it before the day starts', await scr('boss', today + DAY, '333', "D2 F' L2"), true);
expect('…clears it', await scr('boss', today + 7 * DAY, 'pyram', undefined, 'DELETE'), true);
expect('…but cannot change today’s once it is out', await scr('boss', today, '333', 'R'), false);
expect('an anonymous account listed in admins/ cannot set a day ahead', await scr('anonboss', today + DAY, '444', 'R'), false);
expect('a non-admin cannot change an admin’s day ahead', await scr('alice', today + DAY, '333', 'R'), false);
expect('…when the day comes, it is there for everybody', { ok: (await call('GET', `daily/${today + DAY}/333/scramble`, undefined, null)).body === "D2 F' L2" }, true);
expect('600 characters at most, as before', await scr('boss', today + 2 * DAY, '333', 'R '.repeat(301)), false);

/* ---------------- the featured event ---------------- */

console.log('\nsotdFeatured/<day>');
const feat = (who, day, ev, method = 'PUT') => call(method, `sotdFeatured/${day}`, ev, who);
expect('an admin features an event today', await feat('boss', today, '444'), true);
expect('…and on a day ahead', await feat('boss', today + 3 * DAY, 'sq1'), true);
expect('…but not on a day gone', await feat('boss', today - DAY, '333'), false);
expect('everybody reads it, signed out too', await call('GET', `sotdFeatured/${today}`, undefined, null), true);
expect('a non-admin cannot', await feat('alice', today, '222'), false);
expect('an anonymous account listed in admins/ cannot', await feat('anonboss', today, '222'), false);
expect('signed out cannot', await feat(null, today, '222'), false);
expect('something that is not an event with a daily scramble: refused', await feat('boss', today, '333fm'), false);
expect('an admin clears it', await feat('boss', today + 3 * DAY, undefined, 'DELETE'), true);

/* ---------------- announcements for testers ---------------- */

console.log('\nannouncements/ audiences');
const ann = (aud) => call('PATCH', '', {
  'announcements/for-testers': { title: 'Try this', style: 'card', audience: aud, startAt: 0, maxShows: 0, version: 1, log: `N${++n}`, by: 'boss', updatedAt: TS },
  [`configLog/N${n}`]: { uid: 'boss', at: TS, path: 'ann/for-testers', action: 'create', title: 'Try this' } }, 'boss');
expect('an announcement for testers', await ann('testers'), true);
expect('…or for admins only', await ann('admins'), true);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
