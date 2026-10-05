/* ===========================================================
   Tagda Timer — the Worker

   Only two kinds of path ever run this file (run_worker_first in
   wrangler.jsonc); everything else is a static asset, which is not metered.

   /__/auth/*  Same-origin Firebase sign-in: proxied to the firebaseapp.com
               handler, which is what the rewrite in vercel.json does on
               Vercel. Why it has to be same-origin is explained above
               SAME_ORIGIN_AUTH_HOSTS in raceapp.js.

   /replay/*   Shared Scramble of the Day replays, kept in R2 for 7 days
               after their day (DAILY.md §8).

   The money rule for /replay/. R2 bills past its free tier instead of
   failing, so this file is what keeps every meter under it:
   - Reads (Class B) only ever come through here, one R2 get per request at
     most, and Workers Free stops at 100k requests a day. The bucket has no
     public route of its own.
   - Writes (Class A) need a write-once claim in the Realtime Database first,
     one per Google account, event and day. After it: one list and one put.
   - Storage: CLIP_MAX a clip and DAY_BUDGET a day, all events together; the
     bucket's lifecycle rule deletes clips about 8 days after upload.
   Every cheap check runs first, then the database, and R2 is touched last.

   The admin console's settings (config/replays, ADMIN.md) can switch this
   off or tighten it, never loosen it: every limit is min(setting, the
   constant above), so a typo on the admin page cannot cost money.

   No crypto here. The ID token goes to the database REST API as ?auth=, and
   a read the rules allow is the proof that it is genuine; only then is its
   payload decoded (unverified, it is the same string) for the uid and the
   sign-in provider. Never as an Authorization header: the REST API takes a
   Bearer header as an admin OAuth credential, which skips every rule.
   =========================================================== */

import { sectionOf } from './js/config-table.js';

const DAY_MS = 86_400_000;
const IST_MS = 19_800_000;            // the day starts at 00:00 IST (js/dayid.js)
const MB = 1024 * 1024;
/* The ceilings. Settings only ever go below them. */
const KEEP_DAYS = 7;                  // after the day itself; the bucket deletes at 8 days
const PER_DAY = 1000;                 // one page of R2's list, all events together
const TYPES = ['video/webm', 'video/mp4'];
const META_KEYS = ['v', 'mime', 'insp', 'start', 'stop', 'timeMs', 'w', 'h', 'fps', 'lat', 'adj', 'sound', 'at'];
const PATH = /^\/replay\/(\d{13})\/([a-z0-9]{2,12})(?:\/([A-Za-z0-9]{1,128}))?$/;
const UID = /^[A-Za-z0-9]{1,128}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, search } = url;
    if (pathname.startsWith('/__/auth/')) {
      return fetch(new Request(`https://tagda-timer.firebaseapp.com${pathname}${search}`, request));
    }
    if (pathname === '/replay' || pathname.startsWith('/replay/')) {
      try { return await replay(request, env, pathname); }
      catch (err) {
        console.log(JSON.stringify({ replay: 'error', message: String(err?.message || err) }));
        return fail(502, 'upstream');
      }
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- helpers ---------------- */

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});
const fail = (status, error) => json(status, { error });
const log = (op, key, extra = {}) => console.log(JSON.stringify({ r2: op, key, ...extra }));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

