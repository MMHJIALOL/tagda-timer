import { t, lang } from './i18n.js';
/* ===========================================================
   Tagda Timer — the reconstruction workbench

   Opened on demand and never before: from a solve's menu, or from
   the topbar button with a scramble you type in yourself. The timer
   screen is untouched until you ask for this.

   The loop it exists for: look at the cube, pick one of the moves it
   suggests (or type your own), watch it happen, and get a fresh set
   of suggestions from wherever you landed. Nothing is ever refused —
   an off-list move is just a new position, and the counter tells you
   what it cost.
   =========================================================== */

import { el, copy } from './util.js';
import { SOLVED, applyAlg, analyse, analyseRoux, parse, canonical, IDENTITY_FRAME } from './cube3.js';
import { suggest, slotLabel, lastLayerCase } from './solver.js';
import { toast } from './toast.js';
import { isPhone, onPhoneChange } from './phone.js';
import { openSheet, sheetRows, closeAllSheets, sheetOpen } from './sheet.js';
import { createMovePad } from './movepad.js';

/* twisty-player, loaded the same way the scramble preview loads it. */
const SOURCES = [
  new URL('../vendor/cubing/cubing/twisty.js', import.meta.url).href,
  'https://cdn.cubing.net/v0/js/cubing/twisty',
];

/* The panel's own stylesheet, fetched on the first open for the same reason
   the module is: most sessions never come in here. */
