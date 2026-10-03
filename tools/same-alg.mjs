/* ===========================================================
   When are two algorithms the same algorithm?

   When they turn the same layers in the same order, once you stop counting
   how the cube is held. `y L' U' L` turns the front face: it is `F' U' F`
   with a regrip in front. A wide turn is the opposite face plus a rotation
   (`d` is `y' U`, `r` is `x L`), so `d' F R U R' F'` is `U' R B U B' R'`.
   An opening or closing U turn is ignored too — the trainer adds the one a
   case needs, and every check in js/alglibrary.js treats it as free.

   Used by tools/import-lastslot.mjs to drop repeats, and by
   tools/verify-alglibrary.mjs to keep them out.
   =========================================================== */

import { tidy } from '../js/util.js';

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
const flip = (s) => (s === "'" ? '' : s === '' ? "'" : s);
const times = (suf) => (suf === '2' ? 2 : suf === "'" ? 3 : 1);

/**
 * The face turns `alg` makes, named on the cube as it was held at the start —
 * rotations taken out, and wide turns read as the face turn and rotation they
 * are. `y L' U' L` turns the front face, so it comes out as `F' U' F`;
 * `d' F R U R' F'` comes out as `U' R B U B' R'`.
 */
export function faceTurns(alg) {
  let at = Object.fromEntries(FACES.map(f => [f, f]));
  const rotate = (axis, n) => {
    for (let i = 0; i < n; i++) {
      const next = { ...at };
      for (const [to, from] of Object.entries(ROT[axis])) next[to] = at[from];
      at = next;
    }
  };
  const out = [];
  for (const tok of alg.split(' ').filter(Boolean)) {
    const m = /^([URFDLBurfdlbMESxyz])(2|'|)$/.exec(tok);
    if (!m) return null;
    const [, letter, suf] = m;
    if (ROT[letter]) rotate(letter, times(suf));
    else if (WIDE[letter]) {
      const [rot, face] = WIDE[letter];
      out.push(at[face] + suf);
      rotate(rot[0], (times(suf) * (rot.endsWith("'") ? 3 : 1)) % 4);
    } else if (SLICE[letter]) {
      const [s, dir] = SLICE_OF[at[SLICE[letter]]];
      out.push(s + (dir ? flip(suf) : suf));
    } else out.push(at[letter] + suf);
  }
  return tidy(out.join(' '));
}

/** Same key, same algorithm: face turns only, the opening and closing U turns off. */
export function sameAlgKey(alg) {
  const moves = (faceTurns(alg) || alg).split(' ').filter(Boolean);
  while (moves.length > 1 && /^U/.test(moves[0])) moves.shift();
  while (moves.length > 1 && /^U/.test(moves.at(-1))) moves.pop();
  return moves.join(' ');
}

/** How many whole-cube rotations an algorithm spells out. */
export const rotations = (alg) => alg.split(' ').filter(t => /^[xyz]/.test(t)).length;
