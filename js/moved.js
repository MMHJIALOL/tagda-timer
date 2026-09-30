import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — moving off *.vercel.app

   The site lives at tagdatimer.me now, but solves are IndexedDB, which the
   browser keeps per origin: someone who only ever used tagdatimer.vercel.app
   arrives at tagdatimer.me to an empty timer, and most people never signed in
   for sync to carry anything over. So the old address shows a banner whose
   button opens tagdatimer.me and hands it a full export, tab to tab.

   The handshake, in order:
     old tab   window.open(tagdatimer.me/?import-from=vercel), exportAll()
     new tab   → opener: { type: 'tagda-ready' }
     old tab   → new tab: { type: 'tagda-import', data }   (to tagdatimer.me only)
     new tab   importAll(merge), → opener: { type: 'tagda-imported', count }
   Each side checks who sent a message (event.source and event.origin) before
   believing it, and never posts to '*'. importAll merges by id, so tapping it
   twice changes nothing, and nothing on the old site is touched.
   =========================================================== */

import { el } from './util.js';
import { exportAll, importAll, KV } from './db.js';
import { toast } from './toast.js';
import { DEFAULTS } from './theme.js';

const TARGET = 'https://tagdatimer.me';
const VERCEL = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const DONE_KEY = 'tdt-moved';          // old site: this browser has moved its solves
const COUNT_KEY = 'tdt-moved-count';   // new site: toast after the reload that shows them
const WAIT_MS = 15000;

/* ---------- old site: the banner ---------- */

function banner() {
  const text = el('span');
  const close = el('button', { class: 't-act moved-x', text: '×', 'aria-label': t('Hide'), onclick: () => node.remove() });
  const node = el('div', { class: 'toast moved-banner', role: 'status' }, text, close);
  // First child of the toast stack is its bottom row, so real toasts rise above it.
  document.getElementById('toasts').prepend(node);

  const show = (msg, action) => {
    text.textContent = msg;
    node.querySelector('.t-act:not(.moved-x)')?.remove();
    if (action) close.before(action);
  };
  const button = (label) => el('button', { class: 't-act', text: label, onclick: move });
  const offer = () => show(t('Tagda Timer has moved to tagdatimer.me'), button(t('Move my solves')));
  const failed = () => show(t('Could not move your solves.'), button(t('Try again')));
  const moved = () => show('', el('a', { class: 't-act', href: TARGET + '/', text: t('Moved ✓ — open tagdatimer.me') }));

  /* All of this runs inside the click, so the popup is not blocked. */
  function move() {
    const w = window.open(TARGET + '/?import-from=vercel', '_blank');
    if (!w) return failed();
    show(t('Moving your solves…'));
    const data = exportAll();
    let timer;
    const stop = () => { clearTimeout(timer); removeEventListener('message', onMessage); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stop(); failed(); }, WAIT_MS); };
    async function onMessage(e) {
      if (e.source !== w || e.origin !== TARGET) return;
      if (e.data?.type === 'tagda-ready') {
        arm();   // the new tab is up; give the import itself the full wait
        try { w.postMessage({ type: 'tagda-import', data: await data }, TARGET); }
        catch { stop(); failed(); }
      } else if (e.data?.type === 'tagda-imported') {
        stop();
        try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private window: the banner just offers again */ }
        moved();
      }
    }
    addEventListener('message', onMessage);
    arm();
  }

  let done = false;
  try { done = !!localStorage.getItem(DONE_KEY); } catch { /* fine, offer it */ }
  done ? moved() : offer();
}

/* ---------- new site: receiving ---------- */

/** Whether this browser has changed anything from a fresh profile (loadSettings saves one at first boot). */
const customised = (s) => Object.keys(s || {})
  .some(k => k !== 'settingsVersion' && JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k]));

async function importMoved(data) {
  /* Settings come too, but only onto a tagdatimer.me nobody has set up yet:
     someone who already customised it here keeps what they chose. */
  if (data?.settings && typeof data.settings === 'object' && !customised(await KV.get('settings', {}))) {
    await KV.set('settings', data.settings);
  }
  return importAll(data, { merge: true });
}

function receive() {
  const url = new URL(location.href);
  url.searchParams.delete('import-from');
  history.replaceState(history.state, '', url);

  /* The opener's exact origin (preview URLs vary) comes from the referrer, so
     even 'ready' goes to one named origin rather than '*'. */
  const opener = window.opener;
  let from = '';
  try { from = new URL(document.referrer).origin; } catch { /* no referrer: nothing to answer */ }
  if (!opener || !VERCEL.test(from)) return;

  let busy = false;
  addEventListener('message', async (e) => {
    if (e.source !== opener || !VERCEL.test(e.origin) || e.data?.type !== 'tagda-import' || busy) return;
    busy = true;
    try {
      const count = await importMoved(e.data.data);
      opener.postMessage({ type: 'tagda-imported', count }, e.origin);
      try { sessionStorage.setItem(COUNT_KEY, String(count)); } catch { /* no toast, solves still there */ }
      location.reload();   // settings and the solve list both come back from IndexedDB
    } catch (err) {
      busy = false;
      toast(err.message, { kind: 'bad', hold: true });
    }
  });
  opener.postMessage({ type: 'tagda-ready' }, from);
}

function movedToast() {
  let n = null;
  try { n = sessionStorage.getItem(COUNT_KEY); sessionStorage.removeItem(COUNT_KEY); } catch { /* none */ }
  if (n !== null) toast(t('✓ {n} solves moved', { n }), { kind: 'good', hold: true });
}

if (new URLSearchParams(location.search).has('import-from')) receive();
else if (location.hostname.endsWith('.vercel.app')) banner();
movedToast();
