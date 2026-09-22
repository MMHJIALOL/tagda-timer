/* ===========================================================
   Import cubingapp's algorithm sets into js/algsets/.

       node tools/import-cubingapp.mjs <folder of cubingapp alg JSON>

   The folder is cubingapp's tanstack/src/routes/algorithms/algs/ — one
   JSON file per set. Fetch each with:

       gh api -H "Accept: application/vnd.github.raw" \
         repos/spencerchubb/cubingapp/contents/tanstack/src/routes/algorithms/algs/PLL.json

   Nothing is copied on trust:

     1. cubingapp's diagrams come from its own cube model. Before a single
        grey-sticker list is converted, that model is ported here and run
        side by side with js/cubenet.js on random sequences using every kind
        of move the data contains (wide, inner-slice, M/E/S, rotations). One
        sequence the two disagree on stops the import.

     2. Every algorithm is parsed strictly for its puzzle and executed
        against its case with the same verifyAlgForCase the page uses. One
        that does not solve its case is dropped and listed.

     3. Every case is checked against what its set promises is already
        solved when you reach it — a PLL case whose first two layers are not
        intact, or an EP case whose corners are not solved, is not that set's
        case, whatever its algorithm does. Such a case is dropped and listed.

     4. Sets the timer already had (PLL, OLL, F2L, ZBLL, the 2x2 sets …)
        keep their own cases. An imported case is matched to one of them by
        executing its algorithm, and its algorithms become that case's extras.

   Writes js/algsets/<ID>.js for new sets and js/algsets/more-<ID>.js for
   extras — only once every set has been processed — then prints what was
   dropped and why.
   =========================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faceletsFor, parseAlg, stickerAt } from '../js/cubenet.js';
import * as P from '../js/puzzles.js';
import { loadSet, registerSet, verifyAlgForCase, alignAlg, algKey, casePattern, countFor, sq1At } from '../js/alglibrary.js';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node tools/import-cubingapp.mjs <folder of cubingapp alg JSON>'); process.exit(2); }
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'algsets');

/* Deterministic, so two runs on the same data print the same report. */
let seed = 0x2f6e2b1;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rand() * a.length)];

/* ---------------------------------------------------------
   1. cubingapp's cube model, and the cross-check against cubenet.js
   --------------------------------------------------------- */

const sq = (x) => x * x;

class PortCube {
  constructor(n) { this.layers = n; this.stickers = Array.from({ length: 6 * n * n }, (_, i) => i); }

  alg(text) { for (const m of text.split(' ').filter(Boolean)) this.move(m); }

  move(token) {
    let s = token, pre = '', post = '';
    const a = /^\d+/.exec(s);
    if (a) { pre = a[0]; s = s.slice(pre.length); }
    const b = /\d+/.exec(s);
    let middle, prime;
    if (b) { post = b[0]; middle = s.slice(0, s.indexOf(post)); prime = s.endsWith("'"); }
    else { prime = s.endsWith("'"); middle = prime ? s.slice(0, -1) : s; }
    const fn = this.map()[middle];
    if (!fn) throw new Error(`port cube: unknown move ${token}`);
    const layer = (parseInt(pre, 10) - 1) || 0;
    for (let i = 0; i < (parseInt(post, 10) || 1); i++) fn(!prime, layer);
  }

  map() {
    const L = this.layers;
    const wide = (axis, a, b, cw) => { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.matchTurn(axis, i, cw); };
    const all = (axis, cw) => { for (let i = 0; i < L; i++) this.matchTurn(axis, i, cw); };
    const slice = (axis, cw) => { for (let i = 1; i < L - 1; i++) this.matchTurn(axis, i, cw); };
    const m = {
      x: (f) => all(0, f), y: (f) => all(1, f), z: (f) => all(2, f),
      U: (f, n) => this.matchTurn(1, n, f), Uw: (f, n) => wide(1, 0, Math.max(n, 1), f),
      D: (f, n) => this.matchTurn(1, L - 1 - n, !f), Dw: (f, n) => wide(1, L - 1, L - 1 - Math.max(n, 1), !f),
      F: (f, n) => this.matchTurn(2, n, f), Fw: (f, n) => wide(2, 0, Math.max(n, 1), f),
      B: (f, n) => this.matchTurn(2, L - 1 - n, !f), Bw: (f, n) => wide(2, L - 1, L - 1 - Math.max(n, 1), !f),
      L: (f, n) => this.matchTurn(0, L - 1 - n, !f), Lw: (f, n) => wide(0, L - 1, L - 1 - Math.max(n, 1), !f),
      R: (f, n) => this.matchTurn(0, n, f), Rw: (f, n) => wide(0, 0, Math.max(n, 1), f),
      M: (f) => slice(0, !f), E: (f) => slice(1, !f), S: (f) => slice(2, f),
    };
    Object.assign(m, { u: m.Uw, d: m.Dw, f: m.Fw, b: m.Bw, l: m.Lw, r: m.Rw });
    return m;
  }

