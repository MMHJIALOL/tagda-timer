/* ===========================================================
   Tagda Timer — "what could I have done here?"

   Two different tools, because the two halves of a CFOP solve ask
   different questions.

   Cross and F2L are search: define the goal as "these pieces home,
   and don't wreck what is already built", then walk the move tree
   depth by depth with a pruning table so it stays honest about
   optimality. Every solution of the shortest length comes back,
   not just one.

   The last layer is not searched. It is simulated: take the 57 OLLs
   and 21 PLLs the app already ships in algs.js, try each one with
   every AUF, and keep the ones that actually finish the job. That
   is exact, instant, and gives back the alg you would recognise
   rather than a machine-optimal string nobody has fingertricks for.

   Everything here runs on the main thread on purpose — it only ever
   runs while the reconstruction panel is open, and there is no timer
   to stutter.
   =========================================================== */

import {
  MOVES, MOVE_NAMES, FACES, mulInto, applyAlg,
  faceEdges, toUserFace, analyse,
} from './cube3.js';
import { OLL, PLL } from './algs.js';
import { tidy } from './util.js';

/* ---------------- piece transitions ----------------
   The move tables say "position i receives the piece from ep[i]". The search
   wants the other direction — "the piece at j lands on which position" — so
   both are inverted once, here. */
const EDGE_TO = [], EDGE_FLIP = [], CORNER_TO = [], CORNER_TWIST = [];
for (const m of MOVES) {
  const et = new Uint8Array(12), ef = new Uint8Array(12);
  for (let i = 0; i < 12; i++) { et[m.ep[i]] = i; ef[m.ep[i]] = m.eo[i]; }
  EDGE_TO.push(et); EDGE_FLIP.push(ef);
  const ct = new Uint8Array(8), cw = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { ct[m.cp[i]] = i; cw[m.cp[i]] = m.co[i]; }
  CORNER_TO.push(ct); CORNER_TWIST.push(cw);
}

const AXIS = FACES.map(f => 'URF'.includes(f) ? FACES.indexOf(f) : FACES.indexOf(f) - 3);
const opposite = (a, b) => a !== b && AXIS[a] === AXIS[b];

/* =========================================================
   Pruning tables
   ========================================================= */

/** Four cross edges: where they are and which way up, as one number. */
function crossIndex(s, slotOf) {
  const p = [0, 0, 0, 0], o = [0, 0, 0, 0];
  for (let i = 0; i < 12; i++) {
    const k = slotOf[s[16 + i]];
    if (k >= 0) { p[k] = i; o[k] = s[28 + i]; }
  }
  return ((((p[0] * 12 + p[1]) * 12 + p[2]) * 12 + p[3]) << 4) |
         (o[0] << 3 | o[1] << 2 | o[2] << 1 | o[3]);
}

const crossCache = new Map();

/** Exact distance-to-solved for one face's cross. ~190k states, built once. */
function crossTable(face) {
  if (crossCache.has(face)) return crossCache.get(face);
  const homes = faceEdges(face);
  const slotOf = new Int8Array(12).fill(-1);
  homes.forEach((c, k) => { slotOf[c] = k; });

  const dist = new Uint8Array(12 * 12 * 12 * 12 * 16).fill(255);
  const pack = (p, o) => ((((p[0] * 12 + p[1]) * 12 + p[2]) * 12 + p[3]) << 4) |
                         (o[0] << 3 | o[1] << 2 | o[2] << 1 | o[3]);
  const start = pack(homes, [0, 0, 0, 0]);
  dist[start] = 0;

  let frontier = [start];
  for (let d = 0; frontier.length; d++) {
    const next = [];
    for (const idx of frontier) {
      const bits = idx & 15, rest = idx >> 4;
      const p = [(rest / 1728) | 0, ((rest / 144) | 0) % 12, ((rest / 12) | 0) % 12, rest % 12];
      const o = [(bits >> 3) & 1, (bits >> 2) & 1, (bits >> 1) & 1, bits & 1];
      for (let m = 0; m < 18; m++) {
        const et = EDGE_TO[m], ef = EDGE_FLIP[m];
        const np = [et[p[0]], et[p[1]], et[p[2]], et[p[3]]];
        const no = [o[0] ^ ef[p[0]], o[1] ^ ef[p[1]], o[2] ^ ef[p[2]], o[3] ^ ef[p[3]]];
        const ni = pack(np, no);
        if (dist[ni] === 255) { dist[ni] = d + 1; next.push(ni); }
      }
    }
    frontier = next;
  }
  const table = { dist, slotOf, homes };
  crossCache.set(face, table);
  return table;
}

