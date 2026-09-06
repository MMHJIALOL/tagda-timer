/* ===========================================================
   Tagda Timer — a 3x3 the app can reason about

   twisty-player draws a cube; it will not tell you whether your
   cross is done. This is the model that answers questions:
   apply a scramble, apply the moves someone has typed, and say
   which phase of a CFOP solve the result is in.

   Pieces are the usual cubie arrays (Kociemba's ordering), packed
   into one Uint8Array so the solver can copy a position with a
   single .set() instead of four.

       0..7    corner permutation
       8..15   corner orientation (0-2)
       16..27  edge permutation
       28..39  edge orientation (0-1)

   Rotations are not modelled as piece moves. They are eliminated
   as they are read: `y` does not change the cube, it changes what
   the next `R` means. The net rotation is carried alongside the
   state so suggestions can be handed back in the orientation the
   cube is actually being held in.
   =========================================================== */

export const CORNER_NAMES = ['URF', 'UFL', 'ULB', 'UBR', 'DFR', 'DLF', 'DBL', 'DRB'];
export const EDGE_NAMES   = ['UR', 'UF', 'UL', 'UB', 'DR', 'DF', 'DL', 'DB', 'FR', 'FL', 'BL', 'BR'];
export const FACES        = ['U', 'R', 'F', 'D', 'L', 'B'];

export const cornerIndex = (name) => CORNER_NAMES.findIndex(n => same(n, name));
export const edgeIndex   = (name) => EDGE_NAMES.findIndex(n => same(n, name));
const same = (a, b) => a.length === b.length && [...a].every(c => b.includes(c));

/* ---------------- base moves ----------------
   Quarter turns only; halves and inverses are composed below. */
