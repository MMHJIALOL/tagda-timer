import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — cloud sync engine

   Always on, never a button. Once signed in:
     - every Solves.put/putMany, Sessions.put, and the 'settings'/'learn'
       KV keys are mirrored to users/<uid>/... in the Realtime Database
       (solves/sessions immediately, settings/learn debounced).
     - a websocket listener pulls the same tree back down and applies it
       to local IndexedDB.
     - a failed or offline push is queued (in the 'kv' store, key
       '_syncQueue') and retried on reconnect.
     - a delete is mirrored too: the cloud row is removed, and db.js's
       tombstone stops the copy already in flight from landing back.

   Deleting used to be the one thing that did NOT cross the wire, which
   made it look like it had not worked at all: the row left IndexedDB, the
   cloud kept its copy, and the next reload's onChildAdded handed it
   straight back. A delete is now as real as a write in both directions.

   Merging two histories, on the other hand, is still additive — see
   mergeOnSignIn(), the one place data from two devices that have never met
   before gets combined. It just no longer counts a deliberately deleted
   solve as something the other side is missing.
   =========================================================== */

import { Solves, Sessions, KV, Tombstones, onWrite, tx, wrap } from './db.js';
import { onAuthChange, getDatabaseHandle } from './sync-auth.js';

const QUEUE_KEY = '_syncQueue';
const KV_DEBOUNCE_MS = 1500;

/* Record stores mirrored to users/<uid>/<store>, and the field each is keyed
   by. Cubes and their log, and the 3BLD letter-pair dictionary. */
const RECORD_STORES = { gear: 'id', gearLog: 'id', letterPairs: 'pair' };

/* KV keys mirrored to users/<uid>/kv/<key>, besides 'settings' and 'learn'
   which keep their own nodes. Left out on purpose: spotify tokens (a secret
   for this browser), gear.active and fmc.attempt (what is on this desk right
   now), customScrambles (a queue position), the tombstones and sync queue. */
export const isSyncedKv = (key) =>
  key.startsWith('alglib:') || key === 'xp1Settings' || key === 'xp1History';

/* Database keys cannot contain . # $ [ ] or /. */
export const encKey = (key) => encodeURIComponent(key).replace(/\./g, '%2E');
export const decKey = (k) => decodeURIComponent(k);

/* Settings that say where this browser is right now rather than how it is set
   up. Pushed like the rest, never adopted from another device — switching
   event on the laptop must not switch it on the phone mid-solve. */
export const LOCAL_ONLY_SETTINGS = ['sessionId', 'event', 'mode', 'raceReturnSession', 'raceLastRoom'];

/**
 * Serializes every read-modify-write against the offline queue. KV.get/set
 * are two separate IndexedDB round-trips with nothing atomic linking them,
 * so two queueWrite() calls racing (e.g. a burst of solves recorded while
 * offline) could otherwise both read the queue before either writes it
 * back, silently dropping one entry. JS is single-threaded, so chaining
 * every queue-touching operation off one promise is a real mutex here.
 */
let _queueLock = Promise.resolve();
function withQueueLock(fn) {
  const run = _queueLock.then(fn, fn);
  _queueLock = run.then(() => {}, () => {});
  return run;
}

/* ---------------------------------------------------------
   Pure helpers — no network, no IndexedDB. Exported for tests.
   --------------------------------------------------------- */

/**
 * Union two lists of records (solves or sessions) by id. A record present
 * on both sides is assumed to already be the same record — this path is
 * for combining two devices' history, not for resolving a live edit
 * conflict (that's applyRemoteChange, which trusts the incoming side).
 */
