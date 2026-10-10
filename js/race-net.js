import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — race transport

   Two implementations of one small interface, so nothing above this file
   knows or cares which is in use:

     init()            connect + establish an identity, resolves { uid }
     join(id, player)  enter a room
     leave()           exit, and reap the room if you were the last out
     setProgress(p)    your status for the live round — never a time
     submitResult(r)   your time for the live round — write-once
     sendChat(text)    say something to the room — open in every phase
     openRound(n, i)   publish a round's scramble (write-once, first wins)
     advanceRound(n)   move the room's pointer forward by exactly one
     unlockResults()   start reading other people's times
     fetchResults(n)   one read of a past round's times, once you raced it
     watchResults(n,f) keep reading one past round's times, until unsubscribed
     setPenalty(n, p)  change the penalty on your own submitted result
     destroy()

   It is an EventTarget and emits one event, 'room', carrying the whole
   snapshot. Callers re-render from the snapshot rather than diffing — a race
   room is a few dozen small fields and diffing it would be ceremony.

   ---------------------------------------------------------
   The shape of the data is the security model
   ---------------------------------------------------------

   A round is split in two on purpose:

     progress/  who is ready, inspecting, solving, finished — public
     results/   how fast they actually were — readable only once YOUR OWN
                result exists

   That split is what lets the room show "3 of 5 finished" while telling you
   nothing about how fast any of them were, and it is why the reveal rule is
   expressible as a database rule at all rather than a promise the UI makes.
   Firebase read rules cascade downwards and cannot be revoked deeper in the
   tree, so `results` can never sit under a node that is broadly readable —
   which is exactly why there is no ".read" anywhere above it.

   ---------------------------------------------------------
   Chat is always open
   ---------------------------------------------------------

   `chat` sits beside them and is readable and writable by the whole room at
   any time, round or no round.

   It used to be frozen during a round, on the grounds that somebody typing
   "7.2, finally" leaks their time to everybody still mid-solve. That is real
   but it is a room problem, not a rules problem — the same person can say it
   out loud — and the freeze cost every room the thing chat is for: reacting
   while it is happening. `results` stays gated exactly as before, so the
   times themselves are still unreadable until you have sent your own.
   =========================================================== */

import { getConfig, loadConfig } from './config.js';

/* The room's tuning, from the admin console (config/race); the defaults are
   raceapp.js's constants. Read at each use, so a change reaches open rooms. */
const roomMax = () => getConfig('race', 'roomMax');
const heartbeatMs = () => getConfig('race', 'heartbeatSec') * 1000;
const staleRoomMs = () => getConfig('race', 'staleRoomMin') * 60_000;
const hardTimeoutMs = () => getConfig('race', 'hardTimeoutSec') * 1000;
import { EMULATED } from './sync-auth.js';
import {
  FIREBASE_CONFIG, FIREBASE_VERSION,
  CHAT_MAX_LEN, CHAT_HISTORY, MATCH_LOBBY,
} from './raceapp.js';

/* ---------------------------------------------------------
   Shared helpers
   --------------------------------------------------------- */

/**
 * A short, stable hash of a scramble string.
 *
 * FNV-1a, and deliberately not a cryptographic digest: this binds a result to
 * the scramble it was solved against so a client cannot claim a time for an
 * easier scramble than the one it was issued. Secrecy buys nothing here — the
 * scramble is public to the whole room by definition — and SubtleCrypto is
 * async, which would drag a promise into the middle of the submit path for no
 * gain.
 */
