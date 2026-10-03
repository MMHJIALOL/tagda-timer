/* Run every shipped algorithm against its own case, in Node.
       node tools/verify-alglibrary.mjs
   Same check as tools/verify-alglibrary.html, without a browser. */
import assert from 'node:assert/strict';
import { SETS, loadAllSets, auditLibrary, verifyAlgForCase, displayOrder, alignAlg, algKey } from '../js/alglibrary.js';
import { auditSetups } from '../js/alglibrary-setup.js';
import { faceTurns, sameAlgKey } from './same-alg.mjs';

await loadAllSets();

/* alignAlg: a slot variant gets its rotation, an extra one folds away, d is y' U. */
assert.equal(alignAlg('F2L', 'F2L1', "U L U' L'"), "y2 U L U' L'");
assert.equal(alignAlg('F2L', 'F2L1', "y' U R U' R'"), "U R U' R'");
assert.equal(alignAlg('F2L', 'F2L1', "d R U' R'"), "U R U' R'");
assert.equal(alignAlg('OLL', 'OLL27', "U2 R U R' U R U2 R'"), "R U R' U R U2 R'");
/* algKey: R' R' is R2, and a closing U is free. */
assert.equal(algKey('OLL', "R U2 R' R' F R F' U2 R' F R F'"), algKey('OLL', "R U2 R2 F R F' U2 R' F R F' U"));

/* The same algorithm held differently is the same algorithm (tools/same-alg.mjs). */
assert.equal(faceTurns("y L' U' L"), "F' U' F");
assert.equal(sameAlgKey("d' F R U R' F'"), sameAlgKey("U' R B U B' R'"));
assert.equal(sameAlgKey("R U' R' U y' R' U R y"), sameAlgKey("R U' R' U F' U F"));
assert.notEqual(sameAlgKey("r U R' U' r' F R F'"), sameAlgKey("R U R' U' R' F R F'"));

/* The last-slot sets were imported with that rule (LASTSLOT.md §5): every case
   there, and only one spelling of each algorithm in it. */
const LAST_SLOT = { ZBLS: 302, VHLS: 32, SV: 27 };
for (const [id, n] of Object.entries(LAST_SLOT)) assert.equal(SETS[id].cases.length, n, `${id} has ${n} cases`);
const respelt = [];
for (const id of Object.keys(LAST_SLOT)) {
  for (const c of SETS[id].cases) {
    const seen = new Map();
    for (const a of displayOrder(id, c.id)) {
      const k = sameAlgKey(a.alg);
      if (seen.has(k)) respelt.push(`${c.name}: ${seen.get(k)} / ${a.alg}`);
      seen.set(k, a.alg);
    }
  }
}

let total = 0, cases = 0;
for (const set of Object.values(SETS)) {
  cases += set.cases.length;
  for (const c of set.cases) total += displayOrder(set.id, c.id).length;
}

const bad = auditLibrary();
console.log(`${Object.keys(SETS).length} sets · ${cases} cases · ${total} listed algorithms`);
console.log(bad.length ? `FAIL ${bad.length} listed algorithms are wrong or repeated` : 'PASS every listed algorithm solves its case as drawn, none listed twice');
for (const b of bad.slice(0, 40)) console.log('  ', b.set, b.caseId, b.alg, '—', b.why);

console.log(respelt.length
  ? `FAIL ${respelt.length} last-slot algorithms are another listed algorithm held differently`
  : 'PASS no ZBLS, VHLS or SV case lists the same algorithm twice, rotations and wide turns included');
for (const r of respelt.slice(0, 20)) console.log('  ', r);

/* The canonical algorithm of every case, too: `auditLibrary` only walks the
   alternates, and a set whose cases carry their own alg (ZBLL, F2L, 2x2) would
   otherwise never have that one checked. */
const badCanon = [];
for (const set of Object.values(SETS)) {
  for (const c of set.cases) {
    if (!verifyAlgForCase(set.id, c.id, c.alg)) badCanon.push(`${set.id} ${c.id} ${c.alg}`);
  }
}
console.log(badCanon.length ? `FAIL ${badCanon.length} canonical algorithms` : 'PASS every canonical algorithm solves its own case');
for (const b of badCanon.slice(0, 20)) console.log('  ', b);

/* Duplicate case ids across sets would break preferredAlg(), which looks a case
   up by id alone. */
const seen = new Map();
for (const set of Object.values(SETS)) {
  for (const c of set.cases) {
    if (seen.has(c.id) && seen.get(c.id) !== set.id) console.log(`  DUPLICATE id ${c.id} in ${seen.get(c.id)} and ${set.id}`);
    seen.set(c.id, set.id);
  }
}

const badSetup = auditSetups(Object.values(SETS));
const setupCases = Object.values(SETS).filter(s => (s.n || 3) === 3 && (s.puzzle || 'cube') === 'cube').reduce((n, s) => n + s.cases.length, 0);
console.log(badSetup.length
  ? `FAIL ${badSetup.length} setups`
  : `PASS all ${setupCases} 3x3 setups build their case and are solved by their algorithm`);
for (const b of badSetup.slice(0, 20)) console.log('  ', b.set, b.caseId, b.why);

process.exit(bad.length || badCanon.length || badSetup.length || respelt.length ? 1 : 0);
