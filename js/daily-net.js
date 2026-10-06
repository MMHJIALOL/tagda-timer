import { t } from './i18n.js';
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
import { loadRoles } from './audience.js';
import { getConfig } from './config.js';
import { removalUpdate, sendReport } from './moderation.js';
import { CLOCK_SLACK_MS, CLOCK_SLACK_RATIO, CHAT_HISTORY } from './raceapp.js';
import { cleanChat } from './race-net.js';

export { CLOCK_SLACK_MS, CLOCK_SLACK_RATIO };

/* The pure day/time/count math lives in dayid.js — see the header there for
   why it is a separate file. Re-exported so every existing importer of this
   module, test.html included, is unaffected by the split. */
export * from './dayid.js';
// Re-exporting does not put a name in this module's own scope, and the
// transport below calls these directly.
import { dayIdFromServerMs, nextResetMs, dayKeyFromServerMs, pastDayKeys } from './dayid.js';

/**
 * Longest note a row will carry, matched by the database rule.
 *
 * One line, because that is what the board has room for: a name, a time and
 * whatever fits between them on a row in a 300px column. Anything longer is
 * a chat message, and that has a room of its own now: the day's chat, below.
 */
export const NOTE_MAX_LEN = 80;

/* ---------------------------------------------------------
   The day's chat
   ---------------------------------------------------------

   One room per event per day, at `daily/<dayKey>/<event>/chat`, and behind
   the same gate as the times: readable only once your own result is in.
   An open room would be a way round that gate — "free x-cross on white" is
   help on somebody else's one attempt, not banter — so the rule is the
   board's rule, word for word.

   The rest is in firebase.rules.json and DAILY.md §9; in short:
     m/<pushId>   { uid, name, text, at, photo? }. Google accounts only, today's
                  room only, `at` is the server's clock. Deleted by its author
                  or by an admin. Never edited.
     last/<uid>   the server time of that account's last message, written in
                  the same update as the message. The rule wants 1.5 s
                  between the two, which is the rate limit.

   Nothing deletes a room at 00:00 IST. The next day the app simply reads a
   different path, so it is gone from every screen; the stored copy is
   removed by the first signed-in visitor of a later day (sweepOldChats),
   and the rules allow that for every day except today.
   --------------------------------------------------------- */

/**
 * Least time between two messages from one account, in this client. The rule
 * says 1.5 s between the server's two timestamps; asking for a little more
 * here keeps a message sent on a fast connection after one sent on a slow one
 * from being refused.
 */
export const CHAT_GAP_MS = 2000;

/** How many past days one sweep clears, in case nobody visited for a while. */
export const CHAT_SWEEP_DAYS = 7;

/** What the chat looks like before there is anything to read. */
const emptyChat = () => ({ key: null, state: 'locked', messages: [] });

/** Collapse the whitespace and cut it to the cap. Same shape as race chat. */
export function cleanNote(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_LEN);
}

/* ---------------------------------------------------------
   Transport
   --------------------------------------------------------- */

