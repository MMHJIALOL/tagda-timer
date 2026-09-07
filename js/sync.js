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

   Nothing here ever deletes a local or remote record — merges only add.
   See mergeOnSignIn(), which is the one place data from two devices that
   have never met before gets combined.
   =========================================================== */

import { Solves, Sessions, KV, onWrite } from './db.js';
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
 *   'upload' — cloud has nothing yet (or nothing local to lose either way);
 *              no ambiguity, no dialog.
 *   'merge'  — both sides have solves; show the merge dialog, then union.
 */
export function decideMergeAction({ localCount, cloudCount }) {
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

async function applyRemoteSolve(solve) {
  if (!solve || !solve.id) return;
  _lastRemoteJSON.set(`solves:${solve.id}`, JSON.stringify(solve));
  await Solves.put(solve);
}

async function applyRemoteSession(session) {
  if (!session || !session.id) return;
  _lastRemoteJSON.set(`sessions:${session.id}`, JSON.stringify(session));
  await Sessions.put(session);
}

async function applyRemoteLearn(remote) {
  if (!remote || typeof remote !== 'object') return;
  const local = (await KV.get('learn', {})) || {};
  const merged = mergeLearn(local, remote);
  _lastRemoteJSON.set('kv:learn', JSON.stringify(merged));
  await KV.set('learn', merged);
}

async function applyRemoteSettings(remote) {
  if (!remote || typeof remote !== 'object') return;
  _lastRemoteJSON.set('kv:settings', JSON.stringify(remote));
  await KV.set('settings', remote);
}

async function attachListeners() {
  const { db, ref, onChildAdded, onChildChanged, onValue } = _sdk;
  const solvesRef = ref(db, userPath('solves'));
  const sessionsRef = ref(db, userPath('sessions'));
  const settingsRef = ref(db, userPath('settings'));
  const learnRef = ref(db, userPath('learn'));

  _unsubs.push(onChildAdded(solvesRef, (s) => applyRemoteSolve(s.val())));
  _unsubs.push(onChildChanged(solvesRef, (s) => applyRemoteSolve(s.val())));
  _unsubs.push(onChildAdded(sessionsRef, (s) => applyRemoteSession(s.val())));
  _unsubs.push(onChildChanged(sessionsRef, (s) => applyRemoteSession(s.val())));
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
  const cloudSolves = cloudSolvesSnap.exists() ? Object.values(cloudSolvesSnap.val()) : [];
  const cloudSessions = cloudSessionsSnap.exists() ? Object.values(cloudSessionsSnap.val()) : [];

  const action = decideMergeAction({ localCount: localSolves.length, cloudCount: cloudSolves.length });
  if (action === 'upload') {
    await performMerge({ localSolves, localSessions, cloudSolves, cloudSessions });
    return null;
  }

  const mergedCount = unionById(localSolves, cloudSolves).length;
  return {
    localCount: localSolves.length,
    cloudCount: cloudSolves.length,
    totalCount: mergedCount,
    email: user?.email || '',
    confirm: () => performMerge({ localSolves, localSessions, cloudSolves, cloudSessions }),
  };
}

async function performMerge({ localSolves, localSessions, cloudSolves, cloudSessions }) {
  const mergedSolves = unionById(localSolves, cloudSolves);
  const mergedSessions = unionById(localSessions, cloudSessions);
  const [localLearn, cloudLearnSnap] = await Promise.all([
    KV.get('learn', {}),
    _sdk.get(_sdk.ref(_sdk.db, userPath('learn'))),
  ]);
  const mergedLearn = mergeLearn(localLearn, cloudLearnSnap.exists() ? cloudLearnSnap.val() : {});

  // Write the union back to both sides — additive only, nothing cleared.
  for (const s of mergedSolves) await Solves.put(s);
  for (const s of mergedSessions) await Sessions.put(s);
  if (Object.keys(mergedLearn).length) await KV.set('learn', mergedLearn);

  const updates = {};
  for (const s of mergedSolves) updates[userPath('solves', s.id)] = s;
  for (const s of mergedSessions) updates[userPath('sessions', s.id)] = s;
  if (Object.keys(mergedLearn).length) updates[userPath('learn')] = mergedLearn;
  const settings = await KV.get('settings', null);
  if (settings) updates[userPath('settings')] = settings;
  await pushUpdateOrQueue(updates);
}

let _writeUnsubs = [];

async function start() {
  await attachListeners();
  _writeUnsubs = [
    onWrite('solves', pushSolve),
    onWrite('solvesBatch', pushSolvesBatch),
    onWrite('sessions', pushSession),
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