export function scrambleHash(str) {
  let h = 0x811c9dc5;
  const s = String(str || '').trim().replace(/\s+/g, ' ');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Snapshot handed to the UI. Always this shape, even before a room exists. */
const emptySnapshot = () => ({
  roomId: null, uid: null, meta: null,
  players: {}, round: null, resultsUnlocked: false,
  /* A moderator's marks on the room (rooms/<id>/mod, ADMIN.md "Race rooms and
     1v1"): { closed?: { at, by }, kicked?: { uid: at }, struck?: { round: { uid: { at, by, reason } } } }. */
  mod: null,
  /* Oldest first, already trimmed to CHAT_HISTORY. An array rather than the
     raw object because the only order a room's messages have is the one the
     push ids give them, and every reader wants that order. */
  chat: [],
});

/**
 * Everything a message has to survive before the room will carry it.
 *
 * Trimmed, collapsed and capped here rather than only in the rules, so the
 * two transports agree on what a message is — the local one has no rules
 * behind it to fall back on.
 *
 * @returns {string} the text to send, or '' if there is nothing to send.
 */
export function cleanChat(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
}

/* =========================================================
   Firebase transport
   ========================================================= */
class FirebaseTransport extends EventTarget {
  constructor() {
    super();
    this.kind = 'firebase';
    this.snap = emptySnapshot();
    this._sdk = null;
    this._unsubs = [];
    this._roundUnsubs = [];
    this._beat = 0;
    this._watchedRound = null;
    /* What we wrote into players/<uid>, kept so the row can be written again
       from scratch. A reconnect needs the whole row, not a patch — see
       _ensureSeat. */
    this._seat = null;
  }

  async init() {
    if (!FIREBASE_CONFIG) throw new Error('no-config');
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appMod, authMod, dbMod] = await Promise.all([
      import(/* @vite-ignore */ `${base}/firebase-app.js`),
      import(/* @vite-ignore */ `${base}/firebase-auth.js`),
      import(/* @vite-ignore */ `${base}/firebase-database.js`),
    ]);

    const app = appMod.initializeApp(FIREBASE_CONFIG, 'tagda-race');
    const auth = authMod.getAuth(app);
    /* ?emu=1 on localhost (sync-auth.js): the emulators, like the rest of the
       app. Without this a local test of a race room reached the real project. */
    if (EMULATED) authMod.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

    /* One racer per TAB, not one per browser.
     *
     * Anonymous sign-in defaults to local persistence, which is scoped to the
     * origin — so two tabs of this app were handed the SAME uid and the room
     * saw one player however many tabs had joined. Both tabs were therefore
     * host, both published a scramble for every round, and because a rejected
     * write is applied locally before the server refuses it, each tab spent
     * the round showing the scramble it had generated itself. Two tabs, two
     * different scrambles, which is exactly what racing against yourself to
     * test the feature looked like.
     *
     * Session persistence is per tab and survives a reload of that tab, which
     * is the same identity the local transport gives out and the one the rest
     * of this file already assumes: hasOwnResult can still recognise you after
     * a refresh mid-round, and closing the tab — which leaves the room anyway
     * — is the only thing that retires the uid.
     */
    await authMod.setPersistence(auth, authMod.browserSessionPersistence)
      .catch(err => console.warn('[race] session persistence unavailable', err?.code || err));

    const cred = await authMod.signInAnonymously(auth);
    const db = dbMod.getDatabase(app);
    if (EMULATED) dbMod.connectDatabaseEmulator(db, '127.0.0.1', 9000);

    this._sdk = { ...dbMod, db };
    this._user = cred.user;
    this.snap.uid = cred.user.uid;

    /* Open the socket now, while nobody is waiting for it.
     *
     * The database client does not connect until something asks it for data,
     * so the first read of a join was paying for the websocket handshake as
     * well as itself — a second of it, on top of the sign-in, after the
     * button had already been pressed. `.info/connected` is a synthetic node
     * with no rules to satisfy and nothing to download; subscribing to it
     * exists purely to make the connection happen here instead of there. */
    this._unsubs.push(dbMod.onValue(dbMod.ref(db, '.info/connected'), (s) => {
      const up = s.val() === true;
      const wasUp = this._online;
      this._online = up;
      /* Coming back up is the interesting edge.
       *
       * The onDisconnect we registered on join is honoured the moment the
       * socket drops — including a drop of a few seconds on a phone changing
       * network — so by the time we are back the room has already forgotten
       * us. The heartbeat cannot put it right on its own either: it is an
       * update of `lastSeen` alone, and the rules require a player row to
       * carry a name, so on a missing row that write is simply refused. The
       * seat has to be written again whole. */
      if (up && wasUp === false) this._ensureSeat();
    }, () => {}));

    /* The server's clock, for the 1v1 seat's freshness: two players' own
       clocks can disagree by minutes, the server's is the one both read. */
    this._offset = 0;
    this._unsubs.push(dbMod.onValue(dbMod.ref(db, '.info/serverTimeOffset'), (s) => {
      this._offset = Number(s.val()) || 0;
    }, () => {}));

    return { uid: cred.user.uid };
  }

  /* ---- random 1v1: the one waiting seat (RACE.md §8) ---- */

  serverNow() { return Date.now() + (this._offset || 0); }

  get _matchRef() { return this._ref(`rooms/${MATCH_LOBBY}/meta/waiting`); }

  /**
   * Change the seat atomically. `fn(cur)` returns the new seat, or undefined
   * to leave it alone; it can run more than once, against fresher values.
   * Resolves to the seat as it stands afterwards.
   */
  async matchTransact(fn) {
    const res = await this._sdk.runTransaction(this._matchRef, (cur) => fn(cur ?? null), { applyLocally: false });
    return res.snapshot.val() ?? null;
  }

  /** Every change to the seat, until the returned function is called. */
  watchMatch(cb) {
    return this._sdk.onValue(this._matchRef, (s) => cb(s.val() ?? null), () => {});
  }

  /**
   * While we sit in the seat, the server clears it if this tab goes, so
   * nobody is matched with a closed tab. Unconditional, so it is cancelled
   * the moment we stop waiting: if it fired later it could clear someone
   * else's seat (which their next re-stamp would put back).
   */
  async armMatchDrop(on) {
    const d = this._sdk.onDisconnect(this._matchRef);
    await (on ? d.remove() : d.cancel()).catch(() => {});
  }

  /* ---- 1v1 cam and mic: the call's setup messages (RACE.md §9) ----
     rooms/<id>/rtc/<uid>, written only by that player and readable only by
     the people in the room. Paths are below that: 'media', 'desc',
     'ice/<sid>'. Nothing here carries video — it goes peer to peer. */

  _rtcRef(uid, path = '') { return this._ref(`${this._base}/rtc/${uid}${path ? `/${path}` : ''}`); }

  rtcSet(path, value) { return this._sdk.set(this._rtcRef(this.snap.uid, path), value); }

  rtcPush(path, value) { return this._sdk.set(this._sdk.push(this._rtcRef(this.snap.uid, path)), value); }

  /** The other player's node at `path`, now and on every change. Returns the unsubscribe. */
  rtcOn(uid, path, cb) {
    return this._sdk.onValue(this._rtcRef(uid, path), (s) => cb(s.val() ?? null), () => {});
  }

  /** Each child added under the other player's `path`, the ones already there first. */
  rtcOnAdded(uid, path, cb) {
    return this._sdk.onChildAdded(this._rtcRef(uid, path), (s) => cb(s.val()), () => {});
  }

  /** Ours gone, now and when this tab goes. */
  async rtcClear() { await this._sdk.remove(this._rtcRef(this.snap.uid)).catch(() => {}); }

  async rtcArm() { await this._sdk.onDisconnect(this._rtcRef(this.snap.uid)).remove().catch(() => {}); }

  /** TURN relay credentials from the Worker (worker.js /turn), or null when it has none. */
  async rtcIceServers() {
    const token = await this._user?.getIdToken();
    if (!token || !this.snap.roomId) return null;
    /* Counted, one per ask, under turnDay/<today>/<uid>: the admin console's
       only view of the relay, the one part of the site billed by the
       gigabyte. Not awaited, and a refusal (rules from before it) is nothing. */
    const now = this.serverNow();
    const day = now - ((now + 19800000) % 86400000);
    this._sdk.runTransaction(this._ref(`turnDay/${day}/${this.snap.uid}`), (n) => (n || 0) + 1).catch(() => {});
    const r = await fetch('/turn', {
      method: 'POST', cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ room: this.snap.roomId }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.iceServers) && j.iceServers.length ? { list: j.iceServers, ttl: Number(j.ttl) || 0 } : null;
  }

  _ref(path) { return this._sdk.ref(this._sdk.db, path); }
  get _base() { return `rooms/${this.snap.roomId}`; }

  _emit() {
    this.dispatchEvent(new CustomEvent('room', { detail: this.snap }));
  }

  async join(roomId, player) {
    const S = this._sdk;
    this.snap.roomId = roomId;
    const uid = this.snap.uid;

    /* Subscribe first, write second.
     *
     * Every step below is a round trip to the same server and none of them
     * depends on the subscription, so starting it here means the room's own
     * state is already on its way back while our player row is still going
     * out. That ordering is most of the wait people felt between pressing
     * Join and the panel showing anything at all: it used to be four serial
     * round trips (read, reap, create meta, write player) before a single
     * listener was attached. */
    this._listen();

    /* Reap a room nobody has been in for a while before counting heads.
       Without this an abandoned room keeps its ghosts forever and eventually
       reports itself full to people who could otherwise have used the code.

       Fetched as two subtree reads rather than one read of the room node.
       A read is authorised by a rule at that node or above it, so asking for
       rooms/<id> asks for permission the rules withhold on purpose — and
       granting it there would cascade down to `results` and undo the whole
       reveal gate. `meta` and `players` each carry their own `.read`. */
    const [metaSnap, playersSnap] = await Promise.all([
      S.get(this._ref(`${this._base}/meta`)),
      S.get(this._ref(`${this._base}/players`)),
    ]);
    const cur = { meta: metaSnap.val(), players: playersSnap.val() };
    if (cur?.players) {
      const now = Date.now();
      const dead = Object.entries(cur.players)
        .filter(([, p]) => now - (p.lastSeen || 0) > staleRoomMs());
      /* Not awaited. Clearing out ghosts is housekeeping for whoever reads
         this room next, and holding our own join behind a write we do not
         need the answer to bought nothing but the wait. */
      dead.forEach(([id]) => S.remove(this._ref(`${this._base}/players/${id}`)).catch(() => {}));
      const live = Object.keys(cur.players).length - dead.length;
      if (live >= (cur.meta?.kind === 'duel' ? 2 : roomMax()) && !cur.players[uid]) {
        // Undo the early subscription — we are not going to be in this room.
        this._teardown();
        this.snap = { ...emptySnapshot(), uid };
        /* Said out loud: the early subscription has already handed race.js
           this room's snapshot, and without a fresh one it went on believing
           it was inside a room that had just refused it. */
        this._emit();
        throw new Error('room-full');
      }
    }

    /* Kept, so the row can be written again after a reconnect. joinedAt is
       pinned to the value from THIS join rather than re-stamped: host is
       whoever joined first, and re-stamping it would hand the room a new host
       every time somebody's wifi blinked. */
    this._seat = {
      name: player.name, color: player.color,
      joinedAt: cur?.players?.[uid]?.joinedAt || Date.now(),
    };

    /* A new room while the admin console has them switched off (config/race,
       ADMIN.md): the rules refuse its meta, so say so before writing anything.
       Rooms already open are not affected. */
    const creating = !cur?.meta;
    if (creating) {
      await loadConfig();
      if (!getConfig('race', 'enabled')) {
        this._teardown();
        this.snap = { ...emptySnapshot(), uid };
        this._emit();
        throw new Error('race-off');
      }
    }

    /* Both writes at once. Creating the room and taking a seat in it are
       independent nodes with independent rules, and running them one after
       the other made creating a room measurably slower than joining one for
       no reason anybody could see. */
    try {
      await Promise.all([
        creating ? S.set(this._ref(`${this._base}/meta`), {
          createdAt: S.serverTimestamp(), event: player.event, mode: player.mode, round: 1,
          ...(player.kind ? { kind: player.kind } : {}),
        }) : null,
        this._ensureSeat(),
      ]);
    } catch (err) {
      /* Somebody created it a moment sooner: the second create is refused by
         the rule on meta/round, and the room is there to join. A matched 1v1
         is two people arriving at once, so this is its normal case. */
      const made = creating && await S.get(this._ref(`${this._base}/meta`)).then(s => s.exists(), () => false);
      if (made) { this._startHeartbeat(); return; }
      // Refused: switched off since the copy of the settings this tab has.
      if (creating && /permission/i.test(String(err?.code || err?.message || err))) {
        await loadConfig({ maxAge: 0 });
        if (!getConfig('race', 'enabled')) { await this.leave(); throw new Error('race-off'); }
      }
      throw err;
    }

    this._startHeartbeat();
  }

  /**
   * Write our player row, and arm the server-side removal that goes with it.
   *
   * Idempotent, and called on every reconnect as well as on join. The
   * onDisconnect is re-armed each time because it is consumed when it fires:
   * once the server has removed the row on our behalf, there is no standing
   * instruction left for the next drop.
   */
  async _ensureSeat() {
    const S = this._sdk;
    if (!this.snap.roomId || !this._seat) return;
    const me = this._ref(`${this._base}/players/${this.snap.uid}`);
    try {
      /* The one thing a client genuinely cannot do for itself: tell the room
         it has gone when the tab is closed, the laptop lid comes down, or the
         connection simply stops. */
      await S.onDisconnect(me).remove();
      await S.set(me, { ...this._seat, lastSeen: S.serverTimestamp() });
    } catch (err) {
      console.warn('[race] could not take a seat', err?.code || err);
    }
  }

  _listen() {
    const S = this._sdk;
    const on = (path, key) => {
      const un = S.onValue(this._ref(path), (s) => {
        this.snap[key] = s.val() || (key === 'players' ? {} : null);
        if (key === 'meta') this._syncRound();
        this._emit();
      }, () => { /* a denied or dropped listener is not fatal — see _watchResults */ });
      this._unsubs.push(un);
    };
    on(`${this._base}/meta`, 'meta');
    on(`${this._base}/players`, 'players');
    // Refused on rules from before it, which is the same as no marks at all.
    on(`${this._base}/mod`, 'mod');

    /* Chat comes back as a query, not a plain node.
     *
     * A room that has been going for an hour has a chat log nobody is going
     * to scroll, and onValue on the bare node would re-download all of it on
     * every single message. limitToLast asks the server for the tail and then
     * only ships what changed inside it. */
    const chatQ = S.query(this._ref(`${this._base}/chat`), S.limitToLast(CHAT_HISTORY));
    this._unsubs.push(S.onValue(chatQ, (snap) => {
      const out = [];
      // forEach on a query snapshot walks in the query's order; Object.entries
      // on .val() would not, and push ids are only sortable because they were
      // generated in order.
      snap.forEach((child) => { out.push({ id: child.key, ...child.val() }); });
      this.snap.chat = out;
      this._emit();
    }, () => {}));
  }

  /**
   * Say something to the room, in any phase.
   *
   * Rejections are left to surface, so a caller can tell the difference
   * between "sent" and "the room would not take it".
   */
  async sendChat(text) {
    // The admin console can shorten it (config/raceChat/maxLen); the rules hold the same line.
    const body = cleanChat(text).slice(0, getConfig('raceChat', 'maxLen'));
    if (!body || !this.snap.roomId) return;
    const S = this._sdk;
    const uid = this.snap.uid;
    const id = S.push(this._ref(`${this._base}/chat`)).key;
    const msg = { uid, name: this._seat?.name || 'Cuber', text: body, at: S.serverTimestamp() };
    /* With chatLast/<uid> in the same update: the rules' rate limit since the
       admin console, the same pair as the day's chat. On rules from before it
       the pair is refused whole (chatLast has no rule there), and the message
       alone is what works. Whichever worked last goes first; a refusal tries
       the other once, so a tab open across the rules being published keeps
       talking. A genuine refusal (banned, switched off) costs two writes. */
    const pair = () => S.update(this._ref(this._base), { [`chat/${id}`]: msg, [`chatLast/${uid}`]: S.serverTimestamp() });
    const alone = () => S.set(this._ref(`${this._base}/chat/${id}`), msg);
    const order = this._chatShape === 'old' ? [['old', alone], ['new', pair]] : [['new', pair], ['old', alone]];
    let refused;
    for (const [shape, send] of order) {
      try { await send(); this._chatShape = shape; return; }
      catch (err) {
        if (!/permission/i.test(String(err?.code || err?.message || err))) throw err;
        refused = err;
      }
    }
    throw refused;
  }

  /**
   * This racer's own ban, if an admin has banned it (bans/<uid>, readable by
   * the account itself), else null. Asked only to explain a refused message:
   * a race account is a throwaway, so it is not watched.
   */
  async banOf() {
    try { return (await this._sdk.get(this._ref(`bans/${this.snap.uid}`))).val() || null; }
    catch { return null; }
  }

  /** Point the round listeners at whatever meta.round now says. */
  _syncRound() {
    const n = this.snap.meta?.round;
    if (!n || n === this._watchedRound) return;
    this._watchedRound = n;
    this._roundUnsubs.forEach(u => u());
    this._roundUnsubs = [];
    this.snap.round = { no: n, info: null, progress: {}, results: {} };
    this.snap.resultsUnlocked = false;

    const S = this._sdk;
    const path = `${this._base}/rounds/${n}`;
    this._roundUnsubs.push(
      S.onValue(this._ref(`${path}/info`), (s) => {
        if (this.snap.round?.no === n) { this.snap.round.info = s.val(); this._emit(); }
      }, () => {}),
      S.onValue(this._ref(`${path}/progress`), (s) => {
        if (this.snap.round?.no === n) { this.snap.round.progress = s.val() || {}; this._emit(); }
      }, () => {}),
    );
  }

  /**
   * Start reading other people's times.
   *
   * Deliberately not attached when the round opens. Before your own result
   * exists the rule refuses this read, and an attached listener would sit
   * there generating a PERMISSION_DENIED every time the node changed — noise
   * in the console that looks exactly like a bug. Attaching it only once the
   * read is allowed is both quieter and a second, independent statement of
   * the same rule.
   */
  unlockResults() {
    if (this.snap.resultsUnlocked || !this.snap.round) return;
    const n = this.snap.round.no;
    const S = this._sdk;
    this.snap.resultsUnlocked = true;
    this._roundUnsubs.push(
      S.onValue(this._ref(`${this._base}/rounds/${n}/results`), (s) => {
        if (this.snap.round?.no === n) { this.snap.round.results = s.val() || {}; this._emit(); }
      }, (err) => {
        // The one read that is *expected* to fail if we got here early.
        console.warn('[race] results still locked', err?.code || err);
      }),
    );
    this._emit();
  }

  async openRound(n, info) {
    const S = this._sdk;
    try {
      await S.set(this._ref(`${this._base}/rounds/${n}/info`), { ...info, startedAt: S.serverTimestamp() });
    } catch {
      /* Write-once: somebody else opened this round a moment sooner. Their
         scramble is now the round's scramble and the listener will hand it to
         us — which is the whole point of making the field immutable. */
    }
  }

  async setMeta(patch) {
    await this._sdk.update(this._ref(`${this._base}/meta`), patch).catch(() => {});
  }

  /**
   * Has this client already written a result for the round?
   *
   * Reading your OWN result is always permitted — that is the first branch of
   * the read rule — so this works even before the reveal unlocks. It is how a
   * reload mid-round remembers that you have already had your attempt.
   */
  async hasOwnResult(n) {
    try {
      const s = await this._sdk.get(this._ref(`${this._base}/rounds/${n}/results/${this.snap.uid}`));
      return s.exists();
    } catch { return false; }
  }

  /**
   * Every time in round n, read once — or null if the read is refused.
   *
   * The live listener is dropped the moment the pointer moves on, and the
   * pointer can move on before the last finisher's time has reached this tab:
   * somebody else's clock settled first. The same rule that gated the live
   * read gates this one, so it only ever answers a round you raced yourself.
   */
  async fetchResults(n) {
    try {
      const s = await this._sdk.get(this._ref(`${this._base}/rounds/${n}/results`));
      return s.val() || {};
    } catch { return null; }
  }

  /**
   * Keep listening to a round after the room has moved past it.
   *
   * A penalty can be added after the time went in (setPenalty below), and
   * the last round is exactly when that happens: you stop, the room moves on
   * a moment later, and only then do you press +2. Returns the unsubscribe.
   */
  watchResults(n, cb) {
    return this._sdk.onValue(this._ref(`${this._base}/rounds/${n}/results`),
      (s) => cb(s.val() || {}), () => {});
  }

  /**
   * The one change a submitted result still takes: its penalty, from its owner.
   * The rules let it get heavier at any time and lighter only for 15 s after
   * submitting (firebase.rules.json; tools/verify-penalty-rules.mjs).
   */
  async setPenalty(n, penalty) {
    const S = this._sdk;
    const mine = `${this._base}/rounds/${n}/results/${this.snap.uid}`;
    /* With the time it changed, so a moderator looking into a dispute can see
       how long after the solve it came. Rules from before penaltyAt refuse the
       pair: the penalty then goes alone, as it always did. */
    try {
      await S.update(this._ref(mine), { penalty, penaltyAt: S.serverTimestamp() });
    } catch (err) {
      if (!/permission/i.test(String(err?.code || err?.message || err))) throw err;
      await S.set(this._ref(`${mine}/penalty`), penalty);
    }
  }

  async advanceRound(next) {
    const S = this._sdk;
    // A transaction, so two clients deciding "the round is over" at the same
    // instant advance it once between them rather than twice.
    await S.runTransaction(this._ref(`${this._base}/meta/round`),
      (cur) => (cur === next - 1 ? next : undefined));
  }

  async setProgress(patch) {
    const n = this.snap.round?.no;
    if (!n) return;
    const S = this._sdk;
    const out = { ...patch };
    // The clock the client cannot lie to. Both ends of the solve are stamped
    // by the server, and the result write is validated against their gap.
    if (patch.status === 'solving') out.startedAt = S.serverTimestamp();
    if (patch.status === 'done') out.finishedAt = S.serverTimestamp();
    await S.update(this._ref(`${this._base}/rounds/${n}/progress/${this.snap.uid}`), out);
  }

  async submitResult(result) {
    const n = this.snap.round?.no;
    if (!n) return;
    const S = this._sdk;
    await S.set(this._ref(`${this._base}/rounds/${n}/results/${this.snap.uid}`),
      { ...result, submittedAt: S.serverTimestamp() });
  }

  _startHeartbeat() {
    clearInterval(this._beat);
    /* Slow, and a plain interval rather than a write per state change. The
       room already learns everything that matters from progress writes; this
       exists only so a client whose onDisconnect never fired can be told
       apart from one that is merely thinking. */
    this._beat = setInterval(() => {
      if (!this.snap.roomId) return;
      /* A row that is not there any more cannot be patched — the rules want a
         name on it — so notice that case and write the whole seat instead.
         This is the backstop for a drop the `.info/connected` edge missed. */
      if (!this.snap.players?.[this.snap.uid]) { this._ensureSeat(); return; }
      this._sdk.update(this._ref(`${this._base}/players/${this.snap.uid}`),
        { lastSeen: this._sdk.serverTimestamp() }).catch(() => {});
    }, heartbeatMs());
  }

  async leave() {
    const S = this._sdk;
    if (!this.snap.roomId) return;
    const base = this._base;
    const uid = this.snap.uid;
    this._teardown();
    try {
      await S.remove(this._ref(`${base}/players/${uid}`));
      // Last one out turns the lights off, so an idle room stops costing
      // anybody storage the moment it is genuinely empty.
      const left = await S.get(this._ref(`${base}/players`));
      if (!left.exists()) await S.remove(this._ref(base));
    } catch { /* leaving is best-effort; onDisconnect is the real guarantee */ }
    this.snap = { ...emptySnapshot(), uid };
    this._emit();
  }

  _teardown() {
    clearInterval(this._beat);
    this._unsubs.forEach(u => u());
    this._roundUnsubs.forEach(u => u());
    this._unsubs = []; this._roundUnsubs = [];
    this._watchedRound = null;
  }

  destroy() { this._teardown(); }
}

