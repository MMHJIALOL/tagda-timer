/* ===========================================================
   Tagda Timer — application wiring
   =========================================================== */

import { $, $$, el, uid, fmt, fmtLive, clamp, copy, download, toCSV, debounce,
         parseTimeInput, parseScrambleList } from './util.js';
import { Solves, Sessions, KV, Assets, importAll } from './db.js';
import { EVENTS, EVENT_ORDER, MODES, modesForEvent, eventOf, modeOf } from './events.js';
import { ScrambleQueue, setFor, cubingAvailable } from './scramble.js';
import { Timer, INSPECT_MS } from './timer.js';
import { Background } from './bg.js';
import { CubeView } from './cube.js';
import { makeDraggable } from './drag.js';
import { flash, shockwave, confetti, chime, callout, beep } from './fx.js';
import { summarize, eff, DNF, bestSingle, bestAvg, trimmedIndices, byCase, sessionBests, rollingSeries } from './stats.js';
import { renderMiniTrend } from './charts.js';
import { loadSettings, saveSettings, applyTheme, applyBackground, themeColors, setAlbumTint } from './theme.js';
import { SPOTIFY_CLIENT_ID, DEV_MODE_LIMIT, OWNER_NEEDS_PREMIUM } from './spotifyapp.js';
import { popover, closePopover, popoverOpen } from './popover.js';
import { toast, confirmToast } from './toast.js';
import { openPalette, closePalette, paletteOpen } from './palette.js';
/* panels.js, sharedlg.js (which drags in sharecard.js and cubenet.js) and
   stackmat.js are imported where they are first needed, not here — see
   "Lazily loaded modules" below. Between them they were about 82KB of the
   startup graph that no one needs in order to scramble and time a solve. */

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
  // What Ctrl+Z would put back: {solves, sessionId, label}. Deliberately not
  // held in a toast's closure — toasts are gone in a second, and undo has to
  // outlive the message that mentions it.
  lastDeleted: null,
  // A pasted list of scrambles, handed out in order ahead of the generator.
  // Kept as a plain array plus a cursor: pasting a thousand of them costs one
  // allocation and every advance is an index bump.
  custom: { list: [], pos: 0 },
};
window.tagdatimer = app;   // handy in the console
// The boot guard in index.html only exists to catch "the modules never
// loaded". Once this file is evaluating, they did — anything that goes wrong
// from here is a real error worth reporting, not a dead-page diagnosis.
window.__tdtBooted = true;

/* =========================================================
   Lazily loaded modules

   None of these are reachable until you open something: the drawers, the
   share-card dialog, or a Stackmat. Each loader is idempotent — the promise
   is kept, so a second click while the first import is still in flight waits
   on the same request rather than starting another.

   The sync shims matter: closeDrawer/drawerOpen/shareOpen are called from the
   keydown handler and from modalOpen(), which cannot await. They are also
   trivially answerable before the module exists — nothing can be open if the
   code that opens it has never run.
   ========================================================= */
/**
 * Remember the request, but never remember a failed one.
 *
 * `??=` on the bare promise looks right and is a trap: a rejected promise is
 * still a promise, so one failed fetch — a flaky connection, a deploy mid-click
 * — would be cached forever and every later click would reject instantly off
 * the same dead value, with no way back short of a reload. Clearing the slot in
 * the catch makes the next click a real retry.
 */
function lazy(load, onLoad) {
  let req = null;
  return () => (req ??= load().then(onLoad).catch(err => { req = null; throw err; }));
}

let _panels = null;
const loadPanels = lazy(() => import('./panels.js'), m => (_panels = m));

let _share = null;
const loadShare = lazy(() => import('./sharedlg.js'), m => (_share = m));

let _recon = null;
const loadRecon = lazy(() => import('./recon.js'), m => (_recon = m));

/** Nothing to open is better than a click that silently does nothing. */
function lazyFailed(what, err) {
  console.warn(`[lazy] could not load ${what}`, err);
  toast(`Could not open ${what} — check your connection and try again`, { kind: 'bad' });
}

/* =========================================================
   Album theming — the page takes its colours from what is playing

   Both modules load on demand like the panels do: nobody who has not linked
   an account should pay for the OAuth client or the colour quantiser. See
   SPOTIFY.md.
   ========================================================= */
const loadSpotify = lazy(() => import('./spotify.js'), m => m);
const loadPalette = lazy(() => import('./albumpalette.js'), m => m);

/**
 * The app to authenticate against: the built-in one unless somebody has
 * deliberately supplied their own. The override exists because the built-in
 * app is capped at 5 listed users — see spotifyapp.js.
 */
const clientId = () => app.settings.spotifyClientId || SPOTIFY_CLIENT_ID;
const usingOwnApp = () => !!app.settings.spotifyClientId;

/** null until a link is attempted; the poller lives here once it is. */
let spotify = null;
/** Set when a palette arrives mid-attempt and has to wait for idle. */
let pendingTint = null;
/** Whether this origin may read pixels off i.scdn.co — probed, never assumed. */
let artworkReadable = null;
/** Set when Spotify answers a valid token with 403: linked, but not allowed. */
let accessDenied = false;

const drawerOpen  = () => !!_panels && _panels.drawerOpen();
const closeDrawer = () => { _panels?.closeDrawer(); };
const shareOpen   = () => !!_share && _share.shareOpen();
const closeShare  = () => { _share?.closeShare(); };
const reconOpen   = () => !!_recon && _recon.reconOpen();
const closeRecon  = () => _recon ? _recon.closeRecon() : false;

/**
 * The reconstruction workbench. Nothing about it is loaded until somebody asks
 * for it — it drags in a solver and a second cube renderer, and most sessions
 * never open it.
 */
async function openRecon(opts) {
  let m;
  try { m = await loadRecon(); }
  catch (err) { return lazyFailed('the reconstructor', err); }
  timer.reset?.();
  return m.openRecon(opts);
}

/** The session's solves, as things the workbench can jump straight into. */
function reconLibrary() {
  return app.solves.filter(s => s.scramble).slice(-60).reverse().map((s) => ({
    label: `#${app.solves.indexOf(s) + 1} · ${eff(s) === DNF ? 'DNF' : fmt(eff(s))}`,
    scramble: s.scramble,
    moves: s.recon || '',
    save: (moves) => { s.recon = moves; Solves.put(s).catch(() => {}); },
  }));
}

/** Reconstruct a recorded solve, remembering the work on the solve itself. */
function reconstructSolve(solve) {
  if (!solve?.scramble) { toast('That solve has no scramble saved'); return; }
  const n = app.solves.indexOf(solve) + 1;
  return openRecon({
    scramble: solve.scramble,
    title: `#${n} · ${eff(solve) === DNF ? 'DNF' : fmt(eff(solve))}`,
    moves: solve.recon || '',
    onSave: (moves) => { solve.recon = moves; Solves.put(solve).catch(() => {}); },
    library: reconLibrary(),
  });
}
app.reconstructSolve = reconstructSolve;

/**
 * Open a drawer, fetching panels.js on first use.
 * The builder is named rather than passed, because the function itself does
 * not exist yet at the call site.
 */
