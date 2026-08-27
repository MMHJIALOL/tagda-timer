/* ===========================================================
   Tagda Timer — NxN cube state + flat-net drawing

   The scramble preview on the page is a <twisty-player>, which renders
   into a *closed* shadow root — its canvas cannot be read back, so it is
   useless as a source for an exported image. This module is the answer:
   a tiny self-contained facelet simulator plus a 2D net painter that
   draws straight onto any canvas context.

   The simulator works in 3D sticker coordinates rather than hand-written
   index cycles. Every move is one 90-degree rotation of the stickers that
   sit deep enough in the turning layer, which is the same code for every
   face, every depth and every cube size — nothing to get subtly wrong.
   =========================================================== */

export const SCHEME = { U: '#ffffff', D: '#ffe100', F: '#00b04a', B: '#0051ba', R: '#ec0000', L: '#ff8b00' };

const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

/* Outward normal, plus the in-plane directions the rows and columns run in.
   Columns run left-to-right and rows top-to-bottom as the face is drawn on
   the flat net, which is what makes the net painter trivial. */
const GEOM = {
  U: { n: [0, 1, 0],  right: [1, 0, 0],  down: [0, 0, 1] },
  D: { n: [0, -1, 0], right: [1, 0, 0],  down: [0, 0, -1] },
  F: { n: [0, 0, 1],  right: [1, 0, 0],  down: [0, -1, 0] },
  B: { n: [0, 0, -1], right: [-1, 0, 0], down: [0, -1, 0] },
  R: { n: [1, 0, 0],  right: [0, 0, -1], down: [0, -1, 0] },
  L: { n: [-1, 0, 0], right: [0, 0, 1],  down: [0, -1, 0] },
};

/** Which axis, and which way along it, a face turn spins about. */
const AXIS = {
  U: ['y', +1], D: ['y', -1],
  R: ['x', +1], L: ['x', -1],
  F: ['z', +1], B: ['z', -1],
};

const key = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)},${p[2].toFixed(1)}`;

function stickerPos(face, r, c, n) {
  const g = GEOM[face];
  const half = (n - 1) / 2;
  const s = half + 0.5;                 // just outside the cubie centres
  const u = c - half, v = r - half;
  return [
    g.n[0] * s + g.right[0] * u + g.down[0] * v,
    g.n[1] * s + g.right[1] * u + g.down[1] * v,
    g.n[2] * s + g.right[2] * u + g.down[2] * v,
  ];
}

/**
 * Right-hand rotation of `p` about `axis` by `turns` quarter-turns.
 * A clockwise face turn is -1 quarter-turn about that face's outward axis.
 */
function spin(p, axis, turns) {
  let t = ((turns % 4) + 4) % 4;
  for (let i = 0; i < t; i++) {
    const [x, y, z] = p;
    if (axis === 'x')      p = [x, -z, y];
    else if (axis === 'y') p = [z, y, -x];
    else                   p = [-y, x, z];
  }
  return p;
}

/**
 * Turn `depth` layers in from `face` by `amount` quarter-turns clockwise.
 * `depth >= n` is a whole-cube rotation.
 */
function turn(stickers, n, face, depth, amount) {
  const [axis, sign] = AXIS[face];
  const nvec = GEOM[face].n;
  const cut = (n - 1) / 2 - depth;
  // Clockwise-from-outside is -90 about a positive axis, +90 about a negative one.
  const turns = -amount * sign;
  for (const st of stickers) {
    const d = st.p[0] * nvec[0] + st.p[1] * nvec[1] + st.p[2] * nvec[2];
    if (d > cut + 1e-6) st.p = spin(st.p, axis, turns);
  }
}

const WIDE = { u: 'U', r: 'R', f: 'F', d: 'D', l: 'L', b: 'B' };
/** A slice move is "turn everything but the far layer, then put that layer back". */
const SLICE = { M: 'L', E: 'D', S: 'F' };
const ROT   = { x: 'R', y: 'U', z: 'F' };

const TOKEN = /^(\d*)([URFDLBurfdlbMESxyz])(w?)([2']*)$/;

/** Apply one WCA/SiGN move token. Unknown tokens are ignored, never thrown. */
function applyMove(stickers, n, tok) {
  const m = TOKEN.exec(tok);
  if (!m) return;
  const [, numStr, letter, w, suf] = m;
  let amount = 1;
  if (suf.includes('2')) amount = 2;
  if (suf.includes("'")) amount = -amount;

  if (ROT[letter]) { turn(stickers, n, ROT[letter], n, amount); return; }

  if (SLICE[letter]) {
    // Everything except the opposite outer layer, then undo the near one.
    turn(stickers, n, SLICE[letter], n - 1, amount);
    turn(stickers, n, SLICE[letter], 1, -amount);
    return;
  }

  const face = WIDE[letter] || letter;
  const wide = !!w || !!WIDE[letter];
  const depth = numStr ? Math.min(+numStr, n) : (wide ? Math.min(2, n) : 1);
  turn(stickers, n, face, depth, amount);
}

/**
 * Run a scramble and return `{ U: string[][], R: ... }` face colour grids.
 * Multi-blind scrambles ("1) ... 2) ...") use their first attempt.
 */
export function faceletsFor(scramble, n = 3) {
  const stickers = [];
  for (const f of FACES) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) stickers.push({ c: f, p: stickerPos(f, r, c, n) });
    }
  }
  const clean = String(scramble || '').replace(/^\s*\d+\)\s*/gm, '').split('\n')[0];
  for (const tok of clean.trim().split(/\s+/)) {
    if (tok) applyMove(stickers, n, tok);
  }

  const at = new Map();
  for (const st of stickers) at.set(key(st.p), st.c);

  const out = {};
  for (const f of FACES) {
    out[f] = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) row.push(at.get(key(stickerPos(f, r, c, n))) || f);
      out[f].push(row);
    }
  }
  return out;
}

/** Cube size for an event id, or 0 when the event has no net to draw. */
export function cubeSizeFor(eventId = '333') {
  const m = /^([234567])\1\1/.exec(String(eventId));
  return m ? +m[1] : 0;
}

/**
 * Paint the unfolded net inside the box (x, y, w, h), centred and scaled to fit.
 *
 *        U
 *    L   F   R   B
 *        D
 */
export function drawNet(ctx, facelets, n, x, y, w, h, { scheme = SCHEME, radius = 0.16 } = {}) {
  const cols = 4 * n, rows = 3 * n;
  const cell = Math.floor(Math.min(w / cols, h / rows));
  if (cell < 2) return;
  const gap = Math.max(1, Math.round(cell * 0.08));
  const ox = x + (w - cell * cols) / 2;
  const oy = y + (h - cell * rows) / 2;

  const place = { U: [n, 0], L: [0, n], F: [n, n], R: [2 * n, n], B: [3 * n, n], D: [n, 2 * n] };
  const rad = Math.max(1, cell * radius);

  for (const [face, [cx, cy]] of Object.entries(place)) {
    const grid = facelets[face];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        ctx.fillStyle = scheme[grid[r][c]] || '#555';
        roundRect(ctx, ox + (cx + c) * cell + gap / 2, oy + (cy + r) * cell + gap / 2,
                  cell - gap, cell - gap, rad);
        ctx.fill();
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Aspect ratio (w/h) a net of size n wants. */
export const netAspect = 4 / 3;
