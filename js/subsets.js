/* ===========================================================
   Tagda Timer — random-state scrambles for 3x3 subsets

   "Cross solved" means: of every position with the cross solved, any
   one, each as likely as the next. The way to get that is the way
   csTimer and TNoodle do it: pick the position first, then find a
   sequence that reaches it. Gluing cross-safe triggers together does
   not get there — a handful of triggers leaves whole slots untouched
   and pairs ready-made, and "last slot" built that way opened two or
   three slots at once.

   Three kinds of subset, three ways to reach the position:

     cross, lastslot, l10p   pieces are picked at random among the
                             ones the subset leaves free, and the 3x3
                             solver cubing.js ships (min2phase) solves
                             the result; the scramble is that solution
                             backwards. ~20 moves, any face.
     2gen                    a random position of the <R,U> group,
                             solved by a small search that only uses R
                             and U, so the scramble does too.
     lse                     the M,U group is small enough to list
                             whole, so the scramble is a shortest way
                             to a random member of it.

   Runs in js/subsets.worker.js, off the page: min2phase spends ~0.2 s
   building tables the first time, and 2-gen and LSE build their own.
   =========================================================== */

import { SOLVED, MOVES, facelets, mulInto } from './cube3.js';
import { invert, tidy } from './util.js';

/* The 3x3 solver inside the vendored cubing.js. It takes 54 facelets in
   U R F D L B order — the order cube3's facelets() writes — and returns a
   solution. Its file name carries a content hash: tools/mirror_cubing.py
   writes a new one when cubing.js is updated, and verify-subsets.mjs fails
   until this line follows it. */
const MIN2PHASE = '../vendor/cubing/chunks/search-dynamic-solve-3x3x3-B2L4IN34-HY5MHBSJ.js';
let solver = null;
async function min2phase() {
  if (!solver) {
    solver = import(/* @vite-ignore */ new URL(MIN2PHASE, import.meta.url).href).then(m => { m.initialize(); return m; });
    solver.catch(() => { solver = null; });
  }
  return solver;
}

const rand = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const parity = (p) => {
  let odd = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) odd ^= 1;
  return odd;
};

/**
 * A random position that leaves every piece not named in place.
 * `corners` / `edges` are the positions (cube3 indices) whose pieces are
 * free; the pieces that start there are shuffled among them and twisted or
 * flipped at random. Twist, flip and permutation parity are kept legal.
 */
export function randomState(corners, edges) {
  const s = SOLVED.slice();
  const cp = shuffle(corners.slice()), ep = shuffle(edges.slice());
  /* The two permutations must have the same parity. Swapping two edges fixes
     it; with fewer than two free edges, two corners. */
  if (parity(cp) !== parity(ep)) {
    if (ep.length > 1) [ep[0], ep[1]] = [ep[1], ep[0]];
    else [cp[0], cp[1]] = [cp[1], cp[0]];
  }
  corners.forEach((at, i) => { s[at] = cp[i]; });
  edges.forEach((at, i) => { s[16 + at] = ep[i]; });
  let twist = 0, flip = 0;
  corners.forEach((at, i) => {
    const o = i < corners.length - 1 ? rand(3) : (3 - twist % 3) % 3;
    s[8 + at] = o; twist += o;
  });
  edges.forEach((at, i) => {
    const o = i < edges.length - 1 ? rand(2) : flip & 1;
    s[28 + at] = o; flip += o;
  });
  return s;
}

const isSolved = (s) => s.every((v, i) => v === SOLVED[i]);
const home = (s, c, e) => s[c] === c && s[8 + c] === 0 && s[16 + e] === e && s[28 + e] === 0;

/* Which pieces each subset leaves free, by cube3 index.
   Corners: 0 URF 1 UFL 2 ULB 3 UBR 4 DFR 5 DLF 6 DBL 7 DRB.
   Edges:   0 UR 1 UF 2 UL 3 UB 4 DR 5 DF 6 DL 7 DB 8 FR 9 FL 10 BL 11 BR. */
const FREE = {
  /* The cross on D; every corner and every other edge anywhere. */
  cross:    { corners: [0, 1, 2, 3, 4, 5, 6, 7], edges: [0, 1, 2, 3, 8, 9, 10, 11] },
  /* Cross and three pairs; the front-right pair and the last layer free.
     A position where that pair happens to be solved anyway is drawn again:
     the mode promises one pair to go. */
  lastslot: { corners: [0, 1, 2, 3, 4], edges: [0, 1, 2, 3, 8],
              accept: (s) => !home(s, 4, 8) },
  /* Roux: both 1x2x3 blocks built (left on L, right on R, D underneath);
     the four top corners and the six M/U edges free. Centres stay home —
     the solver needs them there — which is the M slice lined up. */
  l10p:     { corners: [0, 1, 2, 3], edges: [0, 1, 2, 3, 5, 7] },
};

