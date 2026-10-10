/* ===========================================================
   Tagda Timer — presence, and letting a hidden tab go (ADMIN.md §20)

   The Spark plan allows 100 database connections at once, and nothing else
   can count them from inside the app. Every connection this page opens (the
   timer's own, and a race tab's) says it is there:

     presence/<uid>/<id> = { at, k: 'app' | 'race' }   removed by the server when it drops

   written when the connection comes up and removed with onDisconnect, so it
   costs no connection of its own. Admins read the count on Today. Only once
   the connection has an account (a race tab's is an anonymous one), and not
   on a device whose Data Health switch is off, or with the console's health
   switch off: the count is "about" for that reason.

   app.idleDisconnectMin (0, off, by default): a tab hidden that long lets its
   connections go (goOffline) and takes them back when it is shown again
   (goOnline). Changes made meanwhile wait in the SDK and go then.
   =========================================================== */

import { getConfig } from './config.js';

/* Data Health's switch for this device (js/health.js OFF_KEY), read here rather than imported:
   health.js brings the scramble code with it, and the admin page has no use for that. */
const OFF_KEY = 'tdt-telemetry';
const telemetryOn = () => { try { return localStorage.getItem(OFF_KEY) !== 'off'; } catch { return true; } };

/** Every database this page has opened: { sdk, offline }. */
const dbs = [];
let refused = false;

/**
 * Track `sdk`'s connection for `uidOf()` as `kind`. Returns sync(): call it
 * when the account changes (signed in, out, another one).
 */
export function trackPresence(sdk, uidOf, kind) {
  const rec = { sdk, offline: false };
  dbs.push(rec);
  let up = false, key = null, keyUid = null;
  const at = (uid, id) => sdk.ref(sdk.db, `presence/${uid}/${id}`);
  async function sync() {
    const uid = uidOf() || null;
    const want = up && !!uid && !refused && telemetryOn() && getConfig('health', 'enabled') !== false;
    // Signed out, another account, or switched off: the old entry goes.
    if (key && (!want || uid !== keyUid)) {
      const gone = at(keyUid, key);
      key = null;
      if (up) await sdk.remove(gone).catch(() => {});
    }
    if (!want || key) return;
    key = sdk.push(sdk.ref(sdk.db, `presence/${uid}`)).key;
    keyUid = uid;
    const r = at(uid, key);
    try {
      await sdk.onDisconnect(r).remove();
      await sdk.set(r, { at: sdk.serverTimestamp(), k: kind });
    } catch (err) {
      // Rules from before presence: not asked again this page load.
      if (/permission/i.test(String(err?.code || err?.message || err))) refused = true;
      key = null;
    }
  }
  sdk.onValue(sdk.ref(sdk.db, '.info/connected'), (s) => {
    up = s.val() === true;
    // The server removed the entry as the connection dropped: a new one when it is back.
    if (!up) key = null;
    sync();
  }, () => {});
  return sync;
}

let idleTimer = 0;

/** Let every connection go after app.idleDisconnectMin hidden, and take them back on show. Once, from main.js. */
export function startIdleDisconnect() {
  document.addEventListener('visibilitychange', () => {
    clearTimeout(idleTimer);
    if (document.hidden) {
      const min = getConfig('app', 'idleDisconnectMin') || 0;
      if (min > 0) idleTimer = setTimeout(() => setOnline(false), min * 60_000);
    } else {
      setOnline(true);
    }
  });
}

/** Every database offline, or back online (only those this let go). */
export function setOnline(on) {
  for (const d of dbs) {
    if (!on && !d.offline) { d.sdk.goOffline(d.sdk.db); d.offline = true; }
    else if (on && d.offline) { d.sdk.goOnline(d.sdk.db); d.offline = false; }
  }
}

/** For tests and the console: how many databases this page has, and how many it let go. */
export const presenceState = () => ({ dbs: dbs.length, offline: dbs.filter(d => d.offline).length, refused });