export function unionById(localList, remoteList) {
  const byId = new Map();
  for (const r of localList) byId.set(r.id, r);
  for (const r of remoteList) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

/**
 * Splits a cloud list into what this device still wants and what it has
 * already thrown away.
 *
 * A union treats "absent locally" as "missing here, copy it down", which is
 * right for a device that has never seen the record and exactly wrong for
 * one that deleted it on purpose — that is the resurrection, in the merge
 * path rather than the listener path. The tombstones say which is which,
 * and the dead half is what gets cleared from the cloud instead.
 */
export function partitionDeleted(list, tombs) {
  const live = [], dead = [];
  for (const r of list) (tombs[r.id] ? dead : live).push(r);
  return { live, dead };
}

/* The database hands a record back with its keys sorted and every null, empty
   array and empty object dropped, so comparing bytes with the local copy would
   call nearly every record changed. */
function canon(v) {
  if (Array.isArray(v)) return v.length ? v.map(canon) : undefined;
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      const c = canon(v[k]);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v ?? undefined;
}

/** Same record as far as the cloud can tell, whichever side it came from. */
export const sameRecord = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * What each side is missing, by id. On a shared id that differs, `localWins`
 * picks the side: true for two histories meeting for the first time (the old
 * union, where this device's copy won), false once this browser has synced
 * with the account before — then the cloud has every edit made elsewhere
 * while this device was closed, and this device's own edits since went out
 * through the push path or are sitting in the queue that start() flushes.
 */
export function diffById(local, cloud, localWins) {
  const cloudById = new Map(cloud.map(r => [r.id, r]));
  const localById = new Map(local.map(r => [r.id, r]));
  const up = local.filter(r => cloudById.has(r.id)
    ? localWins && !sameRecord(r, cloudById.get(r.id)) : true);
  const down = cloud.filter(r => localById.has(r.id)
    ? !localWins && !sameRecord(r, localById.get(r.id)) : true);
  return { up, down };
}

/** Keeps whichever side is further along (higher `box`) per case, same rule as db.js importAll. */
export function mergeLearn(localMap, remoteMap) {
  const out = { ...(localMap || {}) };
  for (const [k, v] of Object.entries(remoteMap || {})) {
    const cur = out[k];
    if (!cur || (v && (v.box ?? 0) > (cur.box ?? 0))) out[k] = v;
  }
  return out;
}

/**
 * What to do with the account's existing cloud data on sign-in.
 *   'upload' — cloud has nothing yet (or nothing local to lose either way),
 *              or this device has already merged with this account once;
 *              no ambiguity, no dialog.
 *   'merge'  — two histories that have never met; show the merge dialog,
 *              then union.
 *
 * `mergedBefore` is what keeps the dialog to once per account per device.
 * The counts alone can never say "already done": the merge writes the union
 * to both sides, so both stay above zero forever and every reload asks again.
 */
export function decideMergeAction({ localCount, cloudCount, mergedBefore }) {
  if (mergedBefore) return 'upload';
  if (cloudCount > 0 && localCount > 0) return 'merge';
  return 'upload';
}

/* ---------------------------------------------------------
   Live engine
   --------------------------------------------------------- */

let _sdk = null;          // { db, ref, set, update, onChildAdded, onChildChanged, onValue, auth }
let _uid = null;
let _unsubs = [];
const _kvTimers = new Map();      // key -> setTimeout id

/**
 * Detects the echo of a write we ourselves just applied from a remote
 * change, so it doesn't get pushed straight back to the cloud — keyed by
 * content, not by a time-boxed flag. A boolean "just applied this id,
 * ignore the next push" flag has a real race: Solves.put resolves through
 * openDB()'s promise chain, so a genuine local edit to the same id arriving
 * while that flag is still set would be silently dropped instead of pushed.
 * Comparing the pushed value against the value we last applied from the
 * network sidesteps the ordering question entirely — an echo is
 * byte-identical to what was just written; a real subsequent edit isn't,
 * no matter how the two promises interleave.
 */
const _lastRemoteJSON = new Map();

function userPath(...parts) { return ['users', _uid, ...parts].join('/'); }

/**
 * Remembers that this browser has already reconciled with this account, so
 * the merge dialog is asked once and never again.
 *
 * Deliberately local, not a flag in the database. A cloud flag would need a
 * new node under users/<uid>, and the rules that permit it are published by
 * hand into the Firebase console (RACE.md §4) — until someone does that, the
 * write is rejected and the flag silently never sticks. localStorage needs
 * no deployment step and is read synchronously on the sign-in path.
 *
 * Losing it (cleared site data, a private window) costs at most one extra
 * dialog and never any data: the merge is a union either way.
 */
const mergedKey = (uid) => `sync:merged:${uid}`;

function hasMergedBefore(uid) {
  try { return !!localStorage.getItem(mergedKey(uid)); } catch { return false; }
}

function rememberMerged(uid) {
  try { localStorage.setItem(mergedKey(uid), String(Date.now())); } catch {}
}

async function queueWrite(entry) {
  return withQueueLock(async () => {
    const q = (await KV.get(QUEUE_KEY, [])) || [];
    q.push(entry);
    await KV.set(QUEUE_KEY, q);
  });
}

/* Paths this device has written and the server has not yet accepted. A
   rejected write — say rules for a new node not yet published — makes the
   SDK roll back its optimistic copy, and that rollback arrives as an
   ordinary child_removed. Taken at face value it deleted the local row: a
   cube added while signed in was gone after the next reload. A removal on a
   path listed here is that rollback, not another device's delete. */
const _unconfirmed = new Set();
const isUnconfirmed = (...parts) => _unconfirmed.has(userPath(...parts));

async function pushOrQueue(path, value) {
  if (value != null) _unconfirmed.add(path);
  if (!_sdk || navigator.onLine === false) { await queueWrite({ kind: 'set', path, value }); return; }
  try {
    await _sdk.set(_sdk.ref(_sdk.db, path), value);
    _unconfirmed.delete(path);
  } catch (err) {
    console.warn('[sync] push failed, queued for retry', path, err?.code || err);
    await queueWrite({ kind: 'set', path, value });
  }
}

async function removeOrQueue(path) {
  if (!_sdk || navigator.onLine === false) { await queueWrite({ kind: 'remove', path }); return; }
  try {
    await _sdk.remove(_sdk.ref(_sdk.db, path));
  } catch (err) {
    console.warn('[sync] remove failed, queued for retry', path, err?.code || err);
    await queueWrite({ kind: 'remove', path });
  }
}

async function pushUpdateOrQueue(updates) {
  if (!Object.keys(updates).length) return;
  for (const [path, value] of Object.entries(updates)) if (value != null) _unconfirmed.add(path);
  if (!_sdk || navigator.onLine === false) { await queueWrite({ kind: 'update', updates }); return; }
  try {
    await _sdk.update(_sdk.ref(_sdk.db), updates);
    for (const path of Object.keys(updates)) _unconfirmed.delete(path);
  } catch (err) {
    console.warn('[sync] batch push failed, queued for retry', err?.code || err);
    await queueWrite({ kind: 'update', updates });
  }
}

/**
 * A queued entry's path/update-keys were built with userPath() at the time
 * it failed, which bakes in whoever was signed in *then*. If that account
 * signs out and a different one signs in on the same browser before the
 * queue drains, replaying it as the new session would either be rejected
 * by the rules (harmless, but retries forever) or — worse, if it ever
 * somehow matched — write into the wrong account. Drop anything that
 * doesn't belong to whoever is signed in now.
 */
function ownedByCurrentUser(entry) {
  const prefix = `users/${_uid}/`;
  const paths = entry.kind === 'update' ? Object.keys(entry.updates) : [entry.path];
  return paths.every(p => p.startsWith(prefix));
}

async function flushQueue() {
  if (!_sdk) return;
  const q = await withQueueLock(async () => {
    const pending = (await KV.get(QUEUE_KEY, [])) || [];
    if (pending.length) await KV.set(QUEUE_KEY, []);
    return pending;
  });
  for (const entry of q) {
    if (!ownedByCurrentUser(entry)) continue;
    if (entry.kind === 'update') await pushUpdateOrQueue(entry.updates);
    else if (entry.kind === 'remove') await removeOrQueue(entry.path);
    else await pushOrQueue(entry.path, entry.value);
  }
}

/** True (and consumes the marker) if `value` is the echo of a remote-applied write. */
function isEcho(key, value) {
  const json = JSON.stringify(value);
  if (_lastRemoteJSON.get(key) === json) {
    _lastRemoteJSON.delete(key);
    return true;
  }
  return false;
}

function pushSolve(solve) {
  if (isEcho(`solves:${solve.id}`, solve)) return;
  pushOrQueue(userPath('solves', solve.id), solve);
}

function pushSolvesBatch(list) {
  const updates = {};
  for (const solve of list) {
    if (isEcho(`solves:${solve.id}`, solve)) continue;
    updates[userPath('solves', solve.id)] = solve;
  }
  pushUpdateOrQueue(updates);
}

/**
 * A multi-path update whose values are all null — one round trip that
 * clears every id at once, so emptying a 500-solve session costs the same
 * as deleting a single one.
 */
function pushDeletes(store, ids) {
  const updates = {};
  for (const id of ids) {
    if (isEcho(`${store}Del:${id}`, null)) continue;
    updates[userPath(store, id)] = null;
  }
  pushUpdateOrQueue(updates);
}

const pushSolvesDel = (ids) => pushDeletes('solves', ids);
const pushSessionsDel = (ids) => pushDeletes('sessions', ids);

function pushSession(session) {
  if (isEcho(`sessions:${session.id}`, session)) return;
  pushOrQueue(userPath('sessions', session.id), session);
}

function pushKv({ key, value }) {
  const path = key === 'settings' || key === 'learn' ? userPath(key)
    : isSyncedKv(key) ? userPath('kv', encKey(key)) : null;
  if (!path) return;
  if (isEcho(`kv:${key}`, value)) return;
  clearTimeout(_kvTimers.get(key));
  _kvTimers.set(key, setTimeout(() => pushOrQueue(path, value ?? null), KV_DEBOUNCE_MS));
}

/* Remote records are written straight into the store, not through putRec(),
   so they never wake the write hook — no echo to detect. (LetterPairs.put
   restamps updatedAt, so an echo would not even be byte-identical.) */
function pushRec({ store, rec }) {
  const idKey = RECORD_STORES[store];
  if (idKey) pushOrQueue(userPath(store, rec[idKey]), rec);
}

function pushRecDel({ store, ids }) {
  if (!RECORD_STORES[store]) return;
  const updates = {};
  for (const id of ids) updates[userPath(store, id)] = null;
  pushUpdateOrQueue(updates);
}

/**
 * A record this device deleted is not a record it is missing.
 *
 * The cloud copy outlives the local delete whenever the removal could not
 * be pushed at the time — offline, signed out, mid-sign-in, or a rejected
 * write — and onChildAdded replays it the moment the listener attaches
 * again. That replay is what a reload is, and it is what used to bring
 * deleted solves back. So: refuse the write, and re-issue the removal the
 * cloud never got. The delete completes itself the next time the device is
 * online, rather than being lost the first time it wasn't.
 */
async function rejectAsDeleted(store, id) {
  if (!(await Tombstones.has(store, id))) return false;
  // Not awaited: the first attach replays the whole tree, and making each
  // refusal wait on a round trip would serialise that behind the network.
  // Caught, though — an unhandled rejection here would surface as a bare
  // console error with nothing to tie it to the delete it came from.
  removeOrQueue(userPath(store, id)).catch(err =>
    console.warn('[sync] could not re-remove a deleted record', store, id, err?.code || err));
  return true;
}

/**
 * Tells the page that solves or sessions changed underneath it, so the list
 * on screen can re-read them instead of waiting for a reload. Debounced: a
 * first attach or a merge lands hundreds of rows at once.
 */
let _notifyTimer = 0;
function notifyRemote() {
  clearTimeout(_notifyTimer);
  _notifyTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('sync:remote')), 150);
}

