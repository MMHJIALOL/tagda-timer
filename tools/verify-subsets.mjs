/* Every 3x3 scramble subset, played on a cube model and checked for what it
   promises to leave solved.
       node tools/verify-subsets.mjs [scrambles-per-random-mode]

   Case sets are walked case by case (every case once, through the generator
   itself), and each is also played forward with its own algorithm to confirm
   the scramble really is that case. Random modes are sampled, and also
   measured for the things a bad generator gives away: slots that come
   already solved, pairs that come already built, scrambles of the wrong
   length or with turns that do not belong. */
import { generate, setFor, loadSetFor } from '../js/scramble.js';
import { MODES, modesForEvent } from '../js/events.js';
import { preferredAlg } from '../js/alglibrary.js';
import { SOLVED, applyAlg, analyse, rouxStatus, mulInto, MOVES, parse, facelets } from '../js/cube3.js';
import { connectedPairs } from '../js/solver.js';
import { lsePosition, lseOriented, lseSize } from '../js/subsets.js';

const N = +process.argv[2] || 300;
const play = (alg, from = SOLVED) => applyAlg(from, alg).state;
const turnU = (s, a) => { if (!a) return s; const o = new Uint8Array(40); mulInto(o, s, MOVES[a - 1]); return o; };
const anyAUF = (s, ok) => [0, 1, 2, 3].some(a => ok(turnU(s, a)));

const cfop = (s) => analyse(s, 'D');
const slotsDone = (s) => cfop(s).slots.filter(x => x.done).length;
const crossOK = (s) => cfop(s).cross;
const f2lOK = (s) => cfop(s).f2l;
/* An M turn moves the centres, which this model never does: it turns L and R
   instead. Undo that first (the turn of L that puts the first block home, and
   the same-way turn of R), and only then ask about AUF. */
const turn = (s, m) => { const o = new Uint8Array(40); mulInto(o, s, MOVES[m]); return o; };
const rouxNorm = (s) => {
  for (let k = 0; k < 4; k++) {
    let t = s;
    for (let i = 0; i < k; i++) t = turn(turn(t, 12), 5);      // L, R'
    if (rouxStatus(t, 'L', 'D').k === 0) return t;
  }
  return s;
};
const rouxRank = (s) => Math.max(...[0, 1, 2, 3].map(a => rouxStatus(turnU(rouxNorm(s), a), 'L', 'D').rank));
const f2bOK = (s) => rouxRank(s) >= 3;
const cmllOK = (s) => rouxRank(s) >= 4;
const solvedOK = (s) => anyAUF(s, t => cfop(t).solved);
const llOriented = (s) => cfop(s).oll;
/* Last-layer corners showing their U colour on top. */
const cornersOriented = (s) => f2lOK(s) && [0, 1, 2, 3].every(i => s[8 + i] === 0);
const edgesOriented = (s) => f2lOK(s) && cfop(s).eo;
/* Pieces <R,U> never touches: the 2x2x3 block on the left. */
const leftBlockOK = (s) => [5, 6].every(i => s[i] === i && s[8 + i] === 0)
  && [5, 6, 7, 9, 10].every(i => s[16 + i] === i && s[28 + i] === 0)
  && [...Array(12).keys()].every(i => s[28 + i] === 0);

