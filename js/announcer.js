/* ===========================================================
   Tagda Timer — the app's announcements, shown with manners

   What there is to announce comes from announce.js (the database's and the
   two built in); this decides when, and remembers what each browser said.

   The manners are the old hand-written cards', for every announcement now:
   - never during a solve or inspection: an announcement on screen steps aside
     the moment an attempt starts and comes back once it is over;
   - never over another popup, a panel, or the support card, and never in a
     hidden tab;
   - one at a time;
   - inside the Scramble of the Day window only a card about a button the
     window has (the camera), so nothing else interrupts the day's attempt;
   - an answer (the button, Not now, ×) is remembered in localStorage by id
     and version, so Show again on the admin page is a new version and asks
     again; a show is counted once per page load, against maxShows.

   Stats (annStats/, ADMIN.md) are written only for a browser that is
   signed in with Google, on the connection cloud sync already has.
   =========================================================== */

import { allAnnouncements, pick, memoryFor, inAudience } from './announce.js';
import { annNode } from './announce-ui.js';
import { getConfig, storedAnnouncements } from './config.js';

const MEM_KEY = 'tdt-ann';
const OPENED_KEY = 'tdt-opened';
const MIGRATED_KEY = 'tdt-ann-migrated';
/** Times one announcement may come back on one page load, after solves hid it. */
const PER_LOAD = 3;

let host = null;
let current = null;            // { a, as, node, place }
const appeared = new Map();    // id -> appearances this page load

const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: asked again next visit */ } };

/** Whether an announcement is on screen: modals and the support card wait for it. */
export const announcementShowing = () => !!current;
/** Whether it is a popup (a modal of its own). */
export const announcementModal = () => current?.as === 'popup';

/** The panel `id` (announce.js ANN_PANELS) has been opened: for the notOpened audience. */
export function markOpened(id) {
  const o = readJson(OPENED_KEY);
  if (o[id]) return;
  o[id] = Date.now();
  writeJson(OPENED_KEY, o);
}

function remember(a, patch) {
  const mem = readJson(MEM_KEY);
  const m = memoryFor(a, mem);
  mem[a.id] = { v: a.version, answer: m.answer, shows: m.shows, ...patch };
  writeJson(MEM_KEY, mem);
}

/** annStats/<id>/<version>/<uid>: signed in with Google only, one record each (the rules). */
async function stat(a, what) {
  if (!host.signedIn()) return;
  try {
    const sdk = await (await import('./sync-auth.js')).getDatabaseHandle();
    // Straight after a load the session is still being restored from storage.
    await sdk.auth.authStateReady?.();
    const uid = sdk.auth.currentUser?.uid;
    if (!uid) return;
    await sdk.set(sdk.ref(sdk.db, `annStats/${a.id}/${a.version}/${uid}`), what);
  } catch { /* refused: already recorded, or rules from before stats */ }
}

function hide() {
  if (!current) return;
  const { node } = current;
  current = null;
  removeEventListener('resize', place);
  if (node.tagName === 'DIALOG') { if (node.open) node.close(); }
  node.remove();
}

function answer(a, what) {
  remember(a, { answer: what });
  if (what !== 'later') stat(a, what === 'clicked' ? 'clicked' : 'dismissed');
  hide();
  if (what === 'later') setTimeout(tick, 600);
}

/** A card about a panel sits under that panel's button, with an arrow; otherwise in the corner. */
function place() {
  if (!current || current.as !== 'card') return;
  const { node, a } = current;
  const btn = a.button?.action === 'panel' ? host.anchor(a.button.target) : null;
  const r = btn?.getBoundingClientRect();
  if (!r?.width) {
    if (host.inSotd()) { hide(); return; }
    node.classList.remove('an-anchored');
    node.classList.add('an-corner');
    node.style.left = node.style.top = '';
    return;
  }
  node.classList.add('an-anchored');
  node.classList.remove('an-corner');
  const w = node.offsetWidth;
  const left = Math.max(10, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 10));
  node.style.left = `${left}px`;
  node.style.top = `${r.bottom + 12}px`;
  node.style.setProperty('--arrow', `${r.left + r.width / 2 - left}px`);
}

