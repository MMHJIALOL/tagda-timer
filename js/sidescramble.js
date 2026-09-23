/* ===========================================================
   Tagda Timer — square-1 and clock scrambles, made here

   cubing.js makes these in its search worker. In Firefox a square-1 there
   takes 15-27 seconds (the twsearch WebAssembly is that slow in SpiderMonkey),
   and because the worker does one thing at a time, every pyraminx, skewb and
   clock queued behind it waited too. Both are random-state and both finish
   here in milliseconds, on the page, in any browser.

   Square-1 uses cubing.js's own 24-wedge model -- slots 0-11 the top layer,
   12-23 the bottom, (x, y) turning each layer x (or y) wedges forward and
   "/" swapping slots 6-11 with 12-17 -- so the notation it writes is exactly
   the notation the preview and every other square-1 program reads.
   =========================================================== */

/* ---------------- clock ---------------- */

/* The WCA order. Every dial amount is uniform in -5..6, and the fourteen moves
   act on the fourteen dials as an invertible map, so random amounts are a
   random state. */
const CLOCK_MOVES = ['UR', 'DR', 'DL', 'UL', 'U', 'R', 'D', 'L', 'ALL', 'y2', 'U', 'R', 'D', 'L', 'ALL'];

export function clockScramble(rand = Math.random) {
  return CLOCK_MOVES.map((m) => {
    if (m === 'y2') return m;
    const n = Math.floor(rand() * 12) - 5;          // -5..6
    return `${m}${Math.abs(n)}${n < 0 ? '-' : '+'}`;
  }).join(' ');
}

/* ---------------- square-1: the model ---------------- */

/* Solved, in cubing.js's slot order: the top layer starts on a corner, the
   bottom on an edge. Corners 0-7 fill two slots each, edges 8-15 one. Found by
   replaying cubing.js's own scrambles: this is the only layout on which every
   one of their slashes is legal. The bottom edges are numbered so that HOME,
   one wedge round, reads 0-7 and 8-15 in position order. */
const SOLVED = [0, 0, 8, 1, 1, 9, 2, 2, 10, 3, 3, 11, 15, 4, 4, 12, 5, 5, 13, 6, 6, 14, 7, 7];

function turn(s, x, y) {
  const o = new Array(24);
  for (let j = 0; j < 12; j++) {
    o[((j + x) % 12 + 12) % 12] = s[j];
    o[12 + ((j + y) % 12 + 12) % 12] = s[12 + j];
  }
  return o;
}

function slash(s) {
  const o = s.slice();
  for (let j = 6; j < 12; j++) { o[j] = s[j + 6]; o[j + 6] = s[j]; }
  return o;
}

/* Which slots start a piece: an edge, or the first wedge of a corner. */
function maskOf(s) {
  let m = 0;
  for (let j = 0; j < 24; j++) {
    const prev = j < 12 ? (j + 11) % 12 : 12 + (j - 1) % 12;
    if (s[prev] !== s[j]) m |= 1 << j;
  }
  return m;
}

/* The parity no square-keeping move can change: of the pieces read in slot
   order, top then bottom. A shape can be solved to a square in either parity,
   but only one of them then solves, so phase 1 has to aim for that one. */
function parityOf(s) {
  const seq = [];
  for (let j = 0; j < 24; j++) {
    const prev = j < 12 ? (j + 11) % 12 : 12 + (j - 1) % 12;
    if (s[prev] !== s[j]) seq.push(s[j]);
  }
  let p = 0;
  for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) if (seq[j] < seq[i]) p ^= 1;
  return p;
}

const rotMask = (m, x, y) => {
  const t = m & 0xfff, b = m >>> 12;
  const r = (v, k) => ((v << k) | (v >>> (12 - k))) & 0xfff;
  return r(t, x) | (r(b, y) << 12);
};
const TWIST = 1 | 1 << 6 | 1 << 12 | 1 << 18;
const twistable = m => (m & TWIST) === TWIST;
const slashMask = m => (m & ~(0x3f << 6) & ~(0x3f << 12)) | ((m >>> 6) & 0x3f) << 12 | ((m >>> 12) & 0x3f) << 6;

