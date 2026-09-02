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
import { createTransport, cloudAvailable, scrambleHash, isStale } from './race-net.js';
import {
  ROOM_MAX, ROWS_BEFORE_FOLD, CODE_ALPHABET, CODE_LENGTH,
  GRACE_MS, SOFT_TIMEOUT_MS, SUSPECT_RATIO,
  CLOCK_SLACK_MS, CLOCK_SLACK_RATIO,
} from './raceapp.js';

/** How long a settled leaderboard stays up before the next scramble. */
const SETTLE_MS = 6000;

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
    /** The round whose scramble is currently on screen. */
    this.servedRound = 0;
    /** Rounds we have already celebrated / folded into standings. */
    this.settledRound = 0;

    /** uid -> { wins, played, lastRank } for this visit to this room. */
    this.standings = new Map();
    /** uid -> rank in the previous settled round, for the ▲▼ column. */
    this.prevRanks = new Map();

    /** Set while a settled leaderboard is being read, before the next round. */
    this.settleAt = 0;
    /** Which round that leaderboard belongs to — see the note in _onTick. */
    this.settleFrom = 0;
    /** Set when everyone still connected but one has finished. */
    this.graceAt = 0;

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
    this.net = createTransport(prefer);
    this.kind = this.net.kind;
    const { uid } = await this.net.init();
    this.uid = uid;
    this.net.addEventListener('room', (e) => this._onRoom(e.detail));
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
    this.servedRound = 0;
    this.settledRound = 0;
    this.standings.clear();
    this.prevRanks.clear();

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
    await this.app.enterRaceSession?.(roomId);
    this._ensurePanel();
    this._startTicking();
    this.dispatchEvent(new CustomEvent('change'));
    return roomId;
  }

  async leave() {
    if (!this.net) return;
    clearInterval(this._tick);
    this._tick = 0;
    await this.net.leave();
    this.snap = null;
    this.settleAt = 0;
    this.graceAt = 0;
    this.submittedRound = 0;
    this.servedRound = 0;
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
    const prevRound = this.round?.no;
    this.snap = snap;

    // A new round: reset the local per-round bookkeeping and put its scramble
    // on screen. Everything else follows from the snapshot.
    if (this.round && this.round.no !== prevRound) {
      this.settleAt = 0;
      this.graceAt = 0;
      this.settleFrom = 0;
      this._restoreOwnResult(this.round.no);
    }

    this._maybeOpenRound();
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
    this._syncPanel();
  }

  /** The host publishes the scramble for a round that has none yet. */
  async _maybeOpenRound() {
    const r = this.round;
    if (!r || r.info || this.phase !== 'racing') return;
    if (!this.isHost) return;
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
  }

  /** Put the round's scramble on screen exactly once per round. */
  _serveScramble() {
    const r = this.round;
    if (!r?.info?.scramble || this.phase !== 'racing') return;
    if (this.servedRound === r.no) return;
    this.servedRound = r.no;
    this.app.nextScramble?.();
  }

  /* ---------------- hooks main.js calls ---------------- */

  /**
   * The scramble the timer should be showing, or null to let the generator
   * have its usual say. Stays pinned to the round even after you have
   * finished, because it is still the scramble everyone is racing.
   */
  takeScramble() {
    const r = this.round;
    if (!this.inRoom || this.phase !== 'racing' || !r?.info?.scramble) return null;
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

    await this.net.setProgress({ status: 'done' }).catch(() => {});
    try {
      await this.net.submitResult({
        timeMs: Math.round(solve.timeMs),
        penalty: solve.penalty || 'none',
        hash: r.info.hash,
        suspect: this._looksSuspect(solve) || null,
      });
    } catch (err) {
      // The rules refusing a write is information, not a crash: it means the
      // scramble or the server-observed clock gap did not line up.
      console.warn('[race] result refused', err);
      toast('The room would not accept that time', { kind: 'bad' });
    }
    // Only now does the read of everyone else's times become allowed.
    this.net.unlockResults();
    this._syncPanel();
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
  }

  _onTick() {
    if (!this.inRoom) return;
    const r = this.round;
    if (!r || this.phase !== 'racing') { this._syncPanel(); return; }

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
    }

    if (this.settleAt && Date.now() >= this.settleAt) {
      const from = this.settleFrom;
      this.settleAt = 0;
      this.graceAt = 0;
      this.settleFrom = 0;
      /* Advance from the round that actually settled, not from whatever the
         current round happens to be when this fires.
         Every client runs this clock, so two of them settle a moment apart.
         Reading `r.no` here meant the slower client could wake up after the
         faster one had already moved the room on, compute "current + 1", and
         advance again — skipping a round outright and handing everybody a
         scramble nobody raced. Pinning it to the settled round makes the
         second attempt a no-op instead, which is what the advance-by-exactly-
         one guard was always meant to catch. */
      if (from && this.round?.no === from) {
        this.net.advanceRound(from + 1).catch(() => {});
      }
    }

    this._syncPanel();
  }

  /** Fold a finished round into the standings, and celebrate if it was yours. */
  _settle(r) {
    const ranked = this.ranked(r);
    this.prevRanks = new Map(this.standings.size ? [...this.standings].map(([k, v]) => [k, v.lastRank]) : []);

    ranked.forEach((row, i) => {
      const s = this.standings.get(row.uid) || { wins: 0, played: 0, lastRank: null };
      s.played += 1;
      if (i === 0 && row.result && effOf(row.result) !== Infinity) s.wins += 1;
      s.lastRank = i + 1;
      this.standings.set(row.uid, s);
    });

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
        <div class="race-foot"></div>
      </div>`;
    host.append(node);
    this._node = node;

    node.querySelector('.race-head').addEventListener('click', (e) => {
      // The grip lives inside the header; dragging it must not fold the panel.
      if (e.target.closest('.tile-grip')) return;
      this.collapsedByUser = !this.collapsed;
      this._syncPanel();
    });

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
    if (!on) { this.app.refreshLayout?.(); return; }
    this._render(node);
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

    /* ---- foot ---- */
    this._foot(node.querySelector('.race-foot'), { rows, done, live });
  }

  _row(row, i) {
    const { player, isMe, isHost, status, result, standing } = row;
    const hue = player.color ?? hueOf(player.name || '');
    const state = this.revealed && result ? (result.penalty === 'DNF' ? 'dnf' : 'revealed')
      : status === 'done' ? 'locked'
      : status;

    const node = el('div', {
      class: 'race-row', role: 'listitem',
      dataset: { state, me: String(isMe) },
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
      foot.append(el('div', { class: 'race-wait', text: 'Waiting for the round’s scramble…' }));
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
      foot.append(el('div', { class: 'race-note', text: `Waiting on ${live - done} more — ${left}s` }));
    } else {
      foot.append(el('div', { class: 'race-note', text: 'Waiting for the rest of the room…' }));
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
