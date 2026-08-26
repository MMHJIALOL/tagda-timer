/* ===========================================================
   Tagda Timer — application wiring
   =========================================================== */

import { $, $$, el, uid, fmt, fmtLive, clamp, copy, download, toCSV, debounce } from './util.js';
import { Solves, Sessions, KV, Assets } from './db.js';
import { EVENTS, EVENT_ORDER, MODES, modesForEvent, eventOf, modeOf } from './events.js';
import { ScrambleQueue, setFor, cubingAvailable } from './scramble.js';
import { Timer, INSPECT_MS } from './timer.js';
import { Background } from './bg.js';
import { CubeView } from './cube.js';
import { makeDraggable } from './drag.js';
import { flash, shockwave, confetti, chime, callout, beep } from './fx.js';
import { summarize, eff, DNF, bestSingle, bestAvg, trimmedIndices, byCase, sessionBests } from './stats.js';
import { renderMiniTrend } from './charts.js';
import { loadSettings, saveSettings, applyTheme, applyBackground, themeColors } from './theme.js';
import { popover, closePopover, popoverOpen } from './popover.js';
import { toast, confirmToast } from './toast.js';
import { openPalette, closePalette, paletteOpen } from './palette.js';
import {
  openDrawer, closeDrawer, drawerOpen,
  buildAppearance, buildSettings, buildStats, buildHistory, buildCases, buildShortcuts, buildSessions,
  buildStatDetail, buildAbout,
} from './panels.js';

/* =========================================================
   State
   ========================================================= */
const app = {
  settings: null,
  sessions: [],
  session: null,
  solves: [],
  sessionCounts: new Map(),
  scramble: null,
  scrambleHistory: [],
  historyPos: -1,
  lastDeleted: null,
};
window.tagdatimer = app;   // handy in the console
// The boot guard in index.html only exists to catch "the modules never
// loaded". Once this file is evaluating, they did — anything that goes wrong
// from here is a real error worth reporting, not a dead-page diagnosis.
window.__tdtBooted = true;

const queue = new ScrambleQueue(3);
const bg = new Background($('#bg-shader'), $('#bg-media'));
const cube = new CubeView($('#cube-holder'), $('#cube-fallback'));
let timer = null;
let cubeDrag = null;

/* =========================================================
   Boot
   ========================================================= */
init().catch(bootFailure);

/**
 * A rejected init() is otherwise an unhandled promise rejection: the page sits
 * there half-drawn with the answer only in the console. Say what broke, on the
 * page, and keep the timer usable if it got far enough to be usable.
 */
function bootFailure(err) {
  console.error('[boot] initialisation failed', err);
  window.__tdtBootFail?.(`Something went wrong while starting up: ${err?.message || err}`);
}

async function init() {
  app.settings = await loadSettings();
  applyTheme(app.settings);

  // sessions
  app.sessions = await Sessions.all();
  if (!app.sessions.length) {
    const s = { id: uid(), name: 'Session 1', event: app.settings.event, createdAt: Date.now(), order: 0 };
    await Sessions.put(s);
    app.sessions = [s];
    app.settings.sessionId = s.id;
  }
  app.session = app.sessions.find(s => s.id === app.settings.sessionId) || app.sessions[0];
  app.settings.sessionId = app.session.id;
  if (app.session.event) app.settings.event = app.session.event;

  await refreshCounts();
  app.solves = await Solves.bySession(app.session.id);

  // timer
  timer = new Timer({
    inspection: app.settings.inspection,
    holdTime: app.settings.holdTime,
    precision: app.settings.precision,
    useInspection: !eventOf(app.settings.event).noInspection,
  });
  wireTimer();
  wireInput();
  wireChrome();
  wireShortcuts();

  // visuals
  // A background is decoration. A broken shader, a missing blob, a browser with
  // WebGL switched off — none of that is a reason for the timer not to start.
  await applyBackground(bg, app.settings).catch(err => console.warn('[bg] could not apply background', err));
  cube.orbit = app.settings.cubeOrbit;
  cube.init().then(() => {
    cube.setHints(app.settings.hintFacelets);
    if (app.scramble) showScramble(app.scramble, true);
  }).catch((err) => {
    console.warn('[cube] failed to initialise', err);
    cube.showFallback('preview unavailable');
  });

  queue.onReady = () => { if (!app.scramble) nextScramble(); };
  refreshQueue();
  nextScramble();

  renderAll();
  bootAnimation();

  window.addEventListener('resize', debounce(() => {
    applyTheme(app.settings);
    sizeRing();
    // Belt and braces alongside the ResizeObserver below: this covers the
    // common case even where ResizeObserver is missing or throttled.
    fitScrambleToLine($('#scramble-text'));
  }, 120));

  watchScrambleWidth();
  sizeRing();
}

/** Animations are only safe to run when the document timeline is actually moving. */
const canAnimate = () => app.settings.motion !== 'off' && document.visibilityState === 'visible';

