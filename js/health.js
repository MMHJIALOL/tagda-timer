/* ===========================================================
   Tagda Timer — client health: the heartbeat and error reports

   What the admin console's Health tab is made of (ADMIN.md, "Health"), so a
   broken sync queue, a deploy that stranded people on an old version, a
   scramble that takes fifteen seconds in one browser or an error on one
   phone shows up before somebody has to say so.

     health/<dayStart>/<uid>          one record a day per signed-in person,
                                      rewritten at most every health.beatMin
     errors/<dayStart>/<hash>         { msg, where, u: { <uid>: { n, first, last, ver, ua } } }

   Only while signed in with Google, and never anything typed: the app's
   version, the browser family and the system (never the user-agent string),
   the sync queue's length and age, the service worker, scramble times, the
   language. An error is its message (web addresses cut at the query) and
   the file and line it came from. Data Health says so, and has a switch for
   this device (OFF_KEY). The admin console has one for everybody
   (config/health).

   Nothing here runs before the page is idle, and a refusal (rules from
   before this, or a switch) stops it for the rest of the page load.
   =========================================================== */

import { getConfig } from './config.js';
import { APP_VERSION } from './version.js';
import { lang } from './i18n.js';
import { isPhone } from './phone.js';
import { scrambleSpeeds } from './scramble.js';

/** This device's own switch, in Data Health: 'off' stops both. */
export const OFF_KEY = 'tdt-telemetry';
const BEAT_KEY = 'tdt-health-beat';   // { uid, ver, day, at } of the last heartbeat that landed
const HEALS_KEY = 'tdt-heals';        // { day, n }: main.js's self-heals from a mixed deploy (#125)
const DROPS_KEY = 'tdt-drops';        // { day, n }: sync writes dropped as permanent today
const ERRS_KEY = 'tdt-errs';          // { day, seen: { hash: { n, first } } }
const MAX_ERRORS = 5;
const DAY_MS = 86_400_000, IST_MS = 19_800_000;

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: counts start again */ } };
const today = (now = Date.now()) => now - ((now + IST_MS) % DAY_MS);

/** Whether this device sends anything at all (Data Health's switch). */
export const telemetryOn = () => { try { return localStorage.getItem(OFF_KEY) !== 'off'; } catch { return true; } };
export function setTelemetry(on) {
  try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, 'off'); } catch { /* stays as it was */ }
}

/** The browser family, never the user-agent string itself. */
export function family(ua = navigator.userAgent) {
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

export function osOf(ua = navigator.userAgent) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'mac';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}

/** FNV-1a, 32 bits, in base 36: the same error, the same key, on every device. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/* ---------------- errors ---------------- */

const caught = new Map();   // hash -> { msg, where, sent }

