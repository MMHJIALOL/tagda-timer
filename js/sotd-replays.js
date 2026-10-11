import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Scramble of the Day: shared replays

   Your SOTD attempt's webcam clip, shared for everybody else who has done
   the same scramble to watch, for 7 days after the day. Never without being
   asked: Share replay under the board, or "Always share my SOTD replay" in
   the camera panel. What goes up is a copy (replay-media.js shareCopy); the
   clip on this device is left exactly as it was.

   worker.js does the checking and DAILY.md §8 has the reasoning. This side
   keeps its own requests few, because every one is a Worker request and
   every watch an R2 read:
   - one request per share, retried once and only on a network error;
   - one per clip watched, kept in memory for the page, so watching it again
     asks for nothing; nothing at all is fetched until ▶ is pressed;
   - who has shared comes from the `replay` flag on the board rows already
     being read. R2 is never listed from here.
   Every refusal is a toast and nothing else: the solve, the time and the
   board are never touched by any of it.

   The admin console's config/replays (ADMIN.md) can switch it all off,
   shrink a clip or the day, end it early, or keep clips fewer days. worker.js
   enforces every one of those; this side reads the same settings so that it
   says so before doing any work, and asks the day's count (replayDay/)
   before uploading, because a share refused for a full day has spent the
   account's one share for that event.
   =========================================================== */

import { el } from './util.js';
import { toast, confirmToast } from './toast.js';
import { idToken } from './sync-auth.js';
import { getConfig, loadConfig } from './config.js';
import { hasFeature } from './audience.js';
import { banLine } from './admins.js';
import { hasReplay, loadClip, clipMeta, clipReady, holdFinish, openReplay, replaySettings,
         setReplaySetting } from './replay.js';

/** worker.js's CLIP_MAX, mirrored: the copy is sized to fit under it, or under the setting if that is smaller. */
export const CLIP_MAX = 10 * 1024 * 1024;
const DAY_MS = 86_400_000;
const clipMax = () => Math.min(CLIP_MAX, getConfig('replays', 'maxClipBytes'));
/** How many days after its day a clip is kept: 7, or fewer from the admin console. */
export const keepDays = () => getConfig('replays', 'keepDays');
/** The Worker's rule exactly: gone once the day is more than keepDays() over. */
export const replayKept = (dayKey, now = Date.now()) => now <= Number(dayKey) + (keepDays() + 1) * DAY_MS;
/** Sharing and watching switched on (config/replays/enabled). */
export const replaysOn = () => getConfig('replays', 'enabled') && hasFeature('replays');
/** Whether replays are a thing for this account at all (their audience, ADMIN.md §9): if not, nothing about them is drawn. */
export const replaysForMe = () => hasFeature('replays');
const offText = () => getConfig('replays', 'message') || t('Replays are switched off for now');
const FULL = () => t('Today’s replay slots are full');

const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/></svg>';
const keyOf = ({ dayKey, event, uid }) => `${dayKey}|${event}|${uid}`;
const pathOf = ({ dayKey, event, uid }) => `/replay/${dayKey}/${event}${uid ? `/${uid}` : ''}`;

class ReplayError extends Error {
  constructor(status, code = '') { super(code || String(status)); this.status = status; this.code = code; }
}

/* ---------------- watching ---------------- */

const clips = new Map();     // key -> Promise<{ blob, meta, admin }>, for the page's life
const gone = new Set();      // keys the Worker said were removed: their ▶ goes

function parseMeta(h) {
  const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    insp: n(h.insp), start: n(h.start) ?? 0, stop: n(h.stop) ?? 0, timeMs: n(h.timeMs),
    w: n(h.w) || 0, h: n(h.h) || 0, fps: n(h.fps) || 30, lat: n(h.lat) || 0, adj: n(h.adj) || 0,
    sound: h.sound === '1', at: n(h.at) || Date.now(), mime: h.mime || '', splits: [],
  };
}

async function fetchClip(at) {
  const token = await idToken().catch(() => null);
  if (!token) throw new ReplayError(401, 'no-token');
  let r;
  for (let i = 0; ; i++) {
    try { r = await fetch(pathOf(at), { headers: { Authorization: `Bearer ${token}` } }); break; }
    catch { if (i) throw new ReplayError(0, 'network'); }   // once more, and only for a network error
  }
  if (!r.ok) throw new ReplayError(r.status, (await r.json().catch(() => ({}))).error);
  let head = {};
  try { head = JSON.parse(r.headers.get('x-replay-meta') || '{}'); } catch { /* the defaults below */ }
  const meta = parseMeta(head);
  const raw = await r.blob();
  return { blob: raw.type ? raw : new Blob([raw], { type: meta.mime }), meta, admin: r.headers.get('x-replay-admin') === '1' };
}