async function openPanel(title, builder, opts, ...args) {
  let m;
  try { m = await loadPanels(); }
  catch (err) { return lazyFailed(title.toLowerCase(), err); }
  m.openDrawer(title, m[builder](...args), opts);
}

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
  wireManualEntry();
  wireHistoryScroll();

  // A pasted scramble list outlives a reload — losing your competition round
  // to an accidental refresh would be the whole feature failing at its job.
  try {
    const saved = await KV.get('customScrambles', null);
    if (saved && Array.isArray(saved.list) && saved.pos < saved.list.length) {
      app.custom = { list: saved.list, pos: saved.pos | 0 };
    }
  } catch { /* an unreadable list is not worth failing the boot over */ }
  updateCustomBar();

  // The scrambler is the only thing anyone actually waits for, so it starts
  // before the decoration does rather than queueing behind it.
  queue.onReady = () => { if (!app.scramble) nextScramble(); };
  refreshQueue();
  nextScramble();

  renderAll();
  syncTimerDisplay();
  applyInputMode();
  bootAnimation();

  // Everything below is decoration or bookkeeping and is deliberately not
  // awaited: the timer is usable the moment the lines above have run.

  /* Ask the browser to stop treating the solve history as disposable.
     Without this an origin's IndexedDB is "best effort": the browser may evict
     the whole thing whenever it wants the space back, and for an app whose
     entire premise is that thousands of solves live on your own machine, that
     is a silent way to lose all of them. Chrome grants this without a prompt on
     a site you actually use; Firefox may ask. A refusal is not an error — it
     just means the Settings backup is the only safety net there is. */
  navigator.storage?.persist?.()
    .then(ok => { if (!ok) console.info('[storage] not persistent — the browser may evict solves; keep a backup'); })
    .catch(() => {});

  // Counting every solve in the database only feeds the badges in the session
  // picker. It used to block the boot for as long as that read took.
  refreshCounts().catch(() => {});

  // A broken shader, a missing blob, a browser with WebGL switched off — none
  // of that is a reason for the timer not to start.
  applyBackground(bg, app.settings).catch(err => console.warn('[bg] could not apply background', err));

  // Album theming, if it was ever linked. Also picks up the ?code= we may have
  // just been redirected back with.
  syncSpotifyPanel();
  startAlbumTheming().catch(err => console.warn('[spotify] not started', err));

  cube.orbit = app.settings.cubeOrbit;
  cube.init().then(() => {
    cube.setHints(app.settings.hintFacelets);
    if (app.scramble) showScramble(app.scramble, true);
  }).catch((err) => {
    console.warn('[cube] failed to initialise', err);
    cube.showFallback('preview unavailable');
  });

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
    // No blur here on purpose. Animating `filter` on six full-width elements
    // forces a fresh offscreen composite every frame of the first second the
    // page is alive — exactly when the scrambler and the cube module are
    // competing for the same main thread. Opacity and transform are free.
    p.animate(
      [{ opacity: 0, transform: 'translateY(12px) scale(.99)' },
       { opacity: 1, transform: 'none' }],
      { duration: 460, delay: 40 + i * 45, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
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
  // A pasted list always wins: while one is loaded, the generator is not
  // consulted at all, so the order you pasted is the order you get.
  const own = takeCustom();
  if (own) {
    app.scrambleHistory.push(own);
    if (app.scrambleHistory.length > 40) app.scrambleHistory.shift();
    app.historyPos = app.scrambleHistory.length - 1;
    showScramble(own);
    return;
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

/* ---------------- custom scramble list ---------------- */

/** Next unused scramble from the pasted list, or null when it is spent. */
function takeCustom() {
  const c = app.custom;
  if (!c.list.length || c.pos >= c.list.length) return null;
  const i = c.pos++;
  saveCustom();
  updateCustomBar();
  if (c.pos >= c.list.length) {
    toast(`Last of your ${c.list.length} scrambles — generated after this one`);
  }
  return { scramble: c.list[i], official: false, custom: true, customIndex: i + 1, customTotal: c.list.length };
}

function saveCustom() {
  // Persisted outside `settings`: a thousand pasted scrambles have no business
  // in an object that is rewritten on every slider drag.
  KV.set('customScrambles', { list: app.custom.list, pos: app.custom.pos }).catch(() => {});
}

function updateCustomBar() {
  const bar = $('#custom-bar');
  if (!bar) return;
  const c = app.custom;
  // A spent list keeps its bar only while one of its own scrambles is still on
  // screen; once the generator takes over, saying "custom 4 / 4" over a
  // generated scramble is just a lie.
  const live = c.list.length > 0 && (c.pos < c.list.length || !!app.scramble?.custom);
  bar.hidden = !live;
  if (live) {
    $('#custom-pos').textContent = `custom ${Math.min(c.pos, c.list.length)} / ${c.list.length}`;
    bar.classList.toggle('spent', c.pos >= c.list.length);
  }
}
app.updateCustomBar = updateCustomBar;

/**
 * Load a pasted block. `append` keeps whatever is left of the current list,
 * which is what you want when you paste a second competition round in.
 */
app.setCustomScrambles = (text, { append = false } = {}) => {
  const list = parseScrambleList(text);
  const c = app.custom;
  if (append && c.list.length) {
    c.list = c.list.concat(list);
  } else {
    c.list = list;
    c.pos = 0;
  }
  saveCustom();
  updateCustomBar();
  if (!list.length) { toast('No scrambles found in that text', { kind: 'bad' }); return 0; }
  closeDrawer();
  // Show the first one straight away rather than making you press next.
  if (!append || c.pos >= c.list.length - list.length) nextScramble();
  toast(`${list.length} scramble${list.length === 1 ? '' : 's'} loaded`, { kind: 'good' });
  return list.length;
};

app.clearCustomScrambles = ({ quiet = false } = {}) => {
  app.custom = { list: [], pos: 0 };
  saveCustom();
  updateCustomBar();
  if (!quiet) { nextScramble(); toast('Back to generated scrambles'); }
};

app.restartCustomScrambles = () => {
  if (!app.custom.list.length) return;
  app.custom.pos = 0;
  saveCustom();
  nextScramble();
  toast('Back to the first of your scrambles');
};

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

  if (s.custom && s.customIndex) {
    const bar = $('#custom-bar');
    if (bar) {
      bar.hidden = false;
      $('#custom-pos').textContent = `custom ${s.customIndex} / ${s.customTotal}`;
    }
  } else updateCustomBar();

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
      // The !! is load-bearing. `hideDuringSolve` is undefined on every event
      // that does not set it, and classList.toggle() with an undefined second
      // argument ignores it and *flips* the class — so on 3x3 the digits went
      // dark on every other solve.
      display.classList.toggle('hidden-digits',
        !!(app.settings.hideWhileRunning || eventOf(app.settings.event).hideDuringSolve));
      pen.textContent = '';
      if (app.settings.paceGhost) startPace(pace, paceFill);
    } else if (st === 'idle') {
      // A track that changed mid-attempt has been waiting for exactly this.
      if (pendingTint) {
        const { colors } = pendingTint;
        pendingTint = null;
        setAlbumTint(colors, app.settings);
        bgFromTheme();
      }
      bg.setSlow(1);
      ring.classList.remove('on');
      readout.hidden = true;
      pace.hidden = true;
      display.classList.remove('hidden-digits');
      document.documentElement.style.removeProperty('--breathe');
    }
  });

  timer.addEventListener('inspectstart', () => {
    insp = { num: '', numColor: '', stroke: '', breathe: '', tint: '' };
    sizeRing();
    ring.classList.add('on');
    readout.hidden = false;
    main.style.opacity = '0';
    ringRect.style.strokeDasharray = ringLen;
    ringRect.style.strokeDashoffset = '0';
  });

  /* Fifteen seconds of animation frames, and almost everything this handler
     writes is the same value it wrote last frame: the countdown only changes
     once a second, and the two colours change twice in the whole inspection.
     Each redundant write still invalidates style on the element. Only the ring
     offset genuinely wants to move every frame. */
  let insp = { num: '', numColor: '', stroke: '', breathe: '', tint: '' };
  timer.addEventListener('inspecttick', (e) => {
    const { elapsed, remaining, penalty } = e.detail;

    const label = penalty === 'DNF' ? 'DNF' : penalty === '+2' ? '+2' : String(Math.ceil(remaining / 1000));
    if (label !== insp.num) { insp.num = label; num.textContent = label; }

    const numColor = penalty === 'none' ? 'var(--warn)' : 'var(--danger)';
    if (numColor !== insp.numColor) { insp.numColor = numColor; num.style.color = numColor; }

    // The one thing that really does move every frame.
    ringRect.style.strokeDashoffset = String(ringLen * Math.min(1, elapsed / INSPECT_MS));

    const stroke = elapsed >= 12000 ? 'var(--danger)' : elapsed >= 8000 ? 'var(--warn)' : 'var(--accent-2)';
    if (stroke !== insp.stroke) { insp.stroke = stroke; ringRect.style.stroke = stroke; }

    // Heartbeat quickens. Written on <html>, so every redundant write dirties
    // the whole inherited tree — and it is only legible to the nearest 10ms.
    const b = (Math.round((1500 - Math.min(1, elapsed / INSPECT_MS) * 1000) / 10) * 10) + 'ms';
    if (b !== insp.breathe) { insp.breathe = b; document.documentElement.style.setProperty('--breathe', b); }

    // Background warms up as time burns down. The shader tint steps through
    // three bands, so it is worth setting only when the band actually changes.
    const t = clamp(elapsed / INSPECT_MS, 0, 1);
    bg.setSlow(1 + t * 2.2);
    const band = t > 0.8 ? 'hot' : t > 0.53 ? 'warm' : 'cool';
    if (band !== insp.tint) {
      insp.tint = band;
      const c = themeColors();
      bg.setColors(c.bg2,
        band === 'hot' ? c.danger : band === 'warm' ? c.warn : c.accent,
        band === 'hot' ? c.warn : c.accent2);
    }
  });

  timer.addEventListener('warn', (e) => {
    callout(e.detail.at, app.settings.callouts);
    const wc = themeColors();
    flash(e.detail.at === 12 ? wc.danger : wc.warn);
  });

  /* The digits only change every 10ms at two decimals, and every 100ms at one
     — but this fires once per frame, which on a 144Hz panel is a third of the
     writes landing on an identical string and dirtying the largest text node
     on screen for nothing. At 240Hz it is over half of them. Compare first. */
  let lastDigits = '';
  timer.addEventListener('tick', (e) => {
    const txt = fmtLive(e.detail.elapsed, app.settings.precision);
    if (txt !== lastDigits) { lastDigits = txt; main.textContent = txt; }
  });

  timer.addEventListener('cancel', () => {
    main.style.opacity = '';
    main.textContent = app.solves.length ? fmt(eff(app.solves.at(-1))) : '0.00';
    resetBgColors();
  });

  timer.addEventListener('start', () => { main.style.opacity = ''; lastDigits = ''; });

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

  // With no arming delay the bar has nothing to report — it would snap to a
  // full green line the moment your finger lands and sit there until you let
  // go, which is the out-of-place green line under the digits. The digits
  // themselves already go green on 'ready', which is the feedback that matters.
  if (holdMs <= 0) {
    bar.hidden = true;
    bar.classList.remove('ready');
    return;
  }

  if (state === 'holding') {
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
  // Second per-frame loop running alongside the digits during a solve. The bar
  // is a few hundred pixels wide, so tenths of a percent are sub-pixel — round
  // and skip the write when it would not move, rather than laying the bar out
  // again on every frame of every solve.
  let lastW = '', lastBehind = null;
  const step = () => {
    if (timer.state !== 'running') return;
    const p = (performance.now() - t0) / ref;
    const w = Math.min(100, p * 100).toFixed(1) + '%';
    if (w !== lastW) { lastW = w; fill.style.width = w; }
    const behind = p >= 1;
    if (behind !== lastBehind) { lastBehind = behind; pace.classList.toggle('behind', behind); }
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
    // A misfire is obvious the instant it happens — you felt the stack move.
    // No answer means keep the solve, and the prompt gets out of the way fast.
    const keep = await confirmToast(`${fmt(res.timeMs)} — misfire? Discard it?`, 'discard', { timeout: 1500 });
    if (keep) { timer.reset(); nextScramble(); return; }
  }

  await recordSolve({ timeMs: res.timeMs, penalty: res.penalty, inspectionMs: res.inspectionMs });
}