const todayKey = (now) => Math.floor((now + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
const isDayKey = (k) => (k + IST_MS) % DAY_MS === 0;

function bearer(request) {
  const m = /^Bearer ([\w.-]{20,4096})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}

/* The payload, unverified. Trusted only after the database has accepted the same token. */
function claims(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch { return null; }
}

function rtdb(env, path, token, init = {}) {
  const q = new URLSearchParams({ auth: token });
  if (env.RTDB_NS) q.set('ns', env.RTDB_NS);
  const base = String(env.RTDB_URL || '').replace(/\/+$/, '');
  return fetch(`${base}/${path}.json?${q}`, { ...init, headers: { 'content-type': 'application/json' } });
}

/* Whether the token is genuine at all: a read only its owner may make, of a
   child that does not exist. Asked only to tell a 401 from a 403. */
async function tokenOk(env, sub, token) {
  const r = await rtdb(env, `users/${sub}/replayProbe`, token);
  return r.ok;
}

/**
 * Whether this account is an admin: a Google sign-in whose admins/<uid> is
 * true (ADMIN.md). Each account may read its own entry, so the rules answer.
 * A refused read is the rules from before the admin console, where ADMIN_UIDS
 * is still the list; a bad token gets there too, which is why every caller
 * proves the token separately before acting.
 */
async function isAdmin(env, who, sub, token) {
  if (who?.firebase?.sign_in_provider !== 'google.com') return false;
  const r = await rtdb(env, `admins/${sub}`, token).catch(() => null);
  if (r?.ok) return (await r.json()) === true;
  return String(env.ADMIN_UIDS || '').split(',').map(s => s.trim()).includes(sub);
}

/* ---------------- settings (ADMIN.md) ---------------- */

let settings = { at: 0, data: null };

/**
 * config/replays, public to read, kept in this isolate for a minute
 * (CONFIG_TTL_MS) so a busy day costs a few database reads rather than one a
 * request. Refused (rules from before the console) is the defaults, which
 * are the constants; a failed fetch keeps the last copy if there is one.
 */
async function replaySettings(env, now = Date.now()) {
  if (settings.data && now - settings.at < num(env.CONFIG_TTL_MS, 60_000)) return settings.data;
  let stored;
  try {
    const q = env.RTDB_NS ? `?ns=${encodeURIComponent(env.RTDB_NS)}` : '';
    const r = await fetch(`${String(env.RTDB_URL || '').replace(/\/+$/, '')}/config/replays.json${q}`);
    stored = r.ok ? await r.json() : r.status === 401 ? null : undefined;
  } catch { stored = undefined; }
  const data = stored === undefined && settings.data ? settings.data : sectionOf('replays', stored);
  settings = { at: now, data };
  return data;
}

/** Every limit at min(setting, ceiling). */
function limits(env, cfg) {
  return {
    clipMax: Math.min(num(env.CLIP_MAX, 10 * MB), cfg.maxClipBytes),
    budget: Math.min(num(env.DAY_BUDGET, 1024 * MB), cfg.dayBudgetBytes),
    perDay: Math.min(PER_DAY, cfg.maxPerDay),
    keepMs: (Math.min(KEEP_DAYS, cfg.keepDays) + 1) * DAY_MS,   // the day itself, then keepDays more
  };
}

const switchedOff = (cfg) => json(503, { error: 'off', message: cfg.message || '' });

/**
 * Whether the account is banned (bans/<uid>, readable by its owner). Refused
 * is the rules from before bans, where nobody is; the claim's own rule
 * checks the ban again, so this is for the right refusal, not the only one.
 */
async function isBanned(env, sub, token, now) {
  const r = await rtdb(env, `bans/${sub}`, token).catch(() => null);
  if (!r?.ok) return false;
  const ban = await r.json();
  return !!ban && !(typeof ban.until === 'number' && ban.until <= now);
}

function magicOk(type, b) {
  if (type === 'video/webm') return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  return b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;      // 'ftyp'
}

/* Only the clock fields the player needs, as short strings. No camera or mic name. */
function cleanMeta(m, type, now) {
  const n = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
    ? String(Math.round(v * 1000) / 1000) : '');
  return {
    v: '1', mime: type,
    insp: n(m.insp, -1e7, 1e7), start: n(m.start, -1e7, 1e7), stop: n(m.stop, -1e7, 1e7),
    timeMs: n(m.timeMs, 0, 36e6), w: n(m.w, 0, 8192), h: n(m.h, 0, 8192), fps: n(m.fps, 1, 240),
    lat: n(m.lat, -2000, 2000), adj: n(m.adj, -2000, 2000), sound: m.sound === true ? '1' : '0',
    at: n(m.at, 0, 1e14) || String(now),
  };
}

/* ---------------- /replay/<dayKey>/<event>[/<uid>] ---------------- */

async function replay(request, env, pathname) {
  const m = PATH.exec(pathname);
  if (!m) return fail(400, 'bad-path');
  const dayKey = Number(m[1]);
  if (!isDayKey(dayKey)) return fail(400, 'bad-day');
  const at = { dayKey, event: m[2], uid: m[3] || null };
  const method = request.method;
  if (method === 'PUT' && !at.uid) return put(request, env, at);
  if (method === 'GET' && at.uid) return get(request, env, at);
  if (method === 'DELETE' && at.uid) return del(request, env, at);
  return fail(405, 'method');
}

/** Share your own clip of the day's attempt. */
async function put(request, env, { dayKey, event }) {
  const now = Date.now();
  const today = todayKey(now);
  // 1. Today's or yesterday's, by this clock.
  if (dayKey !== today && dayKey !== today - DAY_MS) return fail(400, 'bad-day');
  // Switched on, before anything else costs anything.
  const cfg = await replaySettings(env, now);
  if (!cfg.enabled) return switchedOff(cfg);
  const lim = limits(env, cfg);

  // 2. Headers.
  const token = bearer(request);
  if (!token) return fail(401, 'no-token');
  let meta = null;
  try { meta = JSON.parse(request.headers.get('x-replay-meta') || ''); } catch { /* below */ }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fail(400, 'bad-meta');
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES.includes(type)) return fail(415, 'bad-type');
  const max = lim.clipMax;
  const declared = request.headers.get('content-length');
  if (declared == null || !/^\d+$/.test(declared)) return fail(411, 'no-length');
  if (Number(declared) > max) return fail(413, 'too-big');

  // 3. The body, really that size, really a video.
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > max) return fail(413, 'too-big');
  if (body.byteLength < 64 || !magicOk(type, body)) return fail(415, 'not-video');

  // 4. A Google account, with a result on this board.
  const who = claims(token);
  const sub = typeof who?.sub === 'string' && UID.test(who.sub) ? who.sub : null;
  if (!sub) return fail(401, 'bad-token');
  if (who.firebase?.sign_in_provider !== 'google.com') return fail(403, 'not-google');
  const base = `daily/${dayKey}/${event}`;
  const row = await rtdb(env, `${base}/results/${sub}`, token);
  if (row.status === 401) return (await tokenOk(env, sub, token)) ? fail(403, 'not-submitted') : fail(401, 'bad-token');
  if (!row.ok) return fail(502, 'db');
  if ((await row.json()) == null) return fail(403, 'not-submitted');
  if (await isBanned(env, sub, token, now)) return fail(403, 'banned');

  // 5. The claim: write-once, so this is the one attempt today that reaches R2.
  const claim = await rtdb(env, `${base}/replayClaim/${sub}`, token, { method: 'PUT', body: '{".sv":"timestamp"}' });
  if (!claim.ok) {
    if (claim.status !== 401) return fail(502, 'db');
    // Refused: already claimed, or rules from before replays (no rule for the node, nothing readable).
    const had = await rtdb(env, `${base}/replayClaim/${sub}`, token);
    if (had.ok && (await had.json()) != null) return fail(409, 'already-shared');
    return fail(503, 'not-enabled');
  }
  /* The day's count, one entry per claim, which the app reads before it
     uploads anything (replayDay/, ADMIN.md). Not needed for the check below,
     which counts R2 itself; refused on rules from before it, and that is fine. */
  await rtdb(env, `replayDay/${dayKey}/${event}/${sub}`, token, { method: 'PUT', body: '{".sv":"timestamp"}' }).catch(() => null);

  // 6. Today's room, all events together: the first lim.perDay clips, inside
  // the day's budget. More than one page of clips counts as full.
  const listed = await env.REPLAYS.list({ prefix: `r/${dayKey}/`, limit: 1000 });
  log('list', `r/${dayKey}/`, { n: listed.objects.length });
  if (listed.truncated || listed.objects.length >= lim.perDay) return fail(429, 'slots-full');
  const used = listed.objects.reduce((n, o) => n + o.size, 0);
  if (used + body.byteLength > lim.budget) return fail(507, 'full');

  // 7. The clip, then the flag the board shows it by.
  const key = `r/${dayKey}/${event}/${sub}`;
  await env.REPLAYS.put(key, body, { httpMetadata: { contentType: type }, customMetadata: cleanMeta(meta, type, now) });
  log('put', key, { bytes: body.byteLength });
  const flag = await rtdb(env, `${base}/results/${sub}/replay`, token, { method: 'PUT', body: 'true' }).catch(() => null);
  return json(200, { ok: true, flagged: !!flag?.ok, bytes: body.byteLength });
}