/**
 * Remote solves and sessions are gathered and written once per burst. The
 * listener hands them over one child at a time, and a first attach replays the
 * entire history in one go — written one transaction each, that was thousands
 * of IndexedDB round trips on every page load for rows that were already
 * here. Only the ones that actually differ from the local copy are written.
 */
const _incoming = { solves: new Map(), sessions: new Map() };
let _incomingTimer = 0;

function queueIncoming(store, rec) {
  if (!rec || !rec.id) return;
  _incoming[store].set(rec.id, rec);
  _incomingTimer ||= setTimeout(applyIncoming, 0);
}

async function applyIncoming() {
  _incomingTimer = 0;
  let changed = false;
  for (const store of ['solves', 'sessions']) {
    const recs = [..._incoming[store].values()];
    _incoming[store].clear();
    if (!recs.length) continue;
    const live = [];
    for (const r of recs) if (!(await rejectAsDeleted(store, r.id))) live.push(r);
    const os = await tx(store);
    const current = await Promise.all(live.map(r => wrap(os.get(r.id))));
    const fresh = live.filter((r, i) => !sameRecord(r, current[i]));
    if (!fresh.length) continue;
    for (const r of fresh) _lastRemoteJSON.set(`${store}:${r.id}`, JSON.stringify(r));
    if (store === 'solves') await Solves.putMany(fresh);
    else for (const s of fresh) await Sessions.put(s);
    changed = true;
  }
  if (changed) notifyRemote();
}

