/* ===========================================================
   Tagda Timer — PLL algorithm library.

   Alternate algorithms per PLL case, ranked best (index 0) to
   worst, for an "algorithm library" browsing feature (like
   CubeDB / algdb.net). Sourced and cross-checked against
   SpeedCubeDB (community vote counts) and the Speedsolving.com
   wiki PLL page. moveCount is the move count in ETM (execution/
   slice turn metric, counting rotations and slice moves as full
   moves) as reported by those sources.

   Ranking within each case follows community vote share on
   SpeedCubeDB (a proxy for "most commonly used/recommended"),
   tie-broken toward fewer moves / better known finger tricks.
   Where a case only has 1-2 genuinely distinct, well-known
   alternates, fewer than 5 entries are listed rather than
   padding with obscure variants.

   VERIFIED. Every entry below has been executed against its own
   case by tools/verify-alglibrary.html and ends on a solved cube.
   Re-run it after any edit here — the first pass of this file
   shipped an Ab alg that did not solve Ab, a Ub entry containing
   "R3" (not a move), and seven notes claiming to match this app's
   default alg when they did not. None of that is visible by
   reading; all of it is one page load away.
   =========================================================== */

export const PLL_LIBRARY = {
  Aa: {
    alternates: [
      { alg: "x R' U R' D2 R U' R' D2 R2 x'", moveCount: 11, notes: "most popular Aa, clean R-U-D fingertricks, by far the community favorite" },
      { alg: "y' x L2 D2 L' U' L D2 L' U L'", moveCount: 10, notes: "mirrored left-hand version, popular with left-dominant solvers" },
      { alg: "y x' R2 D2 R' U' R D2 R' U R' x", moveCount: 11, notes: "alternate angle of the standard alg, same fingertricks shifted" },
      { alg: "l' U R' D2 R U' R' D2 R2 x'", moveCount: 10, notes: "wide-move variant, slightly fewer moves but less common" },
    ],
  },

  Ab: {
    alternates: [
      { alg: "x R2 D2 R U R' D2 R U' R x'", moveCount: 11, notes: "most popular Ab, mirror of the standard Aa alg" },
      { alg: "y x' L2 D2 L U L' D2 L U' L", moveCount: 11, notes: "mirrored left-hand version, popular with left-dominant solvers" },
      { alg: "y x' R U' R D2 R' U R D2 R2 x", moveCount: 11, notes: "alternate recognition angle of the standard alg" },
      { alg: "R' B' R U' R D R' U R D' R2 B R", moveCount: 13, notes: "no-rotation alternative, more moves, rarely used at speed" },
    ],
  },

  E: {
    alternates: [
      { alg: "x' R U' R' D R U R' D' R U R' D R U' R' D' x", moveCount: 18, notes: "most popular E-perm, repeating R U R' D triggers, easy to learn" },
      { alg: "y R' U' R' D' R U' R' D R U R' D' R U R' D R2", moveCount: 17, notes: "alternate angle, one move shorter in this source's count" },
      { alg: "R2 U F' R' U R U' R' U R U' R' U R U' F U' R2", moveCount: 18, notes: "no cube rotation needed, but harder execution" },
      { alg: "x' L' U L D' L' U' L D L' U' L D' L' U L D", moveCount: 17, notes: "mirrored left-hand version of the standard alg" },
    ],
  },

  F: {
    alternates: [
      { alg: "y R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R", moveCount: 18, notes: "most popular F-perm and this app's default, standard in most tutorials" },
      { alg: "y R' F R f' R' F R2 U R' U' R' F' R2 U R' S", moveCount: 16, notes: "fewer moves but relies on slice/rotation tricks, less beginner friendly" },
      { alg: "R' U R U' R2 F' U' F U R F R' F' R2", moveCount: 14, notes: "shortest common F-perm, fast once drilled but less intuitive" },
      { alg: "y R2 F R F' R' U' F' U F R2 U R' U' R", moveCount: 14, notes: "another short variant, similar speed potential to the above" },
    ],
  },

  Ga: {
    alternates: [
      { alg: "R2 U R' U R' U' R U' R2 D U' R' U R D'", moveCount: 15, notes: "most popular Ga; this app's default written with the commuting D and U' swapped" },
      { alg: "R2 u R' U R' U' R u' R2 F' U F", moveCount: 12, notes: "shorter wide-move variant, fast but trickier recognition of the u slice" },
      { alg: "y R U R' F' R U R' U' R' F R U' R' F R2 U' R' U' R U R' F'", moveCount: 22, notes: "much longer alternative, mostly of historical interest" },
      { alg: "D' R2 U R' U R' U' R U' R2 U' D R' U R", moveCount: 15, notes: "same length as the top alg, alternate D-layer timing" },
    ],
  },

  Gb: {
    alternates: [
      { alg: "D R' U' R U D' R2 U R' U R U' R U' R2", moveCount: 15, notes: "top-voted Gb variant, smooth D-layer setup" },
      { alg: "R' U' R U D' R2 U R' U R U' R U' R2 D", moveCount: 15, notes: "matches this app's existing default alg, nearly as popular as the top pick" },
      { alg: "y F' U' F R2 u R' U R U' R u' R2", moveCount: 12, notes: "shorter wide-move alternative, faster once the u-slice trick is comfortable" },
      { alg: "R' d' F R2 u R' U R U' R u' R2", moveCount: 12, notes: "similar short variant using a d slice instead" },
    ],
  },

  Gc: {
    alternates: [
      { alg: "R2 U' R U' R U R' U R2 D' U R U' R' D", moveCount: 15, notes: "top-voted Gc; this app's default written with the commuting D' and U swapped" },
      { alg: "y2 R2 F2 R U2 R U2 R' F R U R' U' R' F R2", moveCount: 15, notes: "close second in popularity, different trigger shape" },
      { alg: "D R2 U' R U' R U R' U R2 D' U R U' R'", moveCount: 15, notes: "same move count, alternate D-layer timing" },
      { alg: "R2 u' R U' R U R' u R2 f R' f'", moveCount: 12, notes: "shorter wide-move variant, less commonly taught" },
    ],
  },

  Gd: {
    alternates: [
      { alg: "R U R' U' D R2 U' R U' R' U R' U R2 D'", moveCount: 15, notes: "top-voted Gd, matches this app's existing default alg" },
      { alg: "D' R U R' U' D R2 U' R U' R' U R' U R2", moveCount: 15, notes: "same length, alternate D-layer timing" },
      { alg: "R U R' y' R2 u' R U' R' U R' u R2", moveCount: 13, notes: "shorter wide-move variant, faster but less common" },
      { alg: "y R2 F' R U R U' R' F' R U2 R' U2 R' F2 R2", moveCount: 15, notes: "less common alternative with F-trigger framing" },
    ],
  },

  H: {
    alternates: [
      { alg: "M2 U M2 U2 M2 U M2", moveCount: 7, notes: "most popular H-perm, matches this app's default, symmetric and fast" },
      { alg: "M2 U' M2 U2 M2 U' M2", moveCount: 7, notes: "mirrored AUF direction, essentially equally popular" },
      { alg: "R2 S2 R2 U' R2 S2 R2", moveCount: 7, notes: "no-M-slice alternative for solvers who avoid M turns" },
      { alg: "M2 U2 M2 U M2 U2 M2", moveCount: 7, notes: "another AUF variant of the same trigger" },
    ],
  },

  Ja: {
    alternates: [
      { alg: "y2 x R2 F R F' R U2 r' U r U2 x'", moveCount: 12, notes: "most popular Ja, quick R2 F trigger opener" },
      { alg: "y R' U L' U2 R U' R' U2 R L", moveCount: 10, notes: "matches this app's existing default alg style, fewer moves, well known" },
      { alg: "L' U' L F L' U' L U L F' L2 U L", moveCount: 13, notes: "no-AUF alternative but noticeably more moves" },
      { alg: "R U' L' U R' U2 L U' L' U2 L", moveCount: 11, notes: "another common short variant" },
    ],
  },

  Jb: {
    alternates: [
      { alg: "R U R' F' R U R' U' R' F R2 U' R'", moveCount: 13, notes: "by far the most popular Jb; this app's default without its trailing AUF" },
      { alg: "R U2 R' U' R U2 L' U R' U' L", moveCount: 11, notes: "fewer moves, distant second in popularity" },
      { alg: "r' F R F' r U2 R' U R U2 R'", moveCount: 11, notes: "wide-move variant, uncommon but efficient" },
      { alg: "L' U R U' L U2 R' U R U2 R'", moveCount: 11, notes: "mirrored-style alternative, rarely used" },
    ],
  },

  Na: {
    alternates: [
      { alg: "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'", moveCount: 21, notes: "most popular Na, matches this app's existing default alg" },
      { alg: "F' R U R' U' R' F R2 F U' R' U' R U F' R'", moveCount: 16, notes: "notably shorter, second most common choice" },
      { alg: "R F U' R' U R U F' R2 F' R U R U' R' F", moveCount: 16, notes: "similar length alternative with different trigger framing" },
      { alg: "r' D r U2 r' D r U2 r' D r U2 r' D r U2 r' D r", moveCount: 19, notes: "repeated-trigger algorithm, easy to learn but slower in practice" },
    ],
  },

  Nb: {
    alternates: [
      { alg: "R' U R U' R' F' U' F R U R' F R' F' R U' R", moveCount: 17, notes: "most popular Nb, matches this app's existing default alg" },
      { alg: "r' D' F r U' r' F' D r2 U r' U' r' F r F'", moveCount: 16, notes: "close second, wide-move variant, slightly fewer moves" },
      { alg: "R' U L' U2 R U' L R' U L' U2 R U' L", moveCount: 14, notes: "shortest common Nb, but less finger-trick-friendly" },
      { alg: "R' U R U' R' F' U' F R U R' U' R U' f R f'", moveCount: 17, notes: "less common alternative ending in a slice trigger" },
    ],
  },

  Ra: {
    alternates: [
      { alg: "y R U' R' U' R U R D R' U' R D' R' U2 R'", moveCount: 15, notes: "most popular Ra; this app's default from a rotated angle, without the trailing AUF" },
      { alg: "y R U R' F' R U2 R' U2 R' F R U R U2 R' U'", moveCount: 15, notes: "second most common, different trigger shape, same length" },
      { alg: "L U2 L' U2 L F' L' U' L U L F L2", moveCount: 13, notes: "shorter mirrored variant, fewer moves but less taught" },
      { alg: "y R U' R' U' R U R' U R' D' R U' R' D R2 U R'", moveCount: 17, notes: "longer, uncommon alternative" },
    ],
  },

  Rb: {
    alternates: [
      { alg: "R' U2 R U2 R' F R U R' U' R' F' R2", moveCount: 13, notes: "most popular Rb, R' U2 opener, easier recognition than the F-trigger version" },
      { alg: "y R2 F R U R U' R' F' R U2 R' U2 R", moveCount: 13, notes: "close second in popularity, and this app's default alg" },
      { alg: "R' U2 R' D' R U' R' D R U R U' R' U' R", moveCount: 15, notes: "longer alternative, less commonly used" },
      { alg: "y R' U R U R' U' R' D' R U R' D R U2 R", moveCount: 15, notes: "rare alternative, mostly of academic interest" },
    ],
  },

  T: {
    alternates: [
      { alg: "R U R' U' R' F R2 U' R' U' R U R' F'", moveCount: 14, notes: "overwhelmingly the most popular T-perm, matches this app's existing default alg" },
      { alg: "R U R' U' R' F R2 U' R' U F' L' U L", moveCount: 14, notes: "same length variant, distant second in popularity" },
      { alg: "R2 u R2 u' R2 F2 u' F2 u F2", moveCount: 10, notes: "shorter wide-move alternative, uncommon but efficient once learned" },
    ],
  },

  Ua: {
    alternates: [
      { alg: "y2 M2 U M U2 M' U M2", moveCount: 7, notes: "most popular Ua among M-slice users, very fast" },
      { alg: "R U R' U R' U' R2 U' R' U R' U R", moveCount: 13, notes: "no M turns needed, close second in votes" },
      { alg: "y R2 U' S' U2 S U' R2", moveCount: 7, notes: "short slice-turn alternative, popular with some solvers" },
      { alg: "y2 R U' R U R U R U' R' U' R2", moveCount: 11, notes: "this app's own default alg, no slice moves, fewest moves of the four" },
    ],
  },

  Ub: {
    alternates: [
      { alg: "y2 M2 U' M U2 M' U' M2", moveCount: 7, notes: "most popular Ub among M-slice users, very fast" },
      { alg: "R' U R' U' R' U' R' U R U R2", moveCount: 11, notes: "no-M-slice alternative, fewer moves than this app's existing default" },
      { alg: "y2 R2 U R U R' U' R' U' R' U R'", moveCount: 11, notes: "this app's default alg, shown from its usual recognition angle" },
    ],
  },

  V: {
    alternates: [
      { alg: "R' U R' U' R D' R' D R' U D' R2 U' R2 D R2", moveCount: 16, notes: "most popular V-perm variant" },
      { alg: "R' U R U' R' f' U' R U2 R' U' R U' R' f R", moveCount: 16, notes: "close second, common alternative with an f slice trigger" },
      { alg: "R' U R' U' y R' F' R2 U' R' U R' F R F", moveCount: 15, notes: "matches this app's existing default alg style, one move shorter" },
      { alg: "y R U' R U R' D R D' R U' D R2 U R2 D' R2", moveCount: 16, notes: "mirrored-angle alternative, similarly common" },
    ],
  },

  Y: {
    alternates: [
      { alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", moveCount: 17, notes: "by far the most popular Y-perm, matches this app's existing default alg" },
      { alg: "F R' F R2 U' R' U' R U R' F' R U R' U' F'", moveCount: 16, notes: "distant second in popularity, one move shorter" },
      { alg: "R2 U' R2 U' R2 U F U F' R2 F U' F'", moveCount: 13, notes: "notably shorter alternative, less common but efficient" },
      { alg: "F R' F' R U R U' R2 U' R U R f' U' f", moveCount: 15, notes: "rare alternative ending in a slice trigger" },
    ],
  },

  Z: {
    alternates: [
      { alg: "M' U' M2 U' M2 U' M' U2 M2", moveCount: 9, notes: "most popular Z-perm variant" },
      { alg: "M2 U M2 U M' U2 M2 U2 M'", moveCount: 9, notes: "close second, mirrored AUF timing" },
      { alg: "M' U M2 U M2 U M' U2 M2", moveCount: 9, notes: "matches this app's existing default alg, similarly common" },
      { alg: "y M2 U' M2 U' M' U2 M2 U2 M'", moveCount: 9, notes: "alternate recognition angle of a similar trigger" },
    ],
  },
};
