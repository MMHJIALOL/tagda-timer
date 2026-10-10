/* The Scramble of the Day tools' rules (a time held under its floor and kept, an admin's +2 or DNF
   at any time, the featured replay, the board closed for the day, a day's removals listed; ADMIN.md §18), checked against
   the database emulator.
       node tools/verify-sotd-tools-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-sotd-tools-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`sotd-tools-rules`), and the rules
   from before this phase into another (`sotd-tools-old`). Users are unsigned tokens. */

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
const users = { admin: token('boss'), ann: token('ann'), bo: token('bo'), cy: token('cy'), anonboss: token('anonboss', 'anonymous') };
const UIDS = { admin: 'boss', ann: 'ann', bo: 'bo', cy: 'cy', anonboss: 'anonboss' };

let NS = 'sotd-tools-rules';
async function call(method, path, body, who) {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const marker = '"sotdFeaturedReplay"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 11');
  return text;
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

const now = Date.now();
const today = now - ((now + IST) % DAY);
const res = (uid, ev = '333') => `daily/${today}/${ev}/results/${uid}`;
const row = (name, timeMs, extra = {}) => ({ timeMs, name, submittedAt: now, ...extra });
const review = (by = 'boss', extra = {}) => ({ by, at: TS, keep: true, ...extra });

