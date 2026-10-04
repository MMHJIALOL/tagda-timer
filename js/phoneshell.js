import { t } from './i18n.js';
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
import { eff, DNF, isMoveResult, averageOfRange, summarize } from './stats.js';
import { CubeView } from './cube.js';

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

/* Times: the history list the desktop rail holds, which is the same element
   (#sidebar, with #panel-times in it) laid over this tab's lower half by
   css/phone.css — so paging, sorting and the column pencils are the desktop's
   own. It is placed rather than moved: tiles.js puts the panels back in their
   rails on every resize, and a list that had been carried off into a tab would
   be dragged straight back out of it. */
function buildTimes() {
  const s = ui.screens.times;
  ui.timesHead = screenHead(t('Times'));
  ui.timesCtx = el('button', { class: 'ph-ctx small', type: 'button', onclick: openEventSheet });
  ui.timesHead.append(ui.timesCtx);
  ui.timesSummary = el('div', { class: 'ph-times-sum' });
  ui.timesSlot = el('div', { class: 'ph-times-slot' });
  s.append(ui.timesHead, ui.timesSummary,
    el('div', { class: 'ph-times-actions' },
      wordBtn('ph-link', I.times, t('Charts'), () => X.openPanel('Statistics', 'buildStats', { wide: true })),
      wordBtn('ph-link', I.cube, t('All solves'), () => X.openPanel(t('All solves'), 'buildHistory', { wide: true }))),
    ui.timesSlot);
  const place = () => {
    const r = ui.timesSlot.getBoundingClientRect();
    if (r.height) document.body.style.setProperty('--ph-slot-top', `${Math.round(r.top)}px`);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(ui.timesSlot);
  ui.placeTimes = place;
}

function buildTrain() {
  const s = ui.screens.train;
  s.append(screenHead(t('Train')), sheetRows([
    { label: t('Cross + 1'), sub: t('Plan the cross and the first pair together'), onSelect: () => X.click('#btn-xp1') },
    { label: t('Reconstruct'), sub: t('Replay a solve move by move'), onSelect: () => X.click('#btn-recon') },
    // Both of these happen on the timer, so that is where they go.
    { label: t('Scramble of the Day'), sub: t('The same scramble for everyone'), onSelect: () => { setTab('timer'); X.click('#btn-daily'); } },
    { label: t('Race'), sub: t('Open a room'), onSelect: () => { setTab('timer'); X.click('#btn-race'); } },
    { label: t('Scramble mode / trainer'), sub: t('Case trainers for this event'), onSelect: openModeSheet },
    { label: t('Alg library'), sub: t('Every algorithm set, to learn and drill'), onSelect: () => { location.href = 'algs.html'; } },
  ], () => null));
}

function buildMore() {
  const s = ui.screens.more;
  const row = (label, sel) => ({ label, onSelect: () => X.click(sel) });
  s.append(screenHead(t('More')), sheetRows([
    row(t('Account and sync'), '#btn-account'),
    row(t('Appearance'), '#btn-theme'),
    row(t('Settings'), '#btn-settings'),
    row(t('Statistics'), '#btn-stats'),
    row(t('Webcam replay'), '#btn-camera'),
    row(t('Spotify'), '#btn-spotify'),
    row(t('About'), '#btn-about'),
  ], () => null));
}

function renderTab(id) {
  if (id === 'times') {
    const ev = eventOf(A.settings.event);
    ui.timesCtx.textContent = `${ev.short} · ${A.session?.name || ''}`;
    const st = summarize(A.solves || []);
    const f = (v) => (v == null ? '—' : fmtResult(v, (A.solves || []).some(isMoveResult)));
    ui.timesSummary.replaceChildren(...[['ao5', st.ao5], ['ao12', st.ao12], [t('best'), st.best], [t('mean'), st.mean]]
      .map(([k, v]) => el('div', { class: 'ph-stat' }, el('span', { text: k }), el('b', { class: 'mono', text: f(v) }))));
  }
}

