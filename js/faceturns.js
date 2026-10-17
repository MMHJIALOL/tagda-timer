/* ===========================================================
   Tagda Timer — an algorithm's face turns, rotations taken out

   `y L' U' L` turns the front face: it is `F' U' F` with a regrip in
   front. A wide turn is the opposite face plus a rotation (`d` is
   `y' U`, `r` is `x L`), so `d' F R U R' F'` is `U' R B U B' R'`.

   Scrambles need this. A scramble is an algorithm backwards, and
   `y U' L' U L` backwards is `L' U' L U y'`: performed from the way a
   scramble is held, with the closing y' quietly skipped as everyone
   does, that opens the front-left slot instead of the front-right one
   the algorithm solves. Backwards from its face turns it is
   `F' U' F U`, which opens the right one.
   =========================================================== */

import { tidy } from './util.js';

const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

/* Where each face a move names really is, once rotations have happened:
   after an x the face on top is the one that was in front. */
const ROT = {
  x: { U: 'F', F: 'D', D: 'B', B: 'U' },
  y: { L: 'F', B: 'L', R: 'B', F: 'R' },
  z: { R: 'U', D: 'R', L: 'D', U: 'L' },
};
/* A wide turn is the opposite face turned with a rotation: d is y' U, r is x L. */
const WIDE = { r: ['x', 'L'], l: ["x'", 'R'], u: ['y', 'D'], d: ["y'", 'U'], f: ['z', 'B'], b: ["z'", 'F'] };
const SLICE = { M: 'L', E: 'D', S: 'F' };          // a slice turns the way this face does
const SLICE_OF = { L: ['M', ''], R: ['M', "'"], D: ['E', ''], U: ['E', "'"], F: ['S', ''], B: ['S', "'"] };
const OUTER = { M: ['L', 'R', "x'"], E: ['D', 'U', "y'"], S: ['F', 'B', 'z'] };
const flip = (s) => (s === "'" ? '' : s === '' ? "'" : s);
const times = (suf) => (suf === '2' ? 2 : suf === "'" ? 3 : 1);

/**
 * The face turns `alg` makes, named on the cube as it was held at the start —
 * rotations taken out, and wide turns read as the face turn and rotation they
 * are. `y L' U' L` turns the front face, so it comes out as `F' U' F`;
 * `d' F R U R' F'` comes out as `U' R B U B' R'`.
 * With `slices: false` a slice comes out as its two outer faces too.
 */
export function faceTurns(alg, { slices = true } = {}) {
  let at = Object.fromEntries(FACES.map(f => [f, f]));
  const rotate = (axis, n) => {
    for (let i = 0; i < n; i++) {
      const next = { ...at };
      for (const [to, from] of Object.entries(ROT[axis])) next[to] = at[from];
      at = next;
    }
  };
  const out = [];
  for (const raw of alg.split(' ').filter(Boolean)) {
    /* Rw is r, and R2' is the same half turn as R2. */
    const tok = raw.replace(/^([URFDLB])w/, (_, f) => f.toLowerCase()).replace("2'", '2');
    const m = /^([URFDLBurfdlbMESxyz])(2|'|)$/.exec(tok);
    if (!m) return null;
    const [, letter, suf] = m;
    if (ROT[letter]) rotate(letter, times(suf));
    else if (WIDE[letter]) {
      const [rot, face] = WIDE[letter];
      out.push(at[face] + suf);
      rotate(rot[0], (times(suf) * (rot.endsWith("'") ? 3 : 1)) % 4);
    } else if (SLICE[letter] && !slices) {
      /* Outer turns only: a slice is its two faces and a rotation — M is
         L' R x', E is U D' y', S is F' B z. */
      const [a, b, rot] = OUTER[letter];
      out.push(at[a] + flip(suf), at[b] + suf);
      rotate(rot[0], (times(suf) * (rot.endsWith("'") ? 3 : 1)) % 4);
    } else if (SLICE[letter]) {
      const [s, dir] = SLICE_OF[at[SLICE[letter]]];
      out.push(s + (dir ? flip(suf) : suf));
    } else out.push(at[letter] + suf);
  }
  return tidy(out.join(' '));
}

