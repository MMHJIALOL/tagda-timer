/* ===========================================================
   Tagda Timer — "what could I have done here?"

   Two different tools, because the two halves of a CFOP solve ask
   different questions.

   Cross and F2L are search: define the goal as "these pieces home,
   and don't wreck what is already built", then walk the move tree
   depth by depth with a pruning table so it stays honest about
   optimality. Every solution of the shortest length comes back,
   not just one.

   The last layer is not searched. It is simulated: take every OLL,
   PLL and ZBLL alg the app ships in algsets.js, try each one with
   every AUF, and keep the ones that actually finish the job. That
   is exact, instant, and gives back the alg you would recognise
   rather than a machine-optimal string nobody has fingertricks for.

   Every spelling of a case is tried, not just one, because the
   question a reconstruction asks is "is this what I did?" — and the
   answer has to be yes for the alg your fingers know, not only for
   the one the app happens to teach.

   Everything here runs on the main thread on purpose — it only ever
   runs while the reconstruction panel is open, and there is no timer
   to stutter.
   =========================================================== */

import {
  MOVES, MOVE_NAMES, FACES, mulInto, applyAlg,
  faceEdges, toUserFace, facelets, parse,
  slotsFor, CORNER_NAMES, EDGE_NAMES, CORNER_FACELETS, EDGE_FACELETS, IDENTITY_FRAME,
} from './cube3.js';
import { OLL, PLL } from './algs.js';
import { OLL_ALGS, PLL_ALGS, ZBLL } from './algsets.js';
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

/* Every spelling of every case, with the one algs.js teaches kept at the
   front so the app's own alg is still the first thing offered. Each is parsed
   once here rather than on every question: a ZBLL lookup asks about two
   thousand algs, and re-reading the notation each time was most of the cost. */
const merge = (entry, extra) => {
  const seen = new Set();
  const algs = [];
  for (const raw of [entry.alg, ...(extra || [])]) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const key = tidy(text);
    if (seen.has(key)) continue;
    const toks = parse(text);
    if (!toks) continue;
    seen.add(key);
    algs.push({ text, toks });
  }
  return { ...entry, algs };
};

const OLL_SET = OLL.map(o => merge(o, OLL_ALGS[Number(o.name)]));
const PLL_SET = PLL.map(p => merge(p, PLL_ALGS[p.id]));
const ZBLL_SET = ZBLL.map(z => merge({ ...z, alg: '' }, z.algs));

/** Is every sticker on face `ll` showing `ll`? */
function orientedOn(s, ll) {
  const fl = facelets(s);
  const base = FACES.indexOf(ll) * 9;
  for (let i = 0; i < 9; i++) if (fl[base + i] !== ll) return false;
  return true;
}

const isSolvedState = (s) => {
  for (let i = 0; i < 8; i++) if (s[i] !== i || s[8 + i] !== 0) return false;
  for (let i = 0; i < 12; i++) if (s[16 + i] !== i || s[28 + i] !== 0) return false;
  return true;
};

/** How the AUFs a case needed read on the row. */
const aufNote = (rot, pre, post) =>
  [rot && 'rotate first', pre && `${pre} to set up`, post && `${post} to finish`]
    .filter(Boolean).join(' · ') || 'straight in';

const faceTurns = (alg) => alg.split(/\s+/).filter(t => t && !/^[xyz]/.test(t)).length;

/**
 * Try one alg from `state` with every AUF, and return the first pairing that
 * works. The AUFs are the case's rotation, not part of the alg, so the first
 * pairing that fits is the case — the others would only restate it.
 *
 * The alg itself is applied once per setup turn rather than once per pair:
 * the finishing turn goes on the end of the position the alg left behind, in
 * the orientation the alg left it in, which is the same answer for a quarter
 * of the work.
 */
function fit(state, frame, rot, toks, ok, posts) {
  for (const pre of AUFS) {
    const setup = [rot, pre].filter(Boolean).join(' ');
    const base = setup ? applyAlg(state, setup, frame) : { state, frame };
    if (!base) continue;
    const mid = applyAlg(base.state, toks, base.frame);
    if (!mid) continue;
    for (const post of posts) {
      const end = post ? applyAlg(mid.state, post, mid.frame) : mid;
      if (!end || !ok(end.state)) continue;
      return { pre, post };
    }
  }
  return null;
}

