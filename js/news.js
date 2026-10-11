import { t, lang } from './i18n.js';
/* ===========================================================
   Tagda Timer — What's new (ADMIN.md §21)

   changelog/<id> = { at, ver?, title, text?, es?: { title, text }, by }
   written from the admin console (Announce › What's new), public to read.
   A permanent history, unlike an announcement: the newest NEWS_SHOWN are
   read once a page load, once idle (one small public REST read, no
   connection), and shown at the top of About. The About button carries a
   dot while one is newer than this device last looked (SEEN_KEY).
   =========================================================== */

import { el, fmtDate } from './util.js';

const NEWS_SHOWN = 20;
const SEEN_KEY = 'tdt-news-seen';     // the newest entry's `at` this device has seen
let list = null;                      // [{ id, at, ver, title, text }] newest first, in this language

const seenAt = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };

/** The entries, newest first, each in this page's language (English where Spanish is missing). */
export function newsList() { return list || []; }

/** How many are newer than this device last looked. */
export const newsUnread = () => newsList().filter(n => n.at > seenAt()).length;

/** Read the newest entries (once a page load unless `force`). Never throws: none is none. */
export async function loadNews({ force = false } = {}) {
  if (list && !force) return list;
  try {
    const [{ FIREBASE_CONFIG }, { EMULATED }] = await Promise.all([import('./raceapp.js'), import('./sync-auth.js')]);
    const base = EMULATED ? 'http://127.0.0.1:9000' : FIREBASE_CONFIG.databaseURL;
    const q = `?orderBy=${encodeURIComponent('"$key"')}&limitToLast=${NEWS_SHOWN}${EMULATED ? '&ns=tagda-timer-default-rtdb' : ''}`;
    const r = await fetch(`${base}/changelog.json${q}`, { cache: 'no-store' });
    const data = r.ok ? (await r.json()) || {} : {};
    list = Object.entries(data).map(([id, n]) => {
      const es = lang === 'es' && n?.es ? n.es : null;
      return { id, at: Number(n?.at) || 0, ver: Number(n?.ver) || 0,
        title: String(es?.title || n?.title || ''), text: String(es?.text || n?.text || '') };
    }).filter(n => n.title).sort((a, b) => b.at - a.at);
  } catch {
    list = list || [];
  }
  paintDot();
  return list;
}

/** Everything shown is seen: the dot goes. */
export function markNewsSeen() {
  const top = newsList()[0]?.at || 0;
  if (top > seenAt()) { try { localStorage.setItem(SEEN_KEY, String(top)); } catch { /* the dot comes back */ } }
  paintDot();
}

/** The dot on the About button (and its row in a phone's menu reads newsUnread). */
function paintDot() {
  const btn = document.getElementById('btn-about');
  if (!btn) return;
  const n = newsUnread();
  btn.classList.toggle('has-news', n > 0);
  btn.title = n ? t('About · {n} new', { n }) : t('About  (B)');
}

/** Once the page is idle: read them, so the dot can show. */
export function startNews() {
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 4000));
  idle(() => { loadNews(); }, { timeout: 20_000 });
}

/** About's What's new: the entries, new ones marked, then marked seen. Empty: nothing at all. */
export function newsSection() {
  const box = el('div', { class: 'news-list' });
  loadNews().then((items) => {
    if (!items.length) { box.closest('.group')?.remove(); return; }
    const seen = seenAt();
    box.replaceChildren(...items.slice(0, 8).map(n => el('article', { class: `news-item${n.at > seen ? ' is-new' : ''}` },
      el('div', { class: 'news-head' },
        el('b', { class: 'news-title', text: n.title }),
        n.at > seen ? el('span', { class: 'news-new', text: t('new') }) : null),
      el('div', { class: 'news-meta', text: [fmtDate(n.at), n.ver ? t('version {v}', { v: n.ver }) : null].filter(Boolean).join(' · ') }),
      n.text ? el('p', { class: 'news-text', text: n.text }) : null)));
    markNewsSeen();
  });
  return box;
}