function bootAnimation() {
  // `fill: backwards` holds the opening frame (opacity 0) until the animation
  // runs, and a background tab's timeline is paused — which would leave the
  // whole UI invisible until the tab is focused. Not worth the risk.
  if (!canAnimate()) return;
  const parts = [$('#topbar'), $('#scramble-zone'), $('#timer-display'), $('#panel-times'), $('#panel-stats'), $('#panel-cube')];
  parts.forEach((p, i) => {
    if (!p) return;
    p.animate(
      [{ opacity: 0, transform: 'translateY(14px) scale(.985)', filter: 'blur(6px)' },
       { opacity: 1, transform: 'none', filter: 'blur(0)' }],
      { duration: 620, delay: 60 + i * 65, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
  });
}

/* =========================================================
   Scramble
   ========================================================= */
function refreshQueue() {
  const s = app.settings;
  queue.setContext(s.event, s.mode, {
    allowedCases: s.allowedCases[s.mode],
    multiCount: s.multiCount,
  });
}
app.refreshQueue = () => { refreshQueue(); nextScramble(); };

let scrambleToken = 0;

async function nextScramble({ clear = false } = {}) {
  // Switching event: a big-cube random-state scramble takes a couple of seconds,
  // and leaving the previous event's scramble on screen invites you to solve
  // the wrong one. Say what is happening instead.
  if (clear && !queue.ready) {
    const node = $('#scramble-text');
    node.textContent = 'generating scramble…';
    node.classList.remove('multiline', 'long');
    $('#case-label').hidden = true;
  }
  const token = ++scrambleToken;
  const s = await queue.next();
  if (token !== scrambleToken) return;   // a newer request overtook this one
  app.scrambleHistory.push(s);
  if (app.scrambleHistory.length > 40) app.scrambleHistory.shift();
  app.historyPos = app.scrambleHistory.length - 1;
  showScramble(s);
}

function prevScramble() {
  if (app.historyPos <= 0) { toast('No earlier scramble'); return; }
  app.historyPos--;
  showScramble(app.scrambleHistory[app.historyPos]);
}

function forwardScramble() {
  if (app.historyPos >= app.scrambleHistory.length - 1) { nextScramble(); return; }
  app.historyPos++;
  showScramble(app.scrambleHistory[app.historyPos]);
}

function showScramble(s, silent = false) {
  app.scramble = s;
  const ev = eventOf(app.settings.event);
  const node = $('#scramble-text');

  let text = s.scramble;
  if (app.settings.event === 'minx' && !text.includes('\n')) {
    const toks = text.split(/\s+/);
    const lines = [];
    for (let i = 0; i < toks.length; i += 11) lines.push(toks.slice(i, i + 11).join(' '));
    text = lines.join('\n');
  }

  node.textContent = text;
  node.classList.toggle('multiline', text.includes('\n'));
  node.classList.toggle('long', text.length > 90);
  fitScrambleToLine(node);

  const caseEl = $('#case-label');
  if (s.caseName) { caseEl.hidden = false; caseEl.textContent = s.caseName; }
  else caseEl.hidden = true;

  // Only ever animate the *movement*. A keyframe that starts at opacity 0 leaves
  // the scramble invisible if the animation is paused or never runs (a
  // background tab pauses the document timeline), and an unreadable scramble is
  // a far worse outcome than a missing fade.
  if (!silent && canAnimate()) {
    node.animate([{ transform: 'translateY(-6px)' }, { transform: 'none' }],
      { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)' });
  }

  const mode = modeOf(app.settings.mode);
  const view = mode.view || app.settings.cubeView;
  cube.configure(ev.puzzle, view === 'LL3' ? '3D' : view);
  cube.set(s.scramble);

  if (s.official === false && mode.kind === 'wca' && !cubingAvailable()) {
    node.title = 'Offline fallback scramble — not competition legal';
  } else node.title = 'click to copy';
}

/**
 * Refit whenever the box the scramble lives in changes size, or the font it is
 * measured in changes underneath us.
 *
 * A window `resize` listener is not enough. The box also changes width when the
 * sidebar slider moves, when a panel is hidden, when density changes — and none
 * of those resize the window. Worse, the first measurement happens in a
 * fallback font: when JetBrains Mono finishes loading the text reflows to a
 * different width while the element's own width never changes, so nothing
 * would have re-run the fit and the scramble stayed clipped.
 */
function watchScrambleWidth() {
  const node = $('#scramble-text');
  const box = $('#scramble-wrap');
  if (!node || !box) return;

  const refit = debounce(() => fitScrambleToLine(node), 60);
  if (typeof ResizeObserver === 'function') {
    // Observing the wrapper, not the text: the text's own width is an output of
    // the fit, so watching it would feed the observer its own result.
    new ResizeObserver(refit).observe(box);
  }
  document.fonts?.ready?.then(() => fitScrambleToLine(node)).catch(() => {});
}

/**
 * Keep a single-line scramble on a single line.
 *
 * A 3x3 scramble is 19-21 moves and was wrapping with one or two moves stranded
 * on a second line - the worst possible split. Rather than guessing a font size
 * per event, measure the overflow and scale the type down by exactly the ratio
 * needed.
 *
 * There is a floor: a 7x7 scramble squeezed onto one line would be unreadable,
 * so anything that would need to shrink past 55% is allowed to wrap instead.
 */
function fitScrambleToLine(node) {
  if (!node) return;
  node.style.fontSize = '';
  node.classList.remove('oneline');
  // Scrambles with real line breaks in them (megaminx, multi-blind) mean it.
  if (node.classList.contains('multiline')) return;

  node.classList.add('oneline');
  const base = parseFloat(getComputedStyle(node).fontSize) || 16;
  if (node.scrollWidth <= node.clientWidth) return;   // already fits

  const floor = base * 0.55;
  // 0.98 absorbs the sub-pixel rounding in scrollWidth.
  let size = base * (node.clientWidth / node.scrollWidth) * 0.98;
  if (size < floor) { node.classList.remove('oneline'); node.style.fontSize = ''; return; }

  node.style.fontSize = `${size.toFixed(2)}px`;
  // One correction pass: glyph widths are not perfectly linear in font size.
  if (node.scrollWidth > node.clientWidth) {
    size = Math.max(floor, size * (node.clientWidth / node.scrollWidth) * 0.99);
    node.style.fontSize = `${size.toFixed(2)}px`;
  }
}

/* =========================================================
   Timer wiring
   ========================================================= */
/** States during which focus mode keeps everything but the timer off screen. */
const FOCUS_STATES = new Set(['holding', 'ready', 'inspecting', 'running']);

function wireTimer() {
  const display = $('#timer-display');
  const main = $('#time-main');
  const pen = $('#time-penalty');
  const ring = $('#inspect-ring');
  const ringRect = $('#inspect-ring-rect');
  const readout = $('#inspect-readout');
  const num = $('#inspect-num');
  const pace = $('#pace-ghost');
  const paceFill = $('#pace-fill');

  timer.addEventListener('state', (e) => {
    const st = e.detail.state;
    display.className = `state-${st === 'cooldown' ? 'idle' : st}`;

    // The countdown owns the screen from the moment inspection starts until the
    // solve does — including the hold that arms it, which is still inspection
    // time ticking away.
    const counting = timer.inspectionEnabled && !!timer.inspectStart;
    document.body.classList.toggle('inspecting', st === 'inspecting' || ((st === 'holding' || st === 'ready') && counting));

    // Focus mode clears the chrome the instant you press down and keeps it
    // clear through inspection and the solve, so nothing pops back into view
    // mid-attempt. Only a finished or cancelled attempt brings it back.
    document.body.classList.toggle('focus',
      app.settings.focusMode && FOCUS_STATES.has(st));

    // Arming feedback. During inspection the digits are hidden behind the
    // countdown, so the colour change on them was invisible and holding felt
    // like nothing was happening at all.
    document.body.classList.toggle('holding', st === 'holding');
    document.body.classList.toggle('armed', st === 'ready');
    updateHoldBar(st);

    if (st === 'running') {
      bg.setSlow(0.08);
      ring.classList.remove('on');
      readout.hidden = true;
      display.classList.toggle('hidden-digits', app.settings.hideWhileRunning || eventOf(app.settings.event).hideDuringSolve);
      pen.textContent = '';
      if (app.settings.paceGhost) startPace(pace, paceFill);
    } else if (st === 'idle') {
      bg.setSlow(1);
      ring.classList.remove('on');
      readout.hidden = true;
      pace.hidden = true;
      display.classList.remove('hidden-digits');
      document.documentElement.style.removeProperty('--breathe');
    }
  });

  timer.addEventListener('inspectstart', () => {
    sizeRing();
    ring.classList.add('on');
    readout.hidden = false;
    main.style.opacity = '0';
    ringRect.style.strokeDasharray = ringLen;
    ringRect.style.strokeDashoffset = '0';
  });

  timer.addEventListener('inspecttick', (e) => {
    const { elapsed, remaining, penalty } = e.detail;
    const left = Math.ceil(remaining / 1000);
    num.textContent = penalty === 'DNF' ? 'DNF' : penalty === '+2' ? '+2' : String(left);
    num.style.color = penalty === 'none'
      ? (elapsed >= 12000 ? 'var(--danger)' : elapsed >= 8000 ? 'var(--warn)' : 'var(--warn)')
      : 'var(--danger)';

    ringRect.style.strokeDashoffset = String(ringLen * Math.min(1, elapsed / INSPECT_MS));
    ringRect.style.stroke = elapsed >= 12000 ? 'var(--danger)' : elapsed >= 8000 ? 'var(--warn)' : 'var(--accent-2)';

    // heartbeat quickens
    const b = 1500 - Math.min(1, elapsed / INSPECT_MS) * 1000;
    document.documentElement.style.setProperty('--breathe', b.toFixed(0) + 'ms');

    // background warms up as time burns down
    const c = themeColors();
    const t = clamp(elapsed / INSPECT_MS, 0, 1);
    bg.setSlow(1 + t * 2.2);
    bg.setColors(c.bg2, t > 0.8 ? c.danger : t > 0.53 ? c.warn : c.accent, t > 0.8 ? c.warn : c.accent2);
  });

  timer.addEventListener('warn', (e) => {
    callout(e.detail.at, app.settings.callouts);
    flash(e.detail.at === 12 ? getVar('--danger') : getVar('--warn'));
  });

  timer.addEventListener('tick', (e) => {
    main.textContent = fmtLive(e.detail.elapsed, app.settings.precision);
  });

  timer.addEventListener('cancel', () => {
    main.style.opacity = '';
    main.textContent = app.solves.length ? fmt(eff(app.solves.at(-1))) : '0.00';
    resetBgColors();
  });

  timer.addEventListener('start', () => { main.style.opacity = ''; });

  timer.addEventListener('stop', (e) => onSolveFinished(e.detail));
}

/**
 * Fills over the configured hold time, then latches green on "ready". This is
 * the only thing on screen during inspection that says the timer heard you.
 */
function updateHoldBar(state) {
  const bar = $('#hold-bar');
  const fill = $('#hold-fill');
  if (!bar || !fill) return;
  const holdMs = Math.max(0, app.settings.holdTime);

  if (state === 'holding' && holdMs > 0) {
    bar.hidden = false;
    bar.classList.remove('ready');
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth;                    // commit the reset before animating
    fill.style.transition = `width ${holdMs}ms linear`;
    fill.style.width = '100%';
  } else if (state === 'ready') {
    bar.hidden = false;
    bar.classList.add('ready');
    fill.style.transition = 'none';
    fill.style.width = '100%';
  } else {
    bar.hidden = true;
    bar.classList.remove('ready');
    fill.style.transition = 'none';
    fill.style.width = '0%';
  }
}

let ringLen = 0;
function sizeRing() {
  const r = $('#inspect-ring-rect');
  if (!r) return;
  r.setAttribute('width', Math.max(0, innerWidth - 6));
  r.setAttribute('height', Math.max(0, innerHeight - 6));
  ringLen = r.getTotalLength ? r.getTotalLength() : (innerWidth + innerHeight) * 2;
}

const getVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function resetBgColors() {
  const c = themeColors();
  bg.setColors(c.bg2, c.accent, c.accent2);
  bg.setSlow(1);
}

/* ---------------- pace ghost ---------------- */
function startPace(pace, fill) {
  const ref = app.settings.paceRef === 'ao5'
    ? summarize(app.solves).ao5
    : bestSingle(app.solves);
  if (!ref || ref === DNF) { pace.hidden = true; return; }
  pace.hidden = false;
  pace.classList.remove('behind');
  fill.style.width = '0%';
  const t0 = performance.now();
  const step = () => {
    if (timer.state !== 'running') return;
    const p = (performance.now() - t0) / ref;
    fill.style.width = Math.min(100, p * 100) + '%';
    pace.classList.toggle('behind', p >= 1);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* =========================================================
   Recording a solve
   ========================================================= */
async function onSolveFinished(res) {
  resetBgColors();
  const main = $('#time-main');
  main.textContent = fmt(res.timeMs);
  $('#time-penalty').textContent = res.penalty === '+2' ? '+2' : res.penalty === 'DNF' ? 'DNF' : '';

  if (res.suspicious && app.settings.confirmShortSolves) {
    const keep = await confirmToast(`${fmt(res.timeMs)} — misfire? Discard it?`, 'discard');
    if (keep) { timer.reset(); nextScramble(); return; }
  }

  const prevBest = bestSingle(app.solves);
  const prevAo5  = bestAvg(app.solves, 5).value;
  const prevAo12 = bestAvg(app.solves, 12).value;

  const solve = {
    id: uid(),
    sessionId: app.session.id,
    event: app.settings.event,
    mode: app.settings.mode,
    scramble: app.scramble?.scramble || '',
    caseId: app.scramble?.caseId || null,
    caseName: app.scramble?.caseName || null,
    timeMs: res.timeMs,
    penalty: res.penalty,
    inspectionMs: res.inspectionMs,
    comment: '',
    createdAt: Date.now(),
  };
  app.solves.push(solve);
  await Solves.put(solve);
  app.sessionCounts.set(app.session.id, app.solves.length);

  // personal bests
  const nowBest = bestSingle(app.solves);
  const nowAo5  = bestAvg(app.solves, 5).value;
  const nowAo12 = bestAvg(app.solves, 12).value;

  let pbKind = null;
  if (prevBest !== null && nowBest !== null && nowBest < prevBest && eff(solve) === nowBest) pbKind = 'single';
  else if (prevAo5 !== null && nowAo5 !== null && nowAo5 < prevAo5) pbKind = 'ao5';
  else if (prevAo12 !== null && nowAo12 !== null && nowAo12 < prevAo12) pbKind = 'ao12';

  showDelta(solve, prevBest);
  renderAll();

  if (pbKind) celebratePB(pbKind);
  nextScramble();
}

function showDelta(solve, prevBest) {
  const node = $('#last-delta');
  const prev = app.solves.length >= 2 ? eff(app.solves.at(-2)) : null;
  const cur = eff(solve);
  if (prev === null || prev === DNF || cur === DNF) { node.hidden = true; return; }
  const d = cur - prev;
  node.hidden = false;
  node.className = d <= 0 ? 'better' : 'worse';
  node.textContent = `${d <= 0 ? '▼' : '▲'} ${fmt(Math.abs(d))} vs last`;
  void prevBest;
}

function celebratePB(kind) {
  const c = themeColors();
  const intensity = kind === 'single' ? 1 : kind === 'ao5' ? 0.7 : 0.5;
  shockwave(kind === 'single' ? c.gold : c.accent);
  confetti([c.accent, c.accent2, c.gold, c.ok, c.text],
    { count: Math.round(150 * intensity), power: 0.7 + intensity * 0.5 });
  flash(c.gold);
  if (app.settings.soundOnPB) chime();
  const label = kind === 'single' ? 'New personal best!' : kind === 'ao5' ? 'Best ao5 of the session!' : 'Best ao12 of the session!';
  toast(label, { kind: 'good', timeout: 3200 });
  const d = $('#timer-display');
  if (app.settings.motion !== 'off') {
    d.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.09)' }, { transform: 'scale(1)' }],
      { duration: 640, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  }
}

/* =========================================================
   Rendering
   ========================================================= */
function renderAll() {
  renderStats();
  renderHistory();
  updateLabels();
}

let lastStats = {};
function renderStats() {
  const st = summarize(app.solves);
  const f = v => v === null || v === undefined ? '—' : v === DNF ? 'DNF' : fmt(v);
  const map = { best: st.best, ao5: st.ao5, ao12: st.ao12, ao50: st.ao50, ao100: st.ao100, mean: st.mean, mo3: st.mo3 };

  for (const [k, v] of Object.entries(map)) {
    const node = $('#s-' + k);
    if (!node) continue;
    const txt = f(v);
    if (node.textContent !== txt) {
      node.textContent = txt;
      const cell = node.closest('.stat');
      const prev = lastStats[k];
      if (cell && typeof prev === 'number' && typeof v === 'number' && isFinite(v)) {
        cell.classList.remove('flash-up', 'flash-down');
        void cell.offsetWidth;
        cell.classList.add(v < prev ? 'flash-up' : 'flash-down');
      }
    }
    lastStats[k] = v;
  }

  $('#stat-count').textContent = `${st.count} solve${st.count === 1 ? '' : 's'}`;
  const cons = st.consistency;
  $('#cons-fill').style.width = cons === null ? '0%' : Math.round(cons * 100) + '%';
  $('#cons-val').textContent = cons === null ? '—' : Math.round(cons * 100) + '%';
  void 0;
  renderMiniTrend($('#mini-trend'), app.solves);

  // Collapsed peek: the three numbers worth glancing at mid-session.
  $('#peek-ao5').textContent  = f(st.ao5);
  $('#peek-ao12').textContent = f(st.ao12);
  $('#peek-mo3').textContent  = f(st.mo3);

  // Session bests are O(n x len) to compute, so only when they are on screen.
  if ($('#panel-stats')?.dataset.collapsed === 'false') {
    const b = sessionBests(app.solves);
    for (const k of ['single', 'ao5', 'ao12', 'ao50', 'ao100']) {
      const node = $('#b-' + k);
      if (node) node.textContent = f(b[k]);
    }
  }
}

function renderHistory() {
  const list = $('#hist-list');
  list.innerHTML = '';
  if (!app.solves.length) {
    list.append(el('div', { class: 'hist-empty', text: 'No times yet — hold space and go.' }));
    return;
  }
  const best = bestSingle(app.solves);
  const trim5 = trimmedIndices(app.solves, 5);
  const atTop = list.scrollTop < 8;

  // newest first, cap the strip
  const start = Math.max(0, app.solves.length - 60);
  for (let i = app.solves.length - 1; i >= start; i--) {
    const s = app.solves[i];
    const v = eff(s);
    const cls = [
      'solve-chip',
      s.penalty === 'DNF' ? 'dnf' : '',
      s.penalty === '+2' ? 'plus2' : '',
      v === best && v !== DNF ? 'pb' : '',
      trim5.best.has(i) ? 'best-in-avg' : '',
    ].filter(Boolean).join(' ');

    const chip = el('div', { class: cls, role: 'listitem' },
      el('span', { class: 'idx', text: String(i + 1) }),
      el('span', { class: 't', text: v === DNF ? 'DNF' : fmt(v) + (s.penalty === '+2' ? '+' : '') }),
    );
    chip.addEventListener('click', (e) => solveMenu(s, e.currentTarget));
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); solveMenu(s, e.currentTarget); });
    list.append(chip);
  }
  // Newest is at the top now, so a new solve should not leave you scrolled
  // away from it — unless you had deliberately scrolled down to read older ones.
  if (atTop) list.scrollTop = 0;
}

function updateLabels() {
  const ev = eventOf(app.settings.event);
  const mode = modeOf(app.settings.mode);
  $('#event-label').textContent = ev.name;
  $('#mode-label').textContent = mode.name;
  $('#session-label').textContent = app.session.name;
  $('#btn-mode').classList.toggle('active-mode', app.settings.mode !== 'wca');
  $('#hist-title').textContent = `Times · ${ev.short}`;
  $$('#view-toggle button').forEach(b => b.classList.toggle('on', b.dataset.view === app.settings.cubeView));
}

/* =========================================================
   Solve context menu
   ========================================================= */
function solveMenu(solve, anchor) {
  const setPenalty = async (p) => {
    solve.penalty = solve.penalty === p ? 'none' : p;
    await Solves.put(solve);
    renderAll();
  };
  popover(anchor, [
    { title: `#${app.solves.indexOf(solve) + 1} · ${eff(solve) === DNF ? 'DNF' : fmt(eff(solve))}` },
    { label: 'No penalty', on: solve.penalty === 'none', onSelect: () => setPenalty('none') },
    { label: '+2', badge: '2', on: solve.penalty === '+2', onSelect: () => setPenalty('+2') },
    { label: 'DNF', badge: 'D', on: solve.penalty === 'DNF', onSelect: () => setPenalty('DNF') },
    { sep: true },
    { label: 'Copy scramble', badge: '', onSelect: () => copyToast(solve.scramble, 'Scramble') },
    { label: solve.comment ? 'Edit comment' : 'Add comment', badge: 'C', onSelect: () => commentOn(solve) },
    { label: 'Repeat this scramble', badge: 'R', onSelect: () => repeatScramble(solve) },
    { sep: true },
    { label: 'Delete solve', badge: 'Del', onSelect: () => deleteThrottled(solve) },
  ]);
}
app.solveMenu = solveMenu;

/**
 * Put an old scramble back on the board so it can be solved again. The next
 * solve records this scramble, which is the whole point — "show it" without
 * arming it would just be a picture.
 */
function repeatScramble(solve) {
  if (!solve.scramble) { toast('That solve has no scramble saved'); return; }
  timer.reset();
  showScramble({ scramble: solve.scramble, caseId: solve.caseId, caseName: solve.caseName });
  toast(`Repeating solve #${app.solves.indexOf(solve) + 1}`, { kind: 'good' });
}
app.repeatScramble = repeatScramble;

function commentOn(solve) {
  const text = prompt('Comment on this solve', solve.comment || '');
  if (text === null) return;
  solve.comment = text;
  Solves.put(solve).then(() => toast('Comment saved'));
}

/**
 * Deleting is one key away from the times list, and holding the key down used
 * to walk backwards through the session a solve per keyrepeat — a whole run
 * gone before your finger came off. One deletion per cooldown, and a held key
 * simply does nothing after the first.
 */
const DELETE_COOLDOWN_MS = 600;
let lastDeleteAt = 0;

function deleteThrottled(solve) {
  const now = performance.now();
  if (now - lastDeleteAt < DELETE_COOLDOWN_MS) return false;
  lastDeleteAt = now;
  deleteSolve(solve);
  return true;
}

async function deleteSolve(solve) {
  const i = app.solves.indexOf(solve);
  if (i === -1) return;
  app.solves.splice(i, 1);
  await Solves.del(solve.id);
  app.lastDeleted = solve;
  app.sessionCounts.set(app.session.id, app.solves.length);
  renderAll();
  toast(`Deleted ${eff(solve) === DNF ? 'DNF' : fmt(eff(solve))}`, {
    action: 'undo',
    onAction: async () => {
      app.solves.push(solve);
      app.solves.sort((a, b) => a.createdAt - b.createdAt);
      await Solves.put(solve);
      app.lastDeleted = null;
      renderAll();
    },
  });
}

async function undoDelete() {
  if (!app.lastDeleted) { toast('Nothing to undo'); return; }
  const s = app.lastDeleted;
  app.lastDeleted = null;
  app.solves.push(s);
  app.solves.sort((a, b) => a.createdAt - b.createdAt);
  await Solves.put(s);
  renderAll();
  toast('Restored');
}

/* =========================================================
   Sessions
   ========================================================= */
async function refreshCounts() {
  const all = await Solves.all();
  app.sessionCounts = new Map();
  for (const s of all) app.sessionCounts.set(s.sessionId, (app.sessionCounts.get(s.sessionId) || 0) + 1);
}

app.switchSession = async (id) => {
  const s = app.sessions.find(x => x.id === id);
  if (!s) return;
  app.session = s;
  app.settings.sessionId = id;
  if (s.event) { app.settings.event = s.event; syncEventConfig(); }
  app.solves = await Solves.bySession(id);
  lastStats = {};
  persist();
  refreshQueue(); nextScramble();
  renderAll();
  toast(`Switched to ${s.name}`);
};

app.newSession = async () => {
  const n = app.sessions.filter(s => s.event === app.settings.event).length + 1;
  const s = {
    id: uid(),
    name: `${eventOf(app.settings.event).short} · ${n}`,
    event: app.settings.event,
    createdAt: Date.now(),
    order: app.sessions.length,
  };
  await Sessions.put(s);
  app.sessions.push(s);
  await app.switchSession(s.id);
};

app.saveSession = async (s) => { await Sessions.put(s); updateLabels(); };

app.deleteSession = async (id) => {
  await Solves.clearSession(id);
  await Sessions.del(id);
  app.sessions = app.sessions.filter(s => s.id !== id);
  app.sessionCounts.delete(id);
  if (app.session.id === id) await app.switchSession(app.sessions[0].id);
};

async function clearSession() {
  if (!app.solves.length) { toast('Session is already empty'); return; }
  if (!await confirmToast(`Delete all ${app.solves.length} solves in "${app.session.name}"?`, 'clear it')) return;
  const backup = [...app.solves];
  await Solves.clearSession(app.session.id);
  app.solves = [];
  app.sessionCounts.set(app.session.id, 0);
  lastStats = {};
  renderAll();
  toast(`Cleared ${backup.length} solves`, {
    action: 'undo',
    timeout: 9000,
    onAction: async () => {
      await Solves.putMany(backup);
      app.solves = backup;
      app.sessionCounts.set(app.session.id, backup.length);
      renderAll();
    },
  });
}

/* =========================================================
   Settings plumbing
   ========================================================= */
function persist() { saveSettings(app.settings); }
app.persist = persist;

app.setSetting = (k, v) => {
  app.settings[k] = v;
  persist();
  applyAll(k);
};

function applyAll(changed) {
  applyTheme(app.settings);
  // bgSolid and bgGradient were missing here, so editing the background colour
  // or the gradient string did nothing at all until some unrelated setting
  // happened to trigger a re-apply.
  if (!changed || ['bgMode','bgShader','bgSpeed','bgAmount','theme','accent','accent2',
                   'bgDim','bgSolid','bgGradient','autoContrast'].includes(changed)) {
    applyBackground(bg, app.settings);
  }
  if (timer) {
    timer.cfg.inspection = app.settings.inspection;
    timer.cfg.holdTime = app.settings.holdTime;
    timer.cfg.precision = app.settings.precision;
    timer.cfg.useInspection = !eventOf(app.settings.event).noInspection;
  }
  if (changed === 'hintFacelets') cube.setHints(app.settings.hintFacelets);
  // A bigger preview can push a dragged widget off screen, so re-clamp it.
  if (changed === 'cubeSize') cubeDrag?.apply();
  if (!changed || ['scrambleSize', 'density', 'sidebarWidth', 'panelStyle'].includes(changed)) {
    fitScrambleToLine($('#scramble-text'));
  }
  if (changed === 'cubeView') { updateLabels(); if (app.scramble) showScramble(app.scramble, true); }
}
app.applyAll = () => applyAll();
app.refreshBackground = () => applyBackground(bg, app.settings);

function syncEventConfig() {
  const ev = eventOf(app.settings.event);
  if (timer) timer.cfg.useInspection = !ev.noInspection;
  // trainer modes only exist for 3x3 — fall back if the event changed
  if (!modesForEvent(app.settings.event).includes(app.settings.mode)) app.settings.mode = 'wca';
}

async function setEvent(id) {
  app.settings.event = id;
  app.session.event = id;
  await Sessions.put(app.session);
  syncEventConfig();
  // Swap the preview puzzle straight away. A 4x4 random-state scramble takes a
  // few seconds, and leaving the old puzzle on screen until it lands looks broken.
  const ev = eventOf(id);
  cube.configure(ev.puzzle, modeOf(app.settings.mode).view || app.settings.cubeView);
  timer.reset();
  persist();
  app.scrambleHistory = [];
  refreshQueue(); nextScramble({ clear: true });
  renderAll();
}

function setMode(id) {
  app.settings.mode = id;
  persist();
  timer.reset();
  app.scrambleHistory = [];
  refreshQueue(); nextScramble({ clear: true });
  updateLabels();
}

app.setEvent = setEvent;
app.setMode = setMode;

app.reload = async () => {
  app.sessions = await Sessions.all();
  await refreshCounts();
  app.solves = await Solves.bySession(app.session.id);
  lastStats = {};
  renderAll();
  closeDrawer();
};

app.allSolves = () => Solves.all();

app.exportSessionCSV = () => {
  const rows = [['#', 'time', 'penalty', 'scramble', 'case', 'comment', 'date']];
  app.solves.forEach((s, i) => rows.push([
    i + 1, (s.timeMs / 1000).toFixed(3), s.penalty, s.scramble.replace(/\n/g, ' '),
    s.caseName || '', s.comment || '', new Date(s.createdAt).toISOString(),
  ]));
  download(`${app.session.name.replace(/\W+/g, '-')}.csv`, toCSV(rows), 'text/csv');
  toast('CSV downloaded', { kind: 'good' });
};

/* ---------------- csTimer import ---------------- */
app.importCsTimer = async (data) => {
  let names = {};
  try {
    const props = data.properties?.sessionData;
    if (props) {
      const parsed = typeof props === 'string' ? JSON.parse(props) : props;
      for (const [k, v] of Object.entries(parsed)) names[k] = v.name || `csTimer ${k}`;
    }
  } catch { /* names are optional */ }

  let imported = 0;
  for (const [key, value] of Object.entries(data)) {
    const m = key.match(/^session(\d+)$/);
    if (!m || !Array.isArray(value) || !value.length) continue;
    const num = m[1];
    const sess = {
      id: uid(),
      name: names[num] || `csTimer ${num}`,
      event: '333',
      createdAt: Date.now(),
      order: app.sessions.length,
    };
    const solves = [];
    for (const item of value) {
      if (!Array.isArray(item) || !Array.isArray(item[0])) continue;
      const [pen, ms] = item[0];
      solves.push({
        id: uid(),
        sessionId: sess.id,
        event: '333',
        mode: 'wca',
        scramble: item[1] || '',
        timeMs: ms,
        penalty: pen === -1 ? 'DNF' : pen === 2000 ? '+2' : 'none',
        comment: item[2] || '',
        caseId: null, caseName: null,
        createdAt: (item[3] ? item[3] * 1000 : Date.now()),
      });
    }
    if (!solves.length) continue;
    await Sessions.put(sess);
    await Solves.putMany(solves);
    app.sessions.push(sess);
    imported += solves.length;
  }
  if (!imported) throw new Error('no sessions found in that file');
  await refreshCounts();
  closeDrawer();
  return imported;
};

/* =========================================================
   Input — keyboard + touch
   ========================================================= */
const isTyping = () => {
  const a = document.activeElement;
  if (!a) return false;
  const editable = a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable;
  // A focused field inside a closed overlay must not count as typing, or the
  // whole keyboard — spacebar included — goes dead.
  return editable && a.offsetParent !== null;
};
const modalOpen = () => drawerOpen() || paletteOpen() || popoverOpen();

function wireInput() {
  let spaceDown = false;

  document.addEventListener('keydown', (e) => {
    if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (modalOpen()) return;
      if (spaceDown) return;
      spaceDown = true;
      timer.down();
    } else if (timer.state === 'running') {
      // any key stops the timer
      e.preventDefault();
      timer.down();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      if (isTyping() || modalOpen()) return;
      e.preventDefault();
      timer.up();
    }
  });

  // Touch / pen always drive the timer — on a phone there is no other way to
  // start it. A mouse click does not, unless you ask for it: reaching for the
  // mouse mid-session, or a stray click anywhere on the stage, would otherwise
  // start or stop a solve you never meant to touch.
  const zone = $('#timer-zone');
  const pointerOK = (e) => (e.pointerType !== 'mouse') || app.settings.mouseTimer;
  const touchOK = (e) => !modalOpen() && !e.target.closest('button, a, input, select, .solve-chip, .panel, #topbar');

  const down = (e) => { if (!pointerOK(e) || !touchOK(e)) return; e.preventDefault(); timer.down(); };
  const up   = (e) => { if (!pointerOK(e) || modalOpen()) return; timer.up(); };

  for (const target of [zone, $('#stage')]) {
    target.addEventListener('pointerdown', down);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  window.addEventListener('blur', () => { spaceDown = false; if (timer.state !== 'running') timer.reset(); });
}

/* =========================================================
   Chrome (top bar, history strip, scramble tools)
   ========================================================= */
/** Copy, then say what actually happened rather than assuming it worked. */
async function copyToast(text, label = 'Copied') {
  if (!text) { toast('Nothing to copy'); return; }
  if (await copy(text)) toast(`${label} copied`, { kind: 'good' });
  else toast('Your browser blocked the clipboard', { kind: 'bad' });
}
app.copyToast = copyToast;

const STAT_TITLES = {
  best: 'Best single', ao5: 'Average of 5', ao12: 'Average of 12',
  ao50: 'Average of 50', ao100: 'Average of 100', mean: 'Session mean',
};

function wireChrome() {
  $('#btn-event').addEventListener('click', (e) => {
    popover(e.currentTarget, EVENT_ORDER.map(id => ({
      label: EVENTS[id].name,
      badge: EVENTS[id].short,
      on: id === app.settings.event,
      onSelect: () => setEvent(id),
    })), { columns: 2, minWidth: 400 });
  });

  $('#btn-mode').addEventListener('click', (e) => {
    const list = modesForEvent(app.settings.event).map(id => ({
      label: MODES[id].name,
      badge: MODES[id].kind === 'wca' ? 'WCA' : '',
      on: id === app.settings.mode,
      onSelect: () => setMode(id),
    }));
    if (setFor(app.settings.mode)) {
      list.push({ sep: true }, { label: 'Pick cases…', badge: 'K', onSelect: () => openDrawer('Cases', buildCases(app)) });
    }
    popover(e.currentTarget, [{ title: 'Scramble mode' }, ...list]);
  });

  $('#btn-session').addEventListener('click', (e) => {
    const list = app.sessions.map(s => ({
      label: s.name,
      badge: String(app.sessionCounts.get(s.id) || 0),
      on: s.id === app.session.id,
      onSelect: () => app.switchSession(s.id),
    }));
    popover(e.currentTarget, [
      { title: 'Sessions' }, ...list, { sep: true },
      { label: '+ New session', onSelect: () => app.newSession() },
      { label: 'Manage…', onSelect: () => openDrawer('Sessions', buildSessions(app)) },
    ]);
  });

  $('#btn-stats').addEventListener('click', () => openDrawer('Statistics', buildStats(app), { wide: true }));
  $('#btn-theme').addEventListener('click', () => openDrawer('Appearance', buildAppearance(app)));
  $('#btn-settings').addEventListener('click', () => openDrawer('Settings', buildSettings(app)));
  $('#btn-help').addEventListener('click', () => openDrawer('Keyboard shortcuts', buildShortcuts(), { wide: true }));
  $('#btn-about').addEventListener('click', () => openDrawer('About', buildAbout(app)));
  $('#btn-open-history').addEventListener('click', () => openDrawer('All solves', buildHistory(app), { wide: true }));

  // stats stay folded away until you ask for them
  const statsPanel = $('#panel-stats');
  const statsToggle = $('#stats-toggle');
  const applyStatsCollapsed = (collapsed) => {
    statsPanel.dataset.collapsed = String(collapsed);
    statsToggle.setAttribute('aria-expanded', String(!collapsed));
    statsToggle.title = collapsed ? 'Show statistics' : 'Hide statistics';
  };
  applyStatsCollapsed(app.settings.statsCollapsed !== false);
  statsToggle.addEventListener('click', () => {
    const collapsed = statsPanel.dataset.collapsed !== 'true';
    applyStatsCollapsed(collapsed);
    app.setSetting('statsCollapsed', collapsed);
    if (!collapsed) renderStats();
  });
  app.expandStats = () => { applyStatsCollapsed(false); app.setSetting('statsCollapsed', false); renderStats(); };
  // Every statistic opens the solves behind it — times, scrambles, and a copy
  // button for pasting the lot somewhere else.
  $$('.stat[data-k]').forEach((cell) => {
    const k = cell.dataset.k;
    cell.title = 'See the solves behind this';
    cell.addEventListener('click', () => openDrawer(STAT_TITLES[k] || k, buildStatDetail(app, k), { wide: true }));
  });

  $('#mini-chart-btn')?.addEventListener('click', () =>
    openDrawer('Statistics', buildStats(app), { wide: true }));

  $('#btn-clear-session').addEventListener('click', clearSession);

  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);

  $('#btn-next-scramble').addEventListener('click', forwardScramble);
  $('#btn-prev-scramble').addEventListener('click', prevScramble);
  $('#btn-copy-scramble').addEventListener('click', () => copyToast(app.scramble?.scramble || '', 'Scramble'));
  $('#scramble-text').addEventListener('click', () => copyToast(app.scramble?.scramble || '', 'Scramble'));

  $$('#view-toggle button[data-view="3D"], #view-toggle button[data-view="2D"]').forEach(b =>
    b.addEventListener('click', () => app.setSetting('cubeView', b.dataset.view)));

  // Drag the preview anywhere on screen; the 2D/3D buttons inside it stay
  // clickable, and the position survives a reload.
  cubeDrag = makeDraggable($('#panel-cube'), {
    handle: '#cube-grip',
    get: () => app.settings.cubePos,
    set: (pos) => { app.settings.cubePos = pos; persist(); },
  });
  app.resetCubePosition = () => { cubeDrag.reset(); toast('Preview back in its corner'); };

  // Spinning the cube only helps if the angle survives the next scramble and
  // the next visit, so read it back whenever a drag on the cube itself ends.
  const rememberOrbit = debounce(async () => {
    const orbit = await cube.getOrbit();
    if (!orbit) return;
    app.settings.cubeOrbit = orbit;
    persist();
  }, 400);
  for (const ev of ['pointerup', 'pointercancel', 'wheel']) {
    $('#cube-holder').addEventListener(ev, rememberOrbit, { passive: true });
  }

  app.resetCubeOrbit = () => {
    cube.clearOrbit();
    app.settings.cubeOrbit = null;
    persist();
    toast('Cube angle reset');
  };
  $('#btn-reset-orbit').addEventListener('click', (e) => { e.stopPropagation(); app.resetCubeOrbit(); });

  $('#brand').addEventListener('click', () => {
    document.body.classList.toggle('zen');
    toast(document.body.classList.contains('zen') ? 'Zen mode — press Z to exit' : 'Zen mode off');
  });
}

/* =========================================================
   Keyboard shortcuts
   ========================================================= */
function wireShortcuts() {
  document.addEventListener('keydown', async (e) => {
    if (isTyping()) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;

    // palette
    if (mod && k.toLowerCase() === 'k') { e.preventDefault(); return openPaletteWithCommands(); }
    if (k === '/' && !mod && !paletteOpen()) { e.preventDefault(); return openPaletteWithCommands(); }
    if (mod && k.toLowerCase() === 'c' && !window.getSelection().toString()) {
      e.preventDefault(); return copyToast(app.scramble?.scramble || '', 'Scramble');
    }
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); return undoDelete(); }
    if (mod && e.shiftKey && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); return clearSession(); }

    if (k === 'Escape') {
      if (paletteOpen()) return closePalette();
      if (drawerOpen()) return closeDrawer();
      if (popoverOpen()) return closePopover();
      if (timer.cancel()) return;
      if (document.body.classList.contains('zen')) document.body.classList.remove('zen');
      return;
    }

    if (mod || e.altKey || modalOpen()) return;
    if (timer.state !== 'idle' && timer.state !== 'cooldown') return;

    const last = app.solves.at(-1);
    const setPen = async (p) => {
      if (!last) return toast('No solves yet');
      last.penalty = last.penalty === p ? 'none' : p;
      await Solves.put(last);
      renderAll();
      toast(last.penalty === 'none' ? 'Penalty cleared' : `${last.penalty} applied`);
    };

    switch (k) {
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (e.repeat) break;                   // a held key is one intent, not many
        if (!last) toast('No solves yet');
        else if (!deleteThrottled(last)) toast('One at a time — undo is Ctrl+Z');
        break;
      case '2': e.preventDefault(); setPen('+2'); break;
      case 'd': case 'D': e.preventDefault(); setPen('DNF'); break;
      case '0': e.preventDefault(); setPen('none'); break;
      case 'c': case 'C': e.preventDefault(); if (last) commentOn(last); break;
      case 'r': case 'R':
        e.preventDefault();
        if (last) repeatScramble(last); else toast('No solves yet');
        break;

      case 'n': case 'N': e.preventDefault(); forwardScramble(); break;
      case 'ArrowLeft':  e.preventDefault(); prevScramble(); break;
      case 'ArrowRight': e.preventDefault(); forwardScramble(); break;

      case 'e': case 'E': e.preventDefault(); $('#btn-event').click(); break;
      case 'm': case 'M': e.preventDefault(); $('#btn-mode').click(); break;
      case 's': case 'S': e.preventDefault(); $('#btn-session').click(); break;
      case 'a': case 'A': e.preventDefault(); $('#btn-stats').click(); break;
      case 'h': case 'H': e.preventDefault(); $('#btn-open-history').click(); break;
      case 't': case 'T': e.preventDefault(); $('#btn-theme').click(); break;
      case ',':           e.preventDefault(); $('#btn-settings').click(); break;
      case '?':           e.preventDefault(); $('#btn-help').click(); break;
      case 'b': case 'B': e.preventDefault(); $('#btn-about').click(); break;
      case 'k': case 'K':
        e.preventDefault();
        if (setFor(app.settings.mode)) openDrawer('Cases', buildCases(app));
        else toast('Current mode has no case list');
        break;

      case 'z': case 'Z':
        e.preventDefault(); document.body.classList.toggle('zen'); break;
      case 'f': case 'F':
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
        break;
      case 'v': case 'V':
        e.preventDefault();
        app.setSetting('cubeView', app.settings.cubeView === '3D' ? '2D' : '3D');
        if (app.scramble) showScramble(app.scramble, true);
        break;
      case 'i': case 'I':
        e.preventDefault();
        app.setSetting('inspection', !app.settings.inspection);
        toast(`Inspection ${app.settings.inspection ? 'on' : 'off'}`);
        break;
      default: break;
    }
  });
}