function loadCss() {
  if (document.querySelector('link[data-recon]')) return;
  /* The version query is not decoration. vercel.json serves /css/* as immutable
     for a year, so a sheet whose contents change without its URL changing is a
     sheet nobody who has already visited will ever see again. Reading the
     version off a stylesheet index.html already asked for means this one cannot
     drift out of step with the others — bumping them bumps this too. */
  const v = document.querySelector('link[rel="stylesheet"][href*="?v="]')
    ?.getAttribute('href')?.match(/\?v=([^&"]+)/)?.[1];
  const url = new URL('../css/recon.css', import.meta.url).href;
  const href = v ? `${url}?v=${v}` : url;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = href; link.dataset.recon = '1';
  document.head.append(link);
}

let twistyLoaded = null;
async function loadTwisty() {
  if (twistyLoaded !== null) return twistyLoaded;
  for (const src of SOURCES) {
    try { await import(/* @vite-ignore */ src); twistyLoaded = true; return true; }
    catch (err) { console.warn('[recon] could not load', src, err.message); }
  }
  twistyLoaded = false;
  return false;
}

/* ---------------- module state ---------------- */

let host = null;            // #recon
let player = null;
let onClose = null;
let saveHook = null;        // (movesString) => void, when opened from a solve

const S = {
  scramble: '',
  steps: [],                // [{ alg, phase }]
  positions: [],            // state after each step, [0] is after the scramble
  frames: [],
  method: loadMethod(),     // 'cfop' or 'roux'
  /* The colour picker means the cross colour in CFOP and the first block's
     bottom colour in Roux, so each method remembers its own. Roux starts on
     auto: Roux solvers are far more often colour neutral about the block. */
  prefs: { cfop: 'U', roux: 'auto', rouxFront: 'auto' },
  library: [],              // recorded solves you can jump straight into
  replay: false,
  thinking: false,
  hint: null,               // suggestion currently being previewed
  slot: null,               // F2L slot picked by hand, as the solver names it
};

const PHASE_LABEL = {
  cross: t('Cross'), f2l: 'F2L', oll: 'OLL', pll: 'PLL', done: t('Solved'),
  fb: 'FB', sb: 'SB', cmll: 'CMLL', eo: 'EO', ulur: 'UL/UR', lse: 'LSE',
};

/* The progress strip, one bar per rank a solve can reach. */
const STRIP = {
  cfop: ['cross', 'f2l 1', 'f2l 2', 'f2l 3', 'f2l 4', 'oll', 'pll'],
  roux: ['fb', 'sb sq', 'sb', 'cmll', 'eo', 'ul/ur', 'lse'],
};

/* Which method you reconstruct with is a fact about you, not about one solve,
   so it is remembered across visits. Storage can be missing (private windows),
   and then it is simply CFOP every time. */
const METHOD_KEY = 'tagda.recon.method';
function loadMethod() {
  try { return localStorage.getItem(METHOD_KEY) === 'roux' ? 'roux' : 'cfop'; } catch { return 'cfop'; }
}

/* A step that took an oriented-edge OLL straight to a solved cube did both
   jobs at once, and calling that "OLL" undersells it — everywhere the step is
   named, it is named ZBLL instead. */
const stepLabel = (step) => (step.zb ? 'ZBLL' : PHASE_LABEL[step.phase] || '');

/* Cubers pick a cross by colour, not by face letter, so that is what the picker
   offers. These are the standard scheme cubing.js scrambles assume and the
   preview paints — white on top, yellow underneath. */
const CROSS_COLOURS = [
  { face: 'U', name: 'white',  hex: '#ffffff' },
  { face: 'D', name: 'yellow', hex: '#ffe100' },
  { face: 'F', name: 'green',  hex: '#00b04a' },
  { face: 'B', name: 'blue',   hex: '#0051ba' },
  { face: 'R', name: 'red',    hex: '#ec0000' },
  { face: 'L', name: 'orange', hex: '#ff8b00' },
];
const colourOf = (face) => CROSS_COLOURS.find(c => c.face === face);

export const reconOpen = () => !!host && !host.hidden;

/* =========================================================
   Position bookkeeping
   ========================================================= */

const pref = () => (S.prefs[S.method] === 'auto' ? null : S.prefs[S.method]);

/* Roux is held first block on the left, so a bottom colour and a front colour
   together name the face the block is built on: left = bottom x front. */
const AXIS = { U: [0, 1, 0], D: [0, -1, 0], R: [1, 0, 0], L: [-1, 0, 0], F: [0, 0, 1], B: [0, 0, -1] };
const OPP = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'B', B: 'F' };
export function leftOf(bottom, front) {
  const [a, b] = [AXIS[bottom], AXIS[front]];
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Object.keys(AXIS).find(k => AXIS[k].every((x, i) => x === c[i])) || null;
}
const rouxSide = () => {
  const { roux: bottom, rouxFront: front } = S.prefs;
  return bottom !== 'auto' && front !== 'auto' ? leftOf(bottom, front) : null;
};

/** Where a position is in the solve, for whichever method is picked. */
const analyseAt = (state, frame) =>
  (S.method === 'roux' ? analyseRoux(state, pref(), frame, rouxSide()) : analyse(state, pref()));

/** Rebuild every intermediate position from the scramble forwards. */
function recompute() {
  const start = applyAlg(SOLVED, S.scramble, IDENTITY_FRAME);
  if (!start) { S.positions = []; S.frames = []; return false; }
  S.positions = [start.state];
  S.frames = [start.frame];
  for (const step of S.steps) {
    const prev = S.positions.at(-1), pf = S.frames.at(-1);
    // A step is named for the phase it was working on, not the one it left you
    // in — the move that finishes the cross belongs under "Cross".
    const a = analyseAt(prev, pf);
    step.phase = a.phase;
    step.rank = rankOf(a);
    const next = applyAlg(prev, step.alg, pf);
    if (!next) break;
    // Recognised rather than remembered, so it survives closing the panel:
    // an OLL with its edges already up that comes out solved was a ZBLL.
    step.zb = a.phase === 'oll' && a.eo && analyseAt(next.state, next.frame).solved;
    S.positions.push(next.state);
    S.frames.push(next.frame);
  }
  return true;
}

/**
 * How far through a solve a position is, as one increasing number. Roux
 * works its own out (see rouxStatus); for CFOP it is
 * 0 before the cross, 1-4 as the pairs go in, 5 once F2L is whole, 6 once the
 * last layer is oriented, 7 when it is finished. Steps break where this goes
 * up, which is what stops a pair insertion that momentarily disturbs the cross
 * from being filed under "Cross".
 */
function rankOf(a) {
  if (a.method === 'roux') return a.rank;
  if (a.solved) return 7;
  if (a.oll) return 6;
  if (a.f2l) return 5;
  if (!a.cross) return 0;
  return 1 + a.slots.filter(s => s.done).length;
}

/**
 * Break a saved move string back into the steps it was built as.
 * Only the flat list is stored on a solve, so reopening one would otherwise
 * show the whole thing as a single line. Splitting wherever the phase changes
 * puts the cross, the four pairs and the last layer back on their own rows.
 */
function explode(scramble, moves) {
  const list = String(moves || '').trim().split(/\s+/).filter(Boolean);
  if (!list.length) return [];
  const start = applyAlg(SOLVED, scramble, IDENTITY_FRAME);
  if (!start) return [{ alg: list.join(' '), phase: 'cross', rank: 0 }];
  let state = start.state, frame = start.frame;
  const steps = [];
  for (const raw of list) {
    const tok = canonical(raw);
    if (!tok) break;
    const a = analyseAt(state, frame);
    const rank = rankOf(a);
    const last = steps.at(-1);
    if (joinsLast(last, rank)) last.alg += ` ${tok}`;
    else steps.push({ alg: tok, phase: a.phase, rank });
    const next = applyAlg(state, tok, frame);
    if (!next) break;
    state = next.state; frame = next.frame;
  }
  return steps;
}

const currentState = () => S.positions.at(-1);
const currentFrame = () => S.frames.at(-1);
const allMoves = () => S.steps.map(s => s.alg).join(' ').trim();

/** Analysis of where we are, honouring the method and a hand-picked colour. */
const look = () => analyseAt(currentState(), currentFrame());

/* =========================================================
   Rendering
   ========================================================= */

let ui = {};

/* ---------------- hovering the cube ----------------
   Two things made this feel broken. Passing the pointer down the list fired a
   preview per row, so the cube machine-gunned through five algs nobody asked
   to see; and clicking a suggestion re-drew the list under a pointer that had
   not moved, so whatever row landed under the cursor immediately started
   playing instead of the move just committed. A short delay fixes the first,
   and a lock held until the pointer genuinely moves again fixes the second. */
let hoverTimer = null;
let hoverRow = null;
let hoverArmed = true;
let clickedAt = null;

/**
 * Has the pointer moved enough to count as hovering on purpose?
 *
 * Rows are driven by mousemove rather than mouseenter, because a row that
 * appears underneath a stationary cursor fires mouseenter all by itself —
 * that is what made the cube run off and play something else the moment you
 * clicked. After a click the pointer has to travel a few pixels before the
 * panel will believe you meant to hover again.
 */
function armed(e) {
  if (hoverArmed) return true;
  if (!clickedAt) { hoverArmed = true; return true; }
  if (Math.hypot(e.clientX - clickedAt.x, e.clientY - clickedAt.y) < 12) return false;
  hoverArmed = true;
  clickedAt = null;
  return true;
}

/** Preview `alg` if the pointer has settled on a row it was not already on. */
function hoverPreview(e, row, run) {
  if (!armed(e) || hoverRow === row) return;
  hoverRow = row;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(run, 140);
}

function hoverEnd(row) {
  if (row && hoverRow !== row) return;
  hoverRow = null;
  clearTimeout(hoverTimer);
  if (hoverArmed) renderCube();
}

/** Freeze hovering where the click left it, until the pointer moves off. */
function holdHover(e) {
  clearTimeout(hoverTimer);
  hoverArmed = false;
  hoverRow = null;
  clickedAt = e ? { x: e.clientX, y: e.clientY } : null;
}

/** Pick the cross (or block bottom) colour by hand. Everything downstream is asked about it. */
function setCross(face) {
  S.prefs[S.method] = face;
  // A front on the bottom's own axis is not a way to hold the cube.
  if (S.method === 'roux' && (face === 'auto' || [face, OPP[face]].includes(S.prefs.rouxFront))) S.prefs.rouxFront = 'auto';
  S.slot = null;
  lastBest = null;
  commit();
}

/** Roux front colour: with the bottom it fixes which side the first block is on. */
function setFront(face) {
  S.prefs.rouxFront = face;
  S.slot = null;
  lastBest = null;
  commit();
}

/** Six colour swatches and an "auto", each calling `pick` with a face letter. */
const swatchRow = (pick, autoTip) => el('span', { class: 'rc-swatches' },
  ...CROSS_COLOURS.map(c => el('button', {
    class: 'rc-swatch', dataset: { face: c.face }, style: { background: c.hex },
    onclick: () => pick(c.face),
  })),
  el('button', {
    class: 'rc-swatch auto', title: autoTip, dataset: { face: 'auto' }, text: t('auto'),
    onclick: () => pick('auto'),
  }));

/** "white cross" — the one name that means the same whichever way up it is. */
const crossLabel = (a) => t(`${colourOf(a.face)?.name || a.face} cross`);

function paintCrossPicker() {
  const roux = S.method === 'roux';
  ui.crossLbl.textContent = t(roux ? 'bottom' : 'cross');
  for (const b of ui.crossSwatches.children) {
    b.classList.toggle('on', b.dataset.face === S.prefs[S.method]);
    const name = colourOf(b.dataset.face)?.name;
    const tip = b.dataset.face === 'auto'
      ? t(roux ? 'Work out which block you are building from the cube' : 'Work out the cross colour from the cube')
      : (roux ? t('First block with {colour} on the bottom', { colour: t(name) }) : t(`${name} cross`));
    b.title = tip;
    b.setAttribute('aria-label', tip);
  }
  ui.frontPick.hidden = !roux;
  const bottom = S.prefs.roux;
  for (const b of ui.frontSwatches.children) {
    const f = b.dataset.face;
    const bad = f !== 'auto' && (bottom === 'auto' || f === bottom || f === OPP[bottom]);
    b.disabled = bad;
    b.classList.toggle('on', f === S.prefs.rouxFront);
    const name = colourOf(f)?.name;
    const tip = f === 'auto' ? t('Work out the front from the cube')
      : bottom === 'auto' ? t('Pick a bottom colour first')
      : bad ? t('Not possible with that bottom')
      : t('{colour} front: first block on the {side} side', { colour: t(name), side: t(colourOf(leftOf(bottom, f)).name) });
    b.title = tip;
    b.setAttribute('aria-label', tip);
  }
  for (const b of ui.methodBtns.children) {
    const on = b.dataset.method === S.method;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/** CFOP or Roux. Nothing about the moves changes - only how they are read. */
function setMethod(method) {
  if (method === S.method) return;
  S.method = method;
  try { localStorage.setItem(METHOD_KEY, method); } catch { /* private mode */ }
  S.slot = null;
  lastBest = null;
  ui.legend.replaceChildren(...STRIP[method].map(t => el('span', { text: t })));
  /* The lines are re-cut too: where one step ends is a question about the
     method, and a Roux solve read as CFOP is one long "Cross". */
  S.steps = explode(S.scramble, allMoves());
  commit();
}

/* Set while a move is being committed. The commit redraws the panel, and the
   redraw used to hand the cube the finished position a frame before the move
   that got there was played — two writes, and the cube visibly jumped back
   before turning. The play that follows is the one that matters. */
let pendingPlay = false;

function render() {
  const a = look();
  const count = moveCount();

  ui.scrambleBox.value = S.scramble;
  // The bar at the top is where you edit the scramble; this is where you read
  // it, next to the cube it made, without looking away from the cube.
  ui.scrambleEcho.textContent = S.scramble || t('no scramble yet');
  ui.scrambleEcho.classList.toggle('empty', !S.scramble);
  ui.count.textContent = t(count === 1 ? '{n} move so far' : '{n} moves so far', { n: count });

  paintCrossPicker();
  renderSteps(a);
  renderStrip(a);
  if (!pendingPlay) renderCube();
  renderSuggestions(a);
  renderPhone(a);
}

function renderSteps(a) {
  ui.steps.innerHTML = '';
  if (!S.steps.length) {
    ui.steps.append(el('div', { class: 'rc-empty', text: t('Nothing yet. Pick a move on the right, or type one.') }));
  }
  S.steps.forEach((step, i) => {
    const row = el('div', { class: 'rc-step' },
      el('span', { class: 'ph' + (step.zb ? ' zb' : ''), text: stepLabel(step) }),
      el('span', { class: 'mv', text: step.alg }),
      el('span', { class: 'n', text: String(step.alg.split(/\s+/).filter(t => !/^[xyz]/i.test(t)).length) }),
      el('button', { class: 'rc-x', title: t('Remove this step'), text: '×', onclick: (e) => { e.stopPropagation(); holdHover(e); S.steps.splice(i, 1); commit(); } }),
    );
    row.addEventListener('mousemove', (e) => hoverPreview(e, row, () => playStep(i)));
    row.addEventListener('mouseleave', () => hoverEnd(row));
    ui.steps.append(row);
  });
  ui.steps.append(el('div', { class: 'rc-step current' },
    el('span', { class: 'ph', text: PHASE_LABEL[a.phase] }),
    el('span', { class: 'mv', text: a.phase === 'done' ? t('solved') : t('you are here') }),
    el('span', { class: 'n', text: '·' })));
  /* The line you are on is the one you are looking for, and a reconstruction
     eventually outgrows any panel it is given — so the list is always left
     scrolled to the bottom rather than at whatever the last redraw left. */
  ui.steps.scrollTop = ui.steps.scrollHeight;
}

/* Bar i is behind you once the solve has reached rank i + 1 - the same for
   both methods, because both ranks count seven milestones. */
function renderStrip(a) {
  const rank = rankOf(a);
  ui.strip.replaceChildren(...STRIP[S.method].map((_, i) =>
    el('div', { class: rank > i ? 'done' : rank === i ? 'now' : '' })));
}

/* ---------------- driving the cube ----------------
   Every path that changes what the cube shows comes through here, because
   twisty-player restarts itself for each attribute it is handed. Writing the
   new position and then immediately writing a move to play made it re-seat
   itself mid-turn — the jump you saw when a suggestion was clicked while the
   previous one was still turning. Stopping first, writing once, and only
   starting the animation on the next frame makes a click mid-turn look like
   what it is: the cube changing its mind, cleanly.

   Everything is spelt the way twisty-player spells it on the way in. RW is a
   wide turn to this app and a syntax error to the player, and a player that
   cannot read its alg does not turn slowly, it stops. */
let cubeToken = 0;

function showCube({ setup = '', alg = '', controls = 'none' } = {}) {
  if (!player) return;
  const token = ++cubeToken;
  const setupText = canonical(setup) ?? '';
  const algText = canonical(alg) ?? '';
  try {
    player.pause?.();
    player.setAttribute('control-panel', controls);
    player.setAttribute('experimental-setup-alg', setupText);
    player.setAttribute('alg', algText);
    if (!algText) return;
    player.jumpToStart?.();
    requestAnimationFrame(() => { if (token === cubeToken) { try { player.play?.(); } catch { /* ignore */ } } });
  } catch (err) { console.warn('[recon] player', err); }
}

/* ---------------- which way round am I holding it? ----------------
   You drag the cube round to find a piece, and now R is not where R was. The
   letters follow the camera so you never have to work that out: turn it, and
   the six faces are labelled where they have ended up.

   They come from the camera and nothing else. Rotations you *type* already
   turn the cube itself — after a y the face on the right really is the one you
   would call R — so the only thing that can put the letters out of step is
   dragging, and the only thing they have to track is the drag. */
const FACE_NORMALS = {
  U: [0, 1, 0], D: [0, -1, 0], R: [1, 0, 0],
  L: [-1, 0, 0], F: [0, 0, 1], B: [0, 0, -1],
};
/* Where cubing.js parks the camera before anybody touches it. */
const HOME_VIEW = { latitude: 35, longitude: 30 };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Where each face has ended up on screen, for a camera at `latitude` /
 * `longitude` degrees — the two numbers twisty-player hands out.
 *
 * `x` is across the picture and `y` down it, both from the middle and both in
 * units of "half a cube", so a caller multiplies by whatever radius it wants.
 * `front` is the three faces actually pointing at you.
 *
 * Exported because this is the part that can be wrong, and it can be checked
 * without a cube on the screen.
 */
export function faceSpots(latitude, longitude) {
  const la = latitude * Math.PI / 180, lo = longitude * Math.PI / 180;
  // The camera sits on a sphere around the cube; `right` and `up` are the two
  // axes of the picture it takes from there.
  const dir = [Math.sin(lo) * Math.cos(la), Math.sin(la), Math.cos(lo) * Math.cos(la)];
  const right = [Math.cos(lo), 0, -Math.sin(lo)];
  const up = cross3(dir, right);
  return Object.entries(FACE_NORMALS).map(([face, n]) => {
    const depth = dot(n, dir);
    return { face, x: dot(n, right), y: -dot(n, up), depth, front: depth > 0.05 };
  });
}

/** Degrees between two angles, the short way round. */
const apart = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/**
 * Put the letters where the faces are.
 * Hidden while the cube is sitting the way it started, because then the
 * letters are only telling you what you already know.
 */
function paintFaces({ latitude, longitude }) {
  if (!ui.faces || !player) return;
  const moved = Math.abs(latitude - HOME_VIEW.latitude) > 4
    || apart(longitude, HOME_VIEW.longitude) > 4;
  ui.faces.hidden = !moved;
  if (!moved) return;
  const pb = player.getBoundingClientRect(), sb = ui.stage.getBoundingClientRect();
  if (!pb.width || !sb.width) return;
  const cx = pb.x - sb.x + pb.width / 2;
  const cy = pb.y - sb.y + pb.height / 2;
  // Clear of the cube, which fills roughly half of the shorter side.
  const r = Math.min(pb.width, pb.height) * 0.52;
  for (const spot of faceSpots(latitude, longitude)) {
    const tag = ui.faceTags[spot.face];
    tag.style.left = `${cx + spot.x * r}px`;
    tag.style.top = `${cy + spot.y * r}px`;
    tag.classList.toggle('back', !spot.front);
  }
}

/** Follow the camera, if this build of cubing.js will say where it is. */
function watchCamera() {
  const orbit = player?.experimentalModel?.twistySceneModel?.orbitCoordinates;
  if (typeof orbit?.addFreshListener !== 'function') return;
  orbit.addFreshListener((c) => { try { paintFaces(c); } catch { /* not laid out yet */ } });
}

function renderCube(alg = '') {
  if (S.replay) {
    showCube({ setup: S.scramble, alg: allMoves(), controls: phoneOn() && P.timeline ? 'none' : 'bottom-row' });
    return;
  }
  showCube({ setup: [S.scramble, allMoves()].filter(Boolean).join(' '), alg });
}

/**
 * Wind the cube back to just before step `i` and run it.
 * `only` narrows that to the tail of the step — when you type a single move
 * into a line that already has five, you want to see the one you just made,
 * not all six again.
 */
function playStep(i, only = null) {
  if (!player || S.replay || i < 0 || !S.steps[i]) return;
  const step = S.steps[i];
  const alg = only || step.alg;
  const head = only ? step.alg.slice(0, step.alg.length - only.length).trim() : '';
  const before = [S.scramble, S.steps.slice(0, i).map(s => s.alg).join(' '), head]
    .filter(Boolean).join(' ');
  showCube({ setup: before, alg });
}



/**
 * The last one or two face turns made, as the solver names the faces.
 *
 * The search is told not to open on them. Without this the shortest way on
 * from a move you typed was nearly always to take it back — type R and the top
 * suggestion began R' — which is an undo button, not a suggestion. Trailing
 * rotations are looked through, since they turn no layer.
 */
function leadFaces() {
  const toks = allMoves().split(/\s+/).filter(Boolean);
  while (toks.length && /^[xyz]/i.test(toks.at(-1))) toks.pop();
  const lead = [];
  for (let i = toks.length - 1; i >= 0 && lead.length < 2; i--) {
    if (!/^[URFDLB]['2]?$/.test(toks[i])) break;
    lead.push(toks[i][0]);
  }
  if (!lead.length) return [];
  // A face turn does not change the frame, so the frame after them is the
  // frame they were made in.
  const at = applyAlg(SOLVED, [S.scramble, ...toks].filter(Boolean).join(' '), IDENTITY_FRAME);
  return at ? lead.map(f => at.frame[f]) : [];
}

const SLOT_ORDER = ['FR', 'FL', 'BL', 'BR', 'UR', 'UL', 'DL', 'DR', 'UF', 'UB', 'DB', 'DF'];

/** "any" plus the four pairs, named the way you are holding the cube. */
function renderSlots(a) {
  ui.slots.innerHTML = '';
  ui.slots.hidden = a.phase !== 'f2l';
  if (ui.slots.hidden) return;
  // A picked pair that has gone in has done its job.
  if (S.slot && a.slots.find(s => s.label === S.slot)?.done) S.slot = null;
  const frame = currentFrame();
  const pick = (label) => { S.slot = label; lastBest = null; renderSuggestions(look()); };
  ui.slots.append(
    el('span', { class: 'rc-rots-lbl', text: t('slot') }),
    el('button', {
      class: 'rc-rot' + (S.slot ? '' : ' on'), text: t('any'),
      title: t('The easiest pair, wherever it is'), onclick: () => pick(null),
    }));
  const rows = a.slots.map(s => ({ ...s, name: slotLabel(s.label, frame) }))
    .sort((x, y) => SLOT_ORDER.indexOf(x.name) - SLOT_ORDER.indexOf(y.name));
  for (const s of rows) {
    ui.slots.append(el('button', {
      class: 'rc-rot' + (S.slot === s.label ? ' on' : ''), text: s.name,
      title: s.done ? t('The {slot} pair is already in', { slot: s.name }) : t('Only suggest lines for the {slot} pair', { slot: s.name }),
      disabled: s.done || null, onclick: () => pick(s.label),
    }));
  }
}

function renderSuggestions(a) {
  ui.sugList.innerHTML = '';
  ui.phaseTag.textContent = PHASE_LABEL[a.phase];
  renderSlots(a);

  if (a.phase === 'done') {
    // Nothing to ask the solver, but an answer about the position before this
    // one may still be on its way, and it must not paint over "solved".
    ++pending;
    ui.dist.className = 'rc-dist';
    ui.dist.innerHTML = '';
    ui.dist.append(el('span', { class: 'n', text: '✓' }), el('span', { class: 'lbl', text: t('the cube is solved — nice reconstruction') }));
    ui.sugMore.textContent = '';
    return;
  }

  ui.dist.innerHTML = '';
  ui.dist.append(el('span', { class: 'n', text: '…' }), el('span', { class: 'lbl', text: t('looking for the shortest way on') }));
  ui.sugList.append(el('div', { class: 'rc-empty', text: t('thinking…') }));

  // The ticket drops any result a newer click has already outrun.
  const ticket = ++pending;
  askSolver(currentState(), currentFrame(), a, {
    limit: 20, crossName: a.method === 'roux' ? null : crossLabel(a), lead: leadFaces(),
    slot: a.phase === 'f2l' ? S.slot : null,
  })
    .then((res) => { if (ticket === pending) paintSuggestions(res, a); })
    .catch((err) => {
      console.warn('[recon] solver', err);
      if (ticket === pending) paintSuggestions({ list: [], best: -1 }, a);
    });
}

let pending = 0;

/* ---------------- where the thinking happens ----------------
   A last-slot F2L search can run for a couple of seconds. On the main thread
   that is a couple of seconds of frozen page — the cube stops mid-turn and the
   panel reads as broken rather than busy — so it goes to a worker, which also
   keeps the pruning tables warm between questions. If module workers are not
   available the search still runs, just inline, which is what the app did
   before and is only ever noticeable on the hardest positions. */
let worker = null;
let workerDead = false;
let workerJobs = new Map();
let workerSeq = 0;

function getWorker() {
  if (worker || workerDead) return worker;
  try {
    worker = new Worker(new URL(`./solver.worker.js?lang=${lang}`, import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data || {};
      const job = workerJobs.get(id);
      if (!job) return;
      workerJobs.delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(result);
    };
    worker.onerror = (e) => {
      console.warn('[recon] solver worker failed, falling back', e.message);
      workerDead = true;
      worker = null;
      for (const job of workerJobs.values()) job.reject(new Error('worker died'));
      workerJobs.clear();
    };
  } catch (err) {
    console.warn('[recon] no module workers here, solving inline', err.message);
    workerDead = true;
  }
  return worker;
}

function askSolver(state, frame, analysis, opts) {
  const w = getWorker();
  if (!w) {
    // Inline, but after a paint, so "thinking…" is on screen before it blocks.
    return new Promise((resolve) => setTimeout(() => resolve(suggest(state, frame, analysis, opts)), 16));
  }
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    workerJobs.set(id, { resolve, reject });
    // A copy, because the panel keeps using this position while the search runs.
    w.postMessage({ id, state: state.slice().buffer, frame, analysis, opts });
  }).catch((err) => {
    if (workerDead) return suggest(state, frame, analysis, opts);
    throw err;
  });
}

let lastBest = null;
let lastPhase = null;

function paintSuggestions(res, a) {
  ui.sugList.innerHTML = '';
  // Only comparable inside one phase: finishing the cross is not "costing" the
  // F2L moves that follow it.
  const worse = lastBest !== null && lastPhase === a.phase && res.best > lastBest;
  lastBest = res.best;
  lastPhase = a.phase;

  ui.dist.className = 'rc-dist' + (worse ? ' worse' : '') + (res.zb ? ' zb' : '');
  ui.dist.innerHTML = '';
  if (res.best < 0) {
    ui.dist.append(el('span', { class: 'n', text: '?' }),
      el('span', { class: 'lbl', text: t('nothing found within reach — type a move and carry on') }));
  } else {
    const what = a.phase === 'cross' ? t('to finish the {cross}', { cross: crossLabel(a) })
      : a.phase === 'f2l' ? (S.slot ? t('to insert the {slot} pair', { slot: slotLabel(S.slot, currentFrame()) }) : t('to insert the easiest pair'))
      : a.phase === 'oll' ? t('to orient the last layer')
      : a.phase === 'fb' ? t('to build the first block')
      : a.phase === 'sb' ? t(a.sqF || a.sqB ? 'to finish the second block' : 'to build a second-block square')
      : a.phase === 'cmll' ? t('to solve the top corners')
      : a.phase === 'eo' ? t('to orient the last six edges')
      : a.phase === 'ulur' ? t('to put UL and UR in')
      : t('to finish the solve');
    /* The edges are already up, so this OLL does not need a PLL after it.
       That is worth saying out loud — it is the difference between two algs
       and one, and it is easy to miss looking at the cube. */
    const zb = res.zb ? t(' — edges are already oriented, so {alg} finishes it in one', { alg: res.zbBest }) : '';
    ui.dist.append(el('span', { class: 'n', text: String(res.best) }),
      el('span', { class: 'lbl', text: `${res.best === 1 ? t('move') : t('moves')} ${what}`
        + zb + (worse ? t(' — that last move cost you') : '') }));
  }

  paintSugRows(res);
}

/** The suggestion rows themselves: hover rows on a desktop, cards on a phone. */
function paintSugRows(res) {
  ui.sugList.innerHTML = '';
  if (!res.list.length) {
    ui.sugList.append(el('div', { class: 'rc-empty', text: t('No suggestion for this position. Type your own move.') }));
    ui.sugMore.textContent = '';
    return;
  }
  P.res = res;
  if (phoneOn()) { paintPhoneSugs(res); return; }

  for (const s of res.list) {
    const zb = s.kind === 'ZBLL';
    const row = el('div', { class: 'rc-sug' + (zb ? ' zb' : s.moves === res.best ? ' top' : '') },
      el('span', {},
        el('span', { class: 'alg', text: s.alg },
          zb ? el('span', { class: 'rc-zb-tag', text: 'ZBLL', title: t('One alg for the whole last layer') }) : null),
        el('span', { class: 'why', text: `${s.label} · ${s.note}` })),
      el('span', { class: 'len', text: String(s.moves) }),
    );
    row.addEventListener('mousemove', (e) => hoverPreview(e, row, () => renderCube(s.alg)));
    row.addEventListener('mouseleave', () => hoverEnd(row));
    row.addEventListener('click', (e) => { holdHover(e); addStep(s.alg); });
    ui.sugList.append(row);
  }
  ui.sugMore.textContent = res.partial
    ? t('{n} shown — the search stopped early on this one', { n: res.list.length })
    : t('{n} shown · easiest to turn first', { n: res.list.length });
}

/* =========================================================
   Editing
   ========================================================= */

/**
 * Does this move belong on the line already open, or start the next one?
 *
 * One rule, and it is about the cube rather than about you: a line breaks when
 * something actually went in. `rank` is how far through the solve the position
 * is now; `last.rank` is how far through it was when that line started. Equal
 * means nothing has gone in since, so this is still the same pair.
 *
 * It used to also insist the line was typed, and that a clicked suggestion
 * always start its own — which put the alg the panel had just suggested for
 * the pair you were setting up on a line of its own, as though it were a
 * second pair. It is not; the U' before it was part of the same idea. It is
 * also the rule `explode` has always used to read a saved reconstruction back,
 * so editing one and reopening one now group it the same way.
 *
 * Exported for the self test, which is where the rule is written down.
 */
export function joinsLast(last, rank) {
  if (!last) return false;
  /* A line of nothing but rotations is not a step yet — you turned the cube to
     set something up. Whatever comes next joins it, which is how a y' in the
     middle of F2L ends up on the line with the pair it was for. */
  if (allRotations(last.alg)) return true;
  return rank <= last.rank;
}

/**
 * Add moves to the reconstruction.
 * Moves run together into one line for as long as they are still the same
 * piece of work — typing R U2 F', or typing U' and then clicking the alg the
 * panel suggests for that pair, is one step, not two.
 */
function addStep(alg, { typed = false } = {}) {
  /* Stored the way the cube draws it rather than the way it was typed, so a
     wide turn is Rw wherever it goes next — the player, the share card, the
     move string saved on the solve. */
  const clean = canonical(String(alg || '').trim());
  if (clean === null) { toast(t("Could not read that - try moves like R U2 F'"), { kind: 'bad' }); return; }
  if (!clean) return;
  const last = S.steps.at(-1);
  const a = look();
  const rank = rankOf(a);
  if (joinsLast(last, rank)) last.alg = `${last.alg} ${clean}`;
  else S.steps.push({ alg: clean, phase: a.phase, rank });
  // Watch it happen. Snapping to the answer told you nothing about the moves,
  // which is the whole reason the cube is on screen — and the redraw is told
  // to leave the cube alone so the move is the only thing it is asked to do.
  pendingPlay = true;
  try { commit(); } finally { pendingPlay = false; }
  playStep(S.steps.length - 1, typed ? clean : null);
}

/** The reconstruction as text, the way people write them out. */
export function reconText() {
  const lines = S.steps.map(st => `${stepLabel(st)}: ${st.alg}`);
  const total = moveCount();
  return [S.scramble, '', ...lines, '', `${total} moves`].join('\n');
}

const allRotations = (alg) => alg.split(/\s+/).filter(Boolean).every(t => /^[xyz]/i.test(t));

/** Face turns in the reconstruction so far. Rotations are not moves. */
function moveCount() {
  return allMoves().split(/\s+/).filter(t => t && !/^[xyz]/i.test(t)).length;
}

/** Take back one move, not one line - the smallest thing you can regret. */
function undo() {
  const last = S.steps.at(-1);
  if (!last) return;
  const toks = last.alg.split(/\s+/).filter(Boolean);
  toks.pop();
  if (toks.length) last.alg = toks.join(' ');
  else S.steps.pop();
  commit();
}

function commit() {
  recompute();
  render();
  saveHook?.(allMoves());
}

/* =========================================================
   The move box

   Types in caps and commits as you go: finish a move, hit space, and it
   lands on the list. Enter still works, but you never need it.
   ========================================================= */

function wireInput(input) {
  const flush = (force) => {
    let v = input.value;
    if (!v.trim()) { if (force) input.value = ''; return; }
    const endsOpen = !/\s$/.test(v);
    const toks = v.trim().split(/\s+/);
    const tail = (endsOpen && !force) ? toks.pop() : null;
    const ready = toks.join(' ');
    if (ready) {
      if (parse(ready)) { addStep(ready, { typed: true }); input.value = tail || ''; input.classList.remove('bad'); }
      else input.classList.add('bad');
    } else {
      input.value = tail || '';
    }
  };

  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    // Caps as you type, so no shift key stands between you and a move.
    const up = input.value.replace(/[a-z]/g, c => c.toUpperCase());
    if (up !== input.value) { input.value = up; input.setSelectionRange(pos, pos); }
    input.classList.remove('bad');
    if (/\s$/.test(input.value)) flush(false);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();                     // the timer must not see these keys
    if (e.key === 'Enter') { e.preventDefault(); flush(true); }
    if (e.key === 'Backspace' && !input.value && S.steps.length) { e.preventDefault(); undo(); }
  });
  input.addEventListener('blur', () => flush(true));
  return () => flush(true);
}

/* =========================================================
   Building the panel
   ========================================================= */

function build() {
  host = el('div', { id: 'recon', hidden: true });

  ui.scrambleBox = el('input', {
    id: 'rc-scramble', class: 'rc-inp', spellcheck: 'false', autocomplete: 'off',
    'aria-label': t('Scramble to reconstruct'), placeholder: t('paste any scramble…'),
  });
  ui.scrambleBox.addEventListener('keydown', e => e.stopPropagation());
  ui.scrambleBox.addEventListener('change', () => setScramble(ui.scrambleBox.value));

  const top = el('div', { class: 'rc-top' },
    /* The same mark the timer wears. A full-screen surface with no badge on it
       reads as somewhere else's page, which is exactly what this is not. */
    el('span', { class: 'rc-brand' },
      el('img', {
        class: 'brand-mark', src: 'assets/logo-96.png', alt: '',
        width: '96', height: '96', decoding: 'async',
      }),
      el('span', { class: 'brand-text', html: 'Tagda <b>Timer</b>' })),
    el('button', {
      class: 'ghost-btn sm', onclick: () => close(),
      html: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg> ' + t('back to timer'),
    }),
    el('div', { class: 'rc-scr' },
      el('span', { class: 'rc-scr-lbl', text: t('scramble') }),
      ui.scrambleBox,
      el('button', {
        class: 'ghost-btn sm', title: t('Copy the scramble'),
        onclick: () => copy(S.scramble).then(() => toast(t('Scramble copied'))),
        html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
      }),
      /* Share lives in two places on purpose. It reads better as a word next to
         the reconstruction it is going to make a card of, but this is where it
         has always been and where hands already go for it, and a button that
         moves is a button that has gone missing. */
      el('button', {
        class: 'ghost-btn sm rc-share-icon', title: t('Make a share card of this reconstruction'),
        'aria-label': t('Share this reconstruction'), onclick: shareCard,
        html: '<svg viewBox="0 0 24 24"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M12 3v13M8 7l4-4 4 4"/></svg>',
      }),
    ),
    ui.pick = el('div', { class: 'rc-pick' },
      ui.pickBtn = el('button', {
        class: 'ghost-btn sm', onclick: togglePicker,
        html: t('from a solve') + ' <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
      }),
      ui.pickList = el('div', { class: 'rc-picklist', hidden: true })),
    el('div', { class: 'rc-title' }, ui.title = el('span', { text: t('Reconstruct') })),
  );

  /* ---- left: the cube ---- */
  /* The scramble again, above the cube. The bar at the top of the panel is
     where you change it; this is where you read it while you are looking at
     the thing it produced, which is where you are actually looking. */
  ui.scrambleEcho = el('div', { class: 'rc-cube-scramble mono', title: t('The scramble this position came from') });
  ui.stage = el('div', { class: 'rc-cube' });
  ui.faceTags = {};
  ui.faces = el('div', { class: 'rc-faces', hidden: true, 'aria-hidden': 'true' },
    ...Object.keys(FACE_NORMALS).map(f =>
      (ui.faceTags[f] = el('span', { class: 'rc-face', text: f }))));
  ui.stage.append(ui.faces);
  ui.strip = el('div', { class: 'rc-strip' });

  ui.replayBtn = el('button', {
    class: 'ghost-btn sm', text: t('replay the whole solve'),
    onclick: () => { S.replay = !S.replay; ui.replayBtn.classList.toggle('on', S.replay); renderCube(); },
  });

  /* Rotations. Most people reconstruct with the cross on the bottom, which
     means the first thing they want is to turn the cube over — and every
     suggestion after that comes back in the orientation they are holding.
     They cost nothing: a rotation is not a move, and the counter ignores it. */
  ui.rots = el('div', { class: 'rc-rots' },
    el('span', { class: 'rc-rots-lbl', text: t('turn') }),
    ...['x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'].map(r =>
      el('button', {
        class: 'rc-rot', text: r, title: t('Turn the whole cube: {r}', { r }),
        onclick: (e) => { holdHover(e); addStep(r, { typed: true }); },
      })),
  );

  const left = ui.left = el('section', { class: 'panel rc-left' },
    el('div', { class: 'panel-head' },
      el('span', { text: t('Position') }),
      ui.count = el('span', { class: 'panel-sub', text: t('{n} moves so far', { n: 0 }) })),
    /* How the moves are read: where one step ends and the next begins, and
       what gets suggested. The moves themselves are the same either way. It
       sits above everything it decides, big enough that Roux is noticed. */
    ui.methodBtns = el('div', { class: 'rc-method', role: 'group', 'aria-label': t('Solving method') },
      ...[['cfop', 'CFOP', t('cross · F2L · OLL · PLL')], ['roux', 'Roux', t('blocks · CMLL · LSE')]].map(([m, label, sub]) => el('button', {
        class: 'rc-method-btn', dataset: { method: m },
        title: t('Read the solve as {method}', { method: label }), onclick: () => setMethod(m),
      }, el('b', { text: label }), el('small', { text: sub })))),
    el('div', { class: 'rc-orient' },
      el('span', { class: 'rc-cross-pick' },
        ui.crossLbl = el('span', { class: 'rc-pick-lbl', text: t('cross') }),
        ui.crossSwatches = swatchRow(setCross, t('Work out the cross colour from the cube'))),
      ui.frontPick = el('span', { class: 'rc-cross-pick', hidden: true },
        el('span', { class: 'rc-pick-lbl', text: t('front') }),
        ui.frontSwatches = swatchRow(setFront, t('Work out the front from the cube'))),
    ),
    ui.scrambleEcho,
    ui.stage,
    el('div', { class: 'rc-cube-tools' }, ui.replayBtn),
    ui.rots,
    ui.strip,
    ui.legend = el('div', { class: 'rc-strip-legend' },
      ...STRIP[S.method].map(t => el('span', { text: t }))),
  );

  /* ---- right: the reconstruction and what comes next ---- */
  ui.steps = el('div', { class: 'rc-steps' });
  ui.dist = el('div', { class: 'rc-dist' });
  ui.slots = el('div', { class: 'rc-slots', hidden: true });
  ui.sugList = el('div', { class: 'rc-sugs' });
  ui.sugMore = el('div', { class: 'rc-more' });
  ui.input = el('input', {
    class: 'rc-inp mono', spellcheck: 'false', autocomplete: 'off',
    placeholder: t('type a move…'), 'aria-label': t('Add moves'),
  });
  const flushInput = wireInput(ui.input);

  const right = el('aside', { class: 'rc-right' },
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { text: t('Reconstruction') }),
        /* Copying it out and making a card of it are the two things you do
           with a finished reconstruction, and they used to be unlabelled icons
           in the scramble bar at the top — next to the reconstruction is where
           you look for them, and a word is what you look for. */
        el('span', { class: 'rc-head-tools' },
          el('button', {
            class: 'ghost-btn sm', text: t('copy'), title: t('Copy the reconstruction as text'),
            onclick: () => {
              if (!S.steps.length) return toast(t('Nothing to copy yet'));
              copy(reconText()).then(() => toast(t('Reconstruction copied'), { kind: 'good' }));
            },
          }),
          el('button', {
            class: 'ghost-btn sm rc-share', text: t('share'),
            title: t('Make a share card of this reconstruction'), onclick: shareCard,
          }),
          el('button', { class: 'ghost-btn sm', text: t('undo'), onclick: undo }),
          el('button', { class: 'ghost-btn sm danger', text: t('clear'), onclick: () => { S.steps = []; commit(); } }))),
      ui.steps),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { text: t("What's next") }),
        ui.phaseTag = el('span', { class: 'panel-sub', text: t('cross') })),
      ui.slots, ui.dist, ui.sugList, ui.sugMore,
      ui.entry = el('div', { class: 'rc-entry' }, ui.input,
        el('button', { class: 'btn primary', text: t('add'), onclick: () => flushInput() })),
      el('p', { class: 'rc-hint', text:
        t('Types in caps and adds as you go — finish a move, press space. Not in the list? Type it anyway; the suggestions rebuild from wherever you land. Wide turns are RW, LW, UW; slices are M, E, S.') }),
    ),
  );

  host.append(top, el('div', { class: 'rc-body' }, left, right));
  // Clicking anywhere else puts the solve list away, the way a menu should.
  host.addEventListener('click', (e) => {
    if (!ui.pickList.hidden && !ui.pick.contains(e.target)) ui.pickList.hidden = true;
  });
  document.body.append(host);
}