const bits = (v) => { let n = 0; for (; v; v &= v - 1) n++; return n; };
/* How the reading-order parity changes, from the shape alone. Turning a layer
   of n pieces so that k of them pass slot 0 is a cyclic shift: k(n-1). A slash
   swaps the block of pieces in slots 6-11 with the block in 12-17. */
const turnParity = (m, x, y) => {
  const t = m & 0xfff, b = m >>> 12;
  const wrap = (v, k) => bits(v >>> (12 - k)) * (bits(v) - 1);
  return (wrap(t, x) + wrap(b, y)) & 1;
};
const slashParity = m => (bits((m >>> 6) & 0x3f) * bits((m >>> 12) & 0x3f)) & 1;

/* ---------------- phase 1: any shape to a square ---------------- */

/* Phase 2 happens with both layers starting on a corner -- that alignment is
   the one a slash keeps square. The solved puzzle is one bottom wedge away. */
const HOME = turn(SOLVED, 0, -1);
const HOME_KEY = maskOf(HOME) * 2 + parityOf(HOME);

let shapeDist = null;           // twistable mask * 2 + parity -> slashes to HOME
let shapes = null;              // every twistable mask, for picking one at random

/* Backwards from HOME: whatever a slash and then a turn reaches is one
   "(x, y) /" further away. */
function buildShapes() {
  shapeDist = new Map([[HOME_KEY, 0]]);
  let frontier = [HOME_KEY];
  for (let d = 0; frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      const m = Math.floor(k / 2), s = slashMask(m), p = (k & 1) ^ slashParity(m);
      for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) {
        const r = rotMask(s, x, y);
        if (!twistable(r)) continue;
        const key = r * 2 + (p ^ turnParity(s, x, y));
        if (!shapeDist.has(key)) { shapeDist.set(key, d + 1); next.push(key); }
      }
    }
    frontier = next;
  }
  shapes = [...new Set([...shapeDist.keys()].map(k => Math.floor(k / 2)))];
}

/* ---------------- phase 2: square to solved ---------------- */

// At HOME: corners start on slots 0,3,6,9 and 12,15,18,21; edges one after.
const CPOS = [0, 3, 6, 9, 12, 15, 18, 21];
const EPOS = [2, 5, 8, 11, 14, 17, 20, 23];
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040];

function permIndex(p) {
  let idx = 0;
  for (let i = 0; i < 8; i++) {
    let c = 0;
    for (let j = i + 1; j < 8; j++) if (p[j] < p[i]) c++;
    idx += c * FACT[7 - i];
  }
  return idx;
}
function permOf(idx) {
  const left = [0, 1, 2, 3, 4, 5, 6, 7], p = [];
  for (let i = 0; i < 8; i++) { const f = FACT[7 - i]; p.push(left.splice(Math.floor(idx / f), 1)[0]); idx %= f; }
  return p;
}

/* The phase-2 moves, each keeping the puzzle a square at HOME's alignment:
   a quarter turn of the top, of the bottom, a slash, and a slash with both
   layers one wedge round -- (1, 1) / (-1, -1). That last one is what moves
   an edge away from the corner beside it; without it they travel in pairs.
   Each is read off the model: where does the piece in position k end up. */
const P2_MOVES = [
  s => turn(s, 3, 0),
  s => turn(s, 0, 3),
  slash,
  s => turn(slash(turn(s, 1, 1)), -1, -1),
];
const P2 = P2_MOVES.map((f) => {
  const t = f(HOME);
  return {
    c: CPOS.map((_, k) => CPOS.findIndex(p => t[p] === k)),
    e: EPOS.map((_, k) => EPOS.findIndex(p => t[p] === k + 8)),
  };
});

let moveC = null, moveE = null; // [move][perm index]
let setOf = null;               // perm index -> where pieces 0-3 are, as 0..69
let prunC = null, prunE = null; // (perm * 70 + set) * 2 + middle -> slashes

