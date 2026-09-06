/* ===========================================================
   Tagda Timer — Learn mode: the spaced-repetition scheduler.

   The trainers already deal a case and record what you did on it.
   What they never did was *teach*: nothing showed you the algorithm,
   nothing asked whether you actually recalled it, and nothing brought
   a case you fumbled back tomorrow instead of in nine hundred solves'
   time. That is what this file decides.

   Everything here is pure — state in, state out, no DOM, no clock of
   its own (`now` is always passed in). That is what lets test.html
   run a hundred simulated review sessions in a millisecond and assert
   on where each case ended up.

   The state for one case:
       { box, dueAt, reps, lapses, peeks, seen, lastGrade }

   `box` is a Leitner box: 0 is being learned, GRADUATED_BOX and above
   is known. `dueAt` is a timestamp; a case is up for review once the
   clock passes it. A failure sets dueAt to now, which is what makes a
   fumbled case come back inside the same sitting rather than tomorrow.
   =========================================================== */

import { KV } from './db.js';

/** Days of separation for each box. Index is the box number. */
export const INTERVALS = [0, 1, 2, 4, 8, 16, 32, 64];

/** At or above this box, a case counts as known rather than being learned. */
export const GRADUATED_BOX = 3;

export const DEFAULTS = {
  /** How many cases you have never seen may enter one sitting. */
  newPerSession: 5,
  /**
   * A solve slower than this multiple of your own average on the case is
   * treated as "you got there, but you did not know it" — the box holds
   * rather than advancing. It is deliberately a multiple of *your* average
   * and not a fixed second count, because 1.5x is a different number for a
   * sub-10 solver and someone learning their first PLL.
   */
  slowFactor: 1.5,
  /** How many cases one sitting hands you before it calls itself done. */
  sessionLength: 20,
};

const DAY = 86400000;

/** A case nobody has seen yet. */
export const freshState = () => ({
  box: 0, dueAt: 0, reps: 0, lapses: 0, peeks: 0, seen: false, lastGrade: null,
});

/** Learn state is keyed by set as well as case: PLL `T` is not OLL `T`. */
export const keyOf = (setName, caseId) => `${setName}:${caseId}`;

/**
 * What one solve did to a case.
 *
 * Three outcomes, in the order they are checked:
 *   fail — you peeked at the algorithm, or DNF'd it. Back to box 0, and
 *          due immediately, so it returns before you leave.
 *   hold — solved, but slowly, or with a +2. The box does not move; you
 *          see it again on the same schedule rather than a longer one.
 *   pass — clean and at or under your own average. Up a box.
 *
 * `caseAvg` is your mean on this case so far. Until there are enough solves
 * to mean anything the caller passes null, and then anything that is not a
 * peek or a DNF passes: on the first ever attempt at a case there is no
 * honest way to call a time slow.
 */
export function grade(state, { timeMs, penalty = 'none', peeked = false, caseAvg = null, now = Date.now(), opts = {} }) {
  const { slowFactor = DEFAULTS.slowFactor } = opts;
  const s = { ...freshState(), ...state };

  const failed = peeked || penalty === 'DNF';
  const slow   = !failed && (penalty === '+2' || (caseAvg !== null && timeMs > caseAvg * slowFactor));

  s.reps  += 1;
  s.seen   = true;
  if (peeked) s.peeks += 1;

  if (failed) {
    s.lapses += 1;
    s.box     = 0;
    s.dueAt   = now;              // comes back this sitting, not tomorrow
    s.lastGrade = 'fail';
  } else if (slow) {
    s.dueAt   = now + INTERVALS[Math.min(s.box, INTERVALS.length - 1)] * DAY;
    s.lastGrade = 'hold';
  } else {
    s.box = Math.min(s.box + 1, INTERVALS.length - 1);
    /* A case cannot be called known on evidence that does not exist. Until
       there are enough solves of it to have an average, every attempt passes
       -- there is nothing to call slow -- and three lucky passes would
       otherwise graduate a case you cannot actually do. So without an average
       the box stops one short of graduating and waits for one. */
    if (caseAvg === null) s.box = Math.min(s.box, GRADUATED_BOX - 1);
    s.dueAt = now + INTERVALS[s.box] * DAY;
    s.lastGrade = 'pass';
  }
  return s;
}

/** Where a case stands, in the three words the progress strip uses. */
export function stageOf(state) {
  if (!state || !state.seen) return 'new';
  return state.box >= GRADUATED_BOX ? 'mature' : 'learning';
}

/**
 * The order to deal cases in for one sitting.
 *
 * Reviews that are actually due come first — they are the ones at risk of
 * being forgotten — but new cases are folded in every few slots rather than
 * queued behind all of them, so a set with a hundred due reviews still
 * teaches you something today. Nothing not in `allowedIds` is ever dealt:
 * the case picker stays the authority on what you are working on.
 */
export function nextQueue(states, allowedIds, { now = Date.now(), opts = {} } = {}) {
  const { newPerSession = DEFAULTS.newPerSession, sessionLength = DEFAULTS.sessionLength } = opts;

  const due = [];
  const fresh = [];
  for (const id of allowedIds) {
    const st = states[id];
    if (!st || !st.seen) fresh.push(id);
    else if (st.dueAt <= now) due.push(id);
  }
  // Longest overdue first: what you are closest to losing.
  due.sort((a, b) => (states[a].dueAt - states[b].dueAt));
  const intake = fresh.slice(0, newPerSession);

  const out = [];
  let d = 0, n = 0;
  while ((d < due.length || n < intake.length) && out.length < sessionLength) {
    // One new case every third slot, and immediately if there is nothing due.
    const wantNew = n < intake.length && (d >= due.length || out.length % 3 === 2);
    out.push(wantNew ? intake[n++] : due[d++]);
  }
  return out;
}

/** Counts for the progress strip, over whatever cases are switched on. */
export function summarize(states, allowedIds, now = Date.now()) {
  const out = { new: 0, learning: 0, mature: 0, due: 0, total: allowedIds.length };
  for (const id of allowedIds) {
    const st = states[id];
    out[stageOf(st)] += 1;
    if (st && st.seen && st.dueAt <= now) out.due += 1;
  }
  return out;
}

/**
 * When this case comes back, in words. Shown after each solve so the
 * schedule is something you can see working rather than a black box.
 */
export function dueLabel(state, now = Date.now()) {
  if (!state || !state.seen) return 'new';
  const ms = state.dueAt - now;
  if (ms <= 0) return 'again this session';
  const days = Math.round(ms / DAY);
  if (days <= 1) return 'due tomorrow';
  return `due in ${days} days`;
}

/* ---------------------------------------------------------
   Persistence — one KV blob, keyed `set:caseId`.

   A KV entry rather than a new object store on purpose: the store
   is a flat map of a few hundred small records at most, and adding
   one would mean a schema version bump and an upgrade path for every
   existing user's database to carry data that fits in a single value.
   --------------------------------------------------------- */
const KEY = 'learn';

export async function loadStates() {
  return (await KV.get(KEY, {})) || {};
}

export async function saveStates(states) {
  return KV.set(KEY, states);
}
