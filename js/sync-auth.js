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

let _sdk = null;       // { appMod, authMod, auth }
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

export async function signIn(provider = 'google') {
  const { authMod, auth } = await ensureSdk();
  const cred = await authMod.signInWithPopup(auth, providerFor(authMod, provider));
  return cred.user;
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