/**
 * The solution as a card wants it: one line per phase.
 * Adding two moves to the cross does not make a second cross, and four pairs
 * are all F2L — repeating the label four times is noise, not information. A
 * trailing U turn on a finished solve is the AUF, so it gets its own line.
 */
function cardSteps() {
  const out = [];
  let heading = null;
  for (const st of S.steps) {
    const phase = stepLabel(st);
    // Every step keeps its own line — four pairs are four lines. The heading is
    // what stops repeating: they are all F2L, and saying so four times is noise.
    out.push({ phase: phase === heading ? '' : phase, alg: st.alg, zb: !!st.zb });
    heading = phase;
  }
  const last = out.at(-1);
  if (last && look().solved) {
    const toks = last.alg.split(/\s+/).filter(Boolean);
    if (toks.length > 1 && /^U('|2)?$/.test(toks.at(-1))) {
      last.alg = toks.slice(0, -1).join(' ');
      out.push({ phase: 'AUF', alg: toks.at(-1) });
    }
  }
  return out;
}

/** Hand the whole thing - scramble, the cube it makes, and the solution - to
    the share sheet. Loaded on demand, like every other card in the app. */
async function shareCard() {
  if (!S.steps.length) { toast(t('Reconstruct something first')); return; }
  try {
    const m = await import('./sharedlg.js');
    const steps = cardSteps();
    await m.shareRecon({
      scramble: S.scramble,
      title: ui.title.textContent,
      steps,
      moves: moveCount(),
      zb: steps.some(st => st.zb),
    });
  } catch (err) {
    console.warn('[recon] share', err);
    toast(t('Could not open the share sheet'), { kind: 'bad' });
  }
}

/* ---------------- the "or pick one you already did" list ----------------
   The topbar button opens the panel on whatever scramble is on screen. This is
   the other half of the same question: any solve in the session, with whatever
   reconstruction was left on it last time. */

function togglePicker(e) {
  e?.stopPropagation();
  const open = ui.pickList.hidden;
  ui.pickList.hidden = !open;
  if (!open) return;
  ui.pickList.innerHTML = '';
  if (!S.library.length) {
    ui.pickList.append(el('div', { class: 'rc-empty', text: t('No solves in this session yet.') }));
    return;
  }
  for (const item of S.library) {
    ui.pickList.append(el('button', { class: 'rc-pickrow', onclick: () => { ui.pickList.hidden = true; loadFrom(item); } },
      el('b', { text: item.label }),
      el('span', { text: item.scramble }),
      item.moves ? el('i', { text: t('has a reconstruction') }) : null));
  }
}

function loadFrom(item) {
  S.scramble = canonical(String(item.scramble || '').replace(/\s+/g, ' ').trim()) || '';
  S.steps = explode(S.scramble, item.moves);
  saveHook = item.save || null;
  ui.title.textContent = item.label;
  P.time = Number.isFinite(item.time) ? item.time : null;
  S.slot = null;
  lastBest = null;
  commit();
}

/* =========================================================
   The phone layout

   Same workbench, laid out for one hand. The cube sits at the top and never
   scrolls; under it, one scroll area holds where you are (the phase strip and
   the solution so far) and what comes next (the headline, the slot chips and
   the suggestions). The bottom bar opens the move pad, and while the pad is
   up the cube shrinks to a thumbnail beside the last move typed, so the
   suggestions stay in view and rebuild after every key, as they always have.

   Nothing here is built until a phone opens the panel, and the desktop
   layout is left exactly as it was: the few live pieces both share (the
   cube, the headline, the slot chips, the suggestion list) are moved between
   the two by place(), and everything else is the phone's own.

   Hover becomes tap: a suggestion card opens to "Play on cube" and "Use these
   N" instead of previewing under a pointer a phone does not have. A mouse on
   a narrow window still gets the hover preview.
   ========================================================= */

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle class="fill" cx="5.5" cy="12" r="1.5"/><circle class="fill" cx="12" cy="12" r="1.5"/><circle class="fill" cx="18.5" cy="12" r="1.5"/></svg>',
  turn: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7"/><path d="M20.5 4v4.5H16"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path class="fill" d="M7 5.5h3.6v13H7zM13.4 5.5H17v13h-3.6z"/></svg>',
  keys: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/><path d="M6.5 10h1M10.5 10h1M14.5 10h1M8 14.5h8"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 13v5.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V13"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  paste: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 12h7M4 18h11M17 9v9M13.5 12.5L17 9l3.5 3.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  start: '<svg viewBox="0 0 24 24"><path d="M6.5 6v12"/><path class="fill" d="M18 6.5v11L9.5 12z"/></svg>',
  stepBack: '<svg viewBox="0 0 24 24"><path class="fill" d="M16.5 6.5v11L8 12z"/></svg>',
  stepFwd: '<svg viewBox="0 0 24 24"><path class="fill" d="M7.5 6.5v11L16 12z"/></svg>',
  end: '<svg viewBox="0 0 24 24"><path d="M17.5 6v12"/><path class="fill" d="M6 6.5v11l8.5-5.5z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

/* The phone's own state. Everything about the reconstruction itself stays in S. */
const P = {
  built: false,
  padOpen: false,
  lastMove: '',       // the move the pad just landed, lit in the solution
  milestone: '',      // "Pair in — 3 of 4", when the last move finished something
  selStep: -1,        // a step tapped in the solution, with Play / Remove under it
  openSug: null,      // the suggestion card that is open, by its alg
  res: null,          // the last suggestion result, to redraw the cards from
  flat: false,        // the 2D net instead of the 3D cube
  speed: 1,
  playing: false,
  timeline: false,    // this cubing.js tells us where its playback is
  ix: null, starts: [], ends: [], ts: 0,
  R: null,            // the replay's moves, cut up for the scrubber and the table
  time: null,         // the solve's time in ms, for turns per second
};
let ph = {};

const phoneOn = () => P.built && !!host?.classList.contains('rc-phone');

const isRotation = (tok) => /^[xyz]/i.test(tok);
const toksOf = (alg) => String(alg || '').split(/\s+/).filter(Boolean);
const faceCount = (alg) => toksOf(alg).filter(tk => !isRotation(tk)).length;
const lastToken = () => toksOf(allMoves()).at(-1) || '';

const STRIP_NAMES = {
  cfop: () => [t('Cross'), 'F2L 1', 'F2L 2', 'F2L 3', 'F2L 4', 'OLL', 'PLL'],
  roux: () => ['FB', 'SB sq', 'SB', 'CMLL', 'EO', 'UL/UR', 'LSE'],
};

/** What the last move just finished, if anything: rank is where the solve is now. */
function milestoneText(rank, a) {
  if (a.method === 'roux') {
    return [null, t('First block done'), t('Second-block square in'), t('Second block done'),
      t('Corners done'), t('Edges oriented'), t('UL and UR in'), t('Solved')][rank] || '';
  }
  if (rank === 1) return t('Cross done');
  if (rank >= 2 && rank <= 5) return t('Pair in — {n} of 4', { n: rank - 1 });
  if (rank === 6) return t('Last layer oriented');
  return rank === 7 ? t('Solved') : '';
}

/** How far through the solve step i left it. */
function rankAfter(i) {
  if (i + 1 < S.steps.length) return S.steps[i + 1].rank;
  const st = S.positions[i + 1], fr = S.frames[i + 1];
  return st ? rankOf(analyseAt(st, fr)) : S.steps[i].rank;
}

/**
 * A step's name in the phone's replay table, the way a reconstruction is
 * written out: a cross that took a pair with it is an X-cross, and a pair is
 * numbered by how many are in once it is.
 */
function phoneStepLabel(i) {
  const st = S.steps[i];
  if (S.method === 'roux' || st.zb) return stepLabel(st);
  const after = rankAfter(i);
  if (st.phase === 'cross' && after >= 2 && after <= 5) return t(`${'X'.repeat(after - 1)}-cross`);
  if (st.phase === 'f2l') return `F2L ${after > st.rank ? after - 1 : st.rank}`;
  return stepLabel(st);
}

/** "Solve 38 · 11.42" under the title, for a solve; nothing for a typed-in scramble. */
function phoneSubtitle() {
  const title = ui.title.textContent || '';
  const m = /^#(\d+)\s*·\s*(.+)$/.exec(title);
  if (m) return t('Solve {n} · {time}', { n: m[1], time: m[2] });
  return title === t('Reconstruct') ? '' : title;
}

function iconBtn(cls, label, icon, onclick) {
  return el('button', { class: cls, type: 'button', 'aria-label': label, title: label, html: icon, onclick });
}

function buildPhone() {
  if (P.built) return;
  P.built = true;

  /* ---- header ---- */
  ph.sub = el('div', { class: 'rc-ph-sub' });
  ph.head = el('header', { class: 'rc-ph-head' },
    iconBtn('rc-ph-icon', t('Back'), ICON.back, phoneBack),
    el('div', { class: 'rc-ph-titles' }, el('h1', { text: t('Reconstruct') }), ph.sub),
    iconBtn('rc-ph-icon', t('Copy, share card, pick another solve'), ICON.more, openMoreSheet));

  /* ---- the cube, and what floats on it ---- */
  ph.crossDot = el('span', { class: 'rc-ph-dot', 'aria-hidden': 'true' });
  ph.crossTxt = el('span', { class: 'rc-ph-chip-txt' });
  ph.crossChip = el('button', { class: 'rc-ph-chip', type: 'button', onclick: openOrientSheet }, ph.crossDot, ph.crossTxt);
  ph.viewBtn = el('button', {
    class: 'rc-ph-round txt', type: 'button', text: '2D', 'aria-label': t('Flat net'), 'aria-pressed': 'false', onclick: toggleFlat,
  });
  ph.tools = el('div', { class: 'rc-ph-tools' },
    iconBtn('rc-ph-round', t('Turn the cube'), ICON.turn, openTurnSheet), ph.viewBtn);
  ph.moveChip = el('span', { class: 'rc-ph-movechip' });
  ph.roMove = el('div', { class: 'rc-ph-ro-move' });
  ph.roNote = el('div', { class: 'rc-ph-ro-note', hidden: true });
  ph.readout = el('div', { class: 'rc-ph-readout', 'aria-live': 'polite' },
    el('div', { class: 'rc-ph-ro-lbl', text: t('Last move') }), ph.roMove, ph.roNote);
  ph.cube = el('div', { class: 'rc-ph-cube' }, ph.crossChip, ph.tools, ph.moveChip, ph.readout);

  /* ---- next move: where you are, and what comes next ---- */
  ph.strip = el('ol', { class: 'rc-ph-strip', 'aria-label': t('Solve phases') });
  ph.count = el('span', { class: 'rc-ph-count' });
  ph.moves = el('p', { class: 'rc-ph-moves' });
  ph.moves.addEventListener('click', (e) => {
    const step = e.target.closest('.rc-ph-step');
    if (step) selectStep(Number(step.dataset.i));
  });
  ph.moves.addEventListener('keydown', (e) => {
    const step = e.target.closest('.rc-ph-step');
    if (step && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectStep(Number(step.dataset.i)); }
  });
  ph.stepBar = el('div', { class: 'rc-ph-stepbar', hidden: true });
  ph.sol = el('section', { class: 'rc-ph-sol', 'aria-label': t('Solution so far') },
    el('div', { class: 'rc-ph-sol-head' },
      el('span', { class: 'rc-ph-lbl', text: t('Solution so far') }),
      el('span', { class: 'rc-ph-sol-tools' }, ph.count,
        iconBtn('rc-ph-mini', t('Undo the last move'), ICON.undo, () => { P.selStep = -1; undo(); }),
        iconBtn('rc-ph-mini', t('Replay the whole solve'), ICON.play, () => setReplay(true)))),
    ph.moves, ph.stepBar);
  ph.next = el('div', { class: 'rc-ph-next' }, ph.strip, ph.sol);

  /* ---- replay ---- */
  ph.track = el('div', { class: 'rc-ph-track', 'aria-hidden': 'true' });
  ph.thumb = el('span', { class: 'rc-ph-thumb', 'aria-hidden': 'true' });
  ph.scrub = el('div', {
    class: 'rc-ph-scrub', role: 'slider', tabindex: '0', 'aria-label': t('Position in the solve'),
    'aria-valuemin': '0', 'aria-valuenow': '0', 'aria-valuemax': '0',
  }, ph.track, ph.thumb);
  wireScrub();
  ph.speedBtn = el('button', { class: 'rc-ph-speed', type: 'button', 'aria-label': t('Playback speed'), text: '1×', onclick: cycleSpeed });
  ph.playBtn = iconBtn('rc-ph-play', t('Play'), ICON.play, () => (P.playing ? player?.pause?.() : player?.play?.()));
  ph.transport = el('div', { class: 'rc-ph-transport' },
    ph.speedBtn,
    iconBtn('rc-ph-tbtn', t('Back to the scramble'), ICON.start, () => player?.jumpToStart?.()),
    iconBtn('rc-ph-tbtn', t('One move back'), ICON.stepBack, () => stepReplay(-1)),
    ph.playBtn,
    iconBtn('rc-ph-tbtn', t('One move forward'), ICON.stepFwd, () => stepReplay(1)),
    iconBtn('rc-ph-tbtn', t('Jump to the end'), ICON.end, () => player?.jumpToEnd?.()));
  ph.table = el('div', { class: 'rc-ph-table' });
  ph.stats = el('div', { class: 'rc-ph-stats' });
  ph.replay = el('div', { class: 'rc-ph-replay', hidden: true },
    el('div', { class: 'rc-ph-scrubwrap' }, ph.scrub, ph.transport), ph.table, ph.stats);

  ph.scroll = el('div', { class: 'rc-ph-scroll' }, ph.next, ph.replay);

  /* ---- the bottom: the bar that opens the pad, the replay's bar, the pad ---- */
  ph.field = el('input', {
    class: 'rc-ph-field', type: 'text', placeholder: t('Type what you did…'),
    'aria-label': t('Type what you did'), autocomplete: 'off', spellcheck: 'false',
  });
  ph.bar = el('div', { class: 'rc-ph-bar' },
    el('label', { class: 'rc-ph-fieldbox' }, el('span', { class: 'rc-ph-fieldico', html: ICON.keys, 'aria-hidden': 'true' }), ph.field));
  ph.saveBtn = el('button', { class: 'rc-ph-rb primary', type: 'button', text: t('Save to solve'), onclick: saveToSolve });
  ph.rbar = el('div', { class: 'rc-ph-bar rc-ph-rbar', hidden: true },
    el('button', { class: 'rc-ph-rb', type: 'button', html: `${ICON.copy}<span></span>`, onclick: copyRecon }),
    el('button', { class: 'rc-ph-rb', type: 'button', html: `${ICON.share}<span></span>`, onclick: shareCard }),
    ph.saveBtn);
  const [copyLbl, cardLbl] = ph.rbar.querySelectorAll('.rc-ph-rb span');
  copyLbl.textContent = t('Copy');
  cardLbl.textContent = t('Card');

  ph.pad = createMovePad({
    notation: 'full',
    action: t('Done'),
    onAction: closePad,
    last: lastToken,
    push: (tok) => padMove(tok),
    replaceLast: (tok) => { undo(); padMove(tok); },
    pop: () => { undo(); P.lastMove = lastToken(); P.milestone = ''; renderPhoneBits(); },
  });
  ph.pad.attachField(ph.field);
  ph.field.addEventListener('click', openPad);
  ph.field.addEventListener('focus', openPad);

  ph.root = el('div', { class: 'rc-ph' }, ph.head, ph.cube, ph.scroll, ph.bar, ph.rbar, ph.pad.el);
  host.append(ph.root);

  document.addEventListener('keydown', onPhoneKey, true);
}

/**
 * Put the shared pieces where the current layout wants them. Only moved when
 * they are somewhere else: moving the cube restarts its renderer.
 */
function place() {
  if (!host) return;
  const phone = isPhone();
  if (phone) buildPhone();
  host.classList.toggle('rc-phone', phone);
  if (phone) {
    if (ui.stage.parentNode !== ph.cube) ph.cube.prepend(ui.stage);
    if (ui.dist.parentNode !== ph.next) ph.next.append(ui.dist, ui.slots, ui.sugList, ui.sugMore);
  } else {
    if (ui.stage.parentNode !== ui.left) ui.scrambleEcho.after(ui.stage);
    if (ui.entry.parentNode && ui.dist.parentNode !== ui.entry.parentNode) ui.entry.before(ui.slots, ui.dist, ui.sugList, ui.sugMore);
    if (P.flat) toggleFlat();
  }
}

/** Back to a fresh "next move" screen: pad down, replay off, nothing picked. */
function resetPhone() {
  S.replay = false;
  ui.replayBtn?.classList.remove('on');
  P.padOpen = false;
  P.selStep = -1;
  P.openSug = null;
  P.lastMove = '';
  P.milestone = '';
  P.speed = 1;
  if (!P.built) return;
  ph.pad.hide();
  player?.setAttribute?.('back-view', 'top-right');
  ph.root.classList.remove('pad-open', 'replaying');
  ph.next.hidden = false;
  ph.replay.hidden = true;
  ph.bar.hidden = false;
  ph.rbar.hidden = true;
  ph.speedBtn.textContent = '1×';
  player?.setAttribute?.('tempo-scale', '2.2');
  if (P.flat) toggleFlat();
}

onPhoneChange(() => {
  if (!host) return;
  closeAllSheets();
  resetPhone();
  place();
  if (reconOpen()) commit();
});

/** Back: the pad first, then the replay, then out of the workbench. */
function phoneBack() {
  if (P.padOpen) return closePad();
  if (S.replay) return setReplay(false);
  close();
}

/* ---------------- painting ---------------- */

function renderPhone(a) {
  if (!phoneOn()) return;
  const sub = phoneSubtitle();
  ph.sub.textContent = sub;
  ph.sub.hidden = !sub;

  // The colour you are solving from, as a chip on the cube.
  if (S.method === 'roux') {
    const bottom = S.prefs.roux;
    ph.crossDot.style.background = bottom === 'auto' ? '' : colourOf(bottom).hex;
    ph.crossDot.classList.toggle('auto', bottom === 'auto');
    ph.crossTxt.textContent = bottom === 'auto' ? t('Roux · auto') : t('Roux · {colour} bottom', { colour: t(colourOf(bottom).name) });
  } else {
    ph.crossDot.style.background = colourOf(a.face)?.hex || '';
    ph.crossDot.classList.remove('auto');
    ph.crossTxt.textContent = crossLabel(a);
  }
  ph.crossChip.setAttribute('aria-label', `${ph.crossTxt.textContent}. ${t('Change the method or the colour')}`);

  const rank = rankOf(a);
  const names = STRIP_NAMES[S.method]();
  ph.strip.replaceChildren(...names.map((name, i) => el('li', {
    class: rank > i ? 'done' : rank === i ? 'now' : '', 'aria-current': rank === i ? 'step' : null,
  }, el('span', { class: 'bar', 'aria-hidden': 'true' }), el('span', { class: 'name', text: name }))));

  renderPhoneBits();
  ph.saveBtn.hidden = !saveHook;
  ph.rbar.classList.toggle('two', !saveHook);
  if (S.replay) buildReplay();
}

/** The solution so far, the step under it and the pad's readout. */
function renderPhoneBits() {
  if (!phoneOn()) return;
  const count = moveCount();
  ph.count.textContent = t(count === 1 ? '{n} move' : '{n} moves', { n: count });

  const caret = el('span', { class: 'caret', 'aria-hidden': 'true' });
  if (!S.steps.length) {
    ph.moves.replaceChildren(el('span', { class: 'rc-ph-empty', text: t('Nothing yet. Pick a line below, or type what you did.') }), caret);
  } else {
    const kids = [];
    const lastI = S.steps.length - 1;
    S.steps.forEach((step, i) => {
      if (i) kids.push(el('span', { class: 'sep', 'aria-hidden': 'true', text: ' · ' }));
      const toks = toksOf(step.alg);
      const span = el('span', {
        class: 'rc-ph-step' + (P.selStep === i ? ' sel' : ''), role: 'button', tabindex: '0', dataset: { i: String(i) },
        'aria-label': `${stepLabel(step)}: ${step.alg}`, 'aria-pressed': String(P.selStep === i),
      });
      toks.forEach((tk, j) => {
        if (j) span.append(' ');
        const lit = P.padOpen && P.lastMove && i === lastI && j === toks.length - 1;
        span.append(el('span', { class: (isRotation(tk) ? 'rot' : '') + (lit ? ' hl' : ''), text: tk }));
      });
      kids.push(span);
    });
    ph.moves.replaceChildren(...kids, caret);
  }

  const sel = S.steps[P.selStep];
  ph.stepBar.hidden = !sel;
  if (sel) {
    const n = faceCount(sel.alg);
    ph.stepBar.replaceChildren(
      el('span', { class: 'rc-ph-stepname', text: `${stepLabel(sel)} · ${t(n === 1 ? '{n} move' : '{n} moves', { n })}` }),
      el('button', { class: 'rc-ph-stepbtn', type: 'button', html: `${ICON.play}<span></span>`, onclick: () => playStep(P.selStep) }),
      el('button', {
        class: 'rc-ph-stepbtn danger', type: 'button', text: t('Remove'),
        onclick: () => { const i = P.selStep; P.selStep = -1; S.steps.splice(i, 1); commit(); },
      }));
    ph.stepBar.querySelector('.rc-ph-stepbtn span').textContent = t('Play');
  }

  ph.roMove.textContent = lastToken() || '—';
  ph.roNote.hidden = !P.milestone;
  ph.roNote.innerHTML = P.milestone ? ICON.check : '';
  if (P.milestone) ph.roNote.append(P.milestone);
}

function selectStep(i) {
  P.selStep = P.selStep === i ? -1 : i;
  renderPhoneBits();
  if (P.selStep >= 0) playStep(P.selStep);
}

/** Suggestion cards. Tap one to open it; only one is open at a time. */
function paintPhoneSugs(res) {
  ui.sugList.replaceChildren(...res.list.map((s) => {
    const zb = s.kind === 'ZBLL';
    const open = P.openSug === s.alg;
    const card = el('div', { class: 'rc-sug ph' + (zb ? ' zb' : '') + (s.moves === res.best ? ' best' : '') + (open ? ' open' : '') });
    card.append(el('button', {
      class: 'rc-sug-main', type: 'button', 'aria-expanded': String(open), onclick: () => toggleSug(s.alg),
    },
    el('span', { class: 'rc-sug-txt' },
      el('span', { class: 'alg', text: s.alg },
        zb ? el('span', { class: 'rc-zb-tag', text: 'ZBLL', title: t('One alg for the whole last layer') }) : null),
      el('span', { class: 'why', text: `${s.label} · ${s.note}` })),
    el('span', { class: 'len', text: String(s.moves) })));
    if (open) {
      const play = el('button', { class: 'rc-sug-play', type: 'button', html: `${ICON.play}<span></span>`, onclick: () => renderCube(s.alg) });
      play.querySelector('span').textContent = t('Play on cube');
      card.append(el('div', { class: 'rc-sug-acts' }, play,
        el('button', {
          class: 'rc-sug-use', type: 'button',
          text: s.moves === 1 ? t('Use this 1') : t('Use these {n}', { n: s.moves }),
          onclick: () => { P.openSug = null; addStep(s.alg); },
        })));
    }
    // A mouse still previews on hover, as on a desktop. Only a mouse: a tap
    // sends a mousemove of its own, and that is not hovering.
    card.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') hoverPreview(e, card, () => renderCube(s.alg)); });
    card.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hoverEnd(card); });
    return card;
  }));
  ui.sugMore.textContent = res.partial
    ? t('{n} shown — the search stopped early on this one', { n: res.list.length })
    : t('{n} shown · easiest to turn first', { n: res.list.length });
}