/**
 * Store one solve against the scramble currently on screen, then do everything
 * that always follows: personal bests, the delta line, a redraw, next scramble.
 *
 * Split out of onSolveFinished so that a typed time and a Stackmat time land
 * in the database through exactly the same path as a spacebar one — there is
 * no second version of the PB logic to drift.
 */
async function recordSolve({ timeMs, penalty = 'none', inspectionMs = 0 }) {
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
    timeMs,
    penalty,
    inspectionMs,
    comment: '',
    createdAt: Date.now(),
  };
  app.solves.push(solve);
  await Solves.put(solve);
  app.sessionCounts.set(app.session.id, app.solves.length);

  // You have just finished a solve, so you are looking at the timer, not at row
  // four thousand. Folding the times strip back to its top page keeps recording
  // a solve cheap however far back you had scrolled to read old ones.
  resetHistoryWindow();

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

/**
 * Put the digits back to whatever the session now ends with.
 *
 * Deleting a solve used to leave its time sitting on screen — the one number
 * that is no longer in the session is the one you are looking at. Anything that
 * changes which solve is last calls this instead.
 */
function syncTimerDisplay() {
  if (timer && timer.state !== 'idle' && timer.state !== 'cooldown') return;
  const last = app.solves.at(-1);
  const v = last ? eff(last) : null;
  $('#time-main').style.opacity = '';
  $('#time-main').textContent = last ? (v === DNF ? 'DNF' : fmt(v)) : '0.00';
  $('#time-penalty').textContent = last && last.penalty === '+2' ? '+2'
    : last && last.penalty === 'DNF' ? 'DNF' : '';
  $('#last-delta').hidden = true;
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
  const motion = app.settings.motion;

  // The whole celebration is decoration, so it answers to the motion setting
  // like everything else does — off means off, reduced means fewer flakes.
  if (motion !== 'off') {
    shockwave(kind === 'single' ? c.gold : c.accent);
    confetti([c.accent, c.accent2, c.gold, c.ok, c.text],
      { count: Math.round((motion === 'reduced' ? 55 : 120) * intensity),
        power: 0.7 + intensity * 0.5 });
    flash(c.gold);
  }
  if (app.settings.soundOnPB) chime();
  const label = kind === 'single' ? 'New personal best!' : kind === 'ao5' ? 'Best ao5 of the session!' : 'Best ao12 of the session!';
  toast(label, { kind: 'good', long: true });
  const d = $('#timer-display');
  if (motion !== 'off') {
    d.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.09)' }, { transform: 'scale(1)' }],
      { duration: 640, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  }
}

/* =========================================================
   Rendering
   ========================================================= */
/* The heatmap is the one chart fed by the whole store rather than the open
   session, so it is the one that can contradict what you just did — delete a
   day's solves and the grid kept showing them until the drawer was reopened.
   Debounced because refreshing it means re-reading every solve on record, and
   a session with the stats drawer open would otherwise do that on every solve
   that lands. */
const refreshHeatmap = debounce(() => document.querySelector('.heat-host')?.refresh?.(), 400);

function renderAll() {
  renderStats();
  renderHistory();
  updateLabels();
  updateHint();
  refreshHeatmap();
}
app.renderAll = renderAll;

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

  /* Collapsed peek. Two rows: the three averages you watch while a session is
     running, and the three that say how the session has gone. */
  $('#peek-ao5').textContent  = f(st.ao5);
  $('#peek-ao12').textContent = f(st.ao12);
  $('#peek-mo3').textContent  = f(st.mo3);
  $('#peek-best').textContent = f(st.best);
  $('#peek-ao50').textContent = f(st.ao50);
  $('#peek-mean').textContent = f(st.mean);

  // ...and the two of them again under the timer, where you are already looking.
  // Hidden outright until there is an average to print, rather than sitting
  // there as a pair of dashes.
  $('#live-ao5').textContent  = f(st.ao5);
  $('#live-ao12').textContent = f(st.ao12);
  const avgs = $('#timer-avgs');
  if (avgs) {
    avgs.hidden = st.ao5 === null || st.ao5 === undefined;
    avgs.classList.toggle('solo', st.ao12 === null || st.ao12 === undefined);
  }

  // Session bests are O(n x len) to compute, so only when they are on screen.
  if ($('#panel-stats')?.dataset.collapsed === 'false') {
    const b = sessionBests(app.solves);
    for (const k of ['single', 'ao5', 'ao12', 'ao50', 'ao100']) {
      const node = $('#b-' + k);
      if (node) node.textContent = f(b[k]);
    }
  }
}

/* ---------------- the times strip ----------------
   The strip used to stop dead at the last 60 solves, so the rest of a session
   simply could not be reached from the sidebar. It now runs all the way back to
   solve #1 — but a session can be five figures long, so it is windowed: a page
   of rows is built at a time and more are *appended* as you reach the bottom,
   rather than rebuilding thousands of nodes on every scroll. */

const HIST_PAGE = 80;
let histShown = HIST_PAGE;
// Recomputed once per full render and reused while appending, because nothing
// about the data changes between one page of scrolling and the next.
let histCtx = null;
// The solve ids currently on screen, newest first, and what each of those rows
// last rendered as. Renders diff against these rather than assuming the list has
// to be thrown away — and they live here rather than on the elements because
// reading 5,000 data-attributes back off the DOM costs more than the render.
let histIds = [];
let histSigs = [];

/** Back to the top window — a different session is a different list. */
function resetHistoryWindow() {
  histShown = HIST_PAGE;
  histIds = [];
  histSigs = [];
  const list = $('#hist-list');
  if (list) list.scrollTop = 0;
}

/** Everything one row displays, as one string, so rows can be diffed cheaply. */
function historyRowData(i) {
  const s = app.solves[i];
  const { best, trim5, ao5s, bestAo5 } = histCtx;
  const v = eff(s);
  const ao = ao5s[i];
  return {
    solve: s,
    cls: [
      'solve-chip',
      s.penalty === 'DNF' ? 'dnf' : '',
      s.penalty === '+2' ? 'plus2' : '',
      v === best && v !== DNF ? 'pb' : '',
      trim5.best.has(i) ? 'best-in-avg' : '',
    ].filter(Boolean).join(' '),
    idx: String(i + 1),
    time: v === DNF ? 'DNF' : fmt(v) + (s.penalty === '+2' ? '+' : ''),
    ao: ao === null ? '·' : fmt(ao),
    aoBest: ao !== null && bestAo5 !== null && ao === bestAo5,
    aoTitle: ao === null ? 'needs five solves'
      : `ao5 after solve ${i + 1}${ao === bestAo5 ? ' — best of the session' : ''}`,
  };
}

const rowSig = (d) => `${d.cls}|${d.idx}|${d.time}|${d.ao}|${d.aoBest ? 1 : 0}`;

/** One row. `i` is the index into app.solves, so #1 is always #1. */
function historyChip(i, data) {
  const d = data || historyRowData(i);
  /* One click from the times list into the reconstruction. It sits over the
     ao5 on hover rather than taking a column of its own, because the ao5 is
     what you read while you are solving and this is what you reach for when
     you have stopped. The solve menu still carries the same entry, which is
     the only way in on a touch screen. */
  const recon = el('button', {
    class: 'chip-recon', title: 'Reconstruct this solve  (Y)',
    html: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 108-8"/><path d="M12 4L9 7l3 3"/></svg>'
        + '<i>reconstruct</i>',
  });
  recon.addEventListener('click', (e) => { e.stopPropagation(); reconstructSolve(d.solve); });

  const chip = el('div', { class: d.cls, role: 'listitem' },
    el('span', { class: 'idx', text: d.idx }),
    el('span', { class: 't', text: d.time }),
    el('span', { class: `ao5 ${d.aoBest ? 'best' : ''}`, title: d.aoTitle, text: d.ao }),
    recon,
  );
  chip.addEventListener('click', (e) => solveMenu(d.solve, e.currentTarget));
  chip.addEventListener('contextmenu', (e) => { e.preventDefault(); solveMenu(d.solve, e.currentTarget); });
  return chip;
}

