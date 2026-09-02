/* ===========================================================
   Tagda Timer — the Cross+1 trainer

   The wall between sub-20 and sub-10 is not cross execution. It is
   that inspection stops at the cross: four edges planned, then the
   solve begins and the first pair is hunted for with the eyes rather
   than found where you left it. This panel drills the other half.

   The loop: look at a scramble for as long as you like, plan the
   cross AND the first pair in your head, start the timer — at which
   point the scramble and the cube go dark and you execute blind —
   then stop, and see what was actually there.

   What comes back is not "the shortest cross". It is every short way
   to finish the cross and one F2L pair *at the same time*, which is a
   different and better question: a cross move that also sets up a
   corner is worth making even when a shorter cross exists without it.
   Each line says which pair it builds, whether it stays on the
   friendly faces, what it took apart to get there, and — the part
   that actually trains lookahead — where the other three pairs are
   left standing afterwards.

   Nothing here touches the timer screen. Its own Timer, its own
   scramble queue, its own settings; opening it mid-session cannot
   disturb a solve or land anything in your stats.
   =========================================================== */

import { el, copy, fmtLive, tidy } from './util.js';
import {
  SOLVED, applyAlg, analyse, parse, canonical, toUserFace, IDENTITY_FRAME,
  FACES, CORNER_NAMES, EDGE_NAMES, CORNER_FACELETS, EDGE_FACELETS,
} from './cube3.js';
import { suggestCrossPlusOne, crossRotation, reframeResult } from './solver.js';
import { faceletsFor, SCHEME } from './cubenet.js';
import { ScrambleQueue } from './scramble.js';
import { Timer } from './timer.js';
import { KV } from './db.js';
import { toast } from './toast.js';

/* The panel's own stylesheet, fetched on the first open — most sessions never
   come in here. The version query is read off a sheet index.html already asked
   for, so a cache-busting deploy cannot leave this one behind. */