function toggleSug(alg) {
  P.openSug = P.openSug === alg ? null : alg;
  if (P.res) paintSugRows(P.res);
  const open = ui.sugList.querySelector('.rc-sug.open');
  open?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------- the pad ---------------- */

function openPad() {
  if (!phoneOn() || S.replay || P.padOpen) return;
  P.padOpen = true;
  P.selStep = -1;
  P.lastMove = '';
  P.milestone = '';
  ph.root.classList.add('pad-open');
  ph.bar.hidden = true;
  // A thumbnail has no room for the little view of the back.
  player?.setAttribute?.('back-view', 'none');
  ph.pad.show();
  ph.field.blur();
  renderPhoneBits();
}

function closePad() {
  if (!P.built || !P.padOpen) return;
  P.padOpen = false;
  P.lastMove = '';
  P.milestone = '';
  ph.root.classList.remove('pad-open');
  ph.pad.hide();
  ph.bar.hidden = false;
  player?.setAttribute?.('back-view', 'top-right');
  renderPhoneBits();
}

/** A move from the pad: it lands, it plays, and the readout says what it did. */
function padMove(tok) {
  const before = rankOf(look());
  addStep(tok, { typed: true });
  const a = look();
  const after = rankOf(a);
  P.lastMove = tok;
  P.milestone = after > before ? milestoneText(after, a) : '';
  renderPhoneBits();
}

/* A keyboard on a phone (a tablet folio, a Bluetooth one) types through the
   pad. Escape steps back one level; a sheet on top handles its own. */
function onPhoneKey(e) {
  if (!reconOpen() || !phoneOn() || sheetOpen()) return;
  const a = document.activeElement;
  if (a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !a.readOnly))) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    phoneBack();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (S.replay) {
    const act = { ' ': () => (P.playing ? player?.pause?.() : player?.play?.()), ArrowLeft: () => stepReplay(-1), ArrowRight: () => stepReplay(1) }[e.key];
    if (act && !e.target.closest?.('button')) { e.preventDefault(); e.stopImmediatePropagation(); act(); }
    return;
  }
  if (!P.padOpen) {
    if (!/^[urfdlbmesxyz]$/i.test(e.key)) return;
    openPad();
  }
  if (ph.pad.handleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
}

