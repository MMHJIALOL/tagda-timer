/* ===========================================================
   Tagda Timer — race mode

   Everyone in a room gets the same scramble and attacks it whenever they are
   ready. Nobody's time is visible to you until you have finished that same
   scramble yourself — and until then all you can see is that they are done,
   which is the whole feeling the mode exists for.

   Deliberately NOT a synchronised 3-2-1-go. WCA inspection is a personal
   fifteen seconds and network latency is real, so a shared countdown would be
   unfair in a way nobody could see. Same scramble, same window, own clock.

   The room's shape and the reveal rule live in race-net.js; this file is the
   state machine on top of it and the panel you actually look at.
   =========================================================== */

import { $, el, fmt } from './util.js';
import { toast, confirmToast } from './toast.js';
import { eventOf } from './events.js';
import { bestAvg } from './stats.js';
import { shockwave, confetti, flash, chime } from './fx.js';
import { themeColors } from './theme.js';
import { createTransport, cloudAvailable, scrambleHash, isStale, cleanChat } from './race-net.js';
import {
  ROOM_MAX, ROWS_BEFORE_FOLD, CODE_ALPHABET, CODE_LENGTH,
  GRACE_MS, SOFT_TIMEOUT_MS, SUSPECT_RATIO,
  CLOCK_SLACK_MS, CLOCK_SLACK_RATIO,
  CHAT_MAX_LEN, CHAT_COOLDOWN_MS, RACE_EMOJI,
} from './raceapp.js';

/**
 * How long a settled leaderboard stays up before the next scramble.
 *
 * It used to be six, and it used to be six on top of up to two seconds of tick
 * latency and then a scramble that was only generated and published once the
 * round pointer had already moved — so the real gap between the last person
 * finishing and the next scramble appearing was closer to ten. The settle is
 * now the whole of the wait: the next round's scramble is written while this
 * one is still being read (see _preopenNextRound), and both ends of this timer
 * fire on the event that caused them rather than on the next tick.
 *
 * Short enough now that it is not a pause you sit through. Nothing about the
 * finished round vanishes when it expires — the standings board and the row
 * with your time stay exactly where they are — so this is only how long the
 * scramble area waits before handing you the next one to pick up.
 */
const SETTLE_MS = 700;

/**
 * How long a round may sit without a scramble before somebody who is not the
 * host publishes one.
 *
 * The host is derived, not elected, so a host whose tab froze rather than
 * closed is still the host as far as every client is concerned — and a room
 * whose host has stopped publishing scrambles is a room that has stopped. The
 * `info` node is write-once, so letting everyone try after a pause costs
 * nothing: the first write wins and the rest are refused, which is the same
 * mechanism two clients starting at once already rely on.
 */
const ORPHAN_ROUND_MS = 6000;

/** How long to keep retrying a write the room needs before giving up on it. */
const RETRY_MS = [400, 1200];

/* ---------------------------------------------------------
   Small helpers
   --------------------------------------------------------- */

export const randomCode = () => Array.from(
  { length: CODE_LENGTH },
  () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
).join('');

export const normaliseCode = (s) =>
  String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

/** An event only counts as raceable if "one scramble, one time" describes it. */
export function raceable(eventId) {
  const ev = eventOf(eventId);
  return !ev.fmc && !ev.multi;
}

/** Deterministic colour from a name, so everyone sees the same player the same. */
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
}

/** Effective time for ranking: +2 added, DNF sorted last. */
function effOf(r) {
  if (!r) return null;
  if (r.penalty === 'DNF') return Infinity;
  return r.timeMs + (r.penalty === '+2' ? 2000 : 0);
}

/**
 * An inline SVG, wrapped in a span.
 *
 * el() builds with createElement, which cannot make a real SVG element — an
 * <svg> made that way is an unknown HTML tag and renders as nothing at all.
 * Handing the markup to the HTML parser through innerHTML puts it in the SVG
 * namespace properly.
 */
const icon = (inner, cls = '') => {
  const span = el('span', { class: cls });
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  return span;
};

/* =========================================================
   The controller
   ========================================================= */
export class Race extends EventTarget {
  constructor(app) {
    super();
    this.app = app;
    this.net = null;
    this.snap = null;
    this.uid = null;
    this.kind = null;

    /** The round we have already written a result for. */
    this.submittedRound = 0;
    /**
     * What the scramble area is currently showing, as a short key.
     *
     * Not a round number any more. A round has three things it can put on
     * screen — waiting for its scramble, the scramble itself, and the hold
     * that replaces it once YOU are done — and keying on the round alone meant
     * only the first of them was ever drawn. That is the bug where finishing
     * first left the scramble you had just solved sitting there, inviting you
     * to scramble it a second time while the room was still racing.
     */
    this._servedKey = '';
    /** Rounds we have already celebrated / folded into standings. */
    this.settledRound = 0;

    /** uid -> { name, wins, played, best, lastRank } for this room. */
    this.standings = new Map();
    /** roundNo -> the solve this client saved for it, so a row can edit it. */
    this.mySolves = new Map();
    /** uid -> rank in the previous settled round, for the ▲▼ column. */
    this.prevRanks = new Map();

    /** Set while a settled leaderboard is being read, before the next round. */
    this.settleAt = 0;
    /** Which round that leaderboard belongs to — see the note in _onTick. */
    this.settleFrom = 0;
    /** Set when everyone still connected but one has finished. */
    this.graceAt = 0;
    /** roundNo -> when this client first saw that round with no scramble. */
    this._roundSeenAt = new Map();
    /** Timer that fires the settle → advance step on time rather than on tick. */
    this._settleTimer = 0;

    /**
     * null until somebody folds or unfolds the panel by hand, and then their
     * answer forever.
     *
     * Left as a plain boolean set once at creation, this was wrong the moment
     * the window changed size: a tab that opened wide and was then narrowed
     * kept an expanded sheet across the foot of a phone-width screen, and a
     * phone rotating into landscape kept it folded. Deriving it from the
     * viewport until the user overrules it is right in both directions.
     */
    this.collapsedByUser = null;
    this._tick = 0;
    this._node = null;

    /* ---- chat ----
       Always open. It briefly had a fold and an unread badge, which was a
       worse version of the same thing: the log is capped at a few lines and
       collapses to one when the room is quiet, so folding it saved almost no
       height and cost you every message you were not looking at. A chat you
       have to open is a chat nobody uses. */
    /** Last send, for the client-side cooldown. */
    this._chatSentAt = 0;
  }

  /** Folded by default below the tile breakpoint; the user's choice wins. */
  get collapsed() {
    return this.collapsedByUser ?? (innerWidth <= 860);
  }

  /* ---------------- lifecycle ---------------- */

  get inRoom() { return !!this.snap?.roomId; }
  get round() { return this.snap?.round || null; }
  get phase() { return this.snap?.meta?.phase || 'lobby'; }

  /** Everyone the room still considers present, newest-joined last. */
  livePlayers() {
    const now = Date.now();
    return Object.entries(this.snap?.players || {})
      .filter(([, p]) => !isStale(p, now))
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  }

  /**
   * Host is simply whoever joined first and is still here.
   *
   * Not a protocol and not a stored field on purpose: every client derives it
   * from the same player list, so it re-resolves the instant the host's row
   * disappears without anybody having to hold an election.
   */
  get hostUid() { return this.livePlayers()[0]?.[0] || null; }
  get isHost() { return this.hostUid === this.uid; }