function loadCss() {
  if (document.querySelector('link[data-xp1]')) return;
  const v = document.querySelector('link[rel="stylesheet"][href*="?v="]')
    ?.getAttribute('href')?.match(/\?v=([^&"]+)/)?.[1];
  const url = new URL('../css/xplus1.css', import.meta.url).href;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = v ? `${url}?v=${v}` : url;
  link.dataset.xp1 = '1';
  document.head.append(link);
}

/* twisty-player, loaded the same way the scramble preview and the
   reconstruction workbench load it: local mirror first so it works offline,
   CDN as the backup. */
const TWISTY_SOURCES = [
  new URL('../vendor/cubing/cubing/twisty.js', import.meta.url).href,
  'https://cdn.cubing.net/v0/js/cubing/twisty',
];
let twistyLoaded = null;
async function loadTwisty() {
  if (twistyLoaded !== null) return twistyLoaded;
  for (const src of TWISTY_SOURCES) {
    try { await import(/* @vite-ignore */ src); twistyLoaded = true; return true; }
    catch (err) { console.warn('[xp1] could not load', src, err.message); }
  }
  twistyLoaded = false;
  return false;
}

/* ---------------- constants ---------------- */

/* Cubers pick a cross by colour, not by face letter. These are the standard
   scheme cubing.js scrambles assume and every picture in the app paints. */
const CROSS_COLOURS = [
  { face: 'U', name: 'white',  hex: '#ffffff' },
  { face: 'D', name: 'yellow', hex: '#ffe100' },
  { face: 'F', name: 'green',  hex: '#00b04a' },
  { face: 'B', name: 'blue',   hex: '#0051ba' },
  { face: 'R', name: 'red',    hex: '#ec0000' },
  { face: 'L', name: 'orange', hex: '#ff8b00' },
];
const colourOf = (face) => CROSS_COLOURS.find(c => c.face === face);
const crossName = (face) => face === 'auto' ? 'best colour' : `${colourOf(face)?.name || face} cross`;

/* Where each face sits on the unfolded net:
        U
    L   F   R   B
        D                                                        */
const NET_PLACE = { U: [3, 0], L: [0, 3], F: [3, 3], R: [6, 3], B: [9, 3], D: [3, 6] };

/* How far a pair still is, in words. The number is "moves to bring this corner
   and its edge home ignoring everything else" — a true lower bound on the
   insertion, which is exactly the right granularity for "is this one easy?". */
const tierOf = (d) => d === 0 ? 'done' : d <= 3 ? 'easy' : d <= 5 ? 'fair' : 'hard';
const TIER_WORD = { done: 'already in', easy: 'easy', fair: 'fair', hard: 'awkward' };

const DEFAULTS = {
  crossFace: 'U',            // white — where most people start. 'auto' weighs all six
  orient: 'bottom',          // where a fresh scramble starts you: cross down, or as drawn
  view: '3d',                // '3d' turnable cube, or the flat net that shows all six faces
  inspection: 'infinite',    // 'infinite' (default) | 'wca' — 15s, +2, DNF
  blackout: true,            // scramble and cube go dark the moment you start
  hideTime: false,           // …and the clock too, for a full blind rep
  rankTps: false,            // prefer lines that only use R, U, L, D
  rankPreserve: false,       // prefer lines that leave a built pair standing
  showLines: 8,
  maxDepth: 11,
  timeMs: 6000,
  scrambleSource: 'own',     // 'own' | 'timer'
};

const HIST_KEY = 'xp1History';
const HIST_MAX = 200;

/* ---------------- module state ---------------- */

let host = null;
let ui = {};
let tmr = null;
let queue = null;
let onClose = null;
let getTimerScramble = null;

const S = {
  settings: { ...DEFAULTS },
  scramble: '',
  state: null,          // cube3 state after the scramble
  raw: null,            // the search result, as found — orientation-free
  result: null,         // the same result, read from where you are holding it
  searching: false,
  phase: 'plan',        // 'plan' | 'exec' | 'reveal'
  rot: '',              // how the cube is turned in your hands, as an alg
  selKey: null,         // the line being shown on the cube, by its move path
  pairFilter: null,     // show only lines that build this pair (raw slot name)
  plan: '',
  lastTime: null,
  lastPenalty: 'none',
  history: [],
};

export const xp1Open = () => !!host && !host.hidden;

/** The cross face every question below is asked about. */
const faceNow = () => S.settings.crossFace === 'auto'
  ? (S.result?.face || null)
  : S.settings.crossFace;

/* ---------------- which way up the cube is ----------------
   The single most important thing this panel has to get right. A cross+1 is
   only useful if it is written for the cube you are actually holding: turn the
   thing a quarter turn and every R in the answer is an F, the pair you were
   going for is called something else, and the B move you were avoiding has
   stopped being a B. So the orientation is a first-class piece of state you
   can change, not a constant baked in at search time.

   It is carried as an alg rather than a frame because that is the form both
   halves need: the 3D cube is set up with it, and the frame is derived from it. */

/** The rotation a fresh scramble starts on — cross on the bottom, usually. */
const defaultRot = () => crossRotation(faceNow() || 'D', S.settings.orient);

const rotNow = () => S.rot;

/** User face -> solver face, for however the cube is being held right now. */
const frameNow = () => applyAlg(SOLVED, S.rot || '', IDENTITY_FRAME)?.frame || IDENTITY_FRAME;

/**
 * Turn the cube. Nothing is searched again — the answers are the same answers,
 * they just have to be read out from somewhere else, which `reframeResult`
 * does off the paths the search already returned.
 */
function turnCube(rot) {
  S.rot = tidy([S.rot, rot].filter(Boolean).join(' '));
  applyFrame();
  render();
  showCube();
}

function resetRot() {
  S.rot = defaultRot();
  applyFrame();
  render();
  showCube();
}

/** Re-read the stored result for the current orientation. */
function applyFrame() {
  S.result = S.raw ? reframeResult(S.raw, frameNow()) : null;
}

/* =========================================================
   Settings
   ========================================================= */

async function loadSettings() {
  try {
    const saved = await KV.get('xp1Settings', {});
    S.settings = { ...DEFAULTS, ...(saved || {}) };
  } catch { S.settings = { ...DEFAULTS }; }
  try { S.history = (await KV.get(HIST_KEY, [])) || []; } catch { S.history = []; }
}

function setSetting(key, value) {
  S.settings[key] = value;
  KV.set('xp1Settings', S.settings).catch(() => {});
  if (key === 'inspection' && tmr) {
    tmr.cfg.useInspection = value === 'wca';
    tmr.reset();
  }
  /* A different cross, or a different idea of which way up to start, means a
     different default grip — so the cube turns back to it. */
  if (key === 'crossFace' || key === 'orient') {
    S.rot = defaultRot();
    S.pairFilter = null;
    S.selKey = null;
  }
  // Only a different question needs asking again. Turning the cube does not.
  if (key === 'crossFace' || key === 'maxDepth' || key === 'timeMs') {
    S.raw = null;
    S.result = null;
    startSearch();
  } else if (key === 'orient') {
    applyFrame();
  }
  render();
  showCube();
}

/** Swap between the turnable cube and the flat net. */
function setView(v) {
  setSetting('view', v);
  if (v === '3d') mountPlayer().then(showCube);
}

/* =========================================================
   The search, off the main thread

   A joint cross+1 over four pairs is real work — deeper than the plain
   cross and with nothing solved to prune against. On the main thread that
   would be a second of frozen panel during the one phase that is supposed
   to feel unhurried. It runs in the shared solver worker instead, and it
   is started the moment a scramble appears rather than when you stop the
   clock: by the time you want the answer it has been sitting there for
   however long you spent planning.
   ========================================================= */

let worker = null;
let workerDead = false;
const jobs = new Map();
let seq = 0;
let ticket = 0;

function getWorker() {
  if (worker || workerDead) return worker;
  try {
    worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data || {};
      const job = jobs.get(id);
      if (!job) return;
      jobs.delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(result);
    };
    worker.onerror = (e) => {
      console.warn('[xp1] solver worker failed, falling back', e.message);
      workerDead = true;
      worker = null;
      for (const job of jobs.values()) job.reject(new Error('worker died'));
      jobs.clear();
    };
  } catch (err) {
    console.warn('[xp1] no module workers here, solving inline', err.message);
    workerDead = true;
  }
  return worker;
}

function ask(state, frame, opts) {
  const w = getWorker();
  if (!w) {
    // Inline, but after a paint, so the panel is on screen before it blocks.
    return new Promise(r => setTimeout(() => r(suggestCrossPlusOne(state, frame, opts)), 16));
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    w.postMessage({ id, type: 'xp1', state: state.slice().buffer, frame, opts });
  }).catch((err) => {
    if (workerDead) return suggestCrossPlusOne(state, frame, opts);
    throw err;
  });
}

function startSearch() {
  if (!S.state) return;
  const mine = ++ticket;
  S.searching = true;
  S.raw = null;
  S.result = null;
  /* The frame goes in and `orient: 'scramble'` tells the solver to use it
     verbatim rather than working one out for itself — the panel owns which way
     up the cube is, because the panel is where you turn it. */
  const opts = {
    face: S.settings.crossFace,
    orient: 'scramble',
    maxDepth: S.settings.maxDepth,
    timeMs: S.settings.timeMs,
    limit: 60,
  };
  render();
  ask(S.state, frameNow(), opts).then((res) => {
    if (mine !== ticket) return;
    S.searching = false;
    S.raw = res;
    /* Colour-neutral only learns which cross it picked when the search comes
       back, so the default grip can only be settled now. */
    if (S.settings.crossFace === 'auto' && res.face) {
      S.rot = crossRotation(res.face, S.settings.orient);
    }
    applyFrame();
    S.selKey = null;
    S.pairFilter = null;
    render();
    showCube();
  }).catch((err) => {
    if (mine !== ticket) return;
    console.warn('[xp1] search', err);
    S.searching = false;
    S.raw = null;
    S.result = { best: -1, crossBest: -1, list: [], pairs: [], faces: [], built: [], partial: true, failed: true };
    render();
  });
}

/* =========================================================
   Ranking

   Three independent preferences rather than one hardcoded idea of "best",
   because they genuinely disagree: the shortest line is often the one with
   the B move in it, and the line that leaves your built pair alone is
   sometimes a move longer than the one that smashes it.

   Rotations are deliberately absent from this list. The search only ever
   turns the six faces — it cannot produce a solution with a regrip in it —
   so "rotationless" is not a filter to apply here, it is already true of
   every line on screen.
   ========================================================= */

function rankedList() {
  let list = [...(S.result?.list || [])];
  /* Picking a pair off the table means "show me the lines that go for that
     one" — the comparison is only useful if you can then read the answer. */
  if (S.pairFilter) list = list.filter(s => s.rawSlot === S.pairFilter);
  const { rankTps, rankPreserve } = S.settings;
  return list.sort((a, b) => {
    if (rankTps && a.ergo !== b.ergo) return a.ergo - b.ergo;
    if (rankPreserve && a.preserves !== b.preserves) return a.preserves ? -1 : 1;
    return a.moves - b.moves || a.awkward - b.awkward || a.alg.localeCompare(b.alg);
  });
}

/** Does this preference actually separate the lines on screen? */
const preferenceBites = (key) => {
  const list = S.result?.list || [];
  if (!list.length) return false;
  if (key === 'rankTps') return new Set(list.map(s => s.ergo)).size > 1;
  return list.some(s => !s.preserves);
};

const shown = () => rankedList().slice(0, S.settings.showLines);

/**
 * Which line is being shown on the cube.
 *
 * Tracked by its move path rather than its position in the list, because the
 * list genuinely reorders when you turn the cube — a line with a B move in it
 * stops having one from another angle — and the line you were studying jumping
 * out from under you on every rotation is the opposite of what rotating is for.
 */
const selectedIndex = () => {
  const list = shown();
  if (S.selKey) {
    const i = list.findIndex(s => s.path.join() === S.selKey);
    if (i >= 0) return i;
  }
  return 0;
};
const selected = () => shown()[selectedIndex()] || null;

/* =========================================================
   The net

   Drawn through cubenet's simulator rather than cube3's, for one reason:
   cube3 models a rotation as a change of what the next letter means, not
   as something that moves stickers, so it cannot draw a cube that has been
   turned over. cubenet can, and a picture of the cube is only honest if it
   is drawn the way the moves are written — white on the bottom, if that is
   where you are holding it.

   Which cells make up which piece is pure geometry of the layout and does
   not depend on orientation at all, so the corner and edge tables cube3
   already keeps are exactly the right thing to find pieces with: a cubie is
   the unique corner (or edge) showing that set of colours.
   ========================================================= */

function buildNet() {
  const grid = el('div', { class: 'xp-net' });
  const cells = new Array(54);
  for (const [f, [cx, cy]] of Object.entries(NET_PLACE)) {
    const base = FACES.indexOf(f) * 9;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = el('div', {
          class: 'xp-cell',
          style: { gridColumn: String(cx + c + 1), gridRow: String(cy + r + 1) },
        });
        cells[base + r * 3 + c] = cell;
        grid.append(cell);
      }
    }
  }
  return { grid, cells };
}