/** One random-state scramble for `kind`, as a string of face turns. */
export async function subsetScramble(kind) {
  if (kind === '2gen') return twoGenScramble();
  if (kind === 'lse') return lseScramble();
  const free = FREE[kind];
  if (!free) throw new Error(`no subset called ${kind}`);
  let s;
  do s = randomState(free.corners, free.edges);
  while (isSolved(s) || (free.accept && !free.accept(s)));
  const m = await min2phase();
  const solution = m.solvePattern(facelets(s).join(''));
  if (/error/i.test(solution)) throw new Error(`min2phase: ${solution}`);
  return tidy(invert(solution.trim()));
}

/* =========================================================
   2-gen: the <R,U> group, searched with R and U only
   ========================================================= */

/* Pieces <R,U> moves: the six corners and seven edges off the left block. */
const RU_CORNERS = [0, 1, 2, 3, 4, 7];
const RU_EDGES = [0, 1, 2, 3, 4, 8, 11];
const RU_MOVES = [0, 1, 2, 3, 4, 5];              // U U2 U' R R2 R' in cube3.MOVES
const RU_NAMES = ['U', 'U2', "U'", 'R', 'R2', "R'"];

let RU = null;
/* Every corner position the group reaches (120 arrangements x 243 twists) and
   every edge arrangement (5040), each with a move table and its distance from
   solved. Corners and edges are searched as one, with the larger of the two
   distances as the bound. */
function ruTables() {
  if (RU) return RU;
  const explore = (key) => {
    const index = new Map(), states = [], dist = [];
    const start = SOLVED.slice();
    index.set(key(start), 0); states.push(start); dist.push(0);
    const move = [];
    const buf = new Uint8Array(40);
    for (let i = 0; i < states.length; i++) {
      for (let m = 0; m < 6; m++) {
        mulInto(buf, states[i], MOVES[RU_MOVES[m]]);
        const k = key(buf);
        let j = index.get(k);
        if (j === undefined) {
          j = states.length;
          index.set(k, j); states.push(buf.slice()); dist.push(dist[i] + 1);
        }
        move[i * 6 + m] = j;
      }
    }
    return { index, states, dist: Uint8Array.from(dist), move: Int32Array.from(move), key };
  };
  const corners = explore(s => RU_CORNERS.map(i => s[i] * 3 + s[8 + i]).join(','));
  const edges = explore(s => RU_EDGES.map(i => s[16 + i]).join(','));
  const cParity = corners.states.map(s => parity(RU_CORNERS.map(i => s[i])));
  const eParity = edges.states.map(s => parity(RU_EDGES.map(i => s[16 + i])));
  RU = { corners, edges, cParity, eParity };
  return RU;
}

/** A random <R,U> position and a short R,U-only way to it. */
export function twoGenScramble() {
  const { corners, edges, cParity, eParity } = ruTables();
  /* Every corner position combines with every edge arrangement of the same
     parity, and with nothing else: that is the whole group, so drawing the
     two halves this way draws positions uniformly. */
  let c, e;
  do { c = rand(corners.states.length); e = rand(edges.states.length); }
  while (cParity[c] !== eParity[e] || (c === 0 && e === 0));
  const path = [];
  const search = (c, e, depth, lastFace) => {
    const h = Math.max(corners.dist[c], edges.dist[e]);
    if (h === 0) return true;
    if (h > depth) return false;
    for (let m = 0; m < 6; m++) {
      const face = m < 3 ? 0 : 1;
      if (face === lastFace) continue;
      path.push(m);
      if (search(corners.move[c * 6 + m], edges.move[e * 6 + m], depth - 1, face)) return true;
      path.pop();
    }
    return false;
  };
  for (let depth = 1; ; depth++) if (search(c, e, depth, -1)) break;
  /* `path` solves the position, so the scramble is it backwards. */
  return invert(path.map(m => RU_NAMES[m]).join(' '));
}

/* =========================================================
   Roux LSE: the whole M,U group, breadth first
   ========================================================= */

/* A position is: which edge sits in each of the six slots, whether its two
   stickers are swapped (U/D-coloured sticker on the side), how far the M
   slice's centres have turned, and how far the top layer has turned. That
   is 720 x 64 x 4 x 4 indices, of which the group fills 184,320. */
const UF = 0, UL = 1, UB = 2, UR = 3, DF = 4, DB = 5;
const FACT = [120, 24, 6, 2, 1, 1];
function lseEncode(piece, flip, centre, auf) {
  let perm = 0, flips = 0;
  for (let i = 0; i < 6; i++) {
    let smaller = 0;
    for (let j = i + 1; j < 6; j++) if (piece[j] < piece[i]) smaller++;
    perm += smaller * FACT[i];
    flips = flips * 2 + flip[i];
  }
  return ((perm * 64 + flips) * 4 + centre) * 4 + auf;
}
function lseDecode(x) {
  const auf = x & 3, centre = (x >> 2) & 3;
  let flips = (x >> 4) & 63, perm = x >> 10;
  const flip = [], piece = [], left = [0, 1, 2, 3, 4, 5];
  for (let i = 5; i >= 0; i--) { flip[i] = flips & 1; flips >>= 1; }
  for (let i = 0; i < 6; i++) { const k = Math.floor(perm / FACT[i]); perm %= FACT[i]; piece.push(left.splice(k, 1)[0]); }
  return { piece, flip, centre, auf };
}
/* One quarter turn. U, clockwise from above, sends the front edge left; M
   turns like L, top to front, and turns every edge it moves over. */
