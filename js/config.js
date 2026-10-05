/* ===========================================================
   Tagda Timer — settings the admin console can change

   CONFIG below is the whole list: every setting, its default, and the
   range it may take. Four things are built from it and nothing else:
     - getConfig(), what the app reads;
     - the admin page's forms (js/admin.js);
     - the `config` block of firebase.rules.json, written by
       `node tools/config-rules.mjs` (and checked by test.html, so the two
       cannot drift);
     - the tables in ADMIN.md.

   The default is today's hard-coded value, and it is what the app runs on
   whenever the database has nothing, has junk, or cannot be reached. A
   number's `max` is a ceiling: getConfig() clips to it, the rules refuse
   anything above it, and where it guards money it is the same number the
   code used before there was a setting (ADMIN.md, "Ceilings").

   Reading it costs one plain REST fetch of /config.json, kept in
   localStorage for CACHE_MS. Never a live listener: the Firebase project is
   on the Spark plan, 100 connections at once (RACE.md, "Cost"), and a
   setting that changes a few times a week is not worth one.
   =========================================================== */

/**
 * One entry per section, one per key inside it.
 *   type   'bool' | 'int' | 'text'
 *   def    the built-in default
 *   min, max   ints: the range; `max` is the ceiling. text: `max` characters.
 *   where  where it takes effect: 'rules', 'worker' or 'app' (ADMIN.md)
 */
export const CONFIG = {
  sandbox: {
    title: 'Sandbox',
    about: 'Nothing reads these. They are here to try the page with: change one, find it in the log, undo it.',
    keys: {
      on:   { type: 'bool', def: false, label: 'A switch', where: 'nowhere' },
      n:    { type: 'int', def: 5, min: 0, max: 10, label: 'A number', where: 'nowhere' },
      text: { type: 'text', def: '', max: 80, label: 'A line of text', where: 'nowhere' },
    },
  },
};

/** How long a fetched copy is trusted before the next page load asks again. */
export const CACHE_MS = 5 * 60_000;
const CACHE_KEY = 'tdt-config';
/** A section or key name, as the rules and the log's `path` allow it. */
export const NAME = /^[a-zA-Z]{1,24}$/;

export function spec(section, key) {
  return CONFIG[section]?.keys?.[key] || null;
}

/** Every setting as [section, key, spec], in table order. */
export function allSettings() {
  return Object.entries(CONFIG).flatMap(([s, sec]) => Object.entries(sec.keys).map(([k, sp]) => [s, k, sp]));
}

/**
 * A stored value made safe to use, or undefined when it is not one. A number
 * past the range is clipped to it rather than thrown away: the ceiling is
 * min(setting, max), whatever reached the database.
 */
export function clean(sp, v) {
  if (!sp) return undefined;
  if (sp.type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (sp.type === 'int') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    return Math.min(sp.max, Math.max(sp.min, Math.round(v)));
  }
  if (sp.type === 'text') return typeof v === 'string' ? v.slice(0, sp.max) : undefined;
  return undefined;
}

/** Whether `v` may be written as it is: what the rules accept, checked before sending. */
export function valid(sp, v) {
  if (!sp) return false;
  if (sp.type === 'bool') return typeof v === 'boolean';
  if (sp.type === 'int') return Number.isInteger(v) && v >= sp.min && v <= sp.max;
  if (sp.type === 'text') return typeof v === 'string' && v.length <= sp.max;
  return false;
}

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
