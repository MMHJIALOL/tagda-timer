import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Pyraminx, Skewb and Square-1 for the alg library.

   Just enough of each puzzle to draw a case and to check that an
   algorithm solves it. Cubes are not here: js/cubenet.js simulates every
   NxN size already.

   Every move parser here is strict. A token that is not a move — or, on a
   Square-1, a turn that would cut through a corner — makes the whole
   sequence invalid instead of being skipped, because a skipped token is how
   a wrong algorithm gets reported as a right one.

   The move tables and diagram geometry are ported from cubingapp's
   src/utils/puzzles.ts, the model the imported algorithm sets were written
   against, so a case is drawn and checked on the same puzzle its
   algorithms describe. That code is under the MIT License:

     Copyright (c) 2024 Spencer Chubb

     Permission is hereby granted, free of charge, to any person obtaining a
     copy of this software and associated documentation files (the
     "Software"), to deal in the Software without restriction, including
     without limitation the rights to use, copy, modify, merge, publish,
     distribute, sublicense, and/or sell copies of the Software, and to
     permit persons to whom the Software is furnished to do so, subject to
     the following conditions:

     The above copyright notice and this permission notice shall be included
     in all copies or substantial portions of the Software.

     THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
     OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
     MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
     IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
     CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
     TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
     SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
   =========================================================== */

const GREY = '#3b3b4e';

/** Rotate `c` one step in place: the sticker at c[i] moves to c[i+1]. */
function cycle(state, c, forward) {
  const order = forward ? c : [...c].reverse();
  const last = state[order[order.length - 1]];
  for (let i = order.length - 1; i > 0; i--) state[order[i]] = state[order[i - 1]];
  state[order[0]] = last;
}
const cycles = (state, list, forward) => list.forEach(c => cycle(state, c, forward));

const toks = (alg) => String(alg || '').replace(/[()]/g, ' ').trim().split(/\s+/).filter(Boolean);

