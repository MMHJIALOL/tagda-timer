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

import { CONFIG, NAME, spec, allSettings, clean, valid, sectionOf } from './config-table.js';

export { CONFIG, NAME, spec, allSettings, clean, valid, sectionOf };

/** How long a fetched copy is trusted before the next page load asks again. */
export const CACHE_MS = 5 * 60_000;
const CACHE_KEY = 'tdt-config';

/* ---------------- the live copy ---------------- */

let live = null;
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
  if (got) { live = got.data; at = got.at; }
}

/** The setting's value: the database's, clipped to its range, or the default. */
export function getConfig(section, key) {
  const sp = spec(section, key);
  if (!sp) throw new Error(`no such setting: ${section}.${key}`);
  const v = clean(sp, live?.[section]?.[key]);
  return v === undefined ? sp.def : v;
}

/** Replace the live copy (a fetch's result, or a test's). Announces 'tdt-config'. */
export function applyConfig(data, when = Date.now()) {
  live = data && typeof data === 'object' ? data : {};
  at = when;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at, data: live })); } catch { /* still live for this page */ }
  if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('tdt-config'));
}

let inflight = null;

/**
 * Fetch /config.json unless the cached copy is younger than `maxAge`. Never
 * throws: on any failure the cached copy (or the defaults) stays in use.
 */
export function loadConfig({ maxAge = CACHE_MS } = {}) {
  if (live && Date.now() - at < maxAge) return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [{ FIREBASE_CONFIG }, { EMULATED }] = await Promise.all([import('./raceapp.js'), import('./sync-auth.js')]);
      const url = EMULATED
        ? 'http://127.0.0.1:9000/config.json?ns=tagda-timer-default-rtdb'
        : `${FIREBASE_CONFIG.databaseURL}/config.json`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(timer));
      // 401 is rules from before the console: nothing has been set, so the defaults.
      if (r.status === 401) { applyConfig({}); return true; }
      if (!r.ok) return false;
      applyConfig(await r.json());
      return true;
    } catch {
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
