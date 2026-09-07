/* ===========================================================
   Tagda Timer — cloud account auth

   A second, independently-named Firebase app instance from race mode's.
   Race mode signs in anonymously with `browserSessionPersistence` on
   purpose (one identity per TAB, see race-net.js) — an account has to be
   the opposite: one identity per BROWSER that survives a reload or a new
   tab, so `browserLocalPersistence` and a separate named app so neither
   auth instance's persistence setting can bleed into the other.

   Providers are a map rather than a chain of ifs so a second one (email
   link, Apple) is a new entry here, not a restructure.
   =========================================================== */

import { FIREBASE_CONFIG, FIREBASE_VERSION } from './raceapp.js';

const APP_NAME = 'tagda-sync';

/**
 * Set immediately before signInWithRedirect() and cleared once the result
 * has been read back. It is the only thing that tells the page load AFTER
 * that redirect apart from any other page load: the account has not been
 * written to localStorage yet at that point, so hasPersistedSession() below
 * is still false and boot would otherwise skip loading this module
 * entirely — the sign-in would complete at Google and then be silently
 * dropped on the way home, which is exactly the bug this exists to stop.
 *
 * sessionStorage, not localStorage: it is scoped to the tab that started
 * the redirect and cannot outlive it, so an abandoned sign-in can't leave a
 * marker behind that makes every future load wait on getRedirectResult().
 */
const PENDING_REDIRECT_KEY = 'tagda:auth:pendingRedirect';

function markRedirectPending() {
  try { sessionStorage.setItem(PENDING_REDIRECT_KEY, '1'); } catch { /* private mode — worst case is the fallback below */ }
}

/** True on the one page load that comes back from signInWithRedirect(). */
export function hasPendingRedirect() {
  try { return sessionStorage.getItem(PENDING_REDIRECT_KEY) === '1'; } catch { return false; }
}

function clearRedirectPending() {
  try { sessionStorage.removeItem(PENDING_REDIRECT_KEY); } catch { /* nothing to clear */ }
}

let _sdk = null;       // { appMod, authMod, auth }
let _redirectError = null;  // a failed getRedirectResult(), for the UI to report
let _initPromise = null;
const _listeners = new Set();

function providerFor(authMod, name) {
  const makers = {
    google: () => new authMod.GoogleAuthProvider(),
  };
  const make = makers[name];
  if (!make) throw new Error(`unknown sign-in provider: ${name}`);
  return make();
}

async function ensureSdk() {
  if (_sdk) return _sdk;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!FIREBASE_CONFIG) throw new Error('no-config');
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appMod, authMod] = await Promise.all([
      import(/* @vite-ignore */ `${base}/firebase-app.js`),
      import(/* @vite-ignore */ `${base}/firebase-auth.js`),
    ]);
    const app = appMod.initializeApp(FIREBASE_CONFIG, APP_NAME);
    const auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence)
      .catch(err => console.warn('[sync] local persistence unavailable', err?.code || err));
    authMod.onAuthStateChanged(auth, (user) => {
      for (const fn of _listeners) fn(user);
    });
    // Picks up a signInWithRedirect() from the signIn() fallback below. This
    // is what actually completes that sign-in — until it runs, the account
    // exists at Google and nowhere else. Awaited (only when a redirect is
    // actually outstanding, so it costs an ordinary load nothing) so that
    // callers which read auth.currentUser straight after ensureSdk() see the
    // user rather than null, instead of racing onAuthStateChanged.
    if (hasPendingRedirect()) {
      try {
        await authMod.getRedirectResult(auth);
      } catch (err) {
        console.warn('[sync] redirect sign-in failed', err?.code || err);
        _redirectError = err;
      } finally {
        clearRedirectPending();
      }
    }
    _sdk = { appMod, authMod, auth };
    return _sdk;
  })();
  return _initPromise;
}

/**
 * Warms the Firebase Auth SDK ahead of an expected click, so signInWithPopup
 * fires (near-)synchronously with the click that requested it. Browsers
 * tie a popup's permission to the user gesture that opened it and drop that
 * attribution across a real async gap — and fetching the SDK from gstatic
 * the first time is exactly that gap. Without this, the very first sign-in
 * attempt on a fresh page load reliably hits `auth/popup-blocked`, because
 * `signIn()` would otherwise be the one to trigger this same fetch, from
 * inside the click handler, too late to still count as the same gesture.
 */
export function preloadAuth() {
  return ensureSdk().catch(() => {}); // signIn() surfaces the real error if this failed
}

