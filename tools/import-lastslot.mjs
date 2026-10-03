/* ===========================================================
   Import ZBLS, VHLS and Summer Variation into js/algsets/.

       node tools/import-lastslot.mjs <folder>

   <folder> holds the three source files, fetched exactly as LASTSLOT.md §2
   says:

     alg_list.js   Tao Yu's Alg-Trainer, js/alg_list.js — `ZBLS` and `VHLS`
     zbls.ts       @moishy/algsets, packages/algsets/src/zbls/index.ts
     SV.html       the Summer Variation page of speedcubedb.com

   Nothing is filed on trust (LASTSLOT.md §4 has the long version):

     1. Every algorithm is run on js/cubenet.js and filed under the case it
        actually solves, found by the state it leaves behind — not under the
        cell it was written in. A cell's case is what most of its algorithms
        agree on, so a single stray cannot redefine it.

     2. Every case is checked against what the set promises is already
        solved: the cross and three pairs intact, only the front-right slot
        and the top layer disturbed.

     3. Every algorithm then has to pass the page's own verifyAlgForCase, and
        alignAlg gives it the U turn or y it needs in front to work from the
        angle the case is drawn at.

     4. Repeats are dropped. Two algorithms are the same algorithm when they
        turn the same layers in the same order once cube rotations are taken
        out — `y L' U' L` is `F' U' F`, and a wide turn is a face turn plus a
        rotation — with an opening or closing U turn ignored, because the
        trainer adds that one for you (tools/same-alg.mjs). The shorter
        spelling survives, in the place the first one was listed.

   Writes js/algsets/ZBLS.js, VHLS.js and SV.js only once all three sets have
   been built, then prints what was refiled, merged and dropped.
   =========================================================== */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { faceletsFor, parseAlg, stickerAt } from '../js/cubenet.js';
import { tidy, invert } from '../js/util.js';
import { registerSet, verifyAlgForCase, alignAlg, algKey, countFor } from '../js/alglibrary.js';
import { F2L_CASES } from '../js/alglibrary-f2l.js';
import { sameAlgKey, rotations } from './same-alg.mjs';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node tools/import-lastslot.mjs <folder with alg_list.js, zbls.ts, SV.html>'); process.exit(2); }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'js', 'algsets');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const note = (line) => console.log(line);

/* ---------------------------------------------------------
   1. Sources
   --------------------------------------------------------- */