const applyRemoteSolve = (solve) => queueIncoming('solves', solve);
const applyRemoteSession = (session) => queueIncoming('sessions', session);

/**
 * Another device (or this one, echoed back) removed the row. Deleting it
 * locally also records the tombstone, which is what makes the removal stick
 * on this device across the reload that follows.
 *
 * The echo marker is set for the same reason the write path sets one: our
 * own removal comes back to us as onChildRemoved, and without it the local
 * delete that applies would push the removal a second time, forever.
 */
async function applyRemoteSolveRemoved(id) {
  if (!id || isUnconfirmed('solves', id)) return;
  _incoming.solves.delete(id);
  if (!(await Solves.get(id))) return; // our own delete coming back
  _lastRemoteJSON.set(`solvesDel:${id}`, JSON.stringify(null));
  await Solves.del(id);
  notifyRemote();
}

async function applyRemoteSessionRemoved(id) {
  if (!id || isUnconfirmed('sessions', id)) return;
  _incoming.sessions.delete(id);
  if (!(await Sessions.get(id))) return;
  _lastRemoteJSON.set(`sessionsDel:${id}`, JSON.stringify(null));
  await Sessions.del(id);
  notifyRemote();
}

async function applyRemoteRec(store, rec) {
  const id = rec?.[RECORD_STORES[store]];
  if (id == null) return;
  if (await rejectAsDeleted(store, id)) return;
  await wrap((await tx(store, 'readwrite')).put(rec));
}

