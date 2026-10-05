/* The Scramble of the Day admin removal rules, checked against the database emulator.
       node tools/verify-sotd-remove-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-sotd-remove-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`sotd-remove-rules`),
   so a running `tools/sotd-replay-dev.mjs` and the app's data are not
   touched. Users are unsigned tokens, the same as verify-sotd-chat-rules.mjs. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'sotd-remove-rules';
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
const users = { alice: token('alice'), bob: token('bob'), carol: token('carol'), admin: token(ADMIN) };
const uidOf = (who) => (who === 'admin' ? ADMIN : who);

async function call(method, path, body, who) {
  const auth = who === 'owner' ? '' : who ? `&auth=${users[who]}` : '';
  const headers = who === 'owner' ? { Authorization: 'Bearer owner' } : {};
  const r = await fetch(`${DB}/${path}.json?ns=${NS}${auth}`, {
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
const check = (ok, body) => ({ ok, status: 0, body });

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');
// The admin is whoever admins/ says, added by hand in the console (ADMIN.md).
await call('PUT', `admins/${ADMIN}`, true, 'owner');

const now = Date.now();
const today = String(now - ((now + IST) % DAY));
const yday = String(Number(today) - DAY);
const base = `daily/${today}/333`;

/** One attempt, the way the app writes it: progress stamps, then the result, then `submitted`. */
async function solve(who, extra = {}) {
  const u = uidOf(who);
  await call('PATCH', `${base}/progress/${u}`, { status: 'solving', startedAt: TS }, who);
  await call('PATCH', `${base}/progress/${u}`, { status: 'stopped', finishedAt: TS }, who);
  const r = await call('PUT', `${base}/results/${u}`, { timeMs: 9000, penalty: 'none', name: who, submittedAt: TS, ...extra }, who);
  await call('PATCH', `${base}/progress/${u}`, { status: 'done', submitted: true }, who);
  return r;
}

/** What the app's admin button sends: one update, so all of it lands or none of it. */
const removal = (uid, final, fields = {}) => ({
  [`results/${uid}`]: null,
  [`removed/${uid}`]: { at: TS, final, ...fields },
  [`progress/${uid}/submitted`]: null,
  [`replayClaim/${uid}`]: null,
});

console.log(`rules from firebase.rules.json, namespace ${NS}, today ${today}\n`);

for (const u of ['alice', 'bob', 'admin']) expect(`${u} submits`, await solve(u), true);
expect('alice shares a replay (claim)', await call('PUT', `${base}/replayClaim/alice`, TS, 'alice'), true);
expect('…and flags her row', await call('PUT', `${base}/results/alice/replay`, true, 'alice'), true);

// ---- who may remove
expect('bob cannot remove alice\'s time', await call('PATCH', base, removal('alice', false), 'bob'), false);
expect('bob cannot delete his own time', await call('DELETE', `${base}/results/bob`, undefined, 'bob'), false);
expect('bob cannot delete his own time with a removal record either',
  await call('PATCH', base, removal('bob', false), 'bob'), false);
expect('the admin cannot delete a row without the removal record',
  await call('DELETE', `${base}/results/alice`, undefined, 'admin'), false);
expect('the admin cannot write a removal record and keep the row',
  await call('PUT', `${base}/removed/alice`, { at: TS, final: false }, 'admin'), false);
expect('final: true without a backup claim is refused', await call('PATCH', base, removal('alice', true), 'admin'), false);
expect('a client-chosen `at` is refused',
  await call('PATCH', base, { ...removal('alice', false), 'removed/alice': { at: now - 1000, final: false } }, 'admin'), false);
expect('an unknown field on the record is refused', await call('PATCH', base, removal('alice', false, { why: 'x' }), 'admin'), false);
expect('removing somebody with no row is refused', await call('PATCH', base, removal('carol', false), 'admin'), false);
expect('nothing of alice\'s moved after all that',
  check(!!(await call('GET', `${base}/results/alice`, undefined, 'owner')).body?.timeMs, null), true);

