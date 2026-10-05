/* ===========================================================
   Tagda Timer — settings the admin console can change, as the app reads them

   The table itself (every setting, its default, its range) is
   js/config-table.js, kept free of anything browser-only so worker.js can
   bundle it too. This file adds the live copy: getConfig(), what the app
   reads, and loadConfig(), which fetches it.

   Reading it costs one plain REST fetch of /config.json, kept in
   localStorage for CACHE_MS. Never a live listener: the Firebase project is
   on the Spark plan, 100 connections at once (RACE.md, "Cost"), and a
   setting that changes a few times a week is not worth one. If the fetch
   fails, the last copy or the defaults stay in use and nothing breaks.
   =========================================================== */

import { CONFIG, NAME, spec, allSettings, clean, valid, sectionOf, setOf } from './config-table.js';

export { CONFIG, NAME, spec, allSettings, clean, valid, sectionOf, setOf };

/** How long a fetched copy is trusted before the next page load asks again. */
export const CACHE_MS = 5 * 60_000;
const CACHE_KEY = 'tdt-config';

/* ---------------- the live copy ---------------- */

let live = null;
let ann = null;
let at = 0;

function readCache() {
  try {
    const got = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (got && typeof got.at === 'number' && got.data && typeof got.data === 'object') return got;
  } catch { /* private window, or junk: the defaults */ }
  return null;
}

{
  const got = readCache();
  if (got) { live = got.data; ann = got.ann && typeof got.ann === 'object' ? got.ann : null; at = got.at; }
}

/** The setting's value: the database's, clipped to its range, or the default. */
export function getConfig(section, key) {
  const sp = spec(section, key);
  if (!sp) throw new Error(`no such setting: ${section}.${key}`);
  const v = clean(sp, live?.[section]?.[key]);
  return v === undefined ? sp.def : v;
}

/** announcements/ as last fetched (announce.js makes sense of it), or null. */
export const storedAnnouncements = () => ann;

/**
 * Replace the live copy (a fetch's result, or a test's). Announces
 * 'tdt-config'. `announcements` left out keeps the ones already held.
 */
export function applyConfig(data, when = Date.now(), announcements = ann) {
  live = data && typeof data === 'object' ? data : {};
  ann = announcements && typeof announcements === 'object' ? announcements : null;
  at = when;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at, data: live, ann })); } catch { /* still live for this page */ }
  if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('tdt-config'));
}

let inflight = null;

/** One public node over REST: its value, null for refused (rules from before it) or empty, undefined for a failure. */
async function readPublic(base, path, q) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${base}/${path}.json${q}`, { signal: ctl.signal, cache: 'no-store' });
    if (r.status === 401) return null;
    if (!r.ok) return undefined;
    return await r.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch /config.json and /announcements.json unless the cached copy is
 * younger than `maxAge`. Never throws: on any failure the cached copy (or
 * the defaults) stays in use. Two small public reads, no connection.
 */
export function loadConfig({ maxAge = CACHE_MS } = {}) {
  if (live && Date.now() - at < maxAge) return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [{ FIREBASE_CONFIG }, { EMULATED }] = await Promise.all([import('./raceapp.js'), import('./sync-auth.js')]);
      const base = EMULATED ? 'http://127.0.0.1:9000' : FIREBASE_CONFIG.databaseURL;
      const q = EMULATED ? '?ns=tagda-timer-default-rtdb' : '';
      const [cfg, anns] = await Promise.all([readPublic(base, 'config', q), readPublic(base, 'announcements', q)]);
      // Refused or empty is "nothing set": the defaults. A failed read keeps what is held.
      if (cfg === undefined) return false;
      applyConfig(cfg || {}, Date.now(), anns === undefined ? ann : anns);
      return true;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