/* =========================================================
   Local transport — same browser, several tabs

   localStorage holds the room; BroadcastChannel says when it changed. No
   account, no project, no network: this is what makes race mode testable on
   one machine and demoable with no setup at all.

   It enforces nothing. Every tab is the same trusted origin and could write
   whatever it liked, so the reveal gate here is UI politeness rather than a
   guarantee — race.js says so out loud in the panel rather than letting the
   two modes look identical when they are not.
   ========================================================= */
class LocalTransport extends EventTarget {
  constructor() {
    super();
    this.kind = 'local';
    this.snap = emptySnapshot();
    this._chan = null;
    this._beat = 0;
    this._onStorage = null;
  }

  async init() {
    // Per tab, not per browser: two tabs have to be two racers or there is
    // nothing to test. sessionStorage is exactly "this tab, until it closes".
    let uid = sessionStorage.getItem('tdt-race-uid');
    if (!uid) {
      uid = 'L' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('tdt-race-uid', uid);
    }
    this.snap.uid = uid;
    return { uid };
  }

  get _key() { return `tdt-race-room-${this.snap.roomId}`; }

  /* ---- random 1v1: the one waiting seat, between this browser's tabs ---- */

  serverNow() { return Date.now(); }

  /** Read, change, write: no transaction to be had, same as the rooms. */
  async matchTransact(fn) {
    const key = 'tdt-race-match';
    let cur = null;
    try { cur = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    const next = fn(cur);
    if (next === undefined) return cur;
    if (next === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(next));
    const chan = new BroadcastChannel('tdt-race-match');
    chan.postMessage('changed');
    chan.close();
    return next;
  }

  watchMatch(cb) {
    const read = () => { try { cb(JSON.parse(localStorage.getItem('tdt-race-match') || 'null')); } catch {} };
    const chan = new BroadcastChannel('tdt-race-match');
    chan.onmessage = read;
    const onStorage = (e) => { if (e.key === 'tdt-race-match') read(); };
    addEventListener('storage', onStorage);
    read();
    return () => { chan.close(); removeEventListener('storage', onStorage); };
  }

  /** A closed tab's seat just goes stale here; nothing to arm. */
  async armMatchDrop() {}

  /* ---- 1v1 cam and mic, between this browser's tabs ----
     The same tree as the hosted rtc/ node, in one localStorage entry per
     room, and the same five calls. */

  get _rtcKey() { return `tdt-race-rtc-${this.snap.roomId}`; }

  _rtcRead() {
    try { return JSON.parse(localStorage.getItem(this._rtcKey) || '{}'); } catch { return {}; }
  }

  _rtcWrite(fn) {
    const all = this._rtcRead();
    fn(all);
    localStorage.setItem(this._rtcKey, JSON.stringify(all));
    this._rtcBus().postMessage('changed');
    this._rtcFire();
  }

  /** One channel per room, and every listener re-reads on any change. */
  _rtcBus() {
    if (this._rtcChan?.name !== `tdt-race-rtc-${this.snap.roomId}`) {
      this._rtcChan?.close();
      this._rtcChan = new BroadcastChannel(`tdt-race-rtc-${this.snap.roomId}`);
      this._rtcChan.onmessage = () => this._rtcFire();
      this._rtcSubs ||= new Set();
    }
    return this._rtcChan;
  }

  _rtcFire() { for (const fn of this._rtcSubs || []) fn(); }

  _rtcSub(fn) {
    this._rtcBus();
    this._rtcSubs.add(fn);
    fn();
    return () => this._rtcSubs.delete(fn);
  }

  static _at(obj, path) { return path.split('/').reduce((o, k) => (o == null ? o : o[k]), obj); }

  static _put(obj, path, value) {
    const keys = path.split('/');
    const last = keys.pop();
    const parent = keys.reduce((o, k) => (o[k] ||= {}), obj);
    if (value == null) delete parent[last]; else parent[last] = value;
  }

  async rtcSet(path, value) {
    const me = this.snap.uid;
    this._rtcWrite((all) => LocalTransport._put(all, `${me}/${path}`, value));
  }

  async rtcPush(path, value) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    await this.rtcSet(`${path}/${id}`, value);
  }

