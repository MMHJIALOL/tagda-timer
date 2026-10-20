/* ===========================================================
   Tagda Timer — triggers in brackets.

   An alg is remembered as a handful of chunks your hands already know —
   sexy move, sledgehammer, an R U R' insert — not as fourteen separate
   turns. Written with those chunks in brackets, the way cubers write them
   down, it reads the way it is executed:

     R U R' U' R' F R2 U' R' U' R U R' F'
     (R U R' U') R' F R2 U' (R' U' R U) R' F'

   Display only. The stored alg stays plain notation: it is what scrambles
   are built from, what algKey compares and what the verifier executes.
   Brackets never change a move, so stripping them gives the alg back.

   Read left to right, longest trigger first, so a sexy move is never cut
   into an R U R' and a stray U'. Moves that belong to no trigger are left
   as they are rather than forced into a group.
   =========================================================== */

/* Right-hand originals; every one also gets its left-hand mirror below. */
const RIGHT = [
  "R U R' U'",   // sexy move
  "U R U' R'",   // sexy move, undone
  "R' U' R U",   // reverse sexy
  "R' F R F'",   // sledgehammer
  "F R' F' R",   // hedgeslammer
  "r U R' U'",   // wide sexy
  "R' D' R D",   // the D-layer sexy from corner inserts
  "R U R'", "R U' R'", "R' U R", "R' U' R", "R U2 R'", "R' U2 R",
  "r U r'", "r U' r'", "r' U r", "r' U' r", "r U2 r'", "r' U2 r",
];

/* Mirror through the M slice: R and L swap, every turn changes direction. */
const SWAP = { R: 'L', L: 'R', r: 'l', l: 'r' };
const mirrorMove = (m) => {
  const face = SWAP[m[0]] || m[0];
  const suf = m.slice(1);
  return face + (suf === '2' ? '2' : suf === "'" ? '' : "'");
};
const mirror = (alg) => alg.split(' ').map(mirrorMove).join(' ');

/* Spellings that turn the same layers: Rw is r, R2' is R2. */
const norm = (m) => m.replace(/^([URFDLB])w/, (_, f) => f.toLowerCase()).replace(/2'$/, '2');

const TRIGGERS = [...new Set(RIGHT.flatMap(a => [a, mirror(a)]))]
  .map(a => a.split(' '))
  .sort((a, b) => b.length - a.length);

/**
 * The alg with its triggers in brackets. Text that already has brackets,
 * or is not plain space-separated moves, comes back untouched.
 */
export function bracketTriggers(alg) {
  const text = String(alg || '').trim();
  if (!text || /[()[\]]/.test(text)) return text;
  const moves = text.split(/\s+/);
  const key = moves.map(norm);
  const out = [];
  for (let i = 0; i < moves.length;) {
    const hit = TRIGGERS.find(tr => tr.every((m, k) => key[i + k] === m));
    if (hit) {
      out.push(`(${moves.slice(i, i + hit.length).join(' ')})`);
      i += hit.length;
    } else {
      out.push(moves[i++]);
    }
  }
  return out.join(' ');
}

/** Brackets (or square brackets) taken back out, for an alg pasted in. */
export const stripBrackets = (text) => String(text || '').replace(/[()[\]]/g, ' ').trim().split(/\s+/).join(' ');
