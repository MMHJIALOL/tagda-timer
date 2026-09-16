/* ===========================================================
   Tagda Timer — WCA event catalogue + scramble mode catalogue
   =========================================================== */

/** All 17 official WCA events, plus FTO. `puzzle` is the cubing.js puzzle id. */
export const EVENTS = {
  '333':    { name: '3x3x3',              short: '3x3',    puzzle: '3x3x3' },
  '222':    { name: '2x2x2',              short: '2x2',    puzzle: '2x2x2' },
  '444':    { name: '4x4x4',              short: '4x4',    puzzle: '4x4x4' },
  '555':    { name: '5x5x5',              short: '5x5',    puzzle: '5x5x5' },
  '666':    { name: '6x6x6',              short: '6x6',    puzzle: '6x6x6',   wrap: true },
  '777':    { name: '7x7x7',              short: '7x7',    puzzle: '7x7x7',   wrap: true },
  '333bf':  { name: '3x3 Blindfolded',    short: '3BLD',   puzzle: '3x3x3',   noInspection: true, hideDuringSolve: true },
  '333fm':  { name: '3x3 Fewest Moves',   short: 'FMC',    puzzle: '3x3x3',   noInspection: true, fmc: true },
  '333oh':  { name: '3x3 One-Handed',     short: 'OH',     puzzle: '3x3x3' },
  'clock':  { name: 'Clock',              short: 'Clock',  puzzle: 'clock',   wrap: true },
  'minx':   { name: 'Megaminx',           short: 'Minx',   puzzle: 'megaminx', wrap: true, multiline: true },
  'pyram':  { name: 'Pyraminx',           short: 'Pyra',   puzzle: 'pyraminx' },
  'skewb':  { name: 'Skewb',              short: 'Skewb',  puzzle: 'skewb' },
  'sq1':    { name: 'Square-1',           short: 'Sq-1',   puzzle: 'square1', wrap: true },
  '444bf':  { name: '4x4 Blindfolded',    short: '4BLD',   puzzle: '4x4x4',   noInspection: true, hideDuringSolve: true, wrap: true },
  '555bf':  { name: '5x5 Blindfolded',    short: '5BLD',   puzzle: '5x5x5',   noInspection: true, hideDuringSolve: true, wrap: true },
  '333mbf': { name: '3x3 Multi-Blind',    short: 'MBLD',   puzzle: '3x3x3',   noInspection: true, hideDuringSolve: true, multi: true, wrap: true },
  // Unofficial, but cubing.js ships a random-state FTO scrambler and puzzle.
  'fto':    { name: 'FTO',                short: 'FTO',    puzzle: 'fto',     wrap: true },
  /* A relay is several puzzles inside one attempt, so it has no single puzzle
     of its own. `puzzle` is still here and still 3x3x3: every caller of
     eventOf(id).puzzle has to get something loadable back, and the relay code
     points the preview at the active leg's own puzzle before anything is
     drawn. The list itself lives on the session (`session.relay`), not here —
     two relay sessions are two different lists of the same event. */
  'custom': { name: 'Relay',              short: 'Relay',  puzzle: '3x3x3',   relay: true, noInspection: false },
};

export const EVENT_ORDER = [
  '333', '222', '444', '555', '666', '777',
  '333bf', '333fm', '333oh', 'clock', 'minx',
  'pyram', 'skewb', 'sq1', '444bf', '555bf', '333mbf', 'fto',
  'custom',
];

/**
 * Scramble modes. `kind`:
 *   wca      — official random-state scramble for the event
 *   case     — random case from an algorithm set (per-case stats)
 *   subgroup — random moves from a restricted move pool
 *   trigger  — random composition of cross-preserving triggers
 *   wca-goal — official scramble, but you only time part of the solve
 */
