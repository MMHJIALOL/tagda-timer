/* ===========================================================
   Tagda Timer — race transport

   Two implementations of one small interface, so nothing above this file
   knows or cares which is in use:

     init()            connect + establish an identity, resolves { uid }
     join(id, player)  enter a room
     leave()           exit, and reap the room if you were the last out
     setProgress(p)    your status for the live round — never a time
     submitResult(r)   your time for the live round — write-once
     openRound(n, i)   publish a round's scramble (write-once, first wins)
     advanceRound(n)   move the room's pointer forward by exactly one
     unlockResults()   start reading other people's times
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
   =========================================================== */

import {
  FIREBASE_CONFIG, FIREBASE_VERSION, ROOM_MAX,
  HEARTBEAT_MS, STALE_ROOM_MS, HARD_TIMEOUT_MS,
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
});

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
    const cred = await authMod.signInAnonymously(auth);
    const db = dbMod.getDatabase(app);

    this._sdk = { ...dbMod, db };
    this.snap.uid = cred.user.uid;
    return { uid: cred.user.uid };
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
        .filter(([, p]) => now - (p.lastSeen || 0) > STALE_ROOM_MS);
      await Promise.all(dead.map(([id]) => S.remove(this._ref(`${this._base}/players/${id}`))));
      const live = Object.keys(cur.players).length - dead.length;
      if (live >= ROOM_MAX && !cur.players[uid]) throw new Error('room-full');
    }

    if (!cur?.meta) {
      await S.set(this._ref(`${this._base}/meta`), {
        createdAt: S.serverTimestamp(), event: player.event, mode: player.mode, round: 1,
      });
    }

    const me = this._ref(`${this._base}/players/${uid}`);
    await S.set(me, {
      name: player.name, color: player.color,
      joinedAt: S.serverTimestamp(), lastSeen: S.serverTimestamp(),
    });
    /* The one thing a client genuinely cannot do for itself: tell the room it
       has gone when the tab is closed, the laptop lid comes down, or the
       connection simply stops. Registered with the server up front and fired
       by the server when the socket drops. */
    S.onDisconnect(me).remove();

    this._listen();
    this._startHeartbeat();
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
      this._sdk.update(this._ref(`${this._base}/players/${this.snap.uid}`),
        { lastSeen: this._sdk.serverTimestamp() }).catch(() => {});
    }, HEARTBEAT_MS);
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
    this.snap.meta = room.meta || null;
    this.snap.players = room.players || {};
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
        if (now - (p.lastSeen || 0) > STALE_ROOM_MS) delete room.players[id];
      }
      if (Object.keys(room.players || {}).length >= ROOM_MAX && !room.players[uid]) {
        throw new Error('room-full');
      }
      room.meta ||= { createdAt: now, event: player.event, mode: player.mode, round: 1 };
      room.players[uid] = { name: player.name, color: player.color, joinedAt: now, lastSeen: now };
    });

    this._chan = new BroadcastChannel(`tdt-race-${roomId}`);
    this._chan.onmessage = () => this._pull();
    // BroadcastChannel does not reach a tab that was asleep when the message
    // went out; the storage event does. Both, so neither gap matters.
    this._onStorage = (e) => { if (e.key === this._key) this._pull(); };
    addEventListener('storage', this._onStorage);

    this._beat = setInterval(() => {
      this._mutate((room) => { if (room.players?.[uid]) room.players[uid].lastSeen = Date.now(); else return false; });
    }, HEARTBEAT_MS);

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

  unlockResults() {
    if (!this.snap.round) return;
    this.snap.resultsUnlocked = true;
    this._pull();
  }

  /** Retire this player. The room survives whether or not anyone is left. */
  _removeSelf() {
    const uid = this.snap.uid;
    this._mutate((room) => { delete room.players?.[uid]; });
  }

  /** Has this client already written a result for the round? */
  async hasOwnResult(n) {
    const room = this._read();
    return !!room?.rounds?.[n]?.results?.[this.snap.uid];
  }

  async leave() {
    if (!this.snap.roomId) return;
    const uid = this.snap.uid;
    const key = this._key;
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
export const isStale = (p, now = Date.now()) => now - (p?.lastSeen || 0) > HARD_TIMEOUT_MS;
