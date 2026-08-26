/* ===========================================================
   Tagda Timer — WCA event catalogue + scramble mode catalogue
   =========================================================== */

/** All 17 official WCA events. `puzzle` is the cubing.js puzzle id. */
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
};

export const EVENT_ORDER = [
  '333', '222', '444', '555', '666', '777',
  '333bf', '333fm', '333oh', 'clock', 'minx',
  'pyram', 'skewb', 'sq1', '444bf', '555bf', '333mbf',
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

  'll':       { name: 'Last layer',     kind: 'compose', events: ['333','333oh'], view: 'LL', desc: 'Random OLL + PLL together' },
  'cross':    { name: 'Cross solved',   kind: 'trigger', depth: [5, 7], events: ['333','333oh'], desc: 'Cross is done — practise F2L + LL' },
  'lastslot': { name: 'Last slot + LL', kind: 'trigger', depth: [3, 4],  events: ['333','333oh'], view: 'LL3', desc: 'Three pairs in, one to go' },
  '2gen':     { name: '2-gen (R,U)',    kind: 'subgroup', pool: '2gen', depth: [12, 15], events: ['333','333oh'], desc: 'Only R and U turns' },
  'lse':      { name: 'Roux LSE (M,U)', kind: 'subgroup', pool: 'lse',  depth: [10, 14], events: ['333','333oh'], desc: 'Last six edges' },
  'roux':     { name: 'Roux L10P',      kind: 'subgroup', pool: 'roux', depth: [12, 16], events: ['333'], desc: 'R, U and M moves only' },

  'crossgoal':{ name: 'Cross practice', kind: 'wca-goal', events: ['333','333oh'], desc: 'Full WCA scramble — time your cross only' },
};

export const MODE_ORDER = [
  'wca', 'pll', 'oll', 'oll2look', 'pll2look', 'ocll',
  'll', 'cross', 'lastslot', '2gen', 'lse', 'roux', 'crossgoal',
];

export function modesForEvent(eventId) {
  return MODE_ORDER.filter(id => {
    const m = MODES[id];
    return m.events === '*' || m.events.includes(eventId);
  });
}

export const eventOf  = id => EVENTS[id] || EVENTS['333'];
export const modeOf   = id => MODES[id]  || MODES['wca'];