/* ---------------- the cube's own buttons ---------------- */

function toggleFlat() {
  P.flat = !P.flat;
  player?.setAttribute?.('visualization', P.flat ? '2D' : '3D');
  if (ph.viewBtn) ph.viewBtn.setAttribute('aria-pressed', String(P.flat));
  ph.viewBtn?.classList.toggle('on', P.flat);
}

/** Rotations: free, because they turn the cube in your hands and not a layer. */
function openTurnSheet() {
  const grid = el('div', { class: 'rc-ph-rotgrid' },
    ...['x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'].map(r => el('button', {
      class: 'rc-ph-rotbtn', type: 'button', text: r, 'aria-label': t('Turn the whole cube: {r}', { r }),
      onclick: () => addStep(r, { typed: true }),
    })));
  openSheet({
    title: t('Turn the cube'), done: true,
    content: [
      el('p', { class: 'rc-ph-note', text: t('Rotations are free: they turn the cube in your hands, not a layer. Drag the cube to look round it.') }),
      grid,
      el('button', {
        class: 'sheet-btn', type: 'button', text: t('Reset the view'),
        onclick: () => { try { player.experimentalModel.twistySceneModel.orbitCoordinatesRequest.set('auto'); } catch { /* old cubing.js */ } },
      }),
    ],
  });
}