function buildPhase2() {
  const perms = [];
  for (let i = 0; i < 40320; i++) perms.push(permOf(i));
  const q = new Array(8);
  const permMoves = to => {
    const t = new Int32Array(40320);
    for (let i = 0; i < 40320; i++) {
      const p = perms[i];
      for (let k = 0; k < 8; k++) q[to[k]] = p[k];
      t[i] = permIndex(q);
    }
    return t;
  };
  moveC = P2.map(m => permMoves(m.c));
  moveE = P2.map(m => permMoves(m.e));

  /* Which four of the eight positions hold the top layer's pieces: 70 ways. */
  const setIdx = new Int8Array(256).fill(-1), setMask = [];
  for (let m = 0; m < 256; m++) if (bits(m) === 4) { setIdx[m] = setMask.length; setMask.push(m); }
  setOf = new Uint8Array(40320);
  for (let i = 0; i < 40320; i++) {
    const p = perms[i];
    let m = 0;
    for (let k = 0; k < 8; k++) if (p[k] < 4) m |= 1 << k;
    setOf[i] = setIdx[m];
  }
  const setMoves = to => setMask.map((m) => {
    let n = 0;
    for (let k = 0; k < 8; k++) if (m >> k & 1) n |= 1 << to[k];
    return setIdx[n];
  });
  const setC = P2.map(m => setMoves(m.c)), setE = P2.map(m => setMoves(m.e));

  /* The order of one kind of piece, which positions the top pieces of the
     other kind are in, and the middle layer: slashes to solved. A turn of
     either layer before the next slash costs nothing, so every entry is
     written together with its 16 turns and the search walks only one. */
  const fill = (mp, ms) => {
    const prun = new Int8Array(40320 * 70 * 2).fill(-1);
    const [u, uS, dn, dS] = [mp[0], ms[0], mp[1], ms[1]];
    const rp = new Int32Array(16), rs = new Int32Array(16);
    const turns = (p, st) => {
      for (let a = 0, i = 0; a < 4; a++, p = u[p], st = uS[st])
        for (let b = 0, q = p, t = st; b < 4; b++, q = dn[q], t = dS[t], i++) { rp[i] = q; rs[i] = t; }
    };
    // Every turn of an unseen entry is unseen too: one check, 16 writes.
    const mark = (p, st, mid, d) => {
      if (prun[(p * 70 + st) * 2 + mid] >= 0) return false;
      for (let a = 0; a < 4; a++, p = u[p], st = uS[st])
        for (let b = 0, q = p, t = st; b < 4; b++, q = dn[q], t = dS[t]) prun[(q * 70 + t) * 2 + mid] = d;
      return true;
    };
    mark(0, setOf[0], 0, 0);
    let frontier = [setOf[0] * 2];
    for (let d = 0; frontier.length; d++) {
      const next = [];
      for (const k of frontier) {
        const mid = (k & 1) ^ 1;
        turns(Math.floor((k >> 1) / 70), (k >> 1) % 70);
        for (let i = 0; i < 16; i++) {
          for (let m = 2; m < 4; m++) {
            const sp = mp[m][rp[i]], ss = ms[m][rs[i]];
            if (mark(sp, ss, mid, d + 1)) next.push((sp * 70 + ss) * 2 + mid);
          }
        }
      }
      frontier = next;
    }
    return prun;
  };
  prunC = fill(moveC, setE);
  prunE = fill(moveE, setC);
}

const h2 = (c, e, mid) => Math.max(prunC[(c * 70 + setOf[e]) * 2 + mid], prunE[(e * 70 + setOf[c]) * 2 + mid]);

/* The path gathers [a, b, slash] -- a and b quarter turns, then slash 2 (plain)
   or 3 (shifted) -- and ends with the [a, b] that lands on HOME. */
function phase2(c, e, mid) {
  const path = [];
  const search = (c, e, mid, depth, last) => {
    for (let a = 0, tc = c, te = e; a < 4; a++, tc = moveC[0][tc], te = moveE[0][te]) {
      for (let b = 0, bc = tc, be = te; b < 4; b++, bc = moveC[1][bc], be = moveE[1][be]) {
        if (depth === 0) {
          if (!mid && bc === 0 && be === 0) { path.push([a, b]); return true; }
          continue;
        }
        for (const m of [2, 3]) {
          // The same slash twice in a row, with no turn between, undoes itself.
          if (a === 0 && b === 0 && m === last) continue;
          const nc = moveC[m][bc], ne = moveE[m][be], nm = mid ^ 1;
          if (h2(nc, ne, nm) > depth - 1) continue;
          path.push([a, b, m]);
          if (search(nc, ne, nm, depth - 1, m)) return true;
          path.pop();
        }
      }
    }
    return false;
  };
  for (let depth = h2(c, e, mid); ; depth++) {
    if (search(c, e, mid, depth, 0)) return path;
  }
}

