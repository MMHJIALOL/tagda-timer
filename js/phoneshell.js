import { t, lang } from './i18n.js';
/* ===========================================================
   Tagda Timer — the phone shell

   On a phone (js/phone.js) the timer gets a layout of its own: a floating
   dock with four tabs (Timer, Times, Train, More) in place of the top bar's
   row of icons and its hamburger, one context pill for the event and the
   session, a flat net of the scramble instead of the floating 3D preview, a
   strip of recent times above the dock, and bottom sheets where the desktop
   has popovers (the event and session pickers, the solve menu).

   It is all built on the existing page rather than beside it. The timer, the
   scramble, the history list and every drawer are the same elements and the
   same code; this module adds the few pieces a phone needs, and css/phone.css
   (linked with the same media query) lays the page out. Below 641px wide only
   — tablets and desktops never build any of it.

   main.js hands over what it owns (the app object and a handful of its
   functions) and calls render() whenever the session changes.
   =========================================================== */

import { $, $$, el, fmt, fmtResult } from './util.js';
import { isPhone, onPhoneChange } from './phone.js';
import { openSheet, sheetRows, closeAllSheets } from './sheet.js';
import { EVENTS, EVENT_ORDER, eventOf, modeOf, modesForEvent } from './events.js';
import { eff, DNF, isMoveResult, averageOfRange, summarize, bestMean } from './stats.js';
import { CubeView } from './cube.js';
import { renderDotTrend } from './charts.js';
import { setFor } from './scramble.js';
import { loadStates, GRADUATED_BOX } from './learn.js';
import { nextResetMs, formatCountdown, sotdDoneOn, dayIdFromServerMs } from './dayid.js';
import { PRESETS } from './theme.js';

const I = {
  cube: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  chevR: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  timer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V10M9.5 3h5M18.2 6.8l1.3-1.3"/></svg>',
  times: '<svg viewBox="0 0 24 24"><path d="M5 20V11M11 20V5M17 20v-7M3 20h18"/></svg>',
  train: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle class="fill" cx="5.5" cy="12" r="1.5"/><circle class="fill" cx="12" cy="12" r="1.5"/><circle class="fill" cx="18.5" cy="12" r="1.5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4.5L19 9.5 14.5 5 4 15.5z"/><path d="M13 6.5l4.5 4.5"/></svg>',
  recon: '<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 13v5.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V13"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-1a5 5 0 015-5h11M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 01-5 5H4"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 102.4-5.7"/><path d="M3.5 4v4.5H8"/></svg>',
  doctor: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M11 8v6M8 11h6"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/></svg>',
  xp1: '<svg viewBox="0 0 24 24"><path d="M9.5 3.5h5v5h5v5h-5v5h-5v-5h-5v-5h5z"/><rect x="15.5" y="15.5" width="5.5" height="5.5" rx="1.2"/></svg>',
  trophy: '<svg viewBox="0 0 24 24"><path d="M7 4h10v4a5 5 0 01-10 0z" fill="currentColor" stroke="none"/><path d="M7 5H4.5a2.5 2.5 0 002.5 4.5M17 5h2.5a2.5 2.5 0 01-2.5 4.5"/><path d="M12 13v4M9 21h6M10 17h4v2a2 2 0 01-2 2 2 2 0 01-2-2z"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5.2 21V3.4"/><path d="M5.2 4.1h13l-2.5 3.9 2.5 3.9h-13z"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4.6A1.6 1.6 0 016.6 3H19v14.4H6.6A1.6 1.6 0 005 19z"/><path d="M5 19a1.6 1.6 0 001.6 1.6H19v-3.2"/><path d="M8.6 7.4h6.8M8.6 10.8h4.6"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5a4.5 4.5 0 01-.6-8.96A6 6 0 0118 9.5a4.5 4.5 0 01-.5 9z"/></svg>',
  account: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.4"/><path d="M4.8 20a7.2 7.2 0 0114.4 0"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.2v2.6M12 19.2v2.6M2.2 12h2.6M19.2 12h2.6M5.05 5.05l1.85 1.85M17.1 17.1l1.85 1.85M18.95 5.05L17.1 6.9M6.9 17.1l-1.85 1.85"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14.5h9"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.6 1.6 0 00.32 1.77l.06.06a1.94 1.94 0 11-2.75 2.75l-.06-.06a1.6 1.6 0 00-1.77-.32 1.6 1.6 0 00-.97 1.47v.16a1.94 1.94 0 01-3.88 0v-.09a1.6 1.6 0 00-1.05-1.47 1.6 1.6 0 00-1.77.32l-.06.06a1.94 1.94 0 11-2.75-2.75l.06-.06a1.6 1.6 0 00.32-1.77 1.6 1.6 0 00-1.47-.97H3.4a1.94 1.94 0 010-3.88h.09a1.6 1.6 0 001.47-1.05 1.6 1.6 0 00-.32-1.77l-.06-.06a1.94 1.94 0 112.75-2.75l.06.06a1.6 1.6 0 001.77.32h.08a1.6 1.6 0 00.97-1.47V3.4a1.94 1.94 0 013.88 0v.09a1.6 1.6 0 00.97 1.47 1.6 1.6 0 001.77-.32l.06-.06a1.94 1.94 0 112.75 2.75l-.06.06a1.6 1.6 0 00-.32 1.77v.08a1.6 1.6 0 001.47.97h.16a1.94 1.94 0 010 3.88h-.09a1.6 1.6 0 00-1.47.97z"/></svg>',
  spotify: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2"/><path d="M7 9.1c3.3-1 7.2-.7 10.2.9"/><path d="M7.7 12.3c2.7-.8 5.9-.5 8.4.8"/><path d="M8.3 15.4c2.2-.6 4.6-.4 6.5.6"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.1"/></svg>',
};

/** Just the icon, with its label for assistive tech and a tooltip. */
const iconBtn = (cls, label, icon, onclick) =>
  el('button', { class: cls, type: 'button', 'aria-label': label, title: label, html: icon, onclick });

/** An icon and a word; the word set as text, never parsed as markup. */
function wordBtn(cls, icon, word, onclick) {
  const b = el('button', { class: cls, type: 'button', html: `${icon}<span></span>`, onclick });
  b.querySelector('span').textContent = word;
  return b;
}

