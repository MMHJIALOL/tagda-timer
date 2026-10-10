import { t, lang } from './i18n.js';
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

import { el, copy, fmtLive, tidy, capitaliseTypedMove } from './util.js';
import {
  SOLVED, applyAlg, analyse, parse, canonical, toUserFace, IDENTITY_FRAME,
  FACES, CORNER_NAMES, EDGE_NAMES, CORNER_FACELETS, EDGE_FACELETS,
} from './cube3.js';
import { suggestCrossPlusOne, crossRotation, reframeResult } from './solver.js';
import { faceletsFor, SCHEME } from './cubenet.js';
import { faceSpots } from './recon.js';
import { ScrambleQueue } from './scramble.js';
import { Timer } from './timer.js';
import { KV } from './db.js';
import { toast } from './toast.js';
import { isPhone, onPhoneChange } from './phone.js';
import { openSheet, sheetRows, closeAllSheets } from './sheet.js';
import { createMovePad } from './movepad.js';

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
  if (customElements.get('twisty-player') || twistyLoaded) return true;
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
const crossName = (face) => face === 'auto' ? t('best colour') : t(`${colourOf(face)?.name || face} cross`);

/* Where each face sits on the unfolded net:
        U
    L   F   R   B
        D                                                        */
const NET_PLACE = { U: [3, 0], L: [0, 3], F: [3, 3], R: [6, 3], B: [9, 3], D: [3, 6] };

/* How far a pair still is, in words. The number is "moves to bring this corner
   and its edge home ignoring everything else" — a true lower bound on the
   insertion, which is exactly the right granularity for "is this one easy?". */
const tierOf = (d) => d === 0 ? 'done' : d <= 3 ? 'easy' : d <= 5 ? 'fair' : 'hard';
const TIER_WORD = { done: t('already in'), easy: t('easy'), fair: t('fair'), hard: t('awkward') };

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
let library = [];       // the session's solves, to drill one of their scrambles

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
    worker = new Worker(new URL(`./solver.worker.js?lang=${lang}`, import.meta.url), { type: 'module' });
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
      for (const job of jobs.values()) job.reject(new Error(t('worker died')));
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
      ui.cells[i].title = t('{slot} pair — {tier}', { slot: m.slot, tier: TIER_WORD[m.tier] });
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
  renderPhone();
}

function renderTop() {
  ui.scrambleEcho.textContent = S.scramble || t('no scramble yet');
  ui.scrambleEcho.classList.toggle('empty', !S.scramble);
  // Never rewrite the box under somebody who is still typing in it.
  if (document.activeElement !== ui.scrambleBox) ui.scrambleBox.value = S.scramble;
  for (const b of ui.swatches.children) b.classList.toggle('on', b.dataset.face === S.settings.crossFace);
  ui.crossTag.textContent = crossName(S.settings.crossFace)
    + (S.settings.crossFace !== 'auto' && S.settings.orient === 'bottom' ? t(' · on the bottom') : '');
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
    if (!ui.cube3d.querySelector('.xp-nocube')) {
      ui.cube3d.append(el('div', { class: 'xp-nocube', text: t('the 3D cube could not load — showing the flat net') }));
    }
    setSetting('view', 'net');
    return;
  }
  // Another caller may have mounted it while the module was loading.
  if (player) return;
  ui.cube3d.querySelector('.xp-nocube')?.remove();
  player = document.createElement('twisty-player');
  player.setAttribute('puzzle', '3x3x3');
  player.setAttribute('background', 'none');
  player.setAttribute('control-panel', 'none');
  player.setAttribute('hint-facelets', 'floating');
  player.setAttribute('back-view', 'top-right');
  player.setAttribute('visualization', '3D');
  player.setAttribute('tempo-scale', '2');
  ui.cube3d.append(player);
  watchCamera();
  showCube();
}

/* ---------------- face letters ----------------
   Drag the cube round and R is no longer on the right. Same answer as the
   reconstruction workbench: the six letters follow the camera. The x/y/z
   buttons already turn the cube itself, so only a drag can put them out of
   step, and only the drag is tracked. */
const HOME_VIEW = { latitude: 35, longitude: 30 };   // where cubing.js parks the camera
const apart = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

function paintFaces({ latitude, longitude }) {
  const moved = Math.abs(latitude - HOME_VIEW.latitude) > 4 || apart(longitude, HOME_VIEW.longitude) > 4;
  ui.faces.hidden = !moved;
  if (!moved || !player) return;
  const pb = player.getBoundingClientRect(), sb = ui.cube3d.getBoundingClientRect();
  if (!pb.width || !sb.width) return;
  const cx = pb.x - sb.x + pb.width / 2;
  const cy = pb.y - sb.y + pb.height / 2;
  const r = Math.min(pb.width, pb.height) * 0.52;
  for (const spot of faceSpots(latitude, longitude)) {
    const tag = ui.faceTags[spot.face];
    tag.style.left = `${cx + spot.x * r}px`;
    tag.style.top = `${cy + spot.y * r}px`;
    tag.classList.toggle('back', !spot.front);
  }
}

function watchCamera() {
  const orbit = player?.experimentalModel?.twistySceneModel?.orbitCoordinates;
  if (typeof orbit?.addFreshListener !== 'function') return;
  orbit.addFreshListener((c) => { try { paintFaces(c); } catch { /* not laid out yet */ } });
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
  /* Checking a planned line on a phone: the cube is where that line leaves it. */
  const planned = phoneOn() && phoneView() === 'check' && XP.checked ? (canonical(S.plan.trim()) ?? '') : '';
  const sel = S.phase === 'reveal' && !planned && !(phoneOn() && phoneView() === 'check') ? selected() : null;
  const setup = canonical([S.scramble, S.rot, planned].filter(Boolean).join(' ')) ?? '';
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
  U: t('on top'), D: t('on the bottom'), F: t('in front'),
  B: t('at the back'), L: t('on the left'), R: t('on the right'),
};

/** How the cube is being held, said out loud — the moves only mean this. */
function holdingNote() {
  const f = faceNow();
  if (!f) return S.rot ? t('turned {r}', { r: S.rot }) : t('held as the scramble is drawn');
  const name = colourOf(f)?.name || f;
  const where = FACE_WORD[toUserFace(frameNow(), f)] || '';
  return `${t(name)} ${where}${S.rot ? ` · ${S.rot}` : ''}`;
}

function renderStage() {
  host.classList.toggle('blind', S.phase === 'exec' && S.settings.blackout);
  host.classList.toggle('hide-clock', S.phase === 'exec' && S.settings.blackout && S.settings.hideTime);
  host.dataset.phase = S.phase;
  host.dataset.view = S.settings.view;

  ui.hint.textContent =
    S.phase === 'exec' ? t('eyes shut — execute, then press space to stop')
    : S.phase === 'reveal' ? t('here is what was actually there')
    : S.settings.inspection === 'wca'
      ? t('press space to start the 15 second countdown')
      : t('take as long as you like — press space when you have it');

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
  ui.netCap.textContent = sel ? t('after {alg} — the {slot} pair is in', { alg: sel.alg, slot: sel.slot }) : holdingNote();

  renderLegend();
}