const pairCache = new Map();

/** Distance for one corner + one edge, ignoring everything else. 576 states. */
function pairTable(corner, edge) {
  const key = corner * 12 + edge;
  if (pairCache.has(key)) return pairCache.get(key);
  const dist = new Uint8Array(8 * 3 * 12 * 2).fill(255);
  const pack = (cp, co, ep, eo) => ((cp * 3 + co) * 12 + ep) * 2 + eo;
  const start = pack(corner, 0, edge, 0);
  dist[start] = 0;
  let frontier = [start];
  for (let d = 0; frontier.length; d++) {
    const next = [];
    for (const idx of frontier) {
      const eo = idx & 1, ep = ((idx >> 1) % 12), co = ((idx / 24) | 0) % 3, cp = (idx / 72) | 0;
      for (let m = 0; m < 18; m++) {
        const ni = pack(CORNER_TO[m][cp], (co + CORNER_TWIST[m][cp]) % 3,
                        EDGE_TO[m][ep], eo ^ EDGE_FLIP[m][ep]);
        if (dist[ni] === 255) { dist[ni] = d + 1; next.push(ni); }
      }
    }
    frontier = next;
  }
  pairCache.set(key, dist);
  return dist;
}

/* =========================================================
   Depth-first enumeration
   ========================================================= */

const MAX_DEPTH = 11;
const NODE_BUDGET = 5_000_000;

/**
 * Every solution of length exactly `limit`, up to `want` of them.
 * `h` is a lower bound on the remaining length — the tighter it is, the less
 * of the tree gets walked.
 */
function searchDepth(start, goal, h, limit, want, out, budget) {
  const S = [];
  for (let i = 0; i <= limit; i++) S.push(new Uint8Array(40));
  S[0].set(start);
  const path = new Int8Array(limit);
  let nodes = 0;

  const rec = (d, prev, prev2) => {
    if (out.length >= want || nodes > budget.left) return;
    if (d === limit) {
      nodes++;
      if (goal(S[d])) out.push(Array.from(path.slice(0, limit)));
      return;
    }
    if (d + h(S[d]) > limit) return;
    for (let m = 0; m < 18; m++) {
      const face = (m / 3) | 0;
      if (face === prev) continue;
      // Opposite faces commute, so only one of the two orders is walked —
      // and never a third turn of the same face sandwiched between them.
      if (prev >= 0 && opposite(face, prev) && face > prev) continue;
      if (prev2 >= 0 && face === prev2 && opposite(face, prev)) continue;
      nodes++;
      mulInto(S[d + 1], S[d], MOVES[m]);
      path[d] = m;
      rec(d + 1, face, prev);
      if (out.length >= want || nodes > budget.left) return;
    }
  };
  rec(0, -1, -1);
  budget.left -= nodes;
  return out;
}

/** Shortest-first enumeration: stop once we have enough, or once we are two
    moves past the first thing that worked. Nobody wants the 12-move cross. */
function solveGoal(start, goal, h, { want = 60, slack = 2, maxDepth = MAX_DEPTH, budget }) {
  const out = [];
  let best = -1;
  for (let d = 0; d <= maxDepth; d++) {
    if (budget.left <= 0) break;
    searchDepth(start, goal, h, d, want, out, budget);
    if (out.length && best < 0) best = d;
    /* Alternatives are worth having when the answer is short. Once it is eight
       moves or more, one more depth costs an order of magnitude and buys a
       list nobody reads, so a long solution is handed over as it is. */
    const allow = best >= 8 ? 0 : slack;
    if (best >= 0 && (d >= best + allow || out.length >= want)) break;
  }
  return { best, solutions: out };
}

/* =========================================================
   Turning a solution back into something a person can read
   ========================================================= */

const COMFORT = { R: 0, U: 0, L: 1, F: 1, D: 2, B: 3 };

function render(path, frame) {
  const toks = path.map(m => {
    const name = MOVE_NAMES[m];
    const solverFace = name[0];
    return toUserFace(frame, solverFace) + name.slice(1);
  });
  const alg = tidy(toks.join(' '));
  const faces = alg.split(/\s+/).filter(Boolean);
  return {
    alg,
    moves: faces.length,
    awkward: faces.reduce((n, t) => n + COMFORT[t[0]], 0),
  };
}

