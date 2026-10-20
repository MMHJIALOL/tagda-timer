import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  START, MIN, MAX, MAX_STEP, K_NEW, K_SETTLED, PROVISIONAL, PENALTY_WINDOW_MS, FINAL_SLACK_MS,
  kFor, expected, effective, score, step, pairKey, dayKey, judgeRound, roundUpdate, ratedView,
} from './elo.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const res = (timeMs, penalty, submittedAt = NOW - 60_000) => ({ timeMs, hash: 'h', submittedAt, ...(penalty ? { penalty } : {}) });
const linked = { alice: { claim: 'gina', ok: true }, bob: { claim: 'gail', ok: true } };
const round = (a, b, extra = {}) => judgeRound({ event: '333', results: { alice: a, bob: b }, acct: linked, struck: null, now: NOW, ...extra });

test('the formula: equal ratings move by half of K, and both sides mirror', () => {
  assert.equal(expected(1000, 1000), 0.5);
  assert.deepEqual(step(1000, 0, 1000, 1), { r: 1020, d: 20 });
  assert.deepEqual(step(1000, 0, 1000, 0), { r: 980, d: -20 });
  assert.deepEqual(step(1000, 0, 1000, 0.5), { r: 1000, d: 0 });
  assert.deepEqual(step(1000, PROVISIONAL, 1000, 1), { r: 1010, d: 10 });
  // The favourite gains little for winning and loses a lot for losing.
  assert.deepEqual(step(1200, 50, 1000, 1), { r: 1205, d: 5 });
  assert.deepEqual(step(1200, 50, 1000, 0), { r: 1185, d: -15 });
});

test('K is 40 for the first 20 rated rounds, then 20', () => {
  assert.equal(kFor(0), K_NEW);
  assert.equal(kFor(PROVISIONAL - 1), K_NEW);
  assert.equal(kFor(PROVISIONAL), K_SETTLED);
  assert.equal(K_NEW, 40);
  assert.equal(K_SETTLED, 20);
});

test('no change ever passes what the rules allow', () => {
  for (const [r, opp] of [[100, 4000], [4000, 100], [1000, 3000], [3000, 1000]]) {
    for (const s of [0, 0.5, 1]) {
      const st = step(r, 0, opp, s);
      assert.ok(Math.abs(st.d) <= MAX_STEP, `${r} v ${opp} s=${s}: ${st.d}`);
      assert.ok(st.r >= MIN && st.r <= MAX);
      assert.ok(!Object.is(st.d, -0));
    }
  }
  assert.deepEqual(step(100, 0, 100, 0), { r: 100, d: 0 });   // the floor holds
  assert.deepEqual(step(4000, 0, 4000, 1), { r: 4000, d: 0 }); // so does the ceiling
});

test('a result as a number: +2 adds two seconds, DNF loses to anything', () => {
  assert.equal(effective(res(11200)), 11200);
  assert.equal(effective(res(11200, 'none')), 11200);
  assert.equal(effective(res(11200, '+2')), 13200);
  assert.equal(effective(res(11200, 'DNF')), Infinity);
  assert.equal(effective({ hash: 'h' }), null);
  assert.equal(effective(null), null);
  assert.equal(score(11200, 11820), 1);
  assert.equal(score(11820, 11200), 0);
  assert.equal(score(11200, 11200), 0.5);
  assert.equal(score(Infinity, Infinity), 0.5);
  assert.equal(score(Infinity, 59_000), 0);
});

test('a finished round between two linked accounts is rated, seats in uid order', () => {
  assert.deepEqual(round(res(11200), res(11820)), { rate: { seats: ['alice', 'bob'], accounts: ['gina', 'gail'], s: 1 } });
  assert.deepEqual(round(res(11200, '+2'), res(11820)).rate.s, 0);
  assert.deepEqual(round(res(11200, 'DNF'), res(11820, 'DNF')).rate.s, 0.5);
  const flipped = judgeRound({ event: '333', results: { bob: res(11820), alice: res(11200) }, acct: linked, now: NOW });
  assert.deepEqual(flipped.rate.seats, ['alice', 'bob']);
});

test('it waits until no penalty can improve any more', () => {
  const just = NOW - 1000;
  const v = round(res(11200, null, just), res(11820));
  assert.deepEqual(v, { wait: PENALTY_WINDOW_MS + FINAL_SLACK_MS - 1000 });
  assert.ok(round(res(11200, null, NOW - PENALTY_WINDOW_MS - FINAL_SLACK_MS), res(11820)).rate);
  // No submittedAt: the rules could not let it improve either.
  assert.ok(round({ timeMs: 11200, hash: 'h' }, res(11820)).rate);
});

