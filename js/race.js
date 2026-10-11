import { t } from './i18n.js';
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
import { toast, confirmToast, choiceToast } from './toast.js';
import { eventOf } from './events.js';
import { bestAvg, summarize } from './stats.js';
import { shockwave, confetti, flash, chime } from './fx.js';
import { themeColors } from './theme.js';
import { createTransport, cloudAvailable, scrambleHash, isStale, cleanChat } from './race-net.js';
import {
  CODE_ALPHABET, CODE_LENGTH,
  CLOCK_SLACK_MS, CLOCK_SLACK_RATIO,
  CHAT_MAX_LEN, CHAT_COOLDOWN_MS, RACE_EMOJI,
  MATCH_EVENT,
} from './raceapp.js';
import { isOwnerName, openOwnerCard } from './ownercard.js';
import { getConfig, loadConfig, readOnlyText } from './config.js';
import { hasFeature } from './audience.js';

/* Tuning from the admin console (config/race); the defaults are raceapp.js's. */
const tune = (k) => getConfig('race', k);

/* Random 1v1's (config/duel, ADMIN.md §4), in ms. The defaults are raceapp.js's
   MATCH_* constants. A seat is never called abandoned inside two of its own
   re-stamps, whatever the two settings say, or a waiting player would be
   taken over between stamps. */
const duelMs = (k) => getConfig('duel', k) * 1000;
const matchStaleMs = () => Math.max(duelMs('staleSec'), 2 * duelMs('refreshSec') + 1000);
/** Random 1v1 for this account: switched on, and in its audience. */
export const duelOn = () => getConfig('duel', 'enabled') && hasFeature('duel');
export const duelOffText = () => getConfig('duel', 'message') || t('Random 1v1 is switched off for now');
import { banActive, banLine } from './admins.js';
import { hasPersistedSession } from './sync-auth.js';

const FLAG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4m0 0h10l-2 4 2 4H6"/></svg>';

/** Why nobody can post in a room right now (config/raceChat, ADMIN.md), or null. */
const chatOff = () => (getConfig('raceChat', 'enabled') ? null
  : getConfig('raceChat', 'message') || t('Room chat is switched off for now'));

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
 * finished round vanishes when it expires — it is kept (see _settle), stays
 * on the race panel as the last round until a newer one replaces it, and is a
 * column in the Race stats panel for the rest of the visit — so this is only
 * how long the scramble area waits before handing you the next one to pick up.
 */
const SETTLE_MS = 700;

/**
 * How long a finished round waits for the last finisher's time to arrive.
 *
 * Their 'done' is written before their result, so "everyone is done" is
 * usually true a round trip before every time is readable. Settling on the
 * first meant the round was kept without the time that decided it. Bounded,
 * because a time that never comes must not hold the room up.
 */
const RESULTS_WAIT_MS = 2500;

/** Rounds kept per room before the oldest are folded into the tally. */
const HISTORY_MAX = 200;

/** Racers the last-round card lists before it points at the Race stats panel. */
const LAST_MAX = 4;

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th, 21st. */
const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

/**
 * The same, in a 1v1. A room's leaderboard is a list you glance at; a 1v1's
 * result is the moment itself — who took the round and by how much — and at
 * 0.7 s it was gone before anybody had read it. The round's result stays on
 * the panel after this anyway (the "last round" banner), so this is only the
 * beat before the next scramble.
 */
