/* Who may read an uploaded profile picture (js/faces.js), checked against the
   database emulator.
       node tools/verify-avatar-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-avatar-rules.mjs

   Loads firebase.rules.json into a namespace of its own (`avatar-rules`), so
   a running `tools/sotd-replay-dev.mjs` and the app's data are not touched.
   Users are unsigned tokens, as in verify-sotd-chat-rules.mjs. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'avatar-rules';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid) {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: 'google.com', identities: {} },
  })}.`;
}
const users = { alice: token('alice'), bob: token('bob') };

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
function expect(name, res, ok, body) {
  const pass = res.ok === ok && (body === undefined || JSON.stringify(res.body) === JSON.stringify(body));
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`}`);
}

const rules = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'),
});
if (!rules.ok) { console.error('could not load the rules:', rules.status, await rules.text()); process.exit(1); }
await call('DELETE', '', undefined, 'owner');

const face = `data:image/webp;base64,${'A'.repeat(4000)}`;
console.log(`rules from firebase.rules.json, namespace ${NS}\n`);

expect('a settings write carrying a picture still goes through',
  await call('PUT', 'users/alice/settings', { raceName: 'Alice', theme: 'dark', avatar: face }, 'alice'), true);
expect('another account reads the picture', await call('GET', 'users/alice/settings/avatar', undefined, 'bob'), true, face);
expect('…and nothing else in those settings', await call('GET', 'users/alice/settings/raceName', undefined, 'bob'), false);
expect('…nor the settings as a whole', await call('GET', 'users/alice/settings', undefined, 'bob'), false);
expect('…nor anything else of theirs', await call('GET', 'users/alice/solves', undefined, 'bob'), false);
expect('signed out, the picture is not readable', await call('GET', 'users/alice/settings/avatar', undefined, null), false);
expect('nobody else may write it', await call('PUT', 'users/alice/settings/avatar', face, 'bob'), false);
expect('an account with no picture reads as null, not as refused',
  await call('GET', 'users/bob/settings/avatar', undefined, 'alice'), true, null);

await call('PUT', 'users/alice/settings', { raceName: 'Alice', avatar: '' }, 'alice');
expect('a removed picture reads as empty', await call('GET', 'users/alice/settings/avatar', undefined, 'bob'), true, '');

expect('an oversized value can still be saved, so settings sync never breaks over it',
  await call('PUT', 'users/alice/settings', { raceName: 'Alice', avatar: 'x'.repeat(40001) }, 'alice'), true);
expect('…but nobody else downloads it', await call('GET', 'users/alice/settings/avatar', undefined, 'bob'), false);
expect('…while its owner still reads all of it', await call('GET', 'users/alice/settings/avatar', undefined, 'alice'), true);

await call('PUT', 'users/alice/settings', { raceName: 'Alice', avatar: { big: 'x' } }, 'alice');
expect('a picture that is not a string is not readable by others', await call('GET', 'users/alice/settings/avatar', undefined, 'bob'), false);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