  rtcOn(uid, path, cb) {
    let last;
    return this._rtcSub(() => {
      const v = LocalTransport._at(this._rtcRead(), `${uid}/${path}`) ?? null;
      const key = JSON.stringify(v);
      if (key !== last) { last = key; cb(v); }
    });
  }

  rtcOnAdded(uid, path, cb) {
    const seen = new Set();
    return this._rtcSub(() => {
      const kids = LocalTransport._at(this._rtcRead(), `${uid}/${path}`) || {};
      for (const [k, v] of Object.entries(kids)) if (!seen.has(k)) { seen.add(k); cb(v); }
    });
  }

  async rtcClear() {
    if (!this.snap.roomId) return;
    const me = this.snap.uid;
    this._rtcWrite((all) => { delete all[me]; });
  }

  async rtcArm() {
    addEventListener('pagehide', () => { try { this.rtcClear(); } catch {} }, { once: true });
  }

  _read() {
    try { return JSON.parse(localStorage.getItem(this._key) || 'null'); }
    catch { return null; }
  }

  /**
   * Read, change, write, announce.
   *
   * Two tabs writing in the same tick can lose an edit — there is no
   * transaction here to have. In practice each tab only ever writes its own
   * player, its own progress and its own result, so the writes do not overlap;
   * the shared fields (meta.round, round info) are guarded by the same
   * write-once and advance-by-one rules the Firebase side uses.
   */
  _mutate(fn) {
    const room = this._read() || { meta: null, players: {}, rounds: {} };
    const out = fn(room);
    if (out === false) return room;
    localStorage.setItem(this._key, JSON.stringify(room));
    this._chan?.postMessage('changed');
    this._pull();
    return room;
  }