/** The 54 face letters of a move string, in the net's own U R F D L B order. */
function flatFacelets(moves) {
  const g = faceletsFor(moves, 3);
  const out = new Array(54);
  for (let i = 0; i < 6; i++) {
    const f = FACES[i];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[i * 9 + r * 3 + c] = g[f][r][c];
  }
  return out;
}

const sameColours = (indices, fl, want) => {
  if (indices.length !== want.length) return false;
  const got = indices.map(i => fl[i]).sort().join('');
  return got === [...want].sort().join('');
};

/** Where a corner cubie and its edge are sitting, as facelet indices. */
function pieceCells(fl, cornerIdx, edgeIdx) {
  const out = [];
  const cs = CORNER_FACELETS.find(t => sameColours(t, fl, CORNER_NAMES[cornerIdx]));
  const es = EDGE_FACELETS.find(t => sameColours(t, fl, EDGE_NAMES[edgeIdx]));
  if (cs) out.push(...cs);
  if (es) out.push(...es);
  return out;
}

/**
 * Paint the net for `moves`, ringing the pieces of each pair in `marks`.
 * Returns the facelet array so the caller can reuse it.
 */
function paintNet(moves, marks = []) {
  let fl;
  try { fl = flatFacelets(moves); }
  catch (err) { console.warn('[xp1] net', err); return null; }
  for (let i = 0; i < 54; i++) {
    const cell = ui.cells[i];
    cell.style.background = SCHEME[fl[i]] || '#555';
    cell.removeAttribute('data-mark');
    cell.removeAttribute('title');
  }
  for (const m of marks) {
    for (const i of pieceCells(fl, m.corner, m.edge)) {
      ui.cells[i].dataset.mark = m.tier;
      ui.cells[i].title = `${m.slot} pair — ${TIER_WORD[m.tier]}`;
    }
  }
  return fl;
}

/* =========================================================
   Rendering
   ========================================================= */

function render() {
  if (!host) return;
  renderTop();
  renderStage();
  renderResults();
  renderPlan();
}

function renderTop() {
  ui.scrambleEcho.textContent = S.scramble || 'no scramble yet';
  ui.scrambleEcho.classList.toggle('empty', !S.scramble);
  for (const b of ui.swatches.children) b.classList.toggle('on', b.dataset.face === S.settings.crossFace);
  ui.crossTag.textContent = crossName(S.settings.crossFace)
    + (S.settings.crossFace !== 'auto' && S.settings.orient === 'bottom' ? ' · on the bottom' : '');
}

/* ---------------- the 3D cube ----------------
   A turnable cube rather than only a flat net, because the flat net cannot
   answer "what does this look like from where I am holding it" and that turned
   out to be the question that matters: a cross+1 written for one grip is the
   wrong set of moves for any other. The net stays available on a toggle — it
   is still the only view that shows all six faces at once, which is what you
   want when you are hunting for where a pair has ended up. */
