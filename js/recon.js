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
import { SOLVED, applyAlg, analyse, parse, IDENTITY_FRAME } from './cube3.js';
import { suggest, warm } from './solver.js';
import { toast } from './toast.js';

/* twisty-player, loaded the same way the scramble preview loads it. */
const SOURCES = [
  new URL('../vendor/cubing/cubing/twisty.js', import.meta.url).href,
  'https://cdn.cubing.net/v0/js/cubing/twisty',
];
/* The panel's own stylesheet, fetched on the first open for the same reason
   the module is: most sessions never come in here. */
function loadCss() {
  // The version query matters on Vercel, where /css/* is served immutable for
  // a year — see vercel.json. Bump it with the ones in index.html.
  const href = `${new URL('../css/recon.css', import.meta.url).href}?v=33`;
  if (document.querySelector(`link[data-recon]`)) return;
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
  crossPref: 'U',           // white, which is where most people start
  library: [],              // recorded solves you can jump straight into
  replay: false,
  thinking: false,
  hint: null,               // suggestion currently being previewed
};

const PHASE_LABEL = { cross: 'Cross', f2l: 'F2L', oll: 'OLL', pll: 'PLL', done: 'Solved' };

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

/** Rebuild every intermediate position from the scramble forwards. */
function recompute() {
  const start = applyAlg(SOLVED, S.scramble, IDENTITY_FRAME);
  if (!start) { S.positions = []; S.frames = []; return false; }
  S.positions = [start.state];
  S.frames = [start.frame];
  const pref = S.crossPref === 'auto' ? null : S.crossPref;
  for (const step of S.steps) {
    const prev = S.positions.at(-1), pf = S.frames.at(-1);
    // A step is named for the phase it was working on, not the one it left you
    // in — the move that finishes the cross belongs under "Cross".
    const a = analyse(prev, pref);
    step.phase = a.phase;
    step.rank = rankOf(a);
    const next = applyAlg(prev, step.alg, pf);
    if (!next) break;
    S.positions.push(next.state);
    S.frames.push(next.frame);
  }
  return true;
}

/**
 * How far through a CFOP solve a position is, as one increasing number:
 * 0 before the cross, 1-4 as the pairs go in, 5 once F2L is whole, 6 once the
 * last layer is oriented, 7 when it is finished. Steps break where this goes
 * up, which is what stops a pair insertion that momentarily disturbs the cross
 * from being filed under "Cross".
 */
function rankOf(a) {
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
  if (!start) return [{ alg: list.join(' '), phase: 'cross', typed: true }];
  let state = start.state, frame = start.frame;
  const steps = [];
  for (const tok of list) {
    const a = analyse(state);
    const rank = rankOf(a);
    const last = steps.at(-1);
    if (last && rank <= last.rank) last.alg += ` ${tok}`;
    else steps.push({ alg: tok, phase: a.phase, rank, typed: true });
    const next = applyAlg(state, tok, frame);
    if (!next) break;
    state = next.state; frame = next.frame;
  }
  return steps;
}

const currentState = () => S.positions.at(-1);
const currentFrame = () => S.frames.at(-1);
const allMoves = () => S.steps.map(s => s.alg).join(' ').trim();

/** Analysis of where we are, honouring a hand-picked cross colour. */
const look = () => analyse(currentState(), S.crossPref === 'auto' ? null : S.crossPref);

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
let hoverLocked = false;

function hoverPreview(alg) {
  if (hoverLocked) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => renderCube(alg), 140);
}

function hoverEnd() {
  clearTimeout(hoverTimer);
  if (!hoverLocked) renderCube();
}

/** Hold hover off until the pointer moves of its own accord. */
function lockHover() {
  clearTimeout(hoverTimer);
  hoverLocked = true;
}

/** Pick the cross colour by hand. Everything downstream is asked about it. */
function setCross(face) {
  S.crossPref = face;
  lastBest = null;
  commit();
}

function paintCrossPicker() {
  for (const b of ui.crossSwatches.children) {
    b.classList.toggle('on', b.dataset.face === S.crossPref);
  }
}

