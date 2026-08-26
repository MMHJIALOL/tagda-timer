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

/**
 * WCA average of the given effective times.
 * Trims `trimCount(n)` from each end. DNFs sort to the top; if there are more
 * DNFs than the trim count the average itself is a DNF.
 */
export function averageOf(effTimes) {
  const n = effTimes.length;
  if (n < 3) return null;
  const t = n >= 5 ? trimCount(n) : 0;
  const dnfs = effTimes.filter(x => x === DNF).length;
  if (dnfs > t) return DNF;
  const sorted = [...effTimes].sort((a, b) => a - b);
  const kept = t ? sorted.slice(t, n - t) : sorted;
  if (kept.some(x => x === DNF)) return DNF;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
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
  return averageOf(solves.slice(-n).map(eff));
}

/** Current moN (mean of N). */
export function currentMean(solves, n) {
  if (solves.length < n) return null;
  return meanOf(solves.slice(-n).map(eff));
}

/** Best aoN across the whole session, plus the index where it starts. */
export function bestAvg(solves, n) {
  if (solves.length < n) return { value: null, at: -1 };
  const e = solves.map(eff);
  let best = null, at = -1;
  for (let i = 0; i + n <= e.length; i++) {
    const a = averageOf(e.slice(i, i + n));
    if (a === null || a === DNF) continue;
    if (best === null || a < best) { best = a; at = i; }
  }
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

/** Everything the UI needs, computed in one pass over the session. */
export function summarize(solves) {
  const n = solves.length;
  const nonDnf = solves.filter(s => eff(s) !== DNF);
  const sd = stdev(solves);
  const mean = nonDnf.length ? nonDnf.reduce((a, s) => a + eff(s), 0) / nonDnf.length : null;
  return {
    count: n,
    valid: nonDnf.length,
    dnfCount: solves.filter(s => s.penalty === 'DNF').length,
    plus2Count: solves.filter(s => s.penalty === '+2').length,
    best: bestSingle(solves),
    worst: worstSingle(solves),
    mean,
    median: median(solves),
    stdev: sd,
    /** 0–1, higher is more consistent (sd relative to mean). */
    consistency: (sd !== null && mean) ? Math.max(0, Math.min(1, 1 - (sd / mean) / 0.45)) : null,
    ao5:   currentAvg(solves, 5),
    ao12:  currentAvg(solves, 12),
    ao50:  currentAvg(solves, 50),
    ao100: currentAvg(solves, 100),
    mo3:   currentMean(solves, 3),
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
  return solves.map((_, i) => {
    if (i + 1 < n) return null;
    const a = averageOf(e.slice(i + 1 - n, i + 1));
    return (a === null || a === DNF) ? null : a;
  });
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