function show(a, as) {
  const on = {
    go: () => {
      if (a.button?.action === 'link') window.open(a.button.target, '_blank', 'noopener');
      else if (a.button?.action === 'panel') host.open(a.button.target);
      answer(a, 'clicked');
    },
    close: () => answer(a, 'dismissed'),
    later: () => answer(a, 'later'),
  };
  const node = annNode(a, as, on);
  // Its buttons take Space and Enter themselves; the timer behind does not get them.
  node.addEventListener('keydown', (e) => e.stopPropagation());
  if (as === 'pill') {
    const zone = document.getElementById('timer-zone');
    if (!zone) return;
    zone.append(node);
  } else {
    document.body.append(node);
  }
  current = { a, as, node };
  if (as === 'popup') {
    // Escape is an answer too: Maybe later where there is a reminder, Not now otherwise.
    node.addEventListener('cancel', (e) => { e.preventDefault(); (a.reminder ? on.later : on.close)(); });
    node.addEventListener('click', (e) => { if (e.target === node) (a.reminder ? on.later : on.close)(); });
    node.showModal();
    node.querySelector('.an-dlg-card')?.focus();
  }
  if (as === 'card') { place(); addEventListener('resize', place); }
  if (!current) return;            // a card with nowhere to go in the SOTD window
  const n = appeared.get(a.id) || 0;
  appeared.set(a.id, n + 1);
  if (!n) {
    const shows = memoryFor(a, readJson(MEM_KEY)).shows;
    remember(a, { shows: shows + 1 });
    if (!shows) stat(a, 'shown');
  }
}

function who() {
  return { signedIn: host.signedIn(), webcamOn: host.webcamOn(), solves: host.solves(), opened: new Set(Object.keys(readJson(OPENED_KEY))) };
}

/** Look for something to show, if nothing is going on. */
function tick() {
  if (!host || current) return;
  if (document.hidden || !host.idle() || host.blocked()) return;
  const anns = allAnnouncements(storedAnnouncements(), getConfig);
  // Only what may appear here, and not past this load's share of appearances.
  const sotd = host.inSotd();
  for (const [id, a] of Object.entries(anns)) {
    const here = !sotd || (a.style === 'card' && a.button?.action === 'panel' && host.anchor(a.button.target));
    // A button to a panel this browser cannot use (a camera where nothing can record) is no announcement at all.
    const usable = a.button?.action !== 'panel' || host.available(a.button.target);
    if (!here || !usable || (appeared.get(id) || 0) >= PER_LOAD) delete anns[id];
  }
  const got = pick(anns, readJson(MEM_KEY), who());
  if (got) show(got.a, got.as);
}

/**
 * Something about the viewer changed (the camera turned on, a sign-in): an
 * announcement on screen whose audience they have left counts as done.
 */
export function reconsider() {
  if (!current) { setTimeout(tick, 1000); return; }
  if (!inAudience(current.a, who())) answer(current.a, 'clicked');
}

/** The old hand-written cards' "seen" flags, so nobody who answered them is asked again. Once. */
async function migrate() {
  try { if (localStorage.getItem(MIGRATED_KEY)) return; } catch { return; }
  const mem = readJson(MEM_KEY);
  try {
    if (await host.kvGet('replayNewsSeen') || await host.kvGet('sotdCameraNewsSeen')) mem['webcam-replay'] = { v: 1, answer: 'dismissed', shows: 1 };
  } catch { /* unreadable: they may see it once more */ }
  try {
    if (localStorage.getItem('tagda.fb.popup.feedback-2') === '1') {
      mem.feedback = { v: 1, answer: localStorage.getItem('tagda.fb.pill.feedback-2') === '1' ? 'dismissed' : 'later', shows: 1 };
    }
  } catch { /* the same */ }
  writeJson(MEM_KEY, mem);
  try { localStorage.setItem(MIGRATED_KEY, '1'); } catch { /* checked above */ }
}

/**
 * @param h  { idle(), blocked(), inSotd(), open(panel), anchor(panel) -> element|null, available(panel),
 *             signedIn(), webcamOn(), solves(), kvGet(key), onTimerState(fn(idle)) }
 */
export async function startAnnouncements(h) {
  host = h;
  await migrate();
  // An attempt starting puts it away; the end of one is a gap to look again.
  h.onTimerState((idle) => { if (!idle) hide(); else setTimeout(tick, 1500); });
  addEventListener('tdt-config', () => setTimeout(tick, 500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(tick, 1500); });
  setTimeout(tick, 2500);
  setInterval(tick, 4000);
}

/** The SOTD window opened or closed: what is on screen may no longer belong. */
export function placeChanged() {
  if (!current) { setTimeout(tick, 1200); return; }
  if (host.inSotd() && current.as !== 'card') { hide(); return; }
  if (current.as !== 'card') return;
  /* The window's bar slides in, so its camera is not where it will be yet:
     out of sight until it has settled, then placed (as the old card waited). */
  const { node } = current;
  node.style.visibility = 'hidden';
  setTimeout(() => {
    if (current?.node !== node) return;
    place();
    node.style.visibility = '';
  }, 1200);
}