await load('sotd-tools-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- the floors ---------------- */
expect('an admin sets the floors', await change('admin', 'sotd/floors', '333:3000,222:400'), true);
expect('…or clears them all (nothing is held)', await change('admin', 'sotd/floors', ''), true);
expect('…not a list the app cannot read', await change('admin', 'sotd/floors', '333=3000'), false);
expect('…nor a floor with a decimal point', await change('admin', 'sotd/floors', '333:3.5'), false);
expect('…nor past 400 characters', await change('admin', 'sotd/floors', Array.from({ length: 40 }, (_, i) => `ev${i}x:1234567`).join(',')), false);
expect('ann cannot', await change('ann', 'sotd/floors', '333:9000'), false);

/* ---------------- a time held for a look, and kept ---------------- */
expect('ann sends a time under the floor (it goes on the board)', await call('PUT', res('ann'), row('Ann', 2900), 'ann'), true);
expect('bo cannot send his with a review of its own', await call('PUT', res('bo'), row('Bo', 2800, { review: review('bo') }), 'bo'), false);
expect('…nor with one in an admin\'s name', await call('PUT', res('bo'), row('Bo', 2800, { review: review('boss') }), 'bo'), false);
expect('…but without, yes', await call('PUT', res('bo'), row('Bo', 2800), 'bo'), true);
expect('ann cannot keep her own time', await call('PUT', `${res('ann')}/review`, review('ann'), 'ann'), false);
expect('bo cannot keep ann\'s', await call('PUT', `${res('ann')}/review`, review('bo'), 'bo'), false);
expect('an admin keeps it', await call('PUT', `${res('ann')}/review`, review(), 'admin'), true);
expect('…not in somebody else\'s name', await call('PUT', `${res('bo')}/review`, review('ann'), 'admin'), false);
expect('…not at a made-up time', await call('PUT', `${res('bo')}/review`, review('boss', { at: now - 60000 }), 'admin'), false);
expect('…not with a field the rules do not know', await call('PUT', `${res('bo')}/review`, review('boss', { note: 'ok' }), 'admin'), false);
expect('…not without saying keep', await call('PUT', `${res('bo')}/review`, { by: 'boss', at: TS }, 'admin'), false);
expect('…not on a time that is not there', await call('PUT', `${res('cy')}/review`, review(), 'admin'), false);
expect('…not from an anonymous account listed in admins', await call('PUT', `${res('bo')}/review`, review('anonboss'), 'anonboss'), false);
expect('an admin takes a keep back', await call('DELETE', `${res('ann')}/review`, undefined, 'admin'), true);
await call('PUT', `${res('ann')}/review`, review(), 'admin');
expect('ann cannot take back a keep either', await call('DELETE', `${res('ann')}/review`, undefined, 'ann'), false);
expect('ann reads the board, with the keep on it', await call('GET', `daily/${today}/333/results`, undefined, 'ann'), true);

/* ---------------- re-timing ---------------- */
await call('PUT', `${res('bo')}/submittedAt`, now - 3600000, 'owner');
expect('an admin sets bo\'s time to +2, an hour after', await call('PUT', `${res('bo')}/penalty`, '+2', 'admin'), true);
expect('…to DNF', await call('PUT', `${res('bo')}/penalty`, 'DNF', 'admin'), true);
expect('…and back to no penalty, which bo himself never could', await call('PUT', `${res('bo')}/penalty`, 'none', 'admin'), true);
expect('…not to something else', await call('PUT', `${res('bo')}/penalty`, '+4', 'admin'), false);
expect('…not on a time that is not there', await call('PUT', `${res('cy')}/penalty`, 'DNF', 'admin'), false);
expect('…not from an anonymous account listed in admins', await call('PUT', `${res('bo')}/penalty`, 'DNF', 'anonboss'), false);
expect('ann cannot set bo\'s', await call('PUT', `${res('bo')}/penalty`, 'DNF', 'ann'), false);
expect('bo still adds a heavier one himself', await call('PUT', `${res('bo')}/penalty`, '+2', 'bo'), true);
expect('…but cannot clear it an hour on', await call('PUT', `${res('bo')}/penalty`, 'none', 'bo'), false);
expect('an admin cannot delete the penalty (no penalty is "none")', await call('DELETE', `${res('bo')}/penalty`, undefined, 'admin'), false);

/* ---------------- the featured replay ---------------- */
await call('PATCH', '', { [`daily/${today}/333/replayClaim/ann`]: now, [`${res('ann')}/replay`]: true }, 'owner');
const feat = `sotdFeaturedReplay/${today}`;
expect('an admin features ann\'s shared replay', await call('PUT', feat, { event: '333', uid: 'ann' }, 'admin'), true);
expect('anybody reads it, signed out too', await call('GET', feat, undefined, null), true);
expect('…not a time with no replay shared', await call('PUT', feat, { event: '333', uid: 'bo' }, 'admin'), false);
expect('…not a time that is not there', await call('PUT', feat, { event: '222', uid: 'ann' }, 'admin'), false);
expect('…not with a field the rules do not know', await call('PUT', feat, { event: '333', uid: 'ann', note: 'wow' }, 'admin'), false);
expect('…not under a key that is not a day', await call('PUT', 'sotdFeaturedReplay/today', { event: '333', uid: 'ann' }, 'admin'), false);
expect('ann cannot feature her own', await call('PUT', feat, { event: '333', uid: 'ann' }, 'ann'), false);
expect('nor take it off', await call('DELETE', feat, undefined, 'ann'), false);
expect('an anonymous account listed in admins cannot', await call('PUT', feat, { event: '333', uid: 'ann' }, 'anonboss'), false);
expect('an admin takes it off', await call('DELETE', feat, undefined, 'admin'), true);

/* ---------------- the board closed for the day ---------------- */
expect('an admin closes the board', await change('admin', 'sotd/frozen', true), true);
expect('…with a message', await change('admin', 'sotd/frozenMessage', 'The scramble leaked: back tomorrow.'), true);
expect('cy cannot send a time while it is closed', await call('PUT', res('cy'), row('Cy', 9000), 'cy'), false);
expect('…on any event', await call('PUT', res('cy', '222'), row('Cy', 3000), 'cy'), false);
expect('the board still reads', await call('GET', `daily/${today}/333/results`, undefined, 'ann'), true);
expect('an admin still re-times on it', await call('PUT', `${res('ann')}/penalty`, '+2', 'admin'), true);
expect('an admin still removes from it', await call('PATCH', `daily/${today}/333`, { 'results/ann': null, 'removed/ann': { at: TS, final: false } }, 'admin'), true);
expect('an admin lists the day\'s removals (Past days counts them)', await call('GET', `daily/${today}/333/removed`, undefined, 'admin'), true);
expect('ann reads her own removal', await call('GET', `daily/${today}/333/removed/ann`, undefined, 'ann'), true);
expect('…but cannot list everybody\'s', await call('GET', `daily/${today}/333/removed`, undefined, 'ann'), false);
expect('ann cannot close it', await change('ann', 'sotd/frozen', false), false);
expect('not a closed that is not true or false', await change('admin', 'sotd/frozen', 'yes'), false);
expect('an admin opens it again', await change('admin', 'sotd/frozen', false), true);
expect('cy sends a time', await call('PUT', res('cy'), row('Cy', 9000), 'cy'), true);

/* ================= the rules from before this phase ================= */

await load('sotd-tools-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
expect('old rules: ann sends a time', await call('PUT', res('ann'), row('Ann', 2900), 'ann'), true);
expect('old rules: no keep (a time under its floor stays marked)', await call('PUT', `${res('ann')}/review`, review(), 'admin'), false);
expect('old rules: an admin cannot re-time', await call('PUT', `${res('ann')}/penalty`, 'DNF', 'admin'), false);
expect('old rules: no featured replay to read', await call('GET', feat, undefined, 'ann'), false);
expect('old rules: …nor to write', await call('PUT', feat, { event: '333', uid: 'ann' }, 'admin'), false);
expect('old rules: no floors setting', await change('admin', 'sotd/floors', '333:3000'), false);
expect('old rules: no closing the board', await change('admin', 'sotd/frozen', true), false);
expect('old rules: an admin cannot list the removals (Past days leaves the count out)', await call('GET', `daily/${today}/333/removed`, undefined, 'admin'), false);
expect('old rules: …but reads the results', await call('GET', `daily/${today}/333/results`, undefined, 'admin'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