export const MODES = {
  'wca':      { name: 'Random state',   kind: 'wca',      events: '*',    desc: 'Official WCA random-state scramble' },

  'pll':      { name: 'PLL',            kind: 'case',  set: 'PLL',    events: ['333','333oh'], view: 'LL', desc: 'All 21 permutation cases' },
  'oll':      { name: 'OLL',            kind: 'case',  set: 'OLL',    events: ['333','333oh'], view: 'LL', desc: 'All 57 orientation cases' },
  'oll2look': { name: '2-look OLL',     kind: 'case',  set: 'OLL2',   events: ['333','333oh'], view: 'LL', desc: 'Edge orientation + OCLL' },
  'pll2look': { name: '2-look PLL',     kind: 'case',  set: 'PLL2',   events: ['333','333oh'], view: 'LL', desc: 'Corner swap + edge cycle' },
  'ocll':     { name: 'OCLL',           kind: 'case',  set: 'OCLL',   events: ['333','333oh'], view: 'LL', desc: 'The 7 corner-orientation cases' },
  'zbll':     { name: 'ZBLL',           kind: 'case',  set: 'ZBLL',   events: ['333','333oh'], view: 'LL', desc: 'All 472 one-look last layers' },
  // No `view` for F2L: the pair lives in the bottom two layers, so a
  // last-layer picture would show nothing. Whichever preview you have
  // chosen is the right one here.
  'f2l':      { name: 'F2L',            kind: 'case',  set: 'F2L',    events: ['333','333oh'], desc: 'All 41 first-two-layers cases' },

  /* 2x2. The scramble is built exactly the way a 3x3 case scramble is —
     AUF + the inverse of the algorithm + AUF — so per-case statistics work
     here for the same reason they work there. No `view`: a last-layer
     stickering on a 2x2 would hide the bottom layer, and for EG and PBL the
     bottom layer is half the case. */
  '222oll':   { name: '2x2 OLL',        kind: 'case',  set: 'OLL222', events: ['222'], desc: 'Orient the top — first step of Ortega' },
  '222pbl':   { name: '2x2 PBL',        kind: 'case',  set: 'PBL222', events: ['222'], desc: 'Permute both layers — last step of Ortega' },
  '222cll':   { name: '2x2 CLL',        kind: 'case',  set: 'CLL222', events: ['222'], desc: 'Bottom done, top in one algorithm' },
  '222eg1':   { name: '2x2 EG-1',       kind: 'case',  set: 'EG1222', events: ['222'], desc: 'Bottom with one adjacent swap' },
  '222eg2':   { name: '2x2 EG-2',       kind: 'case',  set: 'EG2222', events: ['222'], desc: 'Bottom with a diagonal swap' },

  /* Sets that live in the algorithm library. `set` is the library's own set
     id, and the case list is fetched the first time the mode is used — see
     loadSetFor in scramble.js — so none of them costs the timer anything until
     someone picks one. */
  'wv':        { name: 'Winter Variation', kind: 'case', set: 'WV',        events: ['333','333oh'], desc: 'Insert the last pair and orient the last layer' },
  'coll':      { name: 'COLL',             kind: 'case', set: 'COLL',      events: ['333','333oh'], view: 'LL', desc: 'Last-layer corners with the edges oriented' },
  'ollcp':     { name: 'OLLCP',            kind: 'case', set: 'OLLCP',     events: ['333','333oh'], view: 'LL', desc: 'Orient the last layer and permute its corners' },
  'cmll2look': { name: '2-look CMLL',      kind: 'case', set: 'CMLL2L',    events: ['333','333oh'], desc: 'Roux corners: orient, then permute' },
  'cmll':      { name: 'CMLL',             kind: 'case', set: 'CMLL',      events: ['333','333oh'], desc: 'Roux last-layer corners in one look' },
  'lseeo':     { name: 'LSE EO',           kind: 'case', set: 'LSEEO',     events: ['333','333oh'], desc: 'Orient the last six edges' },
  'lseeolr':   { name: 'EOLR',             kind: 'case', set: 'LSEEOLR',   events: ['333','333oh'], desc: 'Orient the edges and bring UL and UR down' },
  'ohcmll':    { name: 'OH CMLL',          kind: 'case', set: 'OHCMLL',    events: ['333oh','333'], desc: 'CMLL picked for one hand' },
  '444pllp':   { name: 'PLL parity',       kind: 'case', set: '444-PLLP',  events: ['444'], desc: 'Last layers that come with PLL parity' },
  'pyrall':    { name: 'Last layer',       kind: 'case', set: 'PYRA-LL',   events: ['pyram'], desc: 'The last three edges of layer-by-layer' },
  'pyral4e':   { name: 'L4E',              kind: 'case', set: 'PYRA-L4E',  events: ['pyram'], desc: 'The last four edges, after a V' },
  'sarahint':  { name: "Sarah's Intermediate", kind: 'case', set: 'SKEWB-SI', events: ['skewb'], desc: 'The opposite face with sledges and hedges' },
  'sarahadv':  { name: "Sarah's Advanced", kind: 'case', set: 'SKEWB-SA',  events: ['skewb'], desc: 'Everything after the first face' },
  'sq1shape':  { name: 'Cube shape',       kind: 'case', set: 'SQ1-SHAPE', events: ['sq1'], desc: 'Back to a cube from any shape' },
  'sq1csp':    { name: 'CSP',              kind: 'case', set: 'SQ1-CSP',   events: ['sq1'], desc: 'Cube shape with parity fixed' },
  'sq1obl':    { name: 'OBL',              kind: 'case', set: 'SQ1-OBL',   events: ['sq1'], desc: 'Every piece onto its own layer' },
  'sq1eo':     { name: 'EO',               kind: 'case', set: 'SQ1-EO',    events: ['sq1'], desc: 'Edges onto their layers' },
  'sq1cp':     { name: 'CP',               kind: 'case', set: 'SQ1-CP',    events: ['sq1'], desc: 'Permute the corners' },
  'sq1ep':     { name: 'EP',               kind: 'case', set: 'SQ1-EP',    events: ['sq1'], desc: 'Permute the edges' },

  'll':       { name: 'Last layer',     kind: 'compose', events: ['333','333oh'], view: 'LL', desc: 'Random OLL + PLL together' },
  'cross':    { name: 'Cross solved',   kind: 'trigger', depth: [5, 7], events: ['333','333oh'], desc: 'Cross is done — practise F2L + LL' },
  'lastslot': { name: 'Last slot + LL', kind: 'trigger', depth: [3, 4],  events: ['333','333oh'], view: 'LL3', desc: 'Three pairs in, one to go' },
  '2gen':     { name: '2-gen (R,U)',    kind: 'subgroup', pool: '2gen', depth: [12, 15], events: ['333','333oh'], desc: 'Only R and U turns' },
  'lse':      { name: 'Roux LSE (M,U)', kind: 'subgroup', pool: 'lse',  depth: [10, 14], events: ['333','333oh'], desc: 'Last six edges' },
  'roux':     { name: 'Roux L10P',      kind: 'subgroup', pool: 'roux', depth: [12, 16], events: ['333'], desc: 'R, U and M moves only' },

  'crossgoal':{ name: 'Cross practice', kind: 'wca-goal', events: ['333','333oh'], desc: 'Full WCA scramble — time your cross only' },
};

