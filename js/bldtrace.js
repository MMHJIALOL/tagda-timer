/* ===========================================================
   Tagda Timer — 3BLD target tracing

   Given a scramble and a solver's buffer/orientation/letter scheme,
   work out the sequence of targets they would memorise.

   The whole thing is a pure function of (scramble, settings), which is
   what makes it testable — see the "blindfolded tracing" section of
   test.html, where every trace is replayed as a sequence of swaps and
   the cube has to come out solved.

   --- why stickers and not pieces ---

   The obvious model is "each target is a piece, with a flag when the
   piece is flipped". It is also wrong. A flipped edge in place is not
   one target with a flag on it; in Speffz it is genuinely two targets,
   one on each of that edge's stickers, and a memo that collapses them
   into one letter does not solve the cube. So the unit here is a
   sticker, and orientation falls out of the cycle structure for free —
   which is exactly how a human traces it. The flags are still there for
   the UI, they just annotate real targets instead of replacing them.

   --- the state, as a permutation of stickers ---

   `perm[x] = y` reads "the sticker sitting in position x belongs in
   position y". Solved is the identity. Shooting to target T swaps the
   piece at the buffer with the piece at T, lining the buffer sticker up
   with T — that is one transposition, and the trace is just "keep
   shooting where the buffer's piece wants to go".
   =========================================================== */

import { SOLVED, applyAlg, CORNER_NAMES, EDGE_NAMES, cornerIndex, edgeIndex,
         CORNER_FACELETS, EDGE_FACELETS, FACES } from './cube3.js';

/* ---------------------------------------------------------
   Speffz

   Keys are sticker positions written face first: "UBL" is the U-face
   sticker of the UBL corner, "LU" is the L-face sticker of the UL edge.
   Corners and edges each get their own A-X, which is what Speffz
   actually is — the 48 entries below are one scheme, not two.
   --------------------------------------------------------- */
export const DEFAULT_SPEFFZ_MAP = {
  /* corners — each face's four stickers, clockwise from its top-left */
  UBL: 'A', UBR: 'B', UFR: 'C', UFL: 'D',
  LUB: 'E', LUF: 'F', LDF: 'G', LDB: 'H',
  FUL: 'I', FUR: 'J', FDR: 'K', FDL: 'L',
  RUF: 'M', RUB: 'N', RDB: 'O', RDF: 'P',
  BUR: 'Q', BUL: 'R', BDL: 'S', BDR: 'T',
  DFL: 'U', DFR: 'V', DBR: 'W', DBL: 'X',
  /* edges */
  UB: 'A', UR: 'B', UF: 'C', UL: 'D',
  LU: 'E', LF: 'F', LD: 'G', LB: 'H',
  FU: 'I', FR: 'J', FD: 'K', FL: 'L',
  RU: 'M', RB: 'N', RD: 'O', RF: 'P',
  BU: 'Q', BL: 'R', BD: 'S', BR: 'T',
  DF: 'U', DR: 'V', DB: 'W', DL: 'X',
};

/** Sticker positions in the order the scheme editor lists them. */
export const CORNER_STICKER_KEYS = Object.keys(DEFAULT_SPEFFZ_MAP).filter(k => k.length === 3);
export const EDGE_STICKER_KEYS   = Object.keys(DEFAULT_SPEFFZ_MAP).filter(k => k.length === 2);

export const DEFAULT_BLD = {
  version: 1,
  edgeBuffer: 'UF',
  cornerBuffer: 'UFR',
  orientation: { up: 'U', front: 'F' },
  scheme: 'speffz',
  letters: { ...DEFAULT_SPEFFZ_MAP },
  showBreakdownByDefault: false,
  memoExecSplit: true,
};

/** Events where the blindfolded workflow applies at all. */
export const BLD_EVENTS = new Set(['333bf', '444bf', '555bf', '333mbf']);
/** Only a 3x3 can be traced — 4BLD/5BLD wings and centres are not modelled. */
export const TRACEABLE_EVENTS = new Set(['333bf']);

/* ---------------------------------------------------------
   Sticker addressing

   A corner sticker is slot*3 + index, an edge sticker slot*2 + index,
   where the index is the position of that face's letter inside the
   cubie's name — the same ordering CORNER_FACELETS/EDGE_FACELETS use,
   so a sticker index and a facelet index are two names for one thing.
   --------------------------------------------------------- */

/** "LUB" -> { slot, idx } on the corner cubie whose letters those are. */
export function cornerSticker(name) {
  const s = String(name || '').toUpperCase();
  if (s.length !== 3) return null;
  const slot = cornerIndex(s);
  if (slot < 0) return null;
  const idx = CORNER_NAMES[slot].indexOf(s[0]);
  return idx < 0 ? null : { slot, idx };
}