  _pull() {
    const room = this._read();
    if (!room) return;
    /* Two tabs joining in the same instant each read the room, add their own
       seat and write it back, and the slower write drops the faster one's
       seat — there is no transaction here to have. A matched 1v1 is exactly
       two tabs joining at once, so this is its normal case: put ours back the
       moment we notice it is gone. */
    if (this._seat && !room.players?.[this.snap.uid] && !this._reseating) {
      this._reseating = true;
      try {
        this._mutate((r) => {
          r.players ||= {};
          r.players[this.snap.uid] = { ...this._seat, lastSeen: Date.now() };
        });
      } finally { this._reseating = false; }
      return;
    }
    this.snap.meta = room.meta || null;
    this.snap.players = room.players || {};
    this.snap.chat = room.chat || [];
    const n = room.meta?.round;
    if (n) {
      const r = room.rounds?.[n] || {};
      const wasUnlocked = this.snap.resultsUnlocked && this.snap.round?.no === n;
      this.snap.round = {
        no: n,
        info: r.info || null,
        progress: r.progress || {},
        // The gate, kept honest in the one place it can be: results are not
        // copied into the snapshot until this client has submitted its own.
        results: wasUnlocked ? (r.results || {}) : {},
      };
      this.snap.resultsUnlocked = wasUnlocked;
    }
    this.dispatchEvent(new CustomEvent('room', { detail: this.snap }));
  }