function renderLegend() {
  ui.legend.innerHTML = '';
  if (S.phase !== 'reveal') return;
  const sel = selected();
  if (!sel) return;
  ui.legend.append(el('span', { class: 'xp-leg-lbl', text: t('left standing') }));
  for (const p of sel.after) {
    const tier = tierOf(p.dist);
    ui.legend.append(el('span', { class: 'xp-chip', dataset: { mark: tier } },
      el('b', { text: p.slot }),
      el('i', { text: p.dist === 0 ? t('already in') : t('{n} away · {tier}', { n: p.dist, tier: TIER_WORD[tier] }) })));
  }
}

/* A preference that cannot change the order of anything on screen is shown as
   idle rather than left looking broken — clicking it and watching the list sit
   perfectly still is the worst of the three possible answers. */
function renderToggles() {
  const rows = [
    [ui.tpsBtn, 'rankTps', t('Put the lines that stay off B and F first'),
      t('every line here is equally kind to the hands — nothing to reorder')],
    [ui.presBtn, 'rankPreserve', t('Put the lines that leave an already-built pair standing first'),
      t('this scramble has no pair built yet, so there is nothing to protect')],
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
      el('span', { class: 'lbl', text: S.searching ? t('working the scramble out in the background…') : t('plan it, then start the clock') }));
    ui.list.append(el('div', { class: 'xp-empty', text: t('The lines stay hidden until you have had your go.') }));
    ui.more.textContent = '';
    return;
  }

  if (S.searching) {
    ui.headline.append(el('span', { class: 'n', text: '…' }), el('span', { class: 'lbl', text: t('still searching') }));
    ui.list.append(el('div', { class: 'xp-empty', text: t('thinking…') }));
    return;
  }

  const res = S.result;
  if (!res || res.best < 0) {
    ui.headline.append(el('span', { class: 'n', text: '?' }),
      el('span', { class: 'lbl', text: res?.failed
        ? t('the search could not run here')
        : t('nothing found inside the depth limit — try raising it in settings') }));
    ui.more.textContent = '';
    return;
  }

  /* The number that teaches the lesson: the cross on its own is exact (it is a
     lookup, not a search), so "the pair cost me two extra moves" is a fact. */
  const extra = res.best - res.crossBest;
  ui.headline.append(
    el('span', { class: 'n', text: String(res.best) }),
    el('span', { class: 'lbl', text: t('moves for cross + 1 · the cross alone is {n}', { n: res.crossBest })
      + (extra <= 0 ? t(' — the pair is free') : t(', so the pair costs {n}', { n: extra })) }));

  /* A pair the scramble already built is lookahead you were handed. Saying so
     is the difference between "why is that line two moves longer" and "because
     it is the one that does not smash the pair you already have". */
  if (res.built?.length) {
    ui.list.append(el('div', { class: 'xp-built' },
      t(res.built.length > 1 ? 'the scramble already built your {slots} pairs' : 'the scramble already built your {slots} pair',
        { slots: res.built.join(t(' and ')) })
      + t(' — the lines below say which ones survive')));
  }

  renderPairTable(res);

  const list = shown();
  list.forEach((s, i) => {
    const row = el('div', {
      class: 'xp-sug' + (i === selectedIndex() ? ' on' : '') + (s.moves === res.best ? ' top' : ''),
      title: t('Watch this one on the cube'),
      onclick: () => { S.selKey = s.path.join(); render(); showCube(); },
    },
      el('span', {},
        el('span', { class: 'alg', text: s.alg }),
        el('span', { class: 'why' },
          el('b', { text: t('{slot} pair', { slot: s.slot }) }),
          s.highTps ? el('i', { class: 'tag tps', text: t('R U L D only') }) : null,
          s.bMoves ? el('i', { class: 'tag hard', text: s.bMoves === 1 ? t('1 B move') : t('{n} B moves', { n: s.bMoves }) }) : null,
          s.preserves === false ? el('i', { class: 'tag broke', text: t('breaks {slots}', { slots: s.broke.join(', ') }) }) : null,
          s.after[0] ? el('i', { class: 'tag next', text: t('next: {slot} {n} away', { slot: s.after[0].slot, n: s.after[0].dist }) }) : null)),
      el('span', { class: 'len', text: String(s.moves) }),
    );
    ui.list.append(row);
  });

  const total = (res.list || []).length;
  ui.more.textContent = res.partial
    ? t('{n} of {total} — the search ran out of budget before it ran out of depth', { n: list.length, total })
    : t('{n} of {total} found', { n: list.length, total });
}