async function applyRemoteRecRemoved(store, id) {
  if (!id || isUnconfirmed(store, id)) return;
  await wrap((await tx(store, 'readwrite')).delete(id));
}

async function applyRemoteKv(k, value) {
  const key = decKey(k);
  if (!isSyncedKv(key)) return;
  _lastRemoteJSON.set(`kv:${key}`, JSON.stringify(value ?? null));
  await (value == null ? KV.del(key) : KV.set(key, value));
}

async function applyRemoteLearn(remote) {
  if (!remote || typeof remote !== 'object') return;
  const local = (await KV.get('learn', {})) || {};
  const merged = mergeLearn(local, remote);
  _lastRemoteJSON.set('kv:learn', JSON.stringify(merged));
  await KV.set('learn', merged);
}

/**
 * Merged over the local settings, never used to replace them.
 *
 * Replacing was how an edited username could disappear: `settings` is one
 * KV blob, so the first onValue after signing in overwrote every local key
 * with whatever the account last uploaded. A device that had just been
 * renamed, but whose debounced push hadn't landed yet, lost the new name to
 * the old one on the way back down — and on the next sign-in it lost
 * anything the account had never heard of at all.
 *
 * Remote wins key by key (it is the newer of the two by the time it
 * arrives), local keys the cloud copy doesn't mention survive. `bld` is
 * spread a level deeper for the same reason loadSettings() does it: a
 * cloud copy written before a `bld` field existed would otherwise blank it.
 */
export function mergeSettings(local, remote) {
  const merged = { ...local, ...remote };
  if (local.bld || remote.bld) merged.bld = { ...(local.bld || {}), ...(remote.bld || {}) };
  for (const k of LOCAL_ONLY_SETTINGS) {
    if (k in local) merged[k] = local[k]; else delete merged[k];
  }
  return merged;
}

async function applyRemoteSettings(remote) {
  if (!remote || typeof remote !== 'object') return;
  const local = (await KV.get('settings', {})) || {};
  const merged = mergeSettings(local, remote);
  _lastRemoteJSON.set('kv:settings', JSON.stringify(merged));
  await KV.set('settings', merged);
}

