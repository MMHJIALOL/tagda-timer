/* The 1v1 rating's rules (RATING-PLAN.md §5–§6), checked against the
   database emulator.
       node tools/verify-rating-rules.mjs                 emulator on 127.0.0.1:9000
       RTDB=http://127.0.0.1:9400 node tools/verify-rating-rules.mjs

   Only the Worker's rater account (a custom token, uid tagda-rater) writes a
   rating: ratings/<google uid>, ratingPair/<day>/<pair>, and a 1v1's
   rated/<round> and elo/<seat>. It reads a 1v1's results and account links
   to do so, and nothing more. Everybody else, including a Google or
   anonymous account that happens to be called tagda-rater, writes none of
   it. duel.rated off refuses every rating change; duel.ratedPairCap stops
   one pair's rated rounds for the day.

   Loads firebase.rules.json into a namespace of its own (`rating`). Users are
   unsigned tokens, as in verify-rooms-rules.mjs. */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATER_UID, generatedRules } from '../js/config-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = 'rating';
const TS = { '.sv': 'timestamp' };
const DAY_MS = 86_400_000, IST_MS = 19_800_000;
const dayStart = (t = Date.now()) => String(t - ((t + IST_MS) % DAY_MS));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'anonymous') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
// Race seats (alice, bob, carol) are anonymous; gina and gail are the Google accounts behind alice and bob.
const users = {
  rater: token(RATER_UID, 'custom'),
  fakeAnon: token(RATER_UID), fakeGoogle: token(RATER_UID, 'google.com'),
  scheduler: token('tagda-scheduler', 'custom'),
  admin: token('boss', 'google.com'),
  alice: token('alice'), bob: token('bob'), carol: token('carol'),
  gina: token('gina', 'google.com'), gail: token('gail', 'google.com'),
  mo: token('mo', 'google.com'),            // a moderator of race rooms (mods/mo)
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
const set = (path, value) => call('PUT', path, value, 'owner');
const get = async (path) => (await call('GET', path, undefined, 'owner')).body;

let failed = 0, passed = 0;
function expect(name, res, ok) {
  const pass = res.ok === ok;
  if (pass) passed++; else failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `  (got ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`}`);
}
const check = (name, cond, got) => expect(name, { ok: !!cond, status: 0, body: got }, true);

/* ---------------- the file itself ---------------- */
const text = readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8');
const loose = text.replace(`auth.uid === '${RATER_UID}' && auth.token.firebase.sign_in_provider === 'custom'`, `auth.uid === '${RATER_UID}'`);
let threw = false;
try { generatedRules(loose); } catch { threw = true; }
console.log('— the file —');
check('a rater check written any other way is refused by generatedRules', loose !== text && threw);
check('…and the committed rules pass it', generatedRules(text) === text);

/* ---------------- setup ---------------- */
{
  const r = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text });
  if (!r.ok) { console.error('could not load the rules:', r.status, await r.text()); process.exit(1); }
}
await call('DELETE', '', undefined, 'owner');
await set('admins', { boss: true });

const now = Date.now();
const room = (kind) => ({
  meta: { createdAt: now, event: '333', mode: 'wca', round: 3, phase: 'racing', ...(kind ? { kind } : {}) },
  players: { alice: { name: 'alice', joinedAt: now, lastSeen: now }, bob: { name: 'bob', joinedAt: now, lastSeen: now } },
  acct: { alice: { claim: 'gina', ok: true }, bob: { claim: 'gail', ok: true } },
  rounds: { 1: {
    info: { scramble: "R U R' U'", hash: 'h1', event: '333' },
    results: { alice: { timeMs: 11200, hash: 'h1', submittedAt: now - 20000 }, bob: { timeMs: 11820, hash: 'h1', submittedAt: now - 20000 } },
  } },
  rtc: { alice: { media: { cam: false, mic: false } } },
});
await set('rooms/DUEL1', room('duel'));
await set('rooms/RACE1', room(null));
const rating = (r, n, w, l, d, v) => ({ r, n, w, l, d, v, at: TS });

/* ---------------- what the rater reads ---------------- */
console.log('— what the rater reads —');
expect('the rater reads a 1v1\'s account links in one go', await call('GET', 'rooms/DUEL1/acct', undefined, 'rater'), true);
expect('the rater reads a round\'s results', await call('GET', 'rooms/DUEL1/rounds/1/results', undefined, 'rater'), true);
expect('the rater cannot read the call\'s setup (IP addresses)', await call('GET', 'rooms/DUEL1/rtc', undefined, 'rater'), false);
expect('the rater cannot read every room', await call('GET', 'rooms', undefined, 'rater'), false);
expect('an anonymous account named tagda-rater reads no results', await call('GET', 'rooms/DUEL1/rounds/1/results', undefined, 'fakeAnon'), false);
expect('…nor the account links', await call('GET', 'rooms/DUEL1/acct', undefined, 'fakeAnon'), false);
expect('a Google account named tagda-rater reads no results', await call('GET', 'rooms/DUEL1/rounds/1/results', undefined, 'fakeGoogle'), false);
expect('the scheduler reads no results', await call('GET', 'rooms/DUEL1/rounds/1/results', undefined, 'scheduler'), false);
expect('the opponent still cannot read which account a seat is', await call('GET', 'rooms/DUEL1/acct/alice/claim', undefined, 'bob'), false);
expect('a seat still reads its own link', await call('GET', 'rooms/DUEL1/acct/alice', undefined, 'alice'), true);
expect('a player with no time in still cannot read the results', await call('GET', 'rooms/DUEL1/rounds/2/results', undefined, 'alice'), false);

/* ---------------- ratings/<g> ---------------- */
console.log('— ratings —');
expect('the rater starts a rating', await call('PUT', 'ratings/gina', rating(1016, 1, 1, 0, 0, 1), 'rater'), true);
expect('a new rating must be version 1', await call('PUT', 'ratings/gail', rating(984, 1, 0, 1, 0, 2), 'rater'), false);
expect('a new rating starts within 40 of 1000', await call('PUT', 'ratings/gail', rating(1100, 1, 1, 0, 0, 1), 'rater'), false);
expect('…so 984 is fine', await call('PUT', 'ratings/gail', rating(984, 1, 0, 1, 0, 1), 'rater'), true);
expect('the next round: version + 1', await call('PUT', 'ratings/gina', rating(1040, 2, 2, 0, 0, 2), 'rater'), true);
expect('a stale version is refused (two tabs at once)', await call('PUT', 'ratings/gina', rating(1060, 3, 3, 0, 0, 2), 'rater'), false);
expect('a version that skips is refused', await call('PUT', 'ratings/gina', rating(1060, 3, 3, 0, 0, 4), 'rater'), false);
expect('a change of more than 40 is refused', await call('PUT', 'ratings/gina', rating(1081, 3, 3, 0, 0, 3), 'rater'), false);
expect('a change of exactly 40 is fine', await call('PUT', 'ratings/gina', rating(1080, 3, 3, 0, 0, 3), 'rater'), true);
expect('two rounds in one write are refused', await call('PUT', 'ratings/gina', rating(1090, 5, 5, 0, 0, 4), 'rater'), false);
expect('rounds must add up to wins, losses and draws', await call('PUT', 'ratings/gina', rating(1090, 4, 3, 0, 0, 4), 'rater'), false);
expect('a reversal (one round less) is allowed', await call('PUT', 'ratings/gina', rating(1060, 2, 2, 0, 0, 4), 'rater'), true);
expect('nothing else under a rating', await call('PUT', 'ratings/gina', { ...rating(1070, 3, 3, 0, 0, 5), name: 'Gina' }, 'rater'), false);
expect('below 100 is refused', await call('PUT', 'ratings/carol1', rating(99, 1, 0, 1, 0, 1), 'admin'), false);
expect('`at` must be the server\'s time', await call('PUT', 'ratings/gina', { ...rating(1070, 3, 3, 0, 0, 5), at: 5 }, 'rater'), false);
expect('a player cannot write their own rating', await call('PUT', 'ratings/gina', rating(1070, 3, 3, 0, 0, 5), 'gina'), false);
expect('…nor change one field of it', await call('PUT', 'ratings/gina/r', 3000, 'gina'), false);
expect('an anonymous account named tagda-rater cannot', await call('PUT', 'ratings/gina', rating(1070, 3, 3, 0, 0, 5), 'fakeAnon'), false);
expect('a Google account named tagda-rater cannot', await call('PUT', 'ratings/gina', rating(1070, 3, 3, 0, 0, 5), 'fakeGoogle'), false);
expect('the scheduler cannot', await call('PUT', 'ratings/gina', rating(1070, 3, 3, 0, 0, 5), 'scheduler'), false);
expect('a player reads their own rating', await call('GET', 'ratings/gina', undefined, 'gina'), true);
expect('…but not somebody else\'s', await call('GET', 'ratings/gail', undefined, 'gina'), false);
expect('…and nobody lists them all', await call('GET', 'ratings', undefined, 'gina'), false);
expect('a seat cannot read its account\'s rating', await call('GET', 'ratings/gina', undefined, 'alice'), false);
expect('an admin reads one', await call('GET', 'ratings/gina', undefined, 'admin'), true);
expect('an admin resets one by any amount (version + 1)', await call('PUT', 'ratings/gina', rating(1000, 2, 2, 0, 0, 5), 'admin'), true);
expect('an admin deletes one', await call('DELETE', 'ratings/gail', undefined, 'admin'), true);
expect('…and the rater starts it again at version 1', await call('PUT', 'ratings/gail', rating(1016, 1, 1, 0, 0, 1), 'rater'), true);

await set('config/duel/rated', false);
expect('duel.rated off: the rater changes nothing', await call('PUT', 'ratings/gina', rating(1016, 3, 3, 0, 0, 6), 'rater'), false);
expect('…and starts nothing', await call('PUT', 'ratings/new1', rating(1016, 1, 1, 0, 0, 1), 'rater'), false);
expect('…but an admin can still reset one', await call('PUT', 'ratings/gina', rating(1000, 2, 2, 0, 0, 6), 'admin'), true);
await set('config/duel/rated', true);
expect('back on, the rater can again', await call('PUT', 'ratings/gina', rating(1016, 3, 3, 0, 0, 7), 'rater'), true);

/* ---------------- ratingPair/<day>/<pair> ---------------- */
console.log('— the pair\'s daily count —');
const today = dayStart(), yesterday = dayStart(Date.now() - DAY_MS);
const pair = `ratingPair/${today}/gail_gina`;
expect('the rater counts a pair\'s first rated round today', await call('PUT', pair, 1, 'rater'), true);
expect('…and the next', await call('PUT', pair, 2, 'rater'), true);
expect('the count only goes up by one', await call('PUT', pair, 4, 'rater'), false);
expect('…never down', await call('PUT', pair, 1, 'rater'), false);
expect('…and the rater does not delete it', await call('DELETE', pair, undefined, 'rater'), false);
expect('not on another day', await call('PUT', `ratingPair/${yesterday}/gail_gina`, 1, 'rater'), false);
expect('a pair key is two uids and one underscore', await call('PUT', `ratingPair/${today}/gail_gina_x`, 1, 'rater'), false);
expect('a player cannot count', await call('PUT', `ratingPair/${today}/gail_gina`, 3, 'gina'), false);
expect('a player cannot read the count', await call('GET', pair, undefined, 'gina'), false);
expect('the rater reads it', await call('GET', pair, undefined, 'rater'), true);
expect('an admin reads every day', await call('GET', 'ratingPair', undefined, 'admin'), true);
await set('config/duel/ratedPairCap', 2);
expect('duel.ratedPairCap 2: a third is refused', await call('PUT', pair, 3, 'rater'), false);
await set('config/duel/ratedPairCap', null);
let n = 2, capOk = true;
while (n < 20) { n++; if (!(await call('PUT', pair, n, 'rater')).ok) capOk = false; }
check('with no setting, rounds 3 to 20 count', capOk && n === 20, n);
expect('…and the 21st is refused (the ceiling)', await call('PUT', pair, 21, 'rater'), false);
await set('config/duel/rated', false);
expect('duel.rated off: no count either', await call('PUT', `ratingPair/${today}/a_b`, 1, 'rater'), false);
await set('config/duel/rated', true);
await set(`ratingPair/${yesterday}/gail_gina`, 7);
expect('an admin sweeps an old day', await call('DELETE', `ratingPair/${yesterday}`, undefined, 'admin'), true);
expect('…but not today', await call('DELETE', `ratingPair/${today}`, undefined, 'admin'), false);

/* ---------------- a 1v1's rated/ and elo/ ---------------- */
console.log('— the room —');
const mark = (seats) => ({ at: TS, ...seats });
expect('the rater marks a round rated', await call('PUT', 'rooms/DUEL1/rated/1', mark({ alice: { r: 1016, d: 16 }, bob: { r: 984, d: -16 } }), 'rater'), true);
expect('only once', await call('PUT', 'rooms/DUEL1/rated/1', mark({ alice: { r: 1032, d: 16 } }), 'rater'), false);
expect('…not even to delete it', await call('DELETE', 'rooms/DUEL1/rated/1', undefined, 'rater'), false);
expect('the rater marks a round unrated, with why', await call('PUT', 'rooms/DUEL1/rated/2', { at: TS, skip: 'unlinked' }, 'rater'), true);
expect('a reason is lower-case words', await call('PUT', 'rooms/DUEL1/rated/3', { at: TS, skip: 'Bad Reason!' }, 'rater'), false);
expect('a change of more than 40 is refused', await call('PUT', 'rooms/DUEL1/rated/3', mark({ alice: { r: 1041, d: 41 } }), 'rater'), false);
expect('a seat holds only r and d', await call('PUT', 'rooms/DUEL1/rated/3', mark({ alice: { r: 1016, d: 16, g: 'gina' } }), 'rater'), false);
expect('not in a room that is not a 1v1', await call('PUT', 'rooms/RACE1/rated/1', mark({ alice: { r: 1016, d: 16 } }), 'rater'), false);
expect('a player cannot mark a round', await call('PUT', 'rooms/DUEL1/rated/3', mark({ alice: { r: 1040, d: 40 } }), 'alice'), false);
expect('an anonymous account named tagda-rater cannot', await call('PUT', 'rooms/DUEL1/rated/3', mark({ alice: { r: 1040, d: 40 } }), 'fakeAnon'), false);
expect('the players read it', await call('GET', 'rooms/DUEL1/rated', undefined, 'bob'), true);
expect('somebody outside the room does not', await call('GET', 'rooms/DUEL1/rated', undefined, 'carol'), false);

expect('the rater sets a seat\'s rating for the card', await call('PUT', 'rooms/DUEL1/elo/alice', { r: 1016, n: 3 }, 'rater'), true);
expect('…and updates it', await call('PUT', 'rooms/DUEL1/elo/alice', { r: 1032, n: 4 }, 'rater'), true);
expect('a player cannot set their own', await call('PUT', 'rooms/DUEL1/elo/alice', { r: 3000, n: 4 }, 'alice'), false);
expect('nothing else under a seat', await call('PUT', 'rooms/DUEL1/elo/bob', { r: 984, n: 1, g: 'gail' }, 'rater'), false);
expect('not in a room that is not a 1v1', await call('PUT', 'rooms/RACE1/elo/alice', { r: 1016, n: 3 }, 'rater'), false);
expect('the opponent reads it', await call('GET', 'rooms/DUEL1/elo', undefined, 'bob'), true);
expect('somebody outside the room does not', await call('GET', 'rooms/DUEL1/elo', undefined, 'carol'), false);

/* ---------------- one round, all at once ---------------- */
console.log('— one round in one update —');
const before = await get('ratings');
const round3 = {
  'ratings/gina': rating(1032, 4, 4, 0, 0, before.gina.v + 1),
  'ratings/gail': rating(1000, 2, 1, 1, 0, before.gail.v + 1),
  [`ratingPair/${today}/gail_ginb`]: 1,
  'rooms/DUEL1/rated/3': mark({ alice: { r: 1032, d: 16 }, bob: { r: 1000, d: -16 } }),
  'rooms/DUEL1/elo/alice': { r: 1032, n: 4 },
  'rooms/DUEL1/elo/bob': { r: 1000, n: 2 },
};
expect('the rater writes a whole round in one root update', await call('PATCH', '', round3, 'rater'), true);
const mid = await get('ratings');
expect('sent again, it is refused (round 3 is already rated)', await call('PATCH', '', {
  ...round3, 'ratings/gina': rating(1048, 5, 5, 0, 0, mid.gina.v + 1), 'ratings/gail': rating(984, 3, 1, 2, 0, mid.gail.v + 1),
  [`ratingPair/${today}/gail_ginb`]: 2,
}, 'rater'), false);
const after = await get('ratings');
check('…and nothing in it was written: both ratings as they were', after.gina.v === mid.gina.v && after.gail.v === mid.gail.v && after.gina.r === 1032, after);
check('…and the pair count too', (await get(`ratingPair/${today}/gail_ginb`)) === 1, await get(`ratingPair/${today}/gail_ginb`));
expect('a pair over the cap sinks the whole update', await call('PATCH', '', {
  'ratings/gina': rating(1048, 5, 5, 0, 0, after.gina.v + 1), 'ratings/gail': rating(984, 3, 1, 2, 0, after.gail.v + 1),
  [pair]: 21, 'rooms/DUEL1/rated/4': mark({ alice: { r: 1048, d: 16 }, bob: { r: 984, d: -16 } }),
}, 'rater'), false);
check('…leaving round 4 unmarked', (await get('rooms/DUEL1/rated/4')) === null);

/* ---------------- phase 4: scores, taking a round back, the log ---------------- */
console.log('— scores in a marker —');
expect('the rater keeps each seat\'s score', await call('PUT', 'rooms/DUEL1/rated/20', mark({ alice: { r: 1016, d: 16, s: 1 }, bob: { r: 984, d: -16, s: 0 } }), 'rater'), true);
expect('a draw is 0.5', await call('PUT', 'rooms/DUEL1/rated/21', mark({ alice: { r: 1000, d: 0, s: 0.5 }, bob: { r: 1000, d: 0, s: 0.5 } }), 'rater'), true);
expect('a score is 0, 0.5 or 1 and nothing else', await call('PUT', 'rooms/DUEL1/rated/22', mark({ alice: { r: 1016, d: 16, s: 0.3 } }), 'rater'), false);

console.log('— taking a round back —');
await set('mods/mo', { at: Date.now(), by: 'boss', can: 'race' });
const back = (who) => ({ at: TS, by: who === 'admin' ? 'boss' : who });
expect('a player cannot mark a round taken back', await call('PUT', 'rooms/DUEL1/rated/20/reversed', back('alice'), 'alice'), false);
expect('the rater cannot', await call('PUT', 'rooms/DUEL1/rated/20/reversed', { at: TS, by: RATER_UID }, 'rater'), false);
expect('a race moderator cannot (ratings are an admin\'s)', await call('PUT', 'rooms/DUEL1/rated/20/reversed', back('mo'), 'mo'), false);
expect('not a round that was never rated', await call('PUT', 'rooms/DUEL1/rated/23/reversed', back('admin'), 'admin'), false);
expect('not a round marked unrated', await call('PUT', 'rooms/DUEL1/rated/2/reversed', back('admin'), 'admin'), false);
expect('the mark says who, in their own name', await call('PUT', 'rooms/DUEL1/rated/20/reversed', { at: TS, by: 'mo' }, 'admin'), false);
const g0 = await get('ratings/gina'), l0 = await get('ratings/gail');
const reversal = {
  'ratings/gina': { r: g0.r - 16, n: g0.n - 1, w: g0.w - 1, l: g0.l, d: g0.d, v: g0.v + 1, at: TS },
  'ratings/gail': { r: l0.r + 16, n: l0.n - 1, w: l0.w, l: l0.l - 1, d: l0.d, v: l0.v + 1, at: TS },
  'rooms/DUEL1/rated/20/reversed': back('admin'),
  'modLog/-rev1': { by: 'boss', at: TS, action: 'ratingReverse', path: 'rooms/DUEL1/rated/20', note: 'gina −16, gail +16', before: { undone: [] } },
};
expect('an admin takes a round back: ratings, mark and log in one update', await call('PATCH', '', reversal, 'admin'), true);
check('…both ratings moved back', (await get('ratings/gina')).r === g0.r - 16 && (await get('ratings/gail')).n === l0.n - 1);
expect('only once', await call('PUT', 'rooms/DUEL1/rated/20/reversed', back('admin'), 'admin'), false);
expect('…and the mark cannot be deleted', await call('DELETE', 'rooms/DUEL1/rated/20/reversed', undefined, 'admin'), false);
expect('a race moderator cannot write a rating either', await call('PUT', 'ratings/gina', rating(1000, 0, 0, 0, 0, (await get('ratings/gina')).v + 1), 'mo'), false);
const stale = await get('ratings/gina');
expect('a reversal on a stale version sinks whole, mark included', await call('PATCH', '', {
  'ratings/gina': rating(stale.r, stale.n, stale.w, stale.l, stale.d, stale.v),
  'rooms/DUEL1/rated/21/reversed': back('admin'),
}, 'admin'), false);
check('…leaving round 21 unmarked', (await get('rooms/DUEL1/rated/21/reversed')) === null);

console.log('— the log —');
const cur = await get('ratings/gina');
expect('a reset is logged as ratingReset', await call('PATCH', '', {
  'ratings/gina': rating(1000, 0, 0, 0, 0, cur.v + 1),
  'modLog/-reset1': { by: 'boss', at: TS, action: 'ratingReset', path: 'ratings/gina', uid: 'gina', before: { r: cur.r, n: cur.n } },
}, 'admin'), true);
expect('an action the log does not know is still refused', await call('PUT', 'modLog/-bad1', { by: 'boss', at: TS, action: 'ratingFiddle', path: 'x' }, 'admin'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