/** Watch somebody's clip: only once you have a result on the same board. */
async function get(request, env, { dayKey, event, uid }) {
  const now = Date.now();
  if (dayKey > todayKey(now)) return fail(400, 'bad-day');
  const cfg = await replaySettings(env, now);
  if (!cfg.enabled) return switchedOff(cfg);
  // Kept keepDays after the day ends, exactly, whatever the lifecycle rule has got round to.
  if (now > dayKey + limits(env, cfg).keepMs) return fail(410, 'expired');
  const token = bearer(request);
  if (!token) return fail(401, 'no-token');
  const who = claims(token);
  const sub = typeof who?.sub === 'string' && UID.test(who.sub) ? who.sub : null;
  if (!sub) return fail(401, 'bad-token');

  // Allowed only if the viewer has a row on this board; non-null only if the target does.
  const [r, admin] = await Promise.all([
    rtdb(env, `daily/${dayKey}/${event}/results/${uid}`, token),
    isAdmin(env, who, sub, token),
  ]);
  if (r.status === 401) return (await tokenOk(env, sub, token)) ? fail(403, 'not-submitted') : fail(401, 'bad-token');
  if (!r.ok) return fail(502, 'db');
  const row = await r.json();
  if (!row || row.replay !== true) return fail(404, 'removed');

  const key = `r/${dayKey}/${event}/${uid}`;
  const obj = await env.REPLAYS.get(key);
  log('get', key, { hit: !!obj });
  if (!obj) return fail(404, 'removed');
  const stored = obj.httpMetadata?.contentType;
  const meta = {};
  for (const k of META_KEYS) if (obj.customMetadata?.[k] != null) meta[k] = obj.customMetadata[k];
  // Somebody else's upload, served from this origin: never as anything but a video.
  return new Response(obj.body, {
    headers: {
      'content-type': TYPES.includes(stored) ? stored : 'application/octet-stream',
      'content-length': String(obj.size),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=86400',
      'vary': 'Authorization',
      'x-replay-meta': JSON.stringify(meta),
      ...(admin ? { 'x-replay-admin': '1' } : {}),
    },
  });
}

/** The owner, or an admin, takes a clip down. The claim stays: no second share that day. */
async function del(request, env, { dayKey, event, uid }) {
  if (dayKey > todayKey(Date.now())) return fail(400, 'bad-day');
  const token = bearer(request);
  if (!token) return fail(401, 'no-token');
  const who = claims(token);
  const sub = typeof who?.sub === 'string' && UID.test(who.sub) ? who.sub : null;
  if (!sub) return fail(401, 'bad-token');
  const owner = sub === uid;
  if (!owner && !(await isAdmin(env, who, sub, token))) return fail(403, 'not-yours');
  // After the admin check too: a forged token falls back to ADMIN_UIDS above.
  if (!(await tokenOk(env, sub, token))) return fail(401, 'bad-token');
  if (owner) {
    // The flag first, so the board stops offering it before the clip goes.
    const r = await rtdb(env, `daily/${dayKey}/${event}/results/${uid}/replay`, token, { method: 'DELETE' });
    if (!r.ok && r.status !== 401) return fail(502, 'db');
  }
  const key = `r/${dayKey}/${event}/${uid}`;
  await env.REPLAYS.delete(key);
  log('delete', key);
  return json(200, { ok: true });
}