  matchTurn(axis, layer, cw) {
    const L = this.layers;
    if (axis === 0) {
      this.turnX(layer, cw);
      if (layer === 0) this.turnOuter(5, cw); else if (layer === L - 1) this.turnOuter(4, !cw);
    } else if (axis === 1) {
      this.turnY(layer, cw);
      if (layer === 0) this.turnOuter(0, cw); else if (layer === L - 1) this.turnOuter(2, !cw);
    } else {
      this.turnZ(layer, cw);
      if (layer === 0) this.turnOuter(1, cw); else if (layer === L - 1) this.turnOuter(3, !cw);
    }
  }

  turnX(layer, cw) {
    const L = this.layers, n2 = sq(L);
    for (let i = 1; i <= L; i++) {
      this.cycle(cw, n2 - i - layer * L, 3 * n2 + n2 - i - layer * L, 2 * n2 + n2 - i - layer * L, n2 + n2 - i - layer * L);
    }
  }

  turnY(layer, cw) {
    const L = this.layers, n2 = sq(L);
    for (let i = 0; i < L; i++) {
      this.cycle(cw, n2 + i * L + layer, 4 * n2 + i * L + layer, 3 * n2 + (L - i - 1) * L + (L - 1) - layer, 5 * n2 + i * L + layer);
    }
  }

  turnZ(layer, cw) {
    const L = this.layers, n2 = sq(L);
    for (let i = 0; i < L; i++) {
      this.cycle(cw, (i + 1) * L - 1 - layer, 5 * n2 + i + L * layer, 2 * n2 + (L - i - 1) * L + layer, 4 * n2 + n2 - (i + 1) - layer * L);
    }
  }

  turnOuter(face, cw) {
    const L = this.layers;
    for (let i = 0; i < Math.floor(L / 2); i++) {
      const k = this.corners(face, i);
      this.cycle(cw, k.topLeft, k.topRight, k.bottomRight, k.bottomLeft);
      const numEdges = L - 2 * (i + 1);
      for (let j = 0; j < numEdges; j++) {
        const e = this.edges(face, i, j);
        this.cycle(cw, e.top, e.right, e.bottom, e.left);
      }
    }
  }

  cycle(cw, ...idx) {
    const s = this.stickers;
    if (cw) {
      const t = s[idx[idx.length - 1]];
      for (let i = idx.length - 1; i > 0; i--) s[idx[i]] = s[idx[i - 1]];
      s[idx[0]] = t;
    } else {
      const t = s[idx[0]];
      for (let i = 0; i < idx.length - 1; i++) s[idx[i]] = s[idx[i + 1]];
      s[idx[idx.length - 1]] = t;
    }
  }

  corners(face, layer) {
    const L = this.layers, o = face * sq(L);
    return {
      topLeft: o + (L + 1) * layer,
      topRight: o + (L - 1) * (L - layer),
      bottomRight: o + (L + 1) * (L - layer - 1),
      bottomLeft: o + (L - 1) * (layer + 1),
    };
  }

  edges(face, corner, edge) {
    const L = this.layers, k = this.corners(face, corner), numEdges = L - 2 * (corner + 1);
    return {
      top: k.topLeft + L * (edge + 1),
      left: k.topLeft + (numEdges - edge),
      right: k.topRight + edge + 1,
      bottom: k.bottomLeft + L * (numEdges - edge),
    };
  }
}

const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
const PORT_FACE = ['U', 'F', 'D', 'B', 'L', 'R'];

/**
 * Where each of cubingapp's sticker indices sits in cubenet.js's layout — or a
 * thrown error if the two models ever disagree.
 *
 * Each index starts with every sticker position as a candidate and loses the
 * ones whose colour does not match after a random sequence has run on both.
 * If the simulators turned any move differently, some index would run out of
 * candidates. Once every index is down to one position and no two share one,
 * the models agree on every move tried, and grey lists translate through it.
 */