  async join(roomId, player) {
    this.snap.roomId = roomId;
    const uid = this.snap.uid;

    this._mutate((room) => {
      const now = Date.now();
      for (const [id, p] of Object.entries(room.players || {})) {
        if (now - (p.lastSeen || 0) > staleRoomMs()) delete room.players[id];
      }
      if (Object.keys(room.players || {}).length >= (room.meta?.kind === 'duel' ? 2 : roomMax()) && !room.players[uid]) {
        throw new Error('room-full');
      }
      room.meta ||= {
        createdAt: now, event: player.event, mode: player.mode, round: 1,
        ...(player.kind ? { kind: player.kind } : {}),
      };
      room.players[uid] = { name: player.name, color: player.color, joinedAt: now, lastSeen: now };
      // Kept, so _pull can put the seat back if another tab's write drops it.
      this._seat = { name: player.name, color: player.color, joinedAt: now };
    });

    this._chan = new BroadcastChannel(`tdt-race-${roomId}`);
    this._chan.onmessage = () => this._pull();
    // BroadcastChannel does not reach a tab that was asleep when the message
    // went out; the storage event does. Both, so neither gap matters.
    this._onStorage = (e) => { if (e.key === this._key) this._pull(); };
    addEventListener('storage', this._onStorage);

    this._beat = setInterval(() => {
      this._mutate((room) => { if (room.players?.[uid]) room.players[uid].lastSeen = Date.now(); else return false; });
    }, heartbeatMs());

    /* Drop our own row, and nothing else.
     *
     * Deliberately NOT leave(): a reload fires pagehide too, and leave() reaps
     * the whole room when it empties. A single racer refreshing the page —
     * or two people refreshing at once — therefore destroyed a live race and
     * everybody landed back in the lobby. Closing a tab should retire the
     * player; only pressing Leave should be able to retire the room. */
    addEventListener('pagehide', () => { try { this._removeSelf(); } catch {} });
    this._pull();
  }

