/* The Worker's POST /rate (RATING-PLAN.md §7), end to end: wrangler dev
   running worker.js against the database and Auth emulators, the rater
   signing in with a custom token the way it does in production.

       WORKER=http://127.0.0.1:8787 RTDB=http://127.0.0.1:9000 NS=tagda-timer-default-rtdb \
         node tools/verify-rate.mjs

   WORKER, RTDB and NS must be what the Worker's .dev.vars point at
   (RTDB_URL, RTDB_NS); its AUTH_URL the Auth emulator, its
   FIREBASE_SERVICE_ACCOUNT any made-up key (the emulator does not check
   whose key signed a custom token), and CONFIG_TTL_MS small (500), so a
   setting changed here reaches it at once. tools/sotd-replay-dev.mjs
   starts all of that on the default ports.

   Loads firebase.rules.json into NS and wipes it: never point it at a
   namespace somebody is using. Seats are unsigned tokens, which the
   database emulator trusts (the Worker passes them on as ?auth=). */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayKey, PENALTY_WINDOW_MS } from '../js/elo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = (process.env.WORKER || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const DB = (process.env.RTDB || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const NS = process.env.NS || 'tagda-timer-default-rtdb';
const TTL = Number(process.env.CONFIG_TTL_MS || 500);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, provider = 'anonymous') {
  const s = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: uid, user_id: uid, aud: 'tagda-timer', iss: 'https://securetoken.google.com/tagda-timer',
    iat: s, exp: s + 3600, auth_time: s, firebase: { sign_in_provider: provider, identities: {} },
  })}.`;
}
const seats = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'erin', 'fred'].map(u => [u, token(u)]));

async function owner(method, path, body) {
  const r = await fetch(`${DB}/${path}.json?ns=${NS}`, {
    method, headers: { Authorization: 'Bearer owner' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const set = (path, v) => owner('PUT', path, v);
const get = (path) => owner('GET', path);

async function rate(who, body, method = 'POST') {
  const headers = { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${seats[who] || who}` } : {}) };
  const r = await fetch(`${WORKER}/rate`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json ?? text };
}

let failed = 0, passed = 0;
function check(name, cond, got) {
  if (cond) passed++; else failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got).slice(0, 200)})`}`);
}
const settle = () => new Promise(r => setTimeout(r, TTL + 300));