const byNiceness = (a, b) => a.moves - b.moves || a.awkward - b.awkward || a.alg.localeCompare(b.alg);

/* =========================================================
   Goal builders
   ========================================================= */

const edgeHome = (s, i) => s[16 + i] === i && s[28 + i] === 0;
const cornerHome = (s, i) => s[i] === i && s[8 + i] === 0;

function crossGoal(homes) {
  return (s) => homes.every(i => edgeHome(s, i));
}

/** Cross intact, every pair already built still built, and this one added. */
function pairGoal(homes, keep, slot) {
  return (s) => {
    for (const i of homes) if (!edgeHome(s, i)) return false;
    for (const k of keep) if (!cornerHome(s, k.corner) || !edgeHome(s, k.edge)) return false;
    return cornerHome(s, slot.corner) && edgeHome(s, slot.edge);
  };
}

/* =========================================================
   Last layer, by simulation
   ========================================================= */

/* The rotation that brings a given face up, so the algs — which are all
   written for a last layer on U — can be tried at all. */
const BRING_UP = { U: '', F: 'x', D: 'x2', B: "x'", L: 'z', R: "z'" };
const AUFS = ['', 'U', 'U2', "U'"];

function lastLayer(state, frame, analysis) {
  const showing = toUserFace(frame, analysis.ll);
  const rot = BRING_UP[showing] ?? '';
  const set = analysis.phase === 'oll' ? OLL : PLL;
  const wantSolved = analysis.phase === 'pll';
  const found = [];

  for (const entry of set) {
    // The first AUF pairing that works is the case; the others would only
    // restate it, so each alg contributes at most one suggestion.
    let hit = null;
    for (const pre of AUFS) {
      for (const post of (wantSolved ? AUFS : [''])) {
        const alg = [rot, pre, entry.alg, post].filter(Boolean).join(' ');
        const res = applyAlg(state, alg, frame);
        if (!res) continue;
        const a = analyse(res.state);
        if (wantSolved ? !a.solved : !a.oll) continue;
        hit = { alg, pre, post };
        break;
      }
      if (hit) break;
    }
    if (!hit) continue;
    const kind = wantSolved ? 'PLL' : 'OLL';
    const title = entry.label ? `${entry.label} ${entry.name}` : entry.name;
    found.push({
      alg: hit.alg,
      moves: hit.alg.split(/\s+/).filter(t => !/^[xyz]/.test(t)).length,
      awkward: rot ? 1 : 0,
      label: `${kind} ${title}`,
      note: [rot && 'rotate first', hit.pre && `${hit.pre} to set up`, hit.post && `${hit.post} to finish`]
        .filter(Boolean).join(' · ') || 'straight in',
    });
  }
  found.sort(byNiceness);
  return found;
}

/* =========================================================
   The one function the UI calls
   ========================================================= */

/**
 * What could come next from here.
 *   kind    which phase these are for
 *   best    length of the shortest thing that works, in face turns
 *   list    ranked suggestions
 */
