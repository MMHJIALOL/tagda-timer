import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuery, parseTime, searchSolves } from './solve-search.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 10, 20, 15);
let next = 0;
const solve = (timeMs, createdAt, extra = {}) =>
  ({ id: `s${++next}`, timeMs, penalty: 'none', createdAt, scramble: "R U R' U' F2 D", ...extra });

const solves = [
  solve(12240, at(2025, 10, 20)),
  solve(12249, at(2026, 9, 1), { comment: 'Lucky PLL skip' }),
  solve(12250, at(2026, 10, 19)),
  solve(9870, at(2026, 10, 19), { scramble: "R U2 R' D B2" }),
  solve(10240, at(2026, 10, 20), { penalty: '+2' }),
  solve(12240, at(2026, 10, 20), { penalty: 'DNF' }),
  solve(65430, at(2026, 10, 20), { caseName: 'T perm' }),
  solve(600000, at(2026, 10, 20), { fmcMoves: 28 }),
];
const ids = (q, opts = {}) => searchSolves(solves, q, { now: NOW, dayFirst: true, ...opts }).matches.map(m => m.solve.id);
const reads = (q, dayFirst = true) => parseQuery(q, { now: NOW, dayFirst }).map(x => `${x.kind}:${x.label}`);

test('a time finds every solve that prints as it', () => {
  // 12.249 prints as 12.24; the +2 solve prints as 12.24 and is found by what it shows.
  assert.deepEqual(ids('12.24'), ['s5', 's2', 's1']);
  assert.deepEqual(ids('12.2'), ['s5', 's3', 's2', 's1']);
  assert.deepEqual(ids('12.240'), ['s5', 's1']);
  assert.deepEqual(ids('1:05'), ['s7']);
  assert.deepEqual(ids('1:05.43'), ['s7']);
  // A DNF has no time to match, and a move count is matched as moves.
  assert.ok(!ids('12').includes('s6'));
  assert.deepEqual(ids('28'), ['s8']);
  assert.deepEqual(parseTime('1:05.6'), { lo: 65600, step: 100, num: null, text: '1:05.6' });
});

test('ranges and comparisons use the printed time, both ends included', () => {
  assert.deepEqual(ids('12-12.24'), ['s5', 's2', 's1']);
  assert.deepEqual(ids('12.24 to 12.25'), ['s5', 's3', 's2', 's1']);
  assert.deepEqual(ids('sub 10'), ['s4']);
  assert.deepEqual(ids('<10'), ['s4']);
  assert.deepEqual(ids('sub10'), ['s4']);
  assert.deepEqual(ids('>= 1:00'), ['s7']);
  assert.deepEqual(ids('<= 12.24'), ['s5', 's4', 's2', 's1']);
  assert.ok(!ids('>20').includes('s6'), 'a DNF is not "over 20"');
  assert.ok(ids('< 30').includes('s8'), 'moves compare as moves');
});

test('penalties and solve numbers', () => {
  assert.deepEqual(ids('dnf'), ['s6']);
  assert.deepEqual(ids('+2'), ['s5']);
  assert.equal(ids('ok').length, 6);
  assert.equal(ids('no penalty').length, 6);
  assert.deepEqual(ids('#2'), ['s2']);
  assert.deepEqual(ids('#3-5'), ['s5', 's4', 's3']);
  assert.deepEqual(ids('#5-#3'), ['s5', 's4', 's3']);
});

test('dates, written every way people write them', () => {
  const oct20 = ['s8', 's7', 's6', 's5'];
  for (const q of ['today', '2026-10-20', '20/10/2026', '20/10/26', '20-10-2026', '20.10.2026', '20 oct 2026', 'oct 20 2026', '20th October, 2026']) {
    assert.deepEqual(ids(q), oct20, q);
  }
  assert.deepEqual(ids('10/20/2026', { dayFirst: false }), oct20);
  // 20 cannot be a month, so either order reads it.
  assert.deepEqual(ids('10/20/2026'), oct20);
  assert.deepEqual(ids('yesterday'), ['s4', 's3']);
  assert.deepEqual(ids('hoy'), oct20);
  assert.deepEqual(ids('ontem'), ['s4', 's3']);
  // No year: that day in any year.
  assert.deepEqual(ids('20 oct'), [...oct20, 's1']);
  assert.deepEqual(ids('oct'), ['s8', 's7', 's6', 's5', 's4', 's3', 's1']);
  assert.deepEqual(ids('oct 2026'), ['s8', 's7', 's6', 's5', 's4', 's3']);
  assert.deepEqual(ids('2026-09'), ['s2']);
  assert.deepEqual(ids('2025'), ['s1']);
  // 20 Oct and 1 Sep 2026 were both Tuesdays.
  assert.deepEqual(ids('tuesday'), [...oct20, 's2']);
  assert.deepEqual(ids('tue'), [...oct20, 's2']);
});

test('terms combine, and words search scrambles, comments and cases', () => {
  assert.deepEqual(ids('12.24 2026'), ['s5', 's2']);
  assert.deepEqual(ids('sub 13 today'), ['s5']);
  assert.deepEqual(ids("R U R'"), ['s8', 's7', 's6', 's5', 's3', 's2', 's1']);
  // Whole moves only: R U is not the start of R U2.
  assert.ok(!ids('R U').includes('s4'));
  assert.deepEqual(ids("U2 R'"), ['s4']);
  assert.deepEqual(ids('lucky'), ['s2']);
  assert.deepEqual(ids('"pll skip"'), ['s2']);
  assert.deepEqual(ids('t perm'), ['s7']);
  assert.deepEqual(ids('3x3', { extraText: s => (s.fmcMoves ? '' : '3x3 3x3x3') }).length, 7);
  assert.deepEqual(ids('nothing like this'), []);
  assert.deepEqual(searchSolves(solves, '   ').terms, []);
});

test('says how it read the query', () => {
  assert.deepEqual(reads('12.24'), ['value:time 12.24']);
  assert.deepEqual(reads('dnf 20 oct'), ['penalty:DNF', 'date:Oct 20']);
  assert.deepEqual(reads('sub 10'), ['compare:under 10']);
  assert.deepEqual(reads('12 - 13'), ['range:time 12 to 13']);
  // Not a day of the month, so a time and a month.
  assert.deepEqual(reads('32 oct'), ['value:time 32', 'date:October']);
  assert.deepEqual(reads('oct 12.5'), ['date:October', 'value:time 12.5']);
  assert.deepEqual(reads('#7'), ['number:solve #7']);
  assert.deepEqual(reads("R U R'"), ["text:“R U R'”"]);
  assert.deepEqual(reads('sub'), ['text:“sub”']);
});
