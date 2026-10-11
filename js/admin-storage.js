import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Health › Storage (js/admin-health.js; ADMIN.md §20)

   One row per top-level database node: how many records it holds (the
   database's own ?shallow, over REST, as this admin: ids only), the oldest
   (a day key, or a push id's own time), how it is kept bounded, and its
   size on asking (one full read). The Spark plan stores 1 GB and downloads
   10 GB a month, so nothing here is read whole without a tap.

   Two sweeps the rest of the app does not already do, each with a preview
   and logged (modLog, action 'sweep'):
     rooms      older than ROOM_DAYS, with nobody seen in the last day
     annStats   the stats of an announcement gone, or ended over STATS_DAYS ago

   Download backup: everything an admin can read that is not ephemeral, as
   one JSON file (never users/: admins cannot read it). Restore is by hand,
   in the Firebase console's Import JSON.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { logged } from './moderation.js';
import { BUILT_IN } from './announce.js';
import { APP_VERSION } from './version.js';

const DAY_MS = 86_400_000;
const ROOM_DAYS = 7;
const STATS_DAYS = 90;
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** The time a push id was made, from its first eight characters; null for any other key. */
export function pushTime(id) {
  if (typeof id !== 'string' || id.length !== 20 || id[0] !== '-') return null;
  let ms = 0;
  for (let i = 0; i < 8; i++) {
    const v = PUSH_CHARS.indexOf(id[i]);
    if (v < 0) return null;
    ms = ms * 64 + v;
  }
  return ms;
}

/** The oldest moment a node's keys say: the smallest 13-digit day key, or the oldest push id. */
export function oldestOf(keys) {
  let best = null;
  for (const k of keys || []) {
    const at = /^\d{13}$/.test(k) ? Number(k) : pushTime(k);
    if (at != null && (best == null || at < best)) best = at;
  }
  return best;
}

/** Every top-level node, what it is, and how it stays bounded. `backup`: in Download backup. */
const NODES = () => [
  { node: 'rooms', what: t('Race rooms and 1v1s'), kept: t('The last one out deletes a room; rooms left behind are swept here'), sweep: 'rooms' },
  { node: 'daily', what: t('Scramble of the Day'), kept: t('Results kept; each day’s chats cleared the next day by the first timer to open') },
  { node: 'users', what: t('Everybody’s synced solves and settings'), kept: t('Theirs: admins cannot read it, so it is not counted here') },
  { node: 'presence', what: t('Connections now'), kept: t('The server removes each as its connection drops') },
  { node: 'health', what: t('Heartbeats'), kept: t('14 days: the Health tab sweeps older days') },
  { node: 'errors', what: t('Error reports'), kept: t('14 days: the Health tab sweeps older days') },
  { node: 'turnDay', what: t('Relay logins'), kept: t('14 days: Moderate › Rooms sweeps older days') },
  { node: 'replayDay', what: t('Shared replays per day'), kept: t('Two days: the timers sweep older ones') },
  { node: 'reports', what: t('Reports'), kept: t('Open ones kept; closed ones 30 days, swept by Moderate'), backup: true },
  { node: 'modLog', what: t('Moderation log'), kept: t('Kept: never changed or deleted'), backup: true },
  { node: 'configLog', what: t('Settings log'), kept: t('Kept: a few hundred bytes a change'), backup: true },
  { node: 'config', what: t('Settings'), kept: t('One value a setting'), backup: true },
  { node: 'configMeta', what: t('Who changed each setting last'), kept: t('One a setting'), backup: true },
  { node: 'configScheduled', what: t('Scheduled changes'), kept: t('Until applied or cancelled'), backup: true },
  { node: 'announcements', what: t('Announcements'), kept: t('Kept'), backup: true },
  { node: 'annStats', what: t('Announcement stats'), kept: t('One per person per announcement; an ended one’s are swept here'), sweep: 'annStats', backup: true },
  { node: 'bans', what: t('Bans'), kept: t('Kept until cleared'), backup: true },
  { node: 'testers', what: t('Testers'), kept: t('Kept'), backup: true },
  { node: 'seen', what: t('Directory'), kept: t('One per signed-in person; removed with a deletion request'), backup: true },
  { node: 'support', what: t('Support requests'), kept: t('Kept until deleted'), backup: true },
  { node: 'deletion', what: t('Deletion requests'), kept: t('Kept, as the record that it was done'), backup: true },
  { node: 'errorsKnown', what: t('Errors marked known'), kept: t('Kept'), backup: true },
  { node: 'sotdFeatured', what: t('Featured events'), kept: t('One a day'), backup: true },
  { node: 'sotdFeaturedReplay', what: t('Featured replays'), kept: t('One a day'), backup: true },
];

/**
 * @param ctx  { S, scheduleRender, raw, ago, openSheet, closeSheet, rooms, moderation }
 */
export function createStorage(ctx) {
  const { S, raw, ago } = ctx;
  const D = { counts: {}, sizes: {}, oldest: {}, loading: false, loadedAt: 0, measuring: new Set(), backingUp: false };
  const sdk = () => S.sdk;
  const rest = (path, q = '') => ctx.rooms.rest(path, q);
  const now = () => Date.now() + (ctx.moderation.offset() || 0);

  /** Every node's count and oldest key: one shallow read each, in parallel. */
  async function load() {
    if (D.loading) return;
    D.loading = true;
    ctx.scheduleRender();
    await Promise.all(NODES().map(async ({ node }) => {
      try {
        const r = await rest(node, '&shallow=true');
        if (!r.ok) { D.counts[node] = null; return; }
        const keys = Object.keys((await r.json()) || {});
        D.counts[node] = keys.length;
        D.oldest[node] = oldestOf(keys);
      } catch { D.counts[node] = null; }
    }));
    D.loading = false;
    D.loadedAt = Date.now();
    ctx.scheduleRender();
  }

  /** One node read whole, for its size in bytes. */
  async function measure(node) {
    D.measuring.add(node);
    ctx.scheduleRender();
    try {
      const r = await rest(node);
      D.sizes[node] = r.ok ? new Blob([await r.text()]).size : null;
    } catch { D.sizes[node] = null; }
    D.measuring.delete(node);
    ctx.scheduleRender();
  }

  /* ---------------- sweeps ---------------- */

  /** Rooms made over ROOM_DAYS ago with nobody seen in the last day: [[id, room]]. */
  async function oldRooms() {
    const { get, query, ref, orderByChild, endAt, limitToFirst } = sdk();
    const cut = now() - ROOM_DAYS * DAY_MS;
    const s = await get(query(ref(sdk().db, 'rooms'), orderByChild('meta/createdAt'), endAt(cut), limitToFirst(500)));
    const quiet = now() - DAY_MS;
    // Never the 1v1 lobby (_1v1_333): it is the waiting seat, not a room.
    return Object.entries(s.val() || {}).filter(([id, room]) => !id.startsWith('_')
      && (room?.meta?.createdAt || 0) < cut && Object.values(room?.players || {}).every(p => (p?.lastSeen || 0) < quiet));
  }

  /** Announcements whose stats can go: gone (and not built in), or ended over STATS_DAYS ago: [id]. */
  async function oldStats() {
    const r = await rest('annStats', '&shallow=true');
    const ids = r.ok ? Object.keys((await r.json()) || {}) : [];
    const anns = (await sdk().get(sdk().ref(sdk().db, 'announcements'))).val() || {};
    const cut = now() - STATS_DAYS * DAY_MS;
    return ids.filter(id => !BUILT_IN[id] && (!anns[id] || (typeof anns[id].endAt === 'number' && anns[id].endAt > 0 && anns[id].endAt < cut)));
  }

  async function askSweep(kind) {
    let list;
    try { list = kind === 'rooms' ? (await oldRooms()).map(([id]) => id) : await oldStats(); }
    catch (err) {
      console.warn('[admin] sweep preview refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      return;
    }
    const what = kind === 'rooms'
      ? t('{n} rooms made over {d} days ago with nobody in them for a day', { n: list.length, d: ROOM_DAYS })
      : t('The stats of {n} announcements gone or ended over {d} days ago', { n: list.length, d: STATS_DAYS });
    const go = el('button', { class: 'ac-btn primary danger', text: t('Sweep {n}', { n: list.length }), disabled: !list.length });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const path = kind === 'rooms' ? 'rooms' : 'annStats';
      try {
        await logged(sdk(), Object.fromEntries(list.map(id => [`${path}/${id}`, null])), { action: 'sweep', path, note: what, before: list.slice(0, 200) });
        ctx.closeSheet();
        toast(t('Swept'), { kind: 'good' });
        load();
      } catch (err) {
        console.warn('[admin] sweep refused', err?.code || err);
        toast(t('Refused: this needs this version’s firebase.rules.json published'), { kind: 'bad', hold: true });
        go.disabled = false;
      }
    });
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: list.length ? t('Sweep these?') : t('Nothing to sweep') }),
      el('p', { class: 'ac-sub', text: what }),
      list.length ? raw('p', { class: 'ac-entry-meta' }, list.slice(0, 40).join(', ') + (list.length > 40 ? ' …' : '')) : null,
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }), go));
  }

  /* ---------------- the backup ---------------- */

  async function backup() {
    if (D.backingUp) return;
    D.backingUp = true;
    ctx.scheduleRender();
    const out = { tagda: 'backup', at: new Date().toISOString(), version: APP_VERSION, nodes: {}, refused: [] };
    for (const { node } of NODES().filter(n => n.backup)) {
      try {
        const r = await rest(node);
        if (!r.ok) { out.refused.push(node); continue; }
        const text = await r.text();
        D.sizes[node] = new Blob([text]).size;
        out.nodes[node] = JSON.parse(text);
      } catch { out.refused.push(node); }
    }
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `tagda-backup-${out.at.slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    D.backingUp = false;
    ctx.scheduleRender();
    toast(t('Backup saved: {size}', { size: kb(blob.size) }), { kind: 'good' });
  }

  /* ---------------- the view ---------------- */

  const kb = (b) => (b == null ? '—' : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

  function row(n) {
    const count = D.counts[n.node];
    const size = D.sizes[n.node];
    const old = D.oldest[n.node];
    return el('li', { class: 'ac-entry' },
      el('div', { class: 'ac-entry-main' },
        el('span', { class: 'ac-chat-head' }, raw('b', {}, n.what), raw('span', { class: 'ac-pill' }, n.node)),
        raw('span', { class: 'ac-reason' }, [
          count === undefined ? t('…') : count === null ? t('not readable here') : count === 1 ? t('1 record') : t('{n} records', { n: count }),
          size != null ? kb(size) : null,
          old ? t('oldest {when}', { when: ago(old) }) : null,
        ].filter(Boolean).join(' · ')),
        raw('span', { class: 'ac-entry-meta' }, n.kept)),
      el('div', { class: 'ac-entry-actions' },
        count != null ? el('button', { class: 'ac-btn small', text: D.measuring.has(n.node) ? t('Reading…') : t('Size'),
          disabled: D.measuring.has(n.node), onclick: () => measure(n.node) }) : null,
        n.sweep ? el('button', { class: 'ac-btn small', text: t('Sweep…'), onclick: () => askSweep(n.sweep) }) : null));
  }

  function view() {
    if (!D.loadedAt && !D.loading) load();
    const total = Object.values(D.sizes).reduce((a, b) => a + (b || 0), 0);
    return [
      el('section', { class: 'ac-block' },
        el('div', { class: 'ac-head-row' },
          el('h2', { class: 'ac-h2', text: t('Storage') }),
          el('button', { class: 'ac-btn small', type: 'button', text: 'Look again', onclick: load })),
        el('p', { class: 'ac-sub', text: 'The Spark plan stores 1 GB and downloads 10 GB a month. Counts are the database’s own and cost next to nothing; Size reads a node whole once, so it counts against the downloads.' }),
        total ? raw('p', { class: 'ac-entry-meta' }, t('Measured so far: {size}', { size: kb(total) })) : null,
        el('ol', { class: 'ac-log ac-tight' }, ...NODES().map(row))),
      el('section', { class: 'ac-block' },
        el('h2', { class: 'ac-h2', text: t('Backup') }),
        el('p', { class: 'ac-sub', text: 'Spark keeps no backups. This saves everything an admin can read that is not gone in a day or two: settings and both logs, announcements, bans, testers, reports, the directory, support and deletion requests. Not users/ (admins cannot read anybody’s synced data), rooms or the Scramble of the Day. To restore, import the node you need in the Firebase console.' }),
        el('button', { class: 'ac-btn', text: D.backingUp ? t('Reading…') : t('Download backup'), disabled: D.backingUp, onclick: backup })),
    ];
  }

  return { view, load };
}
