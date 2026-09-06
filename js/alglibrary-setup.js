/* ===========================================================
   Tagda Timer — setup moves for a case.

   The library shows you the algorithm. This is the other half: the moves
   that put the case in front of you in the first place, so practising a
   case is "do the setup, then try to solve it" rather than "read the alg
   backwards in your head one move at a time".

   Two rules decide what gets shown, and the second one is the whole point
   of the feature:

     1. A setup must produce *this* case, at the angle the page draws it —
        not a rotation of it, not a different AUF of it. That is checked by
        executing it, the same way every algorithm in this library is
        checked (alglibrary.js §7). Nothing is printed on trust.

     2. A setup that is simply your first algorithm written backwards is
        the last resort, not the default. Reversing the alg you are about
        to practise is exactly the work this feature exists to remove, and
        a cube set up that way is a cube you just watched yourself solve.
        It is used only when nothing else is shorter — when the reversal
        genuinely *is* the optimal setup and pretending otherwise would
        mean printing a longer sequence for the sake of looking different.

   Where the alternatives come from: every algorithm the case lists solves
   that case, so every one of them, inverted, sets it up. A case with six
   alternates therefore has six candidate setups before a single move is
   searched for, and the shortest one that is not your own alg backwards
   is almost always among them. Nothing here invents notation — it
   re-uses algorithms this library already ships and already verified.
   =========================================================== */

import { faceletsFor, parseAlg, stickerAt } from './cubenet.js';
import { invert, tidy } from './util.js';
import { caseFacelets, displayOrder, isCaseSolved } from './alglibrary.js';

const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
const AUFS = ['', 'U', 'U2', "U'"];

/* ---------------------------------------------------------
   Whole-cube orientation
   --------------------------------------------------------- */

/* An algorithm may contain a `y` (or, in the A perms, an `x`) that it never
   undoes. Inverting such an alg gives a sequence that builds the case on a
   cube left facing somewhere else — the right state, drawn wrong. So the
   inverse gets a rotation appended to put the cube back the way the picture
   has it, and the rotation needed is worked out from where the centres ended
   up rather than by trying all 24 and hoping. */
const ORIENTS = [];
for (const flip of ['', 'x', "x'", 'x2', 'z', "z'"]) {
  for (const spin of ['', 'y', 'y2', "y'"]) {
    ORIENTS.push([flip, spin].filter(Boolean).join(' '));
  }
}

/** Where each face's centre comes from, per orientation. Computed once. */
const ORIENT_MAP = ORIENTS.map(rot => {
  const f = faceletsFor(rot || "U U'", 3);
  return { rot, from: Object.fromEntries(FACES.map(face => [face, f[face][1][1]])) };
});

const centres = (f) => Object.fromEntries(FACES.map(face => [face, f[face][1][1]]));

/** The rotation that turns `f`'s orientation into `target`'s, or null. */
function alignment(f, target) {
  const a = centres(f), b = centres(target);
  for (const { rot, from } of ORIENT_MAP) {
    if (FACES.every(face => a[from[face]] === b[face])) return rot;
  }
  return null;
}

/* ---------------------------------------------------------
   "Is this the same picture?"
   --------------------------------------------------------- */

const uniform = (grid) => grid.every(row => row.every(s => s === grid[0][0]));

/**
 * A fingerprint of what the case diagram would show for this state.
 *
 * Comparing raw facelets would be too strict and comparing "does an alg solve
 * it" too loose. Two states draw the same card exactly when this string
 * matches, which is the standard a setup has to meet: the cube in your hands
 * must look like the picture you clicked on.
 *
 * Returns null for a state that is not a case of this set at all — a last
 * layer sitting on top of an unsolved F2L, say.
 */
function signature(f, setId) {
  if (setId === 'F2L') return f2lSignature(f);
  if (!uniform(f.D)) return null;
  if (!['R', 'F', 'L', 'B'].every(face => uniform(f[face].slice(1)))) return null;

  const cells = [...f.U.flat(), ...['R', 'F', 'L', 'B'].flatMap(face => f[face][0])];
  /* OLL is a picture of what faces up, not of what colour it is — the same
     convention the diagrams use, and the reason two OLL setups that leave the
     last layer permuted differently are both correct. */
  if (setId !== 'OLL') return cells.join('');
  const up = f.U[1][1];
  return cells.map(s => (s === up ? '1' : '0')).join('');
}

/**
 * F2L cannot use the above: the case is a corner and an edge on their way into
 * a slot, and what the algorithm leaves behind in the last layer is not part
 * of it. Two correct F2L algs for one case routinely finish with the top layer
 * permuted differently, so their inverses differ there too — and both are
 * still perfectly good setups.
 *
 * What has to match is what the diagram draws: where the pair is, and the two
 * layers below it being built except for the slot.
 */
function f2lSignature(f) {
  const pieces = new Map();
  for (const face of FACES) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const { cubie } = stickerAt(face, r, c, 3);
        let p = pieces.get(cubie);
        if (!p) pieces.set(cubie, (p = { colours: [], stickers: [], home: true }));
        p.colours.push(f[face][r][c]);
        p.stickers.push(face + f[face][r][c]);
        if (f[face][r][c] !== face) p.home = false;
      }
    }
  }

  const parts = [];
  for (const [cubie, p] of [...pieces].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kind = [...p.colours].sort().join('');
    /* The pair, found by colour rather than by position — the whole question is
       where it currently is. Orientation counts, so the stickers go in too. */
    if (kind === 'DFR' || kind === 'FR') parts.push(`${cubie}=${p.stickers.sort().join('')}`);
    else if (Number(cubie.split(',')[1]) <= 0) parts.push(`${cubie}:${p.home ? 1 : 0}`);
  }
  return parts.join('|');
}

