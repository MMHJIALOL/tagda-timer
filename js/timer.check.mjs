import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Timer } from './timer.js';

function clock(t) {
  let now = 0, next = 0;
  const frames = new Map();
  t.mock.method(performance, 'now', () => now);
  const originals = ['requestAnimationFrame', 'cancelAnimationFrame'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    at(value) { now = value; },
    frame(stamp, deliveredAt = stamp) {
      now = deliveredAt;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(stamp);
    },
    get pending() { return frames.size; },
  };
}

test('a delayed animation callback cannot advance the display past the stopping press', t => {
  const time = clock(t);
  const timer = new Timer({ inspection: false });
  const ticks = [];
  let result;
  timer.addEventListener('tick', event => ticks.push(event.detail.elapsed));
  timer.addEventListener('stop', event => { result = event.detail; });
  timer.down(1000); timer.up(1000);
  // The frame started at 11.74, but earlier rendering work took 40ms.
  // Space landed at 11.75 while that work was blocking input delivery.
  time.frame(12740, 12780);
  timer.down(12750);
  assert.equal(ticks.at(-1), 11740);
  assert.equal(result.timeMs, 11750);
  assert.ok(ticks.every(value => value <= result.timeMs), 'live digits must not jump backwards at stop');
  assert.equal(time.pending, 0, 'stop cancels the next display update');
  time.frame(12800);
  assert.equal(ticks.length, 1);
});

test('a frame begun before the starting release displays zero', t => {
  const time = clock(t);
  const timer = new Timer({ inspection: false });
  let elapsed;
  timer.addEventListener('tick', event => { elapsed = event.detail.elapsed; });
  timer.down(1000); timer.up(1000);
  time.frame(990, 1020);
  assert.equal(elapsed, 0);
  timer.reset();
});

test('split and final measurements still use input timestamps', t => {
  const time = clock(t);
  const timer = new Timer({ inspection: false, phaseSplits: 1 });
  let split, result;
  timer.addEventListener('split', event => { split = event.detail; });
  timer.addEventListener('stop', event => { result = event.detail; });
  timer.down(1000); timer.up(1000);
  time.frame(1600, 1680);
  timer.down(1650);
  time.frame(2200, 2280);
  timer.down(2250);
  assert.equal(split.atMs, 650);
  assert.equal(result.timeMs, 1250);
  assert.deepEqual(result.splits, [650]);
  timer.up(2300);
  assert.equal(timer.state, 'idle');
  assert.equal(time.pending, 0);
});

test('inspection penalties use the release time even when its display frame is old', t => {
  const time = clock(t);
  const timer = new Timer({ inspection: true });
  time.at(1000);
  timer.down(1000); timer.up(1000);
  time.frame(15990, 16010);
  timer.down(16010); timer.up(16010);
  assert.equal(timer.pendingPenalty, '+2');
  timer.reset();
});

test('clock fallback and external timer overrides remain exact', t => {
  const time = clock(t);
  const timer = new Timer({ inspection: false });
  const results = [];
  timer.addEventListener('stop', event => results.push(event.detail.timeMs));
  time.at(1000); timer.start();
  time.frame(2000, 2080);
  time.at(2250); timer.stop();
  time.at(3000); timer.start();
  time.at(5000); timer.stop(1234);
  assert.deepEqual(results, [1250, 1234]);
  assert.equal(timer.state, 'idle');
  assert.equal(time.pending, 0);
});