export function edgeSticker(name) {
  const s = String(name || '').toUpperCase();
  if (s.length !== 2) return null;
  const slot = edgeIndex(s);
  if (slot < 0) return null;
  const idx = EDGE_NAMES[slot].indexOf(s[0]);
  return idx < 0 ? null : { slot, idx };
}

const rot = (s, i) => s.slice(i) + s.slice(0, i);
/** The face-first name of a sticker, e.g. corner (2,1) -> "LBU". */
export const cornerStickerName = (slot, idx) => rot(CORNER_NAMES[slot], idx);
export const edgeStickerName   = (slot, idx) => rot(EDGE_NAMES[slot], idx);

/* ---------------------------------------------------------
   Orientation

   "White on top, green on front" is only the default. A solver who
   learned their letters holding the cube some other way gets the same
   letters back by relabelling the six faces before anything is looked up.
   --------------------------------------------------------- */
const VEC = { U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1], R: [1, 0, 0], L: [-1, 0, 0] };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (v) => [-v[0], -v[1], -v[2]];
const faceOfVec = (v) => FACES.find(f => VEC[f].every((x, i) => x === v[i]));

export const IDENTITY_MAP = { U: 'U', D: 'D', L: 'L', R: 'R', F: 'F', B: 'B' };

/**
 * Which physical face each face of the letter scheme refers to.
 * Two faces on the same axis are not a holdable orientation, so those
 * fall back to the standard one rather than producing nonsense letters.
 */
export function faceMap(up = 'U', front = 'F') {
  const u = VEC[up], f = VEC[front];
  if (!u || !f) return { ...IDENTITY_MAP };
  const r = cross(u, f);
  if (r.every(x => x === 0)) return { ...IDENTITY_MAP };
  return {
    U: up, D: faceOfVec(neg(u)),
    F: front, B: faceOfVec(neg(f)),
    R: faceOfVec(r), L: faceOfVec(neg(r)),
  };
}

/** The four faces that can be the front for a given up face. */
export function frontsFor(up) {
  const u = VEC[up];
  if (!u) return FACES.filter(f => f !== 'U' && f !== 'D');
  return FACES.filter(f => f !== up && !VEC[f].every((x, i) => x === -u[i]));
}

/* ---------------------------------------------------------
   The trace
   --------------------------------------------------------- */

/**
 * The sticker permutation for one group.
 * `size` is 3 for corners, 2 for edges.
 */
function permFor(state, size) {
  const n = size === 3 ? 8 : 12;
  const pOff = size === 3 ? 0 : 16;
  const oOff = size === 3 ? 8 : 28;
  const perm = new Int8Array(n * size);
  for (let i = 0; i < n; i++) {
    const c = state[pOff + i], o = state[oOff + i];
    for (let j = 0; j < size; j++) {
      // A cubie sticker k shows at slot sticker (k + o); read backwards,
      // the sticker showing at j belongs to cubie sticker (j - o).
      perm[i * size + j] = c * size + ((j - o + size * 2) % size);
    }
  }
  return perm;
}

/** Shooting to T: swap the buffer's piece with T's, lining buffer up with T. */
function shoot(perm, size, buf, T) {
  const bs = Math.floor(buf / size), bi = buf % size;
  const ts = Math.floor(T / size), ti = T % size;
  for (let d = 0; d < size; d++) {
    const a = bs * size + (bi + d) % size;
    const b = ts * size + (ti + d) % size;
    const t = perm[a]; perm[a] = perm[b]; perm[b] = t;
  }
}

/**
 * Trace one group to a list of targets.
 *
 * The rule is the one a human follows: look at the buffer, shoot where
 * that piece belongs, repeat. When the buffer is holding its own piece
 * — solved, or merely twisted in place — there is nothing to shoot at,
 * so break into the lowest-lettered unsolved sticker instead and carry
 * on. Every break costs an extra target, which is why they are flagged.
 */