/* =========================================================
   Command palette contents
   ========================================================= */
function openPaletteWithCommands() {
  openPalette(() => {
    const out = [];
    for (const id of EVENT_ORDER) {
      out.push({ kind: 'event', label: EVENTS[id].name, keywords: EVENTS[id].short, run: () => setEvent(id) });
    }
    for (const id of modesForEvent(app.settings.event)) {
      out.push({ kind: 'mode', label: MODES[id].name, keywords: MODES[id].desc, run: () => setMode(id) });
    }
    for (const s of app.sessions) {
      out.push({ kind: 'session', label: s.name, run: () => app.switchSession(s.id) });
    }
    out.push(
      { kind: 'go', label: 'Statistics', key: 'A', run: () => $('#btn-stats').click() },
      { kind: 'go', label: 'All solves', key: 'H', run: () => $('#btn-open-history').click() },
      { kind: 'go', label: 'Appearance', key: 'T', run: () => $('#btn-theme').click() },
      { kind: 'go', label: 'Settings', key: ',', run: () => $('#btn-settings').click() },
      { kind: 'go', label: 'Keyboard shortcuts', key: '?', run: () => $('#btn-help').click() },
      { kind: 'go', label: 'About', key: 'B', run: () => $('#btn-about').click() },
      { kind: 'go', label: 'Pick trainer cases', key: 'K', run: () => setFor(app.settings.mode) ? openDrawer('Cases', buildCases(app)) : toast('Current mode has no case list') },
      { kind: 'do', label: 'New session', run: () => app.newSession() },
      { kind: 'do', label: 'New scramble', key: 'N', run: forwardScramble },
      { kind: 'do', label: 'Copy scramble', run: () => copyToast(app.scramble?.scramble || '', 'Scramble') },
      { kind: 'do', label: 'Toggle inspection', key: 'I', run: () => { app.setSetting('inspection', !app.settings.inspection); toast(`Inspection ${app.settings.inspection ? 'on' : 'off'}`); } },
      { kind: 'do', label: 'Zen mode', key: 'Z', run: () => document.body.classList.toggle('zen') },
      { kind: 'do', label: 'Fullscreen', key: 'F', run: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.() },
      { kind: 'do', label: 'Export backup', run: () => $('#btn-settings').click() },
      { kind: 'do', label: 'Clear this session', run: clearSession },
    );
    for (const [id, p] of Object.entries({
      nebula: 'Nebula', carbon: 'Carbon', vaporwave: 'Vaporwave', ice: 'Ice',
      terminal: 'Terminal', speedcube: 'Speedcube', paper: 'Paper',
    })) {
      out.push({ kind: 'theme', label: p, run: () => { app.setSetting('accent', ''); app.setSetting('accent2', ''); app.setSetting('theme', id); toast(`${p} theme`); } });
    }
    return out;
  });
}

/* keep unused imports honest */
void Assets; void KV; void beep; void byCase;
