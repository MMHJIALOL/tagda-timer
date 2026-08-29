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
import { SOLVED, applyAlg, analyse, parse, IDENTITY_FRAME, FACES } from './cube3.js';
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
  const href = new URL('../css/recon.css', import.meta.url).href;
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
  crossPref: 'auto',
  library: [],              // recorded solves you can jump straight into
  replay: false,
  thinking: false,
  hint: null,               // suggestion currently being previewed
};

const PHASE_LABEL = { cross: 'Cross', f2l: 'F2L', oll: 'OLL', pll: 'PLL', done: 'Solved' };

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

function render() {
  const a = look();
  const moves = allMoves();
  const count = moves ? moves.split(/\s+/).filter(t => !/^[xyz]/i.test(t)).length : 0;

  ui.scrambleBox.value = S.scramble;
  ui.count.textContent = `${count} move${count === 1 ? '' : 's'} so far`;

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
      el('button', { class: 'rc-x', title: 'Remove this step', text: '×', onclick: () => { S.steps.splice(i, 1); commit(); } }),
    );
    row.addEventListener('mouseenter', () => previewUpTo(i));
    row.addEventListener('mouseleave', () => renderCube());
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

/** Show the cube as it stood before step `i` ran, then run that step. */
function previewUpTo(i) {
  if (!player || S.replay) return;
  const before = [S.scramble, S.steps.slice(0, i).map(s => s.alg).join(' ')].filter(Boolean).join(' ');
  try {
    player.setAttribute('experimental-setup-alg', before);
    player.setAttribute('alg', S.steps[i].alg);
    player.jumpToStart?.(); player.play?.();
  } catch { /* ignore */ }
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
    row.addEventListener('mouseenter', () => renderCube(s.alg));
    row.addEventListener('mouseleave', () => renderCube());
    row.addEventListener('click', () => addStep(s.alg));
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
        class: 'ghost-btn sm', title: 'Copy the reconstruction',
        onclick: () => {
          if (!S.steps.length) return toast('Nothing to copy yet');
          copy(`${S.scramble}\n\n${S.steps.map(s => `${PHASE_LABEL[s.phase]}: ${s.alg}`).join('\n')}`)
            .then(() => toast('Reconstruction copied'));
        },
        html: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
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

  const left = el('section', { class: 'panel rc-left' },
    el('div', { class: 'panel-head' },
      el('span', { text: 'Position' }),
      ui.count = el('span', { class: 'panel-sub', text: '0 moves so far' })),
    ui.stage,
    el('div', { class: 'rc-cube-tools' },
      ui.replayBtn,
      el('span', { class: 'rc-cross-pick' },
        el('span', { text: 'cross' }),
        ui.crossSel = el('select', { class: 'rc-sel', onchange: () => { S.crossPref = ui.crossSel.value; render(); } },
          el('option', { value: 'auto', text: 'auto' }),
          ...FACES.map(f => el('option', { value: f, text: f })))),
    ),
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
  // Clicking anywhere else puts the solve list away, the way a menu should.
  host.addEventListener('click', (e) => {
    if (!ui.pickList.hidden && !ui.pick.contains(e.target)) ui.pickList.hidden = true;
  });
  document.body.append(host);
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
  S.crossPref = 'auto';
  ui.crossSel.value = 'auto';
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
  player.setAttribute('tempo-scale', '1.8');
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
  S.crossPref = 'auto';
  S.library = library;
  lastBest = null;
  ui.title.textContent = title;
  ui.replayBtn.classList.remove('on');
  ui.crossSel.value = 'auto';
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