function rotatePoints(points, cx, cy, deg) {
  const rad = (deg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  return points.split(' ').map(pt => {
    const [x, y] = pt.split(',').map(parseFloat);
    return `${Math.floor(cos * (x - cx) + sin * (y - cy) + cx)},${Math.floor(cos * (y - cy) - sin * (x - cx) + cy)}`;
  }).join(' ');
}

/* ---------------------------------------------------------
   Pyraminx
   --------------------------------------------------------- */

/* 9 stickers a face, in the order F L R D. Within a face: 0, 4, 8 are the
   tips; 2, 5, 7 the centre pieces under them; 1, 3, 6 the edges. */
const PYRA_MOVES = {
  U: [[1, 10, 19], [2, 11, 20], [3, 12, 21], [0, 9, 18]],
  L: [[1, 30, 15], [5, 29, 16], [6, 28, 12], [4, 27, 17]],
  R: [[3, 24, 30], [7, 23, 34], [6, 19, 33], [8, 22, 35]],
};
const PYRA_TOKEN = /^([ULR])(2?)('?)$/;

export class Pyraminx {
  constructor() { this.state = Array.from({ length: 36 }, (_, i) => Math.floor(i / 9)); }

  /** Apply a sequence. False, with the state left undefined, on anything that is not a move. */
  apply(alg) {
    for (const t of toks(alg)) {
      const m = PYRA_TOKEN.exec(t);
      if (!m) return false;
      /* A pyraminx layer has order 3, so a half turn is the inverse turn. */
      cycles(this.state, PYRA_MOVES[m[1]], (m[2] === '2') === (m[3] === "'"));
    }
    return true;
  }

  svg() {
    const colours = ['#00b04a', '#ec0000', '#0051ba', '#ffe100'];
    const tris = [
      t('500,577 666,673 334,673'), t('500,770 334,673 166,770'), t('500,770 666,673 334,673'),
      t('500,770 666,673 834,770'), t('10,860 166,770 334,860'), t('500,770 334,860 166,770'),
      t('500,770 334,860 666,860'), t('500,770 666,860 834,770'), t('990,860 666,860 834,770'),
    ];
    let out = '';
    tris.forEach((pts, i) => {
      out += `<polygon fill="${colours[this.state[i]]}" points="${pts}"/>`;
      out += `<polygon fill="${colours[this.state[i + 9]]}" points="${rotatePoints(pts, 500, 577, 240)}"/>`;
      out += `<polygon fill="${colours[this.state[i + 18]]}" points="${rotatePoints(pts, 500, 577, 120)}"/>`;
    });
    /* Stroke on a <g>, not the <svg>: the app's base stylesheet styles
       svg[viewBox] directly, which would beat attributes on that element. */
    return `<svg viewBox="0 0 1000 870"><g stroke="#101014" stroke-width="14" stroke-linejoin="round">${out}</g></svg>`;
  }
}

/* ---------------------------------------------------------
   Skewb — R turns the corner at up-front-right, F the one at up-front-left
   --------------------------------------------------------- */

const SKEWB_STICKERS = [
  'U', 'UBL', 'URB', 'UFR', 'ULF', 'F', 'FUL', 'FRU', 'FDR', 'FLD', 'R', 'RUF', 'RBU', 'RDB', 'RFD',
  'B', 'BLU', 'BUR', 'BDL', 'BRD', 'L', 'LFU', 'LUB', 'LDF', 'LBD', 'D', 'DFL', 'DRF', 'DLB', 'DBR',
];
const SKEWB_MOVES = {
  R: [['U', 'R', 'F'], ['UFR', 'RUF', 'FRU'], ['ULF', 'RBU', 'FDR'], ['FUL', 'URB', 'RFD'], ['LFU', 'BUR', 'DRF']],
  F: [['U', 'F', 'L'], ['ULF', 'FUL', 'LFU'], ['UFR', 'FLD', 'LUB'], ['FRU', 'LDF', 'UBL'], ['RUF', 'DFL', 'BLU']],
  y: [['F', 'L', 'B', 'R'], ['ULF', 'UBL', 'URB', 'UFR'], ['LFU', 'BLU', 'RBU', 'FRU'], ['FUL', 'LUB', 'BUR', 'RUF'], ['DFL', 'DLB', 'DBR', 'DRF'], ['FLD', 'LBD', 'BRD', 'RFD'], ['LDF', 'BDL', 'RDB', 'FDR']],
  z: [['U', 'R', 'D', 'L'], ['ULF', 'RUF', 'DRF', 'LDF'], ['LFU', 'UFR', 'RFD', 'DFL'], ['FUL', 'FRU', 'FDR', 'FLD'], ['UBL', 'RBU', 'DBR', 'LBD'], ['BLU', 'BUR', 'BRD', 'BDL'], ['LUB', 'URB', 'RDB', 'DLB']],
};
const SKEWB_TOKEN = /^([RFyz])(2?)('?)$/;

export class Skewb {
  constructor() {
    this.stickers = {};
    for (const s of SKEWB_STICKERS) this.stickers[s] = s[0];
  }

  /** Stickers named here are painted grey wherever they end up. */
  grey(names) { for (const n of names || []) this.stickers[n] = 'X'; return this; }

  apply(alg) {
    for (const t of toks(alg)) {
      const m = SKEWB_TOKEN.exec(t);
      if (!m) return false;
      const [, move, two, prime] = m;
      const rot = move === 'y' || move === 'z';
      if (two && !rot) return false;
      for (let i = 0; i < (two ? 2 : 1); i++) cycles(this.stickers, SKEWB_MOVES[move], !prime);
    }
    return true;
  }

  svg() {
    /* Yellow on top, green in front, orange on the right — the same way round
       every cube case on the page is drawn. */
    const c = { U: '#ffe100', D: '#ffffff', F: '#00b04a', B: '#0051ba', R: '#ff8b00', L: '#ec0000', X: GREY };
    const p = (n, pts) => `<polygon fill="${c[this.stickers[n]]}" points="${pts}"/>`;
    return `<svg viewBox="0 0 1000 1000"><g stroke="#101014" stroke-width="14" stroke-linejoin="round">${[
      p('U', t('500,250 750,500 500,750 250,500')), p('UBL', t('250,250 500,250 250,500')),
      p('URB', t('750,250 500,250 750,500')), p('UFR', t('750,500 500,750 750,750')),
      p('ULF', t('250,500 500,750 250,750')), p('FUL', t('250,750 500,750 250,995')),
      p('F', t('500,750 750,995 250,995')), p('FRU', t('750,750 500,750 750,995')),
      p('RUF', t('750,750 750,500 990,750')), p('R', t('990,750 990,250 750,500')),
      p('RBU', t('750,250 750,500 990,250')), p('BLU', t('250,250 500,250 250,10')),
      p('B', t('500,250 250,10 750,10')), p('BUR', t('750,250 500,250 750,10')),
      p('LFU', t('250,750 250,500 10,750')), p('L', t('10,750 10,250 250,500')),
      p('LUB', t('250,250 250,500 10,250')),
    ].join('')}</g></svg>`;
  }
}

/* Which corner each cubing.js Skewb move turns. cubing.js names all eight —
   the WCA's R, L, U, B plus F, D, UR, UL — so a scramble in this page's
   notation can be re-aimed at the right corner for the timer's preview.
   Keys are the corner's three faces, sorted. */
const CUBING_CORNER = Object.fromEntries(Object.entries({
  UFR: 'F', UFL: 'UL', URB: 'UR', ULB: 'U', DRB: 'R', DFL: 'L', DLB: 'B', DFR: 'D',
}).map(([faces, name]) => [[...faces].sort().join(''), name]));

/* Where a whole-puzzle rotation sends each face. */
const ROT_FACES = {
  y: { F: 'L', L: 'B', B: 'R', R: 'F', U: 'U', D: 'D' },
  z: { U: 'R', R: 'D', D: 'L', L: 'U', F: 'F', B: 'B' },
};
const invertMap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));

/**
 * The same Skewb sequence with its rotations taken out, in cubing.js's names.
 *
 * `y R` is "turn the whole puzzle, then turn whichever corner is now at
 * up-front-right" — a corner that was somewhere else before the rotation. So
 * each turn is re-aimed at the corner it physically moves and the rotations
 * are dropped. Every piece ends where the original sequence leaves it; only
 * the way the whole puzzle is held can differ, which a preview is free to
 * ignore.
 */
export function skewbForCubing(alg) {
  let where = { U: 'U', D: 'D', F: 'F', B: 'B', R: 'R', L: 'L' };   // held position -> original face
  const out = [];
  for (const t of toks(alg)) {
    const m = SKEWB_TOKEN.exec(t);
    if (!m) return null;
    const [, move, two, prime] = m;
    if (move === 'y' || move === 'z') {
      /* What is held at h after the rotation was at r⁻¹(h) before it. */
      const step = two || prime ? ROT_FACES[move] : invertMap(ROT_FACES[move]);
      for (let i = 0; i < (two ? 2 : 1); i++) {
        const next = {};
        for (const h of Object.keys(where)) next[h] = where[step[h]];
        where = next;
      }
      continue;
    }
    const held = move === 'R' ? ['U', 'F', 'R'] : ['U', 'F', 'L'];
    out.push(CUBING_CORNER[held.map(h => where[h]).sort().join('')] + (prime ? "'" : ''));
  }
  return out.join(' ');
}

/* ---------------------------------------------------------
   Square-1
   --------------------------------------------------------- */

/* Pieces 0-7 start on top, 8-15 on the bottom. An even piece is a corner and
   fills two of a layer's twelve slots, an odd one is an edge and fills one. */
const width = (p) => (p % 2 === 0 ? 2 : 1);

/** Index a layer can be cut at after `units` slots, or -1 when a corner straddles the cut. */
function cutAt(face, units) {
  let count = 0;
  for (let i = 0; i < face.length; i++) {
    count += width(face[i]);
    if (count === units) return i + 1;
    if (count > units) return -1;
  }
  return -1;
}

const SQ1_TUPLE = /^\(?(-?\d+|-),(-?\d+|-)\)?$/;
const num = (s) => (s === '-' ? 0 : parseInt(s, 10));

/** Tokens, with slashes split out and tuples closed up, whatever the spacing. */
function sq1Tokens(alg) {
  return String(alg || '').replace(/\//g, t(' / ')).replace(/\s*,\s*/g, ',')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim().split(/\s+/).filter(Boolean);
}

export class SQ1 {
  constructor() {
    this.top = [0, 1, 2, 3, 4, 5, 6, 7];
    this.bottom = [8, 9, 10, 11, 12, 13, 14, 15];
  }

  static turn(face, n) {
    n = ((n % 12) + 12) % 12;
    if (!n) return face;
    const at = cutAt(face, n);
    return at < 0 ? null : face.slice(at).concat(face.slice(0, at));
  }

  apply(alg) {
    for (const t of sq1Tokens(alg)) {
      if (t === '/') {
        const a = cutAt(this.top, 6), b = cutAt(this.bottom, 6);
        if (a < 0 || b < 0) return false;
        const top = this.top.slice(a), bottom = this.bottom.slice(b);
        this.top = this.top.slice(0, a).concat(bottom.reverse());
        this.bottom = this.bottom.slice(0, b).concat(top.reverse());
        continue;
      }
      const m = SQ1_TUPLE.exec(t);
      if (!m) return false;
      const top = SQ1.turn(this.top, -num(m[1]));
      const bottom = SQ1.turn(this.bottom, num(m[2]));
      if (!top || !bottom) return false;
      this.top = top;
      this.bottom = bottom;
    }
    return true;
  }

  svg(bottomMirrored = false) {
    return layerSvg(this.top, true) + layerSvg(this.bottom, false, bottomMirrored);
  }
}

function layerSvg(face, top, mirror = false) {
  const Y = '#ffe100', W = '#ffffff', b = '#0051ba', r = '#ec0000', o = '#ff8b00', g = '#00b04a';
  const pieces = [
    [Y, b, r], [Y, b], [Y, o, b], [Y, o], [Y, g, o], [Y, g], [Y, r, g], [Y, r],
    [W, r, b], [W, b], [W, b, o], [W, o], [W, o, g], [W, g], [W, g, r], [W, r],
  ];
  const size = 100, mid = size / 2, pad = 0.15 * size, w = 0.1 * size;
  const tan = Math.tan((75 * Math.PI) / 180);
  const inner = (w + pad - mid) / tan + mid;
  const outer = (pad - mid) / tan + mid;
  const corner1 = `${mid},${mid} ${inner},${size - w - pad} ${w + pad},${size - w - pad} ${w + pad},${size - inner}`;
  let corner2 = `${pad},${size - pad} ${w + pad},${size - w - pad} ${w + pad},${size - inner} ${pad},${size - outer}`;
  let corner3 = `${pad},${size - pad} ${w + pad},${size - w - pad} ${inner},${size - w - pad} ${outer},${size - pad}`;
  const edge1 = `${mid},${mid} ${size - inner},${size - w - pad} ${inner},${size - w - pad}`;
  const edge2 = `${outer},${size - pad} ${inner},${size - w - pad} ${size - inner},${size - w - pad} ${size - outer},${size - pad}`;
  if (!top) [corner2, corner3] = [corner3, corner2];

  let angle = 0, body = '';
  const poly = (pts, fill, a) => { body += `<polygon points="${rotatePoints(pts, mid, mid, a)}" fill="${fill}"/>`; };
  for (const p of face) {
    const c = pieces[p];
    if (c.length === 3) {
      poly(corner1, c[0], angle); poly(corner2, c[1], angle); poly(corner3, c[2], angle);
      angle -= 60;
    } else {
      poly(edge1, c[0], angle - 30); poly(edge2, c[1], angle - 30);
      angle -= 30;
    }
  }
  if (mirror) body = `<g transform="translate(0, ${size}) scale(1, -1)">${body}</g>`;
  return `<svg viewBox="0 0 ${size} ${size}"><g stroke="#101014" stroke-width="1.6" stroke-linejoin="round">${body}</g></svg>`;
}

/* ---------------------------------------------------------
   Notation, per puzzle ('pyram' | 'skewb' | 'sq1')
   --------------------------------------------------------- */

const normTuple = (t) => {
  if (t === '/') return t;
  const m = SQ1_TUPLE.exec(t);
  return `${num(m[1])},${num(m[2])}`;
};

/** Tokens in canonical spelling, or null if any of it is not a move on this puzzle. */
export function parseMoves(puzzle, alg) {
  if (puzzle === 'sq1') {
    const t = sq1Tokens(alg);
    return t.length && t.every(x => x === '/' || SQ1_TUPLE.test(x)) ? t.map(normTuple) : null;
  }
  const t = toks(alg);
  const re = puzzle === 'pyram' ? PYRA_TOKEN : SKEWB_TOKEN;
  if (!t.length || !t.every(x => re.test(x))) return null;
  /* A pyraminx layer has order 3: L2 is L' and L2' is L. Spelled that way, a
     sequence inverts by flipping primes like any other, and a half turn typed
     into "add your own" cannot be mistaken for a move that undoes itself. */
  return puzzle === 'pyram' ? t.map(m => (m.includes('2') ? (m.endsWith("'") ? m[0] : `${m[0]}'`) : m)) : t;
}

/** A new solved puzzle of this kind. */
export const newPuzzle = (puzzle) => (puzzle === 'pyram' ? new Pyraminx() : puzzle === 'skewb' ? new Skewb() : new SQ1());

/** Move count the way cubers count it: a Square-1 algorithm counts its slashes. */
export function countMoves(puzzle, alg) {
  const t = parseMoves(puzzle, alg) || [];
  return puzzle === 'sq1' ? t.filter(x => x === '/').length : t.filter(x => !/^[yz]/.test(x)).length;
}

export function invertMoves(puzzle, alg) {
  const t = puzzle === 'sq1' ? sq1Tokens(alg).map(normTuple) : (parseMoves(puzzle, alg) || toks(alg));
  return t.reverse().map(m => {
    if (puzzle === 'sq1') {
      if (m === '/') return m;
      const [a, b] = m.split(',').map(Number);
      return `${-a || 0},${-b || 0}`;
    }
    if (m.endsWith("'")) return m.slice(0, -1);
    return m.endsWith('2') ? m : m + "'";
  }).join(' ');
}

/**
 * Join sequences into one scramble and cancel what cancels.
 *
 * A Square-1 scramble comes out the way the WCA writes one — `(1,0) / (3,3)`
 * — with neighbouring layer turns summed, turns of nothing dropped and two
 * slashes in a row removed. A pyraminx or skewb turn has order 3, so two of
 * the same turn are its inverse, not a half turn.
 */
export function joinMoves(puzzle, parts) {
  const all = parts.filter(Boolean).join(' ');
  if (puzzle === 'sq1') {
    const wrap = (n) => { n = ((n % 12) + 12) % 12; return n > 6 ? n - 12 : n; };
    const out = [];
    for (const t of sq1Tokens(all).map(normTuple)) {
      if (t === '/') {
        if (out[out.length - 1] === '/') out.pop(); else out.push('/');
        continue;
      }
      const [a, b] = t.split(',').map(Number);
      const prev = out[out.length - 1];
      let sum = [a, b];
      if (prev && prev !== '/') {
        out.pop();
        const [pa, pb] = prev.split(',').map(Number);
        sum = [pa + a, pb + b];
      }
      /* A sum of nothing is dropped, which can leave two slashes touching;
         the next slash to arrive then cancels against the one before it. */
      const [x, y] = sum.map(wrap);
      if (x || y) out.push(`${x},${y}`);
    }
    return out.map(t => (t === '/' ? t : `(${t})`)).join(' ');
  }
  const out = [];
  const amount = (m) => (m.endsWith("'") ? -1 : m.endsWith('2') ? 2 : 1);
  const face = (m) => m.replace(/['2]+$/, '');
  for (const t of toks(all)) {
    const prev = out[out.length - 1];
    if (prev && face(prev) === face(t)) {
      out.pop();
      const f = face(t);
      const order = /^[yz]$/.test(f) ? 4 : 3;
      const a = (((amount(prev) + amount(t)) % order) + order) % order;
      const name = a === 0 ? null : a === 1 ? f : a === order - 1 ? f + "'" : f + '2';
      if (name) out.push(name);
    } else out.push(t);
  }
  return out.join(' ');
}
