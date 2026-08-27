/* ===========================================================
   Tagda Timer — WCA-correct statistics
   A solve is { timeMs, penalty: 'none'|'+2'|'DNF' }.
   Effective time: DNF -> Infinity, +2 -> timeMs + 2000.
   =========================================================== */

export const DNF = Infinity;

/** Effective (penalty-applied) time in ms. Infinity means DNF. */
export function eff(solve) {
  if (!solve) return DNF;
  if (solve.penalty === 'DNF') return DNF;
  return solve.timeMs + (solve.penalty === '+2' ? 2000 : 0);
}

/** WCA trim count: 1 for ao5–ao12, 5% of n above that. */
export function trimCount(n) {
  return n < 5 ? 0 : Math.max(1, Math.ceil(n * 0.05));
}

/* Scratch buffers, one per window length, reused by every windowed average.
   averageOf() used to allocate two arrays and run three extra passes per call,
   and it is called once per solve by rollingSeries and once per window by
   bestAvg — so on a long session that was tens of thousands of throwaway
   arrays per render. Only a handful of lengths are ever asked for (5, 12, 50,
   100), and a buffer sized exactly to n can be sorted in place with the
   built-in sort, so there is nothing left to allocate. Nothing here is
   re-entrant, so sharing them is safe. */
const _bufs = new Map();
const scratch = (n) => {
  let b = _bufs.get(n);
  if (!b) { b = new Array(n); _bufs.set(n, b); }
  return b;
};

/**
 * WCA average over effective times `e[from .. to)`.
 * Trims `trimCount(len)` from each end. DNFs sort to the top; if there are
 * more DNFs than the trim count the average itself is a DNF.
 */
export function averageOfRange(e, from, to) {
  const n = to - from;
  if (n < 3) return null;
  const t = n >= 5 ? trimCount(n) : 0;

  const win = scratch(n);
  let dnfs = 0;
  for (let i = 0; i < n; i++) {
    const v = e[from + i];
    if (v === DNF) dnfs++;
    win[i] = v;
  }
  if (dnfs > t) return DNF;

  win.sort((a, b) => a - b);

  const hi = n - t;
  let sum = 0;
  for (let i = t; i < hi; i++) {
    if (win[i] === DNF) return DNF;
    sum += win[i];
  }
  return sum / (hi - t);
}

/** WCA average of the given effective times. */
export function averageOf(effTimes) {
  return averageOfRange(effTimes, 0, effTimes.length);
}

/** Mean (no trim). Any DNF makes it a DNF. */
export function meanOf(effTimes) {
  if (!effTimes.length) return null;
  if (effTimes.some(x => x === DNF)) return DNF;
  return effTimes.reduce((a, b) => a + b, 0) / effTimes.length;
}

/** Current aoN over the most recent N solves (solves given oldest-first). */
export function currentAvg(solves, n) {
  if (solves.length < n) return null;
  return averageOfRange(solves.map(eff), solves.length - n, solves.length);
}

/** Current moN (mean of N). */
export function currentMean(solves, n) {
  if (solves.length < n) return null;
  return meanOfRange(solves.map(eff), solves.length - n, solves.length);
}

/** Mean of `e[from .. to)`. Any DNF makes it a DNF. */
function meanOfRange(e, from, to) {
  if (to <= from) return null;
  let sum = 0;
  for (let i = from; i < to; i++) {
    if (e[i] === DNF) return DNF;
    sum += e[i];
  }
  return sum / (to - from);
}

/* bestAvg is O(solves x n) — for ao100 on a five-thousand-solve session that
   is half a million element comparisons, and the stats panel asks for it again
   on every single solve. But finishing a solve does not change any of the
   windows that were already there: it only adds the ones ending on the new
   solve. So remember the last answer and, when the list turns out to be that
   same list with a few solves appended, score only the new windows against it.

   The check has to be honest about *which* list, because a penalty toggled on
   solve #12 changes an old window without changing the length. So the cache
   holds a hash over every solve's time and penalty, and the incremental path
   is taken only when the new list's first `len` entries hash to exactly what
   was cached. Anything else — an edit, a deletion, a different session — falls
   through to the full scan. */
const _bestAvg = new Map();   // n -> { len, hash, value, at }

const hashStep = (h, s) =>
  (Math.imul(Math.imul(h, 31) + (s.timeMs | 0), 31) +
   (s.penalty === 'DNF' ? 2 : s.penalty === '+2' ? 1 : 0)) | 0;

/** Best aoN across the whole session, plus the index where it starts. */
export function bestAvg(solves, n) {
  const N = solves.length;
  if (N < n) return { value: null, at: -1 };

  const prev = _bestAvg.get(n);
  const want = prev ? prev.len : -1;

  // One pass gives both the hash of the whole list and the hash of the prefix
  // the cache was built from, so the two questions cost one walk, not two.
  let h = 0, prefix = null;
  for (let i = 0; i < N; i++) {
    if (i === want) prefix = h;
    h = hashStep(h, solves[i]);
  }
  if (want === N) prefix = h;

  if (prev && prev.hash === h) return { value: prev.value, at: prev.at };

  const e = solves.map(eff);
  let best = null, at = -1, from = 0;

  // Same list plus a short tail: keep the old winner and score only the
  // windows that reach into the new solves.
  if (prev && prefix === prev.hash && prev.len >= n && N > prev.len && N - prev.len <= n) {
    best = prev.value;
    at = prev.at;
    from = Math.max(0, prev.len - n + 1);
  }

  for (let i = from; i + n <= N; i++) {
    const a = averageOfRange(e, i, i + n);
    if (a === null || a === DNF) continue;
    if (best === null || a < best) { best = a; at = i; }
  }

  _bestAvg.set(n, { len: N, hash: h, value: best, at });
  return { value: best, at };
}