function crossCheck(n, trials = 1500) {
  const moves = ['U', 'D', 'F', 'B', 'L', 'R', 'x', 'y', 'z', 'Uw', 'Dw', 'Fw', 'Bw', 'Lw', 'Rw', 'u', 'd', 'f', 'b', 'l', 'r'];
  if (n >= 3) moves.push('M', 'E', 'S', '2U', '2D', '2F', '2B', '2L', '2R');
  if (n >= 4) moves.push('3Uw', '3Dw', '3Fw', '3Bw', '3Lw', '3Rw');
  const suffix = ['', "'", '2', "2'"];

  const keys = [];
  for (const f of FACES) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) keys.push(`${f}${r}${c}`);
  let cand = Array.from({ length: 6 * n * n }, () => keys.slice());

  for (let t = 0; t < trials; t++) {
    const seq = t === 0 ? '' : Array.from({ length: 24 }, () => pick(moves) + pick(suffix)).join(' ');
    const port = new PortCube(n);
    port.alg(seq);
    const f = faceletsFor(seq, n);
    cand = cand.map((list, i) => {
      const colour = PORT_FACE[Math.floor(port.stickers[i] / (n * n))];
      return list.filter(k => f[k[0]][+k[1]][+k[2]] === colour);
    });
    const empty = cand.findIndex(l => !l.length);
    if (empty >= 0) throw new Error(`${n}x${n}: cubingapp's model and cubenet.js disagree (sticker ${empty}, sequence "${seq}")`);
  }
  const map = cand.map(l => (l.length === 1 ? l[0] : null));
  if (map.includes(null) || new Set(map).size !== map.length) {
    throw new Error(`${n}x${n}: sticker layout is still ambiguous after ${trials} sequences`);
  }
  return map;
}

/* ---------------------------------------------------------
   2. Notation
   --------------------------------------------------------- */

/** One cube algorithm in cubenet's grammar, or null. `R3` is `R'`; brackets go. */
function normCube(alg) {
  const out = [];
  for (const t of alg.replace(/[()[\]]/g, ' ').trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\d*)([A-Za-z]+)(\d*)('?)$/.exec(t);
    if (!m) return null;
    let [, pre, mid, amount, prime] = m;
    if (amount === '3') { amount = ''; prime = prime ? '' : "'"; }
    else if (amount && amount !== '2') return null;
    out.push(pre + mid + amount + prime);
  }
  const s = out.join(' ');
  return s && parseAlg(s) ? s : null;
}

/** One pyraminx/skewb/square-1 algorithm in puzzles.js's grammar, or null. */
function normOther(puzzle, alg) {
  const moves = P.parseMoves(puzzle, puzzle === 'sq1' ? alg : alg.replace(/[()]/g, ' '));
  if (!moves) return null;
  /* parseMoves already spells a pyraminx half turn as the turn it equals. */
  return moves.join(' ');
}

const norm = (puzzle, alg) => (puzzle === 'cube' ? normCube(alg) : normOther(puzzle, alg));

/** The random pre/post moves cubingapp's trainer wraps a case in. */
function fillers(src, key, puzzle) {
  const text = src[key];
  if (!text) return { list: [''], repeat: 1 };
  const arr = /\[([^\]]*)\]/.exec(text);
  const list = JSON.parse(`[${arr[1]}]`).map(s => (s === '' ? '' : norm(puzzle, s)));
  if (list.some(s => s === null)) throw new Error(`${key}: a filler sequence is not valid notation`);
  const loop = /i < (\d+)/.exec(text);
  return { list, repeat: loop ? +loop[1] + 1 : 1 };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------------------------------------------------
   3. What each set promises is already solved
   --------------------------------------------------------- */

function cubeHome(seq, n, keep) {
  const f = faceletsFor(seq, n);
  const top = (n - 1) / 2;
  for (const face of FACES) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const [x, y, z] = stickerAt(face, r, c, n).cubie.split(',').map(Number);
        if (keep(x, y, z, top) && f[face][r][c] !== face) return false;
      }
    }
  }
  return true;
}

/* A case whose algorithm contains a `y` is built on a cube held a different
   way round, so every premise is checked from all 24 orientations. */
const HOLDS = ['', 'x', "x'", 'x2', 'z', "z'"].flatMap(a => ['', 'y', 'y2', "y'"].map(b => [a, b].filter(Boolean).join(' ')));
const anyHold = (seq, test) => HOLDS.some(h => test([seq, h].filter(Boolean).join(' ')));