let player = null;
let cubeToken = 0;

async function mountPlayer() {
  if (player || !ui.cube3d) return;
  if (!await loadTwisty() || !customElements.get('twisty-player')) {
    // A dead box helps nobody; fall back to the view that always works.
    ui.cube3d.append(el('div', { class: 'xp-nocube', text: 'the 3D cube could not load — showing the flat net' }));
    setSetting('view', 'net');
    return;
  }
  player = document.createElement('twisty-player');
  player.setAttribute('puzzle', '3x3x3');
  player.setAttribute('background', 'none');
  player.setAttribute('control-panel', 'none');
  player.setAttribute('hint-facelets', 'floating');
  player.setAttribute('back-view', 'top-right');
  player.setAttribute('visualization', '3D');
  player.setAttribute('tempo-scale', '2');
  ui.cube3d.append(player);
  showCube();
}

/**
 * Show the cube the way it is being held — and, once you have had your go,
 * play the line you are looking at on it.
 *
 * Everything is spelt the way twisty-player spells it on the way in: a player
 * handed an alg it cannot read does not turn slowly, it stops.
 */
function showCube() {
  if (!player || S.settings.view !== '3d') return;
  const token = ++cubeToken;
  const sel = S.phase === 'reveal' ? selected() : null;
  const setup = canonical([S.scramble, S.rot].filter(Boolean).join(' ')) ?? '';
  const alg = sel ? (canonical(sel.alg) ?? '') : '';
  try {
    player.pause?.();
    player.setAttribute('experimental-setup-alg', setup);
    player.setAttribute('alg', alg);
    if (!alg) return;
    player.jumpToStart?.();
    // Next frame, so a click mid-turn re-seats cleanly instead of jumping.
    requestAnimationFrame(() => {
      if (token === cubeToken) { try { player.play?.(); } catch { /* ignore */ } }
    });
  } catch (err) { console.warn('[xp1] player', err); }
}

const FACE_WORD = {
  U: 'on top', D: 'on the bottom', F: 'in front',
  B: 'at the back', L: 'on the left', R: 'on the right',
};

/** How the cube is being held, said out loud — the moves only mean this. */
function holdingNote() {
  const f = faceNow();
  if (!f) return S.rot ? `turned ${S.rot}` : 'held as the scramble is drawn';
  const name = colourOf(f)?.name || f;
  const where = FACE_WORD[toUserFace(frameNow(), f)] || '';
  return `${name} ${where}${S.rot ? ` · ${S.rot}` : ''}`;
}

function renderStage() {
  host.classList.toggle('blind', S.phase === 'exec' && S.settings.blackout);
  host.classList.toggle('hide-clock', S.phase === 'exec' && S.settings.blackout && S.settings.hideTime);
  host.dataset.phase = S.phase;
  host.dataset.view = S.settings.view;

  ui.hint.textContent =
    S.phase === 'exec' ? 'eyes shut — execute, then press space to stop'
    : S.phase === 'reveal' ? 'here is what was actually there'
    : S.settings.inspection === 'wca'
      ? 'press space to start the 15 second countdown'
      : 'take as long as you like — press space when you have it';

  for (const b of ui.viewSeg.children) b.classList.toggle('on', b.dataset.view === S.settings.view);
  ui.rotReset.disabled = S.rot === defaultRot();
  ui.holding.textContent = holdingNote();

  /* While planning, the cube is the scramble. After a rep it becomes the
     position the line you are looking at would have left behind, which is the
     whole point: not "was that cross short" but "what did it hand me next". */
  const sel = S.phase === 'reveal' ? selected() : null;
  if (S.settings.view === 'net') {
    paintNet([S.scramble, rotNow(), sel ? sel.alg : ''].filter(Boolean).join(' '),
      sel ? sel.after.map(p => ({ ...p, tier: tierOf(p.dist) })) : []);
  }
  ui.netCap.textContent = sel ? `after ${sel.alg} — the ${sel.slot} pair is in` : holdingNote();

  renderLegend();
}

function renderLegend() {
  ui.legend.innerHTML = '';
  if (S.phase !== 'reveal') return;
  const sel = selected();
  if (!sel) return;
  ui.legend.append(el('span', { class: 'xp-leg-lbl', text: 'left standing' }));
  for (const p of sel.after) {
    const tier = tierOf(p.dist);
    ui.legend.append(el('span', { class: 'xp-chip', dataset: { mark: tier } },
      el('b', { text: p.slot }),
      el('i', { text: p.dist === 0 ? 'already in' : `${p.dist} away · ${TIER_WORD[tier]}` })));
  }
}

/* A preference that cannot change the order of anything on screen is shown as
   idle rather than left looking broken — clicking it and watching the list sit
   perfectly still is the worst of the three possible answers. */
function renderToggles() {
  const rows = [
    [ui.tpsBtn, 'rankTps', 'Put the lines that stay off B and F first',
      'every line here is equally kind to the hands — nothing to reorder'],
    [ui.presBtn, 'rankPreserve', 'Put the lines that leave an already-built pair standing first',
      'this scramble has no pair built yet, so there is nothing to protect'],
  ];
  for (const [btn, key, live, idle] of rows) {
    const bites = preferenceBites(key);
    btn.classList.toggle('on', !!S.settings[key]);
    btn.classList.toggle('idle', S.phase === 'reveal' && !bites);
    btn.title = S.phase !== 'reveal' ? live : bites ? live : idle;
  }
}