/** CFOP or Roux, and the colour you solve from. */
function openOrientSheet() {
  let sheet = null;
  const swatches = (current, pick, disabled = () => false) => el('div', { class: 'rc-ph-swatches' },
    ...CROSS_COLOURS.map(c => el('button', {
      class: 'rc-ph-swatch' + (current === c.face ? ' on' : ''), type: 'button',
      'aria-label': t(`${c.name} cross`), 'aria-pressed': String(current === c.face), disabled: disabled(c.face) || null,
      onclick: () => { pick(c.face); refresh(); },
    }, el('span', { style: { background: c.hex } }))),
    el('button', {
      class: 'rc-ph-swatch auto' + (current === 'auto' ? ' on' : ''), type: 'button', text: t('Auto'),
      'aria-pressed': String(current === 'auto'), onclick: () => { pick('auto'); refresh(); },
    }));
  const content = () => {
    const roux = S.method === 'roux';
    const out = [
      el('div', { class: 'rc-ph-method', role: 'group', 'aria-label': t('Solving method') },
        ...[['cfop', 'CFOP', t('cross · F2L · OLL · PLL')], ['roux', 'Roux', t('blocks · CMLL · LSE')]].map(([m, label, sub]) => el('button', {
          class: 'rc-ph-methodbtn' + (S.method === m ? ' on' : ''), type: 'button', 'aria-pressed': String(S.method === m),
          onclick: () => { setMethod(m); refresh(); },
        }, el('b', { text: label }), el('small', { text: sub })))),
      el('div', { class: 'sheet-label', text: roux ? t('Bottom colour') : t('Cross colour') }),
      swatches(S.prefs[S.method], setCross),
    ];
    if (roux) {
      const bottom = S.prefs.roux;
      out.push(el('div', { class: 'sheet-label', text: t('Front colour') }),
        swatches(S.prefs.rouxFront, setFront, f => bottom === 'auto' || f === bottom || f === OPP[bottom]));
      // The swatches name a cross; for Roux they name a front.
      for (const b of out.at(-1).querySelectorAll('.rc-ph-swatch:not(.auto)')) {
        const name = CROSS_COLOURS[[...b.parentNode.children].indexOf(b)].name;
        b.setAttribute('aria-label', t('{colour} front', { colour: t(name) }));
      }
      for (const b of out[2].querySelectorAll('.rc-ph-swatch:not(.auto)')) {
        const name = CROSS_COLOURS[[...b.parentNode.children].indexOf(b)].name;
        b.setAttribute('aria-label', t('First block with {colour} on the bottom', { colour: t(name) }));
      }
    }
    return out;
  };
  const refresh = () => sheet?.setContent(content());
  sheet = openSheet({ title: t('How you hold it'), done: true, content: content() });
}