function render() {
  const a = look();
  const count = moveCount();

  ui.scrambleBox.value = S.scramble;
  ui.count.textContent = `${count} move${count === 1 ? '' : 's'} so far`;

  paintCrossPicker();
  renderSteps(a);
  renderStrip(a);
  renderCube();
  renderSuggestions(a);
}

function renderSteps(a) {
  ui.steps.innerHTML = '';
  if (!S.steps.length) {
    ui.steps.append(el('div', { class: 'rc-empty', text: 'Nothing yet. Pick a move on the right, or type one.' }));
  }
  S.steps.forEach((step, i) => {
    const row = el('div', { class: 'rc-step' },
      el('span', { class: 'ph', text: PHASE_LABEL[step.phase] || '' }),
      el('span', { class: 'mv', text: step.alg }),
      el('span', { class: 'n', text: String(step.alg.split(/\s+/).filter(t => !/^[xyz]/i.test(t)).length) }),
      el('button', { class: 'rc-x', title: 'Remove this step', text: '×', onclick: (e) => { e.stopPropagation(); lockHover(); S.steps.splice(i, 1); commit(); } }),
    );
    row.addEventListener('mouseenter', () => playSoon(i));
    row.addEventListener('mouseleave', hoverEnd);
    ui.steps.append(row);
  });
  ui.steps.append(el('div', { class: 'rc-step current' },
    el('span', { class: 'ph', text: PHASE_LABEL[a.phase] }),
    el('span', { class: 'mv', text: a.phase === 'done' ? 'solved' : 'you are here' }),
    el('span', { class: 'n', text: '·' })));
}

function renderStrip(a) {
  ui.strip.innerHTML = '';
  const order = ['cross', 'f2l1', 'f2l2', 'f2l3', 'f2l4', 'oll', 'pll'];
  const doneSlots = a.slots ? a.slots.filter(s => s.done).length : 0;
  const reached = { cross: a.cross, f2l1: doneSlots >= 1, f2l2: doneSlots >= 2, f2l3: doneSlots >= 3, f2l4: a.f2l, oll: a.oll, pll: a.solved };
  let markedNow = false;
  for (const k of order) {
    const done = reached[k];
    const now = !done && !markedNow;
    if (now) markedNow = true;
    ui.strip.append(el('div', { class: done ? 'done' : now ? 'now' : '' }));
  }
}

function renderCube(alg = '') {
  if (!player) return;
  const setup = [S.scramble, allMoves()].filter(Boolean).join(' ');
  try {
    if (S.replay) {
      player.setAttribute('experimental-setup-alg', S.scramble);
      player.setAttribute('alg', allMoves());
      player.setAttribute('control-panel', 'bottom-row');
      return;
    }
    player.setAttribute('control-panel', 'none');
    player.setAttribute('experimental-setup-alg', setup);
    player.setAttribute('alg', alg);
    if (alg) { player.jumpToStart?.(); player.play?.(); }
  } catch (err) { console.warn('[recon] player', err); }
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
  try {
    player.setAttribute('experimental-setup-alg', before);
    player.setAttribute('alg', alg);
    player.jumpToStart?.();
    player.play?.();
  } catch { /* ignore */ }
}

/** Replay one step of the reconstruction, after the same settling delay. */
function playSoon(i) {
  if (hoverLocked) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => playStep(i), 140);
}

function renderSuggestions(a) {
  ui.sugList.innerHTML = '';
  ui.phaseTag.textContent = PHASE_LABEL[a.phase];

  if (a.phase === 'done') {
    ui.dist.className = 'rc-dist';
    ui.dist.innerHTML = '';
    ui.dist.append(el('span', { class: 'n', text: '✓' }), el('span', { class: 'lbl', text: 'the cube is solved — nice reconstruction' }));
    ui.sugMore.textContent = '';
    return;
  }

  ui.dist.innerHTML = '';
  ui.dist.append(el('span', { class: 'n', text: '…' }), el('span', { class: 'lbl', text: 'looking for the shortest way on' }));
  ui.sugList.append(el('div', { class: 'rc-empty', text: 'thinking…' }));

  /* Let the "thinking" paint land before the search blocks the thread. A timer
     rather than an animation frame: a backgrounded tab stops handing those out,
     and the panel would sit on "thinking…" for as long as you looked away.
     The token drops any result that a newer click has already outrun. */
  const ticket = ++pending;
  setTimeout(() => {
    if (ticket !== pending) return;
    let res;
    try { res = suggest(currentState(), currentFrame(), a, { limit: 20 }); }
    catch (err) { console.warn('[recon] solver', err); res = { list: [], best: -1 }; }
    if (ticket === pending) paintSuggestions(res, a);
  }, 16);
}