let A = null;      // the app object
let X = null;      // what main.js lends us
let built = false;
const ui = {};
let tab = 'timer';

/* =========================================================
   Setting up
   ========================================================= */

export function initPhoneShell(app, api) {
  A = app;
  X = api;
  mirrorPreview();
  const apply = () => {
    const on = isPhone();
    document.body.classList.toggle('ph', on);
    if (on) build();
    if (!on) { closeAllSheets(); setTab('timer'); }
    syncThumbView();
    if (on) render();
  };
  apply();
  onPhoneChange(apply);
  return {
    render,
    openSolveSheet,
    setTab,
    tab: () => tab,
    on: () => isPhone() && built,
  };
}

function build() {
  if (built) return;
  built = true;

  /* ---- the context pill: event · session ---- */
  ui.ctxEvent = el('span', { class: 'ph-ctx-ev' });
  ui.ctxSession = el('span', { class: 'ph-ctx-ses' });
  ui.ctx = el('button', { id: 'ph-context', class: 'ph-ctx', type: 'button', onclick: openEventSheet },
    el('span', { class: 'ph-ctx-ico', html: I.cube, 'aria-hidden': 'true' }),
    ui.ctxEvent, el('span', { class: 'ph-dot', 'aria-hidden': 'true' }), ui.ctxSession,
    el('span', { class: 'ph-ctx-chev', html: I.chev, 'aria-hidden': 'true' }));
  $('#topbar').prepend(ui.ctx);
  // The Scramble of the Day pill says "Daily" here; syncSotdChip() still owns it.
  $('#btn-daily')?.append(el('span', { class: 'ph-only ph-daily-lbl', text: t('Daily') }));

  /* The digits are set as large as the screen allows for a short time, and a
     time with a minute in it (seven characters) gets the size that fits. CSS
     cannot count characters, so the count is handed to it. */
  const digits = $('#time-main');
  const display = $('#timer-display');
  const count = () => {
    const n = digits.textContent.trim().length;
    if (display.style.getPropertyValue('--ph-chars') !== String(n)) display.style.setProperty('--ph-chars', String(n));
  };
  new MutationObserver(count).observe(digits, { childList: true, characterData: true, subtree: true });
  count();

  /* ---- the scramble card: a flat net of the scramble, which opens the 3D cube ---- */
  ui.thumbHost = el('div', { class: 'ph-net-host', 'aria-hidden': 'true' });
  ui.thumbBtn = el('button', {
    id: 'ph-net', class: 'ph-net', type: 'button', 'aria-label': t('Open the scrambled cube in 3D'),
    onclick: openCubeSheet,
  }, ui.thumbHost);
  $('#scramble-wrap').append(ui.thumbBtn);
  for (const [id, label] of [['#btn-prev-scramble', t('Previous scramble')], ['#btn-next-scramble', t('Next scramble')],
    ['#btn-copy-scramble', t('Copy scramble')], ['#btn-custom-scramble', t('Use your own scrambles')]]) {
    $(id)?.setAttribute('aria-label', label);
  }
  ui.thumb = new CubeView(ui.thumbHost, null);
  ui.thumb.backView = 'none';
  ui.thumb.init().then(() => { replayPreview(ui.thumb, '2D'); ui.thumb.setHints(false); });

  /* ---- under the digits: the best badges, and the post-solve pills ---- */
  for (const k of ['ao5', 'ao12']) {
    const label = $(`#live-${k}`)?.previousElementSibling;
    if (label) label.append(ui[`badge${k}`] = el('span', { class: 'ph-best', text: t('best'), hidden: true }));
  }
  const row = $('#last-actions');
  ui.noteBtn = wordBtn('ghost-btn sm ph-only ph-pill', I.pencil, t('Note'), () => lastAct('note'));
  ui.replayBtn = wordBtn('ghost-btn sm ph-only ph-pill', I.play, t('Replay'), () => lastAct('replay'));
  ui.reconBtn = wordBtn('ghost-btn sm ph-only ph-pill', I.recon, t('Reconstruct'), () => lastAct('recon'));
  ui.replayBtn.hidden = true;
  row.append(ui.noteBtn, ui.replayBtn, ui.reconBtn);
  for (const b of row.querySelectorAll('[data-act="+2"], [data-act="DNF"]')) b.classList.add('ph-pill');
  /* The webcam Replay pill is replay.js's; this one only mirrors whether it is
     there, and presses it. Nothing about the replay itself changes here. */
  const pill = $('#last-replay');
  if (pill) {
    const sync = () => { ui.replayBtn.hidden = pill.hidden; ui.noteBtn.hidden = !pill.hidden; };
    new MutationObserver(sync).observe(pill, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }

  /* ---- inspection: the words around the countdown ---- */
  const readout = $('#inspect-readout');
  ui.inspLeft = el('div', { class: 'ph-insp-left ph-only', text: t('seconds left') });
  ui.inspRule = el('div', { class: 'ph-insp-rule ph-only', text: t('+2 after 15 · DNF after 17') });
  ui.inspFoot = el('div', { class: 'ph-insp-foot ph-only' },
    el('div', { class: 'ph-insp-hold', text: t('Hold to arm, release to start') }),
    el('div', { class: 'ph-insp-gone', text: t('Everything else is gone until you stop') }));
  $('#inspect-num').after(ui.inspLeft, ui.inspRule);
  readout.append(ui.inspFoot);
  const cancel = $('#inspect-cancel');
  cancel.setAttribute('aria-label', t('Cancel inspection'));
  cancel.append(el('span', { class: 'ph-only ph-x', html: I.close, 'aria-hidden': 'true' }));
  // A penalty takes the number's place; "seconds left" then says nothing true.
  const num = $('#inspect-num');
  new MutationObserver(() => readout.classList.toggle('ph-pen', !/^\d+$/.test(num.textContent.trim())))
    .observe(num, { childList: true, characterData: true, subtree: true });

  /* ---- the recent strip, above the dock ---- */
  ui.allBtn = el('button', { class: 'ph-all', type: 'button', onclick: () => setTab('times') });
  ui.chips = el('div', { class: 'ph-chips' });
  ui.recent = el('section', { id: 'ph-recent', class: 'ph-recent', 'aria-label': t('Recent solves') },
    el('div', { class: 'ph-recent-head' }, el('span', { class: 'ph-lbl', text: t('Recent') }), ui.allBtn),
    ui.chips);
  $('#stage').after(ui.recent);

  /* ---- the dock ---- */
  const tabBtn = (id, icon, label) => el('button', {
    class: 'ph-tab', type: 'button', dataset: { tab: id }, onclick: () => setTab(id),
  }, el('span', { class: 'ph-tab-ico', html: icon, 'aria-hidden': 'true' }), el('span', { class: 'ph-tab-lbl', text: label }));
  ui.dock = el('nav', { id: 'ph-dock', class: 'ph-dock', 'aria-label': t('Main') },
    tabBtn('timer', I.timer, t('Timer')), tabBtn('times', I.times, t('Times')),
    tabBtn('train', I.train, t('Train')), tabBtn('more', I.more, t('More')));
  document.body.append(ui.dock);

  /* ---- the other three tabs ---- */
  ui.screens = {};
  for (const id of ['times', 'train', 'more']) {
    ui.screens[id] = el('section', { id: `ph-${id}`, class: 'ph-screen', 'aria-label': t(id[0].toUpperCase() + id.slice(1)), hidden: true });
    $('#app').append(ui.screens[id]);
  }
  buildTimes();
  buildTrain();
  buildMore();

  setTab(tab);

  /* Scramble of the Day is the timer and nothing else, however it was opened
     (the Daily pill, the Train tab, a link). */
  new MutationObserver(() => {
    if (document.body.classList.contains('sotd') && tab !== 'timer') setTab('timer');
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/* =========================================================
   The scramble preview, mirrored

   The 3D preview (main.js's CubeView) is told about every scramble, puzzle
   and orientation change. The phone's flat net and the cube sheet are told
   the same things by wrapping those three calls, so nothing in main.js has to
   know they exist, and a relay leg, a trainer case or a held race all draw
   exactly as they do in the big preview.
   ========================================================= */

const last = { configure: null, setOrientation: null, set: null };

function mirrorPreview() {
  const c = X.cube;
  for (const fn of ['configure', 'setOrientation', 'set']) {
    const orig = c[fn].bind(c);
    c[fn] = (...args) => {
      const r = orig(...args);
      last[fn] = args;
      for (const [view, want] of [[ui.thumb, '2D'], [ui.sheetCube, ui.sheetView || '3D']]) {
        if (view?.ready) forward(view, fn, args, want);
      }
      return r;
    };
  }
}

function forward(view, fn, args, want) {
  if (fn === 'configure') view.configure(args[0], want);
  else if (fn === 'setOrientation') view.setOrientation(args[0]);
  else view.set(args[0], { ...(args[1] || {}), view: want });
}

/** Bring a view that has just been made up to date with the big preview. */
function replayPreview(view, want) {
  if (last.configure) forward(view, 'configure', last.configure, want);
  if (last.setOrientation) forward(view, 'setOrientation', last.setOrientation, want);
  if (last.set) forward(view, 'set', last.set, want);
}

function syncThumbView() {
  if (ui.thumb?.ready) ui.thumb.setView('2D');
}

/** The 3D cube, from the net: drag to spin it, flat or 3D, back to the start. */
function openCubeSheet() {
  const host = el('div', { class: 'ph-cube3d' });
  ui.sheetView = '3D';
  const viewBtn = el('button', {
    class: 'ph-seg-btn', type: 'button', text: '2D', 'aria-pressed': 'false',
    onclick: () => {
      ui.sheetView = ui.sheetView === '3D' ? '2D' : '3D';
      ui.sheetCube?.setView(ui.sheetView);
      viewBtn.setAttribute('aria-pressed', String(ui.sheetView === '2D'));
      viewBtn.classList.toggle('on', ui.sheetView === '2D');
    },
  });
  const sheet = openSheet({
    title: t('Scrambled cube'), done: true, className: 'ph-cube-sheet',
    content: [
      host,
      el('p', { class: 'ph-note', text: t('Drag the cube to look round it.') }),
      el('div', { class: 'ph-cube-tools' }, viewBtn,
        wordBtn('ph-seg-btn', I.reset, t('Reset the view'), () => ui.sheetCube?.clearOrbit())),
    ],
    onClose: () => { ui.sheetCube?.player?.remove(); ui.sheetCube = null; },
  });
  ui.sheetCube = new CubeView(host, null);
  ui.sheetCube.init().then((ok) => {
    if (!ok || !ui.sheetCube) return;
    replayPreview(ui.sheetCube, '3D');
    ui.sheetCube.setHints(!!A.settings.hintFacelets);
  });
  return sheet;
}

/* =========================================================
   Tabs
   ========================================================= */

export function setTab(next) {
  // Scramble of the Day is the timer and nothing else.
  if (document.body.classList.contains('sotd')) next = 'timer';
  tab = next;
  if (!built) return;
  document.body.dataset.tab = next;
  for (const b of ui.dock.children) {
    const on = b.dataset.tab === next;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const [id, node] of Object.entries(ui.screens)) node.hidden = id !== next;
  if (next !== 'timer') { ui.screens[next].scrollTop = 0; renderTab(next); }
  if (next === 'times') {
    ui.placeTimes?.();
    /* Hidden behind the timer, the list measured itself as no width at all and
       dropped its average columns; now it can be seen, it measures again. */
    X.remeasureHistory();
  }
}

/* =========================================================
   Painting
   ========================================================= */

const fmtSolve = (s) => fmtResult(eff(s), isMoveResult(s));

export function render() {
  if (!built || !isPhone()) return;
  const ev = eventOf(A.settings.event);
  ui.ctxEvent.textContent = ev.short;
  ui.ctxSession.textContent = A.session?.name || '';
  ui.ctx.setAttribute('aria-label', t('Event and session: {event}, {session}', { event: ev.short, session: A.session?.name || '' }));

  const solves = A.solves || [];
  const st = summarize(solves);
  const best5 = st.ao5 != null && st.bestAo5 != null && isFinite(st.ao5) && st.ao5 === st.bestAo5 && solves.length > 5;
  const best12 = st.ao12 != null && st.bestAo12 != null && isFinite(st.ao12) && st.ao12 === st.bestAo12 && solves.length > 12;
  if (ui.badgeao5) { ui.badgeao5.hidden = !best5; $('#live-ao5').classList.toggle('ph-is-best', best5); }
  if (ui.badgeao12) { ui.badgeao12.hidden = !best12; $('#live-ao12').classList.toggle('ph-is-best', best12); }

  // The recent strip: newest first, the newest outlined, the best in teal, DNFs in red.
  ui.allBtn.textContent = t('All {n}', { n: solves.length });
  ui.allBtn.hidden = !solves.length;
  ui.recent.classList.toggle('empty', !solves.length);
  const bestV = st.best;
  const recent = solves.slice(-8).reverse();
  ui.chips.replaceChildren(...recent.map((s, i) => {
    const v = eff(s);
    const n = solves.indexOf(s) + 1;
    const label = fmtSolve(s) + (s.penalty === '+2' && !isMoveResult(s) ? '+' : '');
    return el('button', {
      class: 'ph-chip' + (i === 0 ? ' latest' : '') + (v === DNF ? ' dnf' : (bestV != null && v === bestV ? ' best' : '')),
      type: 'button', text: label,
      'aria-label': t('Solve {n}, {time}', { n, time: label }),
      onclick: () => openSolveSheet(s),
    });
  }));
  if (!solves.length) ui.chips.append(el('span', { class: 'ph-chips-empty', text: t('Your times will line up here.') }));

  if (tab !== 'timer') renderTab(tab);
}

/** The last-solve pills that are the phone's own. */
function lastAct(act) {
  const s = X.shownSolve();
  if (!s || !X.timerIdle()) return;
  if (act === 'note') openSolveSheet(s, { focusNote: true });
  else if (act === 'recon') X.reconstructSolve(s);
  else if (act === 'replay') $('#last-replay')?.click();
}

/* =========================================================
   The event and session sheet
   ========================================================= */

function openEventSheet() {
  let sheet = null;
  const content = () => {
    const evGrid = el('div', { class: 'ph-ev-grid', role: 'group', 'aria-label': t('Event') },
      ...EVENT_ORDER.map((id) => {
        const on = id === A.settings.event;
        return el('button', {
          class: 'ph-ev' + (on ? ' on' : ''), type: 'button', text: EVENTS[id].short,
          'aria-pressed': String(on), 'aria-label': EVENTS[id].name,
          onclick: async () => {
            if (EVENTS[id].relay) { sheet.close(); X.openRelayBuilder(); return; }
            await X.setEvent(id);
            refresh();
          },
        });
      }));
    const mode = modeOf(A.settings.mode);
    const settingsRows = sheetRows([
      { label: t('Scrambles'), value: mode.name, chevron: true, keep: true, onSelect: openModeSheet },
      // The top bar's label reads "Cube" until one is marked active; here that is "None".
      { label: t('Cube'), value: A.gear?.activeId ? ($('#gear-label')?.textContent || '') : t('None'), chevron: true,
        onSelect: () => X.openPanel('Gear', 'buildGear', { wide: true }) },
    ], () => sheet);
    const counts = A.sessionCounts || new Map();
    const sessions = sheetRows([
      ...A.sessions.map((s) => {
        const on = s.id === A.session.id;
        const n = on ? A.solves.length : (counts.get(s.id) || 0);
        const ao = on ? { ao12: summarize(A.solves).ao12, moves: A.solves.some(isMoveResult) } : otherAo12(s.id, n, refresh);
        const sub = t(n === 1 ? '{n} solve' : '{n} solves', { n })
          + (ao?.ao12 != null ? ` · ao12 ${fmtResult(ao.ao12, ao.moves)}` : '');
        return { label: s.name, sub, check: on, keep: true,
          onSelect: async () => { if (!on) { await A.switchSession(s.id); refresh(); } } };
      }),
      { label: t('New session'), accent: true, keep: true, onSelect: async () => { await A.newSession(); refresh(); } },
      { label: t('Manage sessions'), chevron: true, onSelect: () => X.openPanel('Sessions', 'buildSessions') },
    ], () => sheet);
    return [evGrid, settingsRows, el('h3', { class: 'sheet-label', text: t('Sessions') }), sessions];
  };
  const refresh = () => { if (sheet && !sheet.closed) sheet.setContent(content()); render(); };
  sheet = openSheet({ title: t('Event'), done: true, className: 'ph-ev-sheet', content: content() });
}

/* Only the open session's solves are in memory. Another session's ao12 is
   read from the database the first time the sheet shows it, and kept for as
   long as that session's solve count says it is still the same session. */
const aoCache = new Map();
function otherAo12(id, n, done) {
  const hit = aoCache.get(id);
  if (hit && hit.n === n) return hit.ready ? hit : null;
  if (n < 12) return null;
  aoCache.set(id, { n, ready: false });
  X.sessionSolves(id).then((list) => {
    aoCache.set(id, { n, ready: true, ao12: summarize(list).ao12, moves: list.some(isMoveResult) });
    done();
  }).catch(() => aoCache.delete(id));
  return null;
}

/** The scramble mode, or trainer, for this event: the desktop's mode picker. */
function openModeSheet() {
  let sheet = null;
  const list = modesForEvent(A.settings.event);
  sheet = openSheet({
    title: t('Scrambles'), done: true,
    content: [sheetRows([
      ...list.map((id) => {
        const m = modeOf(id);
        const on = id === A.settings.mode;
        return { label: m.name, sub: m.desc || '', check: on, onSelect: () => X.setMode(id).then(render) };
      }),
      X.hasCases() ? { label: t('Pick cases…'), chevron: true, onSelect: () => X.openPanel('Cases', 'buildCases') } : null,
    ], () => sheet)],
  });
}

/* =========================================================
   The solve sheet: everything the desktop's solve menu has
   ========================================================= */

const AGO = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (same(d, now)) return t('today, {time}', { time });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (same(d, y)) return t('yesterday, {time}', { time });
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
};

/* The cube a solve started from, as a small flat net beside its scramble.
   cubenet.js is the share card's net painter, loaded the first time it is
   wanted; only cube events have a net to draw. */
let netLib = null;
function drawSolveNet(host, solve, n) {
  if (!solve.scramble || solve.relay?.length) return;
  const paint = (lib) => {
    const size = lib.cubeSizeFor(solve.event);
    if (!size) return;
    const W = 68, H = 51, dpr = Math.min(3, devicePixelRatio || 1);
    const cv = el('canvas', { class: 'ph-sv-net', role: 'img', 'aria-label': t('The cube solve {n} started from', { n }) });
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    lib.drawNet(ctx, lib.faceletsFor(solve.scramble, size), size, 0, 0, W, H);
    host.append(cv);
  };
  if (netLib) paint(netLib);
  else import('./cubenet.js').then((m) => { netLib = m; paint(m); }).catch(() => {});
}

export function openSolveSheet(solve, { focusNote = false } = {}) {
  let sheet = null;
  let armed = false;      // Delete asks twice
  let noteEl = null;
  /* A note is kept the moment it is left, and also when the sheet closes or
     redraws under it: a phone keyboard can be dismissed, or the sheet swiped
     away, without the field ever losing focus. */
  const flushNote = () => { if (noteEl) X.saveNote(solve, noteEl.value); };
  const content = () => {
    const solves = A.solves;
    const i = solves.indexOf(solve);
    if (i < 0) return [el('p', { class: 'ph-note', text: t('That solve is gone.') })];
    const moves = isMoveResult(solve);
    const e = solves.map(eff);
    const ao = (n) => (i + 1 >= n ? averageOfRange(e, i + 1 - n, i + 1) : null);
    const fa = (v) => (v == null ? '—' : fmtResult(v, moves));
    const time = fmtSolve(solve) + (solve.penalty === '+2' && !moves ? '+' : '');

    const head = el('div', { class: 'ph-sv-head' },
      el('div', {},
        el('div', { class: 'ph-sv-when', text: `${t('Solve {n}', { n: i + 1 })} · ${solve.createdAt ? AGO(solve.createdAt) : ''}` }),
        el('div', { class: 'ph-sv-time' + (solve.penalty === 'DNF' ? ' dnf' : ''), text: time }),
        el('div', { class: 'ph-sv-avgs' }, 'ao5 ', el('b', { text: fa(ao(5)) }), '  ·  ao12 ', el('b', { text: fa(ao(12)) }))),
      iconBtn('ph-sv-close', t('Close'), I.close, () => sheet.close()));

    const pen = el('div', { class: 'ph-seg', role: 'group', 'aria-label': t('Penalty') },
      ...[['none', t('No penalty')], ['+2', '+2'], ['DNF', 'DNF']].map(([p, label]) => el('button', {
        class: 'ph-seg-btn' + (solve.penalty === p ? ' on' : ''), type: 'button', text: label,
        'aria-pressed': String(solve.penalty === p),
        onclick: async () => { await X.setPenalty(solve, p); refresh(); },
      })));

    const scr = el('div', { class: 'ph-sv-scr' }, el('p', { class: 'mono', text: solve.scramble || t('No scramble saved') }));
    drawSolveNet(scr, solve, i + 1);

    const note = el('textarea', {
      class: 'ph-sv-note', rows: '1', 'aria-label': t('Note on this solve'),
      placeholder: t('Add a note — lockup on the last pair, good cross…'),
    });
    note.value = solve.comment || '';
    note.addEventListener('keydown', ev => ev.stopPropagation());
    note.addEventListener('change', flushNote);
    noteEl = note;

    const relayLegs = solve.relay?.length
      ? solve.relay.map((p, n) => ({ p, n })).filter(({ p }) => p.event === '333' || p.event === '333oh') : null;
    const mainBtns = el('div', { class: 'ph-sv-main' },
      relayLegs ? null : wordBtn('ph-btn primary', I.recon, solve.recon ? t('Open the reconstruction') : t('Reconstruct'),
        () => { sheet.close(); X.reconstructSolve(solve); }),
      wordBtn('ph-btn', I.share, t('Share card'), () => { sheet.close(); A.shareSolveCard(solve); }));

    const extra = [];
    if (X.hasReplay(solve.id)) extra.push({ label: t('Watch replay'), icon: I.play, onSelect: () => X.openReplay(solve) });
    extra.push({ label: t('Repeat this scramble'), icon: I.repeat, onSelect: () => X.repeatScramble(solve) });
    if (relayLegs) {
      for (const { p, n } of relayLegs) {
        extra.push({ label: t('Reconstruct puzzle {i} ({event})', { i: n + 1, event: eventOf(p.event).short }), icon: I.recon,
          onSelect: () => X.reconstructSolve(solve, p.scramble) });
      }
    }
    if (solve.penalty === 'DNF' && solve.bld?.edges) {
      extra.push({ label: t('Diagnose this DNF'), icon: I.doctor,
        onSelect: () => X.openPanel(t('DNF post-mortem'), 'buildPostMortem', { wide: true }, solve) });
    }

    const out = [head, pen, scr, note, mainBtns];
    // A Fewest Moves result is a solution, not a time — the solution is what this is opened for.
    if (solve.fmcSolution) {
      out.push(el('div', { class: 'ph-sv-block' },
        el('div', { class: 'ph-lbl', text: solve.fmcNotes ? t('Solution · {notes}', { notes: solve.fmcNotes }) : t('Solution') }),
        el('p', { class: 'mono', text: solve.fmcSolution }),
        wordBtn('ph-link', I.copy, t('Copy solution'), () => X.copyToast(solve.fmcSolution, 'Solution'))));
    }
    if (solve.phases?.length) {
      out.push(el('div', { class: 'ph-sv-block' },
        el('div', { class: 'ph-lbl', text: t('Phase breakdown') }),
        el('div', { class: 'phase-row pop-phases' }, ...solve.phases.map((ms, n) =>
          el('div', { class: 'phase-chip' }, el('b', { text: `P${n + 1}` }), el('i', { text: fmt(ms) }))))));
    }
    if (solve.relay?.length) {
      out.push(el('div', { class: 'ph-sv-block' },
        el('div', { class: 'ph-lbl', text: t('Relay · {events}', { events: solve.relay.map(p => eventOf(p.event).short).join(' · ') }) }),
        el('div', { class: 'relay-legs' }, ...solve.relay.map((p, n) =>
          el('div', { class: 'relay-leg' },
            el('div', { class: 'rl-head' }, el('b', { text: `${n + 1}. ${eventOf(p.event).short}` }), el('i', { text: fmt(p.splitMs) })),
            el('div', { class: 'rl-scramble', text: p.scramble }))))));
    }
    if (extra.length) out.push(sheetRows(extra, () => sheet));
    out.push(el('div', { class: 'ph-sv-foot' },
      wordBtn('ph-link', I.copy, t('Copy scramble'), () => X.copyToast(solve.scramble, 'Scramble')),
      wordBtn('ph-link danger' + (armed ? ' armed' : ''), I.trash, armed ? t('Tap again to delete') : t('Delete'), () => {
        if (!armed) { armed = true; refresh(); setTimeout(() => { if (armed) { armed = false; refresh(); } }, 3000); return; }
        armed = false;
        noteEl = null;          // nothing to keep on a solve that is going
        sheet.close();
        X.deleteSolve(solve);
      })));
    return out;
  };
  const refresh = () => { if (sheet && !sheet.closed) { flushNote(); sheet.setContent(content()); } };
  sheet = openSheet({
    label: t('Solve {n}', { n: A.solves.indexOf(solve) + 1 }), className: 'ph-sv', content: content(),
    onClose: flushNote,
  });
  if (focusNote) setTimeout(() => sheet.el.querySelector('.ph-sv-note')?.focus(), 320);
  return sheet;
}

/* =========================================================
   Times, Train and More
   ========================================================= */

function screenHead(title) {
  return el('header', { class: 'ph-screen-head' }, el('h1', { text: title }));
}

/* =========================================================
   Times

   The four figures, a trend card, and the session's list. The list is the
   desktop's own (#sidebar, with #panel-times in it) laid over the foot of
   this tab by css/phone.css, so paging, sorting and the column pencils are
   the desktop's code. It is placed rather than moved: tiles.js puts the
   panels back in their rails on every resize, and a list carried off into a
   tab would be dragged straight back out of it.
   ========================================================= */

function buildTimes() {
  const s = ui.screens.times;
  ui.timesCtxText = el('span', { class: 'ph-ctx-ses' });
  ui.timesCtx = el('button', { class: 'ph-ctx small', type: 'button', onclick: openEventSheet },
    ui.timesCtxText, el('span', { class: 'ph-ctx-chev', html: I.chev, 'aria-hidden': 'true' }));
  const head = screenHead(t('Times'));
  head.append(el('div', { class: 'ph-head-r' }, ui.timesCtx,
    iconBtn('ph-icon-btn', t('More for this session'), I.more, openTimesMenu)));

  ui.timesCards = el('div', { class: 'ph-cards' });

  ui.trendSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ui.trendSvg.setAttribute('class', 'ph-trend-svg');
  ui.trendSvg.setAttribute('role', 'img');
  ui.trendLbl = el('span', { class: 'ph-lbl' });
  ui.trendEmpty = el('p', { class: 'ph-trend-empty', text: t('A few more solves and your trend shows here.') });
  ui.trend = el('section', { class: 'ph-trend', 'aria-label': t('Trend') },
    el('div', { class: 'ph-trend-head' }, ui.trendLbl,
      el('span', { class: 'ph-legend' },
        el('span', { class: 'ph-lg' }, el('i', { class: 'ph-lg-line', 'aria-hidden': 'true' }), 'ao5'),
        el('span', { class: 'ph-lg' }, el('i', { class: 'ph-lg-dot', 'aria-hidden': 'true' }), t('single')),
        el('button', { class: 'ph-charts', type: 'button', text: t('Charts ›'),
          onclick: () => X.openPanel('Statistics', 'buildStats', { wide: true }) }))),
    ui.trendSvg, ui.trendEmpty);

  ui.timesSlot = el('div', { class: 'ph-times-slot' });
  s.append(head, ui.timesCards, ui.trend, ui.timesSlot);
  const place = () => {
    const r = ui.timesSlot.getBoundingClientRect();
    if (r.height) document.body.style.setProperty('--ph-slot-top', `${Math.round(r.top)}px`);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(ui.timesSlot);
  ui.placeTimes = place;
}

/** What the desktop list's footer offered, and the drawer behind it. */
function openTimesMenu() {
  let sheet = null;
  sheet = openSheet({
    title: A.session?.name || t('Times'), done: true,
    content: [sheetRows([
      { label: t('All solves'), icon: I.list, onSelect: () => X.openPanel(t('All solves'), 'buildHistory', { wide: true }) },
      { label: t('Statistics'), icon: I.times, onSelect: () => X.openPanel('Statistics', 'buildStats', { wide: true }) },
      { label: t('Export this session'), icon: I.download, onSelect: () => A.exportSessionCSV?.() },
      { label: t('Clear session'), icon: I.trash, danger: true, onSelect: () => X.click('#btn-clear-session') },
    ], () => sheet)],
  });
}

function renderTimes() {
  const solves = A.solves || [];
  const moves = solves.some(isMoveResult);
  const ev = eventOf(A.settings.event);
  ui.timesCtxText.textContent = `${ev.short} · ${A.session?.name || ''}`;
  ui.timesCtx.setAttribute('aria-label', t('Event and session: {event}, {session}', { event: ev.short, session: A.session?.name || '' }));

  const st = summarize(solves);
  const f = (v) => (v == null || !isFinite(v) ? '—' : fmtResult(v, moves));
  const card = (label, value, { best = false, sub = '' } = {}) => el('div', { class: 'ph-card' + (best ? ' is-best' : '') },
    el('div', { class: 'ph-card-k' }, el('span', { text: label }), best ? el('span', { class: 'ph-best', text: t('best') }) : null),
    el('div', { class: 'ph-card-v', text: f(value) }),
    sub ? el('div', { class: 'ph-card-sub', text: sub }) : null);
  // The current average, marked when it is the session's best and otherwise
  // saying what the best one was.
  const avg = (label, n, cur, best) => {
    const isBest = cur != null && best != null && isFinite(cur) && cur === best && solves.length > n;
    const sub = cur == null ? t('needs {n} solves', { n })
      : !isBest && best != null && isFinite(best) ? t('best {time}', { time: f(best) }) : '';
    return card(label, cur, { best: isBest, sub });
  };
  let bestAt = -1;
  if (st.best != null) for (let i = solves.length - 1; i >= 0; i--) if (eff(solves[i]) === st.best) { bestAt = i; break; }
  ui.timesCards.replaceChildren(
    // Fewest Moves is scored by mean of three, and its averages say so.
    moves ? avg('mo3', 3, st.mo3, bestMean(solves, 3)) : avg('ao5', 5, st.ao5, st.bestAo5),
    moves ? card(t('count'), solves.length) : avg('ao12', 12, st.ao12, st.bestAo12),
    card(t('best'), st.best, { sub: bestAt >= 0 ? t('solve {n}', { n: bestAt + 1 }) : '' }),
    card(t('mean'), st.mean, { sub: t(solves.length === 1 ? '{n} solve' : '{n} solves', { n: solves.length }) }));

  const n = Math.min(22, solves.length);
  ui.trendLbl.textContent = t('Last {n}', { n });
  ui.trendSvg.setAttribute('aria-label', t('Last {n} solves with the rolling ao5', { n }));
  ui.trendSvg.hidden = false;
  const box = ui.trendSvg.getBoundingClientRect();
  const drawn = renderDotTrend(ui.trendSvg, solves, { count: 22, width: Math.round(box.width) || 326, height: Math.round(box.height) || 84 });
  ui.trendSvg.hidden = !drawn;
  ui.trendEmpty.hidden = drawn;
}

/* =========================================================
   Train
   ========================================================= */

function buildTrain() {
  const s = ui.screens.train;
  const tool = (icon, title, sub, onclick) => el('button', { class: 'ph-tool', type: 'button', onclick },
    el('span', { class: 'ph-tool-ico', html: icon, 'aria-hidden': 'true' }),
    el('span', { class: 'ph-tool-t', text: title }),
    el('span', { class: 'ph-tool-s', text: sub }));
  const mini = (cls, icon, title, sub, onclick) => el('button', { class: `ph-mini ${cls}`, type: 'button', onclick },
    el('span', { class: 'ph-mini-ico', html: icon, 'aria-hidden': 'true' }),
    el('span', { class: 'ph-mini-txt' }, el('span', { class: 'ph-mini-t', text: title }), sub));
  ui.sotdSub = el('span', { class: 'ph-mini-s' });
  ui.raceSub = el('span', { class: 'ph-mini-s' });
  const lib = el('a', { class: 'ph-link accent', href: 'algs.html', html: `${I.book}<span></span>` });
  lib.querySelector('span').textContent = t('Alg library');
  ui.trainers = el('div', { class: 'ph-group' });
  s.append(screenHead(t('Train')),
    el('div', { class: 'ph-tools' },
      tool(I.xp1, t('Cross + 1'), t('Plan the cross and first pair in inspection'), () => X.click('#btn-xp1')),
      tool(I.recon, t('Reconstruct'), t('The best next move at every step'), () => X.click('#btn-recon'))),
    el('div', { class: 'ph-minis' },
      // Scramble of the Day happens on the timer, so that is where it goes.
      mini('gold', I.trophy, t('Scramble of the Day'), ui.sotdSub, () => { setTab('timer'); X.click('#btn-daily'); }),
      mini('', I.flag, t('Race'), ui.raceSub, () => X.click('#btn-race'))),
    el('div', { class: 'ph-sec-head' }, el('h2', { class: 'ph-sec', text: t('Case trainers') }), lib),
    ui.trainers);
}

let trainTick = 0;
async function renderTrain() {
  const now = Date.now();
  const left = t('resets in {time}', { time: formatCountdown(nextResetMs(now) - now) });
  ui.sotdSub.textContent = sotdDoneOn(dayIdFromServerMs(now)) ? t('Done today · {left}', { left }) : left;
  ui.raceSub.textContent = $('#btn-race')?.classList.contains('live') ? t('in a room') : t('open a room');
  // The countdown is in minutes; keep it true while the tab is open.
  clearTimeout(trainTick);
  trainTick = setTimeout(() => { if (tab === 'train' && isPhone()) renderTrain(); }, 30000);

  const states = await loadStates().catch(() => ({}));
  const ids = modesForEvent(A.settings.event).filter(id => id !== 'wca');
  ui.trainers.replaceChildren(...ids.map(id => trainerRow(id, states, now)));
  if (!ids.length) ui.trainers.append(el('p', { class: 'ph-note pad', text: t('No trainers for this event yet.') }));
}

/** One trainer: its size, and how far learn mode has got with it. */
function trainerRow(id, states, now) {
  const m = modeOf(id);
  const cases = m.kind === 'case' ? setFor(id) : null;
  let known = 0, learning = 0, due = 0;
  if (m.set) {
    const prefix = `${m.set}:`;
    for (const [k, st] of Object.entries(states)) {
      if (!k.startsWith(prefix) || !st?.seen) continue;
      if (st.box >= GRADUATED_BOX) known++; else learning++;
      if (st.dueAt <= now) due++;
    }
  }
  const total = cases?.length ?? null;
  const sub = total != null
    ? t('{n} cases', { n: total }) + (learning ? ` · ${t('learning {n}', { n: learning })}` : '')
    : (m.desc || '');
  const on = id === A.settings.mode;
  const right = m.kind !== 'case' ? null : el('span', { class: 'ph-prog' },
    el('span', { class: 'ph-prog-t' + (known ? '' : ' none'), text: known ? t('{n} known', { n: known }) : t('not started') }),
    total ? el('span', { class: 'ph-prog-bar', 'aria-hidden': 'true' },
      el('i', { style: `width:${Math.round(100 * Math.min(1, known / total))}%` })) : null);
  return el('button', {
    class: 'ph-row' + (on ? ' current' : ''), type: 'button', 'aria-current': on ? 'true' : null,
    onclick: async () => { await X.setMode(id); render(); setTab('timer'); },
  },
  el('span', { class: 'ph-row-txt' }, el('span', { class: 'ph-row-t', text: m.name }), sub ? el('span', { class: 'ph-row-s', text: sub }) : null),
  due ? el('span', { class: 'ph-due', text: t('{n} due', { n: due }) }) : null,
  right,
  on ? el('span', { class: 'sheet-row-check', html: I.check, 'aria-hidden': 'true' }) : null);
}

/* =========================================================
   More
   ========================================================= */

function buildMore() {
  const s = ui.screens.more;
  ui.syncCard = el('div', { class: 'ph-sync' });
  ui.moreGroups = el('div', { class: 'ph-more' });
  s.append(screenHead(t('More')), ui.syncCard, ui.moreGroups);
  // The account box in the (hidden) top bar is sync-ui.js's, and it is
  // redrawn on every sign-in, sign-out and rename; the card follows it.
  const acct = $('#btn-account');
  if (acct) new MutationObserver(() => { if (tab === 'more') renderMore(); })
    .observe(acct, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  // Keyboard shortcuts are offered once there is a keyboard to use them with.
  addEventListener('keydown', (e) => {
    if (hasKeyboard || e.target.closest?.('input, textarea, [contenteditable]')) return;
    hasKeyboard = true;
    if (tab === 'more') renderMore();
  });
}
let hasKeyboard = typeof matchMedia === 'function' && matchMedia('(any-pointer: fine)').matches;

/** Settings, opened at one of its groups. */
async function openSettingsAt(title) {
  await X.openPanel('Settings', 'buildSettings');
  requestAnimationFrame(() => {
    const h = [...document.querySelectorAll('#drawer .group > h3')].find(n => n.textContent === title);
    h?.parentElement.scrollIntoView({ block: 'start' });
  });
}

function renderMore() {
  /* ---- the account ---- */
  const acct = $('#btn-account');
  const signedIn = !!acct?.classList.contains('on');
  if (signedIn) {
    const pic = acct.querySelector('.account-avatar, .account-initial')?.cloneNode(true);
    const name = acct.querySelector('.account-username')?.textContent || '';
    ui.syncSub = el('span', { class: 'ph-sync-s', text: t('Your solves sync to this account') });
    ui.syncCard.replaceChildren(el('button', { class: 'ph-sync-in', type: 'button', onclick: openAccountSheet },
      el('span', { class: 'ph-sync-pic' }, pic || el('span', { html: I.account })),
      el('span', { class: 'ph-sync-txt' }, el('span', { class: 'ph-sync-t', text: name }), ui.syncSub),
      el('span', { class: 'sheet-row-chev', html: I.chevR, 'aria-hidden': 'true' })));
    // The address the account syncs to, once sync-ui.js (already loaded for a
    // signed-in account) can say.
    import('./sync-ui.js').then((m) => {
      const menu = m.accountMenu?.();
      if (menu?.email && ui.syncSub?.isConnected) ui.syncSub.textContent = t('syncing as {email}', { email: menu.email });
    }).catch(() => {});
  } else {
    ui.syncCard.replaceChildren(
      el('span', { class: 'ph-sync-pic', html: I.cloud, 'aria-hidden': 'true' }),
      el('span', { class: 'ph-sync-txt' },
        el('span', { class: 'ph-sync-t', text: t('Sync your solves') }),
        el('span', { class: 'ph-sync-s', text: t('Keep every session on every device') })),
      el('button', { class: 'ph-sync-btn', type: 'button', text: t('Sign in'), onclick: () => X.click('#btn-account') }));
  }

  /* ---- the rows ---- */
  const S = A.settings;
  const cs = getComputedStyle(document.documentElement);
  const swatches = el('span', { class: 'ph-swatches', 'aria-hidden': 'true' },
    ...['--accent', '--accent-2', '--surface'].map(v => el('i', { style: `background:${cs.getPropertyValue(v).trim()}` })));
  const input = { timer: t('Touch'), manual: t('Type them'), stackmat: t('Stackmat (aux)'), virtual: t('Virtual cube') }[S.inputMode || 'timer'] || t('Touch');
  const gear = A.gear?.activeId ? ($('#gear-label')?.textContent || '') : t('None');
  const row = (icon, label, value, onclick) => el('button', { class: 'ph-row', type: 'button', onclick },
    el('span', { class: 'ph-row-ico', html: icon, 'aria-hidden': 'true' }),
    el('span', { class: 'ph-row-t', text: label }),
    value != null ? el('span', { class: 'ph-row-v' }, value) : null,
    el('span', { class: 'sheet-row-chev', html: I.chevR, 'aria-hidden': 'true' }));
  const group = (...rows) => el('div', { class: 'ph-group' }, ...rows.filter(Boolean));
  ui.moreGroups.replaceChildren(
    group(
      row(I.sun, t('Appearance'), el('span', { class: 'ph-row-vv' }, swatches, PRESETS[S.theme]?.name || ''), () => X.click('#btn-theme')),
      row(I.timer, t('Timer'), S.inspection ? t('Inspection 15 s') : t('Inspection off'), () => openSettingsAt(t('Inspection'))),
      row(I.keyboard, t('Timing input'), input, () => openSettingsAt(t('Timing input'))),
      row(I.gear, t('Settings'), null, () => X.click('#btn-settings'))),
    group(
      row(I.recon, t('Your cubes'), gear, () => X.openPanel('Gear', 'buildGear', { wide: true })),
      row(I.spotify, t('Spotify'), X.spotifyLinked() ? t('Linked') : t('Not linked'), () => X.click('#btn-spotify'))),
    group(
      row(I.download, t('Import and export'), null, () => openSettingsAt(t('Data'))),
      row(I.globe, t('Language'), lang === 'es' ? 'Español' : 'English', () => openSettingsAt(t('Language'))),
      hasKeyboard ? row(I.keyboard, t('Keyboard shortcuts'), null, () => X.openPanel(t('Keyboard shortcuts'), 'buildShortcuts', { wide: true })) : null,
      row(I.info, t('About'), null, () => X.click('#btn-about'))));
}

/** Signed in: the account menu the top bar's button opens, as a sheet. */
async function openAccountSheet() {
  let menu = null;
  try { menu = (await import('./sync-ui.js')).accountMenu?.(); } catch { /* falls through to the drawer */ }
  if (!menu) { openSettingsAt(t('Account')); return; }
  let sheet = null;
  sheet = openSheet({
    title: menu.name, done: true,
    content: [
      menu.email ? el('p', { class: 'ph-note', text: t('syncing as {email}', { email: menu.email }) }) : null,
      sheetRows([
        ...menu.items.map(it => ({ label: it.label, danger: it.label === t('Sign out'), onSelect: it.onSelect })),
        { label: t('Sync settings'), chevron: true, onSelect: () => openSettingsAt(t('Account')) },
      ], () => sheet),
    ],
  });
}

function renderTab(id) {
  if (id === 'times') renderTimes();
  else if (id === 'train') renderTrain();
  else if (id === 'more') renderMore();
}
