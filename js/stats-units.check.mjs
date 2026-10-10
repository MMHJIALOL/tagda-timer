import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultsFor, summarize, rollingSeries, statWindow, trimmedIndices } from './stats.js';

const times = [10000, 12000, 14000, 16000, 18000].map(timeMs => ({ timeMs, penalty: 'none' }));
const moves = [24, 25, 26, 27, 28].map(fmcMoves => ({ timeMs: 600000, fmcMoves, penalty: 'none' }));

test('mixed sessions retain both histories while summaries use one unit', () => {
  const mixed = [...times, ...moves];
  assert.equal(summarize(resultsFor(mixed, false)).mean, 14000);
  assert.equal(summarize(resultsFor(mixed, true)).mean, 26);
  assert.equal(mixed.length, 10);
  assert.equal(summarize(resultsFor(times, true)).mean, null);
});

test('rolling and detail windows never combine milliseconds with moves', () => {
  const mixed = [...times, ...moves];
  assert.deepEqual(rollingSeries(mixed, 3), [null, null, 12000, 14000, 16000, null, null, 25, 26, 27]);
  assert.equal(statWindow(mixed, 'ao3@5').value, null);
  assert.equal(statWindow(mixed, 'ao3@7').value, 25);
  assert.equal(trimmedIndices(mixed.slice(0, 7), 5).best.size, 0);
});
