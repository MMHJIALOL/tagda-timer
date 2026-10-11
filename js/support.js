import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — asking the site for help, and asking it to forget you

   Two things in Data Health, both from a signed-in account, both the
   person's own choice (ADMIN.md §17):

     Send to support   support/<id>: what is typed, plus a snapshot of how
                       this device's data stands. The snapshot is shown in
                       full before it is sent: version, browser family and
                       system, what is waiting to sync (where and what kind of
                       change, never the values), how many solves, sessions
                       and Competition sets this device holds, the sets' ids
                       and states, and the sync status. Never a solve, a time
                       or a setting. One every ten minutes (supportLast/).
                       An admin's reply shows here and in the account menu.

     Delete my cloud data   deletion/<uid>: a request an admin carries out
                       (ADMIN.md §17). This device is signed out first so its
                       own copy stays.

   Admins cannot read anybody's synced data (users/<uid>); this is how
   somebody chooses to show them what they need to help.
   =========================================================== */

import { el, fmtDate } from './util.js';
import { toast, confirmToast } from './toast.js';
import { APP_VERSION } from './version.js';
import { family, osOf } from './health.js';

const TICKETS_KEY = 'tdt-support';   // [{ id, at, note }] sent from this device, newest first
const SEEN_KEY = 'tdt-support-seen'; // ids whose reply was shown
const KEEP = 10;
const QUEUE_MAX = 50, SETS_MAX = 20;

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this device forgets */ } };

let replies = new Map();   // id -> { note, at, reply: { text, at } }
export const unseenReplies = () => [...replies.entries()].filter(([id]) => !read(SEEN_KEY, []).includes(id));

async function signedIn() {
  const auth = await import('./sync-auth.js');
  const user = auth.currentUser();
  if (!user || user.isAnonymous) return null;
  return { user, sdk: await auth.getDatabaseHandle() };
}

/* ---------------- the snapshot ---------------- */

/** What a support request carries besides the note: no values, nothing typed but the note. */
export async function snapshot() {
  const [{ syncQueueEntries, syncHealth, getSyncStatus }, db] = await Promise.all([import('./sync.js'), import('./db.js')]);
  const now = Date.now();
  const queue = syncQueueEntries().slice(0, QUEUE_MAX).map(e => ({
    path: String(e.path).slice(0, 300), op: e.op,
    ...(typeof e.at === 'number' ? { ageMin: Math.max(0, Math.round((now - e.at) / 60_000)) } : {}),
  }));
  const sets = await db.CompetitionSets.all().catch(() => []);
  const sessions = await db.Sessions.all().catch(() => []);
  const solves = await db.Solves.count().catch(() => 0);
  const status = getSyncStatus();
  const h = syncHealth();
  const health = {
    local: db.getLocalStatus().state, cloud: status.state, pending: status.pending,
    dropped: h.dropped, online: navigator.onLine !== false,
    sw: navigator.serviceWorker?.controller ? 'on' : 'off',
  };
  if (status.lastSync) health.lastSync = status.lastSync;
  if (h.lastErr) health.lastErr = String(h.lastErr).slice(0, 200);
  return {
    ver: APP_VERSION, ua: family(), os: osOf(),
    queue,
    counts: {
      solves, sessions: sessions.length, competitionSets: sets.length,
      discardedSets: sets.filter(c => c.status === 'discarded').length,
    },
    competition: [...sets].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, SETS_MAX).map(c => ({
      id: String(c.id).slice(0, 64), status: String(c.status || '').slice(0, 16), event: String(c.event || '').slice(0, 24),
      size: c.size || 0, done: (c.solveIds || []).length, createdAt: c.createdAt || 0,
      ...(c.discardedAt ? { discardedAt: c.discardedAt } : {}),
    })),
    health,
  };
}