/* ---------------- setup ---------------- */
async function loadRules(text) {
  const r = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text });
  if (!r.ok) { console.error('could not load the rules:', r.status, await r.text()); process.exit(1); }
}
await loadRules(readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
await owner('DELETE', '');
await set('admins', { boss: true });

const now = Date.now();
const old = now - PENALTY_WINDOW_MS - 5000;
const result = (timeMs, extra = {}) => ({ timeMs, hash: 'h', submittedAt: old, ...extra });
const players = (...us) => Object.fromEntries(us.map(u => [u, { name: u, joinedAt: now, lastSeen: now }]));
async function room(id, { a = 'alice', b = 'bob', ga = 'gina', gb = 'gail', kind = 'duel', okB = true } = {}) {
  await set(`rooms/${id}`, {
    meta: { createdAt: now, event: '333', mode: 'wca', round: 1, phase: 'racing', ...(kind ? { kind } : {}) },
    players: players(a, b),
    acct: { [a]: { claim: ga, ok: true }, [b]: { claim: gb, ...(okB ? { ok: true } : {}) } },
  });
}
async function roundOf(id, n, ra, rb, { a = 'alice', b = 'bob', event = '333' } = {}) {
  await set(`rooms/${id}/rounds/${n}`, {
    info: { scramble: "R U R' U'", hash: 'h', event },
    results: { ...(ra ? { [a]: ra } : {}), ...(rb ? { [b]: rb } : {}) },
  });
}
await room('DUEL1');

/* ---------------- who may ask ---------------- */
console.log('— who may ask —');
let r = await rate(null, { room: 'DUEL1' });
check('no token: 401', r.status === 401, r);
r = await rate('carol', { room: 'DUEL1' });
// The database says no to a read with 401, as it does to a bad token, so /turn and /rate both answer 401 here.
check('somebody not in the room: refused, not-in-room', (r.status === 401 || r.status === 403) && r.body.error === 'not-in-room', r);
r = await rate('alice', { room: 'DUEL 1' });
check('a bad room: 400', r.status === 400 && r.body.error === 'bad-room', r);
r = await rate('alice', { room: 'DUEL1', round: 0 });
check('round 0: 400', r.status === 400 && r.body.error === 'bad-round', r);
r = await rate('alice', { room: 'DUEL1', round: '2' });
check('a round as text: 400', r.status === 400, r);
r = await rate('alice', null, 'GET');
check('GET: 405', r.status === 405, r);
await room('RACE1', { kind: null });
r = await rate('alice', { room: 'RACE1', round: 1 });
check('a race room that is not a 1v1: 403 not-a-1v1', r.status === 403 && r.body.error === 'not-a-1v1', r);

/* ---------------- the card at the start ---------------- */
console.log('— the card at the start —');
r = await rate('alice', { room: 'DUEL1' });
check('no round: both seats get their rating, 1000 when new', r.status === 200 && r.body.elo?.alice?.r === 1000 && r.body.elo?.bob?.n === 0, r);
check('…and it is in the room for the card', (await get('rooms/DUEL1/elo/bob'))?.r === 1000);

/* ---------------- a round ---------------- */
console.log('— a round —');
await roundOf('DUEL1', 1, { ...result(11200), submittedAt: Date.now() - 2000 }, result(11820));
r = await rate('alice', { room: 'DUEL1', round: 1 });
check('a penalty can still change: 202 with how long to wait', r.status === 202 && r.body.wait > 10_000 && r.body.wait <= 15_000, r);
check('…and nothing is written yet', (await get('rooms/DUEL1/rated/1')) === null && (await get('ratings/gina')) === null);

await roundOf('DUEL1', 2, result(11200), result(11820));
r = await rate('bob', { room: 'DUEL1', round: 2 });
check('a finished round: alice won, +20 and -20 (both new, K 40)', r.status === 200
  && r.body.seats?.alice?.r === 1020 && r.body.seats?.alice?.d === 20 && r.body.seats?.bob?.d === -20, r);
const gina1 = await get('ratings/gina');
check('the account behind the seat has it', gina1?.r === 1020 && gina1.n === 1 && gina1.w === 1 && gina1.v === 1 && typeof gina1.at === 'number', gina1);
check('the pair is counted for today', (await get(`ratingPair/${dayKey(Date.now())}/gail_gina`)) === 1);
check('the card shows it', (await get('rooms/DUEL1/elo/alice'))?.r === 1020 && (await get('rooms/DUEL1/elo/bob'))?.r === 980);
r = await rate('alice', { room: 'DUEL1', round: 2 });
check('asked again: the same answer, read back', r.status === 200 && r.body.seats?.alice?.d === 20, r);
check('…and nothing counted twice', (await get('ratings/gina')).v === 1 && (await get(`ratingPair/${dayKey(Date.now())}/gail_gina`)) === 1);

/* ---------------- both players at once ---------------- */
console.log('— both players at once —');
await roundOf('DUEL1', 3, result(12000, { penalty: 'DNF' }), result(15000));
const four = await Promise.all([rate('alice', { room: 'DUEL1', round: 3 }), rate('bob', { room: 'DUEL1', round: 3 }),
  rate('alice', { room: 'DUEL1', round: 3 }), rate('bob', { room: 'DUEL1', round: 3 })]);
check('four asks at once all get an answer', four.every(x => x.status === 200), four.map(x => x.status));
check('…the same one: alice\'s DNF lost', new Set(four.map(x => JSON.stringify(x.body.seats))).size === 1 && four[0].body.seats.alice.d < 0, four.map(x => x.body));
const gina2 = await get('ratings/gina');
check('…rated once: version 2, one loss', gina2.v === 2 && gina2.n === 2 && gina2.l === 1, gina2);
check('…and the pair counted once more', (await get(`ratingPair/${dayKey(Date.now())}/gail_gina`)) === 2);

/* ---------------- one account in two 1v1s at the same moment ---------------- */
console.log('— one account, two 1v1s —');
await room('DUEL2', { a: 'dave', b: 'erin', ga: 'gina', gb: 'gwen' });
await roundOf('DUEL1', 4, result(11000), result(12000));
await roundOf('DUEL2', 1, result(11000), result(12000), { a: 'dave', b: 'erin' });
const both = await Promise.all([rate('alice', { room: 'DUEL1', round: 4 }), rate('dave', { room: 'DUEL2', round: 1 })]);
check('both rounds are rated', both.every(x => x.status === 200 && x.body.seats), both);
const gina3 = await get('ratings/gina');
check('…one after the other: gina is 2 versions on, with both wins', gina3.v === 4 && gina3.n === 4 && gina3.w === 3, gina3);

/* ---------------- unrated, and why ---------------- */
console.log('— unrated, and why —');
await room('SOLO', { okB: false });
await roundOf('SOLO', 1, result(11000), result(12000));
r = await rate('alice', { room: 'SOLO', round: 1 });
check('an unlinked opponent: unrated (unlinked), at once', r.status === 200 && r.body.skip === 'unlinked', r);
check('…and marked in the room', (await get('rooms/SOLO/rated/1'))?.skip === 'unlinked');
await room('SAME', { gb: 'gina' });
await roundOf('SAME', 1, result(11000), result(12000));
r = await rate('bob', { room: 'SAME', round: 1 });
check('one account on both seats: same-account', r.body.skip === 'same-account', r);
await roundOf('DUEL1', 5, result(11000), result(12000));
await set('rooms/DUEL1/mod/struck/5/bob', { at: now, by: 'boss' });
r = await rate('alice', { room: 'DUEL1', round: 5 });
check('a struck time: struck', r.body.skip === 'struck', r);
await roundOf('DUEL1', 6, result(41000), result(42000), { event: '444' });
r = await rate('alice', { room: 'DUEL1', round: 6 });
check('not 3x3: event', r.body.skip === 'event', r);
await roundOf('DUEL1', 7, result(2500), result(12000));
r = await rate('alice', { room: 'DUEL1', round: 7 });
check('a time under 3 s: floor', r.body.skip === 'floor', r);
await roundOf('DUEL1', 8, result(11000), null);
r = await rate('alice', { room: 'DUEL1', round: 8 });
check('only one time in: 409 not-finished, nothing marked', r.status === 409 && r.body.error === 'not-finished' && (await get('rooms/DUEL1/rated/8')) === null, r);
r = await rate('alice', { room: 'DUEL1', round: 99 });
check('a round that never was: 404', r.status === 404, r);
check('none of those touched a rating', (await get('ratings/gina')).v === 4);

/* ---------------- the switches ---------------- */
console.log('— the switches —');
await set('config/duel/ratedPairCap', 3);
await settle();
await roundOf('DUEL1', 9, result(11000), result(12000));
r = await rate('alice', { room: 'DUEL1', round: 9 });
check('duel.ratedPairCap 3 (the pair has 3 today): cap', r.body.skip === 'cap', r);
await set('config/duel/ratedPairCap', null);
await set('config/duel/rated', false);
await settle();
await roundOf('DUEL1', 10, result(11000), result(12000));
r = await rate('alice', { room: 'DUEL1', round: 10 });
check('duel.rated off: 403 off, and nothing marked', r.status === 403 && r.body.error === 'off' && (await get('rooms/DUEL1/rated/10')) === null, r);
await set('config/duel/rated', null);
await settle();
r = await rate('alice', { room: 'DUEL1', round: 10 });
check('back on: rated', r.status === 200 && r.body.seats, r);

/* ---------------- rules from before ratings ---------------- */
console.log('— rules from before ratings —');
const before = execFileSync('git', ['show', 'origin/main:firebase.rules.json'], { cwd: ROOT, encoding: 'utf8' });
if (before.includes('tagda-rater')) {
  console.log('skip  origin/main already has the rater (phase 1 merged): nothing to compare against');
} else {
  await loadRules(before);
  await roundOf('DUEL1', 11, result(11000), result(12000));
  r = await rate('alice', { room: 'DUEL1', round: 11 });
  check('the rater refused: 503 rules, nothing written', r.status === 503 && r.body.error === 'rules' && (await get('rooms/DUEL1/rated/11')) === null, r);
  await loadRules(readFileSync(join(ROOT, 'firebase.rules.json'), 'utf8'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