/** One algorithm in cubenet's grammar, or null. Brackets go, `R2'` is `R2`. */
function norm(raw) {
  const toks = String(raw).replace(/[()[\]]/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map(t => t.replace(/2'$/, '2'));
  const s = tidy(toks.join(' '));
  return s && parseAlg(s) ? s : null;
}

/* Tao Yu's alg_list.js is a browser script of `var` declarations. */
const tao = (() => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('alg_list.js').replace(/^var /gm, 'globalThis.'), ctx);
  if (!ctx.ZBLS || !ctx.VHLS) throw new Error('alg_list.js: no ZBLS or VHLS table');
  return { ZBLS: ctx.ZBLS, VHLS: ctx.VHLS };
})();

/** `{ "12": [cell1, …, cell8] }` → [{ n, k, raw: [alg, …] }]; alternatives split on `/`. */
const taoCells = (table) => Object.entries(table).flatMap(([n, cells]) => cells.map((cell, i) => ({
  n: +n, k: i + 1, raw: String(cell).split('/').map(s => s.trim()).filter(Boolean),
}))).filter(c => c.raw.length);

/* @moishy/algsets: `{ id: "f2l-12-3", subset: "F2L 12", algs: ["…", …] }`. */
const moishy = [...read('zbls.ts').matchAll(/id: "f2l-(\d+)-(\d+)",\s*subset: "[^"]*",\s*algs: \[([^\]]*)\]/g)]
  .map(m => ({ cell: `${m[1]}-${m[2]}`, raw: [...m[3].matchAll(/"([^"]+)"/g)].map(x => x[1]) }));
if (moishy.length < 300) throw new Error(`zbls.ts: read ${moishy.length} cases, expected 302 — has its layout changed?`);

/* speedcubedb: one `div.singlealgorithm` per case, one `.formatted-alg` per algorithm. */
const unescape = (s) => s.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const svSource = read('SV.html').split('<div class="row singlealgorithm').slice(1).map(b => ({
  name: unescape(/data-alg="([^"]+)"/.exec(b)[1]),
  raw: [...b.matchAll(/<div class="formatted-alg">([\s\S]*?)<\/div>/g)].map(m => unescape(m[1]).replace(/\s+/g, ' ').trim()),
}));
if (svSource.length !== 27) throw new Error(`SV.html: read ${svSource.length} cases, expected 27`);

/* ---------------------------------------------------------
   2. What a case is
   --------------------------------------------------------- */

const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
const AUF = ['', 'U', 'U2', "U'"];

/* The twelve top-layer side stickers — what WV, SV and ZBLS all leave out of
   the picture — and, for ZBLS, the top faces of the four corners as well: an
   edge-orientation step does not care what the corners are doing. */
const SIDE_TOP = ['F00', 'F01', 'F02', 'B02', 'B01', 'B00', 'L00', 'L01', 'L02', 'R00', 'R01', 'R02'];
const GRAY_OLS = SIDE_TOP;
const GRAY_EOLS = [...SIDE_TOP, 'U00', 'U02', 'U20', 'U22'];

/**
 * A case as a string: the state `seq` leaves, recoloured so each colour names
 * the face its centre sits on (a rotation inside an algorithm changes which
 * way you hold the cube, not the case), grey stickers blanked, and the
 * smallest over the four U turns that could come before the algorithm.
 */
function caseKey(seq, grey) {
  const variants = AUF.map(u => {
    const f = faceletsFor([seq, u].filter(Boolean).join(' '), 3, grey);
    const centre = {};
    for (const face of FACES) centre[f[face][1][1]] = face;
    return FACES.map(face => f[face].flat().map(c => (c === 'X' ? '.' : centre[c])).join('')).join('');
  });
  return variants.sort()[0];
}

/* Everything below the top layer is home, except the front-right slot: the
   premise of every last-slot set. "Home" is read against the centres, and
   "front-right" is where the slot physically is: an algorithm that opens with
   a y is held with another colour in front, and its case is still the slot
   in front of you on the right. */
function lastSlotPremise(seq) {
  const f = faceletsFor(seq, 3);
  const centre = {};
  for (const face of FACES) centre[f[face][1][1]] = face;
  for (const face of FACES) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const [x, y, z] = stickerAt(face, r, c, 3).cubie.split(',').map(Number);
        if (y < 1 && !(x === 1 && z === 1) && centre[f[face][r][c]] !== face) return false;
      }
    }
  }
  return true;
}

/* ---------------------------------------------------------
   3. Building a set
   --------------------------------------------------------- */

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pending = [];
const report = { refiled: [], unmatched: [], unparsable: [], failed: [], merged: new Set() };

/**
 * Turn `cells` — [{ name, group, raw: [alg, …] }], each meant to be one case —
 * into a verified set. Extra algorithms from elsewhere come in `extras` as
 * plain strings and are filed by what they solve, like everything else.
 */
async function build(spec, cells, extras = []) {
  const grey = new Set(spec.gray);

  /* A cell's case is what most of its algorithms agree it is. */
  const cases = [];
  const byKey = new Map();
  for (const cell of cells) {
    const algs = cell.raw.map(raw => ({ raw, alg: norm(raw) }));
    for (const a of algs.filter(a => !a.alg)) report.unparsable.push(`${spec.id} ${cell.name}: ${a.raw}`);
    const votes = new Map();
    for (const a of algs.filter(a => a.alg)) {
      const k = caseKey(invert(a.alg), grey);
      votes.set(k, [...(votes.get(k) || []), a.alg]);
    }
    const [key, agreed] = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [];
    if (!key) continue;
    if (byKey.has(key)) throw new Error(`${spec.id}: ${cell.name} and ${byKey.get(key).name} are the same case`);
    const group = spec.groupOf ? spec.groupOf(agreed[0]) : cell.group;
    const c = { id: `${spec.id}-${slug(cell.name)}`, name: cell.name, group, alg: agreed[0], queue: [] };
    if (!lastSlotPremise(invert(c.alg))) throw new Error(`${spec.id} ${cell.name}: disturbs more than the last slot — ${c.alg}`);
    byKey.set(key, c);
    cases.push({ c, algs: algs.filter(a => a.alg).map(a => a.alg) });
  }

  /* Every algorithm, the cell's own first, goes to the case it solves. */
  const file = (alg, from) => {
    const c = byKey.get(caseKey(invert(alg), grey));
    if (!c) { report.unmatched.push(`${spec.id} ${from}: ${alg}`); return; }
    if (from !== c.name && !from.startsWith('+')) report.refiled.push(`${spec.id}: ${alg}  —  listed under ${from}, solves ${c.name}`);
    c.queue.push(alg);
  };
  for (const { c, algs } of cases) for (const a of algs) file(a, c.name);
  for (const raw of extras) {
    const alg = norm(raw.alg);
    if (!alg) { report.unparsable.push(`${spec.id} ${raw.from}: ${raw.alg}`); continue; }
    file(alg, `+${raw.from}`);
  }

  const list = cases.map(x => x.c);
  const meta = {
    id: spec.id, event: '333', puzzle: 'cube', n: 3,
    label: spec.label, title: spec.title, picture: '3d', gray: spec.gray,
    adjust: { pre: AUF, post: AUF },
    scramble: { pre: spec.scramblePre || AUF, post: AUF },
    groups: spec.groups(list),
    defaultGroup: spec.defaultGroup ? spec.groups(list)[0] : null,
    trainerMode: spec.trainerMode,
  };
  await registerSet({ ...meta, cases: list.map(({ queue, ...c }) => c), library: {} });

  /* The page's own check, then the angle, then the repeats. */
  const library = {};
  let algCount = 0, repeats = 0, equivalents = 0;
  for (const c of list) {
    const kept = [];
    for (const alg of c.queue) {
      if (!verifyAlgForCase(spec.id, c.id, alg)) { report.failed.push(`${spec.id} ${c.name}: ${alg}`); continue; }
      const aligned = alignAlg(spec.id, c.id, alg);
      if (!aligned) { report.failed.push(`${spec.id} ${c.name}: no U turn or y makes it work as drawn — ${alg}`); continue; }
      const key = sameAlgKey(aligned);
      const i = kept.findIndex(k => k.key === key || algKey(spec.id, k.alg) === algKey(spec.id, aligned));
      if (i < 0) { kept.push({ alg: aligned, key }); continue; }
      const old = kept[i].alg;
      if (algKey(spec.id, old) === algKey(spec.id, aligned)) { repeats++; continue; }
      equivalents++;
      /* Fewer moves, then fewer rotations; on a tie the one listed first. */
      const better = countFor(spec.id, aligned) - countFor(spec.id, old) || rotations(aligned) - rotations(old);
      if (better < 0) kept[i] = { alg: aligned, key };
      report.merged.add(`${spec.id} ${c.name}: kept ${better < 0 ? aligned : old}  —  dropped ${better < 0 ? old : aligned}`);
    }
    if (!kept.length) throw new Error(`${spec.id} ${c.name}: no algorithm survived`);
    c.alg = kept[0].alg;
    library[c.id] = { alternates: kept.map(k => ({ alg: k.alg, moveCount: countFor(spec.id, k.alg) })) };
    algCount += kept.length;
  }

  const final = list.map(({ queue, ...c }) => c);
  await registerSet({ ...meta, cases: final, library });
  for (const c of final) {
    for (const a of library[c.id].alternates) {
      if (!verifyAlgForCase(spec.id, c.id, a.alg, null, true)) throw new Error(`${spec.id} ${c.name}: ${a.alg} does not solve the case as drawn`);
    }
  }
  note(`${spec.id.padEnd(5)} ${final.length} cases · ${algCount} algorithms · ${repeats} listed twice · ${equivalents} the same algorithm spelt another way`);

  pending.push([`${spec.id}.js`, [
    `/* GENERATED by tools/import-lastslot.mjs — do not hand-edit. See LASTSLOT.md.`,
    ...spec.header.map(l => (l ? `   ${l}` : '')),
    '   Every case below disturbs only the front-right slot and the top layer,',
    '   and every algorithm was executed against the case it is filed under. */',
    'export const SET = {',
    ...Object.entries(meta).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    '  "cases": [',
    ...final.map(c => `    ${JSON.stringify(c)},`),
    '  ],',
    '  "library": {',
    ...Object.entries(library).map(([id, v]) => `    ${JSON.stringify(id)}: ${JSON.stringify(v)},`),
    '  },',
    '};',
    '',
  ].join('\n')]);
  return { cases: final, library };
}

/* ---------------------------------------------------------
   4. The three sets
   --------------------------------------------------------- */

const MIT = (who) => [
  `Copyright (c) ${who}`,
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
];
const TAO = ['Algorithms from Alg-Trainer (github.com/tao-yu/Alg-Trainer), MIT License:', '', ...MIT('2017-2021 Tao Yu')];
const MOISHY = ['Further ZBLS alternatives from @moishy/algsets (github.com/moishy-r/moishy-cubing),', 'MIT License:', '', ...MIT('2026 Moshe Rosenberg')];

/* A random corner state under every ZBLS case, so the corners — greyed out in
   the picture — cannot become what you recognise it by. The seven OCLL
   algorithms keep the first two layers and the edge orientation, which is all
   a ZBLS case is made of; with a U turn either way round they leave the
   corners turned and swapped differently each time. */
const OCLL = [
  "R U R' U R U2 R'", "R U2 R' U' R U' R'", "R U R' U R U' R' U R U2 R'", "R U2 R2 U' R2 U' R2 U2 R",
  "R2 D R' U2 R D' R' U2 R'", "r U R' U' r' F R F'", "F' r U R' U' r' F R",
];
for (const a of OCLL) {
  const f = faceletsFor(invert(a), 3);
  const f2l = FACES.every(face => [0, 1, 2].every(r => [0, 1, 2].every(c =>
    Number(stickerAt(face, r, c, 3).cubie.split(',')[1]) === 1 || f[face][r][c] === face)));
  const eo = [[0, 1], [1, 0], [1, 2], [2, 1]].every(([r, c]) => f.U[r][c] === 'U');
  if (!f2l || !eo) throw new Error(`OCLL ${a} does not keep F2L and edge orientation`);
}
const SHUFFLE_CORNERS = AUF.flatMap(u => ['', ...OCLL.map(invert)].map(o => tidy([u, o].filter(Boolean).join(' '))));

const f2lGroups = (list) => [...new Set(list.map(c => c.group))];

const zblsCells = taoCells(tao.ZBLS).map(({ n, k, raw }) => ({ name: `ZBLS ${n}-${k}`, group: `F2L ${n}`, raw }));
const zbls = await build({
  id: 'ZBLS', label: 'ZBLS', trainerMode: 'zbls',
  title: 'Insert the last pair and orient the last-layer edges in one go',
  gray: GRAY_EOLS, groups: f2lGroups, defaultGroup: true, scramblePre: SHUFFLE_CORNERS,
  header: ['Zborowski-Bruchem last slot: 302 cases, grouped by the F2L case they extend', '(same numbering as the F2L set). Algorithms by Chad Batten and Tao Yu.', '', ...TAO, '', ...MOISHY],
}, zblsCells, moishy.flatMap(m => m.raw.map(alg => ({ alg, from: `moishy ${m.cell}` }))));

/* The groups say "F2L 12" because the pair is the timer's own F2L case 12:
   with the whole last layer greyed out, each ZBLS case has to be exactly the
   F2L case of its number. */
const GRAY_LL = [...GRAY_EOLS, 'U01', 'U10', 'U12', 'U21'];
for (const c of zbls.cases) {
  const n = c.group.replace('F2L ', '');
  const f2l = F2L_CASES.find(x => x.id === `F2L${n}`);
  if (caseKey(invert(c.alg), new Set(GRAY_LL)) !== caseKey(invert(f2l.alg), new Set(GRAY_LL))) {
    throw new Error(`${c.name}: its pair is not F2L ${n}`);
  }
}
note('ZBLS  every case is the F2L case its group names, with the edges to orient on top');

/* VHLS is ZBLS for F2L 1-4 — the pair already made or one move from it. Tao
   Yu's VHLS table (Chad Batten's picks) goes first, then every ZBLS
   alternative for the same case. */
const vhlsCells = taoCells(tao.VHLS).map(({ n, k, raw }) => {
  if (n > 4) throw new Error(`VHLS ${n}-${k}: VHLS only covers F2L 1-4`);
  const z = zbls.cases.find(c => c.name === `ZBLS ${n}-${k}`);
  return { name: `VHLS ${n}-${k}`, group: `F2L ${n}`, raw: [...raw, ...zbls.library[z.id].alternates.map(a => a.alg)] };
});
const vhls = await build({
  id: 'VHLS', label: 'VHLS', trainerMode: 'vhls',
  title: 'Orient the last-layer edges while inserting a pair that is already made',
  gray: GRAY_EOLS, groups: f2lGroups, defaultGroup: false, scramblePre: SHUFFLE_CORNERS,
  header: ['Vandenbergh-Harris last slot: the 32 ZBLS cases of F2L 1-4. Algorithms by Chad Batten.', '', ...TAO, '', ...MOISHY],
}, vhlsCells);
for (const c of vhls.cases) {
  const z = zbls.cases.find(x => x.name === c.name.replace('VHLS', 'ZBLS'));
  if (caseKey(invert(c.alg), new Set(GRAY_EOLS)) !== caseKey(invert(z.alg), new Set(GRAY_EOLS))) throw new Error(`${c.name} is not ${z.name}`);
}

/* Summer Variation: grouped like Winter Variation, by how many of the three
   last-layer corners already face up. */
const svGroup = (alg) => {
  const f = faceletsFor(invert(alg), 3);
  const centre = {};
  for (const face of FACES) centre[f[face][1][1]] = face;
  const up = [[0, 0], [0, 2], [2, 0], [2, 2]].filter(([r, c]) => centre[f.U[r][c]] === 'U').length;
  return `${up} Oriented`;
};
const svCells = svSource.map(c => ({ name: c.name, raw: c.raw }));
const ORIENTED = ['3 Oriented', '2 Oriented', '1 Oriented', '0 Oriented'];
await build({
  id: 'SV', label: 'SV', trainerMode: 'sv',
  title: 'Insert the last pair and orient the corners, edges already oriented',
  gray: GRAY_OLS, groupOf: svGroup, groups: (list) => ORIENTED.filter(g => list.some(c => c.group === g)), defaultGroup: false,
  header: ['Summer Variation: insert the last pair with R U\' R\' and orient the corners.', 'Cases and algorithms as listed on speedcubedb.com/a/3x3/SV (no licence stated there).'],
}, svCells);

/* ---------------------------------------------------------
   Report, then write
   --------------------------------------------------------- */

const section = (title, lines) => {
  note(`\n${title}: ${lines.length}`);
  for (const l of lines) note(`  ${l}`);
};
section('Filed under a different case than the one they were listed under', report.refiled);
section('The same algorithm spelt two ways', [...report.merged]);
section('Not notation', report.unparsable);
section('Solve no case in the set', report.unmatched);
section('Failed the page\'s own check', report.failed);

for (const [file, text] of pending) fs.writeFileSync(path.join(OUT, file), text);
note(`\nwrote ${pending.map(p => p[0]).join(', ')} to js/algsets/`);