async function attachListeners() {
  const { db, ref, onChildAdded, onChildChanged, onChildRemoved, onValue } = _sdk;
  const solvesRef = ref(db, userPath('solves'));
  const sessionsRef = ref(db, userPath('sessions'));
  const settingsRef = ref(db, userPath('settings'));
  const learnRef = ref(db, userPath('learn'));

  _unsubs.push(onChildAdded(solvesRef, (s) => applyRemoteSolve(s.val())));
  _unsubs.push(onChildChanged(solvesRef, (s) => applyRemoteSolve(s.val())));
  _unsubs.push(onChildRemoved(solvesRef, (s) => applyRemoteSolveRemoved(s.key)));
  _unsubs.push(onChildAdded(sessionsRef, (s) => applyRemoteSession(s.val())));
  _unsubs.push(onChildChanged(sessionsRef, (s) => applyRemoteSession(s.val())));
  _unsubs.push(onChildRemoved(sessionsRef, (s) => applyRemoteSessionRemoved(s.key)));
  _unsubs.push(onValue(settingsRef, (s) => { if (s.exists()) applyRemoteSettings(s.val()); }));
  _unsubs.push(onValue(learnRef, (s) => { if (s.exists()) applyRemoteLearn(s.val()); }));

  for (const store of Object.keys(RECORD_STORES)) {
    const r = ref(db, userPath(store));
    _unsubs.push(onChildAdded(r, (s) => applyRemoteRec(store, s.val())));
    _unsubs.push(onChildChanged(r, (s) => applyRemoteRec(store, s.val())));
    _unsubs.push(onChildRemoved(r, (s) => applyRemoteRecRemoved(store, s.key)));
  }
  const kvRef = ref(db, userPath('kv'));
  _unsubs.push(onChildAdded(kvRef, (s) => applyRemoteKv(s.key, s.val())));
  _unsubs.push(onChildChanged(kvRef, (s) => applyRemoteKv(s.key, s.val())));
  _unsubs.push(onChildRemoved(kvRef, (s) => applyRemoteKv(s.key, null)));
}

function detachListeners() {
  for (const unsub of _unsubs) unsub();
  _unsubs = [];
}

/**
 * The one place two devices' histories get combined. Reads local + cloud
 * counts, and if both sides actually have something, hands back a
 * description for the merge dialog instead of writing anything — the
 * caller (panels.js) shows the dialog and calls performMerge() once the
 * user has seen it. If there's no ambiguity, merges silently and returns null.
 */
export async function mergeOnSignIn(user) {
  const { db, ref, onValue } = _sdk;
  /* Watched rather than fetched. get() downloads the tree and forgets it, so
     the listeners start() attaches right after downloaded the whole history a
     second time before anything went live. A listener kept from here on holds
     the copy, and theirs is served from it. */
  const watch = (path) => new Promise((resolve, reject) => {
    _unsubs.push(onValue(ref(db, userPath(path)), resolve, reject));
  });
  const [cloudSolvesSnap, cloudSessionsSnap] = await Promise.all([watch('solves'), watch('sessions')]);
  /* Read after the cloud, never before it. These two reads are what the union
     is built from, and the gap between them and the write listeners start()
     attaches is a window where a solve belongs to neither: not in the snapshot
     that gets uploaded, not yet watched by the push path. Offline that gap is
     as long as the connection is down — a tab opened with no network sat on an
     unresolved get() for minutes, and every solve recorded meanwhile was left
     behind. Taken here, the snapshot is whatever the device has the instant
     the account answers, which closes it to the usual millisecond. */
  const [localSolves, localSessions] = await Promise.all([Solves.all(), Sessions.all()]);
  const allCloudSolves = cloudSolvesSnap.exists() ? Object.values(cloudSolvesSnap.val()) : [];
  const allCloudSessions = cloudSessionsSnap.exists() ? Object.values(cloudSessionsSnap.val()) : [];

  /* Anything this device deleted is dropped from the cloud side before it is
     counted or unioned, and queued for removal upstream. Otherwise the merge
     is the second way a deleted solve comes back: the listener path is
     guarded, but a sign-in reads the tree directly and would union the very
     rows the tombstones exist to keep out — and then write them to both
     sides, making the resurrection permanent. */
  const tombs = await Tombstones.all();
  const { live: cloudSolves, dead: deadSolves } = partitionDeleted(allCloudSolves, tombs.solves);
  const { live: cloudSessions, dead: deadSessions } = partitionDeleted(allCloudSessions, tombs.sessions);
  const dead = { solves: deadSolves.map(s => s.id), sessions: deadSessions.map(s => s.id) };

  const mergedBefore = hasMergedBefore(_uid);
  const action = decideMergeAction({
    localCount: localSolves.length,
    cloudCount: cloudSolves.length,
    mergedBefore,
  });
  const merge = { localSolves, localSessions, cloudSolves, cloudSessions, dead, localWins: !mergedBefore };
  if (action === 'upload') {
    await performMerge(merge);
    return null;
  }

  const mergedCount = unionById(localSolves, cloudSolves).length;
  return {
    localCount: localSolves.length,
    cloudCount: cloudSolves.length,
    totalCount: mergedCount,
    email: user?.email || '',
    confirm: () => performMerge(merge),
  };
}