/**
 * Add rows for indices `from` (higher) down to `to`, both inclusive.
 * `sigs`, when given, is filled in with each new row's signature.
 */
function appendHistoryRows(list, from, to, sigs = null, sigAt = 0) {
  // One fragment, one reflow, however many rows.
  const frag = document.createDocumentFragment();
  for (let i = from; i >= to; i--) {
    const d = historyRowData(i);
    if (sigs) sigs[sigAt + (from - i)] = rowSig(d);
    frag.append(historyChip(i, d));
  }
  list.querySelector('.hist-end')?.remove();
  list.append(frag);
  if (to === 0) {
    list.append(el('div', { class: 'hist-end', text: 'start of the session' }));
  }
}

function renderHistory() {
  const list = $('#hist-list');
  const n = app.solves.length;
  if (!n) {
    histShown = HIST_PAGE;
    histIds = [];
    histSigs = [];
    list.innerHTML = '';
    list.append(el('div', { class: 'hist-empty', text: 'No times yet — hold space and go.' }));
    return;
  }

  // Deleting solves must not leave the window pointing past the end, and a new
  // solve must not silently drop the oldest row you had scrolled to.
  histShown = Math.min(Math.max(histShown, HIST_PAGE), n);

  const ao5s = rollingSeries(app.solves, 5);
  const valid = ao5s.filter(v => v !== null);
  histCtx = {
    best: bestSingle(app.solves),
    trim5: trimmedIndices(app.solves, 5),
    ao5s,
    bestAo5: valid.length ? Math.min(...valid) : null,
  };

  const lo = n - histShown;
  const target = [];
  for (let i = n - 1; i >= lo; i--) target.push(app.solves[i].id);

  /* Reuse what is already on screen wherever the same solves are still in the
     same order. Once you have scrolled back through a few thousand rows, tearing
     the list down and rebuilding it for a penalty toggle cost two whole seconds;
     almost every row renders identically, so the honest amount of work is to
     find the handful that changed.

     The window only ever moves one way: new solves arrive at the top, and the
     oldest rows fall off the bottom when the window is already at its full
     length. So the check is "does the old list appear inside the new one,
     shifted down by `added` rows" — which covers a new solve, a penalty edit,
     and both at once. Anything else (a deletion in the middle, a different
     session) renumbers the rows and honestly does need rebuilding. */
  let added = histIds.length ? target.indexOf(histIds[0], 0) : -1;
  // A shift bigger than a page means the list has moved on entirely.
  if (added < 0 || added > HIST_PAGE) added = -1;
  const reusable = added >= 0 &&
    histIds.every((id, j) => j + added >= target.length || target[j + added] === id);

  const sigs = new Array(target.length);
  if (!reusable) {
    // Reading scrollTop forces a layout of every row on screen, which on a
    // five-thousand-row list is half a second on its own — so it is only ever
    // read on the path that actually destroys the scroll position.
    const prevScroll = list.scrollTop;
    const atTop = prevScroll < 8;
    list.innerHTML = '';
    appendHistoryRows(list, n - 1, lo, sigs);
    list.scrollTop = atTop ? 0 : prevScroll;
  } else {
    if (added > 0) {
      const frag = document.createDocumentFragment();
      for (let i = n - 1; i >= n - added; i--) {
        const d = historyRowData(i);
        sigs[n - 1 - i] = rowSig(d);
        frag.append(historyChip(i, d));
      }
      list.prepend(frag);
    }
    // Rows pushed off the bottom by the new arrivals.
    let spare = histIds.length + added - target.length;
    for (let k = list.children.length - 1; k >= 0 && spare > 0; k--) {
      const node = list.children[k];
      if (!node.classList.contains('solve-chip')) continue;
      node.remove();
      spare--;
    }

    // `children` is live and indexable, and the chips always come before the
    // end marker, so no second query is needed to reach row j.
    const kids = list.children;
    for (let j = added; j < target.length; j++) {
      const i = n - 1 - j;
      const d = historyRowData(i);
      const sig = rowSig(d);
      sigs[j] = sig;
      if (histSigs[j - added] === sig) continue;      // renders identically
      kids[j]?.replaceWith(historyChip(i, d));
    }
  }
  histIds = target;
  histSigs = sigs;

  // The marker only belongs there while the window really does reach solve #1.
  const end = list.querySelector('.hist-end');
  if (lo === 0 && !end) list.append(el('div', { class: 'hist-end', text: 'start of the session' }));
  else if (lo !== 0 && end) end.remove();
}

/** Grow the window when the scroll reaches the oldest row on screen. */
function wireHistoryScroll() {
  const list = $('#hist-list');
  if (!list) return;
  list.addEventListener('scroll', () => {
    const n = app.solves.length;
    if (histShown >= n) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > 300) return;
    const from = n - histShown - 1;
    histShown = Math.min(histShown + HIST_PAGE, n);
    const to = n - histShown;
    appendHistoryRows(list, from, to, histSigs, histIds.length);
    for (let i = from; i >= to; i--) histIds.push(app.solves[i].id);
  }, { passive: true });
}

/* Plugging a keyboard into a tablet, or the browser's own device emulation,
   changes the answer after boot — so the hint is re-read rather than baked in
   once. */
const COARSE = matchMedia('(pointer: coarse)');
COARSE.addEventListener('change', () => updateHint());

/** The hint under the digits states what starts a solve on this device. */
function updateHint() {
  const node = $('#timer-hint');
  if (!node) return;
  // On a touch screen there is no spacebar, so naming one is worse than saying
  // nothing. Same two states, described with the input the device actually has.
  if (COARSE.matches) {
    node.innerHTML = app.settings.holdTime > 0
      ? 'hold anywhere, release to start'
      : 'tap anywhere, release to start';
    return;
  }
  node.innerHTML = app.settings.holdTime > 0
    ? 'hold <kbd>space</kbd>, release to start'
    : 'tap <kbd>space</kbd>, release to start';
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
    syncTimerDisplay();
  };
  popover(anchor, [
    { title: `#${app.solves.indexOf(solve) + 1} · ${eff(solve) === DNF ? 'DNF' : fmt(eff(solve))}` },
    { label: 'No penalty', on: solve.penalty === 'none', onSelect: () => setPenalty('none') },
    { label: '+2', badge: '2', on: solve.penalty === '+2', onSelect: () => setPenalty('+2') },
    { label: 'DNF', badge: 'D', on: solve.penalty === 'DNF', onSelect: () => setPenalty('DNF') },
    { sep: true },
    { label: 'Copy scramble', badge: '', onSelect: () => copyToast(solve.scramble, 'Scramble') },
    { label: 'Share as a card', badge: 'S', onSelect: () => app.shareSolveCard(solve) },
    { label: solve.comment ? 'Edit comment' : 'Add comment', badge: 'C', onSelect: () => commentOn(solve) },
    { label: 'Repeat this scramble', badge: 'R', onSelect: () => repeatScramble(solve) },
    { label: solve.recon ? 'Open the reconstruction' : 'Reconstruct this solve', badge: 'Y', onSelect: () => reconstructSolve(solve) },
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
  app.lastDeleted = { solves: [solve], sessionId: app.session.id, label: '1 solve' };
  app.sessionCounts.set(app.session.id, app.solves.length);
  renderAll();
  syncTimerDisplay();
  toast(`Deleted ${eff(solve) === DNF ? 'DNF' : fmt(eff(solve))} — Ctrl+Z`, {
    action: 'undo',
    onAction: undoDelete,
  });
}

/**
 * Put back whatever was last removed — one solve or a whole cleared session.
 *
 * The record lives on `app`, not inside the toast that announces it, so the
 * message can disappear in a second while the undo itself stays available for
 * as long as you have not deleted something else.
 */
async function undoDelete() {
  const rec = app.lastDeleted;
  if (!rec) { toast('Nothing to undo'); return; }
  app.lastDeleted = null;

  await Solves.putMany(rec.solves);
  // Restoring into a session you have since navigated away from would silently
  // do nothing on screen, so only splice it back in when it belongs here.
  if (rec.sessionId === app.session.id) {
    app.solves = app.solves.concat(rec.solves).sort((a, b) => a.createdAt - b.createdAt);
    lastStats = {};
    resetHistoryWindow();
    renderAll();
    syncTimerDisplay();
  }
  app.sessionCounts.set(rec.sessionId, (app.sessionCounts.get(rec.sessionId) || 0) + rec.solves.length);
  toast(`Restored ${rec.label}`);
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
  resetHistoryWindow();          // a different session is a different list
  syncTimerDisplay();
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
  resetHistoryWindow();
  lastStats = {};
  renderAll();
  syncTimerDisplay();
  app.lastDeleted = {
    solves: backup,
    sessionId: app.session.id,
    label: `${backup.length} solves`,
  };
  toast(`Cleared ${backup.length} solves — Ctrl+Z`, { action: 'undo', onAction: undoDelete });
}


/* =========================================================
   Input source — spacebar, typed, or a Stackmat on the aux jack
   ========================================================= */

/** True when the keyboard/touch timer should be live at all. */
const timerInputLive = () => app.settings.inputMode === 'timer';

function applyInputMode() {
  const mode = app.settings.inputMode || 'timer';
  const form = $('#manual-entry');
  const bar = $('#stackmat-bar');
  document.body.dataset.input = mode;

  if (form) form.hidden = mode !== 'manual';
  if (bar) bar.hidden = mode !== 'stackmat';
  const hint = $('#timer-hint');
  if (hint) hint.hidden = mode !== 'timer';

  // Anything half-armed on the old source has to go, or a stale hold survives
  // the switch and starts a solve nobody asked for.
  timer?.reset();

  if (mode === 'stackmat') startStackmat();
  else stackmat?.stop();

  if (mode === 'manual') setTimeout(() => $('#manual-input')?.focus(), 0);
  else $('#manual-input')?.blur();
}
app.applyInputMode = applyInputMode;

/* ---------------- typed times ---------------- */
function wireManualEntry() {
  const form = $('#manual-entry');
  const input = $('#manual-input');
  if (!form || !input) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const parsed = parseTimeInput(input.value);
    if (!parsed) {
      input.classList.remove('bad'); void input.offsetWidth; input.classList.add('bad');
      toast('Could not read that as a time — try 12.34, 1:05.67 or DNF', { kind: 'bad' });
      return;
    }
    input.value = '';
    input.classList.remove('bad');
    $('#time-main').textContent = fmt(parsed.timeMs);
    $('#time-penalty').textContent = parsed.penalty === 'none' ? '' : parsed.penalty;
    await recordSolve(parsed);
    input.focus();
  });

  // Escape clears the field rather than closing something behind it.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (input.value) { input.value = ''; return; }
    input.blur();
  });
}