/** A web address keeps its path and loses its query (?v=, tokens, anything else). */
export const cleanMsg = (m) => String(m || '').replace(/(https?:\/\/[^\s?#'")]+)[?#][^\s'")]*/g, '$1').trim().slice(0, 200);

/** The file and line an error came from: this site's own files only. */
export function whereOf(file, line, stack) {
  let f = file || '', l = line || 0;
  if (!f && stack) {
    const m = /(https?:\/\/[^\s)]+?):(\d+):\d+/.exec(String(stack));
    if (m) { f = m[1]; l = Number(m[2]); }
  }
  if (!f) return 'unknown';
  try {
    const u = new URL(f, location.href);
    if (u.origin !== location.origin) return null;     // an extension, or somebody else's script
    f = u.pathname.replace(/^\//, '') || 'index.html';
  } catch { return null; }
  return `${f}:${l}`.slice(0, 120);
}

/** Noise every site gets and nobody can act on. */
const NOISE = /^(Script error\.?|ResizeObserver loop|Load failed$|NetworkError when attempting to fetch|Failed to fetch$|The operation was aborted|AbortError)/i;

function caughtError(msg, file, line, err) {
  const m = cleanMsg(msg);
  if (!m || NOISE.test(m)) return;
  const where = whereOf(file, line, err?.stack);
  if (!where) return;
  const hash = fnv1a(`${m}|${where}`);
  if (caught.has(hash) || caught.size >= MAX_ERRORS) return;
  caught.set(hash, { msg: m, where, sent: false });
  flushErrors();
}

/* One error reads the same from every browser: "TypeError: x is null", from
   the error object where there is one (Chrome's event message starts
   "Uncaught …", Firefox's does not), so it groups as one. */
export function messageOf(err, fallback = '') {
  if (err && typeof err === 'object' && typeof err.message === 'string') return `${err.name || 'Error'}: ${err.message}`;
  if (typeof err === 'string') return err;
  return String(fallback || '').replace(/^Uncaught\s+/, '');
}

/** Listen for errors from the first moment; they wait here until there is somebody signed in to send them as. */
export function captureErrors() {
  addEventListener('error', (e) => { if (e.message || e.error) caughtError(messageOf(e.error, e.message), e.filename, e.lineno, e.error); });
  addEventListener('unhandledrejection', (e) => caughtError(messageOf(e.reason), null, null, e.reason));
}

/* ---------------- the connection ---------------- */

let sdk = null, user = null;
const refused = { beat: false, errors: false };
const isRefusal = (err) => /permission/i.test(String(err?.code || err?.message || err));

async function flushErrors() {
  if (!sdk || !user || refused.errors || !telemetryOn() || !getConfig('health', 'errorsEnabled')) return;
  const day = today();
  const kept = read(ERRS_KEY);
  const seen = kept?.day === day ? kept.seen || {} : {};
  for (const [hash, e] of caught) {
    if (e.sent) continue;
    e.sent = true;
    const mine = seen[hash] || { n: 0, first: Date.now() };
    const next = { n: mine.n + 1, first: mine.first };
    const base = `errors/${day}/${hash}`;
    try {
      await sdk.update(sdk.ref(sdk.db), {
        [`${base}/msg`]: e.msg,
        [`${base}/where`]: e.where,
        [`${base}/u/${user.uid}`]: { n: next.n, first: next.first, last: sdk.serverTimestamp(), ver: APP_VERSION, ua: family() },
      });
      seen[hash] = next;
      write(ERRS_KEY, { day, seen });
    } catch (err) {
      if (isRefusal(err)) { refused.errors = true; return; }
      e.sent = false;   // a dropped connection: the next heartbeat tries again
    }
  }
}

/* ---------------- the heartbeat ---------------- */

/** How many times today main.js dropped a mixed deploy's cache and reloaded (#125). */
export function noteHeal() {
  const day = today();
  const c = read(HEALS_KEY);
  write(HEALS_KEY, { day, n: c?.day === day ? c.n + 1 : 1 });
}
const healsToday = () => { const c = read(HEALS_KEY); return c?.day === today() ? c.n : 0; };

let dropsSeen = 0;
/** Writes the queue dropped today on this device, from its count since this page loaded. */
function dropsToday(sinceLoad) {
  const day = today();
  const c = read(DROPS_KEY);
  const n = (c?.day === day ? c.n : 0) + Math.max(0, sinceLoad - dropsSeen);
  dropsSeen = sinceLoad;
  write(DROPS_KEY, { day, n });
  return n;
}

async function record() {
  const { syncHealth } = await import('./sync.js');
  const q = syncHealth();
  const scr = {};
  for (const [ev, ms] of Object.entries(scrambleSpeeds())) if (/^[a-z0-9]{2,16}$/.test(ev)) scr[ev] = Math.min(600000, ms);
  const sw = !('serviceWorker' in navigator) ? 'unsupported' : navigator.serviceWorker.controller ? 'on' : 'off';
  return {
    at: sdk.serverTimestamp(), ver: APP_VERSION, ua: family(), os: osOf(), phone: !!isPhone(),
    q: q.pending, qOldestMin: q.oldestAt ? Math.min(10_000_000, Math.round((Date.now() - q.oldestAt) / 60_000)) : 0,
    dropped: dropsToday(q.dropped), lastErr: (q.lastErr || '').slice(0, 40),
    sw, swHeals: Math.min(1000, healsToday()), scr, lang: lang === 'es' ? 'es' : 'en',
  };
}

let beating = false;
/** Send the heartbeat if it is due: a new account, version or day, or beatMin since the last. */
export async function beat({ force = false } = {}) {
  if (!sdk || !user || beating || refused.beat || !telemetryOn() || !getConfig('health', 'enabled')) return false;
  const day = today();
  const last = read(BEAT_KEY);
  const due = force || last?.uid !== user.uid || last?.ver !== APP_VERSION || last?.day !== day
    || Date.now() - (last?.at || 0) >= getConfig('health', 'beatMin') * 60_000;
  if (!due) return false;
  beating = true;
  try {
    await sdk.set(sdk.ref(sdk.db, `health/${day}/${user.uid}`), await record());
    write(BEAT_KEY, { uid: user.uid, ver: APP_VERSION, day, at: Date.now() });
    return true;
  } catch (err) {
    console.warn('[health] heartbeat not sent', err?.code || err);
    if (isRefusal(err)) refused.beat = true;
    return false;
  } finally {
    beating = false;
  }
}

/**
 * Once the page is idle, and only for somebody already signed in (a visitor
 * who never signed in never loads the Firebase SDK for this): the first
 * heartbeat, the errors caught so far, and a look every few minutes.
 */
export function startHealth() {
  const go = async () => {
    try {
      const auth = await import('./sync-auth.js');
      if (!auth.hasPersistedSession()) return;
      await auth.onAuthChange(async (u) => {
        const google = u && !u.isAnonymous && u.providerData?.some(p => p.providerId === 'google.com');
        user = google ? u : null;
        if (!user) return;
        sdk = sdk || await auth.getDatabaseHandle();
        await beat();
        await flushErrors();
      });
    } catch (err) {
      console.warn('[health] not started', err?.code || err);
    }
  };
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 3000));
  idle(() => go(), { timeout: 15_000 });
  setInterval(() => { if (!document.hidden) beat().then(flushErrors); }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat().then(flushErrors); });
}