function traceGroup(perm, size, buf, letterOf) {
  const bufSlot = Math.floor(buf / size);
  const onBuffer = (x) => Math.floor(x / size) === bufSlot;
  const targets = [];
  const breaks = [];

  const firstUnsolved = () => {
    let best = -1, bestKey = null;
    for (let x = 0; x < perm.length; x++) {
      if (perm[x] === x || onBuffer(x)) continue;
      const k = letterOf(x) + String(x).padStart(2, '0');
      if (bestKey === null || k < bestKey) { bestKey = k; best = x; }
    }
    return best;
  };

  // Every shot that is not a break puts one piece home for good, so this
  // cannot run away; the cap guards a corrupt state, it is not a real
  // bound (the worst honest case is about fifteen edge targets).
  for (let guard = 0; guard < 120; guard++) {
    let T;
    if (onBuffer(perm[buf])) {
      T = firstUnsolved();
      if (T < 0) break;
      breaks.push(targets.length);
    } else {
      T = perm[buf];
    }
    const prev = targets.length ? targets[targets.length - 1] : null;
    const slot = Math.floor(T / size);
    targets.push({
      sticker: T,
      slot,
      idx: T % size,
      letter: letterOf(T),
      // Two targets running on the same piece is a flip (edges) or a
      // twist (corners) being resolved in place — worth a mark on the chip.
      inPlace: !!prev && prev.slot === slot,
    });
    shoot(perm, size, buf, T);
  }
  return { targets, breaks };
}

/** Split a flat target list into cycles at the break boundaries. */
function toCycles(targets, breaks) {
  if (!targets.length) return [];
  const cuts = new Set(breaks);
  const out = [];
  let cur = [];
  targets.forEach((t, i) => {
    if (i && cuts.has(i)) { out.push(cur); cur = []; }
    cur.push(t);
  });
  out.push(cur);
  return out;
}

/**
 * The whole breakdown for one scramble.
 *
 * `frame` matters more than it looks: a WCA 3BLD scramble ends in a
 * random cube rotation, and the cube you are handed is the rotated one.
 * cube3 carries rotations in the frame rather than in the state, so the
 * frame is exactly the relabelling needed to read the right stickers —
 * without it every trace of a real BLD scramble comes out wrong.
 */
export function trace(scramble, bld = DEFAULT_BLD) {
  const applied = applyAlg(SOLVED, scramble || '');
  if (!applied) return null;

  const rho = faceMap(bld.orientation?.up || 'U', bld.orientation?.front || 'F');
  const frame = applied.frame;
  /** A face of the solver's letter scheme, as a face of the state array. */
  const physical = (f) => frame[rho[f]] || f;
  const toPhysical = (name) => [...String(name)].map(physical).join('');

  const letters = { ...DEFAULT_SPEFFZ_MAP, ...(bld.letters || {}) };

  // Letters are written against the scheme's own faces, so each one is
  // resolved to a sticker of the state array once, up front.
  const cLetters = new Array(24).fill('?');
  const eLetters = new Array(24).fill('?');
  for (const [name, letter] of Object.entries(letters)) {
    if (name.length === 3) {
      const st = cornerSticker(toPhysical(name));
      if (st) cLetters[st.slot * 3 + st.idx] = letter;
    } else if (name.length === 2) {
      const st = edgeSticker(toPhysical(name));
      if (st) eLetters[st.slot * 2 + st.idx] = letter;
    }
  }

  const cBuf = cornerSticker(toPhysical(bld.cornerBuffer || 'UFR')) || cornerSticker('UFR');
  const eBuf = edgeSticker(toPhysical(bld.edgeBuffer || 'UF')) || edgeSticker('UF');

  const corners = traceGroup(permFor(applied.state, 3), 3, cBuf.slot * 3 + cBuf.idx, x => cLetters[x]);
  const edges   = traceGroup(permFor(applied.state, 2), 2, eBuf.slot * 2 + eBuf.idx, x => eLetters[x]);

  return {
    corners: { ...corners, cycles: toCycles(corners.targets, corners.breaks) },
    edges:   { ...edges,   cycles: toCycles(edges.targets, edges.breaks) },
    // An odd number of targets on either half is the classic parity case.
    // On a legal cube the two halves always agree; the || is a guard.
    parity: (edges.targets.length % 2 === 1) || (corners.targets.length % 2 === 1),
    buffers: {
      corner: cornerStickerName(cBuf.slot, cBuf.idx),
      edge: edgeStickerName(eBuf.slot, eBuf.idx),
    },
  };
}

/**
 * The part of a trace worth keeping on the solve record.
 *
 * Flat letters plus the slot each target landed on, rather than the
 * nested cycle shape: the post-mortem needs to ask "which target was
 * this piece" and both answers come straight off these two arrays.
 */
export function traceRecord(scramble, bld) {
  const t = trace(scramble, bld);
  if (!t) return null;
  const strip = (g) => ({
    letters: g.targets.map(x => x.letter),
    slots: g.targets.map(x => x.slot),
    breaks: g.breaks.slice(),
  });
  return { edges: strip(t.edges), corners: strip(t.corners), parity: t.parity };
}

