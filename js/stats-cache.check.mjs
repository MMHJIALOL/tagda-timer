import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as stats from './stats.js';

// summarize, bestAvg and rollingSeries keep their last answer and only score
// what was appended. Every figure must still be exactly what a fresh
// recompute gives, so these are the old, uncached versions to compare with.
const { eff, DNF, averageOfRange, consistencyOf, isMoveResult } = stats;

function meanOfRange(e, from, to) {
  if (to <= from) return null;
  let sum = 0;
  for (let i = from; i < to; i++) { if (e[i] === DNF) return DNF; sum += e[i]; }
  return sum / (to - from);
}

function refBestAvg(solves, n) {
  if (solves.length < n) return { value: null, at: -1 };
  const e = solves.map(eff);
  let best = null, at = -1;
  for (let i = 0; i + n <= solves.length; i++) {
    const a = averageOfRange(e, i, i + n);
    if (a === null || a === DNF) continue;
    if (best === null || a < best) { best = a; at = i; }
  }
  return { value: best, at };
}

function refSummarize(solves) {
  const n = solves.length, e = new Array(n), valid = [];
  let best = null, worst = null, sum = 0, dnfCount = 0, plus2Count = 0;
  for (let i = 0; i < n; i++) {
    const s = solves[i], v = eff(s);
    e[i] = v;
    if (s.penalty === 'DNF') dnfCount++; else if (s.penalty === '+2') plus2Count++;
    if (v === DNF) continue;
    valid.push(v); sum += v;
    if (best === null || v < best) best = v;
    if (worst === null || v > worst) worst = v;
  }
  const mean = valid.length ? sum / valid.length : null;
  let sd = null;
  if (valid.length >= 2) { let acc = 0; for (const v of valid) acc += (v - mean) ** 2; sd = Math.sqrt(acc / valid.length); }
  let med = null;
  if (valid.length) { valid.sort((a, b) => a - b); const m = valid.length >> 1; med = valid.length % 2 ? valid[m] : (valid[m - 1] + valid[m]) / 2; }
  const ao = (k) => (n < k ? null : averageOfRange(e, n - k, n));
  return { count: n, valid: valid.length, dnfCount, plus2Count, best, worst, mean, median: med, stdev: sd,
    consistency: consistencyOf(sd, mean), ao5: ao(5), ao12: ao(12), ao50: ao(50), ao100: ao(100),
    mo3: n < 3 ? null : meanOfRange(e, n - 3, n),
    bestAo5: refBestAvg(solves, 5).value, bestAo12: refBestAvg(solves, 12).value };
}

function refRolling(solves, n) {
  const e = solves.map(eff), out = new Array(solves.length);
  let sameUnitFrom = 0;
  for (let i = 0; i < solves.length; i++) {
    if (i && isMoveResult(solves[i]) !== isMoveResult(solves[i - 1])) sameUnitFrom = i;
    if (i + 1 - sameUnitFrom < n) { out[i] = null; continue; }
    const a = averageOfRange(e, i + 1 - n, i + 1);
    out[i] = (a === null || a === DNF) ? null : a;
  }
  return out;
}

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const PEN = () => { const r = rand(); return r < 0.06 ? 'DNF' : r < 0.14 ? '+2' : 'none'; };
const solve = (fmc) => fmc
  ? { timeMs: 3600000, penalty: rand() < 0.1 ? 'DNF' : 'none', fmcMoves: 20 + Math.floor(rand() * 30) }
  : { timeMs: 6000 + Math.floor(rand() * 9000), penalty: PEN() };

function same(list, what) {
  assert.deepStrictEqual(stats.summarize(list), refSummarize(list), `summarize after ${what}`);
  for (const n of [5, 12, 25, 100]) assert.deepStrictEqual(stats.bestAvg(list, n), refBestAvg(list, n), `bestAvg ${n} after ${what}`);
  for (const n of [5, 12, 50]) assert.deepStrictEqual(stats.rollingSeries(list, n), refRolling(list, n), `rollingSeries ${n} after ${what}`);
  for (const n of [3, 5, 12]) {
    const e = list.map(eff);
    assert.equal(stats.currentAvg(list, n), list.length < n ? null : averageOfRange(e, list.length - n, list.length), `currentAvg ${n}`);
    assert.equal(stats.currentMean(list, n), list.length < n ? null : meanOfRange(e, list.length - n, list.length), `currentMean ${n}`);
  }
}

test('cached statistics match a fresh recompute after appends, edits and deletes', () => {
  for (let round = 0; round < 6; round++) {
    const list = [];
    const fmcFrom = round % 2 ? 60 + Math.floor(rand() * 60) : Infinity;   // some sessions switch to Fewest Moves part way
    for (let step = 0; step < 260; step++) {
      const r = rand();
      if (r < 0.75 || list.length < 3) {
        list.push(solve(list.length >= fmcFrom));
        same(list, `append #${list.length}`);
      } else if (r < 0.85) {
        const i = Math.floor(rand() * list.length);
        list[i] = { ...list[i], penalty: list[i].penalty === 'DNF' ? 'none' : 'DNF' };
        same(list, `penalty edit at ${i}`);
      } else if (r < 0.9 && list.some(isMoveResult)) {
        const i = list.findIndex(isMoveResult);
        list[i] = { ...list[i], fmcMoves: list[i].fmcMoves + 1 };
        same(list, `move count edit at ${i}`);
      } else if (r < 0.97) {
        list.splice(Math.floor(rand() * list.length), 1);
        same(list, 'delete');
      } else {
        const other = Array.from({ length: 40 }, () => solve(false));
        same(other, 'a different list');
        same(list, 'back to the session');
      }
    }
  }
});

test('the history columns are copies, not the cache', () => {
  const list = Array.from({ length: 30 }, () => solve(false));
  const a = stats.rollingSeries(list, 5);
  a[10] = 'scribbled';
  assert.deepStrictEqual(stats.rollingSeries(list, 5), refRolling(list, 5));
  const s = stats.summarize(list);
  s.mean = -1;
  assert.deepStrictEqual(stats.summarize(list), refSummarize(list));
});