/* ---------------- Stackmat on the aux jack ----------------
   The driver is only built the first time the input mode is switched to it,
   which for almost everyone is never. Everything below that touches it is
   null-safe for that reason. */
let stackmat = null;
let stackmatWired = false;

const loadStackmatModule = lazy(() => import('./stackmat.js'), m => m);

async function getStackmat() {
  if (!stackmat) {
    const { Stackmat } = await loadStackmatModule();
    stackmat = new Stackmat();
  }
  return stackmat;
}

async function wireStackmat() {
  const stackmat = await getStackmat();
  if (stackmatWired) return stackmat;
  stackmatWired = true;
  const msg = $('#stackmat-msg');
  const dot = $('#stackmat-dot');
  const say = (text, cls) => {
    if (msg) msg.textContent = text;
    if (dot) dot.className = `sm-dot ${cls || ''}`;
  };

  stackmat.addEventListener('signal', (e) => {
    if (e.detail.ok) say('Stackmat connected', 'live');
    else say('listening — no signal yet, check the cable and the input level', 'wait');
  });

  stackmat.addEventListener('time', (e) => {
    // Mirror the mat's own display rather than running a second clock; the mat
    // is the source of truth and the two would visibly disagree.
    $('#timer-display').className = 'state-running';
    $('#time-main').textContent = fmtLive(e.detail.timeMs, app.settings.precision);
    $('#time-penalty').textContent = '';
  });

  stackmat.addEventListener('state', (e) => {
    const hands = e.detail.hands;
    $('#timer-display').classList.toggle('state-ready', hands === 'both');
  });

  stackmat.addEventListener('ready', () => {
    $('#timer-display').className = 'state-idle';
    syncTimerDisplay();
  });

  stackmat.addEventListener('solve', async (e) => {
    $('#timer-display').className = 'state-idle';
    $('#time-main').textContent = fmt(e.detail.timeMs);
    await recordSolve({ timeMs: e.detail.timeMs });
  });

  return stackmat;
}

async function startStackmat() {
  let stackmat;
  try { stackmat = await wireStackmat(); }
  catch (err) { return lazyFailed('the Stackmat driver', err); }
  try {
    await stackmat.start();
    toast('Listening on the microphone input');
  } catch (err) {
    console.warn('[stackmat] could not start', err);
    toast(`Could not open the audio input: ${err.message}`, { kind: 'bad' });
    app.settings.inputMode = 'timer';
    persist();
    applyInputMode();
  }
}

/* =========================================================
   Album theming
   ========================================================= */

/**
 * Bring the link up if there is one to bring up.
 *
 * Called once at boot. Does nothing at all — no import, no network — unless a
 * client ID has been entered, so the cost to everyone else is one string check.
 */
async function startAlbumTheming() {
  /* Now that a client ID always exists, "is one configured" no longer says
     whether anyone has linked anything — so ask the question that does. Both
     of these are cheap and neither pulls in the OAuth client, which is the
     point: a visitor who never presses Connect never downloads any of it. */
  const returning = new URLSearchParams(location.search).has('code')
                 || new URLSearchParams(location.search).has('error');
  const stored = await KV.get('spotifyTokens', null);
  if (!returning && !stored) return;

  const id = clientId();
  const { Spotify } = await loadSpotify();
  if (!spotify) { spotify = new Spotify(); wireSpotify(); wireControls(); }

  // A redirect back from the consent page carries ?code=; consume it before
  // trying to restore, because it is what creates the tokens to restore.
  const fresh = await spotify.completeRedirect(id);
  if (!fresh) await spotify.restore(id);

  if (spotify.connected) spotify.start();
  /* Both of these, not just spotifyChanged. `spotifyChanged` is assigned only
     while the Spotify panel is open, and even then it redraws that panel's own
     body — it has never had anything to do with the sidebar card. Without the
     sync here the card stayed hidden after connecting until something else
     happened to call it, which is why toggling "Now playing panel" appeared to
     be what summoned it. */
  syncSpotifyPanel();
  syncControls();
  app.spotifyChanged?.();
}

function wireSpotify() {
  spotify.addEventListener('track', async (e) => {
    const { artUrl, title, artist } = e.detail;
    showNowPlaying(title, artist);
    paintNowPlaying(e.detail);

    /* One decode per cover, cached by URL. This used to be three — a CORS
       probe, then the extraction, then the <img> in the card — and three
       decodes of a 640px JPEG landing in the same tick is what made changing
       track feel heavy. The probe is gone: the extraction reports whether the
       pixels were readable from the decode it already had to do. */
    const pal = await loadPalette();
    const dark = document.documentElement.dataset.bgLuma !== 'light';
    const { palette, blocked } = await pal.paletteForUrl(artUrl, { dark });
    if (blocked) artworkReadable = false;
    else if (palette) artworkReadable = true;

    if (app.settings.spotifyTint !== 'accent' || blocked) {
      // What CORS cannot block: the artwork itself, behind the blur and dim
      // already in settings. Also the whole fallback when pixels are refused.
      bg.setMedia(`center/cover no-repeat url("${artUrl}")`);
    }
    if (!palette) return;

    paintSwatches(palette);
    queueTint(app.settings.spotifyTint === 'background' ? null : palette);
  });

  spotify.addEventListener('progress', (e) => setProgress(e.detail));

  /* A control that could not be carried out. Each of these is an ordinary
     situation rather than a failure, so each gets a sentence saying what to do
     rather than a generic error. */
  spotify.addEventListener('blocked', (e) => {
    const { reason, detail } = e.detail;
    const msg = {
      premium:     'Spotify only allows apps to control playback on Premium accounts.',
      nodevice:    'No active Spotify device — start playing something on your phone or desktop app first.',
      reconnect:   'Reconnect Spotify to allow playback control (the controls were added after you linked).',
      ratelimited: 'Spotify is rate limiting — try again in a moment.',
    }[reason] || `Spotify could not do that${detail ? ` — ${detail}` : ''}.`;
    // A permanent limitation belongs in the card, not in a toast that vanishes.
    if (reason === 'premium' || reason === 'reconnect') {
      npBlocked = { reason, msg };
      syncControls();
    } else {
      toast(msg, { kind: 'bad' });
    }
    // The optimistic icon flip was a guess; the poll that follows will correct
    // it, but until then put it back rather than lying about the state.
    drawPlayIcon(npAt?.playing);
  });

  spotify.addEventListener('idle', () => {
    showNowPlaying(null);
    paintNowPlaying(null);
    queueTint(null);
  });

  spotify.addEventListener('status', (e) => {
    const { state, detail } = e.detail;
    if (state === 'disconnected' && detail) toast('Spotify disconnected — link it again in Appearance', { kind: 'bad' });
    if (state === 'error' && detail) console.warn('[spotify]', detail);
    /* The allowlist refusal. This used to fall through to the generic error
       path, which only console.warn()s — so a visitor who was not on the list
       saw "Connected", an empty card, and no explanation anywhere. */
    if (state === 'denied') {
      accessDenied = true;
      showNowPlaying(null);
      paintNowPlaying(null);
      queueTint(null);
      toast('Spotify linked, but this account is not on the app’s user list — open the Spotify panel', { kind: 'bad' });
    }
    if (state === 'connected') accessDenied = false;
    syncSpotifyPanel();
    syncControls();
    app.spotifyChanged?.();
  });
}