function renderPairTable(res) {
  const rows = (res.pairs || []).filter(p => p.face === res.face);
  if (!rows.length) return;
  const wrap = el('div', { class: 'xp-pairs' },
    el('span', { class: 'xp-pairs-lbl', text: t('shortest, per pair') }));
  for (const p of rows) {
    const on = S.pairFilter === p.rawSlot;
    const dead = p.best < 0;
    wrap.append(el('button', {
      class: 'xp-pair' + (on ? ' on' : '') + (p.best === res.best ? ' best' : '') + (dead ? ' dead' : ''),
      title: dead ? t('No line for the {slot} pair inside the depth limit', { slot: p.slot })
        : on ? t('Showing only this pair — click to show them all again')
        : t('Show only the lines that build the {slot} pair', { slot: p.slot }),
      disabled: dead || null,
      // Clicking the pair you are curious about is the point of the table.
      onclick: () => { S.pairFilter = on ? null : p.rawSlot; S.selKey = null; render(); showCube(); },
    },
      el('b', { text: p.slot }),
      el('i', { text: dead ? '—' : String(p.best) })));
  }
  if (S.pairFilter) {
    wrap.append(el('button', {
      class: 'xp-pair clear', text: t('show all'),
      onclick: () => { S.pairFilter = null; S.selKey = null; render(); showCube(); },
    }));
  }
  ui.list.append(wrap);

  if (S.settings.crossFace === 'auto' && res.faces?.length > 1) {
    const fw = el('div', { class: 'xp-pairs' }, el('span', { class: 'xp-pairs-lbl', text: t('by colour') }));
    for (const f of res.faces) {
      fw.append(el('button', {
        class: 'xp-pair' + (f.face === res.face ? ' best' : ''),
        title: t('Solve the {cross} instead', { cross: t(`${colourOf(f.face)?.name || f.face} cross`) }),
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
  if (!toks) return { kind: 'bad', msg: t("can't read that — moves look like R U2 F'") };
  const res = applyAlg(S.state, toks, frameNow());
  if (!res) return { kind: 'bad', msg: t("can't read that — moves look like R U2 F'") };
  const n = text.split(/\s+/).filter(t => t && !/^[xyz]/i.test(t)).length;
  const a = analyse(res.state, faceNow());
  if (!a.cross) return { kind: 'bad', msg: t('{n} moves, but that leaves the cross unfinished', { n }) };
  const done = a.slots.filter(s => s.done);
  if (!done.length) return { kind: 'warn', msg: t('cross done in {n} — but no pair with it, so that is a cross, not a cross + 1', { n }) };

  const best = S.result?.best ?? -1;
  const fr = frameNow();
  const where = done.map(s => [...s.label].map(f => toUserFace(fr, f)).join('')).join(t(' + '));
  if (best < 0) return { kind: 'good', msg: t('{n} moves — cross + the {slot} pair', { n, slot: where }) };
  const delta = n - best;
  if (delta <= 0) return { kind: 'good', msg: t('{n} moves — cross + the {slot} pair. That is optimal.', { n, slot: where }) };
  return {
    kind: delta <= 2 ? 'good' : 'warn',
    msg: t('{n} moves — cross + the {slot} pair. {delta} more than the {best} that was there.', { n, slot: where, delta, best }),
  };
}

function renderPlan() {
  const v = checkPlan();
  ui.planOut.className = 'xp-plan-out' + (v ? ` ${v.kind}` : '');
  ui.planOut.textContent = v ? v.msg
    : t('Optional — type the line you planned and this will tell you whether it works, and what it cost.');
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
  phoneClock();
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
  XP.check = false;
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
  XP.planStart = performance.now();
  XP.pairAuto = true;
  if (XP.check) { XP.check = false; XP.checked = false; xh.pad?.hide(); }
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
  if (phoneOn() && phoneView() === 'check' && !document.querySelector('.sheet')) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCheck(false); return; }
    if (!typing(e) || e.target === xh.field) {
      if (xh.pad.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
  }
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
  XP.check = false;
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
  ui.scrambleEcho = el('div', { class: 'xp-scramble mono', title: t('The scramble you are planning') });

  ui.swatches = el('span', { class: 'xp-swatches' },
    ...CROSS_COLOURS.map(c => el('button', {
      class: 'xp-swatch', title: `${c.name} cross`, 'aria-label': `${c.name} cross`,
      dataset: { face: c.face }, style: { background: c.hex },
      onclick: () => setSetting('crossFace', c.face),
    })),
    el('button', {
      class: 'xp-swatch auto', title: t('Weigh up all six colours — slower, but a real answer'),
      dataset: { face: 'auto' }, text: 'auto', onclick: () => setSetting('crossFace', 'auto'),
    }));

  /* Your own scramble. Typed or pasted; it lands when you press Enter or leave
     the box, and a bad one puts the last good scramble back. */
  ui.scrambleBox = el('input', {
    class: 'xp-inp mono', spellcheck: 'false', autocomplete: 'off',
    placeholder: t('paste or type your own scramble…'), 'aria-label': t('Scramble to drill'),
  });
  ui.scrambleBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') ui.scrambleBox.blur();
  });
  ui.scrambleBox.addEventListener('input', e => capitaliseTypedMove(ui.scrambleBox, e));
  ui.scrambleBox.addEventListener('change', () => {
    const text = ui.scrambleBox.value.trim();
    if (!text || !setScramble(text)) ui.scrambleBox.value = S.scramble;
  });

  /* Laid out the way the reconstruction workbench does it: the app's mark, the
     way back, and the scramble as a wide bar of its own with copy inside it. */
  const top = el('div', { class: 'xp-top' },
    el('span', { class: 'xp-brand' },
      el('img', {
        class: 'brand-mark', src: 'assets/logo-96.png', alt: '',
        width: '96', height: '96', decoding: 'async',
      }),
      el('span', { class: 'brand-text', html: 'Tagda <b>Timer</b>' })),
    el('button', {
      class: 'ghost-btn sm', onclick: () => close(),
      html: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg> ' + t('back to timer'),
    }),
    el('div', { class: 'xp-scr' },
      el('span', { class: 'xp-scr-lbl', text: t('scramble') }),
      ui.scrambleBox,
      el('button', {
        class: 'ghost-btn sm', title: t('Copy the scramble'),
        onclick: () => copy(S.scramble).then(ok => toast(ok ? t('Scramble copied') : t('Clipboard blocked'), { kind: ok ? 'good' : 'bad' })),
        html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
      })),
    ui.pick = el('div', { class: 'xp-pick' },
      el('button', {
        class: 'ghost-btn sm', onclick: togglePicker, title: t('Drill the scramble of a solve you already did'),
        html: t('from a solve') + ' <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
      }),
      ui.pickList = el('div', { class: 'xp-picklist', hidden: true })),
    el('div', { class: 'xp-cross-pick' }, el('span', { text: 'cross' }), ui.swatches),
    ui.crossTag = el('span', { class: 'xp-cross-tag' }),
    ui.settingsWrap = el('div', { class: 'xp-setwrap' },
      el('button', {
        class: 'ghost-btn sm', title: t('Trainer settings'), onclick: toggleSettings,
        html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1"/><path d="M4.5 12h2M17.5 12h2M12 4.5v2M12 17.5v2"/></svg> ' + t('settings'),
      }),
      ui.settingsPop = el('div', { class: 'xp-settings', hidden: true })),
    el('div', { class: 'xp-title', text: t('Cross + 1') }),
  );

  /* ---- left: the clock, the scramble, the cube ---- */
  ui.clock = el('div', { class: 'xp-clock', text: t('0.00') });
  ui.hint = el('div', { class: 'xp-hint' });
  const net = buildNet();
  ui.cells = net.cells;
  ui.netCap = el('div', { class: 'xp-netcap' });
  ui.legend = el('div', { class: 'xp-legend' });

  ui.newBtn = el('button', { class: 'ghost-btn sm', text: t('new scramble  (N)'), onclick: () => nextScramble() });

  ui.cube3d = el('div', { class: 'xp-cube3d' });
  ui.faceTags = {};
  ui.faces = el('div', { class: 'xp-faces', hidden: true, 'aria-hidden': 'true' },
    ...['U', 'D', 'R', 'L', 'F', 'B'].map(f => (ui.faceTags[f] = el('span', { class: 'xp-face', text: f }))));
  ui.cube3d.append(ui.faces);

  /* Whole-cube rotations. These are the answer to "the moves are for one grip
     and I hold it another way": every line, every slot name and every ergonomic
     score is re-read from the new orientation the instant one of these is
     pressed. No search runs again — the answers did not change, only the way
     they are written down. */
  ui.rots = el('div', { class: 'xp-rots' },
    el('span', { class: 'xp-rots-lbl', text: t('turn') }),
    ...['x', "x'", 'y', "y'", 'z', "z'"].map(r => el('button', {
      class: 'xp-rot', text: r, title: t('Turn the whole cube: {r} — the moves rewrite themselves', { r }),
      onclick: () => turnCube(r),
    })),
    ui.rotReset = el('button', {
      class: 'xp-rot reset', text: 'reset', title: t('Back to the cross on the bottom'),
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
    ui.cubeHome = el('div', { class: 'xp-hideable' },
      ui.scrambleEcho,
      ui.cubewrap = el('div', { class: 'xp-cubewrap' },
        ui.cube3d,
        el('div', { class: 'xp-netwrap' }, net.grid)),
      ui.netCap,
      ui.rots,
    ),
    el('div', { class: 'xp-blindnote', text: t('blacked out — you planned it, now do it') }),
    ui.legend,
    el('div', { class: 'xp-actions' },
      ui.newBtn,
      el('button', { class: 'ghost-btn sm', text: t('show me  (Enter)'), onclick: showAnswer }),
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

  ui.tpsBtn = el('button', { class: 'xp-toggle', text: t('easy hands'),
    onclick: () => setSetting('rankTps', !S.settings.rankTps) });
  ui.presBtn = el('button', { class: 'xp-toggle', text: t('keep built pairs'),
    onclick: () => setSetting('rankPreserve', !S.settings.rankPreserve) });

  ui.planBox = el('input', {
    class: 'xp-inp mono', spellcheck: 'false', autocomplete: 'off',
    placeholder: t('the line you planned…'), 'aria-label': t('The cross + 1 you planned'),
  });
  ui.planBox.addEventListener('keydown', e => e.stopPropagation());
  ui.planBox.addEventListener('input', e => {
    capitaliseTypedMove(ui.planBox, e);
    S.plan = ui.planBox.value;
    renderPlan();
  });
  ui.planOut = el('div', { class: 'xp-plan-out' });

  const side = el('aside', { class: 'xp-side' },
    el('section', { class: 'panel xp-answers' },
      el('div', { class: 'panel-head' },
        el('span', { text: t('Cross + 1') }),
        el('span', { class: 'xp-toggles' }, el('span', { class: 'xp-toggles-lbl', text: 'prefer' }), ui.tpsBtn, ui.presBtn)),
      ui.headline, ui.list, ui.more),
    el('section', { class: 'panel xp-planner' },
      el('div', { class: 'panel-head' }, el('span', { text: t('What you planned') })),
      ui.planBox, ui.planOut),
  );

  host.append(top, el('div', { class: 'xp-body' }, stage, side));
  host.addEventListener('click', (e) => {
    if (!ui.settingsPop.hidden && !ui.settingsWrap.contains(e.target)) ui.settingsPop.hidden = true;
    if (!ui.pickList.hidden && !ui.pick.contains(e.target)) ui.pickList.hidden = true;
  });
  document.body.append(host);
}

/* ---------------- a scramble from one of your solves ----------------
   The same list the reconstruction workbench offers: the session's solves,
   newest first, each with its time. */
function togglePicker(e) {
  e?.stopPropagation();
  const open = ui.pickList.hidden;
  ui.pickList.hidden = !open;
  if (!open) return;
  ui.pickList.innerHTML = '';
  if (!library.length) {
    ui.pickList.append(el('div', { class: 'xp-empty', text: t('No solves in this session yet.') }));
    return;
  }
  for (const item of library) {
    ui.pickList.append(el('button', {
      class: 'xp-pickrow',
      onclick: () => { ui.pickList.hidden = true; setScramble(item.scramble); },
    },
      el('b', { text: item.label }),
      el('span', { text: item.scramble })));
  }
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
    setRow('Inspection', t('off by default — this is planning practice, not a comp run'),
      choice([
        { value: 'infinite', label: t('unlimited'), title: t('Plan for as long as you like') },
        { value: 'wca', label: t('15 seconds'), title: t('Real WCA inspection, with +2 and DNF') },
      ], s.inspection, v => setSetting('inspection', v))),

    setRow(t('Starting grip'), t('where each new scramble puts the cross — turn it any way you like from there'),
      choice([
        { value: 'bottom', label: t('cross down'), title: t('The way you actually solve') },
        { value: 'scramble', label: t('as scrambled'), title: t('White on top, the way the picture is drawn') },
      ], s.orient, v => setSetting('orient', v))),

    setRow(t('Cube view'), '',
      choice([
        { value: '3d', label: '3D', title: t('A cube you can turn, and watch the line play out on') },
        { value: 'net', label: t('flat net'), title: t('All six faces at once') },
      ], s.view, v => setView(v))),

    setRow(t('Black out when you start'), t('the scramble and the cube go dark so the execution is blind'),
      switchBtn(s.blackout, v => setSetting('blackout', v))),

    setRow(t('Hide the clock too'), t('only while blacked out'),
      switchBtn(s.hideTime, v => setSetting('hideTime', v))),

    setRow('Scrambles', t('where the next one comes from'),
      choice([
        { value: 'own', label: t('generate here') },
        { value: 'timer', label: t("the timer's"), title: t('Drill the scramble that is on the timer screen right now') },
      ], s.scrambleSource, v => setSetting('scrambleSource', v))),

    setRow(t('Lines to show'), '',
      choice([4, 8, 15].map(n => ({ value: n, label: String(n) })), s.showLines, v => setSetting('showLines', v))),

    setRow(t('Search depth'), t('deeper finds more and takes longer'),
      choice([10, 11, 12].map(n => ({ value: n, label: String(n) })), s.maxDepth, v => setSetting('maxDepth', v))),

    el('p', { class: 'xp-set-note', text:
      t('Every line the search returns is already rotation-free — it only ever turns the six faces, so there is no regrip to filter out.') }),
  );
}

/* =========================================================
   The phone layout

   Four screens in place of the desktop's two columns, one at a time:

     plan     the scramble, the cross colour, a big cube, and one large
              "Hold to start" button where the thumb already is
     run      a black screen while you solve; anywhere stops it
     results  the cube after the line you are looking at, the lines, the
              pair table, and "Check my line" / "Next scramble"
     check    the line you planned, typed on the move pad, and what it did

   Each has one scroll area and the cube is never under a panel: the cube is
   moved to wherever the current screen wants it (place()). The keyboard still
   works exactly as on the desktop. Nothing here is built until a phone opens
   the trainer, and the desktop layout is untouched.
   ========================================================= */

const XICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3.5 7h3.2c4.6 0 5.1 10 10 10h3.8M3.5 17h3.2c1.9 0 3.1-1.4 4-3.2M12.8 10.2c.9-1.8 2.1-3.2 4-3.2h3.7"/><path d="M18 4l3 3-3 3M18 14l3 3-3 3"/></svg>',
  fromSolve: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 12h7M4 18h11M17 9v9M13.5 12.5L17 9l3.5 3.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V10M9.5 3h5M18.2 6.8l1.3-1.3"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4.5L19 9.5 14.5 5 4 15.5z"/><path d="M13 6.5l4.5 4.5"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 7l5 5-5 5"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 102.4-5.7"/><path d="M3.5 4v4.5H8"/></svg>',
  paste: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6"/></svg>',
};

const XP = {
  built: false,
  pairAuto: true,      // the pair control follows the shortest pair until you pick one
  check: false,        // results -> "Check my line"
  checked: false,      // Check has been pressed at least once for this plan
  planStart: 0,        // when this scramble went up, for the inspection readout
  ticker: 0,
};
let xh = {};

const phoneOn = () => XP.built && !!host?.classList.contains('xp-phone');

/** Which phone screen is up. */
function phoneView() {
  if (S.phase === 'exec') return 'run';
  if (S.phase === 'reveal') return XP.check ? 'check' : 'results';
  return 'plan';
}

const xIcon = (cls, label, icon, onclick) =>
  el('button', { class: cls, type: 'button', 'aria-label': label, title: label, html: icon, onclick });

/** A button with an icon and a word, the word set as text so it is never parsed. */
function wordBtn(cls, icon, word, onclick) {
  const b = el('button', { class: cls, type: 'button', html: `${icon}<span></span>`, onclick });
  b.querySelector('span').textContent = word;
  return b;
}

function buildPhone() {
  if (XP.built) return;
  XP.built = true;

  /* ---- header, shared by every screen but the run ---- */
  xh.sub = el('div', { class: 'xp-ph-sub' });
  xh.head = el('header', { class: 'xp-ph-head' },
    xIcon('xp-ph-icon', t('Back'), XICON.back, phoneBack),
    el('div', { class: 'xp-ph-titles' }, el('h1', { text: t('Cross + 1') }), xh.sub),
    xIcon('xp-ph-icon', t('Cross + 1 options'), XICON.sliders, openOptionsSheet));

  /* ---- plan ---- */
  xh.scramble = el('p', { class: 'xp-ph-scramble' });
  xh.newBtn = wordBtn('xp-ph-chipbtn', XICON.shuffle, t('New'), () => nextScramble());
  const scrCard = el('section', { class: 'xp-ph-scr', 'aria-label': t('Scramble') },
    xh.scramble,
    el('div', { class: 'xp-ph-scrbtns' },
      xh.newBtn,
      wordBtn('xp-ph-chipbtn', XICON.fromSolve, t('From a solve'), openSolvesSheet),
      wordBtn('xp-ph-chipbtn', XICON.copy, t('Copy'),
        () => copy(S.scramble).then(ok => toast(ok ? t('Scramble copied') : t('Clipboard blocked'), { kind: ok ? 'good' : 'bad' })))));

  xh.swatches = el('div', { class: 'xp-ph-swatches', role: 'group', 'aria-label': t('Cross colour') },
    ...CROSS_COLOURS.map(c => el('button', {
      class: 'xp-ph-sw', type: 'button', dataset: { face: c.face }, 'aria-label': t(`${c.name} cross`),
      onclick: () => setSetting('crossFace', c.face),
    }, el('span', { style: { background: c.hex } }))),
    el('button', { class: 'xp-ph-auto', type: 'button', dataset: { face: 'auto' }, text: t('Auto'),
      'aria-label': t('Weigh up all six colours — slower, but a real answer'), onclick: () => setSetting('crossFace', 'auto') }));
  const crossRow = el('div', { class: 'xp-ph-crossrow' }, el('span', { class: 'xp-ph-lbl', text: t('Cross') }), xh.swatches);

  xh.holding = el('button', { class: 'xp-ph-holding', type: 'button', onclick: () => { if (S.rot !== defaultRot()) resetRot(); } });
  xh.planCube = el('div', { class: 'xp-ph-cubebox' });
  xh.viewBtn = el('button', { class: 'xp-ph-rot txt', type: 'button', text: '2D', 'aria-label': t('Flat net'),
    onclick: () => setView(S.settings.view === 'net' ? '3d' : 'net') });
  xh.rots = el('div', { class: 'xp-ph-rots', role: 'group', 'aria-label': t('Turn the cube') },
    ...['x', "x'", 'y', "y'", 'z', "z'"].map(r => el('button', {
      class: 'xp-ph-rot', type: 'button', text: r, 'aria-label': t('Turn the whole cube: {r} — the moves rewrite themselves', { r }),
      onclick: () => turnCube(r),
    })),
    el('span', { class: 'xp-ph-rotsep', 'aria-hidden': 'true' }),
    xh.viewBtn);
  xh.insp = el('div', { class: 'xp-ph-insp', 'aria-live': 'off' });
  xh.plan = el('div', { class: 'xp-ph-plan xp-ph-scroll' },
    scrCard, crossRow,
    el('div', { class: 'xp-ph-stagebox' }, xh.holding, xh.planCube, xh.rots),
    xh.insp);

  xh.holdSub = el('span', { class: 'xp-ph-holdsub' });
  xh.holdMain = el('span', { class: 'xp-ph-holdmain' });
  xh.hold = el('button', { class: 'xp-ph-hold', type: 'button' }, xh.holdMain, xh.holdSub);
  wireHold(xh.hold);
  xh.planBar = el('div', { class: 'xp-ph-planbar' },
    xh.hold,
    el('button', { class: 'xp-ph-skip', type: 'button', text: t('Skip it — show me the lines'), onclick: showAnswer }));

  /* ---- run ---- */
  xh.runTime = el('span', { class: 'xp-ph-runtime' });
  xh.runNote = el('span', { class: 'xp-ph-runnote', text: t('Scramble hidden · solve on your cube') });
  xh.run = el('div', { class: 'xp-ph-run', role: 'button', 'aria-label': t('Stop the timer') },
    xh.runNote,
    el('div', { class: 'xp-ph-runbox' },
      el('span', { class: 'xp-ph-runlbl', text: t('Cross + 1') }),
      xh.runTime,
      el('span', { class: 'xp-ph-runhint', text: t('Tap anywhere to stop') })));
  xh.run.addEventListener('pointerdown', (e) => { e.preventDefault(); press(e); });

  /* ---- results ---- */
  xh.heroCube = el('div', { class: 'xp-ph-herocube' });
  xh.heroN = el('span', { class: 'xp-ph-heron' });
  xh.heroLbl = el('span', { class: 'xp-ph-herolbl' });
  xh.heroNote = el('p', { class: 'xp-ph-heronote' });
  xh.hero = el('div', { class: 'xp-ph-hero' }, xh.heroCube,
    el('div', { class: 'xp-ph-herotxt' }, el('div', { class: 'xp-ph-herorow' }, xh.heroN, xh.heroLbl), xh.heroNote));
  xh.results = el('div', { class: 'xp-ph-results xp-ph-scroll' });
  xh.resBar = el('div', { class: 'xp-ph-bar two' },
    wordBtn('xp-ph-barbtn', XICON.pencil, t('Check my line'), () => setCheck(true)),
    wordBtn('xp-ph-barbtn primary', XICON.next, t('Next scramble'), () => nextScramble()));

  /* ---- check ---- */
  xh.field = el('input', {
    id: 'xp-ph-planned', class: 'xp-ph-field', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: t('Type it on the pad below'),
  });
  xh.fieldBox = el('div', { class: 'xp-ph-fieldbox' }, xh.field,
    xIcon('xp-ph-icon small', t('Clear the line'), XICON.cross, () => { setPlan(''); }));
  xh.verdict = el('div', { class: 'xp-ph-verdict', role: 'status' });
  xh.shortest = el('div', { class: 'xp-ph-shortest' });
  xh.checkCube = el('div', { class: 'xp-ph-checkcube' });
  xh.checkCap = el('div', { class: 'xp-ph-cap', text: t('after your line') });
  xh.checkView = el('div', { class: 'xp-ph-check xp-ph-scroll' },
    el('label', { class: 'xp-ph-lbl', for: 'xp-ph-planned', text: t('The line you planned') }),
    xh.fieldBox, xh.verdict, xh.shortest,
    el('div', { class: 'xp-ph-checkstage' }, xh.checkCube, xh.checkCap));
  xh.pad = createMovePad({
    notation: 'full',
    action: t('Check'),
    onAction: () => { XP.checked = true; renderPhone(); showCube(); },
    last: () => S.plan.trim().split(/\s+/).filter(Boolean).at(-1) || '',
    push: (tok) => setPlan(`${S.plan.trim()} ${tok}`.trim()),
    replaceLast: (tok) => setPlan([...S.plan.trim().split(/\s+/).filter(Boolean).slice(0, -1), tok].join(' ')),
    pop: () => setPlan(S.plan.trim().split(/\s+/).filter(Boolean).slice(0, -1).join(' ')),
  });
  xh.pad.attachField(xh.field);

  xh.root = el('div', { class: 'xp-ph' },
    xh.head, xh.plan, xh.planBar, xh.hero, xh.results, xh.resBar, xh.checkView, xh.pad.el, xh.run);
  host.append(xh.root);
}

/** The plan as typed on the pad; the desktop box mirrors it. */
function setPlan(text) {
  S.plan = text;
  if (ui.planBox) ui.planBox.value = text;
  renderPhone();
  if (XP.checked) showCube();
}

/** Results <-> check. */
function setCheck(on) {
  XP.check = on;
  XP.checked = on && !!S.plan.trim();
  closeAllSheets();
  if (on) xh.pad.show(); else xh.pad.hide();
  place();
  render();
  showCube();
  xh.checkView.scrollTop = 0;
}

/**
 * A press on the clock, and its release wherever the finger lifts. The release
 * is listened for on the window, not the element pressed: the run screen goes
 * away under the finger the moment the press stops the clock, and a release
 * that never arrives leaves the clock in its cool-down, deaf to the next press.
 * A press the browser takes back (pointercancel) is undone, never acted on.
 */
function press(e) {
  const stopping = tmr.state === 'running';
  tmr.down(e.timeStamp);
  /* The tap that stops the clock brings the results up under the finger, and
     the click that tap ends in would land on whatever line is there. */
  if (stopping) {
    const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 700);
  }
  const off = () => {
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', cancel, true);
  };
  const up = (ev) => { if (ev.pointerId !== e.pointerId) return; off(); tmr.up(ev.timeStamp); };
  const cancel = (ev) => { if (ev.pointerId !== e.pointerId) return; off(); tmr.abortPress(); };
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', cancel, true);
}

/** Hold to start: press, and the clock arms; let go, and it starts (or the 15 s countdown does). */
function wireHold(btn) {
  btn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    press(e);
  });
  // From a keyboard it is pressed like any button (space is the clock's own key already).
  btn.addEventListener('click', (e) => { if (e.detail === 0) { tmr.down(); tmr.up(); } });
}

/**
 * Put the cube where this screen wants it. Moved only when it is somewhere
 * else, because moving it restarts its renderer.
 */
function place() {
  if (!host) return;
  const phone = isPhone();
  if (phone) buildPhone();
  host.classList.toggle('xp-phone', phone);
  const wrap = ui.cubewrap;
  if (!phone) {
    if (wrap.parentNode !== ui.cubeHome) ui.cubeHome.insertBefore(wrap, ui.netCap);
    return;
  }
  const view = phoneView();
  const target = view === 'results' ? xh.heroCube : view === 'check' ? xh.checkCube : xh.planCube;
  if (wrap.parentNode !== target) target.append(wrap);
  xh.root.dataset.view = view;
}

onPhoneChange(() => {
  if (!host) return;
  closeAllSheets();
  XP.check = false;
  xh.pad?.hide();
  place();
  if (xp1Open()) { render(); showCube(); }
});

/** Back: from checking a line to the lines, else out of the trainer. */
function phoneBack() {
  if (XP.check) return setCheck(false);
  close();
}

/* ---------------- painting ---------------- */

const fmtGo = () => {
  if (S.lastTime === null) return '';
  const time = fmtLive(S.lastTime, 2);
  return S.lastPenalty === 'DNF' ? `DNF (${time})` : time + (S.lastPenalty === '+2' ? '+' : '');
};

function renderPhone() {
  if (!phoneOn()) return;
  place();
  const view = phoneView();
  xh.root.dataset.view = view;
  xh.root.classList.toggle('see-through', view === 'run' && !S.settings.blackout);
  xh.root.classList.toggle('no-clock', view === 'run' && S.settings.blackout && S.settings.hideTime);

  xh.sub.textContent = view === 'check' ? t('Check your line')
    : view === 'results' ? (S.lastTime !== null ? t('Your go · {time}', { time: fmtGo() }) : t('Just looking — no time'))
    : '';
  xh.sub.hidden = !xh.sub.textContent;

  if (view === 'plan' || view === 'run') renderPhonePlan();
  if (view === 'results') renderPhoneResults();
  if (view === 'check') renderPhoneCheck();
  phoneClock();
}

/** How the cube is being held, as a sentence: "White cross on the bottom · z2". */
function phoneHolding() {
  const f = faceNow();
  if (!f) return S.rot ? t('turned {r}', { r: S.rot }) : t('held as the scramble is drawn');
  const where = FACE_WORD[toUserFace(frameNow(), f)] || '';
  return `${crossName(f)} ${where}${S.rot ? ` · ${S.rot}` : ''}`;
}

function renderPhonePlan() {
  xh.scramble.textContent = S.scramble || t('no scramble yet');
  xh.scramble.classList.toggle('empty', !S.scramble);
  for (const b of xh.swatches.children) {
    const on = b.dataset.face === S.settings.crossFace;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const turned = S.rot !== defaultRot();
  xh.holding.replaceChildren(el('span', { text: phoneHolding() }));
  if (turned) xh.holding.append(el('span', { class: 'xp-ph-reset', html: XICON.reset, 'aria-hidden': 'true' }));
  xh.holding.disabled = !turned;
  xh.holding.setAttribute('aria-label', turned ? `${phoneHolding()}. ${t('Back to the cross on the bottom')}` : phoneHolding());
  const flat = S.settings.view === 'net';
  xh.viewBtn.classList.toggle('on', flat);
  xh.viewBtn.setAttribute('aria-pressed', String(flat));
}

function renderPhoneResults() {
  const res = S.result;
  /* The pair control starts on the pair with the shortest line, and the list
     (and so the line on the cube) follows it — settled before anything below
     reads which line is selected. */
  const pairs = (res?.pairs || []).filter(p => p.face === res.face);
  if (XP.pairAuto && S.pairFilter === null) {
    const best = pairs.filter(p => p.best >= 0).sort((a, b) => a.best - b.best)[0];
    if (best) S.pairFilter = best.rawSlot;
  }
  const sel = selected();
  xh.results.replaceChildren();

  if (S.searching || !res || res.best < 0) {
    xh.heroN.textContent = S.searching ? '…' : '?';
    xh.heroLbl.textContent = '';
    xh.heroNote.textContent = S.searching ? t('still searching')
      : res?.failed ? t('the search could not run here')
      : t('nothing found inside the depth limit — try raising it in settings');
    return;
  }

  /* The headline: the shortest cross + 1, and what the pair cost on top of the
     cross alone (which is exact — a lookup, not a search). */
  const shownLine = sel || null;
  const n = shownLine ? shownLine.moves : res.best;
  xh.heroN.textContent = String(n);
  xh.heroN.classList.toggle('best', n === res.best);
  xh.heroLbl.textContent = n === 1 ? t('move') : t('moves');
  const extra = n - res.crossBest;
  xh.heroNote.textContent = `${t('for cross + 1. The cross alone is {n}', { n: res.crossBest })}${
    extra <= 0 ? t(', so the pair is free.') : t(', so the pair costs {n}.', { n: extra })}`;

  if (res.built?.length) {
    xh.results.append(el('div', { class: 'xp-ph-built' },
      t(res.built.length > 1 ? 'the scramble already built your {slots} pairs' : 'the scramble already built your {slots} pair',
        { slots: res.built.join(t(' and ')) })
      + t(' — the lines below say which ones survive')));
  }

  // What the line on the cube leaves behind: the pairs still to come, and how near.
  if (sel) {
    const intro = el('div', { class: 'xp-ph-after-txt' });
    intro.append(t('After') + ' ', el('b', { class: 'mono', text: sel.alg }), ' ',
      t('the {slot} pair is in. Left standing:', { slot: sel.slot }));
    xh.results.append(el('section', { class: 'xp-ph-after' }, intro,
      el('div', { class: 'xp-ph-mini' }, ...sel.after.map((p) => {
        const tier = tierOf(p.dist);
        return el('span', { class: 'xp-ph-minicard' },
          el('b', { text: p.slot }),
          el('span', {},
            p.dist === 0 ? el('span', { class: `tier ${tier}`, text: t('already in') })
              : [`${t('{n} away', { n: p.dist })} · `, el('span', { class: `tier ${tier}`, text: TIER_WORD[tier] })]));
      }))));
  }

  /* The shortest line per pair, as a segmented control. Pressing the pair that
     is on lets go of it, and the list shows every pair's lines. */
  if (pairs.length) {
    xh.results.append(el('div', { class: 'xp-ph-pairs', role: 'group', 'aria-label': t('Shortest line per pair') },
      ...pairs.map((p) => {
        const on = S.pairFilter === p.rawSlot;
        const dead = p.best < 0;
        return el('button', {
          class: 'xp-ph-pair' + (on ? ' on' : '') + (p.best === res.best ? ' best' : ''), type: 'button',
          'aria-pressed': String(on), disabled: dead || null,
          'aria-label': dead ? t('No line for the {slot} pair inside the depth limit', { slot: p.slot })
            : on ? t('Showing only this pair — click to show them all again')
            : t('Show only the lines that build the {slot} pair', { slot: p.slot }),
          onclick: () => { XP.pairAuto = false; S.pairFilter = on ? null : p.rawSlot; S.selKey = null; render(); showCube(); },
        }, p.slot, el('span', { class: 'mono', text: dead ? '—' : String(p.best) }));
      })));
  }

  // Colour neutral: the best line for each colour, and a tap to switch to it.
  if (S.settings.crossFace === 'auto' && res.faces?.length > 1) {
    xh.results.append(el('div', { class: 'xp-ph-colours' },
      el('span', { class: 'xp-ph-lbl', text: t('By colour') }),
      el('div', { class: 'xp-ph-colourrow' }, ...res.faces.map(f => el('button', {
        class: 'xp-ph-colour' + (f.face === res.face ? ' on' : ''), type: 'button',
        'aria-label': t('Solve the {cross} instead', { cross: crossName(f.face) }),
        onclick: () => setSetting('crossFace', f.face),
      }, el('span', { class: 'dot', style: { background: colourOf(f.face)?.hex || '' } }),
      el('span', { class: 'mono', text: f.best < 0 ? '—' : String(f.best) }))))));
  }

  // How many, and in which order.
  const list = shown();
  const total = (res.list || []).length;
  const sortBy = (tps) => el('button', {
    class: 'xp-ph-sortbtn' + (!!S.settings.rankTps === tps ? ' on' : ''), type: 'button',
    'aria-pressed': String(!!S.settings.rankTps === tps), text: tps ? t('Easy hands') : t('Shortest'),
    onclick: () => { if (!!S.settings.rankTps !== tps) setSetting('rankTps', tps); },
  });
  xh.results.append(el('div', { class: 'xp-ph-listhead' },
    el('span', { class: 'xp-ph-lbl', text: res.partial
      ? t('{n} of {total} lines · the search stopped early', { n: list.length, total })
      : t('{n} of {total} lines', { n: list.length, total }) }),
    el('div', { class: 'xp-ph-sort', role: 'group', 'aria-label': t('Order lines by') }, sortBy(false), sortBy(true))));

  const selI = selectedIndex();
  xh.results.append(el('div', { class: 'xp-ph-lines' }, ...list.map((s, i) => {
    const on = i === selI;
    const meta = el('span', { class: 'xp-ph-linemeta' },
      el('b', { text: t('{slot} pair', { slot: s.slot }) }),
      s.highTps ? el('span', { class: 'good', text: t('R U L D only') }) : null,
      s.bMoves ? el('span', { class: 'warn', text: s.bMoves === 1 ? t('1 B move') : t('{n} B moves', { n: s.bMoves }) }) : null,
      s.preserves === false ? el('span', { class: 'warn', text: t('breaks {slots}', { slots: s.broke.join(', ') }) }) : null,
      s.after[0] ? el('span', { text: t('next: {slot} {n} away', { slot: s.after[0].slot, n: s.after[0].dist }) }) : null);
    return el('button', {
      class: 'xp-ph-line' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on),
      'aria-label': `${s.alg}, ${t('{n} moves', { n: s.moves })}. ${t('Watch this one on the cube')}`,
      onclick: () => { S.selKey = s.path.join(); render(); showCube(); },
    },
    el('span', { class: 'xp-ph-linetxt' }, el('span', { class: 'mono alg', text: s.alg }), meta),
    on ? el('span', { class: 'xp-ph-playing', html: XICON.play, 'aria-hidden': 'true' }) : null,
    el('span', { class: 'mono len' + (s.moves === res.best ? ' best' : ''), text: String(s.moves) }));
  })));
}

/** The verdict on the planned line, split into its sentence and the rest. */
function renderPhoneCheck() {
  xh.field.value = S.plan;
  const v = XP.checked ? checkPlan() : null;
  xh.verdict.className = 'xp-ph-verdict' + (v ? ` ${v.kind}` : ' idle');
  if (!v) {
    xh.verdict.replaceChildren(el('div', { class: 'xp-ph-vtxt' },
      el('div', { class: 'xp-ph-vhead', text: S.plan.trim() ? t('Press Check to see what that line does.') : t('Type the line you planned on the pad.') }),
      el('div', { class: 'xp-ph-vsub', text: t('It will say whether it works, and what it cost.') })));
  } else {
    const cut = v.msg.indexOf('. ');
    const head = cut >= 0 ? v.msg.slice(0, cut + 1) : v.msg;
    const rest = cut >= 0 ? v.msg.slice(cut + 2) : '';
    xh.verdict.replaceChildren(
      el('span', { class: 'xp-ph-vico', html: v.kind === 'good' ? XICON.check : v.kind === 'warn' ? XICON.warn : XICON.cross, 'aria-hidden': 'true' }),
      el('div', { class: 'xp-ph-vtxt' }, el('div', { class: 'xp-ph-vhead', text: head }), rest ? el('div', { class: 'xp-ph-vsub', text: rest }) : null));
  }
  const best = shown()[0] || null;
  xh.shortest.hidden = !best;
  if (best) {
    xh.shortest.replaceChildren(
      el('div', {}, el('div', { class: 'xp-ph-lbl small', text: t('Shortest') }), el('div', { class: 'mono alg', text: best.alg })),
      el('span', { class: 'mono len', text: String(best.moves) }));
  }
  xh.checkCap.hidden = !(XP.checked && S.plan.trim());
}

/** The clock's side of the phone: the run screen, the inspection readout, the hold button. */
function phoneClock() {
  if (!phoneOn() || !tmr) return;
  const st = tmr.state;
  xh.root.dataset.state = st;
  const inspecting = st === 'inspecting' || ((st === 'holding' || st === 'ready') && tmr.inspectStart);
  if (st === 'running') xh.runTime.textContent = fmtLive(tmr.elapsed, 2);
  else if (S.lastTime !== null) xh.runTime.textContent = fmtGo();
  if (S.settings.blackout && S.settings.hideTime) xh.runTime.textContent = t('eyes shut — execute');

  if (inspecting) {
    const left = Math.max(0, 15 - tmr.inspectElapsed / 1000);
    xh.insp.replaceChildren(el('span', { class: 'ico', html: XICON.clock, 'aria-hidden': 'true' }),
      el('span', { text: t('Inspection') }), el('span', { class: 'mono big', text: left <= 0 ? '+2' : String(Math.ceil(left)) }),
      el('span', { class: 'dim', text: t('· +2 after 15, DNF after 17') }));
    xh.holdMain.textContent = t('Hold to start the solve');
    xh.holdSub.textContent = t('The scramble and the cube black out while you solve');
  } else {
    const s = Math.floor((performance.now() - XP.planStart) / 1000);
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    xh.insp.replaceChildren(el('span', { class: 'ico', html: XICON.clock, 'aria-hidden': 'true' }),
      el('span', { text: t('Inspection') }),
      S.settings.inspection === 'wca'
        ? el('span', { class: 'dim', text: t('· a 15 s countdown when you press') })
        : el('span', { class: 'mono', text: clock }),
      S.settings.inspection === 'wca' ? null : el('span', { class: 'dim', text: t('· no limit') }));
    xh.holdMain.textContent = t('Hold to start');
    xh.holdSub.textContent = S.settings.blackout
      ? t('The scramble and the cube black out while you solve')
      : t('Release to start, tap anywhere to stop');
  }
}

/* Once a second, while a phone is planning, so the inspection readout counts. */
function startTicker() {
  stopTicker();
  XP.ticker = setInterval(() => { if (phoneOn() && phoneView() === 'plan') phoneClock(); }, 1000);
}
function stopTicker() { clearInterval(XP.ticker); XP.ticker = 0; }

/* ---------------- sheets ---------------- */

function openSolvesSheet() {
  let sheet = null;
  const content = library.length
    ? sheetRows(library.map(item => ({ label: item.label, sub: item.scramble, onSelect: () => setScramble(item.scramble) })), () => sheet)
    : el('p', { class: 'xp-ph-note', text: t('No solves in this session yet.') });
  sheet = openSheet({ title: t('Drill a solve’s scramble'), done: true, content });
  for (const sub of sheet.el.querySelectorAll('.sheet-row-sub')) sub.classList.add('mono');
}

function openScrambleSheet() {
  let sheet = null;
  const box = el('textarea', {
    class: 'sheet-field', rows: '3', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters',
    'aria-label': t('Scramble to drill'), placeholder: t('paste or type your own scramble…'),
  });
  box.value = S.scramble;
  box.addEventListener('keydown', e => e.stopPropagation());
  sheet = openSheet({
    title: t('Your own scramble'), done: false,
    content: [box, el('button', {
      class: 'sheet-btn primary', type: 'button', text: t('Use this scramble'),
      onclick: () => { if (setScramble(box.value)) sheet.close(); },
    })],
  });
}

/** Everything the desktop's settings popover holds, as a sheet. */
function openOptionsSheet() {
  let sheet = null;
  const s = () => S.settings;
  const toggle = (label, sub, key) => el('div', { class: 'xp-ph-optrow' },
    el('div', { class: 'xp-ph-opttxt' }, el('b', { text: label }), sub ? el('span', { text: sub }) : null),
    el('button', {
      class: 'xp-switch' + (s()[key] ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': String(!!s()[key]), 'aria-label': label,
      onclick: () => { setSetting(key, !s()[key]); refresh(); },
    }, el('span')));
  const pick = (label, sub, key, options, apply = (v) => setSetting(key, v)) => el('div', { class: 'xp-ph-optrow col' },
    el('div', { class: 'xp-ph-opttxt' }, el('b', { text: label }), sub ? el('span', { text: sub }) : null),
    el('div', { class: 'xp-ph-seg', role: 'group', 'aria-label': label }, ...options.map(o => el('button', {
      class: 'xp-ph-segbtn' + (s()[key] === o.value ? ' on' : ''), type: 'button', 'aria-pressed': String(s()[key] === o.value),
      text: o.label, onclick: () => { apply(o.value); refresh(); },
    }))));
  const content = () => [
    el('div', { class: 'xp-ph-optgroup' },
      toggle(t('Prefer easy hands'), t('Put the lines that stay off B and F first'), 'rankTps'),
      toggle(t('Keep built pairs'), t('Put the lines that leave an already-built pair standing first'), 'rankPreserve')),
    el('div', { class: 'xp-ph-optgroup' },
      pick(t('Inspection'), t('off by default — this is planning practice, not a comp run'), 'inspection',
        [{ value: 'infinite', label: t('No limit') }, { value: 'wca', label: t('15 s countdown') }]),
      toggle(t('Black out when you start'), t('the scramble and the cube go dark so the execution is blind'), 'blackout'),
      toggle(t('Hide the clock too'), t('only while blacked out'), 'hideTime')),
    el('div', { class: 'xp-ph-optgroup' },
      pick(t('Starting grip'), t('where each new scramble puts the cross — turn it any way you like from there'), 'orient',
        [{ value: 'bottom', label: t('cross down') }, { value: 'scramble', label: t('as scrambled') }]),
      pick(t('Cube view'), '', 'view', [{ value: '3d', label: '3D' }, { value: 'net', label: t('flat net') }], (v) => setView(v)),
      pick(t('Scrambles'), t('where the next one comes from'), 'scrambleSource',
        [{ value: 'own', label: t('generate here') }, { value: 'timer', label: t("the timer's") }])),
    el('div', { class: 'xp-ph-optgroup' },
      pick(t('Lines to show'), '', 'showLines', [4, 8, 15].map(n => ({ value: n, label: String(n) }))),
      pick(t('Search depth'), t('deeper finds more and takes longer'), 'maxDepth', [10, 11, 12].map(n => ({ value: n, label: String(n) })))),
    sheetRows([{ label: t('Type or paste a scramble'), icon: XICON.paste, onSelect: openScrambleSheet }], () => sheet),
    el('p', { class: 'xp-ph-note', text: t('Every line the search returns is already rotation-free — it only ever turns the six faces, so there is no regrip to filter out.') }),
  ];
  const refresh = () => sheet?.setContent(content());
  sheet = openSheet({ title: t('Cross + 1 options'), done: true, content: content(), className: 'xp-ph-options' });
}

/* =========================================================
   Open / close
   ========================================================= */

/**
 * Open the trainer.
 *   scramble    a scramble to start on, if you have one to hand
 *   timerScramble  () => the scramble on the timer screen right now
 */
let initTask = null;

export async function openXp1({ scramble = '', timerScramble = null, onExit = null, library: lib = [] } = {}) {
  library = lib;
  if (!host) {
    await (initTask ??= (async () => {
      loadCss();
      await loadSettings();
      build();
      wireTimer();
    })().catch(err => { initTask = null; throw err; }));
  }
  onClose = onExit;
  getTimerScramble = timerScramble;

  XP.check = false;
  xh.pad?.hide();
  place();
  startTicker();
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
  closeAllSheets();
  stopTicker();
  XP.check = false;
  xh.pad?.hide();
  host.hidden = true;
  document.body.classList.remove('xp1-open');
  onClose?.();
  return true;
}
const close = closeXp1;
