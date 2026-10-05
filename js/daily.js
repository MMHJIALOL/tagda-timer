import { t } from './i18n.js';
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
import { fmt } from './util.js';
import { eventOf, EVENT_ORDER, dailyEligible } from './events.js';
import { eff, bestAvg } from './stats.js';
import { generate } from './scramble.js';
import { onAuthChange } from './sync-auth.js';
import {
  DailyTransport, cloudAvailable,
  CLOCK_SLACK_MS, CLOCK_SLACK_RATIO,
  countSolvesForDay, rankByCount, dayStartMs, safePhotoUrl, cleanNote,
  markSotdDone, clearSotdDone, sotdDoneOn, misfireAction,
  CHAT_GAP_MS,
} from './daily-net.js';
import { SUSPECT_RATIO } from './raceapp.js';
import { getConfig } from './config.js';
import { banActive, banLine, banAccount } from './admins.js';

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

/** How long before asking again whether today is spent, when the last ask got no answer. */
const RECHECK_MS = 3000;

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

/**
 * How long to let the scramble listener report before publishing without it.
 *
 * Short, and bounded, because the wait is a courtesy rather than a guarantee:
 * the transaction in publishScramble is what actually makes the write
 * write-once. Four looks at 400ms is long enough for a listener that is
 * merely slow and short enough that a listener that is never coming does not
 * strand the window.
 */
const READ_WAIT_MS = 400;
const READ_WAIT_TRIES = 4;

/** A write that has not landed by now is not landing on this connection. */
const PUBLISH_TIMEOUT_MS = 15000;

/** How long a misfire waits on the backup claim before keeping the time instead. */
const CLAIM_TIMEOUT_MS = 8000;

/**
 * A 2–4.99 s solve of the main scramble whose "Keep / Use backup" question
 * has not been answered yet. Kept in the browser so that closing or reloading
 * the page on the question is answered Keep the next time the window opens,
 * rather than handing back a fresh attempt at a scramble already solved once.
 */
const HELD_KEY = 'tdt.sotd.held';

/**
 * Which local solve was each day's submitted attempt, by account, day and
 * event: the clip that Share replay offers (js/sotd-replays.js) is that
 * solve's. In the browser because the clip is; the newest few are kept.
 */
const ATTEMPTS_KEY = 'tdt.sotd.attempts';
const ATTEMPTS_KEPT = 30;

/** The day key this browser last swept old chat rooms on: once a day is plenty. */
const SWEPT_KEY = 'tdt.sotd.chatSwept';

/** How long after the window connects the sweep waits: it is housekeeping, and today's scramble comes first. */
const SWEEP_DELAY_MS = 5000;

const within = (p, ms, why) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(why)), ms)),
]);