function renderResults() {
  ui.list.innerHTML = '';
  ui.headline.innerHTML = '';
  renderToggles();

  if (S.phase !== 'reveal') {
    ui.headline.append(el('span', { class: 'n', text: '·' }),
      el('span', { class: 'lbl', text: S.searching ? 'working the scramble out in the background…' : 'plan it, then start the clock' }));
    ui.list.append(el('div', { class: 'xp-empty', text: 'The lines stay hidden until you have had your go.' }));
    ui.more.textContent = '';
    return;
  }

  if (S.searching) {
    ui.headline.append(el('span', { class: 'n', text: '…' }), el('span', { class: 'lbl', text: 'still searching' }));
    ui.list.append(el('div', { class: 'xp-empty', text: 'thinking…' }));
    return;
  }

  const res = S.result;
  if (!res || res.best < 0) {
    ui.headline.append(el('span', { class: 'n', text: '?' }),
      el('span', { class: 'lbl', text: res?.failed
        ? 'the search could not run here'
        : 'nothing found inside the depth limit — try raising it in settings' }));
    ui.more.textContent = '';
    return;
  }

  /* The number that teaches the lesson: the cross on its own is exact (it is a
     lookup, not a search), so "the pair cost me two extra moves" is a fact. */
  const extra = res.best - res.crossBest;
  ui.headline.append(
    el('span', { class: 'n', text: String(res.best) }),
    el('span', { class: 'lbl', text: `moves for cross + 1 · the cross alone is ${res.crossBest}`
      + (extra <= 0 ? ' — the pair is free' : `, so the pair costs ${extra}`) }));

  /* A pair the scramble already built is lookahead you were handed. Saying so
     is the difference between "why is that line two moves longer" and "because
     it is the one that does not smash the pair you already have". */
  if (res.built?.length) {
    ui.list.append(el('div', { class: 'xp-built' },
      `the scramble already built your ${res.built.join(' and ')} pair`
      + (res.built.length > 1 ? 's' : '') + ' — the lines below say which ones survive'));
  }

  renderPairTable(res);

  const list = shown();
  list.forEach((s, i) => {
    const row = el('div', {
      class: 'xp-sug' + (i === selectedIndex() ? ' on' : '') + (s.moves === res.best ? ' top' : ''),
      title: 'Watch this one on the cube',
      onclick: () => { S.selKey = s.path.join(); render(); showCube(); },
    },
      el('span', {},
        el('span', { class: 'alg', text: s.alg }),
        el('span', { class: 'why' },
          el('b', { text: `${s.slot} pair` }),
          s.highTps ? el('i', { class: 'tag tps', text: 'R U L D only' }) : null,
          s.bMoves ? el('i', { class: 'tag hard', text: s.bMoves === 1 ? '1 B move' : `${s.bMoves} B moves` }) : null,
          s.preserves === false ? el('i', { class: 'tag broke', text: `breaks ${s.broke.join(', ')}` }) : null,
          s.after[0] ? el('i', { class: 'tag next', text: `next: ${s.after[0].slot} ${s.after[0].dist} away` }) : null)),
      el('span', { class: 'len', text: String(s.moves) }),
    );
    ui.list.append(row);
  });

  const total = (res.list || []).length;
  ui.more.textContent = res.partial
    ? `${list.length} of ${total} — the search ran out of budget before it ran out of depth`
    : `${list.length} of ${total} found`;
}

function renderPairTable(res) {
  const rows = (res.pairs || []).filter(p => p.face === res.face);
  if (!rows.length) return;
  const wrap = el('div', { class: 'xp-pairs' },
    el('span', { class: 'xp-pairs-lbl', text: 'shortest, per pair' }));
  for (const p of rows) {
    const on = S.pairFilter === p.rawSlot;
    const dead = p.best < 0;
    wrap.append(el('button', {
      class: 'xp-pair' + (on ? ' on' : '') + (p.best === res.best ? ' best' : '') + (dead ? ' dead' : ''),
      title: dead ? `No line for the ${p.slot} pair inside the depth limit`
        : on ? 'Showing only this pair — click to show them all again'
        : `Show only the lines that build the ${p.slot} pair`,
      disabled: dead || null,
      // Clicking the pair you are curious about is the point of the table.
      onclick: () => { S.pairFilter = on ? null : p.rawSlot; S.selKey = null; render(); showCube(); },
    },
      el('b', { text: p.slot }),
      el('i', { text: dead ? '—' : String(p.best) })));
  }
  if (S.pairFilter) {
    wrap.append(el('button', {
      class: 'xp-pair clear', text: 'show all',
      onclick: () => { S.pairFilter = null; S.selKey = null; render(); showCube(); },
    }));
  }
  ui.list.append(wrap);

  if (S.settings.crossFace === 'auto' && res.faces?.length > 1) {
    const fw = el('div', { class: 'xp-pairs' }, el('span', { class: 'xp-pairs-lbl', text: 'by colour' }));
    for (const f of res.faces) {
      fw.append(el('button', {
        class: 'xp-pair' + (f.face === res.face ? ' best' : ''),
        title: `Solve the ${colourOf(f.face)?.name || f.face} cross instead`,
        onclick: () => setSetting('crossFace', f.face),
      },
        el('b', { text: colourOf(f.face)?.name || f.face }),
        el('i', { text: f.best < 0 ? '—' : String(f.best) })));
    }
    ui.list.append(fw);
  }
}

/* ---------------- what you planned ----------------
   Not scored on move count alone. The useful question is whether the line you
   had in your head actually works — a plan that leaves the cross a move short
   is a different mistake from one that is simply two moves long, and the panel
   should say which it was. */

function checkPlan() {
  const text = S.plan.trim();
  if (!text || !S.state) return null;
  const toks = parse(text);
  if (!toks) return { kind: 'bad', msg: "can't read that — moves look like R U2 F'" };
  const res = applyAlg(S.state, toks, frameNow());
  if (!res) return { kind: 'bad', msg: "can't read that — moves look like R U2 F'" };
  const n = text.split(/\s+/).filter(t => t && !/^[xyz]/i.test(t)).length;
  const a = analyse(res.state, faceNow());
  if (!a.cross) return { kind: 'bad', msg: `${n} moves, but that leaves the cross unfinished` };
  const done = a.slots.filter(s => s.done);
  if (!done.length) return { kind: 'warn', msg: `cross done in ${n} — but no pair with it, so that is a cross, not a cross + 1` };

  const best = S.result?.best ?? -1;
  const fr = frameNow();
  const where = done.map(s => [...s.label].map(f => toUserFace(fr, f)).join('')).join(' + ');
  if (best < 0) return { kind: 'good', msg: `${n} moves — cross + the ${where} pair` };
  const delta = n - best;
  if (delta <= 0) return { kind: 'good', msg: `${n} moves — cross + the ${where} pair. That is optimal.` };
  return {
    kind: delta <= 2 ? 'good' : 'warn',
    msg: `${n} moves — cross + the ${where} pair. ${delta} more than the ${best} that was there.`,
  };
}