/**
 * Every alg in `set` that finishes the job from here.
 *
 * One case matches a position, but that case has half a dozen spellings and
 * the point of the list is that yours is on it. So the loop does not stop at
 * the first case it recognises: it collects every alg that works, and you
 * pick the one your hands already know.
 */
function hits(set, state, frame, rot, ok, posts, kind, name) {
  const found = [];
  for (const entry of set) {
    for (const { text, toks } of entry.algs) {
      const h = fit(state, frame, rot, toks, ok, posts);
      if (!h) continue;
      /* Tidied, because the setup turn and the alg's own first move are next
         to each other now: U written before an alg that opens on U2 is U', and
         printing it as "U U2" makes one alg look like two. */
      const alg = tidy([rot, h.pre, text, h.post].filter(Boolean).join(' '));
      found.push({
        alg,
        moves: faceTurns(alg),
        awkward: rot ? 1 : 0,
        kind,
        label: `${kind} ${name(entry)}`,
        note: aufNote(rot, h.pre, h.post),
      });
    }
  }
  return dedupe(found);
}

const ollName = (entry) => (entry.label ? `${entry.label} ${entry.name}` : entry.name);

/**
 * The PLL skip: the last layer is already permuted and all that is left is to
 * turn it back.
 *
 * No PLL alg can be the answer here — every one of them moves pieces, and
 * nothing needs moving — so without this the panel announces it has run out of
 * ideas one turn away from a finished solve, which is the one place it must
 * not.
 */
function aufOnly(state, frame, rot) {
  for (const pre of AUFS) {
    if (!pre) continue;
    const full = tidy([rot, pre].filter(Boolean).join(' '));
    const res = applyAlg(state, full, frame);
    if (!res || !isSolvedState(res.state)) continue;
    return [{
      alg: full, moves: faceTurns(full), awkward: 0, kind: 'PLL',
      label: 'PLL skip', note: 'the layer is already permuted — just the AUF',
    }];
  }
  return [];
}

function lastLayer(state, frame, analysis) {
  const showing = toUserFace(frame, analysis.ll);
  const rot = BRING_UP[showing] ?? '';
  const ll = analysis.ll;

  if (analysis.phase === 'pll') {
    const skip = aufOnly(state, frame, rot);
    return {
      main: skip.length ? skip
        : hits(PLL_SET, state, frame, rot, isSolvedState, AUFS, 'PLL', e => e.name).sort(byNiceness),
      zb: [],
    };
  }

  const main = hits(OLL_SET, state, frame, rot, s => orientedOn(s, ll), [''], 'OLL', ollName)
    .sort(byNiceness);

  /* ZBLL only exists as an option when the edges are already up the right way
     — the cross showing on the last layer. Asking otherwise would be eighteen
     hundred algs of guaranteed disappointment. */
  const zb = analysis.eo
    ? hits(ZBLL_SET, state, frame, rot, isSolvedState, AUFS, 'ZBLL', e => `${e.family} ${e.id.split('-').pop()}`).sort(byNiceness)
    : [];

  return { main, zb };
}

/* =========================================================
   The one function the UI calls
   ========================================================= */

/**
 * What could come next from here.
 *   kind    which phase these are for
 *   best    length of the shortest thing that works, in face turns
 *   list    ranked suggestions
 *   zb      true when the list opens with one-alg finishes for this OLL
 */