/* What each mode promises before you start, and what its algorithm finishes. */
const BEFORE = {
  f2l: (s) => crossOK(s) && slotsDone(s) >= 3, wv: (s) => crossOK(s) && slotsDone(s) >= 3,
  sv: (s) => crossOK(s) && slotsDone(s) >= 3, vhls: (s) => crossOK(s) && slotsDone(s) >= 3,
  zbls: (s) => crossOK(s) && slotsDone(s) >= 3,
  pll: f2lOK, oll: f2lOK, zbll: f2lOK, oll2look: f2lOK, pll2look: f2lOK, ocll: f2lOK,
  coll: f2lOK, ollcp: f2lOK, ll: f2lOK,
  cmll2look: f2bOK, cmll: f2bOK, ohcmll: f2bOK,
  lseeo: cmllOK, lseeolr: cmllOK,
  cross: crossOK,
  lastslot: (s) => crossOK(s) && slotsDone(s) === 3,
  '2gen': leftBlockOK,
  lse: cmllOK,
  roux: f2bOK,
};
const AFTER = {
  f2l: f2lOK, wv: llOriented, sv: cornersOriented, vhls: edgesOriented, zbls: edgesOriented,
  pll: solvedOK, zbll: solvedOK, oll: llOriented, ocll: llOriented, coll: llOriented, ollcp: llOriented,
  oll2look: (s) => edgesOriented(s), pll2look: (s) => llOriented(s),
  cmll: cmllOK, ohcmll: cmllOK, cmll2look: f2bOK,
  lseeo: (s) => rouxRank(s) >= 5,
  lseeolr: (s) => rouxRank(s) >= 5,
};
/* Turns a mode may use, when it promises only some. */
const ONLY = { '2gen': /^[RU][2']?$/, lse: /^[MU][2']?$/ };

const ROUX_PRE = ['', 'U', 'U2', "U'"].flatMap(u => ['', 'M', 'M2', "M'"].map(m => `${u} ${m}`.trim()));
const LIBRARY_ADJUST = (modeId) => /cmll|lse/.test(modeId) ? ROUX_PRE : ['', 'U', 'U2', "U'"];

let fails = 0;
const skipped = [];
const fail = (msg) => { fails++; if (fails <= 60) console.log('   FAIL', msg); };
const tokens = (alg) => alg.split(/\s+/).filter(Boolean);

for (const modeId of modesForEvent('333')) {
  const mode = MODES[modeId];
  if (!BEFORE[modeId]) continue;
  const before = BEFORE[modeId], after = AFTER[modeId];

  if (mode.kind === 'case') {
    const cases = await loadSetFor(modeId);
    let bad = 0;
    for (const c of cases) {
      const r = await generate('333', modeId, { allowedCases: [c.id] });
      const s = play(r.scramble);
      if (!before(s)) { bad++; fail(`${modeId} ${c.id}: scramble breaks what it should leave solved — ${r.scramble}`); continue; }
      const alg = preferredAlg(c.id) || c.alg;
      /* LSE edge orientation is asked of the M,U model in js/subsets.js:
         cube3 has no centres, and with the M slice a quarter off "oriented"
         means the other pair of colours. EOLR is held to its EO half. */
      if (/^lse/.test(modeId)) {
        if (lsePosition(alg) === null) { skipped.push(`${modeId} ${c.id}`); continue; }
        const ok = ROUX_PRE.some(p => { const x = lsePosition(`${r.scramble} ${p} ${alg}`); return x !== null && lseOriented(x); });
        if (!ok) { bad++; fail(`${modeId} ${c.id}: "${alg}" does not orient ${r.scramble}`); }
        continue;
      }
      /* Whatever the set calls an adjustment (AUF, and M for Roux) may go first. */
      if (after && !LIBRARY_ADJUST(modeId).some(p => after(applyAlg(s, `${p} ${alg}`).state))) {
        bad++; fail(`${modeId} ${c.id}: "${alg}" does not finish ${r.scramble}`);
      }
    }
    console.log(`${bad ? 'FAIL' : 'PASS'} ${modeId.padEnd(9)} ${cases.length} cases`);
    continue;
  }

  let bad = 0, len = 0, solvedSlots = 0, pairs = 0, longest = 0, trivial = 0;
  const seen = new Set();
  for (let i = 0; i < N; i++) {
    const r = await generate('333', modeId);
    const toks = tokens(r.scramble);
    len += toks.length; longest = Math.max(longest, toks.length);
    seen.add(r.scramble);
    if (!parse(r.scramble)) { bad++; fail(`${modeId}: unreadable scramble ${r.scramble}`); continue; }
    if (ONLY[modeId] && !toks.every(t => ONLY[modeId].test(t))) { bad++; fail(`${modeId}: turn outside its set in ${r.scramble}`); }
    const s = play(r.scramble);
    if (!before(s)) { bad++; fail(`${modeId}: ${r.scramble}`); }
    if (cfop(s).solved) trivial++;
    if (modeId === 'cross' || modeId === 'lastslot') {
      solvedSlots += slotsDone(s);
      pairs += connectedPairs(s, 'D').length;
    }
  }
  const extra = (modeId === 'cross' || modeId === 'lastslot')
    ? ` · ${(solvedSlots / N).toFixed(2)} slots solved, ${(pairs / N).toFixed(2)} pairs built per scramble` : '';
  console.log(`${bad ? 'FAIL' : 'PASS'} ${modeId.padEnd(9)} ${N} scrambles · ${(len / N).toFixed(1)} moves avg, ${longest} max · ${seen.size} distinct${trivial ? ` · ${trivial} already solved` : ''}${extra}${bad ? ` · ${bad} bad` : ''}`);
}

