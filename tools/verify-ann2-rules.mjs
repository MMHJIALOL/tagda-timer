/* Announcements and feedback, round two (targeting and Spanish on an announcement, the
   feedback inbox, What's new; ADMIN.md §21), checked against the database emulator.
       node tools/verify-ann2-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-ann2-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`ann2-rules`), and the rules
   from before this phase into another (`ann2-old`). Users are unsigned tokens. */

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

let NS = 'ann2-rules';
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
  const marker = '"feedbackLast"';
  const intro = git('log', '-S', marker, '--format=%H', '--reverse', '--', 'firebase.rules.json').trim().split('\n')[0];
  const text = git('show', `${intro ? `${intro}^` : 'HEAD'}:firebase.rules.json`);
  if (text.includes(marker)) throw new Error('could not find the rules from before phase 14');
  return text;
}

let n = 0;
/** An announcement saved as the console saves one: the record and its configLog entry together. */
function ann(id, extra = {}, who = 'admin') {
  const log = `L${++n}`;
  return call('PATCH', '', {
    [`announcements/${id}`]: { title: 'Hello', text: 'x', style: 'card', audience: 'everyone', startAt: 0, maxShows: 1, version: 1, log, by: who === 'admin' ? 'boss' : who, updatedAt: TS, ...extra },
    [`configLog/${log}`]: { uid: who === 'admin' ? 'boss' : who, at: TS, path: `ann/${id}`, action: 'create', title: 'Hello' },
  }, who);
}
const fb = (extra = {}) => ({ at: TS, text: 'The timer is great but sq1 is slow', ver: 127, ua: 'firefox', page: 'about', ...extra });
const send = (who, id, rec, last = TS) => call('PATCH', '', { [`feedback/${id}`]: rec, [`feedbackLast/${who}`]: last }, who);
const news = (extra = {}) => ({ at: Date.now(), ver: 127, title: 'Faster Square-1', text: 'Scrambles in a second.', by: 'boss', ...extra });

