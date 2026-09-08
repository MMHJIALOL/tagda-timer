/* ===========================================================
   Tagda Timer — daily leaderboard transport

   Every day, every signed-in visitor gets the exact same scramble for a
   given WCA event and one official attempt at it. The whole feature rests
   on one guarantee: the day boundary is the SAME INSTANT for everybody,
   computed from a clock nobody's device can move.

   ---------------------------------------------------------
   Why a fixed IST instant, not "midnight where you are"
   ---------------------------------------------------------

   A per-timezone reset would need a different scramble per timezone, which
   breaks "everyone solves the same scramble" outright. One global instant
   (00:00 IST, i.e. 18:30 UTC the day before) keeps the promise and needs no
   timezone table at all — see dayIdFromServerMs below.

   ---------------------------------------------------------
   Why a server clock, not the client's Date.now()
   ---------------------------------------------------------

   `.info/serverTimeOffset` is a synthetic Realtime Database node with no
   rules to satisfy — the same trick race-net.js uses for `.info/connected`
   — that streams "server time minus this client's clock" continuously.
   `serverNow()` below is Date.now() plus that offset, so the day id a
   client computes cannot be pushed a day forward or back by winding a
   device clock, which is exactly the attack a client-only Date.now() would
   open up (fetch tomorrow's scramble early, or resubmit into a fresh day
   bucket after already using today's attempt).

   ---------------------------------------------------------
   Who publishes the scramble, since there is no server
   ---------------------------------------------------------

   Same answer as a race room's `rounds/<n>/info`: whichever client opens
   the panel first and finds no scramble for today generates one and writes
   it write-once. Ties are broken by the rules, not by coordination — the
   first write wins and every other client just reads it back.

   ---------------------------------------------------------
   Whose identity a result carries
   ---------------------------------------------------------

   Race mode's anonymous, per-tab identity is deliberately throwaway. A
   leaderboard needs the opposite: a name that survives a reload and shows
   up the same way on another device. That is exactly what the cloud-sync
   Google account (js/sync-auth.js, the separately-named "tagda-sync" app)
   already provides, so this file rides on it rather than standing up a
   third auth identity. Signed-out visitors can still read the board —
   `scramble` and `progress` are public — they just cannot write to it,
   which is enforced by the rules (`auth != null`), not by this file.
   =========================================================== */

import { getDatabaseHandle } from './sync-auth.js';
import { CLOCK_SLACK_MS, CLOCK_SLACK_RATIO } from './raceapp.js';

export { CLOCK_SLACK_MS, CLOCK_SLACK_RATIO };

/* The pure day/time/count math lives in dayid.js — see the header there for
   why it is a separate file. Re-exported so every existing importer of this
   module, test.html included, is unaffected by the split. */
export * from './dayid.js';
// Re-exporting does not put a name in this module's own scope, and the
// transport below calls all three of these directly.
import { dayIdFromServerMs, nextResetMs, dayKeyFromServerMs } from './dayid.js';

/* ---------------------------------------------------------
   Transport
   --------------------------------------------------------- */

/** Snapshot handed to the UI. Always this shape, even before anything loads. */
const emptySnapshot = (event) => ({
  event, dayId: null, uid: null, signedIn: false, displayName: null, photoURL: null,
  scramble: null, progress: {}, results: {}, resultsUnlocked: false, readError: null,
  /* The solve-count board. Keyed by day only, never by event — it counts
     everything you did today, whatever puzzle it was on. */
  counts: {},
  serverNow: Date.now(), nextResetMs: null,
});

/**
 * One instance watches one event at a time (`watch` switches it). A visitor
 * with the drawer open on 3x3 and then 4x4 is watching two different
 * `daily/<dayKey>/<event>` subtrees one after another, never both — nothing
 * in the panel shows more than one event's board at once.
 */
export class DailyTransport extends EventTarget {
  constructor() {
    super();
    this.snap = emptySnapshot(null);
    this._sdk = null;
    this._offset = 0;
    this._offsetUnsub = null;
    this._eventUnsubs = [];
    this._resultsUnsub = null;
    this._countUnsub = null;
    this._countDayKey = null;
    /** The numeric path segment for the watched day — see dayKeyFromServerMs. */
    this._dayKey = null;
  }