const DUEL_SETTLE_MS = 3000;

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
  // A relay is several puzzles behind one time, so there is nothing for a
  // room to agree on: one scramble is not what everyone would be solving.
  return !ev.fmc && !ev.multi && !ev.relay;
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

    /** uid -> { name, wins, played, best, lastRank, ... } for this room, worked out from `history`. */
    this.standings = new Map();
    /** Every finished round in this room, oldest first — see _loadHistory. */
    this.history = [];
    /** The tally from before rounds were kept, or from rounds trimmed off the end. */
    this.baseStandings = {};
    /** roundNo -> the solve this client saved for it, so a row can edit it. */
    this.mySolves = new Map();

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

    /* ---- random 1v1 (RACE.md §8) ----
       `match` is the search: idle | searching | joining | none (a minute
       went by with nobody). `_duel` is the 1v1 once you are in its room. */
    this.match = { state: 'idle' };
    this._duel = null;
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

  async join(code, { name, kind } = {}) {
    const roomId = normaliseCode(code);
    if (roomId.length < 3) throw new Error('bad-code');
    await this.connect(this.app.settings.racePrefer || 'auto');
    // The admin console's read-only switch: a race writes every round (ADMIN.md §4).
    await loadConfig();
    if (readOnlyText()) throw new Error('read-only');

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
    this._keptUnsub?.();
    this._keptUnsub = null;
    this._loadHistory(roomId);
    this._allDoneAt = 0;
    this.mySolves.clear();
    this._resetChat();

    await this.net.join(roomId, {
      name: nick,
      color: hueOf(nick),
      event: this.app.settings.event,
      mode: this.app.settings.mode,
      kind,
    });
    // After a reload too: the last round you raced can still take a late penalty.
    if (this.history.length) this._watchKept(this.history.at(-1));

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

    // Every random 1v1 shares one session, rather than one per stranger.
    await this.app.enterRaceSession?.(roomId, kind === 'duel' ? t('1v1 · 3x3') : undefined);
    return roomId;
  }

  async leave() {
    if (!this.net) return;
    clearInterval(this._tick);
    this._tick = 0;
    clearTimeout(this._settleTimer);
    this._settleTimer = 0;
    clearTimeout(this._waitTimer);
    this._keptUnsub?.();
    this._keptUnsub = null;
    // Camera and mic off before anything else: leaving must never leave either lit.
    this._cam?.stop();
    this._cam = null;
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
    this._duel = null;
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
    /* The round object as last seen, kept for the same reason: once the
       pointer moves, the snapshot only holds the new round, and the old one's
       progress is what a round this tab never got to settle is kept from. */
    const prevObj = this._roundObj;
    this.snap = snap;
    this._prevRound = this.round?.no;
    this._prevPhase = this.phase;
    this._roundObj = this.round;

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
      this._allDoneAt = 0;
      this._restoreOwnResult(this.round.no);

      /* The room moved on. If another tab's clock settled it before this
         one did, keep it now from what was last seen; and either way, a round
         kept with a time still missing reads that time once, directly. */
      if (prevObj && prevObj.no === prevRound && prevPhase === 'racing' && this.phase === 'racing') {
        if (prevObj.info && this.settledRound !== prevObj.no) {
          this.settledRound = prevObj.no;
          this._settle(prevObj);
        }
        this._backfill(prevObj.no);
      }
    }

    /* A time that lands after its round was kept, while the round is still
       the live one: patch it in rather than leave the round short. */
    const kept = this.history.at(-1);
    if (kept?.pending && kept.no === this.round?.no && this._patch(kept, this.round.results)) {
      this._restand();
      this._maybeCelebrate(kept);
    }

    if (this._applyMod()) return;

    this._maybeOpenRound();
    this._evaluateRound();
    this._serveScramble();
    this._duelWatch();
    this._syncPanel();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /* ---------------- a moderator's marks (rooms/<id>/mod) ----------------
   *
   * Set from the admin console (ADMIN.md, "Race rooms and 1v1"): the room
   * closed, somebody removed from it, a time struck. The rules already refuse
   * a closed room's writes and a removed player's; this is the app saying so
   * and getting out of the way. A struck time counts for nothing anywhere:
   * not in the round, not in the standings, not in Race stats.
   */

  /** Whether round n's time from uid was struck. */
  _isStruck(n, uid) { return !!this.snap?.mod?.struck?.[n]?.[uid]; }

  /** Leaves (and says why) when the room was closed or this tab removed from it. True if it left. */
  _applyMod() {
    const mod = this.snap?.mod;
    if (this.inRoom && this.net?.kind !== 'local' && (mod?.closed || mod?.kicked?.[this.uid])) {
      if (this._modLeaving) return true;
      this._modLeaving = true;
      const why = mod.closed ? t('A moderator closed this room') : t('A moderator removed you from this room');
      this.leave().then(() => toast(why, { kind: 'bad', long: true }), () => {}).finally(() => { this._modLeaving = false; });
      return true;
    }
    // Struck since it was kept: out of the kept round, and the standings worked out again.
    let changed = false;
    for (const entry of this.history) {
      for (const row of entry.rows) {
        const struck = this._isStruck(entry.no, row.uid);
        if (struck && !row.struck) { row.struck = true; row.res = null; changed = true; }
        else if (!struck && row.struck) { row.struck = false; entry.pending = entry.seen; changed = true; }
      }
    }
    if (changed) {
      this._restand();
      for (const entry of this.history) if (entry.pending) this._backfill(entry.no);
    }
    return false;
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
    if (!this._canPublish()) return;

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
   * A 1v1 is 3x3, and the scramble comes from the publisher's own generator:
   * somebody who switched event mid-match leaves it to the other side (the
   * orphan takeover above), rather than handing both of them a 4x4.
   */
  _canPublish() {
    return !this.isDuel || this.app.settings.event === MATCH_EVENT;
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
    if (!this.isHost || this.phase !== 'racing' || !this._canPublish()) return;
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
    if (!r) return t('Getting the room ready…');
    if (this.submittedRound !== r.no) return t('Waiting for the round’s scramble…');

    const live = this.livePlayers();
    const left = live.filter(([id]) => r.progress?.[id]?.status !== 'done').length;
    if (this.settleAt) return t('Next scramble loading…');
    if (left > 0) return t(left === 1 ? 'Still solving: {n} racer — hold your cube, next scramble loading…' : 'Still solving: {n} racers — hold your cube, next scramble loading…', { n: left });
    return t('Next scramble loading…');
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

    // Presence retries can outlive a round or a room. Keep the original round
    // and refuse to send an old result after the user leaves or joins another.
    const net = this.net, roomId = this.snap.roomId;
    const send = (fn) => {
      if (this.net !== net || this.snap?.roomId !== roomId) throw new Error('race-room-changed');
      return fn();
    };

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
    // A refused presence update must not discard a locally saved result.
    // Results are separately validated by the transport/database.
    try { await this._retry(() => send(() => net.setProgress({ status: 'done' }, r.no)), 'progress'); }
    catch (err) { console.warn('[race] progress refused', err); }

    const sent = solve.penalty || 'none';
    let landed = false;
    this._submittingRound = r.no;
    try {
      await this._retry(() => send(() => net.submitResult({
        timeMs: Math.round(solve.timeMs),
        penalty: sent,
        hash: r.info.hash,
        suspect: this._looksSuspect(solve) || null,
      }, r.no)), 'result');
      landed = true;
    } catch (err) {
      // The rules refusing a write is information, not a crash: it means the
      // scramble or the server-observed clock gap did not line up.
      console.warn('[race] result refused', err);
      toast('The room would not accept that time', { kind: 'bad' });
    } finally {
      if (this._submittingRound === r.no) this._submittingRound = 0;
    }
    /* A +2 or DNF pressed while the time was still on its way: the solve
       object is the one the times list edits, so it already says so. */
    if (landed && (solve.penalty || 'none') !== sent) this.onPenalty(solve);
    // Only now does the read of everyone else's times become allowed.
    if (this.net !== net || this.snap?.roomId !== roomId) return;
    if (landed && this.round?.no === r.no) net.unlockResults();
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
    return solve.timeMs < avg * (tune('suspectPct') / 100);
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
    this._duelWatch();
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
    const allDone = live.length > 0 && done.length === live.length;
    const someone = done.length > 0;

    /* Everyone is done — but if this tab can read the times, wait (briefly)
       until it actually has them, so the round is kept with the time that
       decided it. See RESULTS_WAIT_MS. */
    if (allDone && !this._allDoneAt) this._allDoneAt = Date.now();
    if (!allDone) this._allDoneAt = 0;
    const timesIn = !this.revealed || done.every(([id]) => r.results?.[id]);
    const everyone = allDone && (timesIn || Date.now() - this._allDoneAt >= RESULTS_WAIT_MS);
    if (allDone && !everyone) {
      clearTimeout(this._waitTimer);
      this._waitTimer = setTimeout(() => this._evaluateRound(), RESULTS_WAIT_MS + 20);
    }

    // The grace clock starts the moment the first person finishes, and only
    // matters if somebody never does.
    if (someone && !everyone && !this.graceAt) this.graceAt = Date.now() + tune('graceSec') * 1000;
    if (everyone) this.graceAt = 0;

    const graceUp = this.graceAt && Date.now() >= this.graceAt;

    /* Everyone done is not everyone's time in. The last to finish learns that
       it was the last from its own 'done', a round trip before the others'
       results reach it, and settling then scored the round with nobody's time
       in it: no winner on that side, and a 1v1 score that disagreed with the
       other side's. Wait for the times, but not forever — a result the rules
       refused never arrives. */
    const missing = this.revealed && done.some(([id]) => !r.results?.[id]);
    if (!everyone || !missing) this._timesWait = null;
    else if (this._timesWait?.n !== r.no) this._timesWait = { n: r.no, until: Date.now() + 3000 };
    const ready = everyone && (!missing || Date.now() >= this._timesWait.until);

    if ((ready || graceUp) && this.settledRound !== r.no) {
      this.settledRound = r.no;
      const settleMs = this.isDuel ? DUEL_SETTLE_MS : SETTLE_MS;
      this.settleAt = Date.now() + settleMs;
      this.settleFrom = r.no;
      this._settle(r);
      /* Scheduled, not waited for. The tick below is still a backstop, but on
         a foreground tab this is what makes the next round arrive when the
         countdown says it will rather than up to a second afterwards. */
      clearTimeout(this._settleTimer);
      this._settleTimer = setTimeout(() => this._advanceIfSettled(), settleMs + 20);
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

  /* ---------------- random 1v1 (RACE.md §8) ----------------

     One waiting seat, rooms/_1v1_333/meta/waiting = { uid, code, at }, changed
     only by transaction. Looking for an opponent is one decision, made
     atomically against whatever is in the seat:

       somebody else is waiting (fresh)  → take it: { ...their seat, takenBy: me }
       our own code, already taken       → leave it; the watcher has seen it
       anything else (empty, stale, done) → sit in it with our own code

     Two people pressing at once therefore cannot both take the same seat or
     both sit in it: the transaction retries the loser against the winner's
     write. Nobody is in a room while waiting — the room is created by
     whichever of the two arrives first once the seat says they are matched. */

  get isDuel() { return this.snap?.meta?.kind === 'duel'; }

  /** The other person in this 1v1, as last seen: { uid, name }, or null. */
  get opponent() { return this._duel?.opp || null; }

  /** Rounds won in this 1v1, yours and theirs. */
  duelScore() {
    const opp = this.opponent;
    return {
      me: this.standings.get(this.uid)?.wins || 0,
      them: opp ? this.standings.get(opp.uid)?.wins || 0 : 0,
    };
  }

  _matchChanged() {
    this.dispatchEvent(new CustomEvent('match', { detail: this.match }));
  }

  /** Look for a random 3x3 opponent for a minute. */
  async findMatch() {
    if (this.inRoom || ['connecting', 'searching', 'joining'].includes(this.match.state)) return;
    if (this.app.settings.event !== MATCH_EVENT) throw new Error('not-333');

    /* Searching from the click, not from the end of the handshake: signing in
       and reading the settings is a second or so, and a button that does
       nothing for that long gets pressed again. The minute starts now too. */
    const span = duelMs('searchSec');
    const m = { state: 'connecting', code: randomCode(), span, endsAt: Date.now() + span };
    this.match = m;
    this._matchChanged();
    try {
      await this.connect(this.app.settings.racePrefer || 'auto');
      await loadConfig();
      if (!getConfig('race', 'enabled')) throw new Error('race-off');
      if (readOnlyText()) throw new Error('read-only');
      if (!duelOn()) throw new Error('duel-off');
    } catch (err) {
      if (this.match === m) { this.match = { state: 'idle' }; this._matchChanged(); }
      throw err;
    }
    // Cancelled while connecting.
    if (this.match !== m || this.inRoom) return;
    m.state = 'searching';
    m.unwatch = this.net.watchMatch((seat) => {
      if (this._takenFromMe(seat, m)) this._matched(m, m.code);
    });
    // Re-stamped while waiting, so the seat never looks abandoned while we are here.
    m.refresh = setInterval(() => this._matchTick(m), duelMs('refreshSec'));
    // The countdown the drawer shows, and the end of the minute.
    m.clock = setInterval(() => {
      if (Date.now() >= m.endsAt) this._giveUp(m); else this._matchChanged();
    }, 1000);
    this._matchChanged();
    await this._matchTick(m);
  }

  _takenFromMe(seat, m) {
    return !!seat && seat.code === m.code && !!seat.takenBy && seat.takenBy !== this.uid;
  }

  async _matchTick(m) {
    if (this.match !== m || m.state !== 'searching' || m.busy) return;
    m.busy = true;
    const me = this.uid;
    try {
      const now = this.net.serverNow();
      const seat = await this.net.matchTransact((cur) => {
        if (cur?.code === m.code && cur.takenBy) return undefined;
        const waiting = cur && !cur.takenBy && cur.uid !== me && now - (cur.at || 0) < matchStaleMs();
        if (waiting) return { uid: cur.uid, code: cur.code, at: cur.at, takenBy: me, takenAt: now };
        return { uid: me, code: m.code, at: now };
      });
      if (seat?.takenBy === me && seat.code !== m.code) { this._matched(m, seat.code); return; }
      if (this._takenFromMe(seat, m)) { this._matched(m, m.code); return; }
      if (seat?.uid === me && seat.code === m.code && !m.armed && this.match === m) {
        m.armed = true;
        this.net.armMatchDrop(true);
      }
    } catch (err) {
      // Refused (switched off since, or a dropped socket): the next tick tries again.
      console.warn('[race] 1v1 seat refused', err?.code || err);
      // The rules refuse the seat while Random 1v1 is off (ADMIN.md §4): ask the settings again, and stop if so.
      if (/permission/i.test(String(err?.code || err?.message || err))) {
        await loadConfig({ maxAge: 0 });
        if (!duelOn() && this.match === m && m.state === 'searching') {
          await this._leaveSeat(m);
          this.match = { state: 'idle' };
          this._matchChanged();
          toast(duelOffText(), { kind: 'bad', long: true });
        }
      }
    } finally {
      m.busy = false;
    }
  }

  _stopSearch(m) {
    clearInterval(m.refresh);
    clearInterval(m.clock);
    m.unwatch?.();
    m.unwatch = null;
    if (m.armed) { m.armed = false; this.net.armMatchDrop(false); }
  }

  /* Out of the seat, then stop watching it, in that order. The SDK runs a
     transaction against what it holds for the path, and once nothing listens
     it holds nothing: the clear saw an empty seat, gave up without asking the
     server, and left this tab sitting in it for whoever searched next. */
  async _leaveSeat(m) {
    clearInterval(m.refresh);
    clearInterval(m.clock);
    try { return await this._clearSeat(m); }
    catch { return null; }
    finally { this._stopSearch(m); }
  }

  /** Out of the seat, unless somebody has just taken it. Resolves to the seat after. */
  _clearSeat(m) {
    const me = this.uid;
    return this.net.matchTransact((cur) =>
      (cur?.uid === me && cur.code === m.code && !cur.takenBy ? null : undefined));
  }

  async _matched(m, code) {
    if (this.match !== m || m.state !== 'searching') return;
    this._stopSearch(m);
    m.state = 'joining';
    this._matchChanged();
    try {
      await this.join(code, { kind: 'duel' });
      toast(this.opponent ? t('Matched with {name}', { name: this.opponent.name }) : t('Opponent found'), { kind: 'good' });
    } catch (err) {
      console.error('[race] 1v1 join failed:', err);
      toast(this.matchErrorText(err), { kind: 'bad' });
    }
    if (this.match === m) this.match = { state: 'idle' };
    this._matchChanged();
  }

  /** A minute with nobody: say so, and offer the next minute. */
  async _giveUp(m) {
    if (this.match !== m || m.state !== 'searching') return;
    m.state = 'ending';
    const seat = await this._leaveSeat(m);
    if (this.match !== m) return;
    // Taken in the last instant: that is a match, not a miss.
    if (this._takenFromMe(seat, m)) { m.state = 'searching'; this._matched(m, m.code); return; }
    this.match = { state: 'none', span: m.span };
    this._matchChanged();
    toast(m.span === 60000 ? t('Couldn’t find anyone in the last minute.') : t('Couldn’t find anyone in the last {n} seconds.', { n: Math.round(m.span / 1000) }), {
      action: t('Try again'), long: true,
      onAction: () => this.findMatch().catch(err => toast(this.matchErrorText(err), { kind: 'bad' })),
    });
  }

  async cancelMatch() {
    const m = this.match;
    if (m.state === 'connecting') { this.match = { state: 'idle' }; this._matchChanged(); return; }
    if (m.state === 'searching') {
      this.match = { state: 'idle' };
      this._matchChanged();
      await this._leaveSeat(m);
      return;
    }
    if (m.state === 'none') { this.match = { state: 'idle' }; this._matchChanged(); }
  }

  matchErrorText(err) {
    const why = err?.message;
    return why === 'not-333' ? t('Random 1v1 is 3x3 only — switch to 3x3 first')
      : why === 'race-off' ? (getConfig('race', 'message') || t('New race rooms are switched off for now'))
      : why === 'duel-off' ? duelOffText()
      : why === 'read-only' ? (readOnlyText() || t('Could not look for an opponent'))
      : why === 'no-config' ? t('Real rooms are not configured — see RACE.md')
      : why === 'room-full' ? t('That 1v1 already has two people in it')
      : t('Could not look for an opponent');
  }

  /**
   * The 1v1's own rules, on top of an ordinary room: it starts by itself the
   * moment both of you are in, and it is over the moment one of you is gone.
   * Called on every snapshot and every tick.
   */
  _duelWatch() {
    if (!this.inRoom || !this.isDuel) return;
    const d = (this._duel ||= { since: Date.now(), opp: null, goneAt: 0, started: false, over: false });
    if (d.over) return;
    const live = this.livePlayers();
    const opp = live.find(([id]) => id !== this.uid);

    if (opp) {
      d.opp = { uid: opp[0], name: opp[1].name || 'Cuber' };
      d.goneAt = 0;
      this.linkAccount();
      this._ensureCam(d.opp);
      // Both sides write it; the same value twice is harmless.
      if (this.phase === 'lobby' && !d.started) {
        d.started = true;
        this._start().catch(() => { d.started = false; });
      }
      return;
    }

    /* Gone: their row was removed (Quit, or the tab closed) or went silent.
       A short wait first, because a phone changing network drops the row
       for a few seconds and then writes it back. */
    if (d.opp) {
      d.goneAt ||= Date.now();
      if (Date.now() - d.goneAt >= duelMs('goneSec')) this._duelOver('left');
    } else if (Date.now() - d.since >= duelMs('showupSec')) {
      this._duelOver('noshow');
    }
  }

  /**
   * This tab's 1v1 seat tied to the Google account signed in to the timer
   * (rooms/<id>/acct/<uid>, RACE.md §9). A race seat is anonymous, one per
   * tab, so the account vouches for it: the seat claims the account, then the
   * account confirms the claim. Cam and mic need it while duel.camSignedIn is
   * on, and a report on the opponent is sent from it. Once per room unless
   * `again` (just signed in).
   *
   * Resolves 'linked'; 'signed-out'; 'refused' (the account may not: a ban);
   * or 'old-rules' (the claim itself refused: rules from before the link,
   * which gate nothing, so the app does not either).
   */
  linkAccount(again = false) {
    const room = this.snap.roomId;
    if (!again && this._link?.room === room) return this._link.p;
    const p = (async () => {
      if (!hasPersistedSession()) return 'signed-out';
      try {
        const { getDatabaseHandle } = await import('./sync-auth.js');
        const sdk = await getDatabaseHandle();
        await sdk.auth.authStateReady?.();
        const user = sdk.auth.currentUser;
        if (!user) return 'signed-out';
        try { await this.net.acctClaim(user.uid); } catch (err) {
          console.warn('[race] link claim refused', err?.code || err?.message || err);
          return 'old-rules';
        }
        try { await sdk.set(sdk.ref(sdk.db, `rooms/${room}/acct/${this.uid}/ok`), true); } catch (err) {
          console.warn('[race] link refused', err?.code || err?.message || err);
          return 'refused';
        }
        return 'linked';
      } catch (err) {
        console.warn('[race] link', err);
        return 'old-rules';
      }
    })();
    this._link = { room, p, state: 'pending' };
    p.then((state) => {
      if (this._link?.p !== p) return;
      this._link.state = state;
      this._cam?.redraw();
    });
    return p;
  }

  /** linkAccount's answer for this room so far: 'pending' until it has one. */
  get linkState() { return this._link?.room === this.snap.roomId ? this._link.state : 'pending'; }

  /**
   * Report the opponent to the admins (reports/, kind 'duel'), as the Google
   * account linked to this seat: for something wrong on their cam or mic, an
   * offensive name or chat, or times that cannot be real. The rules want the
   * reporter's own linked seat in the same room, so only a player can.
   */
  async _reportOpponent() {
    const opp = this.opponent;
    const room = this.snap.roomId;
    if (!opp || !room) return;
    const reason = await choiceToast(t('Report {name} to the admins? What happened?', { name: opp.name || 'Cuber' }), [
      { label: t('Cam or mic'), value: 'Cam or mic' },
      { label: t('Name or chat'), value: 'Name or chat' },
      { label: t('Cheating'), value: 'Cheating' },
      { label: t('Something else'), value: 'Something else' },
    ], { timeout: 15000 });
    if (!reason) return;
    try {
      if ((await this.linkAccount()) !== 'linked') throw new Error('not-linked');
      const [{ getDatabaseHandle }, { sendReport }] = await Promise.all([import('./sync-auth.js'), import('./moderation.js')]);
      const sdk = await getDatabaseHandle();
      // In English for the admins, with what was going on when it was sent.
      const media = this._cam?.remoteMedia || {};
      const text = [reason, opp.name || 'Cuber', `round ${this.round?.no ?? 1}`,
        media.cam ? 'their cam on' : null, media.mic ? 'their mic on' : null].filter(Boolean).join(' · ');
      const out = await sendReport(sdk, { kind: 'duel', path: `rooms/${room}/players/${opp.uid}`, text, room, from: this.uid });
      toast(out === 'already' ? t('You have already reported them') : t('Reported. An admin will look at it.'));
    } catch (err) {
      console.warn('[race] duel report refused', err?.code || err?.message || err);
      toast(t('Couldn’t send the report'), { kind: 'bad' });
    }
  }

  /**
   * The 1v1's cam and mic (race-cam.js, RACE.md §9), fetched the first time a
   * 1v1 has somebody in it. Nothing is opened here: both switches start off.
   */
  async _ensureCam(opp) {
    // Switched off from the admin console (duel.camEnabled): no new call. One already up carries on.
    if (!this._cam && !getConfig('duel', 'camEnabled')) return;
    if (!this._cam) {
      if (this._camLoading) return;
      this._camLoading = true;
      try {
        const { DuelCam } = await import('./race-cam.js');
        this._cam ||= new DuelCam(this);
      } catch (err) {
        console.warn('[race] cam unavailable', err);
        return;
      } finally {
        this._camLoading = false;
      }
    }
    if (!this.inRoom || !this.isDuel) return;
    const host = this._node?.querySelector('.race-cam');
    if (host) this._cam.mount(host);
    this._cam.start(opp);
  }

  async _duelOver(why) {
    const d = this._duel;
    if (!d || d.over) return;
    d.over = true;
    const { me, them } = this.duelScore();
    const name = d.opp?.name || 'Cuber';
    await this.leave();
    const again = () => this.findMatch().catch(err => toast(this.matchErrorText(err), { kind: 'bad' }));
    if (why === 'noshow') {
      // Matched with a tab that closed in the same instant: just keep looking.
      toast(t('Your opponent never showed up — looking again'), { long: true });
      again();
      return;
    }
    toast(t('{name} left the 1v1. Final score: you {me} – {them} {name}', { name, me, them }), {
      action: t('Find another'), onAction: again, long: true,
    });
  }

  /* ---------------- every round, kept across reloads ----------------
   *
   * Each finished round is kept whole — who raced it and every time this tab
   * was allowed to see — and the standings are worked out from that list
   * rather than tallied as the rounds go by. A tally can only ever be as right
   * as the moment it was taken, and the moment a round settles is exactly
   * when the last finisher's time has usually not arrived yet: their 'done'
   * is written before their result. Kept as rounds, a late time just patches
   * the round it belongs to and the standings are worked out again.
   *
   * Per room, and only in this browser. It is a scoreboard for the visit, not
   * a record: putting it in the database would need write rules of its own,
   * and a tally anybody in the room can write to is a tally anybody in the
   * room can forge.
   */

  _historyKey(roomId = this.snap?.roomId) { return `race:rounds:${roomId}`; }
  _standingsKey(roomId = this.snap?.roomId) { return `race:standings:${roomId}`; }

  _loadHistory(roomId) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this._historyKey(roomId)) || 'null'); } catch {}
    if (Array.isArray(saved?.rounds)) {
      this.baseStandings = saved.base || {};
      this.history = saved.rounds;
    } else {
      /* A room joined before rounds were kept: its old tally becomes the
         starting point, so nobody's wins vanish on the way across. */
      try { this.baseStandings = JSON.parse(localStorage.getItem(this._standingsKey(roomId)) || '{}'); }
      catch { this.baseStandings = {}; }
      this.history = [];
    }
    this._restand(false);
  }

  _saveHistory() {
    if (!this.snap?.roomId) return;
    try {
      localStorage.setItem(this._historyKey(),
        JSON.stringify({ base: this.baseStandings, rounds: this.history }));
      // Still written, so a tab on the previous version reads the same tally.
      localStorage.setItem(this._standingsKey(), JSON.stringify(Object.fromEntries(this.standings)));
    } catch { /* a blocked or full store costs the scoreboard, not the race */ }
  }

  /** Just what a table needs from a result. */
  static slim(res) {
    return res ? { timeMs: res.timeMs, penalty: res.penalty || 'none' } : null;
  }

  /** uid -> place in a kept round. Only people with a time are placed; DNFs go last. */
  static places(entry) {
    const out = new Map();
    entry.rows.filter(x => x.res)
      .sort((a, b) => { const x = effOf(a.res), y = effOf(b.res); return x === y ? 0 : x < y ? -1 : 1; })
      .forEach((x, i) => out.set(x.uid, i + 1));
    return out;
  }

  /** Add one kept round to a standings map. */
  static fold(st, entry) {
    const places = Race.places(entry);
    for (const row of entry.rows) {
      const s = st.get(row.uid) || { name: '', wins: 0, played: 0, best: null, lastRank: null };
      s.played += 1;
      /* Carried on the entry so the table can still name somebody who has
         since left. The player list only holds people who are still here,
         and a winner who closed their tab should not vanish from the board. */
      s.name = row.name || s.name;
      const e = effOf(row.res);
      if (Number.isFinite(e)) {
        if (s.best == null || e < s.best) s.best = e;
        s.sum = (s.sum || 0) + e;
        s.timed = (s.timed || 0) + 1;
      }
      const p = places.get(row.uid);
      if (p) {
        s.placeSum = (s.placeSum || 0) + p;
        s.placed = (s.placed || 0) + 1;
        if (p === 1 && Number.isFinite(e)) s.wins += 1;
      }
      s.lastRank = p ?? null;
      st.set(row.uid, s);
    }
  }

  /** Work the standings out again from the kept rounds. */
  _restand(save = true) {
    const st = new Map(Object.entries(this.baseStandings || {}).map(([k, v]) => [k, { ...v }]));
    for (const entry of this.history) Race.fold(st, entry);
    this.standings = st;
    this._histVer = (this._histVer || 0) + 1;
    if (save) this._saveHistory();
  }

  /**
   * A round as this tab saw it: everyone who was in it, whether they finished,
   * and their time if this tab had earned the right to read it.
   */
  _entryFor(r) {
    const seen = this.submittedRound === r.no;
    const rows = this.livePlayers().map(([uid, p]) => ({
      uid, name: p.name || '', color: p.color ?? null,
      done: r.progress?.[uid]?.status === 'done',
      res: seen && !this._isStruck(r.no, uid) ? Race.slim(r.results?.[uid]) : null,
      struck: this._isStruck(r.no, uid),
    }));
    const entry = { no: r.no, at: Date.now(), seen, rows, mine: this.mySolves.get(r.no)?.id || null };
    // Somebody who finished and has since closed their tab still raced it.
    if (seen) this._patch(entry, r.results);
    entry.pending = Race.missing(entry);
    return entry;
  }

  /** A round this tab could read, with somebody's time still on its way. */
  static missing(entry) {
    return entry.seen && entry.rows.some(x => x.done && !x.res && !x.struck);
  }

  /** Patch a kept round with times that arrived after it was kept. */
  _patch(entry, results) {
    let changed = false;
    for (const [uid, res] of Object.entries(results || {})) {
      const row = entry.rows.find(x => x.uid === uid);
      if (this._isStruck(entry.no, uid)) {
        if (row && !row.struck) { row.struck = true; row.res = null; changed = true; }
        continue;
      }
      const next = Race.slim(res);
      // A time that is already there only changes by its penalty — see setPenalty.
      if (row?.res && row.res.timeMs === next.timeMs && row.res.penalty === next.penalty) continue;
      if (row) { row.res = next; row.done = true; }
      else entry.rows.push({ uid, name: this.standings.get(uid)?.name || 'Cuber', color: null, done: true, res: Race.slim(res) });
      changed = true;
    }
    entry.pending = Race.missing(entry);
    return changed;
  }

  /** Keep a finished round, and celebrate if it was yours. */
  _settle(r) {
    if (this.history.some(h => h.no === r.no)) return;
    const entry = this._entryFor(r);
    this.history.push(entry);
    /* Bounded, without losing anything that counts: a round that falls off
       the end is folded into the starting tally first. */
    while (this.history.length > HISTORY_MAX) {
      const st = new Map(Object.entries(this.baseStandings || {}));
      Race.fold(st, this.history.shift());
      this.baseStandings = Object.fromEntries(st);
    }
    this._restand();
    this._maybeCelebrate(entry);
    this._watchKept(entry);
  }

  /**
   * Keep reading the newest kept round until there is a newer one.
   *
   * A penalty added after the time went in (onPenalty) lands on a round the
   * room has often already left — you stop, the round moves on 0.7 s later,
   * and then you press +2 — and the live listener went with the round. One
   * extra listener, on one round, swapped as each round is kept.
   */
  _watchKept(entry) {
    this._keptUnsub?.();
    this._keptUnsub = null;
    if (!entry.seen || !this.net?.watchResults) return;
    this._keptUnsub = this.net.watchResults(entry.no, (results) => {
      if (!this.history.includes(entry) || !this._patch(entry, results)) return;
      this._restand();
      this._syncPanel();
    });
  }

  /**
   * The penalty on one of your own race solves changed after it was submitted.
   *
   * The room's copy is write-once except for this one field, which the rules
   * let you make heavier at any time and lighter only for 15 s afterwards. A
   * change made while the submit is still in flight is picked up at the end of
   * onSolveRecorded instead, since there is nothing to change yet.
   */
  async onPenalty(solve) {
    if (!this.inRoom || !solve?.id || !this.net?.setPenalty) return;
    let n = null;
    for (const [no, s] of this.mySolves) if (s.id === solve.id) n = no;
    n ??= this.history.find(h => h.mine === solve.id)?.no ?? null;
    if (n == null || this._submittingRound === n) return;
    const p = solve.penalty || 'none';
    try {
      await this.net.setPenalty(n, p);
    } catch (err) {
      console.warn('[race] penalty refused', err?.code || err);
      toast(t('The room kept your earlier penalty — it can only be lightened in the first 15 seconds'), { kind: 'bad', long: true });
      return;
    }
    // This tab's own copy at once, rather than after the listener comes round.
    const h = this.history.find(x => x.no === n);
    if (h && this._patch(h, { [this.uid]: { ...(h.rows.find(x => x.uid === this.uid)?.res || { timeMs: solve.timeMs }), penalty: p } })) {
      this._restand();
    }
    this._syncPanel();
  }

  /**
   * The live listener for a round goes the moment the room moves on. A round
   * kept with a time missing gets one read of its own instead — allowed by
   * the same rule, since this tab raced it.
   */
  async _backfill(no) {
    const entry = this.history.find(h => h.no === no);
    if (!entry?.pending || this._filling?.has(no)) return;
    (this._filling ||= new Set()).add(no);
    try {
      const res = await this.net?.fetchResults?.(no);
      if (!this.history.includes(entry)) return;   // left the room meanwhile
      if (res) this._patch(entry, res);
      // Whatever is still missing now is missing for good: stop asking.
      entry.pending = false;
      this._restand();
      this._maybeCelebrate(entry);
      this._syncPanel();
    } finally {
      this._filling.delete(no);
    }
  }

  /** Once a round is complete, and only once. */
  _maybeCelebrate(entry) {
    if (entry.pending || entry.cele) return;
    entry.cele = true;
    this._saveHistory();
    const mine = entry.rows.find(x => x.uid === this.uid);
    if (entry.rows.length > 1 && Race.places(entry).get(this.uid) === 1 && Number.isFinite(effOf(mine?.res))) {
      this._celebrate();
    }
  }

  /** A 1v1's rounds, oldest first: { no, me, them } with each side's result or null. */
  get duelRounds() {
    const opp = this.opponent;
    if (!opp) return [];
    const of = (h, uid) => h.rows.find(x => x.uid === uid)?.res || null;
    return this.history.map(h => ({ no: h.no, me: of(h, this.uid), them: of(h, opp.uid) }));
  }

  /* ---------------- the 1v1's own view ---------------- */

  /** "11.23", "11.23+", "DNF", or "—" for a round that side never finished. */
  static resText(res) {
    if (!res) return '—';
    if (res.penalty === 'DNF') return 'DNF';
    return fmt(res.timeMs + (res.penalty === '+2' ? 2000 : 0)) + (res.penalty === '+2' ? '+' : '');
  }

  /** Who took a recorded round: 'me', 'them', 'tie', or '' when neither finished it. */
  static roundWinner(x) {
    const a = effOf(x.me), b = effOf(x.them);
    const fa = a != null && isFinite(a), fb = b != null && isFinite(b);
    if (!fa && !fb) return '';
    if (fa && !fb) return 'me';
    if (fb && !fa) return 'them';
    return a < b ? 'me' : b < a ? 'them' : 'tie';
  }

  /**
   * The head-to-head card that stands in for the rows in a 1v1: both players
   * with what each is doing (or their time, once the round is readable), the
   * score between them, and the last round's result underneath — kept up for
   * the whole of the next round, so a result is never only a flash.
   */
  _duelBoard(rows) {
    const opp = this.opponent;
    const meRow = rows.find(x => x.isMe);
    const themRow = rows.find(x => !x.isMe);
    const { me, them } = this.duelScore();
    const lead = me > them ? 'me' : them > me ? 'them' : '';

    const side = (row, name, who) => {
      const hue = row?.player?.color ?? hueOf(name);
      const av = el('span', { class: 'duel-board-av', text: initialsOf(name) });
      av.style.setProperty('--av-h', String(hue));
      const state = !row ? 'waiting'
        : this.revealed && row.result ? (row.result.penalty === 'DNF' ? 'dnf' : 'time')
        : row.status === 'done' ? 'locked' : row.status;
      const label = state === 'time' || state === 'dnf' ? Race.resText(row.result)
        : { locked: t('finished'), solving: t('solving…'), inspecting: t('inspecting'), waiting: t('ready') }[state] || t('ready');
      /* Reports need a Google account (reports/, ADMIN.md §6), and a race
         seat is anonymous: so only with the timer's own sign-in. */
      const flag = who === 'them' && row && hasPersistedSession() ? el('button', {
        class: 'duel-report', type: 'button', html: FLAG_SVG,
        title: t('Report {name}', { name }), 'aria-label': t('Report {name}', { name }),
        onclick: () => this._reportOpponent(),
      }) : null;
      return el('div', { class: 'duel-board-side', dataset: { who, state, lead: String(lead === who) } },
        av, flag,
        el('span', { class: 'duel-board-name', text: who === 'me' ? t('You') : name, title: name }),
        el('span', { class: 'duel-board-val', text: label,
          title: state === 'locked' ? t('They are done. You will see the time when you are.') : '' }),
      );
    };

    const board = el('div', { class: 'duel-board' },
      side(meRow, meRow?.player?.name || this.nickname(), 'me'),
      el('div', { class: 'duel-board-mid' },
        el('div', { class: 'duel-board-score' },
          el('b', { dataset: { lead: String(lead === 'me') }, text: String(me) }),
          el('i', { text: '–' }),
          el('b', { dataset: { lead: String(lead === 'them') }, text: String(them) })),
        el('div', { class: 'duel-board-round', text: this.phase === 'lobby' ? t('starting…') : t('Round {n}', { n: this.round?.no ?? 1 }) }),
      ),
      side(themRow, opp?.name || 'Cuber', 'them'),
    );

    const last = this.duelRounds.at(-1);
    if (!last) return [board];
    const w = Race.roundWinner(last);
    const a = effOf(last.me), b = effOf(last.them);
    // Number.isFinite, not isFinite: a round one side never finished is null, and isFinite(null) is true.
    const gap = Number.isFinite(a) && Number.isFinite(b) && a !== b ? fmt(Math.abs(a - b)) : '';
    const headline = w === 'me' ? (gap ? t('You won by {gap}', { gap }) : t('You won'))
      : w === 'them' ? (gap ? t('{name} won by {gap}', { name: opp?.name || 'Cuber', gap }) : t('{name} won', { name: opp?.name || 'Cuber' }))
      : w === 'tie' ? t('Dead heat') : t('No result');
    // One line: it shares the panel with the cam and the chat.
    const banner = el('div', { class: 'duel-last', dataset: { winner: w }, title: t('Round {n}', { n: last.no }) },
      el('span', { class: 'duel-last-k', text: `R${last.no}` }),
      el('span', { class: 'duel-last-h', text: headline }),
      el('span', { class: 'duel-last-times' },
        el('span', { dataset: { win: String(w === 'me') }, text: Race.resText(last.me) }),
        el('i', { text: '–' }),
        el('span', { dataset: { win: String(w === 'them') }, text: Race.resText(last.them) })),
    );
    return [board, banner];
  }

  /**
   * You against them, in the stats panel, for as long as a 1v1 lasts: the
   * figures side by side and every round's two times. Built from the rounds
   * this tab watched — the opponent's times exist nowhere else.
   */
  _syncDuelStats() {
    const panel = document.getElementById('panel-stats');
    if (!panel) return;
    let box = document.getElementById('stats-duel');
    const on = this.inRoom && this.isDuel && !!this.opponent;
    if (!on) { box?.remove(); this._duelStatsSig = ''; return; }

    const opp = this.opponent;
    const rounds = this.duelRounds;
    const sig = [opp.uid, opp.name, rounds.length, this.duelScore().me, this.duelScore().them].join('|');
    if (box && sig === this._duelStatsSig) return;
    this._duelStatsSig = sig;

    if (!box) {
      box = el('div', { id: 'stats-duel', class: 'stats-duel' });
      // Under the header, outside the fold: visible whether the panel is open or not.
      panel.querySelector('#stats-toggle')?.after(box);
    }

    const sum = (pick) => summarize(rounds.map(pick).filter(Boolean));
    const A = sum(x => x.me), B = sum(x => x.them);
    const { me, them } = this.duelScore();
    const f = (v) => (v == null || !Number.isFinite(v) ? '—' : fmt(v));

    /* One row each, a column a figure: three lines where a list of figures
       was six, because this shares a rail with the race panel and its cam. */
    const cols = [
      ['won', t('won'), me, them, (x, y) => x > y],
      ['best', t('best'), A.best, B.best, (x, y) => x < y],
      ['mean', t('mean'), A.mean, B.mean, (x, y) => x < y],
      ['ao5', 'ao5', A.ao5, B.ao5, (x, y) => x < y],
      ['ao12', 'ao12', A.ao12, B.ao12, (x, y) => x < y],
    ];
    const grid = el('div', { class: 'stats-duel-grid', role: 'table' }, el('span', { class: 'sd-h' }));
    for (const [, label] of cols) grid.append(el('span', { class: 'sd-h', text: label }));
    const line = (who, name, pick) => {
      grid.append(el('span', { class: 'sd-who', dataset: { who }, text: name, title: name }));
      for (const [k, , x, y, better] of cols) {
        const mine = pick(x, y), other = pick(y, x);
        // Ahead on that figure: more rounds won, a lower time everywhere else.
        const ok = Number.isFinite(mine) && Number.isFinite(other) && better(mine, other);
        grid.append(el('span', { class: 'sd-v', dataset: { ahead: String(ok) },
          text: k === 'won' ? String(mine) : f(mine) }));
      }
    };
    line('me', t('You'), (x) => x);
    line('them', opp.name, (x, y) => y);

    /* Every round, newest first, as a strip that scrolls sideways: the two
       times stacked under the round number, the winner's in bold. */
    const list = el('div', { class: 'stats-duel-list' });
    if (!rounds.length) {
      list.append(el('div', { class: 'sd-empty', text: t('Each round’s two times land here.') }));
    }
    for (const x of [...rounds].reverse()) {
      const w = Race.roundWinner(x);
      list.append(el('div', { class: 'sd-round', dataset: { winner: w }, title: t('Round {n}', { n: x.no }) },
        el('span', { class: 'sd-no', text: `#${x.no}` }),
        el('span', { class: 'sd-t', dataset: { win: String(w === 'me') }, text: Race.resText(x.me) }),
        el('span', { class: 'sd-t', dataset: { win: String(w === 'them') }, text: Race.resText(x.them) }),
      ));
    }

    box.replaceChildren(
      el('div', { class: 'stats-duel-head' },
        el('span', { text: t('This 1v1') }),
        el('span', { class: 'sd-vs', text: t('vs {name}', { name: opp.name }) })),
      grid,
      list,
    );
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
      const result = this.revealed && !this._isStruck(r?.no, uid) ? (r?.results?.[uid] || null) : null;
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
        <div class="race-top">
          <div class="race-meter"><i></i></div>
          <div class="race-status"></div>
          <div class="race-last" hidden></div>
          <div class="race-rows" role="list"></div>
          <button class="race-more" type="button" hidden></button>
          <div class="race-foot"></div>
        </div>
        <div class="race-cam" hidden></div>
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
          <div class="sc-blocked race-chat-off" role="status" hidden></div>
        </div>
        <div class="race-actions"></div>
      </div>`;
    host.append(node);
    if (!this._configBound) {
      this._configBound = true;
      // A switch flipped from the admin console shows up without a reload.
      addEventListener('tdt-config', () => this._syncChatOff());
    }
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

    /* Pinned to the newest message for as long as the reader has not scrolled
       up — remembered on scroll rather than measured at redraw, because the
       log changes height on its own: it is the part of the panel that gives
       way, so a new round's card or a row folding resizes it after the
       messages were drawn, and a log measured then was left part-way up. */
    const log = chat.querySelector('.race-chat-log');
    this._chatPinned = true;
    log.addEventListener('scroll', () => {
      this._chatPinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    }, { passive: true });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (this._chatPinned) log.scrollTop = log.scrollHeight; }).observe(log);
    }

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

    this._syncDuelStats();
    this._syncRaceStats();
    // For the stats panel's styles: in a 1v1 its folded peek gives way to the you-vs-them table.
    document.body.classList.toggle('duel-on', on && this.isDuel && !!this.opponent);
    if (!on) { this.app.refreshLayout?.(); return; }
    node.dataset.duel = String(this.isDuel && !!this.opponent);
    this._render(node);
    node.querySelector('.race-cam').hidden = !(this.isDuel && this.opponent && (this._cam || getConfig('duel', 'camEnabled')));
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
      this.isHost, this.isDuel, this.opponent?.name, this._histSig(),
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

    // A 1v1's code means nothing to anybody: it is never shared, and nobody else can join.
    node.querySelector('.race-code').textContent = this.isDuel ? t('1v1') : this.snap.roomId || '';

    /* The meter is the pressure. It says how much of the room is already
       finished and nothing whatsoever about how fast any of them were — which
       is exactly the information you are allowed to have mid-solve. */
    const meter = node.querySelector('.race-meter i');
    meter.style.width = live ? `${Math.round((done / live) * 100)}%` : '0%';
    node.querySelector('.race-meter').dataset.state =
      this.revealed ? 'revealed' : done ? 'pressure' : 'idle';

    /* ---- a 1v1: one head-to-head card in place of the status, rows and standings ---- */
    const duel = this.isDuel && !!this.opponent;
    const status = node.querySelector('.race-status');
    status.hidden = duel;
    node.querySelector('.race-meter').hidden = duel;
    node.querySelector('.race-last').hidden = duel;
    if (duel) {
      node.querySelector('.race-rows').replaceChildren(...this._duelBoard(rows));
      node.querySelector('.race-more').hidden = true;
      this._foot(node.querySelector('.race-foot'), { rows, done, live });
      this._actions(node.querySelector('.race-actions'));
      return;
    }

    /* ---- status line ---- */
    status.innerHTML = '';
    if (this.phase === 'lobby') {
      status.append(
        el('span', { class: 'race-round', text: t('Lobby') }),
        el('span', { class: 'race-count', text: t('{n} / {max} here', { n: live, max: this.isDuel ? 2 : tune('roomMax') }) }),
      );
    } else {
      status.append(
        el('span', { class: 'race-round', text: t('Round {n}', { n: r?.no ?? 1 }) }),
        el('span', { class: 'race-count', text: t('{n} of {total} done', { n: done, total: live }) }),
      );
    }

    /* ---- rows ---- */
    const host = node.querySelector('.race-rows');
    host.innerHTML = '';
    const shown = this.collapsed && innerWidth <= 860 ? [] : rows;
    const fold = this._expanded ? shown.length : Math.min(shown.length, tune('rowsBeforeFold'));
    shown.slice(0, fold).forEach((row, i) => host.append(this._row(row, i)));

    const more = node.querySelector('.race-more');
    const hidden = shown.length - fold;
    more.hidden = hidden <= 0 && !this._expanded;
    more.textContent = this._expanded ? t('show fewer') : t('+{n} more', { n: hidden });
    more.onclick = () => { this._expanded = !this._expanded; this._syncPanel(); };

    /* ---- the round before this one, until there is a newer one ---- */
    this._lastRound(node.querySelector('.race-last'));

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

    /* A 1v1 has no lobby to go back to — it starts itself and ends when one
       of you goes — so End race would only strand both of you in it. */
    if (this.isDuel) {
      host.append(el('button', {
        class: 'btn danger', text: t('Quit 1v1'),
        title: t('End this 1v1 and go back to your own session'),
        onclick: async () => {
          if (!await confirmToast(t('Quit this 1v1?'), t('quit'))) return;
          const { me, them } = this.duelScore();
          await this.leave();
          toast(t('Left the 1v1 — you {me} – {them}', { me, them }));
        },
      }));
      return;
    }

    if (this.phase === 'racing' && this.isHost) {
      host.append(el('button', {
        class: 'btn', text: t('End race'),
        title: t('Take the whole room back to the lobby — standings are kept'),
        onclick: async () => {
          if (!await confirmToast('End the race for everyone in the room?', t('end it'))) return;
          await this._end();
        },
      }));
    }

    host.append(el('button', {
      class: 'btn danger', text: t('Leave room'),
      title: t('Leave this room and go back to your own session'),
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
    this._chatPinned = true;
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
    // The rules' gap (config/raceChat/gapMs) and a little more, or the old 0.7 s if that is longer.
    if (Date.now() - this._chatSentAt < Math.max(CHAT_COOLDOWN_MS, getConfig('raceChat', 'gapMs') + 500)) return;
    if (chatOff()) { toast(chatOff()); return; }
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
      // Banned (this racer's own bans/<uid>), or switched off since the settings were read.
      const ban = String(code).includes('PERMISSION_DENIED') ? await this.net.banOf?.() : null;
      if (banActive(ban)) { toast(banLine(ban), { kind: 'bad', long: true }); return; }
      if (chatOff()) { toast(chatOff(), { long: true }); this._syncChatOff(); return; }
      /* PERMISSION_DENIED here means one specific thing almost every time:
         the database is running rules that predate chat, so the write falls
         through to the root's ".write": false. Saying so is the difference
         between a five-minute fix and an afternoon spent reading this file —
         t("Could not send that") sent exactly one person hunting for a bug in
         code that was working. */
      toast(String(code).includes('PERMISSION_DENIED')
        ? t('The room refused that — this database is running rules from before chat existed. Publish firebase.rules.json.')
        : t('Could not send that'), { long: true });
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
  /** Report somebody's message to the admins, as the Google account signed in on this browser. */
  async _report(m) {
    if (!(await confirmToast(t('Report {name}’s message to the admins?', { name: m.name || 'Cuber' }), t('Report')))) return;
    try {
      const [{ getDatabaseHandle }, { sendReport }] = await Promise.all([import('./sync-auth.js'), import('./moderation.js')]);
      const sdk = await getDatabaseHandle();
      const out = await sendReport(sdk, { kind: 'raceChat', path: `rooms/${this.snap.roomId}/chat/${m.id}`, text: m.text });
      toast(out === 'already' ? t('You have already reported that') : t('Reported. An admin will look at it.'));
    } catch (err) {
      console.warn('[race] report refused', err?.code || err);
      toast(t('Couldn’t send the report'), { kind: 'bad' });
    }
  }

  /** The box, or why there is no box (config/raceChat/enabled). */
  _syncChatOff() {
    const wrap = this._node?.querySelector('.race-chat');
    if (!wrap) return;
    const why = chatOff();
    wrap.querySelector('.race-chat-form').hidden = !!why;
    const note = wrap.querySelector('.race-chat-off');
    note.hidden = !why;
    if (why) note.textContent = why;
  }

  _syncChat() {
    const node = this._node;
    const wrap = node?.querySelector('.race-chat');
    if (!wrap) return;
    this._syncChatOff();

    const log = this.chatLog;

    const host = wrap.querySelector('.race-chat-log');
    /* A room's rounds are part of its conversation: each one that finishes
       says so in the log, in among what people said about it. Local lines —
       nobody else is sent them. The last dozen, so a long visit's rounds
       do not crowd out what was said. */
    const lines = this.isDuel ? [] : this.history.slice(-12);
    const sig = log.map(m => m.id).join(',') + '|' + (lines.length ? this._histSig() : '');
    if (sig === this._chatSig) return;
    this._chatSig = sig;

    /* Pinned to the bottom unless the reader has scrolled up to look at
       something, in which case yanking them back down is rude. */
    const pinned = this._chatPinned !== false;

    host.innerHTML = '';
    if (!log.length && !lines.length) {
      host.append(el('div', { class: 'race-chat-empty', text: t('Nothing said yet.') }));
    } else {
      let lastUid = null;
      const items = [...log, ...lines.map(h => ({ round: h, at: h.at }))]
        .sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const m of items) {
        if (m.round) {
          lastUid = null;
          host.append(el('div', { class: 'race-chat-round', text: this._roundLine(m.round) }));
          continue;
        }
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
          /* Reports need a Google account (reports/, ADMIN.md §6), and a race
             identity is anonymous: so only with the timer's own sign-in. */
          m.uid !== this.uid && hasPersistedSession() ? el('button', {
            class: 'race-chat-report', type: 'button', html: FLAG_SVG,
            title: t('Report this message'), 'aria-label': t('Report this message'),
            onclick: () => this._report(m),
          }) : null,
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

  /** Changes whenever what the kept rounds would draw changes. */
  _histSig() {
    const last = this.history.at(-1);
    return `${this._histVer || 0}:${this.history.length}:${last?.no ?? ''}:${last?.pending ? 1 : 0}`;
  }

  /** A racer's name, with the site owner's shine and card where it applies. */
  _nameEl(name, cls, title = name) {
    const owner = isOwnerName(name);
    const node = el('span', {
      class: `${cls}${owner ? ' owner-shine' : ''}`, text: name || 'Cuber',
      title: owner ? t('{name} — that’s the site owner, click for the card', { name }) : title,
    });
    if (owner) node.addEventListener('click', (e) => { e.stopPropagation(); openOwnerCard(node); });
    return node;
  }

  /**
   * The round that just finished, kept on screen for the whole of the next one.
   *
   * The rows above are the live round, and they go back to "solving…" the
   * moment the next scramble lands — less than a second after the last person
   * finishes, which for the last person is no time at all. This is the same
   * result, staying put until there is a newer one. Hidden while the rows are
   * themselves showing that round, so it is never on screen twice.
   */
  _lastRound(host) {
    if (!host) return;
    const last = this.history.at(-1);
    const show = !!last && last.seen && !(last.no === this.round?.no && this.revealed);
    host.hidden = !show;
    if (!show) { host.replaceChildren(); return; }

    const places = Race.places(last);
    const ranked = last.rows.filter(x => places.has(x.uid))
      .sort((a, b) => places.get(a.uid) - places.get(b.uid));
    const mine = places.get(this.uid);
    const myRes = last.rows.find(x => x.uid === this.uid)?.res;

    const verdict = last.rows.find(x => x.uid === this.uid)?.struck ? t('your time was removed by a moderator')
      : !mine ? t('you didn’t finish')
      : myRes?.penalty === 'DNF' ? t('you DNF’d')
      : mine === 1 ? t('you won')
      : t('you {place} of {n}', { place: ordinal(mine), n: last.rows.length });

    /* Two short lines: the top three and you, and the rest one look away in
       the Race stats panel — the chat needs the height more. */
    let shown = ranked;
    if (ranked.length > LAST_MAX) {
      shown = ranked.slice(0, LAST_MAX - 1);
      const me = ranked.find(x => x.uid === this.uid);
      shown.push(me && !shown.includes(me) ? me : ranked[LAST_MAX - 1]);
    }

    const list = el('div', { class: 'race-last-list' });
    for (const row of shown) {
      const p = places.get(row.uid);
      list.append(el('div', { class: 'race-last-row', dataset: { me: String(row.uid === this.uid), win: String(p === 1) } },
        el('span', { class: 'race-last-p', text: String(p) }),
        this._nameEl(row.uid === this.uid ? t('You') : row.name, 'race-last-n', row.name),
        el('b', { class: 'race-last-t', text: Race.resText(row.res) }),
      ));
    }
    const rest = last.rows.length - shown.length;

    host.replaceChildren(
      el('div', { class: 'race-last-head' },
        el('span', { class: 'race-last-k', text: t('Round {n}', { n: last.no }) }),
        el('span', { class: 'race-last-v', dataset: { win: String(mine === 1) }, text: verdict })),
      list,
      // replaceChildren, unlike el(), prints a null as the word "null".
      ...(rest > 0 ? [el('div', { class: 'race-last-more', text: t('+{n} more in Race stats', { n: rest }) })] : []),
    );
  }

  /* ---------------- the Race stats panel ----------------
   *
   * While a room is open, the times list makes way for the room's own
   * numbers: every round's times for everyone in it, and the standings. Your
   * own solves are still one tab away — this is the same panel, so it is
   * wherever you docked your times, and on a phone it is the Times tab.
   */
  _syncRaceStats() {
    const panel = document.getElementById('panel-times');
    if (!panel) return;
    const on = this.inRoom && !this.isDuel;
    let box = document.getElementById('times-race');
    if (!on) {
      box?.remove();
      delete panel.dataset.race;
      this._raceStatsSig = '';
      return;
    }

    const tab = this.statsTab || 'rounds';
    panel.dataset.race = tab;
    const live = this.livePlayers();
    const sig = [this.snap.roomId, tab, this._histSig(), this.uid,
      ...live.map(([uid, p]) => `${uid}:${p.name}`)].join('|');
    if (box && sig === this._raceStatsSig) return;
    this._raceStatsSig = sig;

    if (!box) {
      box = el('div', { id: 'times-race', class: 'times-race' });
      panel.querySelector('.panel-head')?.after(box);
    }
    // Keep the reader where they were: a redraw lands once a round.
    const scroller = box.querySelector('.tr-scroll');
    const keep = scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop } : null;

    const tabs = el('div', { class: 'tr-tabs', role: 'tablist' });
    for (const [id, label] of [['rounds', t('Rounds')], ['standings', t('Standings')], ['solves', t('Your solves')]]) {
      tabs.append(el('button', {
        class: 'tr-tab', type: 'button', role: 'tab', text: label,
        'aria-selected': String(tab === id),
        onclick: () => { this.statsTab = id; this._syncRaceStats(); this.app.refreshLayout?.(); },
      }));
    }

    const head = el('div', { class: 'tr-head' },
      el('span', { class: 'tr-title', text: t('Race stats') }),
      el('span', { class: 'tr-sub', text: t('room {code}', { code: this.snap.roomId || '' }) }));

    if (tab === 'solves') { box.replaceChildren(head, tabs); return; }

    const order = this._standingsOrder();
    const present = new Set(live.map(([uid]) => uid));
    const me = this.standings.get(this.uid);
    const f = (v) => (v == null || !Number.isFinite(v) ? '—' : fmt(v));
    const figs = el('div', { class: 'tr-me' },
      ...[
        [t('Wins'), String(me?.wins || 0), 'wins'],
        [t('Avg place'), me?.placed ? (me.placeSum / me.placed).toFixed(1) : '—', ''],
        [t('Mean'), me?.timed ? f(me.sum / me.timed) : '—', ''],
        [t('Best'), f(me?.best), 'best'],
      ].map(([k, v, cls]) => el('div', { class: 'tr-fig' },
        el('i', { text: k }), el('span', { class: cls, text: v }))));

    const body = el('div', { class: 'tr-scroll' },
      tab === 'rounds' ? this._roundsTable(order, present) : this._standingsTable(order, present));

    box.replaceChildren(head, tabs, figs, body);
    if (keep) { body.scrollLeft = keep.x; body.scrollTop = keep.y; }
  }

  /** Everyone the room has had, best first: wins, then average place, then best single. */
  _standingsOrder() {
    const avgPlace = (s) => (s.placed ? s.placeSum / s.placed : Infinity);
    const ids = new Set([...this.standings.keys(), ...this.livePlayers().map(([uid]) => uid)]);
    return [...ids].map(uid => [uid, this.standings.get(uid) || { name: this.snap.players?.[uid]?.name, wins: 0, played: 0, best: null }])
      .sort((a, b) => b[1].wins - a[1].wins
        || avgPlace(a[1]) - avgPlace(b[1])
        || (a[1].best ?? Infinity) - (b[1].best ?? Infinity)
        || b[1].played - a[1].played);
  }

  /** The name cell both tables start with: place, colour, name. */
  _whoCell(uid, s, i, present) {
    const name = this.snap.players?.[uid]?.name || s.name || 'Cuber';
    const hue = this.snap.players?.[uid]?.color ?? hueOf(name);
    const dot = el('span', { class: 'tr-dot' });
    dot.style.setProperty('--av-h', String(hue));
    return el('th', { class: 'tr-who', scope: 'row' },
      el('span', { class: 'tr-rank', text: String(i + 1) }), dot,
      this._nameEl(uid === this.uid ? t('You') : name, 'tr-name',
        present.has(uid) ? name : t('{name} — no longer in the room', { name })));
  }

  /** One row a racer, one column a round, newest round first. */
  _roundsTable(order, present) {
    const rounds = [...this.history].reverse();
    const table = el('table', { class: 'tr-table tr-rounds' });
    const hrow = el('tr', {},
      el('th', { class: 'tr-who', scope: 'col', text: t('Racer') }),
      el('th', { class: 'tr-w', scope: 'col', text: t('W'), title: t('Rounds won') }));
    for (const h of rounds) {
      hrow.append(el('th', { scope: 'col', text: `R${h.no}`,
        title: h.seen ? t('Round {n}', { n: h.no }) : t('Round {n} — you didn’t finish it, so its times stay hidden', { n: h.no }) }));
    }
    const fastest = new Map(rounds.map(h => {
      const best = Math.min(...h.rows.map(x => effOf(x.res)).filter(Number.isFinite));
      return [h.no, best];
    }));
    const tbody = el('tbody');
    order.forEach(([uid, s], i) => {
      const tr = el('tr', { dataset: { me: String(uid === this.uid), gone: String(!present.has(uid)) } },
        this._whoCell(uid, s, i, present),
        el('td', { class: 'tr-w', text: String(s.wins || 0) }));
      for (const h of rounds) {
        const row = h.rows.find(x => x.uid === uid);
        const e = effOf(row?.res);
        const state = !row ? 'out' : !h.seen ? 'hidden' : row.struck ? 'struck' : !row.res ? 'none'
          : row.res.penalty === 'DNF' ? 'dnf' : e === fastest.get(h.no) ? 'best' : '';
        tr.append(el('td', {
          dataset: { s: state },
          text: !row ? '' : !h.seen ? '?' : row.struck ? '✕' : Race.resText(row.res),
          title: state === 'out' ? t('Not in the room for this round')
            : state === 'struck' ? t('Removed by a moderator')
            : state === 'hidden' ? t('You didn’t finish this round, so its times stay hidden')
            : state === 'none' ? t('Didn’t finish in time') : '',
        }));
      }
      tbody.append(tr);
    });
    table.append(el('thead', {}, hrow), tbody);
    if (!rounds.length) {
      return el('div', {}, table, el('div', { class: 'tr-empty', text: t('Each round’s times land here once it’s over.') }));
    }
    return table;
  }

  /** The whole visit, one line a racer. */
  _standingsTable(order, present) {
    const f = (v) => (v == null || !Number.isFinite(v) ? '—' : fmt(v));
    const table = el('table', { class: 'tr-table tr-stand' });
    table.append(el('thead', {}, el('tr', {},
      el('th', { class: 'tr-who', scope: 'col', text: t('Racer') }),
      el('th', { class: 'tr-w', scope: 'col', text: t('W'), title: t('Rounds won, of rounds raced') }),
      el('th', { scope: 'col', text: t('Best') }),
      el('th', { scope: 'col', text: t('Mean'), title: t('Mean of the rounds they finished') }),
      el('th', { scope: 'col', text: t('Place'), title: t('Average place') }))));
    const tbody = el('tbody');
    order.forEach(([uid, s], i) => {
      tbody.append(el('tr', { dataset: { me: String(uid === this.uid), gone: String(!present.has(uid)) } },
        this._whoCell(uid, s, i, present),
        el('td', { class: 'tr-w', text: `${s.wins || 0}/${s.played || 0}`,
          title: t(s.played === 1 ? '{w} won of {n} round' : '{w} won of {n} rounds', { w: s.wins || 0, n: s.played || 0 }) }),
        el('td', { text: f(s.best) }),
        el('td', { text: s.timed ? f(s.sum / s.timed) : '—' }),
        el('td', { text: s.placed ? (s.placeSum / s.placed).toFixed(1) : '—' }),
      ));
    });
    table.append(tbody);
    return table;
  }

  /** "Round 12 · Aarav won · 8.77 · you 2nd", for the chat log. */
  _roundLine(h) {
    if (!h.seen) return t('Round {n} is over — finish a round to see its times', { n: h.no });
    const places = Race.places(h);
    const top = h.rows.find(x => places.get(x.uid) === 1);
    const mine = places.get(this.uid);
    const parts = [t('Round {n}', { n: h.no })];
    if (top && Number.isFinite(effOf(top.res))) {
      parts.push(top.uid === this.uid ? t('you won') : t('{name} won', { name: top.name || 'Cuber' }), Race.resText(top.res));
    }
    if (mine && mine !== 1) parts.push(t('you {place}', { place: ordinal(mine) }));
    return parts.join(' · ');
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
    const owner = isOwnerName(player.name);
    const av = el('span', {
      class: `race-av${isHost ? ' host' : ''}${owner ? ' owner' : ''}`,
      text: initialsOf(player.name),
      title: owner ? t('{name} — that’s the site owner, click for the card', { name: player.name })
        : isHost ? t('{name} — publishes each round’s scramble', { name: player.name }) : player.name,
    });
    if (owner) av.addEventListener('click', (e) => { e.stopPropagation(); openOwnerCard(av); });
    node.append(av);

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
    const nameB = el('b', { class: owner ? 'owner-shine' : '', text: player.name || 'Cuber' });
    if (owner) nameB.addEventListener('click', (e) => { e.stopPropagation(); openOwnerCard(nameB); });
    const name = el('span', { class: 'race-name' },
      nameB,
      !this.revealed && standing?.wins
        ? el('i', { class: 'race-wins', text: `${standing.wins}W`, title: t(standing.wins === 1 ? '{n} round won' : '{n} rounds won', { n: standing.wins }) })
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
      node.title = t('Edit this solve — penalty, comment, delete');
      node.addEventListener('click', () => this.app.solveMenu?.(mine, node));
    }
    return node;
  }

  /** The right-hand column: a badge until it has earned the right to be a time. */
  _value(row, state) {
    const wrap = el('span', { class: 'race-val' });
    const { result } = row;

    if (state === 'revealed' || state === 'dnf') {
      // The time that counts — 12.00+ for a 10.00 with a +2, as the times list writes it.
      wrap.append(el('b', { class: 'race-time', text: Race.resText(result) }));

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
            ? t('The submitted time is shorter than the window the server timed it in')
            : t('Far faster than this player’s own recent average'),
        }));
      }
      return wrap;
    }

    const label = {
      locked:     ['finished', t('They are done. You will see the time when you are.')],
      solving:    ['solving', t('Currently solving')],
      inspecting: ['inspecting', t('In inspection')],
      waiting:    ['waiting', t('Has not started this scramble')],
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
      !!this.round?.info?.scramble, this.isHost, this.kind, this.isDuel].join('|');
    if (sig === this._lastFootSig) return;
    this._lastFootSig = sig;

    foot.innerHTML = '';

    if (this.phase === 'lobby' && this.isDuel) {
      foot.append(el('div', { class: 'race-wait', text: live >= 2
        ? t('Opponent found — starting…') : t('Waiting for your opponent to connect…') }));
      return;
    }

    if (this.phase === 'lobby') {
      const ready = live >= 2;
      foot.append(el('div', { class: 'race-note', text: ready
        ? t('Everyone here gets the same scramble. Start when you are ready.')
        : t('Share the code — racing starts when the host says go.') }));
      if (this.isHost) {
        foot.append(el('button', {
          class: 'btn primary full', text: live >= 2 ? t('Start racing') : t('Start anyway'),
          onclick: () => this._start(),
        }));
      } else {
        foot.append(el('div', { class: 'race-wait', text: t('Waiting for the host…') }));
      }
      return;
    }

    if (!this.round?.info?.scramble) {
      foot.append(el('div', { class: 'race-wait',
        text: t('Round {n} scramble loading…', { n: this.round?.no ?? 1 }) }));
      return;
    }

    /* A 1v1 says who is done and when it unlocks on the head-to-head card,
       so the foot keeps only its countdowns — and the panel keeps the height
       for the cam and the chat. */
    if (this.isDuel && this.opponent) {
      if (this.revealed && this.settleAt) {
        const left = Math.max(0, Math.ceil((this.settleAt - Date.now()) / 1000));
        foot.append(el('div', { class: 'race-next' },
          el('span', { text: t('Next scramble in') + ' ' }), el('b', { text: `${left}s` })));
      } else if (this.revealed && this.graceAt) {
        const left = Math.max(0, Math.ceil((this.graceAt - Date.now()) / 1000));
        foot.append(el('div', { class: 'race-note', text: t('Waiting on {name} — {s}s', { name: this.opponent.name, s: left }) }));
      }
    } else if (!this.revealed) {
      foot.append(el('div', { class: 'race-note strong', text: done
        ? t(done === 1 ? '{n} person has finished. Times unlock when you do.' : '{n} people have finished. Times unlock when you do.', { n: done })
        : t('Solve the scramble to unlock the room’s times.') }));
    } else if (this.settleAt) {
      const left = Math.max(0, Math.ceil((this.settleAt - Date.now()) / 1000));
      foot.append(el('div', { class: 'race-next' },
        el('span', { text: t('Next scramble in') + ' ' }), el('b', { text: `${left}s` })));
    } else if (this.graceAt) {
      const left = Math.max(0, Math.ceil((this.graceAt - Date.now()) / 1000));
      foot.append(el('div', { class: 'race-note',
        text: t('Waiting on {n} more — {s}s. Keep your cube solved.', { n: live - done, s: left }) }));
    } else {
      foot.append(el('div', { class: 'race-note',
        text: t('Waiting for the rest of the room — keep your cube solved.') }));
    }

    if (this.kind === 'local') {
      foot.append(el('div', { class: 'race-local', text: t('Local room — this browser only, and nothing here is enforced.') }));
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
/** The room size now: config/race/roomMax, at most ROOM_MAX. */
export const roomMax = () => getConfig('race', 'roomMax');
export { hueOf, initialsOf };