/**
 * Apply a palette, but never in the middle of an attempt.
 *
 * A theme that shifts while you are inspecting or solving is exactly the
 * distraction a timer must not have, so anything arriving mid-attempt waits
 * for the next return to idle. See SPOTIFY.md §5.2.
 */
function queueTint(colors) {
  if (timer && timer.state !== 'idle' && timer.state !== 'cooldown') {
    pendingTint = { colors };
    return;
  }
  setAlbumTint(colors, app.settings);
  bgFromTheme();
}

/** Push whatever the palette now resolves to into the shader. */
function bgFromTheme() {
  const c = themeColors();
  bg.setColors(c.bg2, c.accent, c.accent2);
}

/* ---------------- the now-playing panel ----------------
   The sidebar card. Its job is to make the link between the record and the
   interface visible: the cover, the track, and the two colours actually pulled
   out of that cover sitting right next to it. Without the swatches the tint
   just looks like the theme changed on its own. */

let npClock = null;                 // interval that walks the bar between polls
let npAt = null;                    // {progressMs, durationMs, playing, stamp}
// A standing reason the controls cannot work, as {reason, msg}. Kept as the
// reason and not just the sentence, so it can be re-evaluated rather than
// lingering after the thing it complained about has been fixed.
let npBlocked = null;

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Show/hide the whole panel according to the setting and the link state. */
function syncSpotifyPanel() {
  const panel = $('#panel-spotify');
  if (!panel) return;
  /* Shown once there is something to show. A denied link is "connected" in
     the sense that tokens exist, but Spotify will never answer it, so the card
     would sit there empty forever — the Spotify panel says why instead. */
  const on = app.settings.showSpotifyPanel && !!spotify?.connected && !accessDenied;
  panel.hidden = !on;
  const st = $('#np-state');
  if (st) {
    st.textContent = !spotify?.connected ? 'not connected'
      : npAt?.playing ? 'playing' : npAt ? 'paused' : 'nothing playing';
    st.classList.toggle('live', !!npAt?.playing);
  }
}
app.syncSpotifyPanel = syncSpotifyPanel;

function paintNowPlaying(track) {
  const art = $('#np-art'), title = $('#np-title'), artist = $('#np-artist');
  const card = $('#np-card'), prog = $('#np-progress');
  if (!art) return;

  if (!track) {
    art.removeAttribute('src');
    art.hidden = true;
    title.textContent = 'Nothing playing';
    artist.textContent = '';
    if (card) { card.removeAttribute('href'); card.classList.remove('has-track'); }
    if (prog) prog.hidden = true;
    $('#np-controls').hidden = true;
    paintSwatches(null);
    npAt = null;
    stopNpClock();
    syncSpotifyPanel();
    return;
  }

  art.src = track.artUrl;
  art.hidden = false;
  art.alt = track.album ? `${track.album} cover` : '';
  title.textContent = track.title;
  artist.textContent = track.artist;
  if (card) {
    card.classList.add('has-track');
    if (track.url) card.href = track.url; else card.removeAttribute('href');
  }
  if (prog) prog.hidden = false;
  $('#np-duration').textContent = mmss(track.durationMs || 0);
  // A new track clears a "no active device" style complaint; the device is
  // plainly alive if it just started something.
  if (npBlocked && npBlocked.reason !== 'premium' && npBlocked.reason !== 'reconnect') npBlocked = null;
  syncSpotifyPanel();
  syncControls();
}

/** The two colours this cover produced, shown next to the cover. */
/** The play/pause glyph, kept in one place so the optimistic flip and the
    correction from the next poll cannot disagree about which path is which. */
function drawPlayIcon(playing) {
  const icon = $('#np-play-icon');
  if (!icon) return;
  icon.innerHTML = playing
    ? '<path d="M8 5.2h3.1v13.6H8zM12.9 5.2H16v13.6h-3.1z" fill="currentColor" stroke="none"/>'
    : '<path d="M8 5.5l10 6.5-10 6.5V5.5z" fill="currentColor" stroke="none"/>';
  $('#np-play')?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/** Show the transport only when this link is actually allowed to use it. */
function syncControls() {
  const row = $('#np-controls'), note = $('#np-note');
  if (!row) return;

  /* Re-check the standing complaint before acting on it. "Reconnect to enable
     the controls" is exactly the sort of note that would otherwise outlive the
     reconnect that fixed it, leaving the buttons hidden for the rest of the
     session with a stale explanation underneath them. */
  if (npBlocked?.reason === 'reconnect' && spotify?.canControl) npBlocked = null;
  if (npBlocked && !spotify?.connected) npBlocked = null;

  const usable = !!spotify?.connected && spotify.canControl && !npBlocked;
  row.hidden = !usable;
  if (note) {
    note.hidden = !npBlocked;
    note.textContent = npBlocked?.msg || '';
  }
}
app.syncSpotifyControls = syncControls;

function wireControls() {
  const on = (id, fn) => $(id)?.addEventListener('click', (e) => { e.preventDefault(); fn(); });
  on('#np-next', () => spotify?.next());
  on('#np-prev', () => spotify?.previous());
  on('#np-play', () => {
    const playing = !!npAt?.playing;
    // Flip immediately: a transport button that waits for a network round trip
    // before acknowledging the press feels broken even when it works.
    drawPlayIcon(!playing);
    if (npAt) npAt = { ...npAt, playing: !playing, progressMs: currentProgress(), stamp: performance.now() };
    (playing ? spotify?.pause() : spotify?.play());
    if (npAt?.playing) startNpClock(); else stopNpClock();
    syncSpotifyPanel();
  });
}

function paintSwatches(colors) {
  const host = $('#np-swatches');
  if (!host) return;
  host.innerHTML = '';
  if (!colors) return;
  for (const c of [colors.accent, colors.accent2]) {
    const dot = el('i');
    dot.style.background = c;
    dot.title = c;
    host.append(dot);
  }
}

/**
 * Spotify is polled every five seconds, so the bar has to walk itself in
 * between or it jumps in five-second steps and reads as broken rather than
 * live. Each poll re-anchors it, so drift never accumulates.
 */
function setProgress({ progressMs, durationMs, playing }) {
  npAt = { progressMs, durationMs, playing, stamp: performance.now() };
  drawProgress();
  drawPlayIcon(playing);
  syncSpotifyPanel();
  syncControls();
  if (playing) startNpClock(); else stopNpClock();
}

/** Where the track is right now, interpolated since the last poll. */
function currentProgress() {
  if (!npAt) return 0;
  const since = npAt.playing ? performance.now() - npAt.stamp : 0;
  return Math.min(npAt.durationMs, npAt.progressMs + since);
}

function drawProgress() {
  if (!npAt) return;
  const fill = $('#np-fill'), elapsed = $('#np-elapsed');
  if (!fill) return;
  const at = currentProgress();
  const pct = npAt.durationMs ? (at / npAt.durationMs) * 100 : 0;
  fill.style.width = pct.toFixed(2) + '%';
  if (elapsed) elapsed.textContent = mmss(at);
}

function startNpClock() {
  if (npClock) return;
  // 500ms, not a frame loop: this is a progress bar in a sidebar, and it has no
  // business competing with the timer for frames. It also stops entirely while
  // a solve is running.
  npClock = setInterval(() => {
    if (timer && (timer.state === 'running' || timer.state === 'inspecting')) return;
    if (document.hidden) return;
    drawProgress();
  }, 500);
}

function stopNpClock() { clearInterval(npClock); npClock = null; }

function showNowPlaying(title, artist) {
  const el = $('#now-playing');
  if (!el) return;
  const on = app.settings.spotifyNowPlaying && !!title;
  el.hidden = !on;
  if (on) el.textContent = `${title} — ${artist}`;
}

/** Drop the link and put the user's own theme back. */
app.disconnectSpotify = async () => {
  await spotify?.disconnect();
  artworkReadable = null;
  accessDenied = false;
  pendingTint = null;
  setAlbumTint(null, app.settings);
  bgFromTheme();
  showNowPlaying(null);
  paintNowPlaying(null);
  app.spotifyChanged?.();
};

app.connectSpotify = async () => {
  const id = clientId();
  const { Spotify } = await loadSpotify();
  if (!spotify) { spotify = new Spotify(); wireSpotify(); wireControls(); }
  npBlocked = null;               // a fresh consent may grant what the last one did not
  accessDenied = false;           // the dashboard may have been fixed since
  await spotify.connect(id);      // leaves the page
};

// Exposed like the other subsystems on `app` are: handy in the console, and
// the only way to watch what the poller is doing without a network tab open.
Object.defineProperty(app, 'spotify', { get: () => spotify });
Object.defineProperty(app, 'pendingTint', { get: () => pendingTint });

app.spotifyState = () => {
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  const u = new URL(location.href);
  // Spotify allows http only on a loopback IP, never on `localhost`. Surfacing
  // it here rather than letting the consent page reject them with
  // INVALID_CLIENT: Invalid redirect URI, which says nothing about the cause.
  let problem = null;
  if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1') {
    problem = (u.hostname === 'localhost' || u.hostname === '[::1]')
      ? { reason: 'Spotify rejects localhost — it only allows http on a loopback IP.',
          openInstead: `http://127.0.0.1:${u.port || 80}${u.pathname}` }
      : { reason: `Spotify needs https for redirect URIs; this page is ${u.protocol}//`, openInstead: null };
  }
  return {
    configured: true,               // there is always an app to connect to now
    usingOwnApp: usingOwnApp(),
    devModeLimit: DEV_MODE_LIMIT,
    connected: !!spotify?.connected,
    canControl: !!spotify?.canControl,
    blocked: npBlocked?.msg || null,
    denied: accessDenied,
    ownerNeedsPremium: OWNER_NEEDS_PREMIUM,
    artworkReadable,
    redirectUri: base,
    problem,
  };
};

