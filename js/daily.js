/* ===========================================================
   Tagda Timer — daily leaderboard controller

   Every day, everyone gets exactly the same scramble for a WCA event and
   one official attempt at it. This file is the state machine and the
   timer hooks; js/panels.js's buildDaily draws the panel from it, the same
   split race.js and panels.js's buildRace already use.

   Contrast with Race mode: a race room is the point, and its leaderboard
   is a byproduct that resets when the room does. Here the leaderboard is
   the entire point and a room does not exist at all — there is nothing to
   join, just today's scramble and everyone who has already sent a time
   for it. The day boundary, the scramble-publish race and the anti-cheat
   tuning all come straight from race-net.js / raceapp.js; see the comments
   there and in daily-net.js for why each exists.
   =========================================================== */

import { toast } from './toast.js';
import { eventOf } from './events.js';
import { eff, bestAvg } from './stats.js';
import { generate } from './scramble.js';
import { onAuthChange } from './sync-auth.js';
import {
  DailyTransport, cloudAvailable,
  CLOCK_SLACK_MS, CLOCK_SLACK_RATIO,
  countSolvesForDay, rankByCount, dayStartMs, safePhotoUrl,
  markSotdDone, clearSotdDone, sotdDoneOn,
} from './daily-net.js';
import { SUSPECT_RATIO } from './raceapp.js';

/**
 * Whether the "most solves today" board is shown.
 *
 * Off, and deliberately switched off rather than deleted. Everything behind
 * it still works and is still tested — `countSolvesForDay`, `rankByCount`,
 * the `dailyCount` transport and its rules — it just is not drawn, and
 * nothing writes to it while this is false. Flipping this to true is the
 * whole of turning the feature back on.
 *
 * Why it went: two boards side by side invited a comparison between them that
 * neither survives. One is a competition single with a server-timed window
 * behind it; the other counts spacebar presses and says so. Putting them in
 * one card implied they were the same kind of claim.
 *
 * It lives here rather than in dailyui.js because the controller has to
 * consult it too (see pushCount), and a controller reaching into the view for
 * a policy flag is the wrong way round.
 */
export const SHOW_COUNT_BOARD = false;

/** How long to keep retrying a write the leaderboard needs before giving up. */
const RETRY_MS = [400, 1200];

/**
 * How long to wait between attempts at publishing today's scramble, and so
 * how many attempts there are. Generous at the far end because the thing most
 * likely to be wrong is somebody else's connection, not this one — and the
 * moment anybody anywhere succeeds, every other client gets their scramble
 * from the listener and stops trying.
 */
const PUBLISH_BACKOFF_MS = [1500, 4000, 10000, 20000];

/** A random-state search that has not finished by now is not going to. */
const GENERATE_TIMEOUT_MS = 20000;

/** An event only counts as a daily challenge if "one scramble, one time" describes it. */
export function dailyEligible(eventId) {
  const ev = eventOf(eventId);
  return !ev.fmc && !ev.multi;
}

