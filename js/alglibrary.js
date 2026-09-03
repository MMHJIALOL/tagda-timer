/* ===========================================================
   Tagda Timer — algorithm library core (no DOM in this file).

   Three layers, deliberately kept apart so none of them can clobber
   another:

     algs.js              one canonical alg per case, unchanged by this
                          feature — still the fallback everywhere.
     alglibrary-*.js      researched community alternates, read-only,
                          ships with the app.
     IndexedDB `kv`       your drag order and your own algs, per device.

   Nothing here trusts an algorithm it has not executed. `verify()` runs
   the candidate against the case's own scrambled state using the facelet
   simulator the scramble preview already uses, and both the static files
   and the "add your own" box go through it. A wrong alg in a cubing app
   teaches someone the wrong thing, which is worse than a missing feature.
   =========================================================== */

import { PLL, OLL } from './algs.js';
import { PLL_LIBRARY } from './alglibrary-pll.js';
import { OLL_LIBRARY } from './alglibrary-oll.js';
import { faceletsFor, parseAlg } from './cubenet.js';
import { KV } from './db.js';
import { invert } from './util.js';

/* ---------------------------------------------------------
   Sets
   --------------------------------------------------------- */

/* Plain-English descriptors. §2: a card labelled only "T" means nothing to
   anyone who has not memorised PLL letters, and recognition is by shape. The
   letter stays for people who did learn it; this is what the card says next
   to the picture. OLL takes its descriptor from the shape name algs.js
   already carries. */
const PLL_DESC = {
  Aa: 'three corners cycle one way, all four edges solved',
  Ab: 'three corners cycle the other way, all four edges solved',
  E:  'both corner pairs swap, edges stay',
  F:  'two adjacent corners and two edges swap',
  Ga: 'three corners and three edges cycle',
  Gb: 'three corners and three edges cycle',
  Gc: 'three corners and three edges cycle',
  Gd: 'three corners and three edges cycle',
  H:  'both edge pairs swap across the middle',
  Ja: 'one adjacent corner and edge pair swaps',
  Jb: 'one adjacent corner and edge pair swaps',
  Na: 'two opposite corner and edge pairs swap',
  Nb: 'two opposite corner and edge pairs swap',
  Ra: 'two corners and two edges swap, one bar',
  Rb: 'two corners and two edges swap, one bar',
  T:  'adjacent corner swap plus opposite edge swap',
  Ua: 'three edges cycle anticlockwise, corners solved',
  Ub: 'three edges cycle clockwise, corners solved',
  V:  'two adjacent corners and two edges swap',
  Y:  'two adjacent corners and two opposite edges swap',
  Z:  'both edge pairs swap side to side',
};

export const SETS = {
  PLL: {
    id: 'PLL',
    label: 'PLL',
    title: 'Permutation of the last layer',
    cases: PLL,
    library: PLL_LIBRARY,
    describe: (c) => PLL_DESC[c.id] || c.group,
  },
  OLL: {
    id: 'OLL',
    label: 'OLL',
    title: 'Orientation of the last layer',
    cases: OLL,
    library: OLL_LIBRARY,
    describe: (c) => (c.label ? c.label.toLowerCase() : c.group),
  },
};

/** Which set a case id belongs to. Case ids are unique across both sets. */
export function setOf(caseId) {
  for (const set of Object.values(SETS)) {
    if (set.cases.some(c => c.id === caseId)) return set;
  }
  return null;
}

export const caseOf = (setId, caseId) =>
  (SETS[setId]?.cases || []).find(c => c.id === caseId) || null;

/**
 * The scrambled state that defines a case: the app's own alg run backwards
 * from solved. That is exactly how the trainer builds a case scramble
 * (see the header of algs.js), so "solves this case" here means the same
 * thing it means on the timer screen.
 */
export const casePattern = (setId, caseId) => {
  const c = caseOf(setId, caseId);
  return c ? invert(c.alg) : null;
};

/* ---------------------------------------------------------
   Verification (§7)
   --------------------------------------------------------- */

const AUFS = ['', 'U', 'U2', "U'"];
const uniform = (grid) => grid.every(row => row.every(s => s === grid[0][0]));