export function suggest(state, frame, analysis, { limit = 20, timeMs = 1500, crossName = null } = {}) {
  const budget = { left: NODE_BUDGET };
  const started = performance.now();
  const out = { kind: analysis.phase, best: -1, list: [], partial: false, face: analysis.face };

  if (analysis.phase === 'done') return out;

  if (analysis.phase === 'oll' || analysis.phase === 'pll') {
    out.list = lastLayer(state, frame, analysis).slice(0, limit);
    out.best = out.list.length ? out.list[0].moves : -1;
    return out;
  }

  if (analysis.phase === 'cross') {
    const { dist, slotOf, homes } = crossTable(analysis.face);
    const h = (s) => dist[crossIndex(s, slotOf)];
    const { best, solutions } = solveGoal(state, crossGoal(homes), h, { want: 120, slack: 2, maxDepth: 9, budget });
    out.best = best;
    const crossLabel = crossName || `${analysis.face} cross`;
    out.list = dedupe(solutions.map(p => ({ ...render(p, frame), label: crossLabel, note: 'cross' })))
      .sort(byNiceness).slice(0, limit);
    out.partial = budget.left <= 0;
    return out;
  }

  /* F2L. Every unsolved slot is searched, and the results are merged — the
     question a reconstruction actually asks is "which pair was easiest from
     here", not "finish the one I picked". */
  const { dist, slotOf, homes } = crossTable(analysis.face);
  const cross = [0, 0, 0, 0], crossO = [0, 0, 0, 0];
  const done = analysis.slots.filter(s => s.done);
  const todo = analysis.slots.filter(s => !s.done);
  const all = [];
  let best = -1;

  /* A pair that is already in has to come back out and go home again, so its
     own distance is a lower bound too. Taking the largest of them stops the
     search wandering into lines that scatter three finished pairs — which is
     what used to make the last slot unfindable inside the depth limit. */
  const keep = done.map(sl => ({ ...sl, pd: pairTable(sl.corner, sl.edge) }));

  /* The heuristic is the innermost thing in the search, so it walks the
     position once and then does nothing but table lookups. Finding each
     piece with its own scan cost four passes a node and showed up as a
     second of thinking on the last slot. */
  const cAt = new Uint8Array(8);
  const eAt = new Uint8Array(12);

  for (const slot of todo) {
    if (performance.now() - started > timeMs) { out.partial = true; break; }
    const pd = pairTable(slot.corner, slot.edge);
    const pairs = [{ corner: slot.corner, edge: slot.edge, pd }, ...keep];
    const h = (s) => {
      for (let i = 0; i < 8; i++) cAt[s[i]] = i;
      let n = 0;
      for (let i = 0; i < 12; i++) {
        const p = s[16 + i];
        eAt[p] = i;
        const k = slotOf[p];
        if (k >= 0) { cross[k] = i; crossO[k] = s[28 + i]; }
      }
      n = dist[((((cross[0] * 12 + cross[1]) * 12 + cross[2]) * 12 + cross[3]) << 4)
        | (crossO[0] << 3 | crossO[1] << 2 | crossO[2] << 1 | crossO[3])];
      for (const q of pairs) {
        const cp = cAt[q.corner], ep = eAt[q.edge];
        const d = q.pd[((cp * 3 + s[8 + cp]) * 12 + ep) * 2 + s[28 + ep]];
        if (d > n) n = d;
      }
      return n;
    };
    // The last slot is the only search left, so it can afford to look deeper.
    const cap = todo.length === 1 ? 11 : 10;
    const { best: b, solutions } = solveGoal(
      state, pairGoal(homes, done, slot), h,
      { want: 24, slack: 1, maxDepth: best >= 0 ? Math.min(cap, best + 1) : cap, budget },
    );
    if (b >= 0 && (best < 0 || b < best)) best = b;
    for (const p of solutions) {
      const where = [...slot.label].map(f => toUserFace(frame, f)).join('');
      all.push({ ...render(p, frame), label: `${where} pair`, note: 'f2l' });
    }
  }
  /* If nothing keeps everything intact inside the depth limit, look again
     without insisting the finished pairs survive. Breaking one is a real thing
     people do, and a suggestion that says so beats an empty list. */
  if (!all.length && done.length) {
    for (const slot of todo) {
      if (budget.left <= 0) break;
      const pd = pairTable(slot.corner, slot.edge);
      const h = (s) => {
        for (let i = 0; i < 8; i++) cAt[s[i]] = i;
        for (let i = 0; i < 12; i++) {
          const p = s[16 + i];
          eAt[p] = i;
          const k = slotOf[p];
          if (k >= 0) { cross[k] = i; crossO[k] = s[28 + i]; }
        }
        const n = dist[((((cross[0] * 12 + cross[1]) * 12 + cross[2]) * 12 + cross[3]) << 4)
          | (crossO[0] << 3 | crossO[1] << 2 | crossO[2] << 1 | crossO[3])];
        const cp = cAt[slot.corner], ep = eAt[slot.edge];
        const d = pd[((cp * 3 + s[8 + cp]) * 12 + ep) * 2 + s[28 + ep]];
        return d > n ? d : n;
      };
      const { best: b, solutions } = solveGoal(
        state, pairGoal(homes, [], slot), h, { want: 12, slack: 1, maxDepth: 9, budget },
      );
      if (b >= 0 && (best < 0 || b < best)) best = b;
      for (const p of solutions) {
        const where = [...slot.label].map(f => toUserFace(frame, f)).join('');
        all.push({ ...render(p, frame), label: `${where} pair`, note: 'disturbs a finished pair' });
      }
    }
  }

  out.best = best;
  out.partial = out.partial || budget.left <= 0;
  out.list = dedupe(all).sort(byNiceness).slice(0, limit);
  return out;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(x => x.alg && !seen.has(x.alg) && seen.add(x.alg));
}

/** Warm the table for a cross face before the panel needs it. */
export const warm = (face) => { crossTable(face); };