const PREMISES = {
  /* Last-layer sets: every layer below the top is intact. */
  ll: (seq, n) => anyHold(seq, s => cubeHome(s, n, (x, y, z, top) => y < top)),
  /* …and for a permutation set the top face is already one colour. */
  pll: (seq, n) => anyHold(seq, s => cubeHome(s, n, (x, y, z, top) => y < top)
    && faceletsFor(s, n).U.every(row => row.every(c => c === 'U'))),
  /* Winter Variation: everything below the top but the front-right slot. */
  wv: (seq, n) => anyHold(seq, s => cubeHome(s, n, (x, y, z, top) => y < top && !(x === top && z === top))),
  /* CMLL: the two Roux blocks — the bottom two layers minus the M slice. */
  cmll: (seq, n) => anyHold(seq, s => cubeHome(s, n, (x, y) => y < 1 && x !== 0)),
  /* LSE: both blocks and all four top corners, with the top turned any way.
     The six edges are the M slice's four plus UL and UR. */
  lse: (seq, n) => ['', 'U', 'U2', "U'"].some(a => anyHold(`${seq} ${a}`, s =>
    cubeHome(s, n, (x, y, z, top) => x !== 0 && !(y === top && z === 0)))),
  /* Pyraminx layer-by-layer: all but the three top edges and the tips. */
  'pyra-ll': (seq) => {
    const p = new P.Pyraminx();
    return p.apply(seq) && p.state.every((v, i) =>
      [0, 4, 8].includes(i % 9) || (i < 27 && [1, 3].includes(i % 9)) || v === Math.floor(i / 9));
  },
  /* L4E: the V is built, so the three bottom centre pieces are solved. The top
     one is not part of the V — L4E solves it with the edges. Its sticker on
     each of the three upper faces is index 2. */
  l4e: (seq) => {
    const p = new P.Pyraminx();
    return p.apply(seq) && p.state.every((v, i) =>
      ![2, 5, 7].includes(i % 9) || (i < 27 && i % 9 === 2) || v === Math.floor(i / 9));
  },
  /* Sarah's: the first face — its centre and four corners — on the bottom,
     with the puzzle turned any way about the vertical. */
  'skewb-face': (seq) => ['', 'y', 'y2', "y'"].some(r => {
    const s = new P.Skewb();
    return s.apply(`${seq} ${r}`) && ['D', 'DFL', 'DRF', 'DLB', 'DBR', 'FDR', 'FLD', 'RDB', 'RFD', 'BDL', 'BRD', 'LDF', 'LBD']
      .every(k => s.stickers[k] === k[0]);
  }),
};

/* Square-1 steps build on each other: a case of each set must already be at
   the milestone the step before it finishes at (alglibrary.js defines them). */
const SQ1_BEFORE = { 'SQ1-OBL': 'shape', 'SQ1-EO': 'corner-layers', 'SQ1-CP': 'layers', 'SQ1-EP': 'corners' };

function sq1Premise(setId, seq) {
  const milestone = SQ1_BEFORE[setId];
  if (!milestone) return true;
  const s = new P.SQ1();
  return s.apply(seq) && sq1At(milestone, s);
}

/* ---------------------------------------------------------
   4. The sets
   --------------------------------------------------------- */

const AUF = ['', 'U', 'U2', "U'"];
const AUF_M = AUF.flatMap(u => ['', 'M', 'M2', "M'"].map(m => [u, m].filter(Boolean).join(' ')));
const SQ1_ADJ = ['', '6,0', '0,6', '6,6'];
/* Before a cube shape or CSP algorithm you line the layers up however it
   needs, and that alignment is part of recognising the case — so any turn of
   either layer is allowed first. */
const SQ1_ALIGN = [];
for (let a = -5; a <= 6; a++) for (let b = -5; b <= 6; b++) SQ1_ALIGN.push(a || b ? `${a},${b}` : '');
/* A pyraminx top layer is turned into place before or after as freely as a
   cube's U face. */
const PYRA_ADJ = ['', 'U', "U'"];