  async init() {
    const { db, auth, ...sdk } = await getDatabaseHandle();
    this._sdk = { db, auth, ...sdk };

    this.snap.uid = auth.currentUser?.uid || null;
    this.snap.signedIn = !!auth.currentUser;
    this.snap.displayName = auth.currentUser?.displayName || auth.currentUser?.email || null;
    this.snap.photoURL = auth.currentUser?.photoURL || null;

    // Auth-state changes reach this transport through setUser(), called by the
    // controller from sync-auth.js's onAuthChange — the db handle above only
    // hands back a snapshot of `auth`, not a live subscription of its own.
    this._offsetUnsub = sdk.onValue(sdk.ref(db, '.info/serverTimeOffset'), (s) => {
      this._offset = s.val() || 0;
      this.snap.serverNow = Date.now() + this._offset;
      this._emit();
    }, () => {});
  }

  /** Called by the controller whenever the signed-in user changes. */
  setUser(user) {
    this.snap.uid = user?.uid || null;
    this.snap.signedIn = !!user;
    this.snap.displayName = user?.displayName || user?.email || null;
    this.snap.photoURL = user?.photoURL || null;
    this._emit();
  }

  serverNow() { return Date.now() + this._offset; }

  _ref(path) { return this._sdk.ref(this._sdk.db, path); }
  _emit() { this.dispatchEvent(new CustomEvent('day', { detail: this.snap })); }

  /** Point every listener at today's `daily/<dayKey>/<event>` subtree. */
  watch(eventId) {
    const now = this.serverNow();
    const dayId = dayIdFromServerMs(now);
    if (this.snap.event === eventId && this.snap.dayId === dayId) return;
    this._teardownEvent();

    this.snap = { ...emptySnapshot(eventId), uid: this.snap.uid, signedIn: this.snap.signedIn,
      displayName: this.snap.displayName, photoURL: this.snap.photoURL,
      // The count board is not per-event, so switching events must not blank it.
      counts: this.snap.counts || {}, serverNow: now };
    this.snap.dayId = dayId;
    this.snap.nextResetMs = nextResetMs(now);
    // Computed from the same `now` as dayId above, so the two always name
    // the same day even though only the key ever reaches the database.
    this._dayKey = dayKeyFromServerMs(now);

    const S = this._sdk;
    const base = `daily/${this._dayKey}/${eventId}`;
    this._eventUnsubs.push(
      S.onValue(this._ref(`${base}/scramble`), (s) => {
        this.snap.scramble = s.val() || null;
        this.snap.readError = null;
        this._emit();
      }, (err) => {
        /* A refused read used to be swallowed here, and a listener that has
           errored is a listener that has DETACHED: nothing would ever arrive
           on this node again, so the window sat on "Publishing today's
           scramble…" for the rest of the session with nothing anywhere
           saying why. It is recorded and surfaced now. */
        this.snap.readError = err?.code || String(err?.message || err);
        console.warn('[daily] scramble read failed', this.snap.readError);
        this._emit();
      }),
      S.onValue(this._ref(`${base}/progress`), (s) => {
        this.snap.progress = s.val() || {};
        this._emit();
      }, (err) => console.warn('[daily] progress read failed', err?.code || err)),
    );

    /* Outside the per-event subtree, and outside `_eventUnsubs` with it: the
       solve-count board is the same board whichever event the picker is on,
       so switching events must not tear it down and refetch it. */
    this._watchCounts();
    this._emit();
  }

  /**
   * Today's solve-count board. Publicly readable — there is no reveal gate on
   * it, because a count says nothing about the scramble you are about to be
   * given, which is the only thing the time board's gate exists to protect.
   */
  _watchCounts() {
    // Re-attached only when the DAY changes, never when the event picker
    // moves — switching from 3x3 to 4x4 is watching the same count board.
    if (this._countUnsub && this._countDayKey === this._dayKey) return;
    this._countUnsub?.();
    const S = this._sdk;
    const dayKey = this._countDayKey = this._dayKey;
    this._countUnsub = S.onValue(this._ref(`dailyCount/${dayKey}`), (s) => {
      if (this._dayKey !== dayKey) return;   // the day rolled over mid-flight
      this.snap.counts = s.val() || {};
      this._emit();
    }, () => {});
  }