test('what is never rated, and why', () => {
  assert.deepEqual(round(res(11200), undefined), { none: 'not-finished' });
  assert.deepEqual(judgeRound({ event: '333', results: { alice: res(1), bob: res(2), carol: res(3) }, acct: linked, now: NOW }), { none: 'not-a-1v1' });
  assert.deepEqual(round(res(11200), res(11820), { event: '444' }), { skip: 'event' });
  assert.deepEqual(round(res(11200), res(11820), { event: undefined }), { skip: 'event' });
  assert.deepEqual(round(res(11200), res(11820), { struck: { bob: { at: 1, by: 'boss' } } }), { skip: 'struck' });
  assert.deepEqual(round(res(11200), res(11820), { acct: { alice: linked.alice } }), { skip: 'unlinked' });
  assert.deepEqual(round(res(11200), res(11820), { acct: { alice: linked.alice, bob: { claim: 'gail' } } }), { skip: 'unlinked' });
  assert.deepEqual(round(res(11200), res(11820), { acct: null }), { skip: 'unlinked' });
  assert.deepEqual(round(res(11200), res(11820), { acct: { alice: linked.alice, bob: { claim: 'gina', ok: true } } }), { skip: 'same-account' });
  assert.deepEqual(round(res(2900), res(11820)), { skip: 'floor' });
  assert.ok(round(res(1500, '+2'), res(11820)).rate, 'a +2 that lifts it over the floor counts');
  assert.deepEqual(round({ timeMs: 'x', hash: 'h', submittedAt: 0 }, res(11820)), { skip: 'bad-result' });
  // Unlinked is decided before the wait: nothing about it can change.
  assert.deepEqual(round(res(11200, null, NOW), res(11820), { acct: null }), { skip: 'unlinked' });
});

test('the update: both ratings, the pair, the marker and the card, in one go', () => {
  const ts = { '.sv': 'timestamp' };
  const { patch, seats } = roundUpdate({
    room: 'ABC', round: 7, seats: ['alice', 'bob'], accounts: ['gina', 'gail'], s: 1,
    ratings: [null, { r: 1100, n: 30, w: 20, l: 9, d: 1, v: 30, at: 5 }], pairCount: 3, day: '1760898600000', ts,
  });
  // gina is new (K 40) and beat a 1100 (expected 0.36): +26. gail is settled (K 20): -13.
  assert.deepEqual(seats, { alice: { r: 1026, d: 26 }, bob: { r: 1087, d: -13 } });
  assert.deepEqual(patch['ratings/gina'], { r: 1026, n: 1, w: 1, l: 0, d: 0, v: 1, at: ts });
  assert.deepEqual(patch['ratings/gail'], { r: 1087, n: 31, w: 20, l: 10, d: 1, v: 31, at: ts });
  assert.equal(patch['ratingPair/1760898600000/gail_gina'], 4);
  assert.deepEqual(patch['rooms/ABC/rated/7'], { at: ts, alice: { r: 1026, d: 26 }, bob: { r: 1087, d: -13 } });
  assert.deepEqual(patch['rooms/ABC/elo/alice'], { r: 1026, n: 1 });
  assert.deepEqual(patch['rooms/ABC/elo/bob'], { r: 1087, n: 31 });
  assert.equal(Object.keys(patch).length, 6);
  const draw = roundUpdate({ room: 'ABC', round: 8, seats: ['alice', 'bob'], accounts: ['gina', 'gail'], s: 0.5, ratings: [null, null], pairCount: 0, day: 'd', ts });
  assert.deepEqual(draw.patch['ratings/gina'], { r: START, n: 1, w: 0, l: 0, d: 1, v: 1, at: ts });
  // Junk where a rating should be is a new rating, not a crash.
  const junk = roundUpdate({ room: 'ABC', round: 9, seats: ['alice', 'bob'], accounts: ['gina', 'gail'], s: 0, ratings: [{ r: 'x' }, 5], pairCount: undefined, day: 'd', ts });
  assert.equal(junk.patch['ratings/gina'].v, 1);
  assert.equal(junk.patch['ratingPair/d/gail_gina'], 1);
});

test('keys: the same pair either way round, and today as the rules write it', () => {
  assert.equal(pairKey('gina', 'gail'), 'gail_gina');
  assert.equal(pairKey('gail', 'gina'), 'gail_gina');
  // 2026-10-20 12:00 UTC is 17:30 IST; the IST day began 2026-10-19 18:30 UTC.
  assert.equal(dayKey(NOW), String(Date.UTC(2026, 9, 19, 18, 30)));
  assert.equal(dayKey(Date.UTC(2026, 9, 19, 18, 29, 59)), String(Date.UTC(2026, 9, 18, 18, 30)));
});

test('a stored marker as the Worker answers it', () => {
  assert.deepEqual(ratedView({ at: 5, skip: 'unlinked' }), { at: 5, skip: 'unlinked' });
  assert.deepEqual(ratedView({ at: 5, alice: { r: 1020, d: 20 }, bob: { r: 980, d: -20 } }), { at: 5, seats: { alice: { r: 1020, d: 20 }, bob: { r: 980, d: -20 } } });
  assert.equal(ratedView(null), null);
});