const SPECS = [
  { file: 'F2L', merge: 'F2L' },
  { file: '2-Look-OLL', merge: '2LOLL' },
  { file: 'OLL', merge: 'OLL' },
  { file: '2-Look-PLL', merge: '2LPLL' },
  { file: 'PLL', merge: 'PLL' },
  { file: 'ZBLL', merge: 'ZBLL' },
  { file: '2x2-PBL', merge: '222-PBL' },
  { file: '2x2-CLL', merge: '222-CLL' },
  { file: '2x2-EG1', merge: '222-EG1' },
  { file: '2x2-EG2', merge: '222-EG2' },

  { file: 'Winter-Variation', id: 'WV', event: '333', label: 'WV', picture: '3d', trainerMode: 'wv', premise: 'wv',
    title: 'Insert the last pair and orient the last layer in one go', adjust: { pre: AUF, post: AUF } },
  { file: 'COLL', id: 'COLL', event: '333', label: 'COLL', picture: 'll', trainerMode: 'coll', premise: 'll',
    title: 'Solve the last-layer corners with the edges already oriented', adjust: { pre: AUF, post: AUF } },
  { file: 'OLLCP', id: 'OLLCP', event: '333', label: 'OLLCP', picture: 'll', trainerMode: 'ollcp', premise: 'll', firstGroup: true,
    title: 'Orient the last layer and permute its corners together', adjust: { pre: AUF, post: AUF } },
  { file: '2-Look-CMLL', id: 'CMLL2L', event: '333', label: '2-Look CMLL', picture: 'll', trainerMode: 'cmll2look', premise: 'cmll',
    title: 'Orient the top corners, then permute them', adjust: { pre: AUF, post: AUF_M } },
  { file: 'CMLL', id: 'CMLL', event: '333', label: 'CMLL', picture: 'll', trainerMode: 'cmll', premise: 'cmll',
    title: 'Solve the top corners in one look, M slice free', adjust: { pre: AUF, post: AUF_M } },
  { file: 'LSE-EO', id: 'LSEEO', event: '333', label: 'LSE EO', picture: '3d', trainerMode: 'lseeo', premise: 'lse', mergeUD: true,
    title: 'Orient the last six edges', adjust: { pre: AUF_M, post: AUF_M } },
  /* EOLR only asks for edge orientation plus where UL and UR are, so which
     M-slice edge sits where is free — the same U/D merge as LSE EO. */
  { file: 'LSE-EOLR', id: 'LSEEOLR', event: '333', label: 'EOLR', picture: '3d', trainerMode: 'lseeolr', premise: 'lse', mergeUD: true,
    title: 'Orient the edges and bring UL and UR down together', adjust: { pre: AUF_M, post: AUF_M } },
  { file: 'OH-CMLL', id: 'OHCMLL', event: '333oh', label: 'OH CMLL', picture: 'll', trainerMode: 'ohcmll', premise: 'cmll',
    title: 'CMLL picked to be turned with one hand', adjust: { pre: AUF, post: AUF_M } },
  { file: '4x4-PLL-Parity', id: '444-PLLP', event: '444', label: 'PLL Parity', picture: 'll', trainerMode: '444pllp', premise: 'pll',
    /* The source gives no turn to wrap these in, which would deal every case
       from the same angle — so a random AUF either side, as for PLL. */
    title: 'Last-layer permutations that come with 4x4 parity', adjust: { pre: AUF, post: AUF }, fillPre: AUF, fillPost: AUF },

  { file: 'Pyraminx-Last-Layer', id: 'PYRA-LL', event: 'pyram', puzzle: 'pyram', label: 'Last Layer', trainerMode: 'pyrall', premise: 'pyra-ll',
    title: 'The last three edges of layer-by-layer', adjust: { pre: PYRA_ADJ, post: PYRA_ADJ }, fillPost: PYRA_ADJ },
  { file: 'Pyraminx-L4E', id: 'PYRA-L4E', event: 'pyram', puzzle: 'pyram', label: 'L4E', trainerMode: 'pyral4e', premise: 'l4e',
    title: 'The last four edges, after a V on the bottom', adjust: { pre: PYRA_ADJ, post: PYRA_ADJ }, fillPost: PYRA_ADJ },
  { file: 'Sarah-Intermediate', id: 'SKEWB-SI', event: 'skewb', puzzle: 'skewb', label: "Sarah's Intermediate", trainerMode: 'sarahint', premise: 'skewb-face',
    title: 'Solve the opposite face with sledgehammers and hedgeslammers', adjust: { pre: [''], post: ['', 'y', 'y2', "y'"] } },
  { file: 'Sarah-Advanced', id: 'SKEWB-SA', event: 'skewb', puzzle: 'skewb', label: "Sarah's Advanced", trainerMode: 'sarahadv', premise: 'skewb-face', firstGroup: true,
    title: 'Everything after the first face', adjust: { pre: [''], post: ['', 'y', 'y2', "y'"] } },
  { file: 'SQ1-Cube-Shape', id: 'SQ1-SHAPE', event: 'sq1', puzzle: 'sq1', label: 'Cube Shape', trainerMode: 'sq1shape', done: 'shape', mirrorBottom: true, firstGroup: true,
    title: 'Back to a cube from any shape', adjust: { pre: SQ1_ALIGN, post: SQ1_ADJ } },
  { file: 'SQ1-CSP', id: 'SQ1-CSP', event: 'sq1', puzzle: 'sq1', label: 'CSP', trainerMode: 'sq1csp', done: 'shape', mirrorBottom: true, firstGroup: true,
    title: 'Cube shape, with parity fixed on the way', adjust: { pre: SQ1_ALIGN, post: SQ1_ADJ } },
  { file: 'SQ1-OBL', id: 'SQ1-OBL', event: 'sq1', puzzle: 'sq1', label: 'OBL', trainerMode: 'sq1obl', done: 'layers', firstGroup: true,
    title: 'Orient both layers — every piece onto its own layer', adjust: { pre: SQ1_ADJ, post: SQ1_ADJ } },
  { file: 'SQ1-EO', id: 'SQ1-EO', event: 'sq1', puzzle: 'sq1', label: 'EO', trainerMode: 'sq1eo', done: 'layers',
    title: 'Edges onto their layers, once the corners are', adjust: { pre: SQ1_ADJ, post: SQ1_ADJ } },
  /* cubingapp's "before" list for CP is four CP algorithms — `/ 3,-3 / -3,3 /`
     is its own Opp/Opp case — so wrapping a case in one hands you a different
     case. Only half-turns of the layers, which change no case, go around it. */
  { file: 'SQ1-CP', id: 'SQ1-CP', event: 'sq1', puzzle: 'sq1', label: 'CP', trainerMode: 'sq1cp', done: 'corners', fillPre: SQ1_ADJ,
    title: 'Permute the corners', adjust: { pre: SQ1_ADJ, post: SQ1_ADJ } },
  { file: 'SQ1-EP', id: 'SQ1-EP', event: 'sq1', puzzle: 'sq1', label: 'EP', trainerMode: 'sq1ep', done: 'solved',
    title: 'Permute the edges — the last step', adjust: { pre: SQ1_ADJ, post: SQ1_ADJ } },
];