let pending = 0;

let lastBest = null;

function paintSuggestions(res, a) {
  ui.sugList.innerHTML = '';
  const worse = lastBest !== null && res.best > lastBest;
  lastBest = res.best;

  ui.dist.className = 'rc-dist' + (worse ? ' worse' : '');
  ui.dist.innerHTML = '';
  if (res.best < 0) {
    ui.dist.append(el('span', { class: 'n', text: '?' }),
      el('span', { class: 'lbl', text: 'nothing found within reach — type a move and carry on' }));
  } else {
    const what = a.phase === 'cross' ? 'to finish the cross'
      : a.phase === 'f2l' ? 'to insert the easiest pair'
      : a.phase === 'oll' ? 'to orient the last layer'
      : 'to finish the solve';
    ui.dist.append(el('span', { class: 'n', text: String(res.best) }),
      el('span', { class: 'lbl', text: `${res.best === 1 ? 'move' : 'moves'} ${what}`
        + (worse ? ' — that last move cost you' : '') }));
  }

  if (!res.list.length) {
    ui.sugList.append(el('div', { class: 'rc-empty', text: 'No suggestion for this position. Type your own move.' }));
    ui.sugMore.textContent = '';
    return;
  }

  for (const s of res.list) {
    const row = el('div', { class: 'rc-sug' + (s.moves === res.best ? ' top' : '') },
      el('span', {},
        el('span', { class: 'alg', text: s.alg }),
        el('span', { class: 'why', text: `${s.label} · ${s.note}` })),
      el('span', { class: 'len', text: String(s.moves) }),
    );
    row.addEventListener('mouseenter', () => hoverPreview(s.alg));
    row.addEventListener('mouseleave', hoverEnd);
    row.addEventListener('click', () => { lockHover(); addStep(s.alg); });
    ui.sugList.append(row);
  }
  ui.sugMore.textContent = res.partial
    ? `${res.list.length} shown — the search stopped early on this one`
    : `${res.list.length} shown · sorted by moves, then by how they turn`;
}

/* =========================================================
   Editing
   ========================================================= */

/**
 * Add moves to the reconstruction.
 * Moves you type run together into one line for as long as you stay in the
 * same phase - typing R U2 F' should read as a step, not as three. A clicked
 * suggestion always starts its own line, because that is how you thought of it.
 */
function addStep(alg, { typed = false } = {}) {
  const clean = String(alg || '').trim();
  if (!clean) return;
  if (!parse(clean)) { toast("Could not read that - try moves like R U2 F'", { kind: 'bad' }); return; }
  const last = S.steps.at(-1);
  const a = look();
  const rank = rankOf(a);
  if (typed && last?.typed && rank <= last.rank) last.alg = `${last.alg} ${clean}`;
  else S.steps.push({ alg: clean, phase: a.phase, rank, typed });
  commit();
  // Watch it happen. Snapping to the answer told you nothing about the moves,
  // which is the whole reason the cube is on screen.
  lockHover();
  playStep(S.steps.length - 1, typed ? clean : null);
}