/** Whole cube solved, ignoring which way round it ended up facing. */
function isSolved(f) {
  return ['U', 'R', 'F', 'D', 'L', 'B'].every(face => uniform(f[face]));
}

/**
 * Last layer oriented: the U face is one colour and the two layers below it
 * are untouched. A `y` inside the alg rotates all four side faces together,
 * so each staying uniform below the top row is still the right test.
 */
function isOriented(f) {
  if (!uniform(f.U) || !uniform(f.D)) return false;
  return ['R', 'F', 'L', 'B'].every(face => uniform(f[face].slice(1)));
}

/**
 * Does `alg` solve `caseId`?
 *
 * The AUF search is not leniency — a U turn before or after is free on a real
 * cube, and every published alg sheet assumes you will make it. Without it,
 * perfectly good community algs would be rejected for starting from a
 * different recognition angle.
 */
export function verifyAlgForCase(setId, caseId, alg) {
  const pattern = casePattern(setId, caseId);
  if (!pattern || !parseAlg(alg)) return false;
  const done = setId === 'OLL' ? isOriented : isSolved;
  for (const pre of AUFS) {
    for (const post of AUFS) {
      const seq = [pattern, pre, alg, post].filter(Boolean).join(' ');
      if (done(faceletsFor(seq, 3))) return true;
    }
  }
  return false;
}

/**
 * Facelets of the case, at the angle it should be drawn.
 *
 * PLL is turned to the angle every printed sheet uses — the one where the
 * corners look solved. `invert(alg)` on its own lands wherever the alg's U
 * turns leave it, and the Z perm's default alg makes five quarter turns of U,
 * so the raw state comes out a quarter turn off with every corner apparently
 * swapped. It is a real state of the case, and the trainer adds a random AUF
 * on top anyway, but it is not the picture anyone recognises. A U turn is free
 * on a permutation case, so pick the one that leaves the most side stickers
 * already home.
 *
 * OLL is left exactly where the case's own algorithm expects it. There is no
 * free AUF there — an OLL alg only works from the angle it was written for —
 * so turning the picture to look tidier would be drawing a case the listed
 * algorithm does not solve.
 */