// ---- the removal itself
expect('the admin removes alice\'s time', await call('PATCH', base, removal('alice', false), 'admin'), true);
const after = (await call('GET', base, undefined, 'owner')).body || {};
expect('her row is gone, the record is there, her progress stays without `submitted`, her replay claim is cleared',
  check(!after.results?.alice && after.removed?.alice?.final === false && after.removed.alice.at > 0
    && after.progress?.alice?.status === 'done' && after.progress.alice.submitted === undefined
    && !after.replayClaim?.alice, after), true);
expect('alice can read her own record', await call('GET', `${base}/removed/alice`, undefined, 'alice'), true);
expect('bob cannot read alice\'s record', await call('GET', `${base}/removed/alice`, undefined, 'bob'), false);
expect('alice cannot read the board any more', await call('GET', `${base}/results`, undefined, 'alice'), false);
expect('…or the chat', await call('GET', `${base}/chat/m`, undefined, 'alice'), false);
expect('alice cannot clear her record', await call('DELETE', `${base}/removed/alice`, undefined, 'alice'), false);
expect('…nor can the admin', await call('DELETE', `${base}/removed/alice`, undefined, 'admin'), false);
expect('alice cannot resubmit on the main scramble',
  await call('PUT', `${base}/results/alice`, { timeMs: 8000, penalty: 'none', name: 'alice', submittedAt: TS }, 'alice'), false);
expect('…nor claim to be on the backup without a claim',
  await call('PUT', `${base}/results/alice`, { timeMs: 8000, penalty: 'none', name: 'alice', submittedAt: TS, backup: true }, 'alice'), false);
expect('a note alone cannot put a row back', await call('PUT', `${base}/results/alice/note`, 'hi', 'alice'), false);
expect('nor can a replay flag', await call('PUT', `${base}/results/alice/replay`, false, 'alice'), false);

// ---- the backup
expect('alice claims the backup', await call('PUT', `${base}/backupClaim/alice`, TS, 'alice'), true);
expect('alice publishes / reads the backup scramble', await call('PUT', `${base}/backup`, "R U R' U'", 'alice'), true);
await call('PATCH', `${base}/progress/alice`, { status: 'inspecting', startedAt: null, finishedAt: null }, 'alice');
expect('alice submits on the backup', await solve('alice', { backup: true }), true);
expect('alice reads the board again', await call('GET', `${base}/results`, undefined, 'alice'), true);
expect('alice can share a replay of the backup solve', await call('PUT', `${base}/replayClaim/alice`, TS, 'alice'), true);
expect('…and write a note on it', await call('PUT', `${base}/results/alice/note`, 'honest', 'alice'), true);

// ---- the backup removed too: that is the day
expect('final: false is refused once she has claimed the backup',
  await call('PATCH', base, removal('alice', false), 'admin'), false);
expect('the admin removes the backup time (final)', await call('PATCH', base, removal('alice', true), 'admin'), true);
expect('alice cannot submit again',
  await call('PUT', `${base}/results/alice`, { timeMs: 8000, penalty: 'none', name: 'alice', submittedAt: TS, backup: true }, 'alice'), false);
expect('…nor claim again', await call('PUT', `${base}/backupClaim/alice`, TS, 'alice'), false);
expect('…nor overwrite her record', await call('PUT', `${base}/removed/alice`, { at: TS, final: false }, 'alice'), false);

// ---- everybody else is untouched
expect('bob still writes his note', await call('PUT', `${base}/results/bob/note`, 'gg', 'bob'), true);
expect('bob still reads the board', await call('GET', `${base}/results`, undefined, 'bob'), true);
expect('bob can still share a replay', await call('PUT', `${base}/replayClaim/bob`, TS, 'bob'), true);
expect('a fresh result for carol still lands', await solve('carol'), true);

// ---- the admin's own time, and another day's
expect('the admin removes their own time', await call('PATCH', base, removal(ADMIN, false), 'admin'), true);
expect('…and can claim the backup like anyone', await call('PUT', `${base}/backupClaim/${ADMIN}`, TS, 'admin'), true);
await call('PUT', `daily/${yday}/333/results/bob`, { timeMs: 9000, name: 'bob' }, 'owner');
expect('the admin removes a time from yesterday\'s board',
  await call('PATCH', `daily/${yday}/333`, removal('bob', false), 'admin'), true);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