/** The reconstruction as text, the way people write them out. */
export function reconText() {
  const lines = S.steps.map(st => `${PHASE_LABEL[st.phase] || ''}: ${st.alg}`);
  const total = moveCount();
  return [S.scramble, '', ...lines, '', `${total} moves`].join('\n');
}

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
    'aria-label': 'Scramble to reconstruct', placeholder: 'paste any scramble…',
  });
  ui.scrambleBox.addEventListener('keydown', e => e.stopPropagation());
  ui.scrambleBox.addEventListener('change', () => setScramble(ui.scrambleBox.value));

  const top = el('div', { class: 'rc-top' },
    el('button', {
      class: 'ghost-btn sm', onclick: () => close(),
      html: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg> back to timer',
    }),
    el('div', { class: 'rc-scr' },
      el('span', { class: 'rc-scr-lbl', text: 'scramble' }),
      ui.scrambleBox,
      el('button', {
        class: 'ghost-btn sm', title: 'Copy the scramble',
        onclick: () => copy(S.scramble).then(() => toast('Scramble copied')),
        html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
      }),
      el('button', {
        class: 'ghost-btn sm', title: 'Copy the reconstruction as text',
        onclick: () => {
          if (!S.steps.length) return toast('Nothing to copy yet');
          copy(reconText()).then(() => toast('Reconstruction copied', { kind: 'good' }));
        },
        html: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
      }),
      el('button', {
        class: 'ghost-btn sm', title: 'Make a share card of this reconstruction',
        onclick: shareCard,
        html: '<svg viewBox="0 0 24 24"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M12 3v13M8 7l4-4 4 4"/></svg>',
      }),
    ),
    ui.pick = el('div', { class: 'rc-pick' },
      ui.pickBtn = el('button', {
        class: 'ghost-btn sm', onclick: togglePicker,
        html: 'from a solve <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
      }),
      ui.pickList = el('div', { class: 'rc-picklist', hidden: true })),
    el('div', { class: 'rc-title' }, ui.title = el('span', { text: 'Reconstruct' })),
  );

  /* ---- left: the cube ---- */
  ui.stage = el('div', { class: 'rc-cube' });
  ui.strip = el('div', { class: 'rc-strip' });

  ui.replayBtn = el('button', {
    class: 'ghost-btn sm', text: 'replay the whole solve',
    onclick: () => { S.replay = !S.replay; ui.replayBtn.classList.toggle('on', S.replay); renderCube(); },
  });

  /* Rotations. Most people reconstruct with the cross on the bottom, which
     means the first thing they want is to turn the cube over — and every
     suggestion after that comes back in the orientation they are holding.
     They cost nothing: a rotation is not a move, and the counter ignores it. */
  ui.rots = el('div', { class: 'rc-rots' },
    el('span', { class: 'rc-rots-lbl', text: 'turn' }),
    ...['x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'].map(r =>
      el('button', {
        class: 'rc-rot', text: r, title: `Turn the whole cube: ${r}`,
        onclick: () => { lockHover(); addStep(r, { typed: true }); },
      })),
  );

  const left = el('section', { class: 'panel rc-left' },
    el('div', { class: 'panel-head' },
      el('span', { text: 'Position' }),
      ui.count = el('span', { class: 'panel-sub', text: '0 moves so far' })),
    ui.stage,
    el('div', { class: 'rc-cube-tools' },
      ui.replayBtn,
      el('span', { class: 'rc-cross-pick' },
        el('span', { text: 'cross' }),
        ui.crossSwatches = el('span', { class: 'rc-swatches' },
          ...CROSS_COLOURS.map(c => el('button', {
            class: 'rc-swatch', title: `${c.name} cross`, 'aria-label': `${c.name} cross`,
            dataset: { face: c.face }, style: { background: c.hex },
            onclick: () => setCross(c.face),
          })),
          el('button', {
            class: 'rc-swatch auto', title: 'Work out the cross colour from the cube',
            dataset: { face: 'auto' }, text: 'auto', onclick: () => setCross('auto'),
          })),
      ),
    ),
    ui.rots,
    ui.strip,
    el('div', { class: 'rc-strip-legend' },
      ...['cross', 'f2l 1', 'f2l 2', 'f2l 3', 'f2l 4', 'oll', 'pll'].map(t => el('span', { text: t }))),
  );

  /* ---- right: the reconstruction and what comes next ---- */
  ui.steps = el('div', { class: 'rc-steps' });
  ui.dist = el('div', { class: 'rc-dist' });
  ui.sugList = el('div', { class: 'rc-sugs' });
  ui.sugMore = el('div', { class: 'rc-more' });
  ui.input = el('input', {
    class: 'rc-inp mono', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'type a move…', 'aria-label': 'Add moves',
  });
  const flushInput = wireInput(ui.input);

  const right = el('aside', { class: 'rc-right' },
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { text: 'Reconstruction' }),
        el('span', { class: 'rc-head-tools' },
          el('button', { class: 'ghost-btn sm', text: 'undo', onclick: undo }),
          el('button', { class: 'ghost-btn sm danger', text: 'clear', onclick: () => { S.steps = []; commit(); } }))),
      ui.steps),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { text: "What's next" }),
        ui.phaseTag = el('span', { class: 'panel-sub', text: 'cross' })),
      ui.dist, ui.sugList, ui.sugMore,
      el('div', { class: 'rc-entry' }, ui.input,
        el('button', { class: 'btn primary', text: 'add', onclick: () => flushInput() })),
      el('p', { class: 'rc-hint', text:
        'Types in caps and adds as you go — finish a move, press space. Not in the list? '
        + 'Type it anyway; the suggestions rebuild from wherever you land. Wide turns are RW, LW, UW.' }),
    ),
  );

  host.append(top, el('div', { class: 'rc-body' }, left, right));
  // A pointer that has actually moved is a pointer that meant to hover.
  host.addEventListener('mousemove', () => { hoverLocked = false; }, true);
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
  for (const st of S.steps) {
    const phase = PHASE_LABEL[st.phase] || '';
    const last = out.at(-1);
    if (last && last.phase === phase) last.alg = `${last.alg} ${st.alg}`;
    else out.push({ phase, alg: st.alg });
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
  if (!S.steps.length) { toast('Reconstruct something first'); return; }
  try {
    const m = await import('./sharedlg.js');
    await m.shareRecon({
      scramble: S.scramble,
      title: ui.title.textContent,
      steps: cardSteps(),
      moves: moveCount(),
    });
  } catch (err) {
    console.warn('[recon] share', err);
    toast('Could not open the share sheet', { kind: 'bad' });
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
    ui.pickList.append(el('div', { class: 'rc-empty', text: 'No solves in this session yet.' }));
    return;
  }
  for (const item of S.library) {
    ui.pickList.append(el('button', { class: 'rc-pickrow', onclick: () => { ui.pickList.hidden = true; loadFrom(item); } },
      el('b', { text: item.label }),
      el('span', { text: item.scramble }),
      item.moves ? el('i', { text: 'has a reconstruction' }) : null));
  }
}