export const caseFacelets = (setId, caseId) => {
  const pattern = casePattern(setId, caseId);
  if (!pattern) return null;
  if (setId !== 'PLL') return faceletsFor(pattern, 3);

  let best = null, bestScore = -1;
  for (const auf of AUFS) {
    const f = faceletsFor([pattern, auf].filter(Boolean).join(' '), 3);
    let score = 0;
    for (const face of ['R', 'F', 'L', 'B']) {
      for (const s of f[face][0]) if (s === face) score++;
    }
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best;
};

/** Move count in ETM, counting rotations and slices as one move each. */
export const moveCount = (alg) => (parseAlg(alg) || []).length;

/* ---------------------------------------------------------
   Per-user layer — kv keys, cached in memory
   --------------------------------------------------------- */

const orderKey  = (caseId) => 'alglib:order:' + caseId;
const customKey = (caseId) => 'alglib:custom:' + caseId;

/* The trainer needs the user's first-choice alg synchronously, mid-scramble
   generation, so the whole per-user layer is read once at startup and kept in
   memory. It is a few dozen short strings. */
const _order  = new Map();   // caseId -> array of alg strings
const _custom = new Map();   // caseId -> array of { alg, moveCount, notes }
let _loaded = false;

/** Read every stored order/custom entry. Safe to call more than once. */
export async function loadLibraryPrefs() {
  if (_loaded) return;
  _loaded = true;
  /* One scan of the `alglib:` namespace rather than 156 point reads — this is
     awaited on the timer's boot path, before the first scramble. */
  const rows = await KV.prefixed('alglib:');
  for (const [key, value] of rows) {
    if (!Array.isArray(value) || !value.length) continue;
    if (key.startsWith('alglib:order:'))  _order.set(key.slice(13), value);
    if (key.startsWith('alglib:custom:')) _custom.set(key.slice(14), value);
  }
}

/**
 * The list the detail view renders: community alternates, then anything you
 * added, put into your saved order.
 *
 * Entries you have never seen — a future research pass adding a fifth alg to
 * a case — land at the end rather than reshuffling a list you already
 * personalised.
 */
export function displayOrder(setId, caseId) {
  const set = SETS[setId];
  const c = caseOf(setId, caseId);
  if (!set || !c) return [];

  const base = (set.library[caseId]?.alternates || []).map(a => ({ ...a, source: 'community' }));
  /* Every set case has a canonical alg in algs.js. Where the research pass has
     not reached yet (all of OLL, for now) that alg is the whole library rather
     than an empty page. */
  if (!base.some(a => a.alg === c.alg)) {
    base.push({ alg: c.alg, moveCount: moveCount(c.alg), source: 'community',
                notes: "this app's own default for the case" });
  }
  const custom = (_custom.get(caseId) || []).map(a => ({ ...a, source: 'custom' }));

  const all = [...base, ...custom];
  const saved = _order.get(caseId);
  if (!saved) return all;

  const known = new Set(saved);
  return saved.map(alg => all.find(a => a.alg === alg)).filter(Boolean)
    .concat(all.filter(a => !known.has(a.alg)));
}

/**
 * §6.1 — position 1 is not decoration. This is what the trainer inverts to
 * build a scramble for the case, so reordering is how you tell the app which
 * alg you actually drill. Untouched cases fall through to algs.js.
 */
export function preferredAlg(caseId) {
  const saved = _order.get(caseId);
  if (!saved || !saved.length) return null;
  const set = setOf(caseId);
  if (!set) return null;
  const first = displayOrder(set.id, caseId)[0];
  return first ? first.alg : null;
}

/** Persist a drag order. Order is stored as alg strings, not indices. */
export async function saveOrder(caseId, algs) {
  _order.set(caseId, algs.slice());
  await KV.set(orderKey(caseId), algs.slice());
}

/** Drop a personal order, so the case reads community-ranked again. */
export async function resetOrder(caseId) {
  _order.delete(caseId);
  await KV.del(orderKey(caseId));
}

export const hasCustomOrder = (caseId) => _order.has(caseId);

/**
 * Add one of your own algs to a case.
 * Rejects — rather than saving as unverified — anything that does not
 * actually solve the case (§5, §7).
 */
export async function addCustom(setId, caseId, alg) {
  const clean = (parseAlg(alg) || []).join(' ');
  if (!clean) return { ok: false, error: 'That is not move notation. Try something like R U R\' U\'.' };
  if (displayOrder(setId, caseId).some(a => a.alg === clean)) {
    return { ok: false, error: 'That algorithm is already listed for this case.' };
  }
  if (!verifyAlgForCase(setId, caseId, clean)) {
    return { ok: false, error: 'That does not solve this case — checked against a real cube.' };
  }
  const list = (_custom.get(caseId) || []).concat({ alg: clean, moveCount: moveCount(clean) });
  _custom.set(caseId, list);
  await KV.set(customKey(caseId), list);
  return { ok: true, alg: clean };
}

/** Remove one of your own algs, and forget it in the saved order too. */
export async function removeCustom(caseId, alg) {
  const list = (_custom.get(caseId) || []).filter(a => a.alg !== alg);
  list.length ? _custom.set(caseId, list) : _custom.delete(caseId);
  await (list.length ? KV.set(customKey(caseId), list) : KV.del(customKey(caseId)));

  const ord = _order.get(caseId);
  if (ord && ord.includes(alg)) await saveOrder(caseId, ord.filter(a => a !== alg));
}

/* ---------------------------------------------------------
   Static-file audit (§7.1, §8 step 1)
   --------------------------------------------------------- */

/**
 * Run every shipped alternate against its case. Returns the failures.
 *
 * This exists so the check is a step in the build rather than a spot-check
 * anyone can forget — it is what catches a transcription error like the Ua
 * entry described in SPOTIFY-style research notes, instead of finding it by
 * luck. `tools/verify-alglibrary.html` is the page that calls it.
 */
export function auditLibrary() {
  const bad = [];
  for (const set of Object.values(SETS)) {
    for (const c of set.cases) {
      for (const a of (set.library[c.id]?.alternates || [])) {
        if (!verifyAlgForCase(set.id, c.id, a.alg)) bad.push({ set: set.id, caseId: c.id, alg: a.alg });
      }
    }
  }
  return bad;
}