  async connect(prefer = 'auto') {
    if (this.net) return;
    /* One connection attempt at a time.
     *
     * warm() and join() both ask for this, and without the guard opening the
     * drawer and pressing Join in quick succession built two transports,
     * signed in twice and left the first one listening to nothing. */
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      const net = createTransport(prefer);
      const { uid } = await net.init();
      this.net = net;
      this.kind = net.kind;
      this.uid = uid;
      net.addEventListener('room', (e) => this._onRoom(e.detail));
    })().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  /**
   * Get the connection out of the way before anybody presses a button.
   *
   * Joining a room used to pay for the whole of init() — three module
   * downloads and an anonymous sign-in — after the click, which is why
   * creating a room felt like it had not registered. Opening the race drawer
   * is a second or two ahead of the button and costs nothing if the drawer is
   * closed again, so the handshake happens there instead.
   */
  warm() {
    if (this.net || this._connecting) return;
    this.connect(this.app.settings.racePrefer || 'auto')
      .catch((err) => console.warn('[race] warm-up failed', err?.code || err));
  }

  async join(code, { name } = {}) {
    const roomId = normaliseCode(code);
    if (roomId.length < 3) throw new Error('bad-code');
    await this.connect(this.app.settings.racePrefer || 'auto');

    const nick = name || this.nickname();

    /* Cleared BEFORE the join, never after.
     *
     * net.join() delivers the room's first snapshot while it is still running,
     * and that snapshot is what restores a result you had already submitted
     * before reloading. Resetting afterwards therefore threw that answer away
     * and left the panel in a state that cannot really exist: results
     * unlocked, but no submitted round to have unlocked them. */
    this.submittedRound = 0;
    this._servedKey = '';
    this.settledRound = 0;
    this._roundSeenAt.clear();
    this._preopened = 0;
    this._prevRound = undefined;
    this._prevPhase = undefined;
    /* Restored rather than cleared. Wins are the one thing in a room that
       exists nowhere but the client that watched them happen — the snapshot
       can rebuild everything else — so clearing here meant a reload, a
       dropped socket or a rejoin reset the room to nobody having won
       anything, which is the one number people are actually keeping. */
    this.standings = this._loadStandings(roomId);
    this.prevRanks.clear();
    this.mySolves.clear();
    this._resetChat();

    await this.net.join(roomId, {
      name: nick,
      color: hueOf(nick),
      event: this.app.settings.event,
      mode: this.app.settings.mode,
    });

    /* A race is timed on the app's own clock or it is not a race. Switching
       the input source is a smaller surprise than silently letting somebody
       type their times in while other people are actually solving. */
    if (this.app.settings.inputMode !== 'timer') {
      this.app.setSetting('inputMode', 'timer');
      toast('Switched to the spacebar timer for the race', { long: true });
    }

    this.app.setSetting('raceLastRoom', roomId);

    /* The panel goes up before the session switch, not after.
     *
     * enterRaceSession creates a session, writes it and re-reads the solve
     * list, which is IndexedDB work measured in hundreds of milliseconds —
     * and it used to sit between "we are in the room" and "the room is on
     * screen". Nothing about drawing the panel needs the session, so it no
     * longer waits for it. */
    this._ensurePanel();
    this._startTicking();
    this._syncPanel();
    this.dispatchEvent(new CustomEvent('change'));

    await this.app.enterRaceSession?.(roomId);
    return roomId;
  }

  async leave() {
    if (!this.net) return;
    clearInterval(this._tick);
    this._tick = 0;
    clearTimeout(this._settleTimer);
    this._settleTimer = 0;
    await this.net.leave();
    this.snap = null;
    this.settleAt = 0;
    this.graceAt = 0;
    this.submittedRound = 0;
    this._servedKey = '';
    this._roundSeenAt.clear();
    this._preopened = 0;
    this._prevRound = undefined;
    this._prevPhase = undefined;
    this._resetChat();
    this._syncPanel();
    // Back to the session you were in, and to the app's own scrambles. The
    // session switch already pulls a fresh one, so only ask when it did not.
    const moved = await this.app.leaveRaceSession?.();
    if (!moved) this.app.nextScramble?.();
    this.dispatchEvent(new CustomEvent('change'));
  }

  nickname() {
    return this.app.settings.raceName || `Cuber ${String(this.uid || '').slice(-4).toUpperCase()}`;
  }

  /* ---------------- room updates ---------------- */

  _onRoom(snap) {
    /* Remembered here rather than read back off the snapshot.
     *
     * Both transports update the object they already handed us and then emit
     * it, so `this.snap` and `snap` are the same object and "what it said a
     * moment ago" is not a question it can answer — reading the round off it
     * before the assignment gave the NEW round every time, and the round-change
     * branch below could therefore never run. That is what stopped a reload
     * mid-round from noticing it had already submitted. */
    const prevRound = this._prevRound;
    const prevPhase = this._prevPhase;
    this.snap = snap;
    this._prevRound = this.round?.no;
    this._prevPhase = this.phase;

    /* The race was ended under us — by the host, or by this client's own
       End race. Give the timer its own scrambles back and forget the round
       we were part-way through; the standings survive, which is the whole
       reason ending is not the same thing as leaving. */
    if (prevPhase === 'racing' && this.phase === 'lobby') {
      this.settleAt = 0;
      this.graceAt = 0;
      this.settleFrom = 0;
      this.submittedRound = 0;
      this._servedKey = '';
      this.settledRound = 0;
      this._lastStatus = null;
      this._roundSeenAt.clear();
      /* The pre-opened scramble for the round after this one is still sitting
         in the database, unread. That is exactly what _end wants: it moves the
         pointer on by one precisely so a restart does not replay a round
         everybody has already solved, and the scramble waiting there is the
         one that round will use. */
      this._preopened = 0;
      this.app.nextScramble?.();
    }

    // A new round: reset the local per-round bookkeeping and put its scramble
    // on screen. Everything else follows from the snapshot.
    if (this.round && this.round.no !== prevRound) {
      this.settleAt = 0;
      this.graceAt = 0;
      this.settleFrom = 0;
      clearTimeout(this._settleTimer);
      /* Forget what the room last heard about us.
       *
       * onTimerState only writes a status that differs from the last one it
       * wrote, and the only thing that used to clear that memory was
       * submitting a result. So a round you inspected and then abandoned left
       * `_lastStatus` on 'inspecting', and in the NEXT round your inspection
       * was suppressed as a repeat — the room saw you sitting at 'waiting'
       * while you were already on the cube. */
      this._lastStatus = null;
      this._restoreOwnResult(this.round.no);
    }

    this._maybeOpenRound();
    this._evaluateRound();
    this._serveScramble();
    this._syncPanel();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * Pick up a result this client already submitted for the round.
   *
   * Reloading the page resets the in-memory bookkeeping, and without this a
   * refresh mid-round handed you the timer back for a scramble you had
   * already raced: the second attempt was recorded locally, the upload was
   * then refused by the write-once rule, and you got an error toast for
   * something that was really the app's own forgetfulness.
   */
  async _restoreOwnResult(n) {
    if (this.submittedRound === n) return;
    if (!(await this.net.hasOwnResult?.(n))) return;
    if (this.round?.no !== n) return;      // the round moved on while we asked
    this.submittedRound = n;
    this.net.unlockResults();
    /* And put the hold up. A reload mid-round comes back through here rather
       than through onSolveRecorded, so without this the tab that came back
       showed the scramble it had already raced — the same trap, reached the
       other way round. */
    this._serveScramble();
    this._syncPanel();
  }

  /** The host publishes the scramble for a round that has none yet. */
  async _maybeOpenRound() {
    const r = this.round;
    if (!r || this.phase !== 'racing') return;
    if (r.info) { this._preopenNextRound(r.no); return; }

    /* Remember when this round first showed up empty, so "the host has stopped
       answering" is a thing this client can eventually notice on its own. */
    if (!this._roundSeenAt.has(r.no)) this._roundSeenAt.set(r.no, Date.now());
    const orphaned = Date.now() - this._roundSeenAt.get(r.no) > ORPHAN_ROUND_MS;
    if (!this.isHost && !orphaned) return;

    if (this._openingRound === r.no) return;   // one attempt in flight at a time
    this._openingRound = r.no;
    try {
      const s = await this.app.makeScramble?.();
      if (!s?.scramble) return;
      // Re-check: the await above is long enough for somebody else's round to
      // have landed, and writing anyway would just lose the race in the rules.
      if (this.round?.no !== r.no || this.round?.info) return;
      await this.net.openRound(r.no, {
        scramble: s.scramble,
        hash: scrambleHash(s.scramble),
        event: this.snap.meta?.event || this.app.settings.event,
      });
    } finally {
      this._openingRound = 0;
    }
  }

  /**
   * Write the NEXT round's scramble while this one is still being raced.
   *
   * This is most of the pause people were complaining about. The old order was
   * strictly serial and every step was a round trip: the last person finishes,
   * the leaderboard is read for six seconds, the pointer is advanced, the
   * advance comes back to the host, the host generates a scramble, writes it,
   * and only then does it come back to everybody as the thing they are meant
   * to be solving. Three round trips and a scramble generation, all of it
   * after the countdown had already reached zero.
   *
   * None of it depends on the round having ended, so none of it has to happen
   * then. `rounds/<n>/info` is write-once and nothing reads a round the
   * pointer has not reached, so publishing n+1 early is invisible until the
   * pointer arrives — at which point the scramble is already there and the
   * only remaining cost is the listener that was going to be attached anyway.
   */
  async _preopenNextRound(n) {
    if (!this.isHost || this.phase !== 'racing') return;
    if (this._preopened === n + 1 || this._preopening) return;
    this._preopening = true;
    try {
      const s = await this.app.makeScramble?.();
      if (!s?.scramble) return;
      if (this.phase !== 'racing' || this.round?.no !== n) return;
      await this.net.openRound(n + 1, {
        scramble: s.scramble,
        hash: scrambleHash(s.scramble),
        event: this.snap.meta?.event || this.app.settings.event,
      });
      this._preopened = n + 1;
    } catch { /* write-once: somebody got there first, which is fine */ }
    finally { this._preopening = false; }
  }

  /**
   * What the scramble area should be showing, as a key.
   *
   * Three states, not one — see the note on `_servedKey`. The hold text is
   * part of the key so that "waiting on 3 more" becoming "waiting on 1 more"
   * redraws.
   *
   * The scramble ITSELF is in the key, and keying 'run' on the round number
   * alone was a real bug. The round's scramble is write-once on the server,
   * but what a listener hands us is not monotonic: the database client applies
   * a write locally the instant it is made and only afterwards learns the
   * server refused it. So a client that loses the race to open a round — two
   * hosts at once, a host handover, the orphan takeover — renders its OWN
   * rejected scramble first and is corrected a moment later. With the round
   * number as the key that correction never reached the screen, and the two
   * racers spent the rest of the round solving different scrambles with no way
   * back to each other.
   */
  _scrambleKey() {
    const r = this.round;
    if (!this.inRoom || this.phase !== 'racing' || !r) return 'none';
    if (this.submittedRound === r.no) return `hold:${r.no}:${this.holdText()}`;
    if (!r.info?.scramble) return `wait:${r.no}:${this.holdText()}`;
    return `run:${r.no}:${scrambleHash(r.info.scramble)}`;
  }

  /**
   * The line that stands in for the scramble when there is nothing to solve.
   *
   * Finishing first used to leave the scramble you had just raced on screen
   * with no explanation, and the natural thing to do while looking at a
   * scramble is to scramble it — so people did, and were then holding a
   * scrambled cube when the next round handed them a different one.
   */
  holdText() {
    const r = this.round;
    if (!r) return 'Getting the room ready…';
    if (this.submittedRound !== r.no) return 'Waiting for the round’s scramble…';

    const live = this.livePlayers();
    const left = live.filter(([id]) => r.progress?.[id]?.status !== 'done').length;
    if (this.settleAt) return 'Next scramble loading…';
    if (left > 0) return `Still solving: ${left} racer${left === 1 ? '' : 's'} — hold your cube, next scramble loading…`;
    return 'Next scramble loading…';
  }

  /** Put the right thing in the scramble area, and only when it changes. */
  _serveScramble() {
    const key = this._scrambleKey();
    if (key === this._servedKey) return;
    this._servedKey = key;
    if (key === 'none') return;
    this.app.nextScramble?.();
  }

  /* ---------------- hooks main.js calls ---------------- */

  /**
   * The scramble the timer should be showing, or null to let the generator
   * have its usual say. Pinned to the round for as long as the round is
   * yours to solve, and replaced by a hold the moment it is not.
   */
  takeScramble() {
    const r = this.round;
    if (!this.inRoom || this.phase !== 'racing' || !r) return null;

    /* Nothing to solve: either the round has not published its scramble yet,
       or you have already raced this one and the room has not caught up. Both
       are a message where the scramble goes, never the scramble itself — a
       scramble on screen is an instruction to scramble, and following it at
       the wrong moment is exactly the mistake this replaces. */
    if (!r.info?.scramble || this.submittedRound === r.no) {
      return { scramble: '', hold: this.holdText(), official: true, race: true, roundNo: r.no };
    }

    return {
      scramble: r.info.scramble,
      official: true,
      race: true,
      roundNo: r.no,
    };
  }

  /**
   * True while the timer must not accept another attempt: you have already
   * submitted for this round, or the round has no scramble yet.
   */
  locked() {
    if (!this.inRoom || this.phase !== 'racing') return false;
    const r = this.round;
    if (!r) return false;
    if (!r.info?.scramble) return true;
    return this.submittedRound === r.no;
  }

  /** Timer state changes become the public, time-free progress feed. */
  onTimerState(state) {
    if (!this.inRoom || this.phase !== 'racing' || this.locked()) return;
    const map = { inspecting: 'inspecting', holding: 'inspecting', ready: 'inspecting', running: 'solving' };
    const status = map[state];
    if (!status || status === this._lastStatus) return;
    this._lastStatus = status;
    this.net.setProgress({ status }).catch(() => {});
  }

  /** A finished solve becomes this round's result. */
  async onSolveRecorded(solve) {
    const r = this.round;
    if (!this.inRoom || this.phase !== 'racing' || !r?.info) return;
    if (this.submittedRound === r.no) return;
    // Only a solve of THIS round's scramble counts. Anything else is a solve
    // that happened to land while a race was open.
    if (scrambleHash(solve.scramble) !== r.info.hash) return;

    this.submittedRound = r.no;
    this._lastStatus = null;
    // Held so the row can open the solve menu on it once the round reveals.
    this.mySolves.set(r.no, solve);

    /* Straight away, and before the network is involved at all. Everything
       below is a round trip or two, and leaving the solved scramble on screen
       for the length of them is the whole window in which somebody scrambles
       their cube again by mistake. */
    this._serveScramble();

    /* Retried, because this one write is what stops the room waiting on you.
       A dropped 'done' means everybody else sits through the full grace period
       for somebody who is sitting right there having finished. */
    await this._retry(() => this.net.setProgress({ status: 'done' }), 'progress');

    try {
      await this._retry(() => this.net.submitResult({
        timeMs: Math.round(solve.timeMs),
        penalty: solve.penalty || 'none',
        hash: r.info.hash,
        suspect: this._looksSuspect(solve) || null,
      }), 'result');
    } catch (err) {
      // The rules refusing a write is information, not a crash: it means the
      // scramble or the server-observed clock gap did not line up.
      console.warn('[race] result refused', err);
      toast('The room would not accept that time', { kind: 'bad' });
    }
    // Only now does the read of everyone else's times become allowed.
    this.net.unlockResults();
    this._serveScramble();
    this._syncPanel();
  }

  /**
   * Try a write again before deciding it failed.
   *
   * The rules refuse a bad write instantly and identically to how a flaky
   * connection refuses a good one, so this cannot tell them apart — it just
   * makes the flaky case survive, at the cost of two pointless retries in the
   * genuinely-refused case, which is a trade worth making for two writes the
   * rest of the room is waiting on.
   */
  async _retry(fn, label) {
    let last;
    for (let i = 0; i <= RETRY_MS.length; i++) {
      try { return await fn(); }
      catch (err) {
        last = err;
        if (i === RETRY_MS.length) break;
        console.warn(`[race] ${label} write failed, retrying`, err?.code || err);
        await new Promise(res => setTimeout(res, RETRY_MS[i]));
      }
    }
    throw last;
  }

  /**
   * Heuristic only, and labelled as such wherever it is shown.
   *
   * A time far under your own rolling average is exactly what a personal best
   * looks like, so this never blocks anything — it puts a mark next to the row
   * and lets the room draw its own conclusions.
   */
  _looksSuspect(solve) {
    const avg = bestAvg(this.app.solves || [], 12).value;
    if (!avg || !isFinite(avg)) return false;
    return solve.timeMs < avg * SUSPECT_RATIO;
  }

  /* ---------------- round settling ---------------- */

  _startTicking() {
    clearInterval(this._tick);
    // One second is plenty: everything on this clock is a countdown people
    // read, not anything the timing of a solve depends on.
    this._tick = setInterval(() => this._onTick(), 1000);

    /* A backgrounded tab's interval is throttled to about once a minute, and
       a phone with the screen off stops running it at all. Coming back is
       therefore the one moment where every clock in here is definitely stale,
       so catch all of them up at once rather than waiting out a tick. */
    if (!this._onShow) {
      this._onShow = () => { if (!document.hidden) this._onTick(); };
      document.addEventListener('visibilitychange', this._onShow);
    }
  }

  _onTick() {
    if (!this.inRoom) return;
    // A host that stopped answering, or a round whose scramble never landed,
    // is only ever noticed on a clock — no snapshot arrives to say so.
    this._maybeOpenRound();
    this._evaluateRound();
    this._serveScramble();
    this._syncPanel();
  }

  /**
   * Decide whether the round is over, and move it on when it is.
   *
   * Called from the snapshot as well as the tick. It used to be tick-only,
   * which put up to a second of dead air on each end of the settle: a second
   * before the leaderboard appeared, and another before the next round was
   * asked for. Both ends are now driven by the thing that caused them, and
   * the tick is what covers the cases that no event announces — the grace
   * period expiring, and a player going silent rather than leaving.
   */
  _evaluateRound() {
    const r = this.round;
    if (!this.inRoom || !r || this.phase !== 'racing') return;

    const live = this.livePlayers();
    const done = live.filter(([id]) => r.progress?.[id]?.status === 'done');
    const everyone = live.length > 0 && done.length === live.length;
    const someone = done.length > 0;

    // The grace clock starts the moment the first person finishes, and only
    // matters if somebody never does.
    if (someone && !everyone && !this.graceAt) this.graceAt = Date.now() + GRACE_MS;
    if (everyone) this.graceAt = 0;

    const graceUp = this.graceAt && Date.now() >= this.graceAt;

    if ((everyone || graceUp) && this.settledRound !== r.no) {
      this.settledRound = r.no;
      this.settleAt = Date.now() + SETTLE_MS;
      this.settleFrom = r.no;
      this._settle(r);
      /* Scheduled, not waited for. The tick below is still a backstop, but on
         a foreground tab this is what makes the next round arrive when the
         countdown says it will rather than up to a second afterwards. */
      clearTimeout(this._settleTimer);
      this._settleTimer = setTimeout(() => this._advanceIfSettled(), SETTLE_MS + 20);
    }

    if (this.settleAt && Date.now() >= this.settleAt) this._advanceIfSettled();
  }

  /**
   * Move the room on to the round after the one that settled.
   *
   * Advance from the round that actually settled, not from whatever the
   * current round happens to be when this fires. Every client runs this clock,
   * so two of them settle a moment apart. Reading the live round here meant
   * the slower client could wake up after the faster one had already moved the
   * room on, compute "current + 1", and advance again — skipping a round
   * outright and handing everybody a scramble nobody raced. Pinning it to the
   * settled round makes the second attempt a no-op instead, which is what the
   * advance-by-exactly-one guard was always meant to catch.
   *
   * Kept armed until the round number actually changes. Zeroing the settle the
   * moment the transaction was *sent* meant a single dropped write left the
   * room parked on a finished round with nothing left to retry it — the state
   * people described as the race simply stopping.
   */
  _advanceIfSettled() {
    const from = this.settleFrom;
    if (!from || !this.settleAt || Date.now() < this.settleAt) return;
    if (this.round?.no !== from) { this._clearSettle(); return; }
    if (this._advancing) return;
    this._advancing = true;
    Promise.resolve(this.net.advanceRound(from + 1))
      .catch(err => console.warn('[race] advance failed, will retry', err?.code || err))
      .finally(() => {
        this._advancing = false;
        // A transaction that ran and did nothing (somebody else moved us on
        // first) looks exactly like one that failed. The snapshot is the only
        // honest answer, and if it says we are still here the tick tries again.
        if (this.round?.no !== from) this._clearSettle();
      });
  }

  _clearSettle() {
    this.settleAt = 0;
    this.settleFrom = 0;
    this.graceAt = 0;
    clearTimeout(this._settleTimer);
    this._settleTimer = 0;
  }

  /* ---------------- standings, kept across reloads ---------------- */

  _standingsKey(roomId = this.snap?.roomId) { return `race:standings:${roomId}`; }

  /**
   * Per room, and only in this browser. It is a scoreboard for the visit, not
   * a record: putting it in the database would need write rules of its own,
   * and a tally anybody in the room can write to is a tally anybody in the
   * room can forge.
   */
  _loadStandings(roomId) {
    try {
      const raw = JSON.parse(localStorage.getItem(this._standingsKey(roomId)) || '{}');
      return new Map(Object.entries(raw));
    } catch { return new Map(); }
  }

  _saveStandings() {
    if (!this.snap?.roomId) return;
    try {
      localStorage.setItem(this._standingsKey(), JSON.stringify(Object.fromEntries(this.standings)));
    } catch { /* a blocked or full store costs the scoreboard, not the race */ }
  }

  /** Fold a finished round into the standings, and celebrate if it was yours. */
  _settle(r) {
    const ranked = this.ranked(r);
    this.prevRanks = new Map(this.standings.size ? [...this.standings].map(([k, v]) => [k, v.lastRank]) : []);

    ranked.forEach((row, i) => {
      const s = this.standings.get(row.uid) || { name: '', wins: 0, played: 0, best: null, lastRank: null };
      s.played += 1;
      /* Carried on the entry so the table can still name somebody who has
         since left. The player list only holds people who are still here,
         and a winner who closed their tab should not vanish from the board. */
      s.name = row.player?.name || s.name;
      const e = effOf(row.result);
      if (isFinite(e) && (s.best == null || e < s.best)) s.best = e;
      if (i === 0 && row.result && e !== Infinity) s.wins += 1;
      s.lastRank = i + 1;
      this.standings.set(row.uid, s);
    });
    this._saveStandings();

    const mine = ranked.findIndex(x => x.uid === this.uid);
    if (mine === 0 && ranked.length > 1) this._celebrate();
  }

  _celebrate() {
    const motion = this.app.settings.motion;
    if (motion === 'off') { toast('You won the round', { kind: 'good', long: true }); return; }
    const c = themeColors();
    shockwave(c.gold);
    confetti([c.accent, c.accent2, c.gold, c.ok, c.text],
      { count: motion === 'reduced' ? 50 : 110, power: 1 });
    flash(c.gold);
    if (this.app.settings.soundOnPB) chime();
    toast('You won the round', { kind: 'good', long: true });
  }

  /* ---------------- derived view ---------------- */

  /** Whether this client has earned the right to see other people's times. */
  get revealed() {
    const r = this.round;
    return !!r && this.submittedRound === r.no;
  }

  /**
   * Every player, in the order the panel should draw them.
   *
   * Before the reveal that is join order — anything else would leak the
   * finishing order, which is a time signal by another name. After it, rank.
   */
  ranked(round = this.round) {
    const r = round;
    const rows = this.livePlayers().map(([uid, p]) => {
      const prog = r?.progress?.[uid] || null;
      const result = this.revealed ? (r?.results?.[uid] || null) : null;
      return {
        uid, player: p,
        isMe: uid === this.uid,
        isHost: uid === this.hostUid,
        status: prog?.status || 'waiting',
        result,
        eff: effOf(result),
        standing: this.standings.get(uid) || null,
        clockOff: this._clockMismatch(prog, result),
      };
    });

    if (!this.revealed) return rows;
    return rows.sort((a, b) => {
      const ax = a.eff ?? Number.MAX_SAFE_INTEGER;
      const bx = b.eff ?? Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });
  }

  /**
   * Does the submitted time agree with the gap the server itself timed?
   *
   * The two progress stamps are written by the server, so a client cannot
   * move them. A fabricated time is very unlikely to match them; a real one
   * always will, once you allow for the round-trips that bracket it.
   */
  _clockMismatch(prog, result) {
    if (!prog?.startedAt || !prog?.finishedAt || !result) return false;
    const observed = prog.finishedAt - prog.startedAt;
    if (!(observed > 0)) return false;
    const claimed = result.timeMs;
    const slack = CLOCK_SLACK_MS + observed * CLOCK_SLACK_RATIO;
    // Only ever flags a time that is too SHORT for the window it happened in.
    // A long window is just somebody with a slow connection.
    return claimed < observed - slack;
  }

  /* ---------------- panel ---------------- */

  _ensurePanel() {
    if (this._node?.isConnected) return this._node;
    const host = document.getElementById('sidebar-right') || document.getElementById('sidebar');
    if (!host) return null;

    const node = el('section', {
      class: 'panel', id: 'panel-race', dataset: { tile: 'race' }, hidden: true,
    });
    node.innerHTML = `
      <button class="tile-grip" type="button" title="Drag to move — drop on a highlighted zone to dock" aria-label="Move this panel">
        <svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="1.5"/><circle cx="15" cy="7" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="17" r="1.5"/><circle cx="15" cy="17" r="1.5"/></svg>
      </button>
      <button class="panel-head as-btn race-head" type="button" aria-expanded="true">
        <span class="race-title">
          <svg class="race-flag" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4.2"/><path d="M5 4.2h13l-2.6 4 2.6 4H5z"/></svg>
          Race
        </span>
        <span class="panel-sub race-code"></span>
        <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="race-body">
        <div class="race-meter"><i></i></div>
        <div class="race-status"></div>
        <div class="race-rows" role="list"></div>
        <button class="race-more" type="button" hidden></button>
        <div class="race-board" hidden></div>
        <div class="race-foot"></div>
        <div class="race-chat">
          <div class="race-chat-head"><span class="race-chat-label">Chat</span></div>
          <div class="race-chat-log" role="log" aria-live="polite" aria-label="Room chat"></div>
          <div class="race-emoji" hidden role="group" aria-label="Emoji"></div>
          <form class="race-chat-form">
            <button class="race-chat-emoji" type="button" title="Emoji" aria-label="Emoji" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0"/></svg>
            </button>
            <input class="race-chat-input" type="text" autocomplete="off"
                   maxlength="${CHAT_MAX_LEN}" placeholder="Say something…" aria-label="Message the room">
            <button class="race-chat-send" type="submit" title="Send" aria-label="Send">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h13M12 5l7 7-7 7"/></svg>
            </button>
          </form>
        </div>
        <div class="race-actions"></div>
      </div>`;
    host.append(node);
    this._node = node;

    node.querySelector('.race-head').addEventListener('click', (e) => {
      // The grip lives inside the header; dragging it must not fold the panel.
      if (e.target.closest('.tile-grip')) return;
      this.collapsedByUser = !this.collapsed;
      this._syncPanel();
    });

    /* The chat is wired ONCE, here, and never rebuilt.
     *
     * Everything else in this panel is thrown away and redrawn from the
     * snapshot, which is fine for rows and fatal for a text field: a rebuild
     * between two keystrokes eats what you had typed and the caret with it.
     * Only the log's contents and the input's disabled state are touched by
     * the render — see _chat. */
    const chat = node.querySelector('.race-chat');
    chat.querySelector('.race-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this._sendChat();
    });

    /* Enter sends, said explicitly rather than left to the form's implicit
       submission.
     *
     * A <form> with a submit button gives that for free, and it would very
     * probably have worked — but "probably" is doing real work in a document
     * that installs capture-phase keydown handlers on itself and swallows
     * whole keystrokes to protect the timer. One handler growing a new early
     * branch is all it would take, and the failure is silent: the box just
     * stops sending and nobody can say when it started.
     *
     * stopPropagation goes with it so a message ending in a shortcut letter
     * cannot also fire that shortcut. */
    chat.querySelector('.race-chat-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      this._sendChat();
    });

    this._wireEmoji(chat);

    // Crossing the breakpoint changes which layout this panel is in, and with
    // it what "folded" should default to.
    addEventListener('resize', () => this._syncPanel());

    this.app.registerRaceTile?.();
    return node;
  }

  _syncPanel() {
    const node = this._node;
    if (!node) return;
    const on = this.inRoom;
    node.hidden = !on;
    node.dataset.collapsed = String(this.collapsed);
    // The top-bar flag is the one piece of chrome that survives the panel
    // being folded, docked away or hidden behind a phone's bottom sheet.
    document.getElementById('btn-race')?.classList.toggle('live', on);

    /* Appearing and disappearing is a layout event, not a repaint.
     *
     * Whether a rail is displayed at all, and which grid columns the stage
     * has, are decided by applyTheme from what is actually visible in each
     * rail — and refreshLayout only re-measures, it never asks that question
     * again. So a panel that showed up after boot landed in a rail whose
     * width had been computed without it: the race card drew over the stats
     * card and the scramble preview, and only a reload put it right. Ask the
     * layout to be recomputed on the two ticks where the answer changed. */
    if (on !== this._lastOn) {
      this._lastOn = on;
      this.app.registerRaceTile?.();
    }

    if (!on) { this.app.refreshLayout?.(); return; }
    this._render(node);
    /* Outside _render, and outside its signature guard.
     *
     * _render is throttled on a signature built from the rows, so a message
     * arriving while nothing else changed would not have redrawn anything —
     * and a message is exactly the kind of thing that arrives while nothing
     * else is changing. */
    this._syncChat();
    this.app.refreshLayout?.();
  }

  /**
   * Everything that changes what the rows look like, as one short string.
   *
   * The panel is driven by a one-second tick, and rebuilding the row list on
   * every one of them was wrong in three separate ways: the reveal animation
   * restarted each second, a button could be replaced between the press and
   * the release, and text could never be selected because the node holding it
   * did not survive long enough. Countdowns still update every tick — they are
   * written into the foot, which is cheap and holds nothing you can interact
   * with mid-second.
   */
  _sig(rows) {
    return [
      this.snap.roomId, this.phase, this.round?.no, this.revealed, this._expanded, this.collapsed,
      this.isHost,
      ...rows.map(x => `${x.uid}:${x.status}:${x.eff ?? ''}:${x.standing?.wins ?? 0}:${x.clockOff ? 1 : 0}`),
    ].join('|');
  }

  _render(node) {
    const r = this.round;
    const rows = this.ranked();
    const live = rows.length;
    const done = rows.filter(x => x.status === 'done').length;

    // The foot carries the countdowns, so it is redrawn every tick regardless.
    const sig = this._sig(rows);
    const same = sig === this._lastSig;
    this._lastSig = sig;
    if (same) { this._foot(node.querySelector('.race-foot'), { rows, done, live }); return; }

    node.querySelector('.race-code').textContent = this.snap.roomId || '';

    /* The meter is the pressure. It says how much of the room is already
       finished and nothing whatsoever about how fast any of them were — which
       is exactly the information you are allowed to have mid-solve. */
    const meter = node.querySelector('.race-meter i');
    meter.style.width = live ? `${Math.round((done / live) * 100)}%` : '0%';
    node.querySelector('.race-meter').dataset.state =
      this.revealed ? 'revealed' : done ? 'pressure' : 'idle';

    /* ---- status line ---- */
    const status = node.querySelector('.race-status');
    status.innerHTML = '';
    if (this.phase === 'lobby') {
      status.append(
        el('span', { class: 'race-round', text: 'Lobby' }),
        el('span', { class: 'race-count', text: `${live} / ${ROOM_MAX} here` }),
      );
    } else {
      status.append(
        el('span', { class: 'race-round', text: `Round ${r?.no ?? 1}` }),
        el('span', { class: 'race-count', text: `${done} of ${live} done` }),
      );
    }

    /* ---- rows ---- */
    const host = node.querySelector('.race-rows');
    host.innerHTML = '';
    const shown = this.collapsed && innerWidth <= 860 ? [] : rows;
    const fold = this._expanded ? shown.length : Math.min(shown.length, ROWS_BEFORE_FOLD);
    shown.slice(0, fold).forEach((row, i) => host.append(this._row(row, i)));

    const more = node.querySelector('.race-more');
    const hidden = shown.length - fold;
    more.hidden = hidden <= 0 && !this._expanded;
    more.textContent = this._expanded ? 'show fewer' : `+${hidden} more`;
    more.onclick = () => { this._expanded = !this._expanded; this._syncPanel(); };

    /* ---- standings ---- */
    this._board(node.querySelector('.race-board'));

    /* ---- foot ---- */
    this._foot(node.querySelector('.race-foot'), { rows, done, live });

    /* ---- room controls ---- */
    this._actions(node.querySelector('.race-actions'));
  }

  /**
   * The two ways out of a room, where you are already looking.
   *
   * Leaving used to mean opening the race drawer and finding the button in
   * it, and ending a race was not a thing you could do at all — a room that
   * had started racing kept handing out scrambles until the last person shut
   * their tab. Rebuilt only from _render, which the signature guards, so
   * neither button is ever replaced between a press and a release.
   */
  _actions(host) {
    if (!host) return;
    host.innerHTML = '';

    if (this.phase === 'racing' && this.isHost) {
      host.append(el('button', {
        class: 'btn', text: 'End race',
        title: 'Take the whole room back to the lobby — standings are kept',
        onclick: async () => {
          if (!await confirmToast('End the race for everyone in the room?', 'end it')) return;
          await this._end();
        },
      }));
    }

    host.append(el('button', {
      class: 'btn danger', text: 'Leave room',
      title: 'Leave this room and go back to your own session',
      onclick: async () => {
        if (!await confirmToast(`Leave room ${this.snap?.roomId || ''}?`, 'leave')) return;
        await this.leave();
        toast('Left the room');
      },
    }));
  }

  /* ---------------- chat ---------------- */

  /** Everything currently on the wire, oldest first. */
  get chatLog() { return this.snap?.chat || []; }

  /**
   * Build the emoji tray once, and open it under the composer on demand.
   *
   * A fixed grid rather than the platform picker, because there is no
   * platform picker to reach: `emojipicker` is Chrome-on-ChromeOS only, and
   * every cross-browser answer is a dependency measured in hundreds of
   * kilobytes to put twenty characters into a text field. These are the ones
   * a cubing room actually sends.
   */
  _wireEmoji(chat) {
    const tray = chat.querySelector('.race-emoji');
    const btn = chat.querySelector('.race-chat-emoji');
    const input = chat.querySelector('.race-chat-input');

    for (const ch of RACE_EMOJI) {
      tray.append(el('button', {
        class: 'race-emoji-btn', type: 'button', text: ch, title: ch,
        onclick: () => {
          /* Inserted at the caret, not appended. Appending is only ever right
             when the caret happens to be at the end, and it is not right when
             somebody goes back to drop a 🔥 into the middle of a sentence. */
          const at = input.selectionStart ?? input.value.length;
          const to = input.selectionEnd ?? at;
          input.value = input.value.slice(0, at) + ch + input.value.slice(to);
          const caret = at + ch.length;
          input.setSelectionRange(caret, caret);
          /* Focus goes back to the field, so the tray is a detour rather than
             a destination — pick one, keep typing. */
          input.focus();
        },
      }));
    }

    btn.addEventListener('click', () => {
      if (tray.hidden) this._openEmoji(); else this._closeEmoji();
    });

    /* Click-away and Escape, because a tray that only closes via the button
       that opened it is a tray people leave open by accident. Bound on the
       document once, and harmless while hidden. */
    document.addEventListener('click', (e) => {
      if (tray.hidden) return;
      if (e.target.closest('.race-emoji') || e.target.closest('.race-chat-emoji')) return;
      this._closeEmoji();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !tray.hidden) this._closeEmoji();
    });
  }

  _openEmoji() {
    const chat = this._node?.querySelector('.race-chat');
    if (!chat) return;
    chat.querySelector('.race-emoji').hidden = false;
    chat.querySelector('.race-chat-emoji').setAttribute('aria-expanded', 'true');
  }

  _closeEmoji() {
    const chat = this._node?.querySelector('.race-chat');
    if (!chat) return;
    const tray = chat.querySelector('.race-emoji');
    if (tray.hidden) return;
    tray.hidden = true;
    chat.querySelector('.race-chat-emoji').setAttribute('aria-expanded', 'false');
  }

  /**
   * Forget the last room's log.
   *
   * `_chatSig` is the one that has to be cleared rather than merely being
   * tidy: it is a cache key over the message ids, and two rooms whose logs
   * are both empty produce the same key — so without this, walking out of one
   * room and into another left the previous room's messages painted on the
   * panel until somebody said something new.
   */
  _resetChat() {
    this._chatSig = null;
    this._chatSentAt = 0;
    const input = this._node?.querySelector('.race-chat-input');
    if (input) input.value = '';
    this._closeEmoji();
  }

  async _sendChat() {
    const node = this._node;
    const input = node?.querySelector('.race-chat-input');
    if (!input) return;
    const body = cleanChat(input.value);
    if (!body) { input.value = ''; return; }

    /* A cooldown rather than a queue. Holding Enter down is the only way
       anybody hits this, and the honest answer to that is to drop the extra
       presses on the floor, not to send them a moment later. */
    if (Date.now() - this._chatSentAt < CHAT_COOLDOWN_MS) return;
    this._chatSentAt = Date.now();

    /* Cleared before the write, not after.
     *
     * The round trip is a few hundred milliseconds and people type into the
     * next message during it; clearing on the way back would wipe whatever
     * they had started. If the send fails the text goes back, which is the
     * only case where anybody wants it back. */
    input.value = '';
    this._closeEmoji();
    try {
      await this.net.sendChat(body);
    } catch (err) {
      input.value = body;
      const code = err?.code || String(err || '');
      console.warn('[race] chat refused', code);
      /* PERMISSION_DENIED here means one specific thing almost every time:
         the database is running rules that predate chat, so the write falls
         through to the root's ".write": false. Saying so is the difference
         between a five-minute fix and an afternoon spent reading this file —
         "Could not send that" sent exactly one person hunting for a bug in
         code that was working. */
      toast(String(code).includes('PERMISSION_DENIED')
        ? 'The room refused that — this database is running rules from before chat existed. Publish firebase.rules.json.'
        : 'Could not send that', { long: true });
    }
  }

  /**
   * Draw the log, and nothing else.
   *
   * Deliberately never touches the input or the form: those are built once in
   * _ensurePanel and live for as long as the panel does, because a text field
   * replaced between two keystrokes loses what you typed and the caret with
   * it.
   */
  _syncChat() {
    const node = this._node;
    const wrap = node?.querySelector('.race-chat');
    if (!wrap) return;

    const log = this.chatLog;

    const host = wrap.querySelector('.race-chat-log');
    const sig = log.map(m => m.id).join(',');
    if (sig === this._chatSig) return;
    this._chatSig = sig;

    /* Pinned to the bottom unless the reader has scrolled up to look at
       something, in which case yanking them back down is rude. */
    const pinned = host.scrollTop + host.clientHeight >= host.scrollHeight - 24;

    host.innerHTML = '';
    if (!log.length) {
      host.append(el('div', { class: 'race-chat-empty', text: 'Nothing said yet.' }));
    } else {
      let lastUid = null;
      for (const m of log) {
        /* Consecutive messages from one person drop the name. In a rail this
           narrow the name is most of the line, and repeating it four times
           for four short messages leaves no room for the messages. */
        const runOn = m.uid === lastUid;
        lastUid = m.uid;
        const row = el('div', {
          class: `race-chat-msg${runOn ? ' run-on' : ''}`,
          dataset: { me: String(m.uid === this.uid) },
          title: m.at ? new Date(m.at).toLocaleTimeString() : '',
        },
          runOn ? null : el('b', { class: 'race-chat-who', text: m.name || 'Cuber' }),
          el('span', { class: 'race-chat-text', text: m.text || '' }),
        );
        // setProperty, not the style object: Object.assign skips custom
        // properties, which is why every name would have come out the same hue.
        row.style.setProperty('--av-h', String(hueOf(m.name || '')));
        host.append(row);
      }
    }
    if (pinned) host.scrollTop = host.scrollHeight;
  }

  /**
   * Back to the lobby, for everybody.
   *
   * The round pointer moves on as well as the phase. A round's scramble is
   * write-once and a result is write-once per player, so restarting on the
   * same round number would have replayed a scramble everyone had already
   * raced and then had their times refused by the rules. Both fields are
   * written in one update, which is also the only way the "exactly one" rule
   * on `round` will accept it.
   */
  async _end() {
    const n = this.round?.no || 1;
    this.settleAt = 0;
    this.graceAt = 0;
    this.settleFrom = 0;
    await this.net.setMeta({ phase: 'lobby', round: n + 1 });
    toast('Race ended — back in the lobby', { long: true });
  }

  /**
   * The scoreboard for the visit: who has won how many, and who is still here.
   *
   * Separate from the rows on purpose. The rows are this round — they change
   * every few seconds and go blank between scrambles, which is what made a
   * win look like it had been taken away the moment the next round opened.
   * This survives the round, the reload and the player leaving.
   */
  _board(host) {
    if (!host) return;
    const entries = [...this.standings.entries()]
      .filter(([, s]) => s.played > 0)
      .sort((a, b) => b[1].wins - a[1].wins
        || (a[1].best ?? Infinity) - (b[1].best ?? Infinity)
        || b[1].played - a[1].played);

    host.hidden = entries.length === 0;
    if (host.hidden) { host.innerHTML = ''; return; }

    const present = new Set(this.livePlayers().map(([uid]) => uid));
    host.innerHTML = '';
    host.append(el('div', { class: 'race-board-head' },
      el('span', { text: 'Standings' }),
      el('span', { text: `${entries.length} racer${entries.length === 1 ? '' : 's'}` }),
    ));

    entries.forEach(([uid, s], i) => {
      const line = el('div', {
        class: 'race-board-row',
        dataset: { me: String(uid === this.uid), gone: String(!present.has(uid)) },
      });
      line.append(
        el('span', { class: 'race-board-rank', text: String(i + 1) }),
        el('span', { class: 'race-board-name', text: s.name || 'Cuber',
          title: present.has(uid) ? s.name : `${s.name || 'Cuber'} — no longer in the room` }),
        el('span', { class: 'race-board-best', text: s.best != null && isFinite(s.best) ? fmt(s.best) : '—' }),
        el('span', { class: 'race-board-wins', text: `${s.wins}/${s.played}`,
          title: `${s.wins} won of ${s.played} round${s.played === 1 ? '' : 's'}` }),
      );
      host.append(line);
    });
  }

  _row(row, i) {
    const { player, isMe, isHost, status, result, standing } = row;
    const hue = player.color ?? hueOf(player.name || '');
    const state = this.revealed && result ? (result.penalty === 'DNF' ? 'dnf' : 'revealed')
      : status === 'done' ? 'locked'
      : status;

    /* Won or lost, once the round is readable. The rank number carries the
       same fact without colour, which is the point — the green/red is the
       fast read, not the only one. */
    const outcome = this.revealed && result
      ? (i === 0 && effOf(result) !== Infinity ? 'win' : 'loss')
      : '';

    const node = el('div', {
      class: 'race-row', role: 'listitem',
      dataset: { state, me: String(isMe), outcome },
      style: { animationDelay: `${Math.min(i, 8) * 45}ms` },
    });
    // Object.assign onto a style declaration drops custom properties on the
    // floor — they only exist through setProperty.
    node.style.setProperty('--av-h', String(hue));

    /* Rank only once it means something. Before the reveal these rows are in
       join order, and numbering them would imply a standing that does not
       exist yet. */
    node.append(el('span', { class: 'race-rank', text: this.revealed && result ? String(i + 1) : '' }));

    /* Host is a ring on the avatar rather than a chip next to the name.
       A rail is about 200px wide, and "host" and "you" as two text chips left
       roughly five pixels for the name — which is every room's creator, so the
       common case was a row you could not read. The ring costs no width. */
    node.append(el('span', {
      class: `race-av${isHost ? ' host' : ''}`,
      text: initialsOf(player.name),
      title: isHost ? `${player.name} — publishes each round’s scramble` : player.name,
    }));

    /* No "you" chip. The row already carries an accent background and border
       for data-me, which reads faster than a word does, and the chip was
       competing for a ~200px rail against the name, the time and the delta —
       the wins badge ended up painting 12px on top of the time. The row
       highlight says it for free. */
    /* Standings while the round is live; times once it is revealed.
       A revealed row's value is as wide as "12.34 ▼47.65", which leaves the
       name track too narrow to hold a wins badge as well — it was being
       clipped to an unreadable stub. Splitting it by phase means each piece
       gets the room when it is the thing you are actually reading. */
    const name = el('span', { class: 'race-name' },
      el('b', { text: player.name || 'Cuber' }),
      !this.revealed && standing?.wins
        ? el('i', { class: 'race-wins', text: `${standing.wins}W`, title: `${standing.wins} round${standing.wins === 1 ? '' : 's'} won` })
        : null,
    );
    node.append(name);

    node.append(this._value(row, state));

    /* Your own row opens the ordinary solve menu — penalty, comment, delete.
       Race solves land in a real session like any other, so they were always
       editable from the times list; this just puts the menu where you are
       already looking. Only ever your own, and only the saved solve: the
       result in the room is write-once by rule, so a +2 you add here corrects
       your session and cannot rewrite a round other people have already read. */
    const mine = isMe && this.mySolves.get(this.round?.no);
    if (mine && this.revealed) {
      node.classList.add('editable');
      node.title = 'Edit this solve — penalty, comment, delete';
      node.addEventListener('click', () => this.app.solveMenu?.(mine, node));
    }
    return node;
  }

  /** The right-hand column: a badge until it has earned the right to be a time. */
  _value(row, state) {
    const wrap = el('span', { class: 'race-val' });
    const { result } = row;

    if (state === 'revealed' || state === 'dnf') {
      const shown = result.penalty === 'DNF' ? 'DNF'
        : fmt(result.timeMs) + (result.penalty === '+2' ? '+' : '');
      wrap.append(el('b', { class: 'race-time', text: shown }));

      // Delta against your own time, with a glyph as well as a colour — a
      // colour on its own is not a difference everybody can see.
      const mine = this.round?.results?.[this.uid];
      const a = effOf(result), b = effOf(mine);
      if (!row.isMe && mine && isFinite(a) && isFinite(b)) {
        const d = a - b;
        wrap.append(el('i', {
          class: `race-delta ${d < 0 ? 'faster' : d > 0 ? 'slower' : 'tie'}`,
          text: d === 0 ? '=' : `${d < 0 ? '▼' : '▲'}${fmt(Math.abs(d))}`,
        }));
      }
      if (result.suspect || row.clockOff) {
        wrap.append(el('i', {
          class: 'race-flagmark', text: '⚑',
          title: row.clockOff
            ? 'The submitted time is shorter than the window the server timed it in'
            : 'Far faster than this player’s own recent average',
        }));
      }
      return wrap;
    }

    const label = {
      locked:     ['finished', 'They are done. You will see the time when you are.'],
      solving:    ['solving', 'Currently solving'],
      inspecting: ['inspecting', 'In inspection'],
      waiting:    ['waiting', 'Has not started this scramble'],
    }[state] || ['waiting', ''];

    wrap.append(el('i', { class: 'race-badge', text: label[0], title: label[1] }));
    if (state === 'locked') {
      wrap.append(icon('<path d="M7 11V8a5 5 0 0110 0v3"/><rect x="5" y="11" width="14" height="9" rx="2"/>',
        'race-lock'));
    }
    return wrap;
  }

  _foot(foot, { done, live }) {
    /* Same reasoning as _sig, and it matters more here: the foot is where the
       only buttons in the panel live. Rebuilt blindly every tick, "Start
       racing" was destroyed and recreated a second at a time, so a click that
       landed on the wrong side of a rebuild hit a node already on its way out
       and did nothing at all. The countdowns are in the signature, so they
       still update — and while one is running there is no button to lose. */
    const secs = this.settleAt ? Math.ceil((this.settleAt - Date.now()) / 1000)
      : this.graceAt ? Math.ceil((this.graceAt - Date.now()) / 1000)
      : null;
    const sig = [this.phase, this.revealed, done, live, secs,
      !!this.round?.info?.scramble, this.isHost, this.kind].join('|');
    if (sig === this._lastFootSig) return;
    this._lastFootSig = sig;

    foot.innerHTML = '';

    if (this.phase === 'lobby') {
      const ready = live >= 2;
      foot.append(el('div', { class: 'race-note', text: ready
        ? 'Everyone here gets the same scramble. Start when you are ready.'
        : 'Share the code — racing starts when the host says go.' }));
      if (this.isHost) {
        foot.append(el('button', {
          class: 'btn primary full', text: live >= 2 ? 'Start racing' : 'Start anyway',
          onclick: () => this._start(),
        }));
      } else {
        foot.append(el('div', { class: 'race-wait', text: 'Waiting for the host…' }));
      }
      return;
    }

    if (!this.round?.info?.scramble) {
      foot.append(el('div', { class: 'race-wait',
        text: `Round ${this.round?.no ?? 1} scramble loading…` }));
      return;
    }

    if (!this.revealed) {
      foot.append(el('div', { class: 'race-note strong', text: done
        ? `${done} ${done === 1 ? 'person has' : 'people have'} finished. Times unlock when you do.`
        : 'Solve the scramble to unlock the room’s times.' }));
    } else if (this.settleAt) {
      const left = Math.max(0, Math.ceil((this.settleAt - Date.now()) / 1000));
      foot.append(el('div', { class: 'race-next' },
        el('span', { text: 'Next scramble in ' }), el('b', { text: `${left}s` })));
    } else if (this.graceAt) {
      const left = Math.max(0, Math.ceil((this.graceAt - Date.now()) / 1000));
      foot.append(el('div', { class: 'race-note',
        text: `Waiting on ${live - done} more — ${left}s. Keep your cube solved.` }));
    } else {
      foot.append(el('div', { class: 'race-note',
        text: 'Waiting for the rest of the room — keep your cube solved.' }));
    }

    if (this.kind === 'local') {
      foot.append(el('div', { class: 'race-local', text: 'Local room — this browser only, and nothing here is enforced.' }));
    }
  }

  /**
   * Leave the lobby.
   *
   * Only the phase is written here. Publishing the scramble is deliberately
   * left to _maybeOpenRound, which the snapshot that comes back will trigger:
   * writing the round with a placeholder first would burn its write-once
   * `info` slot and leave the round permanently without a scramble.
   */
  async _start() {
    await this.net.setMeta({ phase: 'racing' });
  }
}

/* =========================================================
   Singleton
   ========================================================= */
let instance = null;

export function getRace(app) {
  if (!instance) {
    instance = new Race(app);
    // Reachable from the console the same way `window.tagdatimer` is. A race
    // is a distributed thing that only misbehaves with two clients up, and
    // being able to read one side's state while the other is mid-solve is the
    // difference between diagnosing that and guessing at it.
    app.raceCtl = instance;
  }
  return instance;
}

/* Re-exported so the drawer only ever has to import this one module — the
   transport and the tuning constants stay an implementation detail. */
export { cloudAvailable } from './race-net.js';
export { ROOM_MAX } from './raceapp.js';
export { hueOf, initialsOf };