const note = (line) => console.log(line);
const pending = [];
const write = (file, lines) => pending.push([file, lines.join('\n')]);

/* ---- merges into sets the timer already had ---- */

const ORIENTS = [];
for (const flip of ['', 'x', "x'", 'x2', 'z', "z'"]) for (const spin of ['', 'y', 'y2', "y'"]) ORIENTS.push([flip, spin].filter(Boolean).join(' '));
const centres = (f) => Object.fromEntries(FACES.map(face => [face, f[face][1][1]]));
const ORIENT_FROM = ORIENTS.map(rot => ({ rot, from: centres(faceletsFor(rot, 3)) }));

/** A 3x3 state as a string, turned so the centres are home — "solved" ignores orientation. */
function canonical(seq) {
  const a = centres(faceletsFor(seq, 3));
  const { rot } = ORIENT_FROM.find(({ from }) => FACES.every(face => a[from[face]] === face));
  const f = faceletsFor([seq, rot].filter(Boolean).join(' '), 3);
  return FACES.map(face => f[face].flat().join('')).join('');
}

const invertCube = (alg) => alg.split(' ').reverse()
  .map(m => (m.endsWith("'") ? m.slice(0, -1) : m.endsWith('2') ? m : `${m}'`)).join(' ');

/**
 * Which existing case an imported algorithm solves.
 *
 * Where a set's standard is a fully solved 3x3 the answer is looked up: an alg
 * A solves case X exactly when A's inverse is X's state with some U turn
 * either side, so every case is indexed under its sixteen AUF variants, and
 * the hit is then confirmed with verifyAlgForCase. Any other set is searched
 * case by case with verifyAlgForCase itself.
 */