export class Daily extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.net = null;
    this.snap = null;
    this.eventId = dailyEligible(app.settings.event) ? app.settings.event : '333';

    /**
     * Whether the Scramble of the Day window is open.
     *
     * This, not `attempting`, is what decides whether the daily challenge has
     * any claim on the timer at all. Outside the window the feature is
     * invisible: it does not touch the scramble, does not hold the timer
     * shut, and does not care what you solve.
     */
    this.engaged = false;
    /** Armed by attempt(), disarmed the moment a result is submitted or cancelled. */
    this.attempting = false;
    /** Whether THIS uid already has a result for the watched day/event. */
    this.submittedToday = false;

    this._lastStatus = null;
    this._authUnsub = null;
    this._publishing = false;
    /** Set when the scramble write was refused rather than merely lost. */
    this.publishError = null;
    this._publishRetry = 0;
    this._publishTries = 0;
    /** The count last written, so an unchanged total is not rewritten. */
    this._lastCount = -1;
  }

  get revealed() { return this.submittedToday; }

  async connect() {
    if (this.net) return;
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      if (!cloudAvailable()) throw new Error('no-config');
      const net = new DailyTransport();
      await net.init();
      this.net = net;
      net.addEventListener('day', (e) => this._onDay(e.detail));
      this._authUnsub = await onAuthChange((user) => net.setUser(user));
      net.watch(this.eventId);
      // Whatever you solved today before opening this panel still counts.
      this.pushCount();
    })().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  /** Switch which event's board is being watched. Does not touch the main timer's event. */
  setEvent(eventId) {
    if (!dailyEligible(eventId) || eventId === this.eventId) return;
    this.eventId = eventId;
    this.attempting = false;
    this.submittedToday = false;
    this._resetPublishState();
    this.net?.watch(eventId);
    this._checkOwnResult();
    this.dispatchEvent(new CustomEvent('change'));
  }

  _onDay(snap) {
    const rolled = this.snap && snap.dayId && this.snap.dayId !== snap.dayId;
    if (rolled) this._resetPublishState();
    this.snap = snap;
    // A board that reset under you starts your count again from the solves
    // that belong to the new day, rather than carrying yesterday's total.
    if (rolled) this.pushCount();
    /* Arm as soon as there is something to arm ON, rather than only at the
       moment the window opened. Today's scramble usually arrives a beat after
       that — it may still be being generated and written by whoever got there
       first — and checking once on the way in meant the common case was a
       window that never armed at all: the generator kept supplying ordinary
       practice scrambles, every solve was an ordinary solve, nothing was ever
       submitted, and so the board never unlocked either. */
    if (this.engaged) this._armIfPossible();
    this._maybePublishScramble();
    this._checkOwnResult();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * The first signed-in visitor to find today's event without a scramble
   * publishes one. Write-once on the server, so two visitors racing to be
   * first cost nothing — the loser's write is refused and the listener
   * hands them the winner's scramble a moment later, same as a race round.
   */
  async _maybePublishScramble() {
    if (!this.snap || this.snap.scramble || this._publishing) return;
    if (!this.snap.signedIn) return; // the rules require auth for this write anyway
    /* Not before watch() has settled on a day and an event.
       `_onDay` fires for every snapshot the transport emits, and the very
       first of those can be the server-clock offset arriving while connect()
       is still awaiting onAuthChange — at which point there is no event yet
       and this would call the generator with `null`, burn the one attempt it
       used to get, and leave a bogus error behind. */
    const { event, dayId } = this.snap;
    if (!event || !dayId) return;
    /* And not before the scramble node has actually reported.
       `snap.scramble === null` does not mean "nobody has published today's" —
       it is equally what a listener that has not delivered its first value
       yet looks like, and watch() emits once before that happens. Publishing
       on that emit is the bug that made the day's scramble change on every
       refresh: each load raced its own read, and whoever beat it generated
       and wrote a fresh scramble, which everybody then saw. The rules were
       supposed to catch that (`!data.exists()`), but they are published by
       hand and separately from the app, so until they are there is nothing
       between a lost race and a new scramble for the whole world. */
    if (!this.snap.scrambleLoaded) return;

    this._publishing = true;
    clearTimeout(this._publishRetry);
    try {
      // The same official random-state generator every other scramble in the
      // app comes from (js/scramble.js). Called directly rather than through
      // a warm ScrambleQueue, because this write happens at most once per
      // event per day and nothing is waiting on a second one being ready.
      //
      // Raced against a clock: a random-state search that never comes back
      // is one of the ways this used to hang, and an attempt that never ends
      // is worse than one that fails, because only a failure gets retried.
      const s = await Promise.race([
        generate(event, 'wca'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('generator-timeout')), GENERATE_TIMEOUT_MS)),
      ]);
      if (this.snap.event !== event || this.snap.dayId !== dayId || this.snap.scramble) return;
      const out = await this.net.publishScramble(s.scramble);
      this.publishError = out?.ok ? null : (out?.reason || 'refused');
      if (this.publishError) console.warn('[daily] scramble publish refused:', this.publishError);
    } catch (err) {
      this.publishError = err?.code || String(err?.message || err);
      console.warn('[daily] scramble publish failed', err);
    } finally {
      this._publishing = false;
      this._scheduleRepublish();
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  /**
   * Try again, because one attempt was never enough.
   *
   * This used to be driven entirely by incoming snapshots: publishing was
   * attempted from `_onDay`, so if an attempt failed and no further snapshot
   * happened to arrive — which is the normal state of a quiet day with one
   * visitor — nothing ever tried again and the window sat on "Publishing
   * today's scramble…" until it was reloaded. That is the bug this exists to
   * close, and it is why the retry is on a timer rather than hung off an
   * event that may never come.
   *
   * Backs off, and gives up after a handful. If a scramble cannot be
   * published after PUBLISH_BACKOFF_MS.length tries it is not a hiccup, and
   * holdText says so rather than pretending something is still in flight.
   */
  _scheduleRepublish() {
    clearTimeout(this._publishRetry);
    if (this.snap?.scramble || !this.snap?.signedIn) return;
    if (this._publishTries >= PUBLISH_BACKOFF_MS.length) return;
    const wait = PUBLISH_BACKOFF_MS[this._publishTries++];
    this._publishRetry = setTimeout(() => {
      // Another client may have published in the meantime, which is the happy
      // ending — _maybePublishScramble checks that for itself.
      this._maybePublishScramble();
    }, wait);
  }

  /** A new day or event is a fresh start for all of the above. */
  _resetPublishState() {
    clearTimeout(this._publishRetry);
    this._publishRetry = 0;
    this._publishTries = 0;
    this.publishError = null;
  }

  async _checkOwnResult() {
    if (!this.net || !this.snap?.uid) { this.submittedToday = false; return; }
    const { event, dayId, uid } = this.snap;
    const has = await this.net.hasOwnResult();
    // The event or the day moved on while we were asking — the answer is stale.
    if (this.snap.event !== event || this.snap.dayId !== dayId || this.snap.uid !== uid) return;
    this.submittedToday = has;
    if (has) {
      this.net.unlockResults();
      this.attempting = false;
      markSotdDone(dayId);
    } else if (sotdDoneOn(dayId)) {
      /* The note says today is spent and the database says it is not, so the
         note is wrong and this is the only place that can ever find out: it
         belongs to the browser, not to the account, so it survives a sign-out
         and is inherited by whoever signs in next. The database is the one
         that knows, and it has just answered. */
      clearSotdDone();
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  /* ---------------- attempting today's scramble ---------------- */

  canAttempt() {
    return !!(this.snap?.signedIn && this.snap.scramble && !this.submittedToday && !this.attempting);
  }

  attempt() {
    if (!this.canAttempt()) return;
    this.attempting = true;
    this._lastStatus = null;
    if (this.app.settings.inputMode !== 'timer') {
      this.app.setSetting('inputMode', 'timer');
      toast('Switched to the spacebar timer for today’s scramble', { long: true });
    }
    this.app.nextScramble?.();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /* ---------------- being in the window ---------------- */

  /** Enter the window: from here until disengage(), the timer is the day's. */
  engage() {
    if (this.engaged) return;
    this.engaged = true;
    this._armIfPossible();
    // Even when there is nothing to arm yet, the scramble on screen has to
    // stop being an ordinary one immediately — see takeScramble's hold.
    if (!this.attempting) this.app.nextScramble?.();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** Leave the window. An attempt that was never solved is spent on nothing. */
  disengage() {
    if (!this.engaged) return;
    this.engaged = false;
    this.attempting = false;
    this.app.nextScramble?.();
    this.dispatchEvent(new CustomEvent('change'));
  }

  _armIfPossible() {
    if (this.attempting || !this.canAttempt()) return;
    this.attempt();
  }

  cancelAttempt() {
    if (!this.attempting) return;
    this.attempting = false;
    this.app.nextScramble?.();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** Which of the window's states this is, for the UI to say so out loud. */
  status() {
    if (!this.snap?.signedIn) return 'signed-out';
    if (this.submittedToday) return 'done';
    if (!this.snap.scramble) return 'waiting';
    if (this.attempting) return 'ready';
    return 'waiting';
  }

  /* ---------------- hooks main.js calls, same shape as race.js's ---------------- */

  takeScramble() {
    if (!this.engaged) return null;

    /* Nothing to solve: today's scramble has not been published yet, you are
       not signed in to be given one, or you have already spent today's single
       attempt. All three put a MESSAGE where the notation goes, never a
       scramble — the same rule race.js follows, and for the same reason. A
       scramble on screen is an instruction to scramble, and the version of
       this window that let the generator fill that gap was indistinguishable
       from an ordinary timer: the scramble changed on every solve, none of
       them counted, and nothing ever reached the board. */
    if (!this.attempting || !this.snap?.scramble) {
      return { scramble: '', hold: this.holdText(), official: true, daily: true };
    }
    return { scramble: this.snap.scramble, official: true, daily: true };
  }

  /** The line that stands in for the scramble when there is nothing to solve. */
  holdText() {
    if (!this.snap?.signedIn) return 'Sign in to be given today’s scramble';
    if (this.submittedToday) return 'You have already done today’s scramble — come back after the reset';
    if (this.snap.readError) {
      return 'Today’s board cannot be read on this deployment — see DAILY.md, '
           + 'firebase.rules.json probably needs republishing.';
    }
    /* Three different things used to share one message. "…" implies something
       is still in flight, which was a lie in two of these cases: an attempt
       that had failed and would never be retried, and an attempt that could
       never succeed. Only the first line below is allowed to say "…". */
    if (!this.snap.scramble) {
      if (this.gaveUpPublishing()) {
        return 'Today’s scramble could not be published after several tries'
             + (this.publishError ? ` (${this.publishError})` : '')
             + ' — reload, or see DAILY.md if this keeps happening.';
      }
      return 'Publishing today’s scramble…';
    }
    return 'Nothing to solve right now';
  }

  /** Every attempt at publishing has been spent and none of them worked. */
  gaveUpPublishing() {
    return !this._publishing && this._publishTries >= PUBLISH_BACKOFF_MS.length;
  }

  /**
   * True while the timer must not accept an attempt.
   *
   * Same meaning as race.js's version, which this originally got backwards:
   * it returned `attempting`, so the timer was held shut during the one solve
   * it was supposed to be timing, and wide open the rest of the time. The
   * effect was that today's scramble could be "attempted" over and over, none
   * of those attempts being the official one.
   *
   * Outside the window it is always false. Practising is never the daily
   * challenge's business.
   */
  locked() {
    if (!this.engaged) return false;
    if (!this.snap?.signedIn) return true;
    if (!this.snap.scramble) return true;
    return this.submittedToday;
  }

  onTimerState(state) {
    if (!this.attempting) return;
    const map = { inspecting: 'inspecting', holding: 'inspecting', ready: 'inspecting', running: 'solving' };
    const status = map[state];
    if (!status || status === this._lastStatus) return;
    this._lastStatus = status;
    this.net.setProgress({ status }).catch(() => {});
  }

  /** A finished solve of today's scramble becomes this event's result. */
  async onSolveRecorded(solve) {
    if (!this.attempting || !this.snap?.scramble) return;
    // Only a solve of TODAY's scramble counts — guards the small window where
    // the event or the day could have moved on mid-attempt.
    if (String(solve.scramble || '').trim() !== String(this.snap.scramble).trim()) return;

    this.attempting = false;
    this.submittedToday = true;
    this._lastStatus = null;
    markSotdDone(this.snap.dayId);
    this.dispatchEvent(new CustomEvent('change'));

    await this._retry(() => this.net.setProgress({ status: 'done', submitted: true }));

    const result = {
      timeMs: Math.round(solve.timeMs),
      penalty: solve.penalty || 'none',
      name: this._name(),
      suspect: this._looksSuspect(solve) || null,
    };
    try {
      await this._retry(() => this.net.submitResult({ ...result, photo: this._photo() }));
    } catch (err) {
      /* Once more without the avatar.

         `results` rejects any field it does not know about ("$other": false),
         so a deployment still running the rules from before avatars existed
         refuses the WHOLE write because of one cosmetic field — and the time
         you just did is lost to a picture. Dropping it and trying again turns
         a rules version skew into a missing face instead of a missing result,
         which is the right way round: the face is decoration, the time is the
         entire point. */
      console.warn('[daily] result refused, retrying without the avatar', err);
      try {
        await this._retry(() => this.net.submitResult(result));
      } catch (err2) {
        console.warn('[daily] result refused', err2);
        toast('Today’s board would not accept that time', { kind: 'bad' });
      }
    }
    this.net.unlockResults();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * Roll the boards over if the day has ended while they were on screen.
   *
   * `watch()` already recomputes the day from the server clock and resubscribes
   * when it finds a new one — it just needs somebody to ask. Nothing did: it
   * was called once on connect and again only if you touched the event picker,
   * so a tab left open across 00:00 IST sat on yesterday's board indefinitely,
   * with a countdown stuck at "under a minute" because the reset it was
   * counting down to had already happened.
   *
   * Called from the same one-second tick that draws that countdown, in both
   * the window and the panel, so the thing that would show the problem is the
   * thing that fixes it. Cheap: the comparison is two integers, and `watch()`
   * is a no-op unless the day id genuinely changed.
   */
  checkRollover() {
    if (!this.net || !this.snap?.nextResetMs) return;
    if (this.net.serverNow() < this.snap.nextResetMs) return;
    this.submittedToday = false;
    this._lastCount = -1;   // the new day starts your count over
    this.net.watch(this.eventId);
  }

  /* ---------------- the solve-count board ---------------- */

  /**
   * Publish today's solve total. Called on connect and after every recorded
   * solve, from main.js — including solves that had nothing to do with
   * today's scramble, which is the whole point of this second board.
   *
   * Deliberately fire-and-forget: this is a leaderboard nicety, and a solve
   * that failed to be counted must never surface as an error over a timer.
   */
  pushCount() {
    // Nothing reads this board while it is switched off, and a write nobody
    // reads is a write worth not making — it is also the one write that needs
    // a rules node this deployment may not have yet.
    if (!SHOW_COUNT_BOARD) return;
    if (!this.net || !this.snap?.signedIn || !this.snap.dayId) return;
    const n = countSolvesForDay(this.app.solves || [], dayStartMs(this.snap.dayId));
    if (n === this._lastCount) return;   // nothing new to say
    this._lastCount = n;
    this.net.writeCount(n, this._name(), this._photo())
      .catch(err => console.warn('[daily] count write failed', err));
  }

  /** Today's solve-count board, most solves first. */
  countBoard() {
    return rankByCount(this.snap?.counts, this.snap?.uid);
  }

  /** How many solves this client has done today, whether or not it published. */
  myCount() {
    if (!this.snap?.dayId) return 0;
    return countSolvesForDay(this.app.solves || [], dayStartMs(this.snap.dayId));
  }

  _name() {
    return this.app.settings.raceName || this.snap?.displayName || 'Cuber';
  }

  /**
   * The Google account picture, so a board row is a face rather than a row of
   * identical initials. Never uploaded anywhere — it is a URL Google already
   * serves publicly, written alongside a name that was already public.
   *
   * Filtered on the way OUT as well as on the way in, and not because this
   * app would ever produce a bad one: the rules reject a `photo` that is not
   * an account picture, and a rejected field fails the whole write. Sending
   * only what the rule accepts means an odd provider URL costs a row its
   * face, never its place on the board.
   */
  _photo() {
    return safePhotoUrl(this.snap?.photoURL);
  }

  /** Same reasoning as race.js's version: flagged, never blocked. */
  _looksSuspect(solve) {
    const avg = bestAvg(this.app.solves || [], 12).value;
    if (!avg || !isFinite(avg)) return false;
    return solve.timeMs < avg * SUSPECT_RATIO;
  }

  async _retry(fn) {
    let last;
    for (let i = 0; i <= RETRY_MS.length; i++) {
      try { return await fn(); }
      catch (err) {
        last = err;
        if (i === RETRY_MS.length) break;
        await new Promise(res => setTimeout(res, RETRY_MS[i]));
      }
    }
    throw last;
  }

  /* ---------------- derived view, read by panels.js ---------------- */

  /** How many people have sent in a time today — never how fast any of them were. */
  submittedCount() {
    return Object.values(this.snap?.progress || {}).filter(p => p?.submitted).length;
  }

  /**
   * Everyone's result, ranked, once revealed — empty before that, same gate
   * as race.js's `revealed`/`ranked`.
   */
  ranked() {
    if (!this.revealed || !this.snap?.results) return [];
    return Object.entries(this.snap.results)
      .map(([uid, r]) => ({
        uid, result: r, e: eff(r),
        isMe: uid === this.snap.uid,
        clockOff: this._clockMismatch(uid, r),
      }))
      .sort((a, b) => a.e - b.e);
  }

  /**
   * Does the submitted time agree with the gap the server itself timed?
   * `progress` is public, so this can be computed for every row, not just
   * your own — same check as race.js's `_clockMismatch`.
   */
  _clockMismatch(uid, result) {
    const prog = this.snap?.progress?.[uid];
    if (!prog?.startedAt || !prog?.finishedAt) return false;
    const observed = prog.finishedAt - prog.startedAt;
    if (!(observed > 0)) return false;
    const slack = CLOCK_SLACK_MS + observed * CLOCK_SLACK_RATIO;
    return result.timeMs < observed - slack;
  }

  destroy() {
    clearTimeout(this._publishRetry);
    this._authUnsub?.();
    this.net?.destroy();
    this.net = null;
  }
}

/* =========================================================
   Singleton — same shape as race.js's getRace
   ========================================================= */
let instance = null;

export function getDaily(app) {
  if (!instance) {
    instance = new Daily(app);
    app.dailyCtl = instance;
  }
  return instance;
}

export { cloudAvailable } from './daily-net.js';
export { dayIdFromServerMs, nextResetMs, formatCountdown } from './daily-net.js';