/** Fires immediately with the current user (or null), then on every change. */
export async function onAuthChange(fn) {
  const { auth } = await ensureSdk();
  _listeners.add(fn);
  fn(auth.currentUser);
  return () => _listeners.delete(fn);
}

export function currentUser() {
  return _sdk?.auth.currentUser ?? null;
}

/**
 * The only failures worth leaving the page for. Each one means the popup
 * genuinely cannot complete in this browser — it was blocked, the relay
 * iframe's storage is partitioned away (Firefox strict / Zen, Safari ITP,
 * whenever authDomain is still third-party; see raceapp.js), or popups
 * aren't a thing in this environment at all.
 *
 * Deliberately a list and not "anything that isn't the user cancelling":
 * falling back on every error meant a wrong password, a network blip or a
 * misconfigured project all silently threw the whole page at Google and
 * came back with no explanation. A full-page redirect is a real cost —
 * it tears down the running timer — so it is reserved for the cases that
 * actually need it, and everything else surfaces as an error the UI can
 * report.
 */
const REDIRECT_FALLBACK_CODES = new Set([
  'auth/popup-blocked',
  'auth/web-storage-unsupported',
  'auth/operation-not-supported-in-this-environment',
  'auth/internal-error',              // what the partitioned-storage relay times out as
]);

/**
 * Tries the popup, and only leaves the page when the popup cannot possibly
 * work (see REDIRECT_FALLBACK_CODES). The fallback resolves this call with
 * `null` — the page is navigating away, and the real result arrives from
 * getRedirectResult() in ensureSdk() on the page load after the redirect,
 * which is why markRedirectPending() has to be set before we go.
 */
export async function signIn(provider = 'google') {
  const { authMod, auth } = await ensureSdk();
  const p = providerFor(authMod, provider);
  try {
    const cred = await authMod.signInWithPopup(auth, p);
    return cred.user;
  } catch (err) {
    if (!REDIRECT_FALLBACK_CODES.has(err?.code)) throw err;
    console.warn('[sync] popup sign-in unavailable, falling back to redirect', err?.code || err);
    markRedirectPending();
    await authMod.signInWithRedirect(auth, p);
    return null;
  }
}

/** The last getRedirectResult() failure, if there was one. Read once, then forgotten. */
export function takeRedirectError() {
  const err = _redirectError;
  _redirectError = null;
  return err;
}

/** Local IndexedDB is never touched here — signing out only ends the cloud session. */
export async function signOutUser() {
  const { authMod, auth } = await ensureSdk();
  await authMod.signOut(auth);
}

/**
 * Cheap, synchronous, no-SDK-load guess at "was this browser ever signed
 * in", so main.js can skip pulling in the Firebase Auth SDK at boot for the
 * far more common visitor who has never signed in — same shape as the
 * spotifyTokens check startAlbumTheming() does. `browserLocalPersistence`
 * writes this exact localStorage key; if a future SDK version changes that
 * format the worst case is just falling back to loading on first settings
 * open, not a broken sign-in.
 */
export function hasPersistedSession() {
  try {
    return !!localStorage.getItem(`firebase:authUser:${FIREBASE_CONFIG.apiKey}:${APP_NAME}`);
  } catch {
    return false;
  }
}

export async function getDatabaseHandle() {
  const { appMod, auth } = await ensureSdk();
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const dbMod = await import(/* @vite-ignore */ `${base}/firebase-database.js`);
  const app = appMod.getApp(APP_NAME);
  return { ...dbMod, db: dbMod.getDatabase(app), auth };
}

/** Lazily loads Storage — only reached from "Change avatar", never at boot. */
export async function getStorageHandle() {
  const { appMod, auth } = await ensureSdk();
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const storageMod = await import(/* @vite-ignore */ `${base}/firebase-storage.js`);
  const app = appMod.getApp(APP_NAME);
  return { ...storageMod, storage: storageMod.getStorage(app), auth };
}

/**
 * `signInWithPopup`'s returned user and the live `auth.currentUser` are
 * snapshots — updating one's `photoURL` doesn't retroactively change an
 * object already handed to a caller. `updateProfile` writes it to the
 * account itself (so it comes back correctly on the next sign-in on any
 * device too); the caller still needs to re-render off the fresh
 * `auth.currentUser` afterward, which this returns for convenience.
 */
export async function updateUserProfile(patch) {
  const { authMod, auth } = await ensureSdk();
  await authMod.updateProfile(auth.currentUser, patch);
  return auth.currentUser;
}