/* ---------------- the scramble ---------------- */

const norm = v => { v = ((v % 12) + 12) % 12; return v > 6 ? v - 12 : v; };

/** A random-state square-1 scramble, in WCA notation. */
export function sq1Scramble(rand = Math.random) {
  if (!shapeDist) buildShapes();
  if (!moveC) buildPhase2();

  // A random state: a random twistable shape, its corners and edges shuffled.
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let state, key;
  do {
    const mask = shapes[Math.floor(rand() * shapes.length)];
    const cs = shuffle([0, 1, 2, 3, 4, 5, 6, 7]), es = shuffle([8, 9, 10, 11, 12, 13, 14, 15]);
    state = new Array(24);
    for (let j = 0, ci = 0, ei = 0; j < 24; j++) {
      if (!(mask >> j & 1)) continue;
      const next = j < 12 ? (j + 1) % 12 : 12 + (j - 11) % 12;
      if (mask >> next & 1) state[j] = es[ei++];
      else state[j] = state[next] = cs[ci++];
    }
    key = mask * 2 + parityOf(state);
  } while (!shapeDist.has(key));
  let mid = rand() < 0.5 ? 1 : 0;

  // Solve it. Moves are [x, y] turns and '/' slashes.
  const sol = [];
  while (shapeDist.get(key) > 0) {
    const d = shapeDist.get(key), m = Math.floor(key / 2), opts = [];
    for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) {
      const r = rotMask(m, x, y);
      if (!twistable(r)) continue;
      const k = slashMask(r) * 2 + ((key & 1) ^ turnParity(m, x, y) ^ slashParity(r));
      if (shapeDist.get(k) === d - 1) opts.push([x, y, k]);
    }
    const [x, y, k] = opts[Math.floor(rand() * opts.length)];
    state = slash(turn(state, x, y)); mid ^= 1; key = k;
    sol.push([x, y], '/');
  }
  const c = permIndex(CPOS.map(p => state[p])), e = permIndex(EPOS.map(p => state[p] - 8));
  const p2 = phase2(c, e, mid);
  for (const [a, b, m] of p2) {
    if (m === 3) sol.push([3 * a + 1, 3 * b + 1], '/', [-1, -1]);
    else if (m === 2) sol.push([3 * a, 3 * b], '/');
    else sol.push([3 * a, 3 * b]);
  }
  sol.push([0, 1]);             // HOME back to solved

  /* Tidy: neighbouring turns add up, and two slashes with nothing but a whole
     turn between them cancel -- where the phases meet, that happens. */
  const tidy = [];
  for (const t of sol) {
    const top = tidy[tidy.length - 1];
    if (t !== '/') {
      if (top && top !== '/') { top[0] += t[0]; top[1] += t[1]; } else tidy.push([t[0], t[1]]);
      continue;
    }
    if (top && top !== '/' && !norm(top[0]) && !norm(top[1])) tidy.pop();
    if (tidy[tidy.length - 1] === '/') tidy.pop(); else tidy.push('/');
  }

  // The scramble is the solution backwards: slashes stay, turns negate.
  return tidy.reverse()
    .map(t => (t === '/' ? t : norm(t[0]) || norm(t[1]) ? `(${norm(-t[0])}, ${norm(-t[1])})` : ''))
    .filter(Boolean).join(' ');
}

/* For the self test: play a scramble on the model. Returns null the moment a
   slash would cut through a corner. */
export function sq1Apply(scramble, state = SOLVED) {
  let s = state.slice(), mid = 0;
  for (const tok of scramble.match(/\(\s*-?\d+\s*,\s*-?\d+\s*\)|\//g) || []) {
    if (tok === '/') {
      if (!twistable(maskOf(s))) return null;
      s = slash(s); mid ^= 1;
    } else {
      const [x, y] = tok.match(/-?\d+/g).map(Number);
      s = turn(s, x, y);
    }
  }
  return { state: s, mid };
}
export const SQ1_SOLVED = SOLVED;
