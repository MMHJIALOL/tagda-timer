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

import { faceTurns } from '../js/faceturns.js';

export { faceTurns };

/** Same key, same algorithm: face turns only, the opening and closing U turns off. */
export function sameAlgKey(alg) {
  const moves = (faceTurns(alg) || alg).split(' ').filter(Boolean);
  while (moves.length > 1 && /^U/.test(moves[0])) moves.shift();
  while (moves.length > 1 && /^U/.test(moves.at(-1))) moves.pop();
  return moves.join(' ');
}

/** How many whole-cube rotations an algorithm spells out. */
export const rotations = (alg) => alg.split(' ').filter(t => /^[xyz]/.test(t)).length;