/** The snapshot as people read it, for the preview. */
function describe(s) {
  const oldest = s.queue.reduce((m, q) => Math.max(m, q.ageMin || 0), 0);
  return [
    t('Version {v} · {browser} · {os}', { v: s.ver, browser: s.ua, os: s.os }),
    s.queue.length ? t('{n} changes waiting to sync, the oldest {m} min', { n: s.queue.length, m: oldest }) : t('Nothing waiting to sync'),
    t('This device holds {solves} solves in {sessions} sessions, and {sets} Competition sets ({gone} discarded)',
      { solves: s.counts.solves, sessions: s.counts.sessions, sets: s.counts.competitionSets, gone: s.counts.discardedSets }),
    t('Sync: {cloud}, saving on this device: {local}', { cloud: s.health.cloud, local: s.health.local }),
  ];
}

/* ---------------- the dialog ---------------- */

let host = null;
function dialog(title, nodes) {
  host?.close(); host?.remove();
  host = el('dialog', { class: 'competition-dialog support-dialog', 'aria-label': title },
    el('header', {}, el('h2', { text: title }), el('button', { class: 'ghost-btn', text: 'Close', onclick: () => { host?.close(); host?.remove(); host = null; } })),
    ...nodes);
  host.addEventListener('cancel', () => { host?.remove(); host = null; });
  document.body.append(host);
  host.showModal();
  return host;
}

/** Data Health's Send to support: the note, the whole snapshot shown, then sent. */
export async function openSupport() {
  const who = await signedIn().catch(() => null);
  if (!who) {
    dialog(t('Send to support'), [el('p', { text: t('Sign in first: a request goes from your account, so the reply can come back to it.') })]);
    return;
  }
  const s = await snapshot();
  const note = el('textarea', { class: 'inp support-note', maxlength: 500, rows: 4, placeholder: t('What went wrong, and when?') });
  const send = el('button', { class: 'ghost-btn primary', text: 'Send' });
  send.addEventListener('click', async () => {
    const text = note.value.trim();
    if (!text) { note.focus(); toast(t('Say what went wrong first'), { kind: 'bad' }); return; }
    send.disabled = true;
    try {
      const { sdk, user } = who;
      const id = sdk.push(sdk.ref(sdk.db, 'support')).key;
      await sdk.update(sdk.ref(sdk.db), {
        [`support/${id}`]: { uid: user.uid, at: sdk.serverTimestamp(), note: text.slice(0, 500), ...(await snapshot()) },
        [`supportLast/${user.uid}`]: sdk.serverTimestamp(),
      });
      write(TICKETS_KEY, [{ id, at: Date.now(), note: text.slice(0, 120) }, ...read(TICKETS_KEY, [])].slice(0, KEEP));
      host?.close(); host?.remove(); host = null;
      toast(t('Sent. A reply will show in Data Health and in your account menu.'), { kind: 'good', long: true });
    } catch (err) {
      console.warn('[support] not sent', err?.code || err);
      toast(/permission/i.test(String(err?.code || err)) ? t('Not sent: one request every ten minutes, or support is not open yet') : t('Not sent — check your connection'), { kind: 'bad', long: true });
      send.disabled = false;
    }
  });
  dialog(t('Send to support'), [
    el('p', { text: t('Describe the problem. This is sent with it, so whoever answers can see how your data stands without seeing your data:') }),
    el('ul', { class: 'support-list' }, ...describe(s).map(line => el('li', { text: line }))),
    el('details', {}, el('summary', { text: t('Exactly what is sent') }), el('pre', { class: 'support-json', text: JSON.stringify(s, null, 2) })),
    el('p', { class: 'sub', text: t('Never your solves, times or settings. Only the site’s admins can read it.') }),
    note,
    el('div', { class: 'health-actions' }, send),
  ]);
  note.focus();
}

