/* ===========================================================
   Tagda Timer — algorithm sets used to build trainer scrambles.

   A trainer scramble is generated as:
       AUF  +  inverse(solution alg)  +  AUF
   so the app always knows which case it handed you — that is what
   makes per-case statistics possible.
   =========================================================== */

/* ---------------------- PLL (21) ---------------------- */
export const PLL = [
  { id: 'Aa', name: 'Aa', group: 'corners', alg: "R' F R' B2 R F' R' B2 R2" },
  { id: 'Ab', name: 'Ab', group: 'corners', alg: "R B' R F2 R' B R F2 R2" },
  { id: 'E',  name: 'E',  group: 'corners', alg: "x' L' U L D' L' U' L D L' U' L D' L' U L D x" },
  { id: 'F',  name: 'F',  group: 'both',    alg: "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R" },
  { id: 'Ga', name: 'Ga', group: 'both',    alg: "R2 U R' U R' U' R U' R2 U' D R' U R D'" },
  { id: 'Gb', name: 'Gb', group: 'both',    alg: "R' U' R U D' R2 U R' U R U' R U' R2 D" },
  { id: 'Gc', name: 'Gc', group: 'both',    alg: "R2 U' R U' R U R' U R2 U D' R U' R' D" },
  { id: 'Gd', name: 'Gd', group: 'both',    alg: "R U R' U' D R2 U' R U' R' U R' U R2 D'" },
  { id: 'H',  name: 'H',  group: 'edges',   alg: "M2 U M2 U2 M2 U M2" },
  { id: 'Ja', name: 'Ja', group: 'both',    alg: "R' U2 R U R' U2 L U' R U L'" },
  { id: 'Jb', name: 'Jb', group: 'both',    alg: "R U R' F' R U R' U' R' F R2 U' R' U'" },
  { id: 'Na', name: 'Na', group: 'both',    alg: "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'" },
  { id: 'Nb', name: 'Nb', group: 'both',    alg: "R' U R U' R' F' U' F R U R' F R' F' R U' R" },
  { id: 'Ra', name: 'Ra', group: 'both',    alg: "R U' R' U' R U R D R' U' R D' R' U2 R' U'" },
  { id: 'Rb', name: 'Rb', group: 'both',    alg: "R2 F R U R U' R' F' R U2 R' U2 R" },
  { id: 'T',  name: 'T',  group: 'both',    alg: "R U R' U' R' F R2 U' R' U' R U R' F'" },
  { id: 'Ua', name: 'Ua', group: 'edges',   alg: "R U' R U R U R U' R' U' R2" },
  { id: 'Ub', name: 'Ub', group: 'edges',   alg: "R2 U R U R' U' R' U' R' U R'" },
  { id: 'V',  name: 'V',  group: 'both',    alg: "R' U R' U' y R' F' R2 U' R' U R' F R F y'" },
  { id: 'Y',  name: 'Y',  group: 'both',    alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'" },
  { id: 'Z',  name: 'Z',  group: 'edges',   alg: "M' U M2 U M2 U M' U2 M2" },
];

/* ---------------------- OLL (57) ---------------------- */
const O = (n, name, group, alg) => ({ id: 'OLL' + n, name: String(n), label: name, group, alg });

export const OLL = [
  O(1,  'Dot',      'dot',     "R U2 R2 F R F' U2 R' F R F'"),
  O(2,  'Dot',      'dot',     "F R U R' U' F' f R U R' U' f'"),
  O(3,  'Dot',      'dot',     "f R U R' U' f' U' F R U R' U' F'"),
  O(4,  'Dot',      'dot',     "f R U R' U' f' U F R U R' U' F'"),
  O(5,  'Square',   'square',  "r' U2 R U R' U r"),
  O(6,  'Square',   'square',  "r U2 R' U' R U' r'"),
  O(7,  'Small L',  'lshape',  "r U R' U R U2 r'"),
  O(8,  'Small L',  'lshape',  "r' U' R U' R' U2 r"),
  O(9,  'Fish',     'fish',    "R U R' U' R' F R2 U R' U' F'"),
  O(10, 'Fish',     'fish',    "R U R' U R' F R F' R U2 R'"),
  O(11, 'Small L',  'lshape',  "r U R' U R' F R F' R U2 r'"),
  O(12, 'Small L',  'lshape',  "M' R' U' R U' R' U2 R U' R r'"),
  O(13, 'Knight',   'knight',  "F U R U' R2 F' R U R U' R'"),
  O(14, 'Knight',   'knight',  "R' F R U R' F' R F U' F'"),
  O(15, 'Knight',   'knight',  "l' U' l L' U' L U l' U l"),
  O(16, 'Knight',   'knight',  "r U r' R U R' U' r U' r'"),
  O(17, 'Dot',      'dot',     "F R' F' R2 r' U R U' R' U' M'"),
  O(18, 'Dot',      'dot',     "r U R' U R U2 r2 U' R U' R' U2 r"),
  O(19, 'Dot',      'dot',     "r' R U R U R' U' M' R' F R F'"),
  O(20, 'Dot',      'dot',     "r U R' U' M2 U R U' R' U' M'"),
  O(21, 'Cross H',  'ocll',    "R U2 R' U' R U R' U' R U' R'"),
  O(22, 'Cross Pi', 'ocll',    "R U2 R2 U' R2 U' R2 U2 R"),
  O(23, 'Cross U',  'ocll',    "R2 D' R U2 R' D R U2 R"),
  O(24, 'Cross T',  'ocll',    "r U R' U' r' F R F'"),
  O(25, 'Cross L',  'ocll',    "F' r U R' U' r' F R"),
  O(26, 'Antisune', 'ocll',    "R U2 R' U' R U' R'"),
  O(27, 'Sune',     'ocll',    "R U R' U R U2 R'"),
  O(28, 'Corners',  'corner',  "r U R' U' r' R U R U' R'"),
  O(29, 'Awkward',  'awkward', "R U R' U' R U' R' F' U' F R U R'"),
  O(30, 'Awkward',  'awkward', "F R' F R2 U' R' U' R U R' F2"),
  O(31, 'P',        'pshape',  "R' U' F U R U' R' F' R"),
  O(32, 'P',        'pshape',  "L U F' U' L' U L F L'"),
  O(33, 'T',        'tshape',  "R U R' U' R' F R F'"),
  O(34, 'C',        'cshape',  "R U R2 U' R' F R U R U' F'"),
  O(35, 'Fish',     'fish',    "R U2 R2 F R F' R U2 R'"),
  O(36, 'W',        'wshape',  "L' U' L U' L' U L U L F' L' F"),
  O(37, 'Fish',     'fish',    "F R' F' R U R U' R'"),
  O(38, 'W',        'wshape',  "R U R' U R U' R' U' R' F R F'"),
  O(39, 'Big L',    'biglshape', "L F' L' U' L U F U' L'"),
  O(40, 'Big L',    'biglshape', "R' F R U R' U' F' U R"),
  O(41, 'Awkward',  'awkward', "R U R' U R U2 R' F R U R' U' F'"),
  O(42, 'Awkward',  'awkward', "R' U' R U' R' U2 R F R U R' U' F'"),
  O(43, 'P',        'pshape',  "F' U' L' U L F"),
  O(44, 'P',        'pshape',  "F U R U' R' F'"),
  O(45, 'T',        'tshape',  "F R U R' U' F'"),
  O(46, 'C',        'cshape',  "R' U' R' F R F' U R"),
  O(47, 'Small L',  'lshape',  "F' L' U' L U L' U' L U F"),
  O(48, 'Small L',  'lshape',  "F R U R' U' R U R' U' F'"),
  O(49, 'Small L',  'lshape',  "r U' r2 U r2 U r2 U' r"),
  O(50, 'Small L',  'lshape',  "r' U r2 U' r2 U' r2 U r'"),
  O(51, 'Big L',    'biglshape', "F U R U' R' U R U' R' F'"),
  O(52, 'Big L',    'biglshape', "R U R' U R U' B U' B' R'"),
  O(53, 'Small L',  'lshape',  "l' U2 L U L' U' L U L' U l"),
  O(54, 'Small L',  'lshape',  "r U2 R' U' R U R' U' R U' r'"),
  O(55, 'Big L',    'biglshape', "R U2 R2 U' R U' R' U2 F R F'"),
  O(56, 'Big L',    'biglshape', "r U r' U R U' R' U R U' R' r U' r'"),
  O(57, 'Corners',  'corner',  "R U R' U' M' U R U' r'"),
];

/* ------------------ 2-look subsets ------------------ */
export const OLL_EO = [
  { id: 'EO-dot',  name: 'Dot',  alg: "F R U R' U' F' f R U R' U' f'" },
  { id: 'EO-L',    name: 'L',    alg: "f R U R' U' f'" },
  { id: 'EO-line', name: 'Line', alg: "F R U R' U' F'" },
];

export const OCLL = OLL.filter(o => o.group === 'ocll')
  .map(o => ({ id: 'OCLL-' + o.name, name: o.label.replace('Cross ', ''), alg: o.alg }));

export const PLL_CP = [
  { id: 'CP-adj',  name: 'Adjacent', alg: "R U R' U' R' F R2 U' R' U' R U R' F'" },
  { id: 'CP-diag', name: 'Diagonal', alg: "F R U' R' U' R U R' F' R U R' U' R' F R F'" },
];

export const PLL_EP = PLL.filter(p => p.group === 'edges')
  .map(p => ({ id: 'EP-' + p.id, name: p.name, alg: p.alg }));

/* =========================================================
   Cross-preserving triggers.
   Every one of these restores the D-layer, so any composition
   of them (plus U turns) leaves the cross solved — which is how
   the "cross solved" and "last slot" trainers are generated
   without needing a full solver.
   ========================================================= */
export const CROSS_SAFE_TRIGGERS = [
  "R U R'",  "R U' R'",  "R U2 R'",  "R' U R",  "R' U' R",  "R' U2 R",
  "F' U F",  "F' U' F",  "F' U2 F",  "F U F'",  "F U' F'",  "F U2 F'",
  "L' U' L", "L' U L",   "L' U2 L",  "L U L'",  "L U' L'",  "L U2 L'",
  "B U B'",  "B U' B'",  "B U2 B'",  "B' U B",  "B' U' B",  "B' U2 B",
  "R U R' U R U2 R'", "R' U' R U' R' U2 R",
  "F R U R' U' F'", "R U R' U' R' F R F'",
];

export const U_MOVES = ["U", "U'", "U2", ""];

/* Move pools for subgroup-based trainers. */
export const POOLS = {
  '2gen': ["R", "R'", "R2", "U", "U'", "U2"],
  'lse':  ["M", "M'", "M2", "U", "U'", "U2"],
  'roux': ["R", "R'", "R2", "U", "U'", "U2", "M", "M'", "M2", "r", "r'", "r2"],
};

/** Face letter of a move token, for avoiding consecutive same-face moves. */
export const faceOf = (m) => m.replace(/['2]$/, '');
