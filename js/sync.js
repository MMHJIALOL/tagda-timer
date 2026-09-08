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

import { Solves, Sessions, KV, Tombstones, onWrite } from './db.js';
import { onAuthChange, getDatabaseHandle } from './sync-auth.js';

const QUEUE_KEY = '_syncQueue';
const KV_DEBOUNCE_MS = 1500;

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

async function pushOrQueue(path, value) {
  if (!_sdk || navigator.onLine === false) { await queueWrite({ kind: 'set', path, value }); return; }
  try {
    await _sdk.set(_sdk.ref(_sdk.db, path), value);
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
  if (!_sdk || navigator.onLine === false) { await queueWrite({ kind: 'update', updates }); return; }
  try {
    await _sdk.update(_sdk.ref(_sdk.db), updates);
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
  if (key !== 'settings' && key !== 'learn') return;
  if (isEcho(`kv:${key}`, value)) return;
  clearTimeout(_kvTimers.get(key));
  _kvTimers.set(key, setTimeout(() => pushOrQueue(userPath(key), value), KV_DEBOUNCE_MS));
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

async function applyRemoteSolve(solve) {
  if (!solve || !solve.id) return;
  if (await rejectAsDeleted('solves', solve.id)) return;
  _lastRemoteJSON.set(`solves:${solve.id}`, JSON.stringify(solve));
  await Solves.put(solve);
}

async function applyRemoteSession(session) {
  if (!session || !session.id) return;
  if (await rejectAsDeleted('sessions', session.id)) return;
  _lastRemoteJSON.set(`sessions:${session.id}`, JSON.stringify(session));
  await Sessions.put(session);
}

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
  if (!id) return;
  _lastRemoteJSON.set(`solvesDel:${id}`, JSON.stringify(null));
  await Solves.del(id);
}

async function applyRemoteSessionRemoved(id) {
  if (!id) return;
  _lastRemoteJSON.set(`sessionsDel:${id}`, JSON.stringify(null));
  await Sessions.del(id);
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
async function applyRemoteSettings(remote) {
  if (!remote || typeof remote !== 'object') return;
  const local = (await KV.get('settings', {})) || {};
  const merged = { ...local, ...remote };
  if (local.bld || remote.bld) merged.bld = { ...(local.bld || {}), ...(remote.bld || {}) };
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
  const [localSolves, localSessions] = await Promise.all([Solves.all(), Sessions.all()]);
  const { db, ref, get } = _sdk;
  const [cloudSolvesSnap, cloudSessionsSnap] = await Promise.all([
    get(ref(db, userPath('solves'))),
    get(ref(db, userPath('sessions'))),
  ]);
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

  const action = decideMergeAction({
    localCount: localSolves.length,
    cloudCount: cloudSolves.length,
    mergedBefore: hasMergedBefore(_uid),
  });
  if (action === 'upload') {
    await performMerge({ localSolves, localSessions, cloudSolves, cloudSessions, dead });
    return null;
  }

  const mergedCount = unionById(localSolves, cloudSolves).length;
  return {
    localCount: localSolves.length,
    cloudCount: cloudSolves.length,
    totalCount: mergedCount,
    email: user?.email || '',
    confirm: () => performMerge({ localSolves, localSessions, cloudSolves, cloudSessions, dead }),
  };
}

async function performMerge({ localSolves, localSessions, cloudSolves, cloudSessions, dead = { solves: [], sessions: [] } }) {
  const mergedSolves = unionById(localSolves, cloudSolves);
  const mergedSessions = unionById(localSessions, cloudSessions);
  const [localLearn, cloudLearnSnap] = await Promise.all([
    KV.get('learn', {}),
    _sdk.get(_sdk.ref(_sdk.db, userPath('learn'))),
  ]);
  const mergedLearn = mergeLearn(localLearn, cloudLearnSnap.exists() ? cloudLearnSnap.val() : {});

  // Write the union back to both sides. Additive for everything either side
  // still has; the only thing cleared is what this device deleted on purpose.
  for (const s of mergedSolves) await Solves.put(s);
  for (const s of mergedSessions) await Sessions.put(s);
  if (Object.keys(mergedLearn).length) await KV.set('learn', mergedLearn);

  const updates = {};
  for (const s of mergedSolves) updates[userPath('solves', s.id)] = s;
  for (const s of mergedSessions) updates[userPath('sessions', s.id)] = s;
  if (Object.keys(mergedLearn).length) updates[userPath('learn')] = mergedLearn;
  const settings = await KV.get('settings', null);
  if (settings) updates[userPath('settings')] = settings;
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
  ];
  window.addEventListener('online', flushQueue);
  await flushQueue();
}

function stop() {
  detachListeners();
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

/** Call once at boot. Resolves the Firebase SDK lazily — only signing in (or already being signed in) pulls it in. */
export async function initSync({ onMergeNeeded } = {}) {
  await onAuthChange(async (user) => {
    const gen = ++_generation;
    stop();
    if (!user) return;
    _uid = user.uid;
    _sdk = await getDatabaseHandle();
    if (gen !== _generation) return;
    const mergeInfo = await mergeOnSignIn(user);
    if (gen !== _generation) return;
    if (mergeInfo && onMergeNeeded) {
      await onMergeNeeded(mergeInfo);
      if (gen !== _generation) return;
    }
    await start();
  });
}
