/* ===========================================================
   Tagda Timer — Learn mode: the runtime around the scheduler.

   js/learn.js decides *when* a case should come back. This file is
   everything else: which case the timer is about to deal, whether the
   algorithm is on screen, what the last solve did to the schedule, and
   the strip of counts under the scramble.

   Learn is a switch on top of the trainer modes rather than a mode of
   its own. Every case mode already deals a known case and records what
   you did on it; making learn a second copy of all fifteen of them would
   have meant two definitions of what a PLL scramble is. So the mode
   picker is untouched — PLL is still PLL — and learn changes only which
   case out of PLL you are handed next, and what is shown alongside it.
   =========================================================== */

import { $, fmt } from './util.js';
import { toast } from './toast.js';
import { byCase } from './stats.js';
import { setFor } from './scramble.js';
import { MODES } from './events.js';
import {
  freshState, grade, stageOf, nextQueue, summarize, dueLabel, keyOf,
  loadStates, saveStates, DEFAULTS,
} from './learn.js';

/**
 * How many *earlier* solves of a case there must be before its average is
 * allowed to judge the current one. Two is enough to say "slower than usual"
 * without being one bad solve away from meaningless.
 */
const ENOUGH_TO_JUDGE = 2;

export function createLearn(app) {
  let states = {};
  let queue = [];
  let current = null;        // { caseId, key, alg, name, stage }
  let peeked = false;
  let ready = false;
  /* How many cases you had never seen have been introduced in this sitting.
     The cap has to be counted here rather than inside nextQueue, because the
     queue is rebuilt every twenty solves and a cap applied per rebuild would
     let a whole session's worth of new cases through a few at a time. */
  let introduced = 0;
  let exhausted = false;

  const setName = () => MODES[app.settings.mode]?.set || null;
  /** Learn only means anything where there is a case list to learn. */
  const supported = () => !!setName();
  const on = () => !!app.settings.learn && supported();

  const allowedIds = () => {
    const set = setFor(app.settings.mode);
    if (!set) return [];
    const allow = app.settings.allowedCases[app.settings.mode];
    return (allow && allow.length) ? set.filter(c => allow.includes(c.id)).map(c => c.id)
                                   : set.map(c => c.id);
  };

  /** The learn states for the current set, keyed by bare case id. */
  function scopedStates() {
    const sn = setName();
    const out = {};
    if (!sn) return out;
    for (const id of allowedIds()) {
      const st = states[keyOf(sn, id)];
      if (st) out[id] = st;
    }
    return out;
  }

  const stateFor = (caseId) => states[keyOf(setName(), caseId)] || freshState();

  /* ---------------- the sitting ---------------- */

  /**
   * The next case to deal, or null when there is nothing due and no new case
   * left. Null is not a failure — it means you are done for now, and the
   * caller falls back to a normal random case from the set so the timer
   * never sits there with nothing on it.
   */
  function nextCaseId() {
    if (!on()) return null;
    if (!queue.length) {
      const cap = app.settings.learnNewPerSession ?? DEFAULTS.newPerSession;
      queue = nextQueue(scopedStates(), allowedIds(), {
        opts: {
          newPerSession: Math.max(0, cap - introduced),
          sessionLength: DEFAULTS.sessionLength,
        },
      });
    }
    const id = queue.shift() || null;
    // Nothing due and no new case left to introduce: the sitting is done, and
    // the caller falls back to a random case out of the set.
    if (!id && !exhausted) { exhausted = true; sittingDone(); }
    if (id) exhausted = false;
    return id;
  }

  /** Called by main.js once a case scramble has actually been shown. */
  function dealt(caseId) {
    if (!on() || !caseId) { current = null; render(); return; }
    const set = setFor(app.settings.mode) || [];
    const c = set.find(x => x.id === caseId);
    const st = stateFor(caseId);
    current = {
      caseId,
      key: keyOf(setName(), caseId),
      alg: c?.alg || '',
      name: c?.name || caseId,
      stage: stageOf(st),
    };
    // A case you have never seen is shown its algorithm without being asked:
    // there is nothing to recall yet, and hiding it would only be a guess.
    peeked = current.stage === 'new';
    if (current.stage === 'new' && !st.seen) introduced += 1;
    render();
  }

  function peek() {
    if (!on() || !current) return;
    peeked = true;
    render();
  }

  /**
   * Grade the solve that just landed and say what it did.
   * Returns silently for anything that is not a learn-mode case solve, so
   * main.js can call it on every solve without asking questions first.
   */
  async function onSolve(solve) {
    if (!on() || !current || solve.caseId !== current.caseId) return;

    /* Everything on this case except the solve being graded. Including it
       would let a slow solve raise the very average it is being measured
       against, which is how a case you are getting worse at keeps passing. */
    const earlier = app.solves.filter(s => s.caseId === solve.caseId && s.id !== solve.id);
    const row = byCase(earlier).find(r => r.caseId === solve.caseId);
    const caseAvg = (row && row.count >= ENOUGH_TO_JUDGE && row.avg !== null) ? row.avg : null;

    const before = stateFor(solve.caseId);
    const after = grade(before, {
      timeMs: solve.timeMs,
      penalty: solve.penalty,
      peeked: peeked && before.seen,   // a first sighting is not a peek, it is the lesson
      caseAvg,
      opts: { slowFactor: app.settings.learnSlowFactor ?? DEFAULTS.slowFactor },
    });
    states[current.key] = after;
    await saveStates(states);

    // A failed case goes back near the front of the queue so it returns within
    // a few solves rather than at the end of the sitting.
    if (after.lastGrade === 'fail' && !queue.includes(solve.caseId)) {
      queue.splice(Math.min(2, queue.length), 0, solve.caseId);
    }

    showVerdict(after, caseAvg);
  }

  /* ---------------- rendering ---------------- */

  function showVerdict(st, caseAvg) {
    const node = $('#learn-verdict');
    if (!node) return;
    const word = st.lastGrade === 'pass' ? 'got it' : st.lastGrade === 'hold' ? 'slow' : 'missed';
    const why = st.lastGrade === 'hold' && caseAvg !== null ? ` (your average is ${fmt(caseAvg)})` : '';
    node.textContent = `${word} — ${dueLabel(st)}${why}`;
    node.className = `lv-${st.lastGrade}`;
  }

  function render() {
    const bar = $('#learn-bar');
    if (!bar) return;
    bar.hidden = !on();
    if (!on()) return;

    const sum = summarize(scopedStates(), allowedIds());
    $('#lp-new').textContent = sum.new;
    $('#lp-learning').textContent = sum.learning;
    $('#lp-mature').textContent = sum.mature;
    $('#lp-due').textContent = sum.due;

    const algBox = $('#learn-alg');
    const peekBtn = $('#btn-learn-peek');
    if (!current) {
      algBox.hidden = true;
      peekBtn.hidden = true;
      return;
    }
    peekBtn.hidden = peeked;
    algBox.hidden = !peeked;
    if (peeked) {
      $('#learn-tag').textContent = current.stage === 'new' ? 'new case' : current.name;
      $('#learn-alg-text').textContent = current.alg || '(no algorithm on file)';
    }
  }

  /* ---------------- switching it on ---------------- */

  async function init() {
    states = await loadStates();
    ready = true;
    $('#btn-learn-peek')?.addEventListener('click', peek);
    $('#btn-learn-exit')?.addEventListener('click', () => setEnabled(false));
    render();
  }

  /** Said once, when there is nothing left that is due. */
  function sittingDone() {
    const node = $('#learn-verdict');
    if (node) {
      node.textContent = 'nothing due — drilling this set at random from here';
      node.className = 'lv-done';
    }
  }

  function setEnabled(want) {
    if (want && !supported()) {
      toast('Learn mode works on the trainer modes — pick PLL, OLL, F2L or ZBLL first');
      return false;
    }
    app.settings.learn = !!want;
    app.persist();
    queue = [];
    current = null;
    peeked = false;
    introduced = 0;
    exhausted = false;
    const v = $('#learn-verdict');
    if (v) { v.textContent = ''; v.className = ''; }
    render();
    app.nextScramble();
    if (want) {
      const sum = summarize(scopedStates(), allowedIds());
      toast(sum.due || sum.new
        ? `Learn mode on — ${sum.due} due, ${sum.new} you have not seen`
        : 'Learn mode on — everything in this set is up to date');
    }
    return true;
  }

  /** Hand a case back when the scramble built for it never reached the screen. */
  function returnCase(caseId) {
    if (caseId && !queue.includes(caseId)) queue.unshift(caseId);
  }

  return {
    init, render, dealt, onSolve, peek, setEnabled, nextCaseId, returnCase,
    get enabled() { return on(); },
    get supported() { return supported(); },
    get ready() { return ready; },
    stats: () => summarize(scopedStates(), allowedIds()),
  };
}