const VIEW_ERRORS = {
  401: () => t('Sign in to watch replays'),
  403: () => t('Submit your own attempt to watch the replays'),
  404: () => t('That replay was removed'),
  410: () => t('Replays are kept for {n} days', { n: keepDays() }),
  503: offText,
};

/** Whether a board row's ▶ should be drawn. */
export const canPlay = (dayKey, event, uid, result) =>
  result?.replay === true && replaysOn() && replayKept(dayKey) && !gone.has(keyOf({ dayKey, event, uid }));

/** Fetch (once) and play somebody's shared clip. `button` shows it loading. */
export async function playShared({ dayKey, event, uid, name, timeMs, penalty, button = null, onGone = null, onBan = null, onReport = null }) {
  const at = { dayKey, event, uid };
  const key = keyOf(at);
  if (!replaysOn()) { toast(offText()); return; }
  if (!replayKept(dayKey)) { toast(t('Replays are kept for {n} days', { n: keepDays() })); return; }
  if (button) { button.disabled = true; button.classList.add('loading'); }
  try {
    let p = clips.get(key);
    if (!p) {
      p = fetchClip(at);
      clips.set(key, p);
      p.catch(() => { if (clips.get(key) === p) clips.delete(key); });
    }
    const got = await p;
    const player = await import('./replay-player.js');
    await player.openSharedPlayer({
      blob: got.blob, meta: got.meta, timeMs: timeMs ?? got.meta.timeMs, penalty, name,
      // The player asks first: a toast's buttons cannot be pressed under a modal.
      onRemove: got.admin ? () => removeShared(at, { asked: true }).then((ok) => { if (ok) onGone?.(); return ok; }) : null,
      onBan: got.admin && onBan ? () => onBan({ uid, name }) : null,
      onReport: !got.admin && onReport ? () => onReport({ uid, name }) : null,
    });
  } catch (err) {
    if (err instanceof ReplayError) {
      if (err.status === 404 || err.status === 410) { gone.add(key); onGone?.(); }
      toast((VIEW_ERRORS[err.status] || (() => t('Couldn’t load the replay, try later')))(), { kind: 'bad' });
    } else {
      console.warn('[sotd-replays] play', err);
      toast(t('Couldn’t load the replay, try later'), { kind: 'bad' });
    }
  } finally {
    if (button) { button.disabled = false; button.classList.remove('loading'); }
  }
}

/** The ▶ on a board row. */
export function playButton({ dayKey, event, uid, result, onGone, onBan = null, onReport = null }) {
  const name = result?.name || 'Cuber';
  const b = el('button', {
    class: 'db-play', type: 'button', html: PLAY,
    title: t('Watch {name}’s replay', { name }), 'aria-label': t('Watch {name}’s replay', { name }),
  });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    playShared({ dayKey, event, uid, name, timeMs: result?.timeMs, penalty: result?.penalty || 'none', button: b, onGone, onBan, onReport });
  });
  // The keys belong to the timer behind the board: space on a focused ▶ must not start a solve.
  b.addEventListener('keydown', (e) => e.stopPropagation());
  return b;
}

/* ---------------- sharing ---------------- */

const jobs = new Map();      // key -> { phase: 'preparing' | 'uploading', pct }
const spent = new Map();     // key -> whether today's one share for it is used (shared, or shared and removed)
const off = new Set();       // keys whose board runs rules from before replays: nothing can be shared yet
const full = new Set();      // day keys whose replay slots are all taken (replays.maxPerDay)
const counted = new Set();   // day keys whose count has been read once for the box
const asked = new Set();     // keys whose claim has been read once
const boxes = new Set();     // share boxes on screen, repainted as a job moves
const repaint = () => boxes.forEach(b => b.refresh());

function xhrPut(url, token, blob, type, metaJson, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Authorization', `Bearer ${token}`);
    x.setRequestHeader('Content-Type', type);
    x.setRequestHeader('X-Replay-Meta', metaJson);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      resolve({ status: x.status, body });
    };
    x.onerror = () => reject(new TypeError('network'));
    x.send(blob);
  });
}