/** An event only counts as a daily challenge if "one scramble, one time" describes it. */
export { dailyEligible };

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
    /** The hold line currently on screen, null while a real scramble is, or
     *  undefined before anything has been shown at all — see _changed(). */
    this._shownHold = undefined;
    /** Whether _checkOwnResult has answered at least once for this uid/day.
     *  Arming an attempt before this is true means arming it against
     *  whatever submittedToday happened to default to, not what the
     *  database actually says — see canAttempt(). */
    this._resultChecked = false;
    /** The account|day|event that `_resultChecked` is about, and the one being asked about right now. */
    this._resultKey = null;
    this._checking = null;
    /** How many times publishing has stood aside for a listener that has not reported. */
    this._readWaits = 0;
    this._readWait = 0;
    /** The count last written, so an unchanged total is not rewritten. */
    this._lastCount = -1;

    /** Whether today's attempt has moved to the backup scramble, and that scramble once fetched. */
    this.onBackup = false;
    this.backupScramble = null;
    this.backupError = null;
    this._backupTries = 0;
    this._backupRetry = 0;
    /** The claim is in flight; the timer stays shut until it lands or is refused. */
    this._switching = false;
    /** A misfire question is on screen — see holdMisfire. */
    this._held = false;

    /**
     * `{ at, final }` once an admin has taken this account's time off the
     * watched board, else null. Not final: the main attempt is gone and the
     * backup is next. Final: that was the backup, and the day is over.
     */
    this.removal = null;
    /** The removal already acted on, so the listener's echo of it is not a new one. */
    this._knownRemovalAt = 0;
    /** The backup claim after a removal was refused; and how many retries so far. */
    this._removalClaimError = null;
    this._removalTries = 0;
    this._claimRetry = 0;
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
      // Its own event, so a message arriving redraws the chat and not the board.
      net.addEventListener('chat', () => this.dispatchEvent(new CustomEvent('chat')));
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
    this._resultChecked = false;
    this._resetPublishState();
    this._resetBackup();
    this.net?.watch(eventId);
    this._checkOwnResult();
    this._changed();
  }

  _onDay(snap) {
    const rolled = this.snap && snap.dayId && this.snap.dayId !== snap.dayId;
    if (rolled) this._resetPublishState();
    this.snap = snap;
    /* Banned while an attempt is armed but not started: take it back, since
       the rules would refuse the time. One already under way finishes. */
    if (this.banned && this.attempting && !this._lastStatus) this.attempting = false;
    // A board that reset under you starts your count again from the solves
    // that belong to the new day, rather than carrying yesterday's total.
    if (rolled) this.pushCount();
    /* First, because it resets synchronously when the account, day or event
       has changed — arming below on the previous key's answer would hand out
       an attempt the new key has not been checked for. */
    this._checkOwnResult();
    this._maybeRemoved();
    /* Arm as soon as there is something to arm ON, rather than only at the
       moment the window opened. Today's scramble usually arrives a beat after
       that — it may still be being generated and written by whoever got there
       first — and checking once on the way in meant the common case was a
       window that never armed at all: the generator kept supplying ordinary
       practice scrambles, every solve was an ordinary solve, nothing was ever
       submitted, and so the board never unlocked either. */
    if (this.engaged) this._armIfPossible();
    this._maybePublishScramble();
    this._maybeSweepChats();
    this._changed();
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
    /* Prefer not to publish before the scramble node has reported.
       `snap.scramble === null` does not mean "nobody has published today's" —
       it is equally what a listener that has not delivered its first value
       yet looks like, and watch() emits once before that happens. Publishing
       on that emit is the bug that made the day's scramble change on every
       refresh: each load raced its own read, and whoever beat it generated
       and wrote a fresh scramble, which everybody then saw.

       A PREFERENCE, with a deadline, and never a dead end. The first version
       of this was a bare `return`, which was worse than the bug it fixed: a
       listener that never reports — and there is no promise that it must —
       left the window sitting on "Publishing today's scramble…" forever with
       no attempt made, no retry scheduled and nothing anywhere saying why.
       That is exactly the silent hang _scheduleRepublish exists to kill, and
       it had been reintroduced one line above it.

       Waiting is only an optimisation now, because publishScramble is a
       transaction: it cannot overwrite an existing scramble whatever this
       decides. So a node that will not report is waited on briefly, out of
       courtesy, and then published to anyway. */
    if (!this.snap.scrambleLoaded && this._readWaits < READ_WAIT_TRIES) {
      this._readWaits++;
      clearTimeout(this._readWait);
      this._readWait = setTimeout(() => this._maybePublishScramble(), READ_WAIT_MS);
      this._changed();
      return;
    }

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
      /* Raced, for the same reason the generator above is. A database write
         with nowhere to go does not fail — it waits for a connection, which
         may never come, and `_publishing` stays true behind it so nothing
         retries and nothing gives up. An attempt that never ends is worse
         than one that fails, because only a failure is ever reported. */
      const out = await Promise.race([
        this.net.publishScramble(s.scramble),
        new Promise((_, rej) => setTimeout(() => rej(new Error('publish-timeout')), PUBLISH_TIMEOUT_MS)),
      ]);
      this.publishError = out?.ok ? null : (out?.reason || 'refused');
      if (this.publishError) console.warn('[daily] scramble publish refused:', this.publishError);
    } catch (err) {
      this.publishError = err?.code || String(err?.message || err);
      console.warn('[daily] scramble publish failed', err);
    } finally {
      this._publishing = false;
      this._scheduleRepublish();
      this._changed();
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
    clearTimeout(this._readWait);
    this._publishRetry = 0;
    this._readWait = 0;
    this._publishTries = 0;
    this._readWaits = 0;
    this.publishError = null;
  }

  /** Whose result, on which day, for which event — null until all three are known. */
  _ownKey() {
    const s = this.snap;
    return s?.uid && s.dayId && s.event ? `${s.uid}|${s.dayId}|${s.event}` : null;
  }

  async _checkOwnResult() {
    const key = this._ownKey();
    /* A different account, day or event: everything known so far was about
       something else. Reset before the first await, so a caller's very next
       line cannot arm an attempt on the previous key's answer. */
    if (key !== this._resultKey) {
      this._resultKey = key;
      this._resultChecked = false;
      this.submittedToday = false;
      this.attempting = false;
      this._resetBackup();
    }
    /* Once per key, not once per snapshot. Every snapshot lands here —
       anybody's progress, the clock offset, the results listener — and each
       one used to be another read of the same row. */
    if (!key || !this.net || this._resultChecked || this._checking === key) return;
    this._checking = key;
    // Asked alongside, not after: one round trip, not two, before anything is armed.
    const asking = this.net.removal?.();
    const has = await this.net.hasOwnResult();
    const removal = asking ? await asking : false;
    /* A backup claimed before a reload is still claimed, and the attempt is
       on the backup — asked before anything is armed, or the main scramble
       would come back for a moment first. */
    const claimed = has === false && this.net.hasBackupClaim ? await this.net.hasBackupClaim() : false;
    if (this._checking === key) this._checking = null;
    /* `null` is "could not ask", which is not "no". The first snapshot arrives
       before watch() has chosen a day or an event, and that "no" used to be
       trusted: today's scramble landed a beat later, the window armed on it
       and drew it, and then the real answer swapped it for "come back after
       the reset". Left unchecked and asked again shortly, because a quiet day
       may bring no further snapshot to ask on. */
    if (this._ownKey() !== key) return;
    if (has === null || claimed === null || removal === null) {
      clearTimeout(this._recheck);
      this._recheck = setTimeout(() => this._checkOwnResult(), RECHECK_MS);
      return;
    }
    /* Taken off the board by an admin. Read with the rest, so a reload lands
       on the backup (or on "nothing left today") instead of the main scramble
       a second time, and the listener's copy of the same record is not news. */
    this.removal = removal || null;
    this._knownRemovalAt = Math.max(this._knownRemovalAt, removal?.at || 0);
    const spent = !has && !!removal?.final;
    if (has || claimed || removal) this._dropHeld();
    if (claimed && !this.onBackup) {
      this.onBackup = true;
      this._loadBackup();
    }
    this.submittedToday = has;
    this._resultChecked = true;
    if (has) {
      this.net.unlockResults();
      this.attempting = false;
      markSotdDone(this.snap.dayId);
    } else if (spent) {
      // Both attempts are used up: there is nothing to arm until the reset.
      this.attempting = false;
      markSotdDone(this.snap.dayId);
    } else if (removal && !claimed) {
      /* The main attempt was taken off the board, so the backup is next.
         Claimed here, by this account, exactly as a misfire would be: the
         rules want the claim before the backup can be read or a result taken. */
      if (sotdDoneOn(this.snap.dayId)) clearSotdDone();
      this._claimAfterRemoval(key);
    } else {
      if (sotdDoneOn(this.snap.dayId)) {
        /* The note says today is spent and the database says it is not, so the
           note is wrong and this is the only place that can ever find out: it
           belongs to the browser, not to the account, so it survives a sign-out
           and is inherited by whoever signs in next. The database is the one
           that knows, and it has just answered. */
        clearSotdDone();
      }
      /* Armed here as well as in _onDay. When this answer is the last thing to
         arrive — the ordinary case on a quiet day — no further snapshot comes
         along to arm it, and the window sat on its placeholder with today's
         scramble already in hand. */
      if (this.engaged) this._armIfPossible();
    }
    this._changed();
    // A removal that landed while this was asking has not been acted on yet.
    this._maybeRemoved();
  }

  /**
   * An admin has just taken this account's time off the board, seen live by
   * the `removed/<uid>` listener. The board and the chat are already shut by
   * the rules; this shuts them here too and asks again from the top, which
   * puts the backup up (or says there is nothing left today).
   */
  _maybeRemoved() {
    const r = this.snap?.removed;
    if (!r?.at || !this._resultChecked || r.at <= this._knownRemovalAt) return;
    this._knownRemovalAt = r.at;
    this.net.relock?.();
    this.submittedToday = false;
    this.attempting = false;
    this._resultChecked = false;
    toast(r.final
      ? t('An admin removed your Scramble of the Day time. It was your backup, so that’s it for today.')
      : t('An admin removed your Scramble of the Day time. You get the backup scramble — final attempt.'),
    { kind: 'bad', hold: true });
    this.dispatchEvent(new CustomEvent('removed', { detail: { at: this.net.target?.(), final: !!r.final } }));
    this._checkOwnResult();
    this._changed();
  }

  /** Claim the backup for an account whose main time was removed; tried again a few times if refused. */
  async _claimAfterRemoval(key) {
    if (this.onBackup || this._switching) return;
    this._removalClaimError = null;
    const ok = await this.switchToBackup();
    if (this._ownKey() !== key) return;
    if (ok) {
      this._removalTries = 0;
      if (this.engaged) this._armIfPossible();
      this._changed();
      return;
    }
    this._removalClaimError = 'claim-refused';
    if (this._removalTries < PUBLISH_BACKOFF_MS.length) {
      clearTimeout(this._claimRetry);
      this._claimRetry = setTimeout(() => {
        if (this._ownKey() === key && !this.onBackup) this._claimAfterRemoval(key);
      }, PUBLISH_BACKOFF_MS[this._removalTries++]);
    }
    this._changed();
  }

  /**
   * Resolves once the database has said whether today is already spent for
   * this account and event, or after `ms`, whichever comes first.
   *
   * For the window's intro: the localStorage note is only written when a
   * result lands in THIS browser, so on a fresh one it says nothing and the
   * title card played for somebody who had already submitted. Signed out there
   * is no answer coming, so there is nothing to wait for.
   */
  ownResultKnown(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.removeEventListener('change', on); resolve(); };
      const on = () => { if (this._resultChecked || !this.snap?.signedIn) done(); };
      const timer = setTimeout(done, ms);
      this.addEventListener('change', on);
      on();
    });
  }

  /* ---------------- attempting today's scramble ---------------- */

  canAttempt() {
    /* `submittedToday` defaults to false and only becomes trustworthy once
       _checkOwnResult has actually answered for this uid/day — arming an
       attempt on the default, before that answer is back, meant every fresh
       connect (a page load, a reopen of the window) briefly believed nobody
       had submitted yet and handed out a fresh crack at today's scramble
       even when the account had already spent it. */
    return !!(this.snap?.signedIn && this.snap.scramble && this._resultChecked
      && !this.submittedToday && !this.attempting && !this.banned
      // Removed by an admin: the backup or nothing, never the main scramble again.
      && (!this.removal || (!this.removal.final && this.onBackup)));
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
    this._changed();
  }

  /* ---------------- being in the window ---------------- */

  /** Enter the window: from here until disengage(), the timer is the day's. */
  engage() {
    if (this.engaged) return;
    /* The window solves in the timer's event: the solve underneath it is
       recorded against app.settings.event, in that event's session. This
       controller is a singleton that took its event once, when it was built,
       so after doing 4x4's scramble of the day and going back to 3x3 the
       window opened on 4x4 again — a 4x4 scramble on a 3x3 timer — until a
       reload. setEvent ignores an event the daily challenge does not run. */
    this.setEvent(this.app.settings.event);
    this.engaged = true;
    // Still armed from before leaving (a misfire answered on the way out):
    // attempt() will not run, so nothing else puts today's scramble back.
    const wasArmed = this.attempting;
    this._armIfPossible();
    // Even when there is nothing to arm yet, the scramble on screen has to
    // stop being an ordinary one immediately — see takeScramble's hold.
    if (!this.attempting || wasArmed) this.app.nextScramble?.();
    this._changed();
  }

  /** Leave the window. An attempt that was never solved is spent on nothing. */
  disengage() {
    if (!this.engaged) return;
    this.engaged = false;
    /* Except one already solved and waiting on the misfire question: leaving
       answers it Keep (main.js dismisses it on the way out), and that answer
       still has to be able to submit. */
    if (!this._held) this.attempting = false;
    this.app.nextScramble?.();
    this._changed();
  }

  _armIfPossible() {
    if (this.attempting || !this.canAttempt()) return;
    /* The page closed on a misfire question. It is answered Keep here, on the
       way back in, instead of arming the main scramble for a second go. */
    const held = !this.onBackup && this._heldNote();
    if (held && this.app.recordSolve) {
      this.attempting = true;
      this.releaseMisfire();
      toast(t('Kept your {time} — the page closed before you answered the misfire question', { time: fmt(held.timeMs) }), { hold: true });
      this.app.recordSolve({
        timeMs: held.timeMs, penalty: held.penalty, inspectionMs: held.inspectionMs, scramble: held.scramble,
      }).catch(err => console.warn('[daily] could not keep the held solve', err));
      return;
    }
    this.attempt();
  }

  /* ---------------- misfires and the backup scramble ---------------- */

  /** The scramble today's attempt is on: the main one, or the backup once it has been claimed. */
  currentScramble() {
    return this.onBackup ? this.backupScramble : (this.snap?.scramble || null);
  }

  /**
   * What main.js should do with a solve that just stopped, or null when it
   * was not today's attempt and this feature has no say. A solve of the
   * backup is always submitted — there is nothing left to fall back to — but
   * one short enough to be thrown away on the main scramble goes in as a DNF,
   * not as a time: submitted as-is, a 1.5 s misfire on the backup was the
   * best time on the board.
   */
  misfireCheck(timeMs) {
    if (!this.engaged || !this.attempting) return null;
    const act = misfireAction(timeMs, this.eventId);
    if (!this.onBackup) return act;
    return act === 'discard' ? 'dnf' : 'keep';
  }

  /** A misfire question is going up: note the solve, so leaving the page cannot un-ask it. */
  holdMisfire(res) {
    this._held = true;
    const held = {
      key: this._ownKey(), scramble: this.snap?.scramble || '',
      timeMs: res.timeMs, penalty: res.penalty || 'none', inspectionMs: res.inspectionMs || 0,
    };
    try { localStorage.setItem(HELD_KEY, JSON.stringify(held)); } catch { /* private mode */ }
    return held;
  }

  /** The question is answered, either way. */
  releaseMisfire() {
    this._held = false;
    this._dropHeld();
  }

  _dropHeld() {
    try { localStorage.removeItem(HELD_KEY); } catch { /* private mode */ }
  }

  _heldNote() {
    try {
      const held = JSON.parse(localStorage.getItem(HELD_KEY));
      return held?.key && held.key === this._ownKey() ? held : null;
    } catch { return null; }
  }

  /**
   * Spend the main attempt on the backup scramble.
   *
   * The claim is written first and is the point of no return: the backup
   * cannot even be read until it lands, and once it has, the rules only
   * take a result marked `backup`. Refused means the rules that allow it are
   * not published yet; the caller decides what happens to the solve then
   * (main.js: thrown away under 2 s, kept otherwise).
   */
  async switchToBackup() {
    if (!this.net || this.onBackup) return false;
    const at = this.net.target?.();
    this._switching = true;
    this._changed();
    try {
      await within(this.net.claimBackup(at), CLAIM_TIMEOUT_MS, 'claim-timeout');
    } catch (err) {
      this._switching = false;
      console.warn('[daily] backup claim refused', err);
      this._changed();
      return false;
    }
    this.releaseMisfire();
    this._switching = false;
    this.onBackup = true;
    this._lastStatus = null;
    // Left the window while the claim was in flight: re-entering arms the backup.
    if (!this.engaged) this.attempting = false;
    /* The rules' clock check measures the result against startedAt and
       finishedAt, which still bracket the solve just thrown away. The backup
       solve stamps its own when it starts and stops. */
    this.net.setProgress({ status: 'inspecting', startedAt: null, finishedAt: null, submitted: null }, at)
      .catch(err => console.warn('[daily] progress reset refused', err));
    this._loadBackup(at);
    this._changed();
    return true;
  }

  async _loadBackup(at = this.net?.target?.()) {
    clearTimeout(this._backupRetry);
    const key = this._ownKey();
    const make = () => within(generate(at.event, 'wca'), GENERATE_TIMEOUT_MS, 'generator-timeout').then(s => s.scramble);
    try {
      const s = await this.net.backupScramble(make, at);
      if (!s) throw new Error('empty-after-write');
      if (this._ownKey() !== key || !this.onBackup) return;
      this.backupScramble = s;
      this.backupError = null;
    } catch (err) {
      if (this._ownKey() !== key || !this.onBackup) return;
      this.backupError = err?.code || String(err?.message || err);
      console.warn('[daily] backup scramble failed', err);
      if (this._backupTries < PUBLISH_BACKOFF_MS.length) {
        this._backupRetry = setTimeout(() => this._loadBackup(at), PUBLISH_BACKOFF_MS[this._backupTries++]);
      }
    }
    this._changed();
  }

  /** A new day, event or account starts with the main scramble again. */
  _resetBackup() {
    clearTimeout(this._backupRetry);
    this._backupRetry = 0;
    this._backupTries = 0;
    this.onBackup = false;
    this.backupScramble = null;
    this.backupError = null;
    this._switching = false;
    // A removal belongs to one account, day and event too.
    clearTimeout(this._claimRetry);
    this.removal = null;
    this._knownRemovalAt = 0;
    this._removalClaimError = null;
    this._removalTries = 0;
  }

  cancelAttempt() {
    if (!this.attempting) return;
    this.attempting = false;
    this.app.nextScramble?.();
    this._changed();
  }

  /** Which of the window's states this is, for the UI to say so out loud. */
  status() {
    if (!this.snap?.signedIn) return 'signed-out';
    if (this.submittedToday) return 'done';
    if (this.removal?.final && this._resultChecked) return 'removed';
    if (!this.snap.scramble) return 'waiting';
    if (this.onBackup) return 'backup';
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
    const scramble = this.attempting && this.snap?.scramble ? this.currentScramble() : null;
    if (!scramble) {
      const hold = this.holdText();
      this._shownHold = hold;
      return { scramble: '', hold, official: true, daily: true };
    }
    this._shownHold = null;
    return { scramble, official: true, daily: true };
  }

  /**
   * Announce a state change — and repaint the line standing in for the
   * scramble if it has stopped being true.
   *
   * The window draws that line from takeScramble(), and takeScramble() only
   * runs when the app is asked for a new scramble. So the message was a
   * SNAPSHOT: whatever holdText() happened to say at the moment the window
   * opened stayed on screen for the rest of the session, however far the
   * state moved on underneath it. A window that had gone on to fail, retry
   * and give up still read "Reading today's board…", which is indeed what it
   * had been doing, about a second and a half earlier.
   *
   * Comparing the text rather than tracking what changed keeps this honest
   * for every future message too, and costs a string compare on an event
   * that fires a handful of times a minute.
   */
  _changed() {
    if (this.engaged) {
      /* null when a real scramble belongs on screen: the backup arriving
         after "Fetching your backup scramble…" is the case that needs it. */
      const now = this.attempting && this.snap?.scramble && this.currentScramble() ? null : this.holdText();
      /* `undefined` means nothing has been shown yet, and there is nothing to
         repaint over. `null` means a real scramble is on screen right now —
         checking it against `null` here, the same as against any other stale
         hold, is what corrects a scramble that should never have been shown
         (e.g. an attempt armed on a submittedToday that had not been checked
         yet) back to the message that belongs there, the moment the truer
         answer comes in. */
      if (this._shownHold !== undefined && this._shownHold !== now) this.app.nextScramble?.();
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  /** The line that stands in for the scramble when there is nothing to solve. */
  holdText() {
    if (!this.snap?.signedIn) return t('Sign in to be given today’s scramble');
    if (this.submittedToday) return t('You have already done today’s scramble — come back after the reset');
    // Banned (bans/, ADMIN.md): the rules would refuse the time, so it is not offered.
    if (this.banned) return banLine(this.snap.ban);
    if (this.snap.readError) {
      return t('Today’s board cannot be read on this deployment — see DAILY.md, firebase.rules.json probably needs republishing.');
    }
    /* Three different things used to share one message. "…" implies something
       is still in flight, which was a lie in two of these cases: an attempt
       that had failed and would never be retried, and an attempt that could
       never succeed. Only the first line below is allowed to say "…". */
    if (!this.snap.scramble) {
      if (this.gaveUpPublishing()) {
        return t('Today’s scramble could not be published after several tries')
             + (this.publishError ? ` (${this.publishError})` : '')
             + t(' — reload, or see DAILY.md if this keeps happening.');
      }
      /* An attempt has already failed and another is queued. Saying only
         "Publishing…" here hid the reason for the best part of a minute —
         four tries with a twenty-second generator timeout behind each — and
         a wait with no explanation is indistinguishable from a hang. The
         reason is known the moment the first attempt fails, so it is said
         then rather than kept back until the last one. */
      if (this.publishError) {
        return t('Still trying to publish today’s scramble ({err})…', { err: this.publishError });
      }
      /* Only while the courtesy wait is actually running: once an attempt has
         been made, "reading" is no longer what is happening. */
      if (!this.snap.scrambleLoaded && !this._publishTries && this._readWaits) {
        return t('Reading today’s board…');
      }
      return t('Publishing today’s scramble…');
    }
    if (this.removal?.final && this._resultChecked) {
      return t('An admin removed your time, and it was your backup — come back after the reset');
    }
    if (this.removal && !this.onBackup) {
      return this._removalClaimError
        ? t('Your time was removed, and the backup scramble could not be claimed — reload to try again.')
        : t('Your time was removed — getting your backup scramble…');
    }
    if (this.onBackup) {
      if (!this.backupError) return t('Fetching your backup scramble…');
      return this._backupTries < PUBLISH_BACKOFF_MS.length
        ? t('Still fetching your backup scramble ({err})…', { err: this.backupError })
        : t('Your backup scramble could not be fetched ({err}) — reload to try again.', { err: this.backupError });
    }
    // Today's scramble is here; whether you may still attempt it is not known yet.
    if (!this._resultChecked) return t('Checking whether today’s attempt is already in…');
    return t('Nothing to solve right now');
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
    if (this.banned) return true;
    if (!this.snap.scramble) return true;
    /* The misfire question is up, the backup is being claimed, or it is still
       on its way: nothing to solve yet. Shut during the question in particular,
       or a press of space answered it Keep AND started a stray solve on the
       "already done" line that replaced the scramble. */
    if (this._held || this._switching || (this.onBackup && !this.backupScramble)) return true;
    if (this.removal && (this.removal.final || !this.onBackup)) return true;
    return this.submittedToday;
  }

  onTimerState(state) {
    if (!this.attempting) return;
    const map = { inspecting: 'inspecting', holding: 'inspecting', ready: 'inspecting', running: 'solving' };
    // Leaving `running` any other way is the stop, which stamps finishedAt.
    const status = map[state] || (this._lastStatus === 'solving' ? 'stopped' : null);
    if (!status || status === this._lastStatus) return;
    this._lastStatus = status;
    this.net.setProgress({ status }).catch(() => {});
  }

  /** A finished solve of today's scramble becomes this event's result. */
  async onSolveRecorded(solve) {
    const scramble = this.currentScramble();
    if (!this.attempting || !this.snap?.scramble || !scramble) return;
    // Only a solve of TODAY's scramble counts — guards the small window where
    // the event or the day could have moved on mid-attempt.
    if (String(solve.scramble || '').trim() !== String(scramble).trim()) return;

    /* Where this solve belongs, pinned before the first await: the progress
       write and its retries leave room for the board to move to another event
       or day, and the result must still land on the one it was solved in. */
    const at = this.net.target?.();
    const { dayId } = this.snap;
    const backup = this.onBackup;
    this.attempting = false;
    this.submittedToday = true;
    this._lastStatus = null;
    this._changed();

    /* Best effort, and never a gate on the result. It used to be awaited bare,
       so a refused progress write threw straight past the submit and the time
       was lost while the window already read "attempt submitted". The rules'
       clock check is skipped when `finishedAt` is missing, so the result is
       still accepted without it. */
    try { await this._retry(() => this.net.setProgress({ status: 'done', submitted: true }, at)); }
    catch (err) { console.warn('[daily] progress refused', err); }

    const result = {
      timeMs: Math.round(solve.timeMs),
      penalty: solve.penalty || 'none',
      name: this._name(),
      suspect: this._looksSuspect(solve) || null,
    };
    /* Then once more without the avatar, and for a backup solve once more
       without the `backup` mark.

       `results` rejects any field it does not know about ("$other": false),
       so a deployment still running the rules from before avatars existed
       refuses the WHOLE write because of one cosmetic field — and the time
       you just did is lost to a picture. Dropping it and trying again turns
       a rules version skew into a missing face instead of a missing result,
       which is the right way round: the face is decoration, the time is the
       entire point. The backup mark is the same story one rules version on. */
    const tries = backup
      ? [{ ...result, backup: true, photo: this._photo() }, { ...result, backup: true }, result]
      : [{ ...result, photo: this._photo() }, result];
    let landed = false;
    for (const r of tries) {
      try { await this._retry(() => this.net.submitResult(r, at)); landed = true; break; }
      catch (err) { console.warn('[daily] result refused', err); }
    }
    if (!landed) toast('Today’s board would not accept that time', { kind: 'bad', hold: true });
    /* Only a result that landed retires the day. The note used to be written
       before the submit, so a time the board never took still skipped the
       intro and dimmed the chip as though today were done. */
    if (!landed) return;
    markSotdDone(dayId);
    this._noteAttempt(at, solve.id);
    this.net.unlockResults();
    this._changed();
    // sotd-replays.js: "Always share my SOTD replay" starts from here.
    this.dispatchEvent(new CustomEvent('submitted', { detail: { solve, at } }));
  }

  _noteAttempt(at, solveId) {
    if (!at?.dayKey || !at.event || !at.uid) return;
    try {
      const all = JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || '{}');
      delete all[`${at.dayKey}|${at.event}|${at.uid}`];
      all[`${at.dayKey}|${at.event}|${at.uid}`] = solveId;
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - ATTEMPTS_KEPT))) delete all[k];
      localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(all));
    } catch { /* private mode: the Share button just will not find the clip after a reload */ }
  }

  /** The local solve that was this account's attempt at the watched board, or null. */
  attemptSolveId() {
    const at = this.net?.target?.();
    if (!at?.dayKey || !at.event || !at.uid) return null;
    try { return JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || '{}')[`${at.dayKey}|${at.event}|${at.uid}`] || null; }
    catch { return null; }
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
    this._resetBackup();    // yesterday's backup was yesterday's
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

  /** Whatever note is on your own row today, or '' if there is none. */
  get myNote() {
    return this.snap?.results?.[this.snap?.uid]?.note || '';
  }

  /**
   * Say one line about your solve, on your own row.
   *
   * Only after submitting: the note lives ON the result, so there is nothing
   * to attach it to until the time is in — and the board you are talking to
   * is not readable before then either.
   *
   * Written straight through and painted from the listener's echo, except
   * for the local copy set here so the composer does not appear to lose what
   * you typed during the round trip.
   */
  async setNote(text) {
    if (!this.net || !this.submittedToday) return;
    if (this.banned) { toast(banLine(this.snap.ban), { kind: 'bad', long: true }); return false; }
    const body = cleanNote(text);
    try {
      await this._retry(() => this.net.setNote(body));
      const mine = this.snap?.results?.[this.snap?.uid];
      if (mine) mine.note = body;
      this._changed();
      return true;
    } catch (err) {
      console.warn('[daily] note refused', err);
      toast(String(err?.code || err).includes('PERMISSION_DENIED')
        ? t('The board would not take that note — this database is running rules from before notes existed. Publish firebase.rules.json.')
        : t('Could not save that note'), { kind: 'bad', long: true });
      return false;
    }
  }

  /* ---------------- the day's chat ---------------- */

  /** The watched room as the transport last saw it: { state, messages }. */
  get chat() {
    return this.net?.chat || { key: null, state: 'locked', messages: [] };
  }

  /** Whether the chat is open to this viewer: their time is in, and the room answered. */
  get chatOpen() {
    return this.revealed && ['loading', 'live'].includes(this.chat.state);
  }

  /** Whether an admin has banned this account (bans/<uid>), as of the server's clock. */
  get banned() {
    return banActive(this.snap?.ban, this.net?.serverNow?.() ?? Date.now());
  }

  /**
   * Why this account cannot post in the open room right now, or null if it
   * can: banned, or the chat switched off from the admin console. The rules
   * refuse the message either way; this is so the box says why first.
   */
  get chatBlocked() {
    if (this.banned) return banLine(this.snap.ban);
    if (!getConfig('sotdChat', 'enabled')) return getConfig('sotdChat', 'message') || t('The chat is switched off for now');
    return null;
  }

  /** Least time between two of this account's messages, in this client: the rule's gap and a little more. */
  get chatGapMs() {
    return Math.max(CHAT_GAP_MS, getConfig('sotdChat', 'gapMs') + 500);
  }

  /**
   * An admin bans somebody from the boards, the chats and replays (bans/,
   * ADMIN.md), with a reason they will be shown. Throws when the rules refuse.
   */
  async banUser({ uid, name, reason }) {
    if (!this.admin || !this.net?._sdk || !uid) throw new Error('not-admin');
    await banAccount(this.net._sdk, { uid, name, reason });
  }

  /** Whether this account may delete other people's messages and times (admins/; the rules have the final say). */
  get admin() {
    return !!this.snap?.uid && this.snap.admin === true;
  }

  /**
   * Take a time off a board: today's, or a past day's from the picker. The
   * person gets the backup scramble as a final attempt, unless that time was
   * already on the backup, in which case they are done for the day. Their own
   * app finds out from `removed/<uid>` (see _maybeRemoved). Throws when the
   * rules refuse, which until firebase.rules.json is published is always.
   */
  async removeResult(row, dayKey = this.net?.target?.().dayKey, eventId = this.eventId) {
    if (!this.admin || !this.net || !row?.uid || !dayKey) throw new Error('not-admin');
    await this.net.removeResult({ dayKey, event: eventId, uid: row.uid, final: row.result?.backup === true });
  }

  /**
   * Say something in today's room for the watched event.
   *
   * 'slow' when it comes too soon after the last one: dropped, not queued —
   * the only way to get here is holding Enter down, and sending those presses
   * a moment later is not what anybody holding Enter wanted. Throws when the
   * server refuses, so the composer can put the text back.
   */
  async sendChat(text) {
    if (!this.net || !this.chatOpen || this.chatBlocked) return 'closed';
    const now = Date.now();
    if (now - (this._chatSentAt || 0) < this.chatGapMs) return 'slow';
    this._chatSentAt = now;
    try {
      await this.net.sendChat(text, { name: this._name(), photo: this._photo() });
      return 'sent';
    } catch (err) {
      // A refused message does not count against the gap.
      this._chatSentAt = 0;
      throw err;
    }
  }

  async deleteChat(id) {
    await this.net?.deleteChat(id);
  }

  /** Report somebody's message to the admins: 'sent', 'already', or null when banned (said so). */
  async reportChat(m) {
    if (this.banned) { toast(banLine(this.snap.ban), { kind: 'bad', long: true }); return null; }
    return this.net?.reportChat(m);
  }

  /** Report somebody's shared replay on `dayKey`'s board for `event`. */
  async reportReplay(at) {
    if (this.banned) { toast(banLine(this.snap.ban), { kind: 'bad', long: true }); return null; }
    return this.net?.reportReplay(at);
  }

  /**
   * Clear the stored rooms of the last few days, once a day per browser.
   *
   * Anybody signed in may (the rules allow it for every day but today), so
   * it is whoever opens the window first after a reset. Nothing on screen
   * depends on it: yesterday's room vanished from every screen at 00:00 IST
   * because the window reads today's path, not because this ran.
   */
  _maybeSweepChats() {
    const key = this.net?.target?.().dayKey;
    if (!key || !this.snap?.signedIn || this._sweptKey === key) return;
    this._sweptKey = key;
    try { if (localStorage.getItem(SWEPT_KEY) === key) return; } catch { /* private mode: sweep anyway */ }
    clearTimeout(this._sweepTimer);
    this._sweepTimer = setTimeout(() => {
      if (this.net?.target?.().dayKey !== key) return;
      this.net.sweepOldChats(EVENT_ORDER.filter(dailyEligible)).then(() => {
        // Marked whatever the answer: rules that refuse it today refuse it
        // on every reload today too, and tomorrow's sweep reaches back a week.
        try { localStorage.setItem(SWEPT_KEY, key); } catch { /* private mode */ }
      });
    }, SWEEP_DELAY_MS);
  }

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
    return this._rank(this.snap.results, this.snap.progress);
  }

  /**
   * A day's results in board order. Shared by today's live `ranked()` and by
   * the past-day lookup below, so a row of history is ordered and flagged by
   * exactly the same rules today's is — the two cannot drift, because there
   * is only one of them.
   */
  _rank(results, progress) {
    return Object.entries(results || {})
      .map(([uid, r]) => ({
        uid, result: r, e: eff(r),
        isMe: uid === this.snap?.uid,
        clockOff: this._clockMismatch(r, progress?.[uid]),
      }))
      .sort((a, b) => a.e - b.e);
  }

  /**
   * One past day's board, fetched once.
   *
   * The reveal gate is unchanged and deliberately so: the rules let you read
   * a day's `results` only if you have a row in it, for every day and not
   * just today, so a day you sat out comes back `denied` and stays that way.
   * That is the same bargain today's board offers, applied to history.
   *
   * Returns `{ dayId, eventId, rows, denied, scramble }` — never throws for
   * the locked case, because "you did not play that day" is an answer the
   * panel has to draw rather than an error it has to report.
   */
  async pastBoard(dayId, eventId = this.eventId) {
    if (!this.net) await this.connect();
    const out = await this.net.readDay(String(dayStartMs(dayId)), eventId);
    return {
      dayId, eventId, scramble: out.scramble, denied: out.denied,
      rows: out.denied ? [] : this._rank(out.results, out.progress),
    };
  }

  /**
   * Does the submitted time agree with the gap the server itself timed?
   * `progress` is public, so this can be computed for every row, not just
   * your own — same check as race.js's `_clockMismatch`.
   */
  _clockMismatch(result, prog) {
    if (!prog?.startedAt || !prog?.finishedAt) return false;
    const observed = prog.finishedAt - prog.startedAt;
    if (!(observed > 0)) return false;
    const slack = CLOCK_SLACK_MS + observed * CLOCK_SLACK_RATIO;
    return result.timeMs < observed - slack;
  }

  destroy() {
    clearTimeout(this._sweepTimer);
    clearTimeout(this._publishRetry);
    clearTimeout(this._recheck);
    clearTimeout(this._backupRetry);
    clearTimeout(this._claimRetry);
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
export { dayIdFromServerMs, nextResetMs, formatCountdown, shiftDayId } from './daily-net.js';
export { misfireAction, AUTO_DISCARD_MS, ASK_MS } from './daily-net.js';