function renderPlan() {
  const v = checkPlan();
  ui.planOut.className = 'xp-plan-out' + (v ? ` ${v.kind}` : '');
  ui.planOut.textContent = v ? v.msg
    : 'Optional — type the line you planned and this will tell you whether it works, and what it cost.';
}

/* =========================================================
   The clock
   ========================================================= */

function paintClock() {
  const st = tmr.state;
  host.dataset.state = st;
  if (st === 'inspecting' || ((st === 'holding' || st === 'ready') && tmr.inspectStart)) {
    const left = Math.max(0, 15 - tmr.inspectElapsed / 1000);
    ui.clock.textContent = left <= 0 ? '+2' : String(Math.ceil(left));
  } else if (st === 'running') {
    ui.clock.textContent = fmtLive(tmr.elapsed, 2);
  } else if (S.lastTime !== null) {
    ui.clock.textContent = fmtLive(S.lastTime, 2) + (S.lastPenalty === '+2' ? '+' : '');
  } else {
    ui.clock.textContent = '0.00';
  }
}

function wireTimer() {
  tmr = new Timer({
    inspection: true,
    useInspection: S.settings.inspection === 'wca',
    holdTime: 0,
    minSolveMs: 200,
  });
  tmr.addEventListener('state', paintClock);
  tmr.addEventListener('inspecttick', paintClock);
  tmr.addEventListener('tick', paintClock);
  tmr.addEventListener('cancel', () => { S.phase = 'plan'; render(); paintClock(); });
  tmr.addEventListener('start', () => {
    S.phase = 'exec';
    S.lastTime = null;
    render();
    paintClock();
  });
  tmr.addEventListener('stop', (e) => {
    S.lastTime = e.detail.timeMs;
    S.lastPenalty = e.detail.penalty;
    reveal();
    paintClock();
  });
}

function reveal() {
  S.phase = 'reveal';
  S.selKey = null;
  render();
  showCube();
  recordAttempt();
}

/** A capped rolling log — enough to see whether you are closing on optimal,
    and deliberately not a second stats subsystem. */
function recordAttempt() {
  const res = S.result;
  const v = checkPlan();
  S.history.push({
    at: Date.now(),
    scramble: S.scramble,
    face: res?.face || S.settings.crossFace,
    crossBest: res?.crossBest ?? -1,
    best: res?.best ?? -1,
    timeMs: S.lastTime,
    penalty: S.lastPenalty,
    plan: S.plan.trim() || null,
    planOk: v ? v.kind !== 'bad' : null,
  });
  if (S.history.length > HIST_MAX) S.history = S.history.slice(-HIST_MAX);
  KV.set(HIST_KEY, S.history).catch(() => {});
}

/* =========================================================
   Scrambles
   ========================================================= */

async function nextScramble() {
  let text = '';
  if (S.settings.scrambleSource === 'timer' && getTimerScramble) {
    text = getTimerScramble() || '';
  }
  if (!text) {
    if (!queue) { queue = new ScrambleQueue(2); queue.setContext('333', 'wca', {}); }
    ui.newBtn.disabled = true;
    try { text = (await queue.next())?.scramble || ''; }
    finally { ui.newBtn.disabled = false; }
  }
  setScramble(text);
}

function setScramble(text) {
  const clean = canonical(String(text || '').replace(/\s+/g, ' ').trim());
  if (clean === null) { toast('That scramble has a move I cannot read', { kind: 'bad' }); return false; }
  const start = applyAlg(SOLVED, clean);
  if (!start) { toast('That scramble has a move I cannot read', { kind: 'bad' }); return false; }
  S.scramble = clean;
  S.state = start.state;
  S.raw = null;
  S.result = null;
  S.selKey = null;
  S.pairFilter = null;
  S.phase = 'plan';
  S.plan = '';
  S.lastTime = null;
  S.rot = defaultRot();
  if (ui.planBox) ui.planBox.value = '';
  tmr?.reset();
  render();
  paintClock();
  showCube();
  startSearch();
  return true;
}

/* =========================================================
   Input

   The panel owns the keyboard while it is open. main.js already stands down
   — its space handler bails on modalOpen(), which counts this panel — so
   these are the only listeners that see the key, and nothing here can
   accidentally start a solve on the timer screen behind.

   Capture phase, and that is load-bearing for exactly one key. main.js's
   Escape handler is on document too, and it was bound at start-up, so in the
   bubble phase it would always run first — and it closes this panel. Escape
   during an attempt has to mean "abandon the attempt", the way it does on the
   timer screen, so this has to get there first and stop the event when it did
   something with it.
   ========================================================= */
const KEY_OPTS = { capture: true };

let spaceDown = false;

const typing = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

function onKeyDown(e) {
  if (e.key === 'Escape') {
    // Abandon the attempt first; only a second Escape leaves the panel.
    if (tmr.state !== 'idle' && tmr.state !== 'cooldown') { e.stopPropagation(); tmr.cancel(); }
    return;
  }
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    // Also stops the key activating whatever button was last clicked.
    e.preventDefault();
    if (spaceDown || e.repeat) return;
    spaceDown = true;
    tmr.down();
    return;
  }
  if (tmr.state !== 'idle' && tmr.state !== 'cooldown') return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); nextScramble(); }
  if (e.key === 'Enter') { e.preventDefault(); if (S.phase !== 'reveal') showAnswer(); }
}

function onKeyUp(e) {
  if (e.code !== 'Space') return;
  spaceDown = false;
  if (typing(e)) return;
  e.preventDefault();
  tmr.up();
}

/** Skip the rep and just look. Study mode — no time recorded. */
function showAnswer() {
  if (!S.scramble) return;
  tmr.reset();
  S.lastTime = null;
  S.phase = 'reveal';
  S.selKey = null;
  render();
  paintClock();
  showCube();
}