/** Snapshot handed to the UI. Always this shape, even before anything loads. */
const emptySnapshot = (event) => ({
  event, dayId: null, uid: null, signedIn: false, displayName: null, photoURL: null,
  scramble: null, progress: {}, results: {}, resultsUnlocked: false, readError: null,
  /* `removed/<uid>` for the signed-in account: { at, final } once an admin has
     taken its time off this board, else null. Watched, so a removal reaches an
     open window at once rather than at the next reload. */
  removed: null,
  /* Whether this account is an admin (js/admins.js): who may delete anybody's
     message and take anybody's time off a board. Only draws the buttons; the
     rules decide, by admins/<uid>. */
  admin: false,
  /* bans/<uid> for the signed-in account: { at, reason, until? } while an
     admin has banned it, else null (js/admins.js banActive says whether it is
     still in force). Watched, like `removed`. Only explains things: the rules
     refuse a banned account's writes regardless. */
  ban: null,
  /* Whether the scramble node has actually reported yet.
     `scramble: null` alone cannot answer "has anybody published today's?" —
     it is also what a listener that has not yet delivered its first value
     looks like, and watch() emits once before that happens. Publishing on
     that emit is how every client ended up generating its own: each refresh
     raced the read, and a client that beat it wrote a brand new scramble
     over the day's. Nothing publishes until this is true. */
  scrambleLoaded: false,
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
    /**
     * The watched room's messages, oldest first. Outside `snap`, and announced
     * as its own 'chat' event rather than 'day': the board is rebuilt on every
     * 'day', and a message arriving is no reason to rebuild it.
     */
    this.chat = emptyChat();
    this._chatUnsub = null;
    this._chatRetried = null;
    this._removedUnsub = null;
    this._removedKey = null;
    this._adminUid = null;
    this._banUnsub = null;
    this._banUid = undefined;
  }

  async init() {
    const { db, auth, ...sdk } = await getDatabaseHandle();
    this._sdk = { db, auth, ...sdk };

    this.snap.uid = auth.currentUser?.uid || null;
    this.snap.signedIn = !!auth.currentUser;
    this.snap.displayName = auth.currentUser?.displayName || auth.currentUser?.email || null;
    this.snap.photoURL = auth.currentUser?.photoURL || null;
    this._checkAdmin(auth.currentUser);
    this._watchBan();

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
    this._checkAdmin(user);
    this._watchBan();
    this._watchRemoved();
    this._emit();
  }

  /**
   * Follow bans/<uid> for the signed-in account. Readable by its owner, and
   * on the connection this transport already has; refused is the rules from
   * before bans, where nobody is banned, and is left at null.
   */
  _watchBan() {
    const uid = this.snap.uid;
    if (!this._sdk || uid === this._banUid) return;
    this._banUnsub?.();
    this._banUnsub = null;
    this._banUid = uid;
    this.snap.ban = null;
    if (!uid) return;
    this._banUnsub = this._sdk.onValue(this._ref(`bans/${uid}`), (s) => {
      if (this._banUid !== uid) return;
      this.snap.ban = s.val() || null;
      this._emit();
    }, () => {});
  }

  /**
   * Ask admins/<uid> and testers/<uid> once per account (audience.js, which
   * keeps the answer for every feature with an audience); until they answer,
   * neither.
   */
  _checkAdmin(user) {
    const uid = user?.uid || null;
    if (!this._sdk || uid === this._adminUid) return;
    this._adminUid = uid;
    this.snap.admin = false;
    this.snap.tester = false;
    loadRoles(this._sdk, user).then(({ uid: who, admin, tester }) => {
      if (this._adminUid !== uid || who !== uid) {
        // Offline, most likely: the next auth event asks again.
        if (this._adminUid === uid && uid) this._adminUid = null;
        return;
      }
      this.snap.admin = admin;
      this.snap.tester = tester;
      this._emit();
    });
  }

  /** The day's featured event (sotdFeatured/<dayKey>, DAILY.md §3), read once a day. Refused or none: null. */
  _readFeatured(dayKey) {
    if (this._featuredDay === dayKey) return;
    this._featuredDay = dayKey;
    this.featured = null;
    this._sdk.get(this._ref(`sotdFeatured/${dayKey}`)).then((s) => {
      if (this._featuredDay !== dayKey) return;
      this.featured = typeof s.val() === 'string' ? s.val() : null;
      this._emit();
    }, () => {});
  }

  serverNow() { return Date.now() + this._offset; }

  _ref(path) { return this._sdk.ref(this._sdk.db, path); }
  _emit() { this.dispatchEvent(new CustomEvent('day', { detail: this.snap })); }
  _emitChat() { this.dispatchEvent(new CustomEvent('chat', { detail: this.chat })); }

  /** Point every listener at today's `daily/<dayKey>/<event>` subtree. */
  watch(eventId) {
    const now = this.serverNow();
    const dayId = dayIdFromServerMs(now);
    if (this.snap.event === eventId && this.snap.dayId === dayId) return;
    this._teardownEvent();

    this.snap = { ...emptySnapshot(eventId), uid: this.snap.uid, signedIn: this.snap.signedIn,
      displayName: this.snap.displayName, photoURL: this.snap.photoURL, admin: this.snap.admin, tester: this.snap.tester, ban: this.snap.ban,
      // The count board is not per-event, so switching events must not blank it.
      counts: this.snap.counts || {}, serverNow: now };
    this.snap.dayId = dayId;
    this.snap.nextResetMs = nextResetMs(now);
    // Computed from the same `now` as dayId above, so the two always name
    // the same day even though only the key ever reaches the database.
    this._dayKey = dayKeyFromServerMs(now);
    this._readFeatured(this._dayKey);

    const S = this._sdk;
    const base = `daily/${this._dayKey}/${eventId}`;
    this._eventUnsubs.push(
      S.onValue(this._ref(`${base}/scramble`), (s) => {
        this.snap.scramble = s.val() || null;
        this.snap.scrambleLoaded = true;
        this.snap.readError = null;
        this._emit();
      }, (err) => {
        /* A refused read used to be swallowed here, and a listener that has
           errored is a listener that has DETACHED: nothing would ever arrive
           on this node again, so the window sat on "Publishing today's
           scramble…" for the rest of the session with nothing anywhere
           saying why. It is recorded and surfaced now. */
        this.snap.readError = err?.code || String(err?.message || err);
        /* Emphatically NOT scrambleLoaded. A node we cannot read is a node we
           must not publish to: we would be writing a scramble we can never be
           told has already been written, which is the same "everyone gets
           their own" failure with a worse cause. holdText says so instead. */
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
    this._watchRemoved();
    this._emit();
  }

  /**
   * Follow `removed/<uid>` for the watched day, event and account: the one
   * node that says an admin has taken this account's time off the board.
   * Re-pointed whenever any of the three changes (setUser as well as watch).
   * Owner-readable only, so a refusal is rules from before removals, where
   * nothing can have been removed, and is left at null.
   */
  _watchRemoved() {
    const { uid, event } = this.snap;
    const key = uid && event && this._dayKey ? `${this._dayKey}/${event}/removed/${uid}` : null;
    if (key === this._removedKey) return;
    this._removedUnsub?.();
    this._removedUnsub = null;
    this._removedKey = key;
    this.snap.removed = null;
    if (!key || !this._sdk) return;
    this._removedUnsub = this._sdk.onValue(this._ref(`daily/${key}`), (s) => {
      if (this._removedKey !== key) return;
      this.snap.removed = s.val() || null;
      this._emit();
    }, () => {});
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
    this._removedUnsub?.();
    this._removedUnsub = null;
    this._removedKey = null;
    this._dayKey = null;
    this._chatUnsub?.();
    this._chatUnsub = null;
    clearTimeout(this._chatRetry);
    // Another event or another day is another room, and its gate is shut
    // until that board's own result says otherwise.
    if (this.chat.key) {
      this.chat = emptyChat();
      this._emitChat();
    }
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
    const ref = this._ref(`daily/${this._dayKey}/${event}/scramble`);
    try {
      /* A transaction, not a set().
         `set()` overwrites. That was survivable only because the rule says
         `!data.exists()` — so the whole "one scramble for everyone, all day"
         guarantee rested entirely on a rules file that has to be published by
         hand, separately from the app, and is not published on a fresh
         deployment. Until it is, every client that loses the read race writes
         a new scramble over the day's, and it changes on every refresh for
         everyone at once.
         runTransaction is the same guarantee made by the client instead:
         `undefined` aborts, so an existing value is never replaced, whatever
         the rules happen to allow. Two clients racing still cost nothing —
         the loser is handed the winner's value in the result and adopts it. */
      const out = await S.runTransaction(ref, (cur) => (cur === null ? scramble : undefined));
      const settled = out?.snapshot?.val() || null;
      /* Adopt whatever is now on the node — ours if we committed, theirs if we
         aborted — rather than waiting for the listener to hand it back.
         Normally it does so within a moment; if it has died (see the read
         handler above) it never will, and there is no reason to be blocked on
         being told a thing we have just been told. */
      if (this.snap.event === event && settled && !this.snap.scramble) {
        this.snap.scramble = settled;
        this.snap.scrambleLoaded = true;
        this._emit();
      }
      // Losing the race is a success: today's scramble exists, which was the
      // entire point of the write. Only an empty node afterwards is a failure.
      return settled ? { ok: true } : { ok: false, reason: 'empty-after-write' };
    } catch (err) {
      // Somebody else's scramble arriving is the benign case, and it is
      // distinguishable: their write is already on the node we just read.
      const lost = !!this.snap.scramble;
      return { ok: lost, reason: err?.code || String(err?.message || err) };
    }
  }

  /**
   * Where a write for the current attempt lands, pinned now.
   *
   * A submit awaits a progress write and its retries first, and watch() can
   * move the transport to another event or day in that gap — so a result that
   * read `_dayKey` and `snap.event` at the moment of writing could be filed
   * under an event it was never solved in.
   */
  target() {
    return { dayKey: this._dayKey, event: this.snap.event, uid: this.snap.uid };
  }

  async setProgress(patch, { dayKey, event, uid } = this.target()) {
    const S = this._sdk;
    if (!dayKey || !event || !uid) return;
    const out = { ...patch };
    if (patch.status === 'solving') out.startedAt = S.serverTimestamp();
    /* Stamped when the timer stops, not when the result is sent. A kept
       misfire waits on a question first, and a reload can put that answer off
       for minutes; stamped at submit, all of that counted as solving time and
       the rules' clock check refused the time that was kept. */
    if (patch.status === 'stopped') out.finishedAt = S.serverTimestamp();
    await S.update(this._ref(`daily/${dayKey}/${event}/progress/${uid}`), out);
  }

  async submitResult(result, { dayKey, event, uid } = this.target()) {
    const S = this._sdk;
    if (!dayKey || !event || !uid) throw new Error('not-signed-in');
    await S.set(this._ref(`daily/${dayKey}/${event}/results/${uid}`),
      { ...result, submittedAt: S.serverTimestamp() });
  }

  /**
   * Attach (or replace) the one-line note on your own row.
   *
   * A separate write from submitResult on purpose: the result is sealed the
   * moment it lands, and the note is written afterwards, from the board,
   * once you can see who else is on it. The rules give `note` its own
   * ".write" for exactly that — see firebase.rules.json.
   *
   * Written into the day the caller names, not necessarily today's: a note
   * can be added to yesterday's row from the history view without moving the
   * transport off the day it is watching.
   */
  async setNote(text, dayKey = this._dayKey) {
    const { event, uid } = this.snap;
    if (!dayKey || !event || !uid) throw new Error('not-signed-in');
    const body = cleanNote(text);
    await this._sdk.set(this._ref(`daily/${dayKey}/${event}/results/${uid}/note`), body);
    return body;
  }

  /**
   * Whether this account has already spent today's replay share for the
   * watched event (shared, or shared and removed). Owner-readable only, so
   * a refusal means rules from before replays, where nothing can be shared
   * yet: 'off'. `null` when that cannot be asked.
   */
  async hasReplayClaim({ dayKey, event, uid } = this.target()) {
    if (!dayKey || !event || !uid) return null;
    try {
      return (await this._sdk.get(this._ref(`daily/${dayKey}/${event}/replayClaim/${uid}`))).exists();
    } catch (err) {
      return /permission.denied/i.test(String(err?.code || err?.message || err)) ? 'off' : null;
    }
  }

  /** Whether your own row says it has a replay, read now rather than from the listener. */
  async replayFlag({ dayKey, event, uid } = this.target()) {
    if (!dayKey || !event || !uid) return null;
    try { return (await this._sdk.get(this._ref(`daily/${dayKey}/${event}/results/${uid}/replay`))).val() === true; }
    catch { return null; }
  }

  /** Mark your own row as having a replay: the Worker does this; this is the fallback when its write did not land. */
  async setReplayFlag(value, { dayKey, event, uid } = this.target()) {
    if (!dayKey || !event || !uid) throw new Error('not-signed-in');
    await this._sdk.set(this._ref(`daily/${dayKey}/${event}/results/${uid}/replay`), value ? true : null);
  }

  /**
   * Give up the main attempt for the backup scramble. Write-once, and the
   * rules only accept it from somebody who has started an attempt and not
   * yet sent a result. This comes BEFORE the backup can be read at all: the
   * `backup` node is readable only once this exists, so seeing the backup
   * always costs the first attempt, however the database is reached.
   */
  async claimBackup({ dayKey, event, uid } = this.target()) {
    if (!dayKey || !event || !uid) throw new Error('not-signed-in');
    await this._sdk.set(this._ref(`daily/${dayKey}/${event}/backupClaim/${uid}`), this._sdk.serverTimestamp());
  }

  /** Whether this uid has claimed today's backup. Same null/false split as hasOwnResult. */
  async hasBackupClaim() {
    const { event, uid } = this.snap;
    if (!this._dayKey || !event || !uid) return null;
    try {
      return (await this._sdk.get(this._ref(`daily/${this._dayKey}/${event}/backupClaim/${uid}`))).exists();
    } catch (err) {
      /* Refused means rules from before backups existed, where nobody can
         have claimed one. */
      return /permission.denied/i.test(String(err?.code || err?.message || err)) ? false : null;
    }
  }

  /**
   * Whether an admin has taken this account's time off the watched board:
   * `{ at, final }`, or false. Same null/false split as hasOwnResult, and a
   * refusal is rules from before removals, where nothing was ever removed.
   */
  async removal() {
    const { event, uid } = this.snap;
    if (!this._dayKey || !event || !uid) return null;
    try {
      return (await this._sdk.get(this._ref(`daily/${this._dayKey}/${event}/removed/${uid}`))).val() || false;
    } catch (err) {
      return /permission.denied/i.test(String(err?.code || err?.message || err)) ? false : null;
    }
  }

  /**
   * Take somebody's time off a board (the admin only: the rules refuse anybody
   * else). One update, so it all lands or none of it does:
   *   results/<uid>             gone, so the board and the chat lock for them
   *   removed/<uid>             { at, final }: what tells their app, and what
   *                             the rules read before taking another result.
   *                             `final` is whether that time was already on the
   *                             backup; the rules check it against the claim.
   *   progress/<uid>/submitted  gone, so "n people have done it" drops by one
   *   replayClaim/<uid>         gone, so a replay of the backup solve can be shared
   */
  async removeResult({ dayKey, event, uid, final }) {
    if (!dayKey || !event || !uid) throw new Error('nothing-to-remove');
    const S = this._sdk;
    await S.update(this._ref(`daily/${dayKey}/${event}`), removalUpdate(uid, final, S.serverTimestamp()));
  }

  /** Report a message in the watched room (moderation.js): 'sent' or 'already'. */
  reportChat(m) {
    const { dayKey, event } = this.target();
    return sendReport(this._sdk, { kind: 'chat', path: `daily/${dayKey}/${event}/chat/m/${m.id}`, text: m.text });
  }

  /** Report somebody's shared replay on the board `dayKey`, `event`. */
  reportReplay({ dayKey, event, uid, name }) {
    return sendReport(this._sdk, { kind: 'replay', path: `daily/${dayKey}/${event}/results/${uid}`, text: name || '' });
  }

  /**
   * Shut the board and the chat again after this account's own row was taken
   * away. The rules have already revoked both reads, and an errored listener
   * has detached; this forgets them, so the next unlockResults() (after the
   * backup solve lands) attaches fresh ones instead of finding the gate open.
   */
  relock() {
    this._resultsUnsub?.();
    this._resultsUnsub = null;
    this.snap.resultsUnlocked = false;
    this.snap.results = {};
    this._chatUnsub?.();
    this._chatUnsub = null;
    clearTimeout(this._chatRetry);
    this._chatRetried = null;
    this.chat = emptyChat();
    this._emitChat();
    this._emit();
  }

  /**
   * The day's backup scramble, publishing `make()`'s if nobody has yet.
   *
   * Only works after claimBackup. Whoever claims first generates it, the
   * same way the main scramble is published: a transaction that never
   * replaces what is there, so two claimers racing both end up with the
   * winner's. It cannot be generated in advance by whoever publishes the main
   * one, because then that person would have seen it without claiming.
   */
  async backupScramble(make, { dayKey, event } = this.target()) {
    const ref = this._ref(`daily/${dayKey}/${event}/backup`);
    const have = (await this._sdk.get(ref)).val();
    if (have) return have;
    const mine = await make();
    const out = await this._sdk.runTransaction(ref, (cur) => (cur === null ? mine : undefined));
    return out?.snapshot?.val() || null;
  }

  /**
   * Has this uid already submitted today, for this event?
   *
   * `null` when that cannot be asked — nothing watched yet, or the read
   * failed. Answering `false` there told the controller "not played today",
   * and it armed a fresh attempt for an account that had already spent it.
   */
  async hasOwnResult() {
    const { event, uid } = this.snap;
    if (!this._dayKey || !event || !uid) return null;
    try {
      const s = await this._sdk.get(this._ref(`daily/${this._dayKey}/${event}/results/${uid}`));
      return s.exists();
    } catch (err) {
      /* A refusal IS the answer. `results` is readable only once your own row
         is in it, so from here a row that does not exist looks exactly like
         PERMISSION_DENIED. Anything else — offline, a timeout — is unknown. */
      return /permission.denied/i.test(String(err?.code || err?.message || err)) ? false : null;
    }
  }

  /**
   * Read one past day's board once, without disturbing the live one.
   *
   * Deliberately NOT watch(): that is the pointer at TODAY, and everything
   * hanging off it — the countdown, the rollover check, whether an attempt
   * may still be armed — is keyed to the day it currently names. Pointing it
   * at history to look something up and pointing it back afterwards would
   * make "which day is this transport on" a question with two answers, and
   * the submit path would be reading whichever one lost the race.
   *
   * So this touches no instance state at all: three `get`s and a plain
   * object back, the same one-shot shape hasOwnResult() uses.
   *
   * `results` is gated per day by the rules — you may read a day's board only
   * if you have a row in it — so a refusal here is the ordinary answer for a
   * day you sat out, not a fault. It comes back as `denied` rather than as a
   * throw, because the caller has to draw something either way and "you did
   * not play that day" is not an error to report. A refusal on `scramble` or
   * `progress` would be, both being public, so those are left to reject.
   */
  async readDay(dayKey, eventId) {
    const S = this._sdk;
    if (!S || !dayKey || !eventId) return { scramble: null, progress: {}, results: {}, denied: true };
    const base = `daily/${dayKey}/${eventId}`;
    const [scramble, progress] = await Promise.all([
      S.get(this._ref(`${base}/scramble`)).then(s => s.val() || null, () => null),
      S.get(this._ref(`${base}/progress`)).then(s => s.val() || {}, () => ({})),
    ]);
    try {
      const results = (await S.get(this._ref(`${base}/results`))).val() || {};
      return { scramble, progress, results, denied: false };
    } catch {
      return { scramble, progress, results: {}, denied: true };
    }
  }

  /**
   * Start reading everyone else's times for the watched day/event.
   *
   * Not attached until the caller knows the reveal rule will allow it —
   * exactly the same reasoning as race-net.js's unlockResults: attaching it
   * earlier would just generate PERMISSION_DENIED noise for every change.
   */
  unlockResults() {
    // The chat sits behind the very same gate, so it opens at the very same
    // moment — including after a reload, when this is how a result already
    // in the database is acted on.
    this._watchChat();
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

  /* ---------------- the day's chat ---------------- */

  /**
   * Start reading the watched room: the newest CHAT_HISTORY messages, as a
   * query so that a busy day ships only what changed inside that tail.
   *
   * A refusal is `off`, not an error to show anybody: it is what a
   * deployment whose rules predate the chat answers, and the window simply
   * goes without one. One more try a few seconds later covers the other
   * cause, a listener attached a beat before the server had the result that
   * opens the gate.
   */
  _watchChat() {
    if (this._chatUnsub || !this._dayKey || !this.snap.event) return;
    const dayKey = this._dayKey;
    const event = this.snap.event;
    const key = `${dayKey}|${event}`;
    const S = this._sdk;
    if (this.chat.key !== key) this.chat = { key, state: 'loading', messages: [] };
    const q = S.query(this._ref(`daily/${dayKey}/${event}/chat/m`), S.limitToLast(CHAT_HISTORY));
    this._chatUnsub = S.onValue(q, (snap) => {
      if (this.chat.key !== key) return;
      const messages = [];
      // forEach walks in the query's (push id, so time) order; a callback
      // that returned push()'s length would stop it after the first.
      snap.forEach((child) => { messages.push({ id: child.key, ...child.val() }); });
      this.chat = { key, state: 'live', messages };
      this._emitChat();
    }, (err) => {
      if (this.chat.key !== key) return;
      // An errored listener has detached; nothing more will arrive on it.
      this._chatUnsub = null;
      console.warn('[daily] chat read refused', err?.code || err);
      this.chat = { key, state: 'off', messages: [] };
      this._emitChat();
      if (this._chatRetried !== key) {
        this._chatRetried = key;
        this._chatRetry = setTimeout(() => {
          if (this.chat.key === key && this._dayKey === dayKey && this.snap.event === event) this._watchChat();
        }, 3000);
      }
    });
    this._emitChat();
  }

  /**
   * Say something in the watched room.
   *
   * One update writes the message and `last/<uid>` together, because that is
   * the only shape the rules take: each requires the other to carry the same
   * server time, and `last` is what the 1.5 s limit is measured from. The
   * listener shows the message at once (the SDK applies a write locally
   * before the server answers) and takes it back if the server refuses.
   */
  async sendChat(text, { name, photo } = {}) {
    const { dayKey, event, uid } = this.target();
    if (!dayKey || !event || !uid) throw new Error('not-signed-in');
    const body = cleanChat(text);
    if (!body) return null;
    const S = this._sdk;
    const base = `daily/${dayKey}/${event}/chat`;
    // push() with no value only makes the id: time-ordered, so the query's order.
    const id = S.push(this._ref(`${base}/m`)).key;
    // The admin console can shorten it (config/sotdChat/maxLen); the rules hold the same line.
    const msg = { uid, name: String(name || 'Cuber').slice(0, 32), text: body.slice(0, getConfig('sotdChat', 'maxLen')), at: S.serverTimestamp() };
    if (photo) msg.photo = photo;
    await S.update(this._ref(base), { [`m/${id}`]: msg, [`last/${uid}`]: S.serverTimestamp() });
    return id;
  }

  /**
   * How many replays have been shared on `dayKey`, all events together: one
   * entry per claim under replayDay/ (the Worker writes it, ADMIN.md). Asked
   * before uploading, so a full day is found out before the one share for the
   * event is spent on it. null when it cannot be read (rules from before it).
   */
  async replaysShared(dayKey) {
    try {
      const v = (await this._sdk.get(this._ref(`replayDay/${dayKey}`))).val() || {};
      return Object.values(v).reduce((n, ev) => n + Object.keys(ev || {}).length, 0);
    } catch { return null; }
  }

  /** Take a message down: your own, or anybody's for an admin. The rules decide which. */
  async deleteChat(id) {
    const { dayKey, event } = this.target();
    if (!dayKey || !event || !id) return;
    await this._sdk.remove(this._ref(`daily/${dayKey}/${event}/chat/m/${id}`));
  }

  /**
   * Remove the stored rooms of the last few days, every event at once.
   *
   * Blind: one update per day, nulls only, nothing read first. Deleting a
   * room that is not there costs nothing and is allowed, and the rules allow
   * it for every day but today, so a clock that is a little off can only
   * ever fail to clean, never clean today. Yesterday goes first, alone: if
   * that is refused, these rules predate the chat and the rest would be
   * refused too.
   */
  async sweepOldChats(events) {
    if (!this._dayKey || !this.snap.uid || !events?.length) return false;
    const S = this._sdk;
    const paths = Object.fromEntries(events.map(e => [`${e}/chat`, null]));
    const [first, ...rest] = pastDayKeys(this._dayKey, CHAT_SWEEP_DAYS);
    try { await S.update(this._ref(`daily/${first}`), paths); }
    catch (err) {
      console.warn('[daily] chat sweep refused', err?.code || err);
      return false;
    }
    await Promise.allSettled(rest.map(k => S.update(this._ref(`daily/${k}`), paths)));
    /* The replay counts of the same days, bar yesterday's, whose replays can
       still be shared. One blind update; refused on rules from before them. */
    if (rest.length) {
      // The root: ref(db, '') is refused as an empty path.
      S.update(S.ref(S.db), Object.fromEntries(rest.map(k => [`replayDay/${k}`, null])))
        .catch(err => console.warn('[daily] replay count sweep refused', err?.code || err));
    }
    return true;
  }

  destroy() {
    clearTimeout(this._chatRetry);
    this._banUnsub?.();
    this._banUnsub = null;
    this._offsetUnsub?.();
    this._countUnsub?.();
    this._countUnsub = null;
    this._countDayKey = null;
    this._teardownEvent();
  }
}

/** Whether a real, shared daily board is configured on this deployment. */
export { cloudAvailable } from './race-net.js';
