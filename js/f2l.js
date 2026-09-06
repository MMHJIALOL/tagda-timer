/* ===========================================================
   Tagda Timer — the 41 F2L cases.

   A trainer scramble is the inverse of the case's alg, so what is
   stored here is one solution per case, written in plain outer-face
   turns: reversing a token list is only a true inverse when there is
   no rotation in it to change what the letters after it mean.

   Every alg was picked out of SpeedCubeDB's F2L list — the shortest
   spelling of each case once rotations, slices and wide turns are
   rewritten away — and then checked against js/cube3.js: applying it
   to the position it claims to solve really does solve it, the cross
   survives, and exactly three pairs are already in. test.html runs
   that check on all 41.

   `group` is how F2L is taught: recognise what the pair is doing
   first, then the case.
   =========================================================== */

const F = (n, group, alg) => ({ id: 'F2L' + n, name: String(n), label: F2L_GROUPS[group], group, alg });

export const F2L_GROUPS = {
  free:   'Free pair',
  split:  'Split pair',
  joined: 'Joined pair',
  corner: 'Corner in slot',
  edge:   'Edge in slot',
  both:   'Both in slot',
};

export const F2L = [
  F( 1, 'free',    "U R U' R'"),
  F( 2, 'free',    "F R' F' R"),
  F( 3, 'free',    "F' U' F"),
  F( 4, 'free',    "R U R'"),
  F( 5, 'split',   "U' R U R' U2 R U' R'"),
  F( 6, 'split',   "U' L F' R' F R F L'"),
  F( 7, 'split',   "U' R U2 R' U' R U2 R'"),
  F( 8, 'split',   "L' B2 R2 B R2 B L"),
  F( 9, 'split',   "U' R U' R' U F' U' F"),
  F(10, 'split',   "U' R U R' U R U R'"),
  F(11, 'joined',  "U' R U2 R' U F' U' F"),
  F(12, 'joined',  "R U' R' U R U' R' U2 R U' R'"),
  F(13, 'joined',  "U F' U F U' F' U' F"),
  F(14, 'joined',  "U' R U' R' U R U R'"),
  F(15, 'joined',  "L' R B L U' L' B' L' R L' R L' R"),
  F(16, 'joined',  "R U' R' U2 F' U' F"),
  F(17, 'joined',  "R U2 R' U' R U R'"),
  F(18, 'joined',  "F' U2 F U F' U' F"),
  F(19, 'split',   "U R U2 R' U R U' R'"),
  F(20, 'split',   "U' F' U2 F U' F' U F"),
  F(21, 'split',   "U2 R U R' U R U' R'"),
  F(22, 'split',   "L F' L' U2 L F L'"),
  F(23, 'joined',  "U R U' R' U' R U' R' U R U' R'"),
  F(24, 'joined',  "F U R U' R' F' R U' R'"),
  F(25, 'corner',  "U' R' F R F' R U R'"),
  F(26, 'corner',  "U R U' R' F R' F' R"),
  F(27, 'corner',  "R U' R' U R U' R'"),
  F(28, 'corner',  "R U R' U' F R' F' R"),
  F(29, 'corner',  "R' F R F' U R U' R'"),
  F(30, 'corner',  "R U R' U' R U R'"),
  F(31, 'edge',    "U' R' F R F' R U' R'"),
  F(32, 'edge',    "U R U' R' U R U' R' U R U' R'"),
  F(33, 'edge',    "U' R U' R' U2 R U' R'"),
  F(34, 'edge',    "U R U R' U2 R U R'"),
  F(35, 'edge',    "U' R U R' U F' U' F"),
  F(36, 'edge',    "U F' U' F U' R U R'"),
  F(37, 'both',    "R2 U2 F R2 F' U2 R' U R'"),
  F(38, 'both',    "R U' R' U' R U R' U2 R U' R'"),
  F(39, 'both',    "R U' R' U R U2 R' U R U' R'"),
  F(40, 'both',    "L F' L' U2 L F L' R U R'"),
  F(41, 'both',    "R U' R' L F' L' U2 L F L'"),
];