async function performMerge({ localSolves, localSessions, cloudSolves, cloudSessions, dead, localWins }) {
  const node = (...path) => _sdk.get(_sdk.ref(_sdk.db, userPath(...path)));
  const val = (snap, empty) => (snap.exists() ? snap.val() : empty);
  const stores = Object.keys(RECORD_STORES);
  // One round of reads in parallel, not a round trip per node in turn.
  const [localLearn, learnSnap, settings, settingsSnap, localKv, kvSnap, tombs, ...recs] = await Promise.all([
    KV.get('learn', {}), node('learn'),
    KV.get('settings', null), node('settings'),
    KV.prefixed(''), node('kv'),
    Tombstones.all(),
    ...stores.flatMap(store => [tx(store).then(os => wrap(os.getAll())), node(store)]),
  ]);

  /* Each side gets only what it is missing. This runs on every page load of a
     signed-in browser, and rewriting the whole union into IndexedDB one solve
     at a time, then uploading all of it again, was most of what made the
     merge slow — and uploading this device's stale copies was how an edit
     made on another device got undone the next time this one opened. */
  const solves = diffById(localSolves, cloudSolves, localWins);
  const sessions = diffById(localSessions, cloudSessions, localWins);
  const cloudLearn = val(learnSnap, {});
  const learn = mergeLearn(localLearn, cloudLearn);

  if (solves.down.length) await Solves.putMany(solves.down);
  for (const s of sessions.down) await Sessions.put(s);
  if (!sameRecord(learn, localLearn)) await KV.set('learn', learn);

  const updates = {};
  for (const s of solves.up) updates[userPath('solves', s.id)] = s;
  for (const s of sessions.up) updates[userPath('sessions', s.id)] = s;
  if (!sameRecord(learn, cloudLearn)) updates[userPath('learn')] = learn;
  /* Only when the account has none yet. Uploading this browser's copy over an
     existing one was how signing in on a fresh device reset every other
     device to defaults; the listener merges the account's copy down instead. */
  if (settings && !settingsSnap.exists()) updates[userPath('settings')] = settings;

  /* Cubes, letter pairs, custom algs: upload what the account has never seen,
     clear what this device deleted. Everything the account already has comes
     down through the listeners start() attaches, which replay the whole tree. */
  stores.forEach((store, i) => {
    const idKey = RECORD_STORES[store];
    const local = recs[2 * i], cloud = val(recs[2 * i + 1], {});
    for (const r of local) if (!(r[idKey] in cloud)) updates[userPath(store, r[idKey])] = r;
    for (const id of Object.keys(cloud)) if (tombs[store]?.[id]) updates[userPath(store, id)] = null;
  });
  const cloudKv = val(kvSnap, {});
  for (const [key, value] of localKv) {
    if (isSyncedKv(key) && !(encKey(key) in cloudKv)) updates[userPath('kv', encKey(key))] = value;
  }
  // Same batch, so the account's leftovers go in the one round trip that
  // uploads the union rather than a second pass that could half-apply.
  for (const id of dead.solves) updates[userPath('solves', id)] = null;
  for (const id of dead.sessions) updates[userPath('sessions', id)] = null;
  await pushUpdateOrQueue(updates);
  // Stamped here rather than by the dialog, so the silent path counts too:
  // once this browser and this account have been reconciled, every later
  // sign-in — including the one a page reload performs for you — goes
  // straight to live sync with nothing to confirm.
  rememberMerged(_uid);
  if (solves.down.length || sessions.down.length) notifyRemote();
}

let _writeUnsubs = [];

async function start() {
  // Before the listeners, never after: attaching replays the whole tree, and
  // every incoming record is checked against the tombstones. Pruning behind
  // that replay could drop a note a split second before the row it guards
  // against arrives.
  await Tombstones.prune();
  await attachListeners();
  _writeUnsubs = [
    onWrite('solves', pushSolve),
    onWrite('solvesBatch', pushSolvesBatch),
    onWrite('sessions', pushSession),
    onWrite('solvesDel', pushSolvesDel),
    onWrite('sessionsDel', pushSessionsDel),
    onWrite('kv', pushKv),
    onWrite('rec', pushRec),
    onWrite('recDel', pushRecDel),
  ];
  window.addEventListener('online', flushQueue);
  await flushQueue();
}