function loadFrom(item) {
  S.scramble = String(item.scramble || '').replace(/\s+/g, ' ').trim();
  S.steps = explode(S.scramble, item.moves);
  saveHook = item.save || null;
  ui.title.textContent = item.label;
  lastBest = null;
  commit();
}

/* =========================================================
   Open / close
   ========================================================= */

async function mountPlayer() {
  if (player) return;
  if (!await loadTwisty() || !customElements.get('twisty-player')) {
    ui.stage.append(el('div', { class: 'rc-nocube', text: 'cube preview unavailable' }));
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
  ui.stage.append(player);
}

function setScramble(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean && !parse(clean)) { toast('That scramble has a move I cannot read', { kind: 'bad' }); return false; }
  S.scramble = clean;
  S.steps = [];
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
export async function openRecon({ scramble = '', title = 'Reconstruct', moves = '', onSave = null, onExit = null, library = [] } = {}) {
  if (!host) { loadCss(); build(); }
  saveHook = onSave;
  onClose = onExit;
  S.scramble = String(scramble || '').replace(/\s+/g, ' ').trim();
  S.steps = explode(S.scramble, moves);
  S.replay = false;
  S.library = library;
  lastBest = null;
  ui.title.textContent = title;
  ui.replayBtn.classList.remove('on');
  ui.pickList.hidden = true;

  host.hidden = false;
  document.body.classList.add('recon-open');
  await mountPlayer();
  commit();
  // The cross table for D is the one almost every reconstruction wants.
  setTimeout(() => { try { warm('D'); } catch { /* ignore */ } }, 0);
  ui.input.focus();
}

export function closeRecon() {
  if (!host || host.hidden) return false;
  if (host.contains(document.activeElement)) document.activeElement.blur();
  host.hidden = true;
  document.body.classList.remove('recon-open');
  onClose?.();
  return true;
}
const close = closeRecon;