function matcher(set) {
  const exact = (set.n || 3) === 3 && !set.done && set.id !== 'F2L' && !set.cases.some(c => c.done);
  if (!exact) return (alg) => set.cases.find(c => verifyAlgForCase(set.id, c.id, alg))?.id || null;
  const index = new Map();
  for (const c of set.cases) {
    const p = casePattern(set.id, c.id);
    for (const a of AUF) for (const b of AUF) index.set(canonical([b, p, a].filter(Boolean).join(' ')), c.id);
  }
  return (alg) => {
    const id = index.get(canonical(invertCube(alg)));
    return id && verifyAlgForCase(set.id, id, alg) ? id : null;
  };
}

async function merge(spec, src) {
  const set = await loadSet(spec.merge);
  set.extra = {};
  const find = matcher(set);
  const extra = {};
  let added = 0, dropped = 0;

  for (const [name, cd] of Object.entries(src.cases)) {
    const algs = Object.entries(cd.algs).map(([raw, meta]) => ({ raw, alg: normCube(raw), note: meta.note }));
    for (const a of algs.filter(x => !x.alg)) { dropped++; note(`  ${spec.merge} "${name}": not notation — ${a.raw}`); }
    const good = algs.filter(a => a.alg);
    let caseId = null;
    for (const a of good) if ((caseId = find(a.alg))) break;
    if (!caseId) { dropped += good.length; note(`  ${spec.merge} "${name}": matches no case — ${good.map(a => a.alg).join(' | ')}`); continue; }

    const known = [...(set.library[caseId]?.alternates || []), { alg: set.cases.find(c => c.id === caseId).alg }];
    for (const a of good) {
      /* Matched to the case with a free U turn either side; stored with the
         one it needs in front, so it works from the picture. */
      const aligned = verifyAlgForCase(set.id, caseId, a.alg) && alignAlg(set.id, caseId, a.alg);
      if (!aligned) { dropped++; note(`  ${spec.merge} "${name}" → ${caseId}: does not solve — ${a.alg}`); continue; }
      /* The library's own spelling wins, so a saved order that names it still finds it. */
      const same = known.find(k => algKey(set.id, k.alg) === algKey(set.id, aligned));
      const list = (extra[caseId] ||= []);
      const alg = same ? same.alg : aligned;
      if (list.some(e => algKey(set.id, e.alg) === algKey(set.id, alg))) continue;
      const notes = a.note || same?.notes;
      list.push({ alg, moveCount: countFor(set.id, alg), ...(notes ? { notes } : {}) });
      if (!same) added++;
    }
  }

  note(`${spec.merge.padEnd(10)} ${Object.keys(extra).length}/${set.cases.length} cases matched · ${added} new algorithms · ${dropped} dropped`);
  write(`more-${spec.merge}.js`, [
    `/* GENERATED by tools/import-cubingapp.mjs from ${spec.file}.json — do not hand-edit.`,
    `   More algorithms for the ${spec.merge} cases, in the order that list gives them.`,
    '   Every one was executed against the case it is filed under. */',
    'export const EXTRA = {',
    ...Object.entries(extra).map(([id, list]) => `  ${JSON.stringify(id)}: ${JSON.stringify(list)},`),
    '};',
    '',
  ]);
}

/* ---- new sets ---- */