/* =========================================================
   Building the panel
   ========================================================= */

function build() {
  host = el('div', { id: 'xp1', hidden: true });

  /* ---- top bar ---- */
  ui.scrambleEcho = el('div', { class: 'xp-scramble mono', title: 'The scramble you are planning' });

  ui.swatches = el('span', { class: 'xp-swatches' },
    ...CROSS_COLOURS.map(c => el('button', {
      class: 'xp-swatch', title: `${c.name} cross`, 'aria-label': `${c.name} cross`,
      dataset: { face: c.face }, style: { background: c.hex },
      onclick: () => setSetting('crossFace', c.face),
    })),
    el('button', {
      class: 'xp-swatch auto', title: 'Weigh up all six colours — slower, but a real answer',
      dataset: { face: 'auto' }, text: 'auto', onclick: () => setSetting('crossFace', 'auto'),
    }));

  const top = el('div', { class: 'xp-top' },
    el('button', {
      class: 'ghost-btn sm', onclick: () => close(),
      html: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg> back to timer',
    }),
    el('div', { class: 'xp-cross-pick' }, el('span', { text: 'cross' }), ui.swatches),
    ui.crossTag = el('span', { class: 'xp-cross-tag' }),
    el('div', { class: 'xp-spacer' }),
    el('button', {
      class: 'ghost-btn sm', title: 'Copy the scramble',
      onclick: () => copy(S.scramble).then(ok => toast(ok ? 'Scramble copied' : 'Clipboard blocked', { kind: ok ? 'good' : 'bad' })),
      html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
    }),
    ui.settingsWrap = el('div', { class: 'xp-setwrap' },
      el('button', {
        class: 'ghost-btn sm', title: 'Trainer settings', onclick: toggleSettings,
        html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1"/><path d="M4.5 12h2M17.5 12h2M12 4.5v2M12 17.5v2"/></svg> settings',
      }),
      ui.settingsPop = el('div', { class: 'xp-settings', hidden: true })),
    el('div', { class: 'xp-title', text: 'Cross + 1' }),
  );

  /* ---- left: the clock, the scramble, the cube ---- */
  ui.clock = el('div', { class: 'xp-clock', text: '0.00' });
  ui.hint = el('div', { class: 'xp-hint' });
  const net = buildNet();
  ui.cells = net.cells;
  ui.netCap = el('div', { class: 'xp-netcap' });
  ui.legend = el('div', { class: 'xp-legend' });

  ui.newBtn = el('button', { class: 'ghost-btn sm', text: 'new scramble  (N)', onclick: () => nextScramble() });

  ui.cube3d = el('div', { class: 'xp-cube3d' });

  /* Whole-cube rotations. These are the answer to "the moves are for one grip
     and I hold it another way": every line, every slot name and every ergonomic
     score is re-read from the new orientation the instant one of these is
     pressed. No search runs again — the answers did not change, only the way
     they are written down. */
  ui.rots = el('div', { class: 'xp-rots' },
    el('span', { class: 'xp-rots-lbl', text: 'turn' }),
    ...['x', "x'", 'y', "y'", 'z', "z'"].map(r => el('button', {
      class: 'xp-rot', text: r, title: `Turn the whole cube: ${r} — the moves rewrite themselves`,
      onclick: () => turnCube(r),
    })),
    ui.rotReset = el('button', {
      class: 'xp-rot reset', text: 'reset', title: 'Back to the cross on the bottom',
      onclick: resetRot,
    }),
    ui.viewSeg = el('div', { class: 'xp-seg xp-view' },
      el('button', { class: 'xp-seg-btn', dataset: { view: '3d' }, text: '3D', onclick: () => setView('3d') }),
      el('button', { class: 'xp-seg-btn', dataset: { view: 'net' }, text: 'net', onclick: () => setView('net') })),
    ui.holding = el('span', { class: 'xp-holding' }),
  );

  const stage = el('section', { class: 'panel xp-stage' },
    ui.clock,
    ui.hint,
    el('div', { class: 'xp-hideable' },
      ui.scrambleEcho,
      el('div', { class: 'xp-cubewrap' },
        ui.cube3d,
        el('div', { class: 'xp-netwrap' }, net.grid)),
      ui.netCap,
      ui.rots,
    ),
    el('div', { class: 'xp-blindnote', text: 'blacked out — you planned it, now do it' }),
    ui.legend,
    el('div', { class: 'xp-actions' },
      ui.newBtn,
      el('button', { class: 'ghost-btn sm', text: 'show me  (Enter)', onclick: showAnswer }),
    ),
  );
  /* A tap anywhere on the stage drives the clock, the way the timer screen
     does — and, like the timer screen, only from a finger. A mouse click has
     to be able to land on this panel without starting a rep, or every attempt
     to select the scramble text becomes an attempt nobody asked for. */
  const stagePointer = (e, fn) => {
    if (e.pointerType === 'mouse') return;
    if (e.target.closest('button, input, a, .xp-sug')) return;
    e.preventDefault();
    fn();
  };
  stage.addEventListener('pointerdown', e => stagePointer(e, () => tmr.down()));
  stage.addEventListener('pointerup', e => stagePointer(e, () => tmr.up()));

  /* ---- right: the answers ---- */
  ui.headline = el('div', { class: 'xp-headline' });
  ui.list = el('div', { class: 'xp-sugs' });
  ui.more = el('div', { class: 'xp-more' });

  ui.tpsBtn = el('button', { class: 'xp-toggle', text: 'easy hands',
    onclick: () => setSetting('rankTps', !S.settings.rankTps) });
  ui.presBtn = el('button', { class: 'xp-toggle', text: 'keep built pairs',
    onclick: () => setSetting('rankPreserve', !S.settings.rankPreserve) });

  ui.planBox = el('input', {
    class: 'xp-inp mono', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'the line you planned…', 'aria-label': 'The cross + 1 you planned',
  });
  ui.planBox.addEventListener('keydown', e => e.stopPropagation());
  ui.planBox.addEventListener('input', () => {
    const pos = ui.planBox.selectionStart;
    const up = ui.planBox.value.replace(/[a-z]/g, c => c.toUpperCase());
    if (up !== ui.planBox.value) { ui.planBox.value = up; ui.planBox.setSelectionRange(pos, pos); }
    S.plan = ui.planBox.value;
    renderPlan();
  });
  ui.planOut = el('div', { class: 'xp-plan-out' });

  const side = el('aside', { class: 'xp-side' },
    el('section', { class: 'panel xp-answers' },
      el('div', { class: 'panel-head' },
        el('span', { text: 'Cross + 1' }),
        el('span', { class: 'xp-toggles' }, el('span', { class: 'xp-toggles-lbl', text: 'prefer' }), ui.tpsBtn, ui.presBtn)),
      ui.headline, ui.list, ui.more),
    el('section', { class: 'panel xp-planner' },
      el('div', { class: 'panel-head' }, el('span', { text: 'What you planned' })),
      ui.planBox, ui.planOut),
  );

  host.append(top, el('div', { class: 'xp-body' }, stage, side));
  host.addEventListener('click', (e) => {
    if (!ui.settingsPop.hidden && !ui.settingsWrap.contains(e.target)) ui.settingsPop.hidden = true;
  });
  document.body.append(host);
}