export const MODE_ORDER = [
  'wca', 'f2l', 'pll', 'oll', 'zbll', 'oll2look', 'pll2look', 'ocll',
  'wv', 'coll', 'ollcp', 'cmll2look', 'cmll', 'ohcmll', 'lseeo', 'lseeolr',
  '222oll', '222pbl', '222cll', '222eg1', '222eg2',
  '444pllp', 'pyrall', 'pyral4e', 'sarahint', 'sarahadv',
  'sq1shape', 'sq1csp', 'sq1obl', 'sq1eo', 'sq1cp', 'sq1ep',
  'll', 'cross', 'lastslot', '2gen', 'lse', 'roux', 'crossgoal',
];

export function modesForEvent(eventId) {
  return MODE_ORDER.filter(id => {
    const m = MODES[id];
    return m.events === '*' || m.events.includes(eventId);
  });
}

/** Cube size when the virtual cube can do this event (2x2 to 7x7), else 0. */
export const virtualSize = id => (/^([2-7])\1\1$/.test(id) ? +id[0] : 0);

/**
 * Events a relay leg may be built from.
 *
 * A leg has to be one ordinary scramble solved once: blindfolded events, FMC
 * and multi-blind all mean something else by "one attempt", and folding any of
 * them into a relay would make the total meaningless. The relay event itself is
 * excluded for the obvious reason.
 */
export const relayLegEvents = () =>
  EVENT_ORDER.filter(id => {
    const ev = EVENTS[id];
    return !ev.relay && !ev.fmc && !ev.multi && !ev.noInspection;
  });

/** How many puzzles one relay may hold. */
export const RELAY_MAX = 10;

/** `2x2 · 3x3 · 4x4` — a relay list written out for a label. */
export const relayLabel = (list = []) => list.map(id => eventOf(id).short).join(' · ');

export const eventOf  = id => EVENTS[id] || EVENTS['333'];
export const modeOf   = id => MODES[id]  || MODES['wca'];