/* 2x2: the corners of a 3x3, with no centres to hold it by — so "solved" is
   every face showing one colour on its corners, whichever way up. */
const CORNER_STICKERS = [0, 2, 6, 8];
const faceDone = (fl, f) => CORNER_STICKERS.every(i => fl[f * 9 + i] === fl[f * 9]);
const allDone = (s) => { const fl = facelets(s); return [0, 1, 2, 3, 4, 5].every(f => faceDone(fl, f)); };
/* The bottom layer built: D one colour, and each side's two bottom corners alike. */
const bottomBuilt = (s) => {
  const fl = facelets(s);
  return faceDone(fl, 3) && [1, 2, 4, 5].every(f => fl[f * 9 + 6] === fl[f * 9 + 8]);
};
/* Ortega's OLL needs only the bottom face; its algorithms may permute that layer. */
const BEFORE_222 = {
  '222oll': (s) => faceDone(facelets(s), 3), '222cll': bottomBuilt,
  '222eg1': (s) => faceDone(facelets(s), 3), '222eg2': (s) => faceDone(facelets(s), 3),
  '222pbl': (s) => { const fl = facelets(s); return faceDone(fl, 0) && faceDone(fl, 3); },
};
const AFTER_222 = { '222oll': (s) => { const fl = facelets(s); return faceDone(fl, 0) && faceDone(fl, 3); } };
for (const modeId of modesForEvent('222').filter(m => BEFORE_222[m])) {
  const cases = await loadSetFor(modeId);
  let bad = 0;
  for (const c of cases) {
    const r = await generate('222', modeId, { allowedCases: [c.id] });
    const s = play(r.scramble);
    if (!BEFORE_222[modeId](s)) { bad++; fail(`${modeId} ${c.id}: scramble breaks what it should leave solved — ${r.scramble}`); continue; }
    const alg = preferredAlg(c.id) || c.alg;
    const after = AFTER_222[modeId] || allDone;
    const ok = ['', 'U', 'U2', "U'"].some(p => ['', 'D', 'D2', "D'"].some(q => after(applyAlg(s, `${p} ${alg} ${q}`).state)));
    if (!ok) { bad++; fail(`${modeId} ${c.id}: "${alg}" does not finish ${r.scramble}`); }
  }
  console.log(`${bad ? 'FAIL' : 'PASS'} ${modeId.padEnd(9)} ${cases.length} cases`);
}

const lse = lseSize();
if (lse !== 184320) fail(`the M,U group has 184320 positions, the LSE table ${lse}`);
if (skipped.length) console.log(`\nnot checked (turns outside M and U): ${skipped.join(', ')}`);
console.log(fails ? `\n${fails} failures` : '\nAll subsets keep their promises.');
process.exit(fails ? 1 : 0);