/* ---------------- settings sheet ---------------- */

function toggleSettings(e) {
  e?.stopPropagation();
  const open = ui.settingsPop.hidden;
  ui.settingsPop.hidden = !open;
  if (open) buildSettings();
}

const setRow = (label, sub, control) => el('div', { class: 'xp-set-row' },
  el('span', {}, el('b', { text: label }), sub ? el('i', { text: sub }) : null), control);

function choice(options, value, onPick) {
  const wrap = el('div', { class: 'xp-seg' });
  for (const o of options) {
    wrap.append(el('button', {
      class: 'xp-seg-btn' + (o.value === value ? ' on' : ''), text: o.label, title: o.title || '',
      onclick: () => { onPick(o.value); buildSettings(); },
    }));
  }
  return wrap;
}

const switchBtn = (on, onToggle) => el('button', {
  class: 'xp-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false',
  onclick: () => { onToggle(!on); buildSettings(); },
}, el('span', {}));

function buildSettings() {
  const s = S.settings;
  ui.settingsPop.innerHTML = '';
  ui.settingsPop.append(
    setRow('Inspection', 'off by default — this is planning practice, not a comp run',
      choice([
        { value: 'infinite', label: 'unlimited', title: 'Plan for as long as you like' },
        { value: 'wca', label: '15 seconds', title: 'Real WCA inspection, with +2 and DNF' },
      ], s.inspection, v => setSetting('inspection', v))),

    setRow('Starting grip', 'where each new scramble puts the cross — turn it any way you like from there',
      choice([
        { value: 'bottom', label: 'cross down', title: 'The way you actually solve' },
        { value: 'scramble', label: 'as scrambled', title: 'White on top, the way the picture is drawn' },
      ], s.orient, v => setSetting('orient', v))),

    setRow('Cube view', '',
      choice([
        { value: '3d', label: '3D', title: 'A cube you can turn, and watch the line play out on' },
        { value: 'net', label: 'flat net', title: 'All six faces at once' },
      ], s.view, v => setView(v))),

    setRow('Black out when you start', 'the scramble and the cube go dark so the execution is blind',
      switchBtn(s.blackout, v => setSetting('blackout', v))),

    setRow('Hide the clock too', 'only while blacked out',
      switchBtn(s.hideTime, v => setSetting('hideTime', v))),

    setRow('Scrambles', 'where the next one comes from',
      choice([
        { value: 'own', label: 'generate here' },
        { value: 'timer', label: "the timer's", title: 'Drill the scramble that is on the timer screen right now' },
      ], s.scrambleSource, v => setSetting('scrambleSource', v))),

    setRow('Lines to show', '',
      choice([4, 8, 15].map(n => ({ value: n, label: String(n) })), s.showLines, v => setSetting('showLines', v))),

    setRow('Search depth', 'deeper finds more and takes longer',
      choice([10, 11, 12].map(n => ({ value: n, label: String(n) })), s.maxDepth, v => setSetting('maxDepth', v))),

    el('p', { class: 'xp-set-note', text:
      'Every line the search returns is already rotation-free — it only ever turns the six faces, '
      + 'so there is no regrip to filter out.' }),
  );
}

/* =========================================================
   Open / close
   ========================================================= */

/**
 * Open the trainer.
 *   scramble    a scramble to start on, if you have one to hand
 *   timerScramble  () => the scramble on the timer screen right now
 */
export async function openXp1({ scramble = '', timerScramble = null, onExit = null } = {}) {
  if (!host) {
    loadCss();
    await loadSettings();
    build();
    wireTimer();
  }
  onClose = onExit;
  getTimerScramble = timerScramble;

  host.hidden = false;
  document.body.classList.add('xp1-open');
  document.addEventListener('keydown', onKeyDown, KEY_OPTS);
  document.addEventListener('keyup', onKeyUp, KEY_OPTS);

  buildSettings();
  if (S.settings.view === '3d') mountPlayer();
  const start = (S.settings.scrambleSource === 'timer' && timerScramble && timerScramble()) || scramble;
  if (start) setScramble(start);
  else if (!S.scramble) await nextScramble();
  else { render(); paintClock(); showCube(); }

  // Get the worker and its pruning tables warming now, not on the first answer.
  setTimeout(() => { try { getWorker(); } catch { /* ignore */ } }, 0);
}

export function closeXp1() {
  if (!host || host.hidden) return false;
  if (host.contains(document.activeElement)) document.activeElement.blur();
  document.removeEventListener('keydown', onKeyDown, KEY_OPTS);
  document.removeEventListener('keyup', onKeyUp, KEY_OPTS);
  spaceDown = false;
  tmr?.reset();
  host.hidden = true;
  document.body.classList.remove('xp1-open');
  onClose?.();
  return true;
}
const close = closeXp1;
