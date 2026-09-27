/* The Scramble of the Day misfire thresholds, in Node.
       node tools/verify-misfire.mjs
   See misfireAction in js/dayid.js. */
import assert from 'node:assert/strict';
import { misfireAction, AUTO_DISCARD_MS, ASK_MS } from '../js/dayid.js';

assert.equal(AUTO_DISCARD_MS, 2000);
assert.equal(ASK_MS, 5000);

assert.equal(misfireAction(0), 'discard');
assert.equal(misfireAction(1999), 'discard');
assert.equal(misfireAction(2000), 'ask');
assert.equal(misfireAction(4999), 'ask');
assert.equal(misfireAction(5000), 'keep');

/* The penalty is not part of the time judged. A 1.5 s misfire with a +2 is
   3.5 s on the board, but the timer hands over the raw 1500 and that is
   what gets judged, so it is still thrown away. */
const plusTwo = { timeMs: 1500, penalty: '+2' };
assert.equal(misfireAction(plusTwo.timeMs), 'discard');

console.log('PASS misfire thresholds: <2 s discard, 2-4.99 s ask, >=5 s keep, penalty ignored');