/** Look for replies to this device's requests (each one readable by its sender). */
export async function checkReplies() {
  const mine = read(TICKETS_KEY, []);
  if (!mine.length) return [];
  const who = await signedIn().catch(() => null);
  if (!who) return [];
  const { sdk } = who;
  const next = new Map();
  await Promise.all(mine.map(async (tk) => {
    try {
      const v = (await sdk.get(sdk.ref(sdk.db, `support/${tk.id}`))).val();
      if (v?.reply?.text) next.set(tk.id, { note: v.note, at: v.at, reply: v.reply });
    } catch { /* gone, or not this account's */ }
  }));
  replies = next;
  if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('tdt-support'));
  return [...replies.entries()];
}

/** Every reply, shown; the unseen ones are marked seen here and in the database. */
export async function showReplies() {
  const list = [...replies.entries()];
  const seen = new Set(read(SEEN_KEY, []));
  dialog(t('Replies from support'), list.length ? list.map(([id, r]) => el('section', { class: 'support-reply' },
    el('p', { class: 'sub', text: t('You wrote on {date}:', { date: fmtDate(r.at || Date.now()) }) }),
    el('blockquote', { text: r.note || '' }),
    el('p', { class: 'sub', text: t('Reply, {date}:', { date: fmtDate(r.reply.at || Date.now()) }) }),
    el('p', { class: 'support-reply-text', text: r.reply.text })))
    : [el('p', { text: t('No replies yet.') })]);
  const who = await signedIn().catch(() => null);
  for (const [id] of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (who) who.sdk.set(who.sdk.ref(who.sdk.db, `support/${id}/replySeen`), who.sdk.serverTimestamp()).catch(() => {});
  }
  write(SEEN_KEY, [...seen].slice(-50));
  if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('tdt-support'));
}

/** Data Health's section: send, read replies, and the deletion request. */
export function supportSection() {
  const status = el('p', { class: 'sub' });
  const paint = () => {
    const n = replies.size, u = unseenReplies().length;
    status.textContent = u ? t('{n} new replies from support', { n: u }) : n ? t('{n} replies from support', { n }) : '';
  };
  addEventListener('tdt-support', paint);
  checkReplies().then(paint, () => {});
  return el('div', {},
    el('p', { class: 'sub', text: t('Something wrong with your data? Send a request with a snapshot of how this device stands; you see all of it before it goes.') }),
    status,
    el('div', { class: 'health-actions' },
      el('button', { class: 'ghost-btn', text: 'Send to support…', onclick: () => openSupport() }),
      el('button', { class: 'ghost-btn', text: 'Replies', onclick: () => showReplies() }),
      el('button', { class: 'ghost-btn danger', text: 'Delete my cloud data…', onclick: () => requestDeletion() })));
}

/* ---------------- the deletion request ---------------- */

export async function requestDeletion() {
  const who = await signedIn().catch(() => null);
  if (!who) { toast(t('Sign in first: there is no cloud data without an account')); return; }
  const ok = await confirmToast(t('Ask for your cloud data to be deleted? An admin removes your synced solves, sessions and settings, your name in their directory, your health reports and your messages. This device is signed out first and keeps its copy; any other device still signed in loses its copy when it next syncs, so sign out there first to keep one.'),
    t('Ask for deletion'), { timeout: 30_000 });
  if (!ok) return;
  const { sdk, user } = who;
  const { KV } = await import('./db.js');
  const s = await KV.get('settings', {}).catch(() => ({}));
  try {
    await sdk.set(sdk.ref(sdk.db, `deletion/${user.uid}`), {
      at: sdk.serverTimestamp(), name: String(s?.raceName || user.displayName || '').slice(0, 32),
    });
  } catch (err) {
    console.warn('[support] deletion request refused', err?.code || err);
    toast(/permission/i.test(String(err?.code || err)) ? t('Already asked, or not open yet') : t('Not sent — check your connection'), { kind: 'bad', long: true });
    return;
  }
  const { signOutUser } = await import('./sync-auth.js');
  await signOutUser();
  toast(t('Asked. You are signed out here and this device keeps its solves.'), { kind: 'good', long: true });
}