  /**
   * Publish how many solves this client has done today.
   *
   * A total, not an increment — see the note above countSolvesForDay. The
   * rule refuses anything lower than what is already there, so a stale tab
   * writing an old total is a no-op rather than a rollback, and this can be
   * called as often as it likes without coordination.
   */
  async writeCount(n, name, photo) {
    const S = this._sdk;
    const { uid } = this.snap;
    if (!this._dayKey || !uid || !(n > 0)) return;
    await S.set(this._ref(`dailyCount/${this._dayKey}/${uid}`), {
      n, name: String(name || 'Cuber').slice(0, 32),
      ...(photo ? { photo: String(photo).slice(0, 300) } : {}),
    });
  }

  _teardownEvent() {
    this._eventUnsubs.forEach(u => u());
    this._eventUnsubs = [];
    this._resultsUnsub?.();
    this._resultsUnsub = null;
    this._dayKey = null;
  }

  /**
   * Publish today's scramble for the watched event, if nobody has yet.
   *
   * Losing the write-once race is not an error — somebody else got there
   * first and the listener hands us their scramble a moment later, the same
   * shape as a race round. Being REFUSED is a different thing entirely, and
   * this used to swallow both identically: a deployment whose rules had never
   * been published sat forever on "Publishing today's scramble…" with nothing
   * anywhere saying why, because the one line that knew had thrown its
   * exception away. The caller gets told now.
   */
  async publishScramble(scramble) {
    const S = this._sdk;
    const { event } = this.snap;
    if (!this._dayKey || !event) return { ok: false, reason: 'not-watching' };
    try {
      await S.set(this._ref(`daily/${this._dayKey}/${event}/scramble`), scramble);
      /* Adopt it immediately rather than waiting for the listener to hand our
         own write back. Normally it does so within a moment; if it has died
         (see the read handler above) it never will, and there is no reason to
         be blocked on being told a thing we just successfully did. */
      if (this.snap.event === event && !this.snap.scramble) {
        this.snap.scramble = scramble;
        this._emit();
      }
      return { ok: true };
    } catch (err) {
      // Somebody else's scramble arriving is the benign case, and it is
      // distinguishable: their write is already on the node we just read.
      const lost = !!this.snap.scramble;
      return { ok: lost, reason: err?.code || String(err?.message || err) };
    }
  }

  async setProgress(patch) {
    const S = this._sdk;
    const { event, uid } = this.snap;
    if (!this._dayKey || !event || !uid) return;
    const out = { ...patch };
    if (patch.status === 'solving') out.startedAt = S.serverTimestamp();
    if (patch.status === 'done') out.finishedAt = S.serverTimestamp();
    await S.update(this._ref(`daily/${this._dayKey}/${event}/progress/${uid}`), out);
  }

  async submitResult(result) {
    const S = this._sdk;
    const { event, uid } = this.snap;
    if (!this._dayKey || !event || !uid) throw new Error('not-signed-in');
    await S.set(this._ref(`daily/${this._dayKey}/${event}/results/${uid}`),
      { ...result, submittedAt: S.serverTimestamp() });
  }

  /** Has this uid already submitted today, for this event? */
  async hasOwnResult() {
    const { event, uid } = this.snap;
    if (!this._dayKey || !event || !uid) return false;
    try {
      const s = await this._sdk.get(this._ref(`daily/${this._dayKey}/${event}/results/${uid}`));
      return s.exists();
    } catch { return false; }
  }

  /**
   * Start reading everyone else's times for the watched day/event.
   *
   * Not attached until the caller knows the reveal rule will allow it —
   * exactly the same reasoning as race-net.js's unlockResults: attaching it
   * earlier would just generate PERMISSION_DENIED noise for every change.
   */
  unlockResults() {
    if (this.snap.resultsUnlocked || !this._dayKey) return;
    const { dayId, event } = this.snap;
    const dayKey = this._dayKey;
    this.snap.resultsUnlocked = true;
    const S = this._sdk;
    this._resultsUnsub = S.onValue(this._ref(`daily/${dayKey}/${event}/results`), (s) => {
      if (this.snap.dayId === dayId && this.snap.event === event) {
        this.snap.results = s.val() || {};
        this._emit();
      }
    }, (err) => console.warn('[daily] results still locked', err?.code || err));
    this._emit();
  }

  destroy() {
    this._offsetUnsub?.();
    this._countUnsub?.();
    this._countUnsub = null;
    this._countDayKey = null;
    this._teardownEvent();
  }
}

/** Whether a real, shared daily board is configured on this deployment. */
export { cloudAvailable } from './race-net.js';
