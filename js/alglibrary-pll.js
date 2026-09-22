import { t } from './i18n.js';
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
      { alg: "x R' U R' D2 R U' R' D2 R2 x'", moveCount: 11, notes: t("most popular Aa, clean R-U-D fingertricks, by far the community favorite") },
      { alg: "y' x L2 D2 L' U' L D2 L' U L'", moveCount: 11, notes: t("mirrored left-hand version, popular with left-dominant solvers") },
      { alg: "y x' R2 D2 R' U' R D2 R' U R' x", moveCount: 12, notes: t("alternate angle of the standard alg, same fingertricks shifted") },
      { alg: "l' U R' D2 R U' R' D2 R2 x'", moveCount: 10, notes: t("wide-move variant, slightly fewer moves but less common") },
    ],
  },

  Ab: {
    alternates: [
      { alg: "U' x R2 D2 R U R' D2 R U' R x'", moveCount: 12, notes: t("most popular Ab, mirror of the standard Aa alg") },
      { alg: "y x' L2 D2 L U L' D2 L U' L", moveCount: 11, notes: t("mirrored left-hand version, popular with left-dominant solvers") },
      { alg: "x' R U' R D2 R' U R D2 R2 x", moveCount: 11, notes: t("alternate recognition angle of the standard alg") },
      { alg: "U' R' B' R U' R D R' U R D' R2 B R", moveCount: 14, notes: t("no-rotation alternative, more moves, rarely used at speed") },
    ],
  },

  E: {
    alternates: [
      { alg: "x' R U' R' D R U R' D' R U R' D R U' R' D' x", moveCount: 18, notes: t("most popular E-perm, repeating R U R' D triggers, easy to learn") },
      { alg: "R' U' R' D' R U' R' D R U R' D' R U R' D R2", moveCount: 17, notes: t("alternate angle, one move shorter in this source's count") },
      { alg: "U R2 U F' R' U R U' R' U R U' R' U R U' F U' R2", moveCount: 19, notes: t("no cube rotation needed, but harder execution") },
      { alg: "x' L' U L D' L' U' L D L' U' L D' L' U L D", moveCount: 17, notes: t("mirrored left-hand version of the standard alg") },
    ],
  },

  F: {
    alternates: [
      { alg: "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R", moveCount: 18, notes: t("most popular F-perm and this app's default, standard in most tutorials") },
      { alg: "R' F R f' R' F R2 U R' U' R' F' R2 U R' S", moveCount: 16, notes: t("fewer moves but relies on slice/rotation tricks, less beginner friendly") },
      { alg: "U' R' U R U' R2 F' U' F U R F R' F' R2", moveCount: 15, notes: t("shortest common F-perm, fast once drilled but less intuitive") },
      { alg: "R2 F R F' R' U' F' U F R2 U R' U' R", moveCount: 14, notes: t("another short variant, similar speed potential to the above") },
    ],
  },

  Ga: {
    alternates: [
      { alg: "R2 U R' U R' U' R U' R2 D U' R' U R D'", moveCount: 15, notes: t("most popular Ga; this app's default written with the commuting D and U' swapped") },
      { alg: "R2 u R' U R' U' R u' R2 F' U F", moveCount: 12, notes: t("shorter wide-move variant, fast but trickier recognition of the u slice") },
      { alg: "y R U R' F' R U R' U' R' F R U' R' F R2 U' R' U' R U R' F'", moveCount: 23, notes: t("much longer alternative, mostly of historical interest") },
      { alg: "D' R2 U R' U R' U' R U' R2 U' D R' U R", moveCount: 15, notes: t("same length as the top alg, alternate D-layer timing") },
    ],
  },

  Gb: {
    alternates: [
      { alg: "D R' U' R U D' R2 U R' U R U' R U' R2", moveCount: 15, notes: t("top-voted Gb variant, smooth D-layer setup") },
      { alg: "R' U' R U D' R2 U R' U R U' R U' R2 D", moveCount: 15, notes: t("matches this app's existing default alg, nearly as popular as the top pick") },
      { alg: "y F' U' F R2 u R' U R U' R u' R2", moveCount: 13, notes: t("shorter wide-move alternative, faster once the u-slice trick is comfortable") },
      { alg: "R' d' F R2 u R' U R U' R u' R2", moveCount: 12, notes: t("similar short variant using a d slice instead") },
    ],
  },

  Gc: {
    alternates: [
      { alg: "R2 U' R U' R U R' U R2 D' U R U' R' D", moveCount: 15, notes: t("top-voted Gc; this app's default written with the commuting D' and U swapped") },
      { alg: "y2 R2 F2 R U2 R U2 R' F R U R' U' R' F R2", moveCount: 16, notes: t("close second in popularity, different trigger shape") },
      { alg: "D R2 U' R U' R U R' U R2 D' U R U' R'", moveCount: 15, notes: t("same move count, alternate D-layer timing") },
      { alg: "R2 u' R U' R U R' u R2 f R' f'", moveCount: 12, notes: t("shorter wide-move variant, less commonly taught") },
    ],
  },

  Gd: {
    alternates: [
      { alg: "R U R' U' D R2 U' R U' R' U R' U R2 D'", moveCount: 15, notes: t("top-voted Gd, matches this app's existing default alg") },
      { alg: "D' R U R' U' D R2 U' R U' R' U R' U R2", moveCount: 15, notes: t("same length, alternate D-layer timing") },
      { alg: "R U R' y' R2 u' R U' R' U R' u R2", moveCount: 13, notes: t("shorter wide-move variant, faster but less common") },
      { alg: "y R2 F' R U R U' R' F' R U2 R' U2 R' F2 R2", moveCount: 16, notes: t("less common alternative with F-trigger framing") },
    ],
  },

  H: {
    alternates: [
      { alg: "M2 U M2 U2 M2 U M2", moveCount: 7, notes: t("most popular H-perm, matches this app's default, symmetric and fast") },
      { alg: "M2 U' M2 U2 M2 U' M2", moveCount: 7, notes: t("mirrored AUF direction, essentially equally popular") },
      { alg: "R2 S2 R2 U' R2 S2 R2", moveCount: 7, notes: t("no-M-slice alternative for solvers who avoid M turns") },
      { alg: "M2 U2 M2 U M2 U2 M2", moveCount: 7, notes: t("another AUF variant of the same trigger") },
    ],
  },

  Ja: {
    alternates: [
      { alg: "x R2 F R F' R U2 r' U r U2 x'", moveCount: 12, notes: t("most popular Ja, quick R2 F trigger opener") },
      { alg: "y' R' U L' U2 R U' R' U2 R L", moveCount: 11, notes: t("matches this app's existing default alg style, fewer moves, well known") },
      { alg: "U2 L' U' L F L' U' L U L F' L2 U L", moveCount: 14, notes: t("no-rotation alternative but noticeably more moves") },
      { alg: "U2 R U' L' U R' U2 L U' L' U2 L", moveCount: 12, notes: t("another common short variant") },
    ],
  },

  Jb: {
    alternates: [
      { alg: "R U R' F' R U R' U' R' F R2 U' R'", moveCount: 13, notes: t("by far the most popular Jb; this app's default without its trailing AUF") },
      { alg: "R U2 R' U' R U2 L' U R' U' L", moveCount: 11, notes: t("fewer moves, distant second in popularity") },
      { alg: "r' F R F' r U2 R' U R U2 R'", moveCount: 11, notes: t("wide-move variant, uncommon but efficient") },
      { alg: "L' U R U' L U2 R' U R U2 R'", moveCount: 11, notes: t("mirrored-style alternative, rarely used") },
    ],
  },

  Na: {
    alternates: [
      { alg: "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'", moveCount: 21, notes: t("most popular Na, matches this app's existing default alg") },
      { alg: "F' R U R' U' R' F R2 F U' R' U' R U F' R'", moveCount: 16, notes: t("notably shorter, second most common choice") },
      { alg: "R F U' R' U R U F' R2 F' R U R U' R' F", moveCount: 16, notes: t("similar length alternative with different trigger framing") },
      { alg: "r' D r U2 r' D r U2 r' D r U2 r' D r U2 r' D r", moveCount: 19, notes: t("repeated-trigger algorithm, easy to learn but slower in practice") },
    ],
  },

  Nb: {
    alternates: [
      { alg: "R' U R U' R' F' U' F R U R' F R' F' R U' R", moveCount: 17, notes: t("most popular Nb, matches this app's existing default alg") },
      { alg: "r' D' F r U' r' F' D r2 U r' U' r' F r F'", moveCount: 16, notes: t("close second, wide-move variant, slightly fewer moves") },
      { alg: "R' U L' U2 R U' L R' U L' U2 R U' L", moveCount: 14, notes: t("shortest common Nb, but less finger-trick-friendly") },
      { alg: "R' U R U' R' F' U' F R U R' U' R U' f R f'", moveCount: 17, notes: t("less common alternative ending in a slice trigger") },
    ],
  },

  Ra: {
    alternates: [
      { alg: "R U' R' U' R U R D R' U' R D' R' U2 R'", moveCount: 15, notes: t("most popular Ra; this app's default without the trailing AUF") },
      { alg: "R U R' F' R U2 R' U2 R' F R U R U2 R' U'", moveCount: 16, notes: t("second most common, different trigger shape, same length") },
      { alg: "U' L U2 L' U2 L F' L' U' L U L F L2", moveCount: 14, notes: t("shorter mirrored variant, fewer moves but less taught") },
      { alg: "R U' R' U' R U R' U R' D' R U' R' D R2 U R'", moveCount: 17, notes: t("longer, uncommon alternative") },
    ],
  },

  Rb: {
    alternates: [
      { alg: "R' U2 R U2 R' F R U R' U' R' F' R2", moveCount: 13, notes: t("most popular Rb, R' U2 opener, easier recognition than the F-trigger version") },
      { alg: "y R2 F R U R U' R' F' R U2 R' U2 R", moveCount: 14, notes: t("close second in popularity, and this app's default alg") },
      { alg: "R' U2 R' D' R U' R' D R U R U' R' U' R", moveCount: 15, notes: t("longer alternative, less commonly used") },
      { alg: "y R' U R U R' U' R' D' R U R' D R U2 R", moveCount: 16, notes: t("rare alternative, mostly of academic interest") },
    ],
  },

  T: {
    alternates: [
      { alg: "R U R' U' R' F R2 U' R' U' R U R' F'", moveCount: 14, notes: t("overwhelmingly the most popular T-perm, matches this app's existing default alg") },
      { alg: "R U R' U' R' F R2 U' R' U F' L' U L", moveCount: 14, notes: t("same length variant, distant second in popularity") },
      { alg: "R2 u R2 u' R2 F2 u' F2 u F2", moveCount: 10, notes: t("shorter wide-move alternative, uncommon but efficient once learned") },
    ],
  },

  Ua: {
    alternates: [
      { alg: "M2 U M U2 M' U M2", moveCount: 7, notes: t("most popular Ua among M-slice users, very fast") },
      { alg: "U2 R U R' U R' U' R2 U' R' U R' U R", moveCount: 14, notes: t("no M turns needed, close second in votes") },
      { alg: "y' R2 U' S' U2 S U' R2", moveCount: 8, notes: t("short slice-turn alternative, popular with some solvers") },
      { alg: "R U' R U R U R U' R' U' R2", moveCount: 11, notes: t("this app's own default alg, no slice moves, fewest moves of the four") },
    ],
  },

  Ub: {
    alternates: [
      { alg: "M2 U' M U2 M' U' M2", moveCount: 7, notes: t("most popular Ub among M-slice users, very fast") },
      { alg: "U2 R' U R' U' R' U' R' U R U R2", moveCount: 12, notes: t("no-M-slice alternative, fewer moves than this app's existing default") },
      { alg: "R2 U R U R' U' R' U' R' U R'", moveCount: 11, notes: t("this app's default alg") },
    ],
  },

  V: {
    alternates: [
      { alg: "R' U R' U' R D' R' D R' U D' R2 U' R2 D R2", moveCount: 16, notes: t("most popular V-perm variant") },
      { alg: "R' U R U' R' f' U' R U2 R' U' R U' R' f R", moveCount: 16, notes: t("close second, common alternative with an f slice trigger") },
      { alg: "R' U R' U' y R' F' R2 U' R' U R' F R F", moveCount: 15, notes: t("matches this app's existing default alg style, one move shorter") },
      { alg: "y R U' R U R' D R D' R U' D R2 U R2 D' R2", moveCount: 17, notes: t("mirrored-angle alternative, similarly common") },
    ],
  },

  Y: {
    alternates: [
      { alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'", moveCount: 17, notes: t("by far the most popular Y-perm, matches this app's existing default alg") },
      { alg: "F R' F R2 U' R' U' R U R' F' R U R' U' F'", moveCount: 16, notes: t("distant second in popularity, one move shorter") },
      { alg: "R2 U' R2 U' R2 U F U F' R2 F U' F'", moveCount: 13, notes: t("notably shorter alternative, less common but efficient") },
      { alg: "F R' F' R U R U' R2 U' R U R f' U' f", moveCount: 15, notes: t("rare alternative ending in a slice trigger") },
    ],
  },

  Z: {
    alternates: [
      { alg: "M' U' M2 U' M2 U' M' U2 M2", moveCount: 9, notes: t("most popular Z-perm variant") },
      { alg: "M2 U M2 U M' U2 M2 U2 M'", moveCount: 9, notes: t("close second, mirrored AUF timing") },
      { alg: "U M' U M2 U M2 U M' U2 M2", moveCount: 10, notes: t("matches this app's existing default alg, similarly common") },
      { alg: "y M2 U' M2 U' M' U2 M2 U2 M'", moveCount: 10, notes: t("alternate recognition angle of a similar trigger") },
    ],
  },
};