await load('ann2-rules', readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

/* ---------------- targeting and Spanish ---------------- */
expect('an announcement for versions 120 to 130, phones, Spanish, signed in, with Spanish words', await ann('t1', {
  minVer: 120, maxVer: 130, platform: 'phone', lang: 'es', signedInOnly: true, es: { title: 'Hola', text: 'Algo nuevo', label: 'Probar' } }), true);
expect('not a platform the rules do not know', await ann('t2', { platform: 'tv' }), false);
expect('not a language the rules do not know', await ann('t3', { lang: 'fr' }), false);
expect('not a version below 0', await ann('t4', { minVer: -1 }), false);
expect('not half a version', await ann('t5', { maxVer: 12.5 }), false);
expect('not a Spanish title past 80 characters', await ann('t6', { es: { title: 'x'.repeat(81) } }), false);
expect('not a Spanish field the rules do not know', await ann('t7', { es: { title: 'Hola', emoji: '👋' } }), false);
expect('signed in only is true or false', await ann('t8', { signedInOnly: 'yes' }), false);

/* ---------------- the feedback inbox ---------------- */
expect('ann sends feedback, with her account', await send('ann', 'F1', fb({ uid: 'ann', name: 'Ann', rating: 4 })), true);
expect('…not a second within the hour', await send('ann', 'F2', fb()), false);
await call('PUT', 'feedbackLast/ann', Date.now() - 3700000, 'owner');
expect('…but after it, yes', await send('ann', 'F2', fb()), true);
expect('bo sends his without an account in it', await send('bo', 'F3', fb()), true);
expect('not without the hour\'s stamp', await call('PUT', 'feedback/F4', fb(), 'bo'), false);
expect('not in somebody else\'s name', await send('admin', 'F4', fb({ uid: 'ann' })), false);
expect('not from an anonymous race account', await send('racer', 'F4', fb()), false);
expect('not empty', await send('admin', 'F4', fb({ text: '' })), false);
expect('not past 1000 characters', await send('admin', 'F4', fb({ text: 'x'.repeat(1001) })), false);
expect('not a rating of 6', await send('admin', 'F4', fb({ rating: 6 })), false);
expect('not with a field the rules do not know', await send('admin', 'F4', fb({ email: 'a@b.c' })), false);
expect('not already marked read, starred or replied to', await send('admin', 'F4', fb({ read: TS })), false);
expect('…nor with a reply of its own', await send('admin', 'F4', fb({ uid: 'boss', reply: { text: 'fixed', by: 'boss', at: TS } })), false);
expect('ann reads hers (it has her account)', await call('GET', 'feedback/F1', undefined, 'ann'), true);
expect('bo does not read ann\'s', await call('GET', 'feedback/F1', undefined, 'bo'), false);
expect('…nor the inbox', await call('GET', 'feedback', undefined, 'bo'), false);
expect('nobody reads when somebody last sent one, admins neither', await call('GET', 'feedbackLast/ann', undefined, 'admin'), false);
expect('an admin reads the inbox', await call('GET', 'feedback', undefined, 'admin'), true);
expect('…marks one read', await call('PUT', 'feedback/F1/read', TS, 'admin'), true);
expect('…stars it', await call('PUT', 'feedback/F1/star', true, 'admin'), true);
expect('…replies to ann (her account is on it)', await call('PUT', 'feedback/F1/reply', { text: 'Fixed in 128, thanks!', by: 'boss', at: TS }, 'admin'), true);
expect('…not to bo\'s, which has no account to reach', await call('PUT', 'feedback/F3/reply', { text: 'Thanks', by: 'boss', at: TS }, 'admin'), false);
expect('…not in somebody else\'s name', await call('PUT', 'feedback/F1/reply', { text: 'x', by: 'ann', at: TS }, 'admin'), false);
expect('ann cannot star or reply to her own', await call('PUT', 'feedback/F1/star', true, 'ann'), false);
expect('ann cannot change what she sent', await call('PUT', 'feedback/F1/text', 'never mind', 'ann'), false);
expect('ann marks the reply read', await call('PUT', 'feedback/F1/replySeen', TS, 'ann'), true);
expect('bo cannot mark it for her', await call('PUT', 'feedback/F1/replySeen', TS, 'bo'), false);
expect('ann cannot delete hers', await call('DELETE', 'feedback/F1', undefined, 'ann'), false);
expect('an admin deletes one', await call('DELETE', 'feedback/F3', undefined, 'admin'), true);
expect('an anonymous account listed in admins reads nothing', await call('GET', 'feedback', undefined, 'anonboss'), false);

/* ---------------- What's new ---------------- */
expect('an admin adds an entry', await call('PUT', 'changelog/-n1', news({ es: { title: 'Square-1 más rápido', text: 'En un segundo.' } }), 'admin'), true);
expect('anybody reads them, signed out too', await call('GET', 'changelog', undefined, null), true);
expect('…newest first, as the timer asks', await call('GET', 'changelog', undefined, null, '&orderBy=%22%24key%22&limitToLast=20'), true);
expect('ann cannot add one', await call('PUT', 'changelog/-n2', news({ by: 'ann' }), 'ann'), false);
expect('not without a title', await call('PUT', 'changelog/-n2', news({ title: '' }), 'admin'), false);
expect('not a text past 600 characters', await call('PUT', 'changelog/-n2', news({ text: 'x'.repeat(601) }), 'admin'), false);
expect('not a Spanish field the rules do not know', await call('PUT', 'changelog/-n2', news({ es: { label: 'x' } }), 'admin'), false);
expect('not in somebody else\'s name', await call('PUT', 'changelog/-n2', news({ by: 'ann' }), 'admin'), false);
expect('an admin edits one', await call('PUT', 'changelog/-n1/title', 'Square-1, faster', 'admin'), true);
expect('…and deletes one', await call('DELETE', 'changelog/-n1', undefined, 'admin'), true);

/* ================= the rules from before this phase ================= */

await load('ann2-old', oldRules());
console.log(`\nthe rules from before this phase, namespace ${NS}\n`);
expect('old rules: an announcement without targeting saves as before', await ann('o1'), true);
expect('old rules: …with targeting, refused', await ann('o2', { platform: 'phone' }), false);
expect('old rules: no feedback', await send('ann', 'F1', fb()), false);
expect('old rules: What\'s new does not read (the timer shows none)', await call('GET', 'changelog', undefined, null), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
