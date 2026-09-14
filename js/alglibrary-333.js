/* ===========================================================
   Tagda Timer — the 3x3 sets that are steps rather than whole methods.

   Four sets live here, and none of them invents an algorithm: every case
   already exists in js/algs.js, because the trainer has drilled these
   since long before this page did. What was missing was a way to *look*
   at them — OCLL and the two-look halves were reachable from the mode
   picker and nowhere else, so the only way to see the seven corner cases
   as pictures was to start a timed session and wait for them to come up.

   Alternates come from the full OLL and PLL libraries wherever the case
   is literally the same case. An OCLL case is OLL 21-27 under a shorter
   name, and a PLL edge-permutation case is that PLL — so the researched
   alternates for those apply unchanged, and are re-verified against the
   case here like everything else (§7).

   Lazy-loaded: js/alglibrary.js sits on the timer's boot path and this
   does not need to.
   =========================================================== */

import { OLL, OCLL, OLL_EO, PLL, PLL_CP, PLL_EP } from './algs.js';
import { OLL_LIBRARY } from './alglibrary-oll.js';
import { PLL_LIBRARY } from './alglibrary-pll.js';

/* OCLL keeps algs.js's own order, which is OLL 21 to 27, so the two lists line
   up index for index. Derived rather than written out, so renaming a case in
   one place cannot silently unpair them. */
const OCLL_SOURCE = OLL.filter(o => o.group === 'ocll');

const remap = (cases, source, library) => {
  const out = {};
  cases.forEach((c, i) => {
    const from = library[source[i]?.id];
    if (from) out[c.id] = { alternates: from.alternates };
  });
  return out;
};

const OCLL_LIBRARY = remap(OCLL, OCLL_SOURCE, OLL_LIBRARY);
const EPLL_LIBRARY = remap(PLL_EP, PLL.filter(p => p.group === 'edges'), PLL_LIBRARY);

/* Edge orientation and corner permutation have no researched alternates yet.
   displayOrder() falls back to the case's own algorithm rather than an empty
   page, which is exactly what should happen — the list is short and true
   instead of long and padded. */

export const SETS = {
  OCLL: {
    id: 'OCLL',
    event: '333',
    label: 'OCLL',
    title: 'Orient the last layer corners — the second look of two-look OLL',
    cases: OCLL,
    library: OCLL_LIBRARY,
    done: 'oriented',
    picture: 'orientation',
    trained: true,
    trainerMode: 'ocll',
    caseLabel: (c) => c.name,
    describe: () => 'edges already oriented — turn the four corners up',
  },
  EOLL: {
    id: 'EOLL',
    event: '333',
    label: 'EO',
    title: 'Orient the last layer edges — the first look of two-look OLL',
    cases: OLL_EO,
    library: {},
    /* The trainer's two-look OLL mode holds both halves of the set, so
       training just these three is that mode with only these cases switched
       on — which is exactly what the case picker already does. */
    trained: true,
    trainerMode: 'oll2look',
    /* Only the edges have to come out of this. Asking for a solved cube would
       reject every correct algorithm except the one the case was built from. */
    done: 'eo',
    picture: 'orientation',
    caseLabel: (c) => `${c.name} case`,
    describe: (c) => (c.name === 'Dot' ? 'no edges oriented' : c.name === 'Line' ? 'two opposite edges oriented' : 'two adjacent edges oriented'),
  },
  CPLL: {
    id: 'CPLL',
    event: '333',
    label: 'CP',
    title: 'Permute the last layer corners — the first look of two-look PLL',
    cases: PLL_CP,
    library: {},
    trained: true,
    trainerMode: 'pll2look',
    done: 'cp',
    caseLabel: (c) => `${c.name} corners`,
    describe: (c) => (c.name === 'Adjacent' ? 'two neighbouring corners swap' : 'the two diagonals swap'),
  },
  EPLL: {
    id: 'EPLL',
    event: '333',
    label: 'EP',
    title: 'Permute the last layer edges — the second look of two-look PLL',
    cases: PLL_EP,
    library: EPLL_LIBRARY,
    trained: true,
    trainerMode: 'pll2look',
    angle: 'auf',
    caseLabel: (c) => `${c.name} perm`,
    describe: (c) => (c.name === 'H' ? 'both edge pairs swap across the middle'
                   : c.name === 'Z' ? 'both edge pairs swap side to side'
                   : 'three edges cycle, corners already done'),
  },
};
