/* Costs and storage (presence, an announcement's stats cleared, sweeps in the moderation log;
   ADMIN.md §20), checked against the database emulator.
       node tools/verify-costs-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-costs-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`costs-rules`), and the rules
   from before this phase into another (`costs-old`). Users are unsigned tokens. */

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
const users = { admin: token('boss'), ann: token('ann'), bo: token('bo'), racer: token('racer', 'anonymous'), anonboss: token('anonboss', 'anonymous') };

let NS = 'costs-rules';
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
  const marker = '"presence"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 13');
  return text;
}

const now = Date.now();
const here = (k = 'app', extra = {}) => ({ at: TS, k, ...extra });
const seed = () => call('PATCH', '', {
  'announcements/old-news': { title: 'Old news', style: 'card', audience: 'everyone', startAt: 1, endAt: 2, maxShows: 1, version: 1, log: 'x', by: 'boss', updatedAt: 1 },
  'annStats/old-news/1': { ann: 'shown', bo: 'clicked' },
  'annStats/gone-one/1': { ann: 'dismissed' },
  'rooms/OLD01': { meta: { createdAt: now - 30 * 86400000, event: '333', mode: 'wca', round: 1 } },
  'rooms/OLD02': { meta: { createdAt: now - 20 * 86400000, event: '333', mode: 'wca', round: 1 } },
}, 'owner');

await load('costs-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);
await seed();

/* ---------------- presence ---------------- */
expect('ann says her connection is up', await call('PUT', 'presence/ann/-c1', here(), 'ann'), true);
expect('…a race tab too', await call('PUT', 'presence/ann/-c2', here('race'), 'ann'), true);
expect('an anonymous race account says its own', await call('PUT', 'presence/racer/-c1', here('race'), 'racer'), true);
expect('not a kind the rules do not know', await call('PUT', 'presence/ann/-c3', here('bot'), 'ann'), false);
expect('not a made-up time', await call('PUT', 'presence/ann/-c3', { at: now - 1000, k: 'app' }, 'ann'), false);
expect('not a field the rules do not know', await call('PUT', 'presence/ann/-c3', here('app', { ua: 'x' }), 'ann'), false);
expect('not under a key past 40 characters', await call('PUT', `presence/ann/${'x'.repeat(41)}`, here(), 'ann'), false);
expect('not in somebody else\'s name', await call('PUT', 'presence/ann/-c4', here(), 'bo'), false);
expect('ann takes hers away (what onDisconnect does)', await call('DELETE', 'presence/ann/-c1', undefined, 'ann'), true);
expect('bo cannot take ann\'s away', await call('DELETE', 'presence/ann/-c2', undefined, 'bo'), false);
expect('ann cannot read who is connected', await call('GET', 'presence', undefined, 'ann'), false);
expect('…nor her own', await call('GET', 'presence/ann', undefined, 'ann'), false);
expect('an admin reads them all', await call('GET', 'presence', undefined, 'admin'), true);
expect('…and shallow, as Health › Storage counts', await call('GET', 'presence', undefined, 'admin', '&shallow=true'), true);
expect('an anonymous account listed in admins does not', await call('GET', 'presence', undefined, 'anonboss'), false);

/* ---------------- an announcement's stats, cleared ---------------- */
expect('an admin clears an announcement\'s stats, logged as a sweep', await call('PATCH', '', {
  'annStats/old-news': null, 'annStats/gone-one': null,
  'modLog/-s1': { by: 'boss', at: TS, action: 'sweep', path: 'annStats', note: '2 announcements', before: ['old-news', 'gone-one'] },
}, 'admin'), true);
await seed();
expect('ann cannot clear them', await call('DELETE', 'annStats/old-news', undefined, 'ann'), false);
expect('an admin cannot write somebody\'s stat', await call('PUT', 'annStats/old-news/1/ann', 'clicked', 'admin'), false);
expect('…nor put stats in place of them', await call('PUT', 'annStats/old-news', { 1: { ann: 'shown' } }, 'admin'), false);
expect('an anonymous account listed in admins cannot clear them', await call('DELETE', 'annStats/old-news', undefined, 'anonboss'), false);

/* ---------------- old rooms, swept ---------------- */
expect('an admin sweeps old rooms in one update, logged', await call('PATCH', '', {
  'rooms/OLD01': null, 'rooms/OLD02': null,
  'modLog/-s2': { by: 'boss', at: TS, action: 'sweep', path: 'rooms', note: '2 rooms', before: ['OLD01', 'OLD02'] },
}, 'admin'), true);
await seed();
expect('ann cannot', await call('DELETE', 'rooms/OLD01', undefined, 'ann'), false);

/* ================= the rules from before this phase ================= */

await load('costs-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
await seed();
expect('old rules: no presence (the app stops trying)', await call('PUT', 'presence/ann/-c1', here(), 'ann'), false);
expect('old rules: no clearing an announcement\'s stats', await call('DELETE', 'annStats/old-news', undefined, 'admin'), false);
expect('old rules: no sweep entry in the log…', await call('PUT', 'modLog/-s3', { by: 'boss', at: TS, action: 'sweep', path: 'rooms' }, 'admin'), false);
expect('…so an old-room sweep goes alone, which lands', await call('PATCH', '', { 'rooms/OLD01': null }, 'admin'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