/* =========================================================
   Sharing
   ========================================================= */
/* The card renderer and the cube-net drawing it needs are ~26KB that only
   matter once someone actually asks for a card, so they arrive on the click. */
app.shareSolveCard = async (solve) => {
  let m;
  try { m = await loadShare(); } catch (err) { return lazyFailed('the share card', err); }
  return m.shareSolve(solve, { index: app.solves.indexOf(solve) + 1 });
};

/**
 * Share the last `n` solves as an average card. `kind` is one of the stat keys,
 * so the card is labelled with the same words the panel uses.
 */
app.shareAverageCard = async (kind) => {
  try { await loadShare(); } catch (err) { return lazyFailed('the share card', err); }
  const st = summarize(app.solves);
  const N = { ao5: 5, ao12: 12, ao50: 50, ao100: 100, mo3: 3 }[kind];
  if (!N) {
    // "best single" and "mean" have no window of their own to show.
    if (kind === 'best') {
      const best = app.solves.filter(x => eff(x) !== DNF)
        .sort((a, b) => eff(a) - eff(b))[0];
      if (!best) { toast('No solves yet'); return; }
      return (await loadShare()).shareSolve(best, { index: app.solves.indexOf(best) + 1 });
    }
    return (await loadShare()).shareAverage(app.solves.slice(-12), { label: 'session mean', value: st.mean === null ? '—' : fmt(st.mean) });
  }
  if (app.solves.length < N) { toast(`Needs ${N} solves`); return; }
  const window = app.solves.slice(-N);
  const value = st[kind];
  const label = kind === 'mo3' ? 'mean of 3' : `average of ${N}`;
  const trim = trimmedIndices(app.solves, N);
  const base = app.solves.length - N;
  const trimmed = new Set();
  for (const i of [...trim.best, ...trim.worst]) trimmed.add(i - base);
  return (await loadShare()).shareAverage(window, {
    label,
    value: value === null || value === undefined ? '—' : value === DNF ? 'DNF' : fmt(value),
    trimmed: kind === 'mo3' ? null : trimmed,
  });
};

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
  if (!changed || changed === 'inputMode') applyInputMode();
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
  resetHistoryWindow();
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

/* ---------------- csTimer import ----------------
   csTimer's "export to file" writes JSON with a .txt extension, which is why
   a plain .json picker never sees it. We take the file, not the extension.

   Shape:
     { "session1": [ [[penalty, ms], scramble, comment, unixSeconds], ... ],
       "properties": { "sessionData": "<JSON string of names and options>" } }
   penalty is 0, 2000 (+2) or -1 (DNF); ms is already milliseconds.
   --------------------------------------------------- */

/** csTimer names its scramble types; map the ones that are really an event. */
function eventFromScrType(scrType = '', name = '') {
  const t = String(scrType || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  const probe = t || n;
  const table = [
    ['333ni', '333bf'], ['333bf', '333bf'], ['333fm', '333fm'], ['333oh', '333oh'],
    ['444bld', '444bf'], ['444bf', '444bf'], ['555bld', '555bf'], ['555bf', '555bf'],
    ['333mbf', '333mbf'], ['mlt', '333mbf'],
    ['222', '222'], ['444', '444'], ['555', '555'], ['666', '666'], ['777', '777'],
    ['clk', 'clock'], ['clock', 'clock'], ['mgm', 'minx'], ['minx', 'minx'],
    ['pyr', 'pyram'], ['pyram', 'pyram'], ['skb', 'skewb'], ['skewb', 'skewb'],
    ['sq1', 'sq1'], ['sqr', 'sq1'], ['333', '333'],
  ];
  for (const [key, ev] of table) if (probe.includes(key)) return ev;
  return '333';
}

/** Names and per-session options, which csTimer stores as JSON inside JSON. */
function csTimerSessionMeta(data) {
  const out = {};
  try {
    const props = data.properties?.sessionData;
    if (!props) return out;
    const parsed = typeof props === 'string' ? JSON.parse(props) : props;
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = { name: v?.name ? String(v.name) : '', scrType: v?.opt?.scrType || '' };
    }
  } catch { /* names and options are a bonus, never a requirement */ }
  return out;
}

app.importCsTimer = async (data, { onProgress } = {}) => {
  if (typeof data === 'string') data = JSON.parse(data);
  const meta = csTimerSessionMeta(data);

  const keys = Object.keys(data)
    .filter(k => /^session\d+$/.test(k) && Array.isArray(data[k]) && data[k].length)
    .sort((a, b) => (+a.slice(7)) - (+b.slice(7)));
  if (!keys.length) throw new Error('no csTimer sessions in that file');

  let imported = 0;
  let order = app.sessions.length;
  const added = [];

  for (const key of keys) {
    const num = key.slice(7);
    const info = meta[num] || {};
    const event = eventFromScrType(info.scrType, info.name);
    const sess = {
      id: uid(),
      // csTimer stores the session number as the name until you rename it,
      // and a sidebar full of bare digits tells you nothing.
      name: (info.name && !/^\d+$/.test(info.name)) ? info.name : `csTimer ${num}`,
      event,
      createdAt: Date.now(),
      order: order++,
    };

    const solves = [];
    for (const item of data[key]) {
      if (!Array.isArray(item) || !Array.isArray(item[0])) continue;
      const [pen, ms] = item[0];
      if (!isFinite(ms)) continue;
      solves.push({
        id: uid(),
        sessionId: sess.id,
        event,
        mode: 'wca',
        scramble: item[1] || '',
        timeMs: ms,
        penalty: pen === -1 ? 'DNF' : pen === 2000 ? '+2' : 'none',
        comment: typeof item[2] === 'string' ? item[2] : '',
        caseId: null, caseName: null,
        createdAt: item[3] ? item[3] * 1000 : Date.now(),
      });
    }
    if (!solves.length) continue;

    await Sessions.put(sess);
    // Written in blocks: a full csTimer history is tens of thousands of solves,
    // and one transaction holding all of them is where the browser gives up.
    for (let i = 0; i < solves.length; i += 1000) {
      await Solves.putMany(solves.slice(i, i + 1000));
      onProgress?.(imported + Math.min(i + 1000, solves.length), sess.name);
    }
    app.sessions.push(sess);
    added.push(sess);
    imported += solves.length;
  }

  if (!imported) throw new Error('those sessions had no readable solves');
  await refreshCounts();
  return { solves: imported, sessions: added.length, first: added[0] };
};

/**
 * One importer for both file types. csTimer exports are JSON in a .txt, and a
 * Tagda backup is JSON in a .json, so sniffing the contents is both simpler
 * and more forgiving than trusting the extension.
 */
app.importFile = async (file, { onProgress } = {}) => {
  const text = (await file.text()).replace(/^\uFEFF/, '').trim();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('that file is not a timer export — it is not readable as JSON'); }

  if (data && data.app === 'tagdatimer' && Array.isArray(data.solves)) {
    const n = await importAll(data);
    await app.reload();
    return { kind: 'backup', solves: n, sessions: (data.sessions || []).length };
  }
  if (data && Object.keys(data).some(k => /^session\d+$/.test(k))) {
    const res = await app.importCsTimer(data, { onProgress });
    await app.reload();
    return { kind: 'cstimer', ...res };
  }
  throw new Error('unrecognised export — expected a Tagda backup or a csTimer file');
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
const modalOpen = () => drawerOpen() || paletteOpen() || popoverOpen() || shareOpen() || reconOpen();