const SHARE_ERRORS = {
  401: () => t('Sign in again to share your replay'),
  409: () => t('You have already shared a replay for this today'),
  429: FULL,
  413: () => t('That replay is too big to share'),
  415: () => t('That clip can’t be shared'),
  503: () => t('Sharing replays isn’t switched on yet'),
  507: () => t('Replay space for today is full'),
};
const COPY_ERRORS = {
  'too-long': () => t('That clip is too long to share'),
  'too-big': () => t('That replay is too big to share'),
  cannot: () => t('This browser can’t prepare the replay for sharing'),
};

/**
 * Share the clip of `solveId` on the board `at` ({ dayKey, event, uid }).
 * Resolves whether it is now shared. `quiet`: the automatic share, which
 * says nothing when there turns out to be no clip.
 */
export async function shareReplay(ctl, at, solveId, { quiet = false } = {}) {
  const key = keyOf(at);
  if (jobs.has(key)) return false;
  const job = { phase: 'preparing', pct: 0 };
  jobs.set(key, job);
  repaint();
  try {
    // The admin console's switches first: off, or banned, and nothing else is worth doing.
    await loadConfig();
    if (!replaysOn()) { if (!quiet && replaysForMe()) toast(offText(), { long: true }); return false; }
    if (ctl.bannedFor('replays')) { if (!quiet) toast(banLine(ctl.snap?.ban, 'replays'), { kind: 'bad', long: true }); return false; }
    /* One read before any work: rules not published yet, or today's share
       already used, is known without encoding or uploading anything. */
    const claimed = await ctl.net?.hasReplayClaim?.(at);
    if (claimed === 'off') { off.add(key); toast(SHARE_ERRORS[503](), { kind: 'bad', long: true }); return false; }
    if (claimed === true) { spent.set(key, true); if (!quiet) toast(SHARE_ERRORS[409](), { kind: 'bad' }); return false; }
    /* …and whether the day still has room. The Worker counts again before
       its put, but by then the claim, this account's one share for the event
       today, is spent; asking here first means that rarely happens. */
    const shared = await ctl.net?.replaysShared?.(at.dayKey);
    if (shared != null && shared >= getConfig('replays', 'maxPerDay')) {
      full.add(at.dayKey);
      if (!quiet) toast(FULL(), { long: true });
      return false;
    }
    await clipReady(solveId);
    const got = await loadClip(solveId);
    if (!got) { if (!quiet) toast(t('That replay is gone')); return false; }
    const S = replaySettings();
    const m = got.meta;
    let copy;
    // The conversion on this device waits while the copy is made: two encodes at once can fail in Firefox.
    const release = holdFinish();
    try {
      const media = await import('./replay-media.js');
      copy = await media.shareCopy(got.blob, {
        sound: !!(m.sound && S.sotdShareSound), maxBytes: clipMax(),
        onProgress: (p) => { job.pct = p; repaint(); },
      });
    } catch (err) {
      const why = COPY_ERRORS[err?.code];
      if (!why) console.warn('[sotd-replays] could not prepare', err);
      toast((why || COPY_ERRORS.cannot)(), { kind: 'bad', long: true });
      return false;
    } finally { release(); }

    const meta = JSON.stringify({
      insp: m.insp ?? null, start: m.start, stop: m.stop, timeMs: m.timeMs,
      w: copy.w, h: copy.h, fps: copy.fps || m.fps, lat: m.lat || 0,
      adj: (S.webcamSync || {})[m.cam] || 0, sound: !!copy.sound, at: m.at,
    });
    job.phase = 'uploading';
    job.pct = 0;
    repaint();
    const token = await idToken().catch(() => null);
    if (!token) { toast(SHARE_ERRORS[401](), { kind: 'bad' }); return false; }
    let res, retried = false;
    for (;;) {
      try { res = await xhrPut(pathOf({ dayKey: at.dayKey, event: at.event }), token, copy.blob, copy.mime, meta, (p) => { job.pct = p; repaint(); }); break; }
      catch (err) {
        if (retried) { toast(t('Couldn’t share the replay, try later'), { kind: 'bad' }); return false; }
        retried = true;
      }
    }
    // A retry after a network error that had in fact gone through: the first one is the share.
    if (res.status === 409 && retried && await ctl.net?.replayFlag(at)) res = { status: 200, body: { flagged: true } };
    if (res.status === 200) {
      spent.set(key, true);
      if (!res.body?.flagged) await ctl.net?.setReplayFlag(true, at).catch(err => console.warn('[sotd-replays] flag', err));
      toast(t('Replay shared'));
      return true;
    }
    if (res.status === 409 || res.status === 507 || res.status === 429) spent.set(key, true);
    if (res.status === 429) full.add(at.dayKey);
    // 503 is either the switch (`off`, with the admin's message) or rules from before replays.
    if (res.status === 503 && res.body?.error === 'off') {
      if (!quiet) toast(res.body.message || offText(), { long: true });
      loadConfig({ maxAge: 0 }).then(repaint);
      return false;
    }
    if (res.status === 503) off.add(key);
    const msg = res.status === 403
      ? (res.body?.error === 'not-google' ? t('Only Google accounts can share replays')
        : res.body?.error === 'banned' ? (ctl.snap?.ban ? banLine(ctl.snap.ban, 'replays') : t('This account can’t share replays'))
          : t('Submit today’s attempt first'))
      : (SHARE_ERRORS[res.status] || (() => t('Couldn’t share the replay, try later')))();
    toast(msg, { kind: 'bad', long: true });
    return false;
  } finally {
    jobs.delete(key);
    repaint();
  }
}