  async openRound(n, info) {
    this._mutate((room) => {
      room.rounds ||= {};
      room.rounds[n] ||= {};
      if (room.rounds[n].info) return false;          // write-once, first wins
      room.rounds[n].info = { ...info, startedAt: Date.now() };
    });
  }

  async advanceRound(next) {
    this._mutate((room) => {
      if (room.meta?.round !== next - 1) return false;  // advance by exactly one
      room.meta.round = next;
    });
  }

  async setMeta(patch) {
    this._mutate((room) => { room.meta = { ...(room.meta || {}), ...patch }; });
  }

  async setProgress(patch) {
    const n = this.snap.round?.no;
    if (!n) return;
    this._mutate((room) => {
      room.rounds ||= {}; room.rounds[n] ||= {}; room.rounds[n].progress ||= {};
      const cur = room.rounds[n].progress[this.snap.uid] || {};
      const out = { ...cur, ...patch };
      if (patch.status === 'solving') out.startedAt = Date.now();
      if (patch.status === 'done') out.finishedAt = Date.now();
      room.rounds[n].progress[this.snap.uid] = out;
    });
  }

  async submitResult(result) {
    const n = this.snap.round?.no;
    if (!n) return;
    this._mutate((room) => {
      room.rounds ||= {}; room.rounds[n] ||= {}; room.rounds[n].results ||= {};
      if (room.rounds[n].results[this.snap.uid]) return false;   // write-once
      room.rounds[n].results[this.snap.uid] = { ...result, submittedAt: Date.now() };
    });
  }