/** Fastest single (ignoring DNFs). */
export function bestSingle(solves) {
  let best = null;
  for (const s of solves) {
    const v = eff(s);
    if (v === DNF) continue;
    if (best === null || v < best) best = v;
  }
  return best;
}

export function worstSingle(solves) {
  let worst = null;
  for (const s of solves) {
    const v = eff(s);
    if (v === DNF) continue;
    if (worst === null || v > worst) worst = v;
  }
  return worst;
}

/** Population standard deviation of non-DNF solves. */
export function stdev(solves) {
  const v = solves.map(eff).filter(x => x !== DNF);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

export function median(solves) {
  const v = solves.map(eff).filter(x => x !== DNF).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Everything the UI needs.
 *
 * This used to advertise one pass and take about eight — a filter for the
 * non-DNFs, another for the DNF count, another for the +2s, then stdev,
 * median, bestSingle and worstSingle each walking the list again with their
 * own `map(eff)` allocating a full array on the way. It runs on every solve,
 * so on a long session that was a lot of garbage for one row of numbers.
 * Now: one walk to collect everything, one sort for the median, one more walk
 * for the variance.
 */
export function summarize(solves) {
  const n = solves.length;
  const e = new Array(n);
  const valid = [];
  let best = null, worst = null, sum = 0, dnfCount = 0, plus2Count = 0;

  for (let i = 0; i < n; i++) {
    const s = solves[i];
    const v = eff(s);
    e[i] = v;
    if (s.penalty === 'DNF') dnfCount++;
    else if (s.penalty === '+2') plus2Count++;
    if (v === DNF) continue;
    valid.push(v);
    sum += v;
    if (best === null || v < best) best = v;
    if (worst === null || v > worst) worst = v;
  }

  const mean = valid.length ? sum / valid.length : null;

  let sd = null;
  if (valid.length >= 2) {
    let acc = 0;
    for (let i = 0; i < valid.length; i++) acc += (valid[i] - mean) ** 2;
    sd = Math.sqrt(acc / valid.length);
  }

  let med = null;
  if (valid.length) {
    valid.sort((a, b) => a - b);
    const m = valid.length >> 1;
    med = valid.length % 2 ? valid[m] : (valid[m - 1] + valid[m]) / 2;
  }

  const ao = (k) => (n < k ? null : averageOfRange(e, n - k, n));

  return {
    count: n,
    valid: valid.length,
    dnfCount,
    plus2Count,
    best,
    worst,
    mean,
    median: med,
    stdev: sd,
    /** 0–1, higher is more consistent (sd relative to mean). */
    consistency: (sd !== null && mean) ? Math.max(0, Math.min(1, 1 - (sd / mean) / 0.45)) : null,
    ao5:   ao(5),
    ao12:  ao(12),
    ao50:  ao(50),
    ao100: ao(100),
    mo3:   n < 3 ? null : meanOfRange(e, n - 3, n),
    bestAo5:  bestAvg(solves, 5).value,
    bestAo12: bestAvg(solves, 12).value,
  };
}

/**
 * Best-ever average of each length in this session.
 *
 * Kept out of summarize() on purpose: bestAvg is O(n x len) and summarize runs
 * on every single solve, whereas these are only ever read by the expanded
 * stats panel.
 */
export function sessionBests(solves) {
  const out = {};
  for (const n of [5, 12, 50, 100]) {
    out['ao' + n] = solves.length >= n ? bestAvg(solves, n).value : null;
  }
  out.single = bestSingle(solves);
  out.mo3 = solves.length >= 3 ? currentMean(solves, 3) : null;
  return out;
}

/**
 * Which indices in the last-N window are the trimmed best/worst — used to
 * underline the counting solves in the history strip.
 */
export function trimmedIndices(solves, n) {
  if (solves.length < n) return { best: new Set(), worst: new Set() };
  const start = solves.length - n;
  const window = solves.slice(start).map((s, i) => ({ i: start + i, v: eff(s) }));
  const t = trimCount(n);
  const sorted = [...window].sort((a, b) => a.v - b.v);
  return {
    best:  new Set(sorted.slice(0, t).map(x => x.i)),
    worst: new Set(sorted.slice(-t).map(x => x.i)),
  };
}

/** Rolling aoN series aligned with `solves` (null before enough data). */
export function rollingSeries(solves, n) {
  const e = solves.map(eff);
  const out = new Array(solves.length);
  for (let i = 0; i < solves.length; i++) {
    if (i + 1 < n) { out[i] = null; continue; }
    const a = averageOfRange(e, i + 1 - n, i + 1);
    out[i] = (a === null || a === DNF) ? null : a;
  }
  return out;
}

/** Per-case aggregation for trainer modes. */
export function byCase(solves) {
  const map = new Map();
  for (const s of solves) {
    if (!s.caseId) continue;
    if (!map.has(s.caseId)) map.set(s.caseId, []);
    map.get(s.caseId).push(s);
  }
  const out = [];
  for (const [caseId, list] of map) {
    const valid = list.map(eff).filter(x => x !== DNF);
    out.push({
      caseId,
      name: list.at(-1).caseName || caseId,
      count: list.length,
      best: valid.length ? Math.min(...valid) : null,
      avg: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
      ao5: currentAvg(list, 5),
      last: list.at(-1).createdAt,
      dnf: list.filter(s => s.penalty === 'DNF').length,
    });
  }
  return out;
}

/** Solve counts per calendar day, for the heatmap. */
export function dailyCounts(solves, keyOf) {
  const m = new Map();
  for (const s of solves) {
    const k = keyOf(s.createdAt);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