/** "AB CD EF G" — targets paired up the way they are memorised. */
export function pairUp(letters) {
  const out = [];
  for (let i = 0; i < letters.length; i += 2) out.push(letters.slice(i, i + 2).join(''));
  return out;
}

/* ---------------------------------------------------------
   Facelets <-> pieces, for the post-mortem net
   --------------------------------------------------------- */
const FACELET_PIECE = (() => {
  const m = new Array(54).fill(null);
  CORNER_FACELETS.forEach((fl, slot) => fl.forEach((f, idx) => { m[f] = { type: 'corner', slot, idx }; }));
  EDGE_FACELETS.forEach((fl, slot) => fl.forEach((f, idx) => { m[f] = { type: 'edge', slot, idx }; }));
  return m;
})();

/** Which piece a sticker of the flat net belongs to; null for a centre. */
export function pieceAtFacelet(face, r, c) {
  const fi = FACES.indexOf(face);
  if (fi < 0) return null;
  return FACELET_PIECE[fi * 9 + r * 3 + c];
}

/** Every net cell that belongs to a given piece, as [face, r, c]. */
export function faceletsOfPiece(piece) {
  const out = [];
  for (let i = 0; i < 54; i++) {
    const p = FACELET_PIECE[i];
    if (p && p.type === piece.type && p.slot === piece.slot) {
      out.push([FACES[Math.floor(i / 9)], Math.floor((i % 9) / 3), i % 3]);
    }
  }
  return out;
}

export const pieceName = (p) =>
  p.type === 'corner' ? CORNER_NAMES[p.slot] : EDGE_NAMES[p.slot];

export const samePiece = (a, b) => a.type === b.type && a.slot === b.slot;

/* ---------------------------------------------------------
   DNF post-mortem

   Not a diagnosis engine — a short, readable table of the failure
   shapes that actually happen, matched against the targets stored with
   the solve. Anything it cannot recognise says so rather than guessing.
   --------------------------------------------------------- */
export function diagnose(bld, wrong) {
  if (!bld || !wrong?.length) return null;
  const out = [];

  for (const [key, kind, label] of [['edges', 'edge', 'Edges'], ['corners', 'corner', 'Corners']]) {
    const g = bld[key];
    const mine = wrong.filter(w => w.type === kind);
    if (!g || !mine.length) continue;
    const breaks = new Set(g.breaks || []);

    // Where each wrong piece turns up in the memo.
    const hits = mine.map(w => ({
      piece: w,
      at: (g.slots || []).map((s, i) => (s === w.slot ? i : -1)).filter(i => i >= 0),
    }));

    const named = (h) => pieceName(h.piece);

    // 0 — pieces that were never traced at all. Memo problem, not execution.
    if (hits.every(h => !h.at.length)) {
      out.push(`${label}: ${hits.map(named).join(', ')} never appear in this solve's memo — ` +
               'they were mis-traced or dropped while memorising, so the memo itself was wrong.');
      continue;
    }

    // 1 — a cycle break that was not taken. The pieces either side of a
    // break are exactly the ones left behind when it is missed.
    const nearBreak = hits.filter(h => h.at.some(i => breaks.has(i) || breaks.has(i + 1)));
    if (nearBreak.length >= 2) {
      const i = nearBreak[0].at[0];
      out.push(`${label}: target ${i + 1} — ${g.letters[i]} sits on a cycle break. ` +
               'Missing a break leaves exactly these pieces behind.');
      continue;
    }

    // 2 — parity was flagged and two pieces of one type are left over.
    if (bld.parity && mine.length === 2) {
      out.push(`${label}: this scramble had parity and two ${label.toLowerCase()} are left — ` +
               'the parity algorithm was skipped, or applied the wrong way round.');
      continue;
    }

    // 3 — a piece shot at twice in a row is a flip or a twist.
    const twisted = hits.find(h => h.at.some((i, k) => k > 0 && h.at[k - 1] === i - 1));
    if (twisted) {
      out.push(`${label}: ${named(twisted)} is shot at twice in a row (targets ` +
               `${twisted.at.map(i => i + 1).join(' and ')}) — a ${kind === 'edge' ? 'flipped edge' : 'twisted corner'} ` +
               'put back the wrong way round.');
      continue;
    }

    // 4 — nothing matched a known shape; say which targets were involved.
    const where = hits.filter(h => h.at.length)
      .map(h => `${named(h)} at target ${h.at.map(i => i + 1).join('/')} (${h.at.map(i => g.letters[i]).join('/')})`);
    out.push(`${label}: ${where.join('; ')} — no familiar failure shape, so most likely ` +
             'a single mis-executed algorithm rather than a memo or tracing error.');
  }

  return out.length ? out : null;
}