function wireInput() {
  let spaceDown = false;
  // Keys that stopped a running solve. Their keyup belongs to that same press
  // and must be swallowed too, or it lands on whatever the key normally does.
  const stopKeys = new Set();

  /**
   * Both listeners run in the CAPTURE phase, before anything else on the
   * document, and stop the event dead when it was the key that ended a solve.
   *
   * Bubble-phase listeners could not do this. The shortcut handler is also on
   * document, so stopping a solve with `d` used to stop the solve *and* mark it
   * DNF, `h` opened the history, `f` went fullscreen — the timer had already
   * moved to `cooldown` by the time the shortcut handler looked at the state,
   * so its own guard let everything through. Killing the event here means one
   * keystroke is one instruction: stop.
   */
  document.addEventListener('keydown', (e) => {
    // Typed times and a Stackmat both own the timer outright; leaving the
    // spacebar live alongside them is how you get two records for one solve.
    if (!timerInputLive()) return;
    if (timer.state === 'running') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        stopKeys.add(e.code || e.key);
        spaceDown = false;
        timer.down();                    // -> stop
      }
      return;
    }
    if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (modalOpen()) return;
    if (spaceDown) return;
    spaceDown = true;
    timer.down();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (!timerInputLive()) return;
    const key = e.code || e.key;
    if (stopKeys.has(key)) {
      stopKeys.delete(key);
      e.preventDefault();
      e.stopImmediatePropagation();
      if (key === 'Space') spaceDown = false;
      timer.up();                        // cooldown -> idle
      return;
    }
    if (e.code !== 'Space') return;
    spaceDown = false;
    if (isTyping() || modalOpen()) return;
    e.preventDefault();
    timer.up();
  }, true);

  // Touch / pen always drive the timer — on a phone there is no other way to
  // start it. A mouse click does not, unless you ask for it: reaching for the
  // mouse mid-session, or a stray click anywhere on the stage, would otherwise
  // start or stop a solve you never meant to touch.
  //
  // ONE listener, on #stage only. #timer-zone lives inside #stage, so binding
  // both meant a single tap on the digits ran the handler twice as it bubbled:
  // down() took idle -> inspecting (swallowing the matching up), then the
  // second down() took inspecting -> holding -> ready, and the second up()
  // started the solve. On a phone -- the one place touch is the only input --
  // inspection was therefore skipped entirely and the timer just ran.
  const pointerOK = (e) => timerInputLive() && ((e.pointerType !== 'mouse') || app.settings.mouseTimer);
  const touchOK = (e) => !modalOpen() && !e.target.closest(
    'button, a, input, select, .solve-chip, .panel, #topbar'
  );

  // A second finger landing mid-solve must not count as a stop, and its release
  // must not count as the release of the first. `isPrimary` is exactly that
  // distinction and the browser maintains it for us: one primary pointer at a
  // time, extra fingers arrive non-primary. Deliberately not a pointer id we
  // latch onto — a press whose release never comes back (capture stolen,
  // inspection abandoned with Esc, the page backgrounded mid-hold) would leave
  // the id set and every later tap ignored, i.e. a screen dead to touch until
  // reload.
  //
  // `tracking` gates only the release, never the press, so it cannot wedge. It
  // says "the press this release belongs to was one we acted on", which is what
  // stops a pointerup that began life on a panel from starting a solve.
  let tracking = false;
  const down = (e) => {
    if (!e.isPrimary) return;
    if (!pointerOK(e) || !touchOK(e)) { tracking = false; return; }
    tracking = true;
    e.preventDefault();
    timer.down();
  };
  const up = (e) => {
    if (!e.isPrimary || !tracking) return;
    tracking = false;
    if (!pointerOK(e) || modalOpen()) return;
    timer.up();
  };

  const stage = $('#stage');
  stage.addEventListener('pointerdown', down);
  // The release goes on the window: a finger that slides off the stage mid-solve
  // would otherwise never deliver its pointerup to #stage, and the solve would
  // keep running with nothing left to stop it.
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);

  window.addEventListener('blur', () => {
    spaceDown = false;
    tracking = false;
    stopKeys.clear();
    if (timer.state !== 'running') timer.reset();
  });
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
      list.push({ sep: true }, { label: 'Pick cases…', badge: 'K', onSelect: () => openPanel('Cases', 'buildCases', undefined, app) });
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
      { label: 'Manage…', onSelect: () => openPanel('Sessions', 'buildSessions', undefined, app) },
    ]);
  });

  $('#btn-recon').addEventListener('click', () => openRecon({
    scramble: app.scramble?.scramble || '',
    title: 'Reconstruct',
    library: reconLibrary(),
  }));
  $('#btn-stats').addEventListener('click', () => openPanel('Statistics', 'buildStats', { wide: true }, app));
  $('#btn-theme').addEventListener('click', () => openPanel('Appearance', 'buildAppearance', undefined, app));
  $('#btn-settings').addEventListener('click', () => openPanel('Settings', 'buildSettings', undefined, app));
  $('#btn-spotify').addEventListener('click', () => openPanel('Spotify', 'buildSpotify', undefined, app));
  $('#btn-help').addEventListener('click', () => openPanel('Keyboard shortcuts', 'buildShortcuts', { wide: true }));
  $('#btn-about').addEventListener('click', () => openPanel('About', 'buildAbout', undefined, app));
  $('#btn-open-history').addEventListener('click', () => openPanel('All solves', 'buildHistory', { wide: true }, app));

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
    cell.addEventListener('click', () => openPanel(STAT_TITLES[k] || k, 'buildStatDetail', { wide: true }, app, k));
  });

  $('#mini-chart-btn')?.addEventListener('click', () =>
    openPanel('Statistics', 'buildStats', { wide: true }, app));

  $('#btn-clear-session').addEventListener('click', clearSession);

  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);

  $('#btn-next-scramble').addEventListener('click', forwardScramble);
  $('#btn-prev-scramble').addEventListener('click', prevScramble);
  $('#btn-copy-scramble').addEventListener('click', () => copyToast(app.scramble?.scramble || '', 'Scramble'));
  $('#btn-custom-scramble').addEventListener('click', () => openPanel('Your scrambles', 'buildCustomScrambles', undefined, app));
  $('#btn-custom-exit').addEventListener('click', () => app.clearCustomScrambles());
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

  wireMascot();
}

/* =========================================================
   Mascot — the brand cube, let loose on the page
   ========================================================= */
function wireMascot() {
  const box = $('#mascot');
  const img = $('#mascot-img');
  if (!box) return;

  const clampSize = (n) => Math.max(90, Math.min(460, Math.round(n)));
  const applySize = () => {
    const n = clampSize(app.settings.mascotSize);
    box.style.width = `${n}px`;
    box.style.height = `${n}px`;
    mascotDrag?.apply();          // a bigger cube can end up off screen
  };

  const mascotDrag = makeDraggable(box, {
    get: () => app.settings.mascotPos,
    set: (pos) => { app.settings.mascotPos = pos; persist(); },
    ignore: '#mascot-bar button',
  });

  const show = (on) => {
    box.hidden = !on;
    app.settings.mascotOpen = on;
    persist();
    if (on) { applySize(); mascotDrag.apply(); }
  };

  $('#brand').addEventListener('click', () => show(box.hidden));
  $('#mascot-close').addEventListener('click', (e) => { e.stopPropagation(); show(false); });
  $('#mascot-bigger').addEventListener('click', (e) => {
    e.stopPropagation();
    app.settings.mascotSize = clampSize(app.settings.mascotSize * 1.25);
    persist(); applySize();
  });
  $('#mascot-smaller').addEventListener('click', (e) => {
    e.stopPropagation();
    app.settings.mascotSize = clampSize(app.settings.mascotSize / 1.25);
    persist(); applySize();
  });
  // Scroll over him to resize, which is what everyone tries first.
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    app.settings.mascotSize = clampSize(app.settings.mascotSize * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    persist(); applySize();
  }, { passive: false });

  applySize();
  if (app.settings.mascotOpen) show(true);
  app.closeMascot = () => show(false);
  void img;
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
      if (reconOpen()) return void closeRecon();
      if (shareOpen()) return closeShare();
      if (paletteOpen()) return closePalette();
      if (!$('#mascot').hidden) return app.closeMascot();
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
      syncTimerDisplay();
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
      case 'x': case 'X': e.preventDefault(); openPanel('Your scrambles', 'buildCustomScrambles', undefined, app); break;
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
      case 'y': case 'Y': e.preventDefault(); $('#btn-recon').click(); break;
      case 'p': case 'P': e.preventDefault(); $('#btn-spotify').click(); break;
      case 'k': case 'K':
        e.preventDefault();
        if (setFor(app.settings.mode)) openPanel('Cases', 'buildCases', undefined, app);
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
      { kind: 'go', label: 'Reconstruct a scramble', key: 'Y', run: () => $('#btn-recon').click() },
      { kind: 'do', label: 'Reconstruct the last solve', run: () => app.solves.at(-1) ? reconstructSolve(app.solves.at(-1)) : toast('No solves yet') },
      { kind: 'go', label: 'Pick trainer cases', key: 'K', run: () => setFor(app.settings.mode) ? openPanel('Cases', 'buildCases', undefined, app) : toast('Current mode has no case list') },
      { kind: 'do', label: 'New session', run: () => app.newSession() },
      { kind: 'do', label: 'New scramble', key: 'N', run: forwardScramble },
      { kind: 'do', label: 'Copy scramble', run: () => copyToast(app.scramble?.scramble || '', 'Scramble') },
      { kind: 'do', label: 'Enter your own scrambles', key: 'X', run: () => openPanel('Your scrambles', 'buildCustomScrambles', undefined, app) },
      { kind: 'do', label: 'Share last solve as a card', run: () => app.solves.at(-1) ? app.shareSolveCard(app.solves.at(-1)) : toast('No solves yet') },
      { kind: 'do', label: 'Share current ao5 as a card', run: () => app.shareAverageCard('ao5') },
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