function stop() {
  detachListeners();
  clearTimeout(_incomingTimer);
  _incomingTimer = 0;
  _incoming.solves.clear();
  _incoming.sessions.clear();
  for (const unsub of _writeUnsubs) unsub();
  _writeUnsubs = [];
  window.removeEventListener('online', flushQueue);
  _sdk = null;
  _uid = null;
}

/**
 * `browserLocalPersistence` is shared across tabs, so onAuthStateChanged can
 * fire again for the same session (a cross-tab storage event, a token
 * refresh) before a previous invocation has finished awaiting mergeOnSignIn
 * — without a guard, the second call's stop() would tear down the first
 * call's listeners mid-setup. Each invocation stamps a generation and bails
 * after every await if a newer one has since started.
 */
let _generation = 0;

/**
 * Starting sync needs the network — the SDK comes from gstatic and
 * mergeOnSignIn() reads the account — so it can fail. A failure used to be
 * retried only on the next 'online' event, which never comes for a tab that
 * was online all along and just hit a blip (a dropped socket, a slow token
 * right after the popup closed). Sync then stayed off, the merge dialog never
 * appeared, and reloading was the only way to try again. Now it also retries
 * on a timer, backing off from 2 s to a minute, whichever comes first.
 */
let _retryTimer = 0;
let _retryDelay = 0;
let _retry = null;

function retrySoon(run) {
  clearTimeout(_retryTimer);
  _retryDelay = Math.min(_retryDelay ? _retryDelay * 2 : 2000, 60000);
  _retry = run;
  _retryTimer = setTimeout(fireRetry, _retryDelay);
  window.addEventListener('online', fireRetry);
}

function fireRetry() {
  clearTimeout(_retryTimer);
  window.removeEventListener('online', fireRetry);
  const run = _retry;
  _retry = null;
  run?.();
}

let _user = null;      // who the engine is running, or starting, for
let _bringUp = null;   // that start's promise
let _onMergeNeeded = null;

/**
 * Brings the engine up for `user` (or down, for null). The auth listener can
 * report the same account twice in a row — once from onAuthChange()'s
 * immediate call and once from the SDK's own first callback — and a second
 * bring-up would tear down the first halfway and download the account again,
 * so the same account is only restarted when `force` asks for it.
 * Resolves once sync is live; rejects (after scheduling a retry) if it could not start.
 */
function handleUser(user, force = false) {
  if (!force && user && _bringUp && _user?.uid === user.uid) return _bringUp;
  const gen = ++_generation;
  stop();
  _user = user;
  if (!user) { _bringUp = null; return Promise.resolve(); }
  _bringUp = (async () => {
    try {
      _uid = user.uid;
      _sdk = await getDatabaseHandle();
      if (gen !== _generation) return;
      const mergeInfo = await mergeOnSignIn(user);
      if (gen !== _generation) return;
      if (mergeInfo && _onMergeNeeded) {
        await _onMergeNeeded(mergeInfo);
        if (gen !== _generation) return;
      }
      await start();
      _retryDelay = 0;
    } catch (err) {
      // A newer sign-in already owns the engine — its own failure will do the
      // retrying, and a second retry here would fight it.
      if (gen !== _generation) return;
      _bringUp = null;
      console.warn('[sync] could not start, retrying', err?.code || err);
      retrySoon(() => { if (gen === _generation) handleUser(user).catch(() => {}); });
      throw err;
    }
  })();
  return _bringUp;
}

/**
 * The settings drawer's "sync now": reads the whole account again, merges it
 * with this device both ways, reattaches the live listeners and flushes
 * anything queued. Resolves with how many writes are still waiting to go up.
 */
export async function syncNow() {
  if (!_user) throw new Error('signed-out');
  await handleUser(_user, true);
  return ((await KV.get(QUEUE_KEY, [])) || []).length;
}

/** Call once at boot. Resolves the Firebase SDK lazily — only signing in (or already being signed in) pulls it in. */
export async function initSync({ onMergeNeeded } = {}) {
  _onMergeNeeded = onMergeNeeded;
  try {
    await onAuthChange((user) => { handleUser(user).catch(() => {}); });
  } catch (err) {
    // The SDK itself never loaded, so there is no auth listener at all yet.
    retrySoon(() => initSync({ onMergeNeeded }).catch(() => {}));
    throw err;
  }
}