export function suggest(state, frame, analysis, { limit = 20, timeMs = 1500, crossName = null } = {}) {
  const budget = { left: NODE_BUDGET };
  const started = performance.now();
  const out = { kind: analysis.phase, best: -1, list: [], partial: false, face: analysis.face, zb: false };

  if (analysis.phase === 'done') return out;

  if (analysis.phase === 'oll' || analysis.phase === 'pll') {
    const { main, zb } = lastLayer(state, frame, analysis);
    /* ZBLL goes first even though it is the longer alg. It is longer because
       it is doing both jobs, and burying a solve-the-whole-layer suggestion
       under the OLL that only does half of it gets the ranking backwards. */
    const zbShown = zb.slice(0, Math.max(4, limit - main.length));
    out.zb = zbShown.length > 0;
    out.zbBest = zbShown.length ? zbShown[0].moves : -1;
    out.list = [...zbShown, ...main].slice(0, limit);
    out.best = main.length ? main[0].moves : out.zbBest;
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

/* =========================================================
   Cross + 1 — the cross and the first pair, searched together

   This is not "solve the cross, then solve a pair". Those are two
   separate optimalities stacked on each other, and stacking them
   throws away the whole point: a cross move that also happens to
   set a corner up is worth taking even when a shorter cross exists
   without it. So the goal handed to the search is the joint one —
   four cross edges home AND one corner-edge pair home — asked of
   the scrambled position directly, with nothing solved yet.

   It is the same machinery the reconstruction panel already uses on
   the F2L slots (pairGoal, pairTable, the max-of-two-lower-bounds
   heuristic); the only real change is where it starts from.

   The four pairs are searched side by side, one depth at a time, so
   the first answer that comes back is the shortest across all of
   them — which is the question the trainer exists to ask. Searching
   them one after another would have spent the whole budget proving
   the first pair optimal before ever looking at the pair that was
   two moves cheaper.
   ========================================================= */

/** Where each cubie currently sits, as position lookups. */
function locate(s, cAt, eAt) {
  for (let i = 0; i < 8; i++) cAt[s[i]] = i;
  for (let i = 0; i < 12; i++) eAt[s[16 + i]] = i;
}

/** Is edge slot `ep` one of the three touching corner slot `cp`? */
const touching = (cp, ep) => [...EDGE_NAMES[ep]].every(c => CORNER_NAMES[cp].includes(c));

const cornerFacelet = (cp, f) => CORNER_FACELETS[cp][CORNER_NAMES[cp].indexOf(f)];
const edgeFacelet   = (ep, f) => EDGE_FACELETS[ep][EDGE_NAMES[ep].indexOf(f)];

/**
 * Which of this cross's four F2L pairs are already built as a block.
 *
 * "Built" is exact, not a distance threshold: the corner and its edge are
 * sitting next to each other, and on both faces they share they are showing
 * the same colour. That is a pair the scramble handed you, and a cross that
 * carelessly takes it apart has cost you something the move count alone will
 * never show.
 *
 * Only *connected* pairs — adjacent, colours touching — are recognised. A
 * corner and edge that are merely near each other are a real idea in CFOP
 * with no single agreed test, and guessing at a threshold here would make
 * this look exact while quietly being a matter of opinion.
 *
 * Returns the pairs' home-slot names, e.g. ['FR', 'BL'].
 */
export function connectedPairs(s, face) {
  const fl = facelets(s);
  const cAt = new Uint8Array(8), eAt = new Uint8Array(12);
  locate(s, cAt, eAt);
  const out = [];
  for (const slot of slotsFor(face)) {
    const cp = cAt[slot.corner], ep = eAt[slot.edge];
    if (!touching(cp, ep)) continue;
    let matched = true;
    for (const f of EDGE_NAMES[ep]) {
      if (fl[edgeFacelet(ep, f)] !== fl[cornerFacelet(cp, f)]) { matched = false; break; }
    }
    if (matched) out.push(slot.label);
  }
  return out;
}

/** Moves to bring one corner and its edge home, ignoring the rest of the cube. */
function pairDistance(s, slot, pd, cAt, eAt) {
  const cp = cAt[slot.corner], ep = eAt[slot.edge];
  return pd[((cp * 3 + s[8 + cp]) * 12 + ep) * 2 + s[28 + ep]];
}

/** Run a move-index path and hand back where it lands. */
function applyPath(start, path) {
  let cur = Uint8Array.from(start), buf = new Uint8Array(40);
  for (const m of path) { mulInto(buf, cur, MOVES[m]); [cur, buf] = [buf, cur]; }
  return cur;
}

/* Every way of putting one face on the bottom. Searched rather than tabulated
   so the answer cannot be subtly wrong: whichever of these actually lands the
   cross face on D is the one used. z2 is ahead of x2 for the white cross
   because it leaves the front face where it was, so the slots keep the names
   the scramble picture gave them. */
const TO_BOTTOM = ['', 'z2', 'x', "x'", 'z', "z'", 'x2'];
const ROT_PROBE = new Uint8Array(40);

/**
 * The frame the moves should be written in.
 *
 * Nobody solves a white cross with white on top. `orient: 'bottom'` answers in
 * the orientation the cross is actually built in — the cube already turned over
 * in your hands, so a solver-frame U turn is written as the D turn your fingers
 * would make. `'scramble'` answers in the orientation the scramble picture
 * shows, for anyone who would rather read it that way.
 */
function frameFor(face, frame, orient) {
  if (orient !== 'bottom') return frame;
  return crossFrame(face, orient);
}

/**
 * The rotation that puts `face` on the bottom — '' when it is already there or
 * when the answers are being written the way the scramble picture shows it.
 * Exported because a picture of the cube has to be turned over too: the net the
 * trainer draws is only honest if it is drawn the way the moves are written.
 */
export function crossRotation(face, orient = 'bottom') {
  if (orient !== 'bottom') return '';
  for (const rot of TO_BOTTOM) {
    const r = applyAlg(ROT_PROBE, rot, IDENTITY_FRAME);
    if (r && toUserFace(r.frame, face) === 'D') return rot;
  }
  return '';
}

/** The frame those answers are written in — so a plan typed by hand is read
    in the same orientation the trainer prints its own lines in. */
export function crossFrame(face, orient = 'bottom') {
  const rot = crossRotation(face, orient);
  return applyAlg(ROT_PROBE, rot, IDENTITY_FRAME)?.frame || IDENTITY_FRAME;
}

/**
 * A slot's name as the person holding the cube would say it: FR, DL, UB.
 *
 * Re-sorted into the order cube notation is written in — layer first, then
 * front/back, then right/left — because mapping the letters straight through a
 * rotation spells them in whatever order the original happened to be in, and
 * "RF pair" is a slot nobody has ever called that.
 */
const NAME_ORDER = { U: 0, D: 1, F: 2, B: 3, R: 4, L: 5 };
const slotLabel = (label, frame) => [...label]
  .map(f => toUserFace(frame, f))
  .sort((a, b) => NAME_ORDER[a] - NAME_ORDER[b])
  .join('');

/**
 * Everything about a solution that depends on which way up you are holding it.
 *
 * Turn the cube and the same eight quarter-turns are spelt differently, finish
 * a differently-named slot, and — the one that actually matters — get easier or
 * harder: the B move you were rearranging your solution to avoid is an F move
 * from over here. So none of this can be baked in at search time. The path and
 * the pair distances are the facts; this is the reading.
 */
export function decorateSolution(raw, frame) {
  const r = render(raw.path, frame);
  return {
    ...raw, ...r,
    slot: slotLabel(raw.rawSlot, frame),
    ergo: ergoOf(r.alg),
    bMoves: countB(r.alg),
    highTps: ergoOf(r.alg) === 0,
    broke: raw.rawBroke.map(l => slotLabel(l, frame)),
    preserves: raw.rawBroke.length === 0,
    after: raw.rawAfter.map(a => ({ ...a, slot: slotLabel(a.raw, frame) })),
  };
}

/**
 * Re-read a whole result from a new orientation, without searching again.
 *
 * Rotating the cube in your hands changes how the answers are written, not
 * what they are — so paying a second search for it would be paying for nothing.
 */
export function reframeResult(result, frame) {
  if (!result) return result;
  return {
    ...result,
    list: (result.list || []).map(s => decorateSolution(s, frame)),
    built: (result.rawBuilt || []).map(l => slotLabel(l, frame)),
    pairs: (result.pairs || []).map(p => ({ ...p, slot: slotLabel(p.rawSlot, frame) })),
    faces: (result.faces || []).map(f => ({
      ...f, slot: f.rawSlot ? slotLabel(f.rawSlot, frame) : '',
    })),
  };
}

/**
 * How much the hands have to work, as a number that is 0 when a line is pure
 * R, U, L and D.
 *
 * This started as a filter — keep only the lines with nothing but the four
 * comfortable faces — and that turned out to be a filter that matches almost
 * nothing: across three hundred lines from five scrambles, not one qualified.
 * The reason is structural rather than bad luck. Two of the cross edges start
 * life needing an F or a B to reach the bottom layer at all, so a line that
 * avoids both faces entirely and still finishes inside eight moves is a
 * curiosity, not something to rank by.
 *
 * A score discriminates where the filter could not. B is weighted heaviest
 * because a B move in a cross is the one everybody actually rearranges their
 * solution to avoid; F is a mild cost; the other four are free.
 */
const ERGO = { R: 0, U: 0, L: 0, D: 0, F: 1, B: 3 };
const ergoOf = (alg) => alg.split(/\s+/).filter(Boolean)
  .reduce((n, t) => n + (ERGO[t[0]] ?? 1), 0);
const countB = (alg) => alg.split(/\s+/).filter(t => t[0] === 'B').length;

/**
 * Every short way to finish the cross and one F2L pair at the same time.
 *
 *   face     the cross face, or 'auto' to weigh up all six
 *   orient   'bottom' (as you hold it) or 'scramble' (as the picture shows it)
 *
 * Comes back as:
 *   face       the face these answers are for
 *   crossBest  the optimal plain cross, exactly — a table lookup, not a search,
 *              so "the pair cost me two extra moves" is a fact, not an estimate
 *   best       the shortest joint cross+1 found
 *   list       ranked lines, each carrying which pair it sets up, whether it
 *              stays on the friendly faces, what it took apart, and how far the
 *              other three pairs are left afterwards
 *   pairs      one row per pair: the shortest line that goes for it
 *   faces      per-face summary, when asked about all six
 *   partial    the search ran out of budget before it ran out of depth
 */
export function suggestCrossPlusOne(state, frame = IDENTITY_FRAME, {
  face = 'D', limit = 60, timeMs = 6000, maxDepth = 11, slack = null,
  perSlot = 24, orient = 'bottom',
} = {}) {
  const started = performance.now();
  const budget = { left: NODE_BUDGET };
  const faces = face === 'auto' ? [...FACES] : [face];
  /* All six colours is twenty-four searches sharing one budget, and running
     out of it is what leaves a pair missing from the comparison the mode
     exists for. One depth past the answer instead of two keeps that table
     whole; on a single colour there is room for the extra depth, and the
     alternatives it buys are worth having. */
  if (slack === null) slack = faces.length > 1 ? 1 : 2;
  const cAt = new Uint8Array(8), eAt = new Uint8Array(12);
  const cross = [0, 0, 0, 0], crossO = [0, 0, 0, 0];
  locate(state, cAt, eAt);

  /* The optimal cross is already sitting in the pruning table — it is what the
     table is a table of. No search, no approximation. */
  const crossOf = {};
  for (const f of faces) {
    const t = crossTable(f);
    crossOf[f] = t.dist[crossIndex(state, t.slotOf)];
  }

  /* One search per (face, pair). Cheapest first, so that if the budget does run
     out it runs out on the lines that were never going to be the answer. */
  const targets = [];
  for (const f of faces) {
    const table = crossTable(f);
    for (const slot of slotsFor(f)) {
      const pd = pairTable(slot.corner, slot.edge);
      targets.push({
        face: f, slot, table, pd, out: [],
        lb: Math.max(crossOf[f], pairDistance(state, slot, pd, cAt, eAt)),
        goal: pairGoal(table.homes, [], slot),
        h: makeHeuristic(table, slot, pd, cAt, eAt, cross, crossO),
      });
    }
  }
  targets.sort((a, b) => a.lb - b.lb);

  const out = {
    face: faces.length === 1 ? face : 'auto',
    crossBest: faces.length === 1 ? crossOf[face] : Math.min(...Object.values(crossOf)),
    best: -1, list: [], pairs: [], faces: [], partial: false,
  };

  /* Depth by depth, across every pair at once. The first depth that yields
     anything is the true joint optimum; `slack` more depths after it are what
     turn one answer into a list worth choosing from. */
  let best = -1;
  const lowest = targets.length ? targets[0].lb : 0;
  outer:
  for (let d = lowest; d <= maxDepth; d++) {
    for (const t of targets) {
      if (t.lb > d || t.out.length >= perSlot) continue;
      if (budget.left <= 0 || performance.now() - started > timeMs) { out.partial = true; break outer; }
      searchDepth(state, t.goal, t.h, d, perSlot, t.out, budget);
    }
    if (best < 0 && targets.some(t => t.out.length)) best = d;
    if (best >= 0 && d >= best + slack) break;
  }
  if (budget.left <= 0) out.partial = true;

  /* What the lines actually cost you, beyond their length. */
  const before = {};
  for (const f of faces) before[f] = connectedPairs(state, f);

  const all = [];
  for (const t of targets) {
    const rf = frameFor(t.face, frame, orient);
    const others = slotsFor(t.face).filter(s => s.label !== t.slot.label);
    for (const path of t.out) {
      const after = applyPath(state, path);
      const aAt = new Uint8Array(8), bAt = new Uint8Array(12);
      locate(after, aAt, bAt);
      const stillPaired = connectedPairs(after, t.face);
      /* Split in two on purpose: what is true of a solution, and how that
         solution reads from where you are standing. Only the second half
         changes when the cube is turned over, and keeping it separable is what
         lets a rotation re-label the answers instead of re-finding them. */
      all.push(decorateSolution({
        path: Array.from(path),
        face: t.face,
        rawSlot: t.slot.label,
        rawBroke: before[t.face].filter(l => l !== t.slot.label && !stillPaired.includes(l)),
        /* Where the remaining three pairs are left. This is the lookahead the
           whole feature is for: not "was that cross short" but "what did it
           hand me next". */
        rawAfter: others.map(s => ({
          raw: s.label,
          corner: s.corner,
          edge: s.edge,
          dist: pairDistance(after, s, pairTable(s.corner, s.edge), aAt, bAt),
        })).sort((a, b) => a.dist - b.dist),
      }, rf));
    }
  }

  const ranked = dedupe(all).sort(byNiceness);
  out.best = ranked.length ? ranked[0].moves : -1;
  out.list = ranked.slice(0, limit);

  /* One row per pair, so "which pair should I go for" is a table you read
     rather than a list you scan. Built off the ranked lines, so a pair with no
     short line at all is shown as exactly that instead of silently missing. */
  const seenPair = new Map();
  for (const s of ranked) {
    const key = `${s.face}|${s.rawSlot}`;
    if (!seenPair.has(key)) {
      seenPair.set(key, { face: s.face, slot: s.slot, rawSlot: s.rawSlot, best: s.moves, count: 0 });
    }
    seenPair.get(key).count++;
  }
  for (const t of targets) {
    const key = `${t.face}|${t.slot.label}`;
    if (seenPair.has(key)) continue;
    seenPair.set(key, {
      face: t.face, rawSlot: t.slot.label,
      slot: slotLabel(t.slot.label, frameFor(t.face, frame, orient)),
      best: -1, count: 0,
    });
  }
  out.pairs = [...seenPair.values()].sort((a, b) =>
    (a.best < 0) - (b.best < 0) || a.best - b.best || a.slot.localeCompare(b.slot));

  out.faces = faces.map(f => {
    const mine = ranked.filter(s => s.face === f);
    return {
      face: f, cross: crossOf[f], best: mine.length ? mine[0].moves : -1,
      slot: mine[0]?.slot || '', rawSlot: mine[0]?.rawSlot || '',
    };
  }).sort((a, b) => (a.best < 0) - (b.best < 0) || a.best - b.best || a.cross - b.cross);

  if (face === 'auto' && out.faces.length) out.face = out.faces[0].face;

  /* Pairs the scramble handed you already built. Worth saying out loud on its
     own — it is lookahead you are given for free — and it is also the only
     thing that makes "don't break a built pair" mean anything: with none on the
     cube every line trivially preserves them all, and a preference that is
     always satisfied is one the panel should show as idle rather than let you
     switch on and watch do nothing. Computed last, because until the face is
     settled there is no cross to ask the question about. */
  out.rawBuilt = before[out.face] || [];
  out.built = out.rawBuilt.map(l => slotLabel(l, frameFor(out.face, frame, orient)));
  return out;
}

/**
 * Lower bound on what is left: the cross's exact distance, and the pair's
 * exact distance, whichever is larger. Both are exact for their own subproblem
 * and neither can be skipped, so the larger of the two is admissible — and it
 * is what keeps a depth-11 search over four pairs finishing in a second rather
 * than a minute.
 *
 * The scratch arrays are handed in rather than allocated: this runs at every
 * node of every search, and allocating four typed arrays a node was, in the
 * panel this borrows from, most of the cost.
 */
function makeHeuristic(table, slot, pd, cAt, eAt, cross, crossO) {
  const { dist, slotOf } = table;
  return (s) => {
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
}