const CYCLE = { U: [UF, UL, UB, UR], M: [UB, UF, DF, DB] };
function lseQuarter(st, face) {
  const piece = st.piece.slice(), flip = st.flip.slice();
  const c = CYCLE[face];
  for (let i = 0; i < 4; i++) {
    piece[c[(i + 1) % 4]] = st.piece[c[i]];
    flip[c[(i + 1) % 4]] = st.flip[c[i]] ^ (face === 'M' ? 1 : 0);
  }
  return face === 'U'
    ? { piece, flip, centre: st.centre, auf: (st.auf + 1) & 3 }
    : { piece, flip, centre: (st.centre + 1) & 3, auf: st.auf };
}
const LSE_NAMES = ['U', 'U2', "U'", 'M', 'M2', "M'"];

let LSE = null;
function lseTables() {
  if (LSE) return LSE;
  /* The four parts move independently — a turn permutes the slots, flips by
     slot, and steps the centres or the top layer — so each gets its own
     small move table and a whole move is four lookups. */
  const perm = new Uint16Array(720 * 6), flips = new Uint8Array(64 * 6);
  for (let m = 0; m < 6; m++) {
    const turn = (x) => { let st = lseDecode(x); for (let i = 0; i <= m % 3; i++) st = lseQuarter(st, m < 3 ? 'U' : 'M'); return st; };
    for (let p = 0; p < 720; p++) perm[p * 6 + m] = lseEncode(turn(p << 10).piece, [0, 0, 0, 0, 0, 0], 0, 0) >> 10;
    for (let f = 0; f < 64; f++) flips[f * 6 + m] = (lseEncode([0, 1, 2, 3, 4, 5], turn(f << 4).flip, 0, 0) >> 4) & 63;
  }
  const move = (x, m) => {
    const q = (m % 3) + 1;
    const auf = m < 3 ? ((x & 3) + q) & 3 : x & 3;
    const centre = m < 3 ? (x >> 2) & 3 : (((x >> 2) & 3) + q) & 3;
    return (perm[(x >> 10) * 6 + m] << 10) | (flips[((x >> 4) & 63) * 6 + m] << 4) | (centre << 2) | auf;
  };
  const dist = new Uint8Array(720 * 64 * 16).fill(255);
  const list = new Int32Array(720 * 64 * 16);
  let n = 0;
  dist[0] = 0; list[n++] = 0;
  for (let i = 0; i < n; i++) {
    for (let m = 0; m < 6; m++) {
      const y = move(list[i], m);
      if (dist[y] === 255) { dist[y] = dist[list[i]] + 1; list[n++] = y; }
    }
  }
  LSE = { dist, list: list.slice(0, n), move };
  return LSE;
}

/** A random position of the M,U group, and a shortest way to it. */
export function lseScramble() {
  const { dist, list, move } = lseTables();
  let x = list[1 + rand(list.length - 1)];
  const solution = [];
  while (dist[x] > 0) {
    for (let m = 0; m < 6; m++) {
      const y = move(x, m);
      if (dist[y] === dist[x] - 1) { solution.push(LSE_NAMES[m]); x = y; break; }
    }
  }
  return invert(solution.join(' '));
}

/** How many positions the LSE table holds — for tools/verify-subsets.mjs. */
export const lseSize = () => lseTables().list.length;

/* For tools/verify-subsets.mjs: where an M,U sequence leaves the six edges
   (null if it turns anything else), and whether that position has its edges
   oriented. That is the set solved can reach with the centres off by some
   M, then only moves that keep edges oriented: U, M2, M' U2 M and M U2 M'.
   It is 1/32 of the group, one position per edge-orientation case. */
export function lsePosition(alg) {
  const { move } = lseTables();
  let x = 0;
  for (const tok of alg.split(/\s+/).filter(Boolean)) {
    const m = LSE_NAMES.indexOf(tok.replace("2'", '2'));
    if (m < 0) return null;
    x = move(x, m);
  }
  return x;
}
let ORIENTED = null;
export function lseOriented(x) {
  const { move } = lseTables();
  if (!ORIENTED) {
    const q = [0, move(0, 3), move(0, 4), move(0, 5)];
    ORIENTED = new Set(q);
    for (let i = 0; i < q.length; i++) {
      for (const seq of [[0], [1], [2], [4], [5, 1, 3], [3, 1, 5]]) {   // U U2 U' M2, M' U2 M, M U2 M'
        const y = seq.reduce(move, q[i]);
        if (!ORIENTED.has(y)) { ORIENTED.add(y); q.push(y); }
      }
    }
  }
  return ORIENTED.has(x);
}
export const lseOrientedSize = () => (lseOriented(0), ORIENTED.size);
