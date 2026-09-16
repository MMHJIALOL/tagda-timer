/* ===========================================================
   Tagda Timer — two-look OLL and two-look PLL.

   Neither set invents an algorithm: every case already exists in
   js/algs.js, because the trainer's 2-look modes have drilled them for
   ages, and the ids here are those ids — so "Train these cases" hands the
   timer exactly the cases the mode already knows.

   Each set holds both of its looks. A case says which look it is with
   `done`: an edge-orientation case is finished when the edges face up, not
   when the whole last layer does, and a corner-permutation case when the
   corners are home. Asking either for a solved cube would reject every
   correct algorithm except the one the case was built from.

   Alternates for the second looks come from the full OLL and PLL libraries
   wherever the case is literally the same case — an OCLL case is OLL 21-27
   under a shorter name, and an edge-permutation case is that PLL — and are
   re-verified against the case here like everything else.

   Lazy-loaded: js/alglibrary.js sits on the timer's boot path and this
   does not need to.
   =========================================================== */

import { OLL, OCLL, OLL_EO, PLL, PLL_CP, PLL_EP } from './algs.js';
import { OLL_LIBRARY } from './alglibrary-oll.js';
import { PLL_LIBRARY } from './alglibrary-pll.js';

/* OCLL keeps algs.js's own order, which is OLL 21 to 27, so the two lists line
   up index for index. Derived rather than written out, so renaming a case in
   one place cannot silently unpair them. */
const remap = (cases, source, library) => {
  const out = {};
  cases.forEach((c, i) => {
    const from = library[source[i]?.id];
    if (from) out[c.id] = { alternates: from.alternates };
  });
  return out;
};

const EO_DESC = { Dot: 'no edges facing up', L: 'two neighbouring edges up', Line: 'two opposite edges up' };

export const SETS = {
  '2LOLL': {
    id: '2LOLL',
    event: '333',
    label: '2-Look OLL',
    title: 'Orient the edges, then the corners',
    cases: [
      ...OLL_EO.map(c => ({ ...c, group: 'Edges', done: 'eo' })),
      ...OCLL.map(c => ({ ...c, group: 'Corners', done: 'oriented' })),
    ],
    library: remap(OCLL, OLL.filter(o => o.group === 'ocll'), OLL_LIBRARY),
    picture: 'orientation',
    trained: true,
    trainerMode: 'oll2look',
    groups: ['Edges', 'Corners'],
    groupOf: (c) => c.group,
    defaultGroup: null,
    caseLabel: (c) => (c.group === 'Edges' ? `${c.name} edges` : c.name),
    describe: (c) => (c.group === 'Edges' ? EO_DESC[c.name] || 'orient the edges' : 'edges up — turn the corners up'),
  },
  '2LPLL': {
    id: '2LPLL',
    event: '333',
    label: '2-Look PLL',
    title: 'Permute the corners, then the edges',
    cases: [
      ...PLL_CP.map(c => ({ ...c, group: 'Corners', done: 'cp' })),
      ...PLL_EP.map(c => ({ ...c, group: 'Edges' })),
    ],
    library: remap(PLL_EP, PLL.filter(p => p.group === 'edges'), PLL_LIBRARY),
    trained: true,
    trainerMode: 'pll2look',
    angle: 'auf',
    groups: ['Corners', 'Edges'],
    groupOf: (c) => c.group,
    defaultGroup: null,
    caseLabel: (c) => (c.group === 'Corners' ? `${c.name} corners` : `${c.name} perm`),
    describe: (c) => (c.group === 'Corners'
      ? (c.name === 'Adjacent' ? 'two neighbouring corners swap' : 'the two diagonals swap')
      : c.name === 'H' ? 'both edge pairs swap across the middle'
      : c.name === 'Z' ? 'both edge pairs swap side to side'
      : 'three edges cycle, corners already done'),
  },
};