  /** The local room's chat. Open in every phase, same as the hosted one. */
  async sendChat(text) {
    const body = cleanChat(text);
    if (!body || !this.snap.roomId) return;
    const uid = this.snap.uid;
    this._mutate((room) => {
      room.chat ||= [];
      room.chat.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        uid, name: room.players?.[uid]?.name || 'Cuber', text: body, at: Date.now(),
      });
      // Trimmed on write because there is no query to do it on read.
      if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
    });
  }

  unlockResults() {
    if (!this.snap.round) return;
    this.snap.resultsUnlocked = true;
    this._pull();
  }

  /** Retire this player. The room survives whether or not anyone is left. */
  _removeSelf() {
    const uid = this.snap.uid;
    this._seat = null;      // gone on purpose: _pull must not put it back
    this._mutate((room) => { delete room.players?.[uid]; });
  }

  /** Has this client already written a result for the round? */
  async hasOwnResult(n) {
    const room = this._read();
    return !!room?.rounds?.[n]?.results?.[this.snap.uid];
  }

  /** The same gate as the hosted rule: only a round you have a result in. */
  async fetchResults(n) {
    const res = this._read()?.rounds?.[n]?.results;
    return res?.[this.snap.uid] ? { ...res } : null;
  }

  /** Every change to the room is a 'room' event here, so re-read on each. */
  watchResults(n, cb) {
    const read = () => { const r = this._read()?.rounds?.[n]?.results; if (r?.[this.snap.uid]) cb({ ...r }); };
    this.addEventListener('room', read);
    read();
    return () => this.removeEventListener('room', read);
  }

  /** The hosted rules' window is not modelled: nothing here is enforced. */
  async setPenalty(n, penalty) {
    this._mutate((room) => {
      const mine = room.rounds?.[n]?.results?.[this.snap.uid];
      if (!mine) return false;
      mine.penalty = penalty;
    });
  }

  async leave() {
    if (!this.snap.roomId) return;
    const uid = this.snap.uid;
    const key = this._key;
    this._seat = null;
    this._mutate((room) => {
      delete room.players?.[uid];
      // Only a deliberate Leave reaps the room, and only when it is genuinely
      // empty — see the pagehide note above for why this cannot be the path a
      // reload takes.
      if (!Object.keys(room.players || {}).length) {
        localStorage.removeItem(key);
        return false;
      }
    });
    this.destroy();
    this.snap = { ...emptySnapshot(), uid };
    this.dispatchEvent(new CustomEvent('room', { detail: this.snap }));
  }

  destroy() {
    clearInterval(this._beat);
    this._chan?.close();
    this._chan = null;
    this._rtcChan?.close();
    this._rtcChan = null;
    this._rtcSubs?.clear();
    if (this._onStorage) removeEventListener('storage', this._onStorage);
    this._onStorage = null;
  }
}

/* =========================================================
   Selection
   ========================================================= */

/** Whether real, over-the-internet racing is configured on this deployment. */
export const cloudAvailable = () => !!FIREBASE_CONFIG;

/**
 * @param {'auto'|'firebase'|'local'} [prefer]
 * @returns {FirebaseTransport|LocalTransport}
 */
export function createTransport(prefer = 'auto') {
  const useCloud = prefer === 'firebase' || (prefer === 'auto' && cloudAvailable());
  return useCloud ? new FirebaseTransport() : new LocalTransport();
}

/** Exported so race.js and the UI agree on what counts as gone. */
export const isStale = (p, now = Date.now()) => now - (p?.lastSeen || 0) > hardTimeoutMs();