const BASE = {
  U: { cp: [3, 0, 1, 2, 4, 5, 6, 7], co: [0, 0, 0, 0, 0, 0, 0, 0],
       ep: [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11], eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  R: { cp: [4, 1, 2, 0, 7, 5, 6, 3], co: [2, 0, 0, 1, 1, 0, 0, 2],
       ep: [8, 1, 2, 3, 11, 5, 6, 7, 4, 9, 10, 0], eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  F: { cp: [1, 5, 2, 3, 0, 4, 6, 7], co: [1, 2, 0, 0, 2, 1, 0, 0],
       ep: [0, 9, 2, 3, 4, 8, 6, 7, 1, 5, 10, 11], eo: [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0] },
  D: { cp: [0, 1, 2, 3, 5, 6, 7, 4], co: [0, 0, 0, 0, 0, 0, 0, 0],
       ep: [0, 1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11], eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  L: { cp: [0, 2, 6, 3, 4, 1, 5, 7], co: [0, 1, 2, 0, 0, 2, 1, 0],
       ep: [0, 1, 10, 3, 4, 5, 9, 7, 8, 2, 6, 11], eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  B: { cp: [0, 1, 3, 7, 4, 5, 2, 6], co: [0, 0, 1, 2, 0, 0, 2, 1],
       ep: [0, 1, 2, 11, 4, 5, 6, 10, 8, 9, 3, 7], eo: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1] },
  /* Slice moves. Only needed so that r, M, S and friends can be expanded;
     they never appear in a solution the solver hands back. */
  M: { cp: [0, 1, 2, 3, 4, 5, 6, 7], co: [0, 0, 0, 0, 0, 0, 0, 0],
       ep: [0, 3, 2, 7, 4, 1, 6, 5, 8, 9, 10, 11], eo: [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0] },
  E: { cp: [0, 1, 2, 3, 4, 5, 6, 7], co: [0, 0, 0, 0, 0, 0, 0, 0],
       ep: [0, 1, 2, 3, 4, 5, 6, 7, 11, 8, 9, 10], eo: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1] },
  S: { cp: [0, 1, 2, 3, 4, 5, 6, 7], co: [0, 0, 0, 0, 0, 0, 0, 0],
       ep: [2, 1, 6, 3, 0, 5, 4, 7, 8, 9, 10, 11], eo: [1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0] },
};

export const SOLVED = (() => {
  const s = new Uint8Array(40);
  for (let i = 0; i < 8; i++) s[i] = i;
  for (let i = 0; i < 12; i++) s[16 + i] = i;
  return s;
})();

export const clone = (s) => Uint8Array.prototype.slice.call(s);

/** out = s, then move m. Safe to call with out === s? No — keep them apart. */
export function mulInto(out, s, m) {
  const { cp, co, ep, eo } = m;
  for (let i = 0; i < 8; i++) {
    const j = cp[i];
    out[i] = s[j];
    out[8 + i] = (s[8 + j] + co[i]) % 3;
  }
  for (let i = 0; i < 12; i++) {
    const j = ep[i];
    out[16 + i] = s[16 + j];
    out[28 + i] = (s[28 + j] + eo[i]) & 1;
  }
}

/** Compose two move tables into one: "a then b". */
function compose(a, b) {
  const out = { cp: [], co: [], ep: [], eo: [] };
  for (let i = 0; i < 8; i++) {
    out.cp[i] = a.cp[b.cp[i]];
    out.co[i] = (a.co[b.cp[i]] + b.co[i]) % 3;
  }
  for (let i = 0; i < 12; i++) {
    out.ep[i] = a.ep[b.ep[i]];
    out.eo[i] = (a.eo[b.ep[i]] + b.eo[i]) & 1;
  }
  return out;
}

/** Every face turn, indexed face*3 + (amount-1) — the solver's move set. */
export const MOVES = [];
export const MOVE_NAMES = [];
for (const f of FACES) {
  let acc = BASE[f];
  for (let n = 1; n <= 3; n++) {
    MOVES.push(acc);
    MOVE_NAMES.push(f + (n === 1 ? '' : n === 2 ? '2' : "'"));
    acc = compose(acc, BASE[f]);
  }
}
const moveIndex = (face, amount) => FACES.indexOf(face) * 3 + (amount - 1);

/* ---------------- rotations as relabelling ----------------
   newFrame[f] = oldFrame[ROT[r][f]]. Read it as "after this rotation, the
   face the solver calls f is the one that used to be called ROT[r][f]". */
const ROT = {
  x: { U: 'F', D: 'B', F: 'D', B: 'U', R: 'R', L: 'L' },
  y: { U: 'U', D: 'D', F: 'R', R: 'B', B: 'L', L: 'F' },
  z: { U: 'L', D: 'R', R: 'U', L: 'D', F: 'F', B: 'B' },
};

export const IDENTITY_FRAME = { U: 'U', D: 'D', L: 'L', R: 'R', F: 'F', B: 'B' };

function turnFrame(frame, rot, amount) {
  let f = frame;
  for (let n = 0; n < amount; n++) {
    const next = {};
    for (const k of FACES) next[k] = f[ROT[rot][k]];
    f = next;
  }
  return f;
}

/** Face letter the user would say for a solver-frame face. */
export function toUserFace(frame, solverFace) {
  return FACES.find(f => frame[f] === solverFace) || solverFace;
}

/* ---------------- notation ---------------- */

/* Uppercase is accepted everywhere, because the move box types in caps: Rw and
   RW are the same wide turn, X and x the same rotation. Only the six lowercase
   face letters keep their own meaning, and they still work if you type them. */
const TOKEN = /^([UDLRFBMESXYZxyz]|[udlrfb])([wW]?)(2'|'2|['2])?$/;

/**
 * Wide and slice turns, written as things the model already understands.
 * Each entry is read left to right; a rotation changes what the letters after
 * it mean, which is exactly what makes `r` leave the cube re-oriented.
 */
const EXPAND = {
  r: [['rot', 'x'], ['face', 'L']],
  l: [['rot', 'x'], ['rot', 'x'], ['rot', 'x'], ['face', 'R']],
  u: [['rot', 'y'], ['face', 'D']],
  d: [['rot', 'y'], ['rot', 'y'], ['rot', 'y'], ['face', 'U']],
  f: [['rot', 'z'], ['face', 'B']],
  b: [['rot', 'z'], ['rot', 'z'], ['rot', 'z'], ['face', 'F']],
};

/** Is this a token the model can read at all? */
export function validToken(tok) { return TOKEN.test(tok); }

/**
 * Split an alg into tokens, keeping only the ones we understand.
 * Returns null the moment something unreadable turns up, so the UI can say
 * which move it choked on rather than silently dropping it.
 */
export function parse(alg) {
  const raw = String(alg || '').replace(/[()]/g, ' ').trim();
  if (!raw) return [];
  const out = [];
  for (const tok of raw.split(/\s+/)) {
    const m = TOKEN.exec(tok);
    if (!m) return null;
    let [, letter, wide, suffix] = m;
    if ('XYZ'.includes(letter)) letter = letter.toLowerCase();
    const amount = !suffix ? 1 : suffix.includes('2') ? 2 : 3;
    out.push({ tok, letter, wide: !!wide, amount });
  }
  return out;
}

/**
 * Write an alg the way every other cube program spells it.
 *
 * The move box types in caps so no shift key stands between you and a move,
 * which turns a wide turn into RW — something this model reads happily and
 * twisty-player does not read at all. An unreadable alg is not a slow cube,
 * it is a cube that stops dead, which is what "the preview glitches on wide
 * moves" was. So everything on its way to the player comes through here:
 * RW and rw become Rw, X becomes x, and 2' becomes 2.
 */
export function canonical(alg) {
  const toks = typeof alg === 'string' ? parse(alg) : alg;
  if (!toks) return null;
  return toks.map(({ letter, wide, amount }) => {
    const suffix = amount === 2 ? '2' : amount === 3 ? "'" : '';
    if (wide) return letter.toUpperCase() + 'w' + suffix;
    return letter + suffix;
  }).join(' ');
}

/**
 * Apply an alg to a position.
 * `frame` carries the rotations already accumulated; pass the one that came
 * out of the last call to keep a running reconstruction consistent.
 */
export function applyAlg(state, alg, frame = IDENTITY_FRAME) {
  const toks = typeof alg === 'string' ? parse(alg) : alg;
  if (!toks) return null;
  let cur = clone(state);
  let buf = new Uint8Array(40);
  let f = frame;

  const face = (letter, amount) => {
    const solver = f[letter];
    mulInto(buf, cur, MOVES[moveIndex(solver, amount)]);
    [cur, buf] = [buf, cur];
  };
  // One quarter of a slice, written as two face turns either side of a
  // rotation. M = L' x' R, E = D' y' U, S = F' z B — each verified by the fact
  // that l = L M, d = D E and f = F S.
  const slice = (letter) => {
    if (letter === 'M') { face('L', 3); f = turnFrame(f, 'x', 3); face('R', 1); }
    else if (letter === 'E') { face('D', 3); f = turnFrame(f, 'y', 3); face('U', 1); }
    else { face('F', 3); f = turnFrame(f, 'z', 1); face('B', 1); }
  };

  for (const t of toks) {
    const { letter, wide, amount } = t;
    if (letter === 'x' || letter === 'y' || letter === 'z') { f = turnFrame(f, letter, amount); continue; }
    if (letter === 'M' || letter === 'E' || letter === 'S') {
      // M2 is M twice, and each pass drags the frame with it.
      for (let n = 0; n < amount; n++) slice(letter);
      continue;
    }
    const lower = wide ? letter.toLowerCase() : letter;
    if (EXPAND[lower]) {
      for (let n = 0; n < amount; n++) {
        for (const [kind, arg] of EXPAND[lower]) {
          if (kind === 'rot') f = turnFrame(f, arg, 1);
          else face(arg, 1);
        }
      }
      continue;
    }
    face(letter, amount);
  }
  return { state: cur, frame: f };
}

/* ---------------- stickers ----------------
   Every phase question ("is the cross done?") is easier to ask of stickers
   than of orientation numbers, and it cannot be got wrong by picking the
   wrong orientation convention. */

const CF = [[8, 9, 20], [6, 18, 38], [0, 36, 47], [2, 45, 11],
            [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51]];
const EF = [[5, 10], [7, 19], [3, 37], [1, 46], [32, 16], [28, 25],
            [30, 43], [34, 52], [23, 12], [21, 41], [50, 39], [48, 14]];
const CC = CORNER_NAMES.map(n => [...n]);
const EC = EDGE_NAMES.map(n => [...n]);

/* Which facelets a slot owns, in the order its name spells them: CORNER_FACELETS[i][k]
   is the sticker of corner slot i that faces CORNER_NAMES[i][k]. That is what makes
   "are these two pieces showing the same colour on the face they share?" — the
   question that decides whether an F2L pair is already built — a lookup rather than
   a geometry problem. It is also what lets the blindfolded tracer treat "sticker
   index" and "facelet index" as two names for one thing. */
export const CORNER_FACELETS = CF;
export const EDGE_FACELETS = EF;

/** 54 face letters, in U R F D L B order. Centres never move, so a sticker
    matching its face letter is a sticker that is home. */
export function facelets(s) {
  const f = new Array(54);
  for (let i = 0; i < 6; i++) f[i * 9 + 4] = FACES[i];
  for (let i = 0; i < 8; i++) {
    const o = s[8 + i];
    for (let k = 0; k < 3; k++) f[CF[i][(k + o) % 3]] = CC[s[i]][k];
  }
  for (let i = 0; i < 12; i++) {
    const o = s[28 + i];
    for (let k = 0; k < 2; k++) f[EF[i][(k + o) % 2]] = EC[s[16 + i]][k];
  }
  return f;
}

/* ---------------- phases ----------------
   The cross face is never assumed. Whichever face has its four edges home is
   the cross; before that, the solver picks whichever is closest. That is what
   makes this work for a colour-neutral solver, and for anyone who starts a
   reconstruction with x2 or z'. */

/** The four edges belonging to a face, by cubie index. */
export const faceEdges = (face) => EDGE_NAMES
  .map((n, i) => ({ n, i })).filter(e => e.n.includes(face)).map(e => e.i);

/** The four F2L pairs for a cross on `face`, as {corner, edge, name}. */
export function slotsFor(face) {
  return CORNER_NAMES.map((n, ci) => ({ n, ci })).filter(c => c.n.includes(face)).map(c => {
    const others = [...c.n].filter(x => x !== face).join('');
    const ei = edgeIndex(others);
    return { corner: c.ci, edge: ei, name: others, label: EDGE_NAMES[ei] };
  });
}

const edgeHome = (s, i) => s[16 + i] === i && s[28 + i] === 0;
const cornerHome = (s, i) => s[i] === i && s[8 + i] === 0;

export const crossDone = (s, face) => faceEdges(face).every(i => edgeHome(s, i));

/** Moves the cross still needs, as a count of edges home — a cheap stand-in
    used only for choosing a face before the real table exists. */
const crossScore = (s, face) => faceEdges(face).filter(i => edgeHome(s, i)).length;

export function analyse(s, prefer = null) {
  // A finished cross wins outright; otherwise take the face that is closest,
  // and break a tie towards D, where most people build it. `prefer` is the
  // colour picker in the panel saying "I meant the blue one" — it holds until
  // some other cross is actually finished.
  let face = 'D', best = -1;
  for (const f of ['D', 'U', 'F', 'B', 'L', 'R']) {
    const n = crossScore(s, f) * 10 + (f === 'D' ? 1 : 0);
    if (n > best) { best = n; face = f; }
  }
  // A named colour is an instruction, not a hint: if you say white cross, every
  // question after this is asked about the white cross, finished or not.
  if (prefer && FACES.includes(prefer)) face = prefer;
  const cross = crossDone(s, face);
  const slots = slotsFor(face).map(sl => ({
    ...sl,
    done: cross && cornerHome(s, sl.corner) && edgeHome(s, sl.edge),
  }));
  const f2l = slots.every(sl => sl.done);
  const ll = FACES.find(x => isOpposite(x, face));
  const fl = facelets(s);
  const llIdx = FACES.indexOf(ll) * 9;
  const oll = f2l && Array.from({ length: 9 }, (_, i) => fl[llIdx + i]).every(c => c === ll);
  const solved = fl.every((c, i) => c === FACES[Math.floor(i / 9)]);
  /* The last layer's edges already the right way up — the cross showing on
     top. It is the only thing that separates an OLL you have to follow with a
     PLL from one ZBLL alg can finish on its own. */
  const eo = [1, 3, 5, 7].every(i => fl[llIdx + i] === ll);

  let phase = 'cross';
  if (solved) phase = 'done';
  else if (oll) phase = 'pll';
  else if (f2l) phase = 'oll';
  else if (cross) phase = 'f2l';

  return { face, ll, cross, slots, f2l, oll, eo, solved, phase };
}

const OPP = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'B', B: 'F' };
const isOpposite = (a, b) => OPP[a] === b;
export { OPP };