async function build(spec, src, maps) {
  const puzzle = spec.puzzle || 'cube';
  const n = puzzle === 'cube' ? parseInt(src.puzzle, 10) : undefined;
  const gray = puzzle === 'cube'
    ? (src.gray || []).map(i => maps[n][i])
    : puzzle === 'skewb' ? (src.gray || []) : [];

  const ids = new Set();
  const cases = [], algsOf = {};
  let dropped = 0;
  for (const [name, cd] of Object.entries(src.cases)) {
    const algs = Object.entries(cd.algs).map(([raw, meta]) => ({
      raw, alg: norm(puzzle, raw), note: meta.note,
      setup: meta.setup ? norm(puzzle, meta.setup) : '',
    }));
    for (const a of algs.filter(x => !x.alg || x.setup === null)) { dropped++; note(`  ${spec.id} "${name}": not notation — ${a.raw}`); }
    const good = algs.filter(a => a.alg && a.setup !== null);
    if (!good.length) continue;

    const base = `${spec.id}-${slug(name)}`.slice(0, 60);
    let id = base;
    for (let k = 2; ids.has(id); k++) id = `${base.slice(0, 57)}-${k}`;
    ids.add(id);
    cases.push({ id, name, ...(cd.subset ? { group: cd.subset } : {}), alg: good[0].alg, ...(good[0].setup ? { setup: good[0].setup } : {}) });
    algsOf[id] = good;
  }

  const pre = spec.fillPre ? { list: spec.fillPre, repeat: 1 } : fillers(src, 'before', puzzle);
  const post = spec.fillPost ? { list: spec.fillPost, repeat: 1 } : fillers(src, 'after', puzzle);
  const data = {
    id: spec.id, event: spec.event, puzzle, ...(n ? { n } : {}),
    label: spec.label, title: spec.title,
    ...(spec.picture ? { picture: spec.picture } : {}),
    ...(gray.length ? { gray } : {}),
    ...(spec.done ? { done: spec.done } : {}),
    ...(spec.mergeUD ? { mergeUD: true } : {}),
    ...(spec.mirrorBottom ? { mirrorBottom: true } : {}),
    adjust: spec.adjust || { pre: [''], post: [''] },
    scramble: { pre: pre.list, post: post.list, ...(pre.repeat > 1 ? { preRepeat: pre.repeat } : {}) },
    trainerMode: spec.trainerMode,
    cases,
    library: {},
  };
  await registerSet(data);

  const keep = [], library = {};
  let algCount = 0;
  for (const c of cases) {
    const from = casePattern(spec.id, c.id);
    const premise = puzzle === 'sq1' ? sq1Premise(spec.id, from) : spec.premise ? PREMISES[spec.premise](from, n) : true;
    if (!premise) { dropped += algsOf[c.id].length; note(`  ${spec.id} "${c.name}": breaks what the set assumes is already solved — ${c.alg}`); continue; }
    const list = [];
    for (const a of algsOf[c.id]) {
      if (!verifyAlgForCase(spec.id, c.id, a.alg)) { dropped++; note(`  ${spec.id} "${c.name}": does not solve — ${a.alg}`); continue; }
      /* LSE's free opening M is not a U turn, so its algs stay as written. */
      const alg = alignAlg(spec.id, c.id, a.alg) || a.alg;
      if (list.some(e => algKey(spec.id, e.alg) === algKey(spec.id, alg))) continue;
      list.push({ alg, moveCount: countFor(spec.id, alg), ...(a.note ? { notes: a.note } : {}) });
    }
    if (!list.length) { note(`  ${spec.id} "${c.name}": no algorithm survived`); continue; }
    keep.push(c);
    library[c.id] = { alternates: list };
    algCount += list.length;
  }
  if (!keep.length) throw new Error(`${spec.id}: no case survived verification`);

  const used = new Set(keep.map(c => c.group).filter(Boolean));
  const groups = (src.subsets || []).filter(g => used.has(g));
  const { cases: _c, library: _l, trainerMode, ...head } = data;
  const meta = {
    ...head,
    ...(groups.length ? { groups, defaultGroup: spec.firstGroup ? groups[0] : null } : {}),
    trainerMode,
  };
  await registerSet({ ...meta, cases: keep, library });
  note(`${spec.id.padEnd(10)} ${keep.length}/${Object.keys(src.cases).length} cases · ${algCount} algorithms · ${dropped} dropped`);

  write(`${spec.id}.js`, [
    `/* GENERATED by tools/import-cubingapp.mjs from ${spec.file}.json — do not hand-edit.`,
    '   Every case below sits where its set says it should, and every algorithm',
    '   was executed against the case it is filed under. */',
    'export const SET = {',
    ...Object.entries(meta).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    '  "cases": [',
    ...keep.map(c => `    ${JSON.stringify(c)},`),
    '  ],',
    '  "library": {',
    ...Object.entries(library).map(([id, v]) => `    ${JSON.stringify(id)}: ${JSON.stringify(v)},`),
    '  },',
    '};',
    '',
  ]);
}

/* ---------------------------------------------------------
   Run
   --------------------------------------------------------- */

const maps = {};
for (const n of [2, 3, 4]) maps[n] = crossCheck(n);
console.log('cross-check: cubingapp and cubenet.js agree on every move tried, on 2x2, 3x3 and 4x4');

for (const spec of SPECS) {
  const src = JSON.parse(fs.readFileSync(path.join(SRC, `${spec.file}.json`), 'utf8'));
  if (spec.merge) await merge(spec, src);
  else await build(spec, src, maps);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [file, text] of pending) fs.writeFileSync(path.join(OUT, file), text);
console.log(`wrote ${pending.length} files to js/algsets/`);