/** Copy, share, another solve, another scramble, start again. */
function openMoreSheet() {
  let sheet = null;
  sheet = openSheet({
    title: t('Reconstruction'), done: true,
    content: sheetRows([
      { label: t('Copy the reconstruction'), icon: ICON.copy, disabled: !S.steps.length, onSelect: copyRecon },
      { label: t('Make a share card'), icon: ICON.share, disabled: !S.steps.length, onSelect: shareCard },
      { label: t('Copy the scramble'), sub: S.scramble, icon: ICON.copy, disabled: !S.scramble,
        onSelect: () => copy(S.scramble).then(() => toast(t('Scramble copied'))) },
      { label: t('Reconstruct another solve'), icon: ICON.list, onSelect: openSolvesSheet },
      { label: t('Type or paste a scramble'), icon: ICON.paste, onSelect: openScrambleSheet },
      { label: t('Clear the reconstruction'), icon: ICON.trash, danger: true, disabled: !S.steps.length,
        onSelect: () => { S.steps = []; P.selStep = -1; commit(); toast(t('Reconstruction cleared')); } },
    ], () => sheet),
  });
  for (const sub of sheet.el.querySelectorAll('.sheet-row-sub')) sub.classList.add('mono');
}

function openSolvesSheet() {
  let sheet = null;
  const content = S.library.length
    ? sheetRows(S.library.map(item => ({
      label: item.label, sub: item.scramble, value: item.moves ? t('reconstructed') : '',
      onSelect: () => { resetPhone(); loadFrom(item); },
    })), () => sheet)
    : el('p', { class: 'rc-ph-note', text: t('No solves in this session yet.') });
  sheet = openSheet({ title: t('Reconstruct a solve'), done: true, content });
  for (const sub of sheet.el.querySelectorAll('.sheet-row-sub')) sub.classList.add('mono');
}

function openScrambleSheet() {
  let sheet = null;
  const box = el('textarea', {
    class: 'sheet-field', rows: '3', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters',
    'aria-label': t('Scramble to reconstruct'), placeholder: t('paste any scramble…'),
  });
  box.value = S.scramble;
  box.addEventListener('keydown', e => e.stopPropagation());
  const use = () => {
    if (canonical(String(box.value || '').replace(/\s+/g, ' ').trim()) === null) {
      toast(t('That scramble has a move I cannot read'), { kind: 'bad' });
      return;
    }
    // Let go of the solve first: a new scramble is a new reconstruction, and
    // the empty one it starts with must not be saved over the solve's.
    saveHook = null;
    P.time = null;
    ui.title.textContent = t('Reconstruct');
    resetPhone();
    setScramble(box.value);
    sheet.close();
  };
  sheet = openSheet({
    title: t('Scramble'), done: false,
    content: [
      box,
      el('p', { class: 'rc-ph-note', text: t('A new scramble starts a new reconstruction, not tied to any solve.') }),
      el('button', { class: 'sheet-btn primary', type: 'button', text: t('Use this scramble'), onclick: use }),
    ],
  });
}

function copyRecon() {
  if (!S.steps.length) return toast(t('Nothing to copy yet'));
  copy(reconText()).then(() => toast(t('Reconstruction copied'), { kind: 'good' }));
}

function saveToSolve() {
  if (!saveHook) return;
  saveHook(allMoves());
  toast(t('Saved to the solve'), { kind: 'good' });
}