/** The owner takes theirs down (asked first: it cannot be shared again that day), or an admin anybody's. */
async function removeShared(at, { asked = false } = {}) {
  if (!asked && !(await confirmToast(t('Remove your replay? You can’t share another one for this event today.'),
    t('Remove'), { timeout: 10000 }))) return false;
  const token = await idToken().catch(() => null);
  let r = null;
  for (let i = 0; i < 2 && token; i++) {
    try { r = await fetch(pathOf(at), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); break; }
    catch { /* once more, for a network error only */ }
  }
  if (!r?.ok) { toast(t('Couldn’t remove the replay, try later'), { kind: 'bad' }); return false; }
  const key = keyOf(at);
  clips.delete(key);
  gone.add(key);
  spent.set(key, true);
  toast(t('Replay removed'));
  repaint();
  return true;
}

/**
 * An admin took a row off the board: its clip goes as well, quietly. Nobody
 * can reach it without the row's flag anyway, and deletes cost nothing; the
 * bucket's lifecycle rule would get it within 8 days if this does not.
 */
export async function dropClip(at) {
  clips.delete(keyOf(at));
  const token = await idToken().catch(() => null);
  if (!token) return;
  try { await fetch(pathOf(at), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
  catch (err) { console.warn('[sotd-replays] clip delete', err); }
}

/** "Always share my SOTD replay": a result landing starts the share. Once per controller. */
const bound = new WeakSet();
export function bindReplays(ctl) {
  if (bound.has(ctl)) return;
  bound.add(ctl);
  /* Your own time was removed by an admin: the removal cleared your share
     claim, so a replay of the backup solve can be shared. Forget what was
     known about the first one. */
  ctl.addEventListener('removed', (e) => {
    const at = e.detail?.at;
    if (!at?.dayKey) return;
    const key = keyOf(at);
    for (const s of [clips, gone, spent, off, asked]) s.delete(key);
    counted.delete(at.dayKey);
    full.delete(at.dayKey);
    repaint();
  });
  ctl.addEventListener('submitted', (e) => {
    const { solve, at } = e.detail || {};
    if (!replaySettings().sotdShareAuto || !solve || !hasReplay(solve.id)) return;
    shareReplay(ctl, at, solve.id, { quiet: true });
  });
}

/**
 * Under today's board, once you have submitted: Share replay, its progress,
 * then Shared · Watch · Remove. Built once and kept, like the note composer,
 * so a progress bar is not rebuilt by every board redraw.
 */
export function shareBox(ctl) {
  const box = el('div', { class: 'db-share', hidden: true });
  const metaCache = new Map();          // solve id -> whether its clip has sound
  box.refresh = () => {
    const at = ctl.net?.target?.();
    const solveId = ctl.attemptSolveId?.();
    if (!at?.dayKey || !at.uid || !ctl.revealed) { box.hidden = true; return; }
    const key = keyOf(at);
    const row = ctl.snap?.results?.[at.uid];
    const job = jobs.get(key);
    const local = !!solveId && hasReplay(solveId);
    if (!asked.has(key) && ctl.net?.hasReplayClaim) {
      asked.add(key);
      ctl.net.hasReplayClaim(at).then((v) => {
        if (v === 'off') off.add(key);
        else if (v != null && !spent.has(key)) spent.set(key, v);
        repaint();
      });
    }
    /* Whether the day is already full, once, while there is still a share
       to make: the box says so rather than offering a button that will fail. */
    if (local && !counted.has(at.dayKey) && ctl.net?.replaysShared && row?.replay !== true && replaysOn()) {
      counted.add(at.dayKey);
      ctl.net.replaysShared(at.dayKey).then((n) => {
        if (n != null && n >= getConfig('replays', 'maxPerDay')) { full.add(at.dayKey); repaint(); }
      });
    }
    if (local && !metaCache.has(solveId)) {
      metaCache.set(solveId, null);
      clipMeta(solveId).then((m) => { metaCache.set(solveId, !!m?.sound); box.refresh(); }, () => {});
    }

    let kids;
    if (job) {
      const pct = Math.round((job.pct || 0) * 100);
      kids = [
        el('div', { class: 'db-share-row' },
          el('span', { text: job.phase === 'preparing' ? t('Preparing the replay… {pct}%', { pct }) : t('Uploading {pct}%', { pct }) })),
        el('div', { class: 'rp-progress' }, el('i', { style: { width: `${pct}%` } })),
      ];
    } else if (row?.replay === true) {
      kids = [el('div', { class: 'db-share-row' },
        el('span', { class: 'db-share-done', text: t('Replay shared · kept {n} days', { n: keepDays() }) }),
        el('button', { class: 'ghost-btn sm', type: 'button', text: t('Watch'), onclick: () => {
          // Yours is on this device: watching it costs nothing.
          if (local) openReplay(ctl.app?.solves?.find(s => s.id === solveId) || solveId);
          else playShared({ ...at, name: row.name, timeMs: row.timeMs, penalty: row.penalty });
        } }),
        el('button', { class: 'ghost-btn sm danger', type: 'button', text: t('Remove'), onclick: () => removeShared(at) }))];
    } else if (!replaysForMe()) {
      kids = [];
    } else if (!replaysOn() && local) {
      kids = [el('div', { class: 'db-share-row' }, el('span', { class: 'db-share-note', text: offText() }))];
    } else if (ctl.bannedFor('replays') && local) {
      kids = [el('div', { class: 'db-share-row' }, el('span', { class: 'db-share-note', text: banLine(ctl.snap?.ban, 'replays') }))];
    } else if (off.has(key)) {
      kids = [el('div', { class: 'db-share-row' },
        el('span', { class: 'db-share-note', text: t('Sharing replays isn’t switched on yet') }))];
    } else if (full.has(at.dayKey) && local && !spent.get(key)) {
      kids = [el('div', { class: 'db-share-row' }, el('span', { class: 'db-share-note', text: FULL() }))];
    } else if (spent.get(key)) {
      kids = [el('div', { class: 'db-share-row' },
        el('span', { class: 'db-share-note', text: t('Your replay isn’t shared. One share per event a day.') }))];
    } else if (local) {
      const sound = metaCache.get(solveId);
      const tick = el('input', { type: 'checkbox' });
      tick.checked = !!replaySettings().sotdShareSound;
      tick.addEventListener('change', () => setReplaySetting('sotdShareSound', tick.checked));
      kids = [
        el('div', { class: 'db-share-row' },
          el('button', { class: 'btn primary sm', type: 'button', html: `${PLAY}<span>${t('Share replay')}</span>`,
            onclick: () => shareReplay(ctl, at, solveId) }),
          sound ? el('label', { class: 'db-share-sound' }, tick, el('span', { text: t('Include sound') })) : null),
        el('div', { class: 'db-share-note', text: t('Everyone who has done today’s scramble can watch it, for {n} days. Your copy stays on this device.', { n: keepDays() }) }),
      ];
    } else { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren(...kids);
    // Space on a focused button here is not the timer's.
    for (const b of box.querySelectorAll('button, input')) b.addEventListener('keydown', (e) => e.stopPropagation());
  };
  box.dispose = () => { boxes.delete(box); removeEventListener('tdt-config', box.refresh); };
  boxes.add(box);
  // A switch flipped from the admin console redraws it.
  addEventListener('tdt-config', box.refresh);
  box.refresh();
  return box;
}
