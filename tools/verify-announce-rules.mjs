/* The admin console's announcement rules (announcements/, annStats/, their
   change-log entries) and the newer setting types, checked against the
   database emulator.
       node tools/verify-announce-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-announce-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`announce-rules`).
   Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'announce-rules';
const TS = { '.sv': 'timestamp' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'google.com') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const users = { boss: token('boss'), alice: token('alice'), anon: token('anon', 'anonymous'), anonboss: token('anonboss', 'anonymous') };

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

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');
await call('PUT', 'admins', { boss: true, anonboss: true }, 'owner');

console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

let n = 0;
const base = {
  title: 'New: the admin console', text: 'Settings from a phone.', style: 'card', audience: 'everyone',
  startAt: 0, maxShows: 3, version: 1, button: { label: 'Open', action: 'panel', target: 'settings' },
};
/** The admin page's save: the record (with log, by, updatedAt) and its log entry, in one update. */
function save(who, id, rec, { action = 'edit', logPath = `ann/${id}`, noLog = false, logId } = {}) {
  const lid = logId || `A${String(++n).padStart(3, '0')}`;
  const uid = who === 'anonboss' ? 'anonboss' : who;
  const body = { [`announcements/${id}`]: { ...rec, log: lid, by: uid, updatedAt: TS } };
  if (!noLog) body[`configLog/${lid}`] = { uid, at: TS, path: logPath, title: rec.title || '', ...(action ? { action } : {}) };
  return call('PATCH', '', body, who);
}

expect('an admin creates an announcement, with its log entry', await save('boss', 'console-news', base, { action: 'create' }), true);
expect('everybody reads announcements, signed out too', await call('GET', 'announcements', undefined, null), true);
expect('a non-admin cannot', await save('alice', 'console-news', base), false);
expect('an anonymous account listed in admins/ cannot', await save('anonboss', 'console-news', base), false);
expect('signed out cannot', await save(null, 'console-news', base), false);
expect('without its log entry, refused', await save('boss', 'console-news', base, { noLog: true }), false);
expect('with a log entry about another announcement, refused', await save('boss', 'console-news', base, { logPath: 'ann/other' }), false);
expect('a log entry with no action, refused', await save('boss', 'console-news', base, { action: null }), false);
expect('an id with capitals, refused', await save('boss', 'Console', base), false);
for (const [what, rec] of [
  ['a style that does not exist', { ...base, style: 'banner' }],
  ['an audience that does not exist', { ...base, audience: 'all' }],
  ['an http link', { ...base, button: { label: 'Go', action: 'link', target: 'http://example.com' } }],
  ['a panel that does not exist', { ...base, button: { label: 'Go', action: 'panel', target: 'nowhere' } }],
  ['an empty title', { ...base, title: '' }],
  ['81 characters of title', { ...base, title: 'x'.repeat(81) }],
  ['401 of text', { ...base, text: 'x'.repeat(401) }],
  ['a 31-character button', { ...base, button: { label: 'x'.repeat(31), action: 'panel', target: 'camera' } }],
  ['maxShows 101', { ...base, maxShows: 101 }],
  ['version 0', { ...base, version: 0 }],
  ['a field that is not allowed', { ...base, colour: 'red' }],
]) expect(`${what}: refused`, await save('boss', 'console-news', rec), false);
expect('an https link is fine', await save('boss', 'console-news', { ...base, button: { label: 'Read', action: 'link', target: 'https://tagdatimer.me/admin' } }), true);
expect('Show again: version up', await save('boss', 'console-news', { ...base, version: 2 }, { action: 'again' }), true);
expect('version back down: refused (it would show old answers again)', await save('boss', 'console-news', { ...base, version: 1 }), false);
expect('End now: an end at the server’s clock', await save('boss', 'console-news', { ...base, version: 2, endAt: TS }, { action: 'end' }), true);
expect('an announcement cannot be deleted', await call('DELETE', 'announcements/console-news', undefined, 'boss'), false);
expect('one field alone, without the log, refused', await call('PUT', 'announcements/console-news/maxShows', 5, 'boss'), false);
expect('a log entry about an announcement with no change behind it, refused', await call('PUT', 'configLog/Z1', { uid: 'boss', at: TS, path: 'ann/console-news', action: 'edit' }, 'boss'), false);
expect('a config entry still needs its own chain (unchanged)', await call('PUT', 'configLog/Z2', { uid: 'boss', at: TS, path: 'sandbox/n', to: 3 }, 'boss'), false);

/* ---------------- annStats ---------------- */

const stat = (who, id, v, val) => call('PUT', `annStats/${id}/${v}/${who === 'anon' ? 'anon' : who}`, val, who);
expect('a signed-in account records “shown”', await stat('alice', 'console-news', 2, 'shown'), true);
expect('“shown” again: refused (one record each)', await stat('alice', 'console-news', 2, 'shown'), false);
expect('then “clicked”', await stat('alice', 'console-news', 2, 'clicked'), true);
expect('then “dismissed”: refused (an answer is final)', await stat('alice', 'console-news', 2, 'dismissed'), false);
expect('a built-in announcement’s stats (no record in the database)', await stat('alice', 'webcam-replay', 1, 'dismissed'), true);
expect('an announcement that does not exist: refused', await stat('alice', 'nope', 1, 'shown'), false);
expect('an anonymous account: refused', await stat('anon', 'console-news', 2, 'shown'), false);
expect('somebody else’s record: refused', await call('PUT', 'annStats/console-news/2/bob', 'shown', 'alice'), false);
expect('a value that is not one of the three: refused', await stat('alice', 'feedback', 1, 'liked'), false);
expect('a version that is not a number: refused', await call('PUT', 'annStats/console-news/x/alice', 'shown', 'alice'), false);
expect('an admin reads the stats', await call('GET', 'annStats', undefined, 'boss'), true);
expect('nobody else does', await call('GET', 'annStats/console-news', undefined, 'alice'), false);

/* ---------------- the newer setting types ---------------- */

const cfg = (path, to, from) => {
  const id = `C${String(++n).padStart(3, '0')}`;
  const entry = { uid: 'boss', at: TS, path };
  if (from !== undefined) entry.from = from;
  if (to !== null) entry.to = to;
  return call('PATCH', '', { [`config/${path}`]: to, [`configMeta/${path}`]: { at: TS, by: 'boss', log: id }, [`configLog/${id}`]: entry }, 'boss');
};
expect('a set of events: some of them', await cfg('sotd/events', '333,222,sq1'), true);
expect('…none at all', await cfg('sotd/events', '', '333,222,sq1'), true);
expect('…one that is not an event: refused', await cfg('sotd/events', '333,333fm', ''), false);
expect('a link: https', await cfg('feedback/url', 'https://forms.example/x'), true);
expect('…http: refused', await cfg('feedback/url', 'http://forms.example/x', 'https://forms.example/x'), false);
expect('…with a space: refused', await cfg('feedback/url', 'https://a b', 'https://forms.example/x'), false);
expect('a time', await cfg('feedback/endAt', Date.now() + 86400000), true);
expect('…a fraction: refused', await cfg('feedback/endAt', 1.5, undefined), false);

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