/* ---------------------------------------------------------
   Candidates
   --------------------------------------------------------- */

/* Ergonomics, as a tiebreak only — never enough to prefer a longer setup.
   Between two seven-move setups the one without a cube rotation in the middle
   is the one you can actually do without losing track of the front face. */
const awkwardness = (moves) => moves.reduce((n, m) => {
  if (/^[xyz]/.test(m)) return n + 0.5;
  if (/^[MES]/.test(m)) return n + 0.3;
  if (/w|^[urfdlb]/.test(m)) return n + 0.15;
  return n;
}, 0);

/**
 * Turn one algorithm into the best setup it can give.
 *
 * `invert(alg)` alone is not it. The alg is verified as solving the case from
 * *some* U turn, so its inverse builds the case at *some* U turn — the pre and
 * post AUFs here are what pin it to the one in the picture. They also pay for
 * themselves: a leading U' that cancels against the alg's own first move comes
 * out one move shorter than the raw inverse.
 */
function candidateFrom(alg, target, setId, want) {
  const inv = invert(alg);
  const rot = alignment(faceletsFor(inv, 3), target);
  if (rot === null) return null;

  /* Ranked before any of them is executed, and the first one that matches
     wins. Ordering first is not just tidiness: checking a state means running
     it on the simulator, and a case with sixteen alternates would otherwise
     pay for 256 cube simulations every time you open it. */
  const tries = [];
  for (const pre of AUFS) {
    for (const post of AUFS) {
      const moves = parseAlg(tidy([pre, inv, rot, post].filter(Boolean).join(' ')));
      if (moves) tries.push({ setup: moves.join(' '), moves: moves.length, awkward: awkwardness(moves), from: alg });
    }
  }
  tries.sort((a, b) => a.moves - b.moves || a.awkward - b.awkward);
  return tries.find(t => signature(faceletsFor(t.setup, 3), setId) === want) || null;
}

/* Comparing whole setups, awkwardness counts for something rather than only
   breaking ties: a twelve-move setup with two cube rotations in it is worse to
   do than a thirteen-move one without. It stays small enough that it can never
   turn a clearly shorter setup into the loser. */
const score = (c) => c.moves + c.awkward;
const better = (a, b) => (!b ? a : !a ? b : score(a) <= score(b) ? a : b);

/**
 * The setup moves for a case, given the order the alternates are currently in.
 *
 * Depends on your order on purpose: rule 2 is about the alg *you* are
 * practising, so promoting a different alg to the top can change which setup
 * is offered. Returns null only for a case whose algorithms all failed to
 * produce a checkable state, which the audit below exists to catch.
 *
 *   { setup, moves, from, reversesFirst, alternative }
 *
 * `reversesFirst` is true when what you are looking at is your own first
 * algorithm backwards, which the page says out loud rather than letting it
 * look like an oversight. `alternative` is the shortest setup that is not,
 * present only when one exists and lost on length.
 */
export function setupFor(setId, caseId) {
  const list = displayOrder(setId, caseId);
  if (!list.length) return null;
  const target = caseFacelets(setId, caseId);
  if (!target) return null;
  const want = signature(target, setId);
  if (want === null) return null;

  const first = candidateFrom(list[0].alg, target, setId, want);

  let distinct = null;
  for (const a of list.slice(1)) {
    const cand = candidateFrom(a.alg, target, setId, want);
    /* Two alternates can invert to the same string once cancellations are
       taken out. If that string is the reversal, it is still the reversal. */
    if (!cand || (first && cand.setup === first.setup)) continue;
    distinct = better(cand, distinct);
  }

  if (!distinct) return first && { ...first, reversesFirst: true, alternative: null };
  if (first && first.moves < distinct.moves) {
    return { ...first, reversesFirst: true, alternative: distinct };
  }
  return { ...distinct, reversesFirst: false, alternative: null };
}

/* ---------------------------------------------------------
   Audit (tools/verify-alglibrary.html)
   --------------------------------------------------------- */

/**
 * Every case gets a setup, and doing it followed by the case's own algorithm
 * finishes the cube.
 *
 * The second half is not redundant with the signature check. The signature
 * says the cube looks like the picture; this says the algorithm printed under
 * that picture actually works from there — end to end, which is the only claim
 * the page is making to someone holding a cube.
 */
export function auditSetups(sets) {
  const bad = [];
  for (const set of sets) {
    for (const c of set.cases) {
      const s = setupFor(set.id, c.id);
      if (!s) { bad.push({ set: set.id, caseId: c.id, why: 'no setup found' }); continue; }
      const alg = displayOrder(set.id, c.id)[0].alg;
      const solved = AUFS.some(pre => AUFS.some(post =>
        isCaseSolved(set.id, faceletsFor([s.setup, pre, alg, post].filter(Boolean).join(' '), 3))));
      if (!solved) bad.push({ set: set.id, caseId: c.id, why: `setup "${s.setup}" is not solved by ${alg}` });
    }
  }
  return bad;
}