/* ---------------- replay ----------------
   The whole solve, played on the cube with a scrubber cut into its steps.
   cubing.js does the playing; this follows where it has got to (the
   timeline) and draws the counter, the scrubber and the row about to play.
   A cubing.js that will not say where it is gets its own control bar back
   instead, which is what the desktop uses. */

function watchTimeline() {
  const m = player?.experimentalModel;
  if (!m?.detailedTimelineInfo?.addFreshListener || !m?.indexer?.addFreshListener || !player.controller) return;
  P.timeline = true;
  m.indexer.addFreshListener((ix) => {
    P.ix = ix;
    P.starts = []; P.ends = [];
    try {
      const n = ix.numAnimatedLeaves();
      for (let i = 0; i < n; i++) {
        const s0 = ix.indexToMoveStartTimestamp(i);
        P.starts.push(s0);
        P.ends.push(s0 + ix.moveDuration(i));
      }
    } catch { P.starts = []; P.ends = []; }
    if (S.replay && phoneOn()) paintReplayPos();
  });
  m.detailedTimelineInfo.addFreshListener((info) => {
    P.ts = info?.timestamp ?? 0;
    if (S.replay && phoneOn()) paintReplayPos();
  });
  m.playingInfo?.addFreshListener?.((info) => {
    P.playing = !!info?.playing;
    if (!ph.playBtn) return;
    ph.playBtn.innerHTML = P.playing ? ICON.pause : ICON.play;
    const label = P.playing ? t('Pause') : t('Play');
    ph.playBtn.setAttribute('aria-label', label);
    ph.playBtn.title = label;
  });
}

function setReplay(on) {
  if (on && !S.steps.length) { toast(t('Nothing to replay yet')); return; }
  closePad();
  P.selStep = -1;
  S.replay = on;
  ui.replayBtn.classList.toggle('on', on);
  if (P.built) {
    ph.root.classList.toggle('replaying', on);
    ph.next.hidden = on;
    ph.replay.hidden = !on;
    ph.bar.hidden = on;
    ph.rbar.hidden = !on;
    ph.scroll.scrollTop = 0;
    if (!on) { P.speed = 1; ph.speedBtn.textContent = '1×'; player?.setAttribute?.('tempo-scale', '2.2'); }
  }
  renderCube();
  if (phoneOn()) renderPhone(look());
}

/** The replay's moves cut up: where each step starts, and face turns before each move. */
function buildReplay() {
  const toks = toksOf(canonical(allMoves()) || '');
  const faceBefore = [0];
  for (const tk of toks) faceBefore.push(faceBefore.at(-1) + (isRotation(tk) ? 0 : 1));
  const steps = [];
  let at = 0;
  S.steps.forEach((st, i) => {
    const n = toksOf(st.alg).length;
    const pos = S.positions[i], fr = S.frames[i];
    let kase = null;
    if (pos && (st.phase === 'oll' || st.phase === 'pll')) {
      try { kase = lastLayerCase(pos, fr, analyseAt(pos, fr)); } catch { kase = null; }
    }
    steps.push({ i, from: at, to: at + n, faces: faceCount(st.alg), label: phoneStepLabel(i), kase, alg: st.alg });
    at += n;
  });
  P.R = { toks, faceBefore, steps, total: faceBefore.at(-1) };

  ph.track.replaceChildren(...steps.filter(s => s.faces).map(s =>
    el('span', { class: 'seg', dataset: { i: String(s.i) }, style: { flexGrow: String(s.faces) } })));

  ph.table.replaceChildren(...steps.map(s => el('button', {
    class: 'rc-ph-row', type: 'button', dataset: { i: String(s.i) },
    'aria-label': `${s.label}${s.kase ? ` ${s.kase}` : ''}: ${s.alg}`, onclick: () => seekTok(s.from),
  },
  el('span', { class: 'ph' }, s.label, s.kase ? el('span', { class: 'case', text: s.kase }) : null),
  el('span', { class: 'mv' }, ...toksOf(s.alg).flatMap((tk, j) => [j ? ' ' : '', el('span', { class: isRotation(tk) ? 'rot' : '', text: tk })])),
  el('span', { class: 'n', text: String(s.faces) }))));

  const N = P.R.total;
  const tps = P.time && P.time > 0 ? (N / (P.time / 1000)).toFixed(2) : null;
  ph.stats.textContent = tps
    ? t('{n} moves · {tps} turns a second', { n: N, tps })
    : t(N === 1 ? '{n} move' : '{n} moves', { n: N });
  ph.scrub.setAttribute('aria-valuemax', String(N));
  ph.transport.hidden = !P.timeline;
  ph.scrub.hidden = !P.timeline;
  paintReplayPos();
}

/** Where the playback is: the counter, the thumb, the steps behind it, the row next up. */
function paintReplayPos() {
  const R = P.R;
  if (!R || !ph.thumb) return;
  const n = R.toks.length;
  let done = n, frac = 0;
  if (P.ends.length === n) {
    done = 0;
    while (done < n && P.ends[done] <= P.ts + 0.5) done++;
    if (done < n && P.ts > P.starts[done]) frac = (P.ts - P.starts[done]) / Math.max(1, P.ends[done] - P.starts[done]);
  }
  const faces = R.faceBefore[done];
  const moving = done < n && !isRotation(R.toks[done]) ? frac : 0;
  const pos = R.total ? (faces + moving) / R.total : 0;
  ph.thumb.style.left = `${(pos * 100).toFixed(2)}%`;
  ph.moveChip.textContent = t('move {k} / {n}', { k: faces, n: R.total });
  ph.scrub.setAttribute('aria-valuenow', String(faces));
  ph.scrub.setAttribute('aria-valuetext', t('move {k} of {n}', { k: faces, n: R.total }));
  const next = done < n ? R.steps.find(s => done >= s.from && done < s.to) : null;
  // Each step's segment fills as its moves are played, the one under the thumb partly.
  const played = faces + moving;
  for (const seg of ph.track.children) {
    const s = R.steps[Number(seg.dataset.i)];
    if (!s) continue;
    const before = R.faceBefore[s.from];
    const part = Math.min(1, Math.max(0, (played - before) / s.faces));
    seg.style.setProperty('--fill', `${(part * 100).toFixed(1)}%`);
    seg.classList.toggle('done', s.to <= done);
  }
  for (const row of ph.table.children) row.classList.toggle('now', !!next && Number(row.dataset.i) === next.i);
}

/** Jump to just before move `k` of the replay (rotations included). */
function seekTok(k) {
  if (!player || !P.timeline) return;
  try {
    player.pause();
    player.timestamp = k > 0 ? (P.ends[k - 1] ?? 0) : 0;
  } catch { /* old cubing.js */ }
}

/** The position after `f` face turns, sitting before whatever rotation follows. */
function seekFaces(f) {
  const R = P.R;
  if (!R) return;
  let k = 0;
  if (f > 0) k = R.faceBefore.findIndex((c, i) => i > 0 && c >= f && !isRotation(R.toks[i - 1]));
  seekTok(k < 0 ? R.toks.length : k);
}

function stepReplay(dir) {
  try { player.controller.animationController.play({ direction: dir, untilBoundary: 'move' }); }
  catch { /* old cubing.js */ }
}

function cycleSpeed() {
  const speeds = [1, 2, 0.5];
  P.speed = speeds[(speeds.indexOf(P.speed) + 1) % speeds.length];
  ph.speedBtn.textContent = `${P.speed}×`;
  player?.setAttribute?.('tempo-scale', String(2.2 * P.speed));
}

function wireScrub() {
  let dragging = null;
  const at = (e) => {
    const r = ph.track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    seekFaces(Math.round(f * (P.R?.total || 0)));
  };
  ph.scrub.addEventListener('pointerdown', (e) => {
    dragging = e.pointerId;
    try { ph.scrub.setPointerCapture(e.pointerId); } catch { /* fine */ }
    at(e);
  });
  ph.scrub.addEventListener('pointermove', (e) => { if (dragging === e.pointerId) at(e); });
  const stop = (e) => { if (dragging === e.pointerId) dragging = null; };
  ph.scrub.addEventListener('pointerup', stop);
  ph.scrub.addEventListener('pointercancel', stop);
  ph.scrub.addEventListener('keydown', (e) => {
    const act = { ArrowLeft: () => stepReplay(-1), ArrowRight: () => stepReplay(1), Home: () => player?.jumpToStart?.(), End: () => player?.jumpToEnd?.() }[e.key];
    if (act) { e.preventDefault(); e.stopPropagation(); act(); }
  });
}

/* =========================================================
   Open / close
   ========================================================= */

async function mountPlayer() {
  if (player) return;
  if (!await loadTwisty() || !customElements.get('twisty-player')) {
    ui.stage.append(el('div', { class: 'rc-nocube', text: t('cube preview unavailable') }));
    return;
  }
  player = document.createElement('twisty-player');
  player.setAttribute('puzzle', '3x3x3');
  player.setAttribute('background', 'none');
  player.setAttribute('control-panel', 'none');
  player.setAttribute('hint-facelets', 'floating');
  player.setAttribute('back-view', 'top-right');
  player.setAttribute('visualization', '3D');
  player.setAttribute('tempo-scale', '2.2');
  /* After the letters, which are already in the stage and sit on top of the
     cube by z-index rather than by being later in the document. */
  ui.stage.append(player);
  watchCamera();
  watchTimeline();
}

function setScramble(text) {
  const clean = canonical(String(text || '').replace(/\s+/g, ' ').trim());
  if (clean === null) { toast(t('That scramble has a move I cannot read'), { kind: 'bad' }); return false; }
  S.scramble = clean;
  S.steps = [];
  S.slot = null;
  lastBest = null;
  commit();
  return true;
}

/**
 * Open the workbench.
 *   scramble   the scramble to reconstruct against
 *   title      what to call it — a solve time, usually
 *   moves      a reconstruction already in progress
 *   onSave     called with the move string whenever it changes
 */
export async function openRecon({ scramble = '', title = 'Reconstruct', moves = '', onSave = null, onExit = null, library = [], time = null } = {}) {
  if (!host) { loadCss(); build(); }
  P.time = Number.isFinite(time) ? time : null;
  saveHook = onSave;
  onClose = onExit;
  S.scramble = canonical(String(scramble || '').replace(/\s+/g, ' ').trim()) || '';
  S.steps = explode(S.scramble, moves);
  S.replay = false;
  S.library = library;
  S.slot = null;
  lastBest = null;
  ui.title.textContent = title;
  ui.replayBtn.classList.remove('on');
  ui.pickList.hidden = true;
  resetPhone();
  place();

  host.hidden = false;
  document.body.classList.add('recon-open');
  await mountPlayer();
  commit();
  // Get the worker (and its module graph) loading now, alongside the cube,
  // rather than on the first question asked of it.
  setTimeout(() => { try { getWorker(); } catch { /* ignore */ } }, 0);
  // A phone's keyboard would cover the cube; it types on the pad instead.
  if (!isPhone()) ui.input.focus();
}

export function closeRecon() {
  if (!host || host.hidden) return false;
  if (host.contains(document.activeElement)) document.activeElement.blur();
  closeAllSheets();
  resetPhone();
  host.hidden = true;
  document.body.classList.remove('recon-open');
  onClose?.();
  return true;
}
const close = closeRecon;
