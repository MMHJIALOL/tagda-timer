/* ===========================================================
   Tagda Timer — algorithm library page (algs.html).

   Pick a puzzle, pick a set, and every case is a card you recognise by
   its picture. A card has two halves with two jobs, kept physically apart
   so one is never hit when you meant the other:

     top      the picture. Click to select the case for training;
              Shift-click selects everything between it and the case you
              clicked before, the way a file list does.
     bottom   the first algorithm and how many there are. Click to open
              the case: every algorithm, your order, your own.

   Deliberately its own page rather than a panel: this is a thing you
   browse at leisure, not a thing you touch every solve.
   =========================================================== */

import { $, el, copy } from './util.js';
import { SCHEME, stickerAt } from './cubenet.js';
import { loadSettings, saveSettings, applyTheme } from './theme.js';
import { mountMetro } from './metro.js';
import { toast } from './toast.js';
import {
  SETS, ALG_EVENTS, SET_LABELS, eventEntry, loadSet, caseOf, caseFacelets, caseSvg, displayOrder,
  loadLibraryPrefs, saveOrder, resetOrder, hasCustomOrder, addCustom, removeCustom, countFor,
} from './alglibrary.js';
import { setupFor } from './alglibrary-setup.js';

/* ---------------------------------------------------------
   Case pictures
   --------------------------------------------------------- */

/* A sticker that is not part of the case. On an orientation diagram it is half
   the information, so it is a mid grey rather than a near-black. */
const UNORIENTED = '#3b3b4e';

/* Yellow on top, because by the last layer that is the face you are looking
   at. The simulator keeps white on U, so the picture recolours by `z2` — U
   swaps with D and L with R — which draws exactly what rotating the cube
   would, without moving the case off the face the drawing code reads. */
const Z2 = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'F', B: 'B' };
const LL_SCHEME = Object.fromEntries(Object.keys(SCHEME).map(face => [face, SCHEME[Z2[face]]]));

function sizeCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const size = canvas.clientWidth || 104;
  canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);
  return { ctx, size };
}

/**
 * The standard last-layer picture — the U face plus the top row of each side
 * — or, for sets drawn in three-quarter view, the cube from up-front-right.
 * The strips are read straight out of the simulator's facelets, so nothing
 * here has to know what any particular case looks like. A grey 'X' sticker is
 * one the set's diagram leaves out.
 */
function drawCase(canvas, setId, caseId) {
  const f = caseFacelets(setId, caseId);
  if (!f) return;
  const { ctx, size } = sizeCanvas(canvas);
  const set = SETS[setId] || {};
  if (set.picture === 'f2l') return drawIso(ctx, f, size, f2lLit(f));
  if (set.picture === '3d') return drawIso(ctx, f, size, () => true);

  const n = set.n || 3;
  const cell = size / (n + 1.2);
  const t = cell * 0.42, g = cell * 0.11;
  const span = n * cell + 2 * (t + g);
  const ox = (size - span) / 2, oy = (size - span) / 2;
  const gx = ox + t + g, gy = oy + t + g;

  const orient = set.picture === 'orientation';
  const paint = (s) => (orient ? (s === 'U' ? LL_SCHEME.U : UNORIENTED) : LL_SCHEME[s] || UNORIENTED);
  const box = (x, y, w, h, s) => {
    ctx.fillStyle = paint(s);
    ctx.beginPath();
    const r = Math.min(w, h) * 0.22;
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.fill();
  };

  const pad = cell * 0.06;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      box(gx + c * cell + pad, gy + r * cell + pad, cell - 2 * pad, cell - 2 * pad, f.U[r][c]);
    }
  }
  /* Winding, from the face geometry in cubenet.js: F and L run the same way
     as the U face they touch, B and R against it. Get one backwards and every
     case is silently mirrored. */
  const B = f.B[0].slice().reverse();
  const R = f.R[0].slice().reverse();
  for (let i = 0; i < n; i++) {
    box(gx + i * cell + pad, oy,                  cell - 2 * pad, t, B[i]);
    box(gx + i * cell + pad, oy + span - t,       cell - 2 * pad, t, f.F[0][i]);
    box(ox,                  gy + i * cell + pad, t, cell - 2 * pad, f.L[0][i]);
    box(ox + span - t,       gy + i * cell + pad, t, cell - 2 * pad, R[i]);
  }
}

/* A piece that is not part of a three-quarter-view case: dark, because there
   it is the background two pieces have to stand out against. */
const ISO_IGNORED = '#2e2e3c';

/**
 * Which stickers an F2L picture colours in: the corner and edge of the pair,
 * wherever they are, and the two layers already built. Leaving the built
 * layers solid is what makes the empty slot read as a notch — the target.
 * Pieces are found by colour, and "home" is per piece, not per sticker, so a
 * displaced corner that happens to show the right colour on one face still
 * leaves the slot looking empty.
 */
function f2lLit(f) {
  const isTarget = (colours) => {
    const k = [...colours].sort().join('');
    return k === 'DFR' || k === 'FR';
  };
  const pieces = new Map();
  for (const face of ['U', 'R', 'F', 'D', 'L', 'B']) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const { cubie } = stickerAt(face, r, c, 3);
        if (!pieces.has(cubie)) pieces.set(cubie, { colours: new Set(), home: true });
        const p = pieces.get(cubie);
        p.colours.add(f[face][r][c]);
        if (f[face][r][c] !== face) p.home = false;
      }
    }
  }
  return (cubie) => {
    const piece = pieces.get(cubie);
    return (Number(cubie.split(',')[1]) <= 0 && piece.home) || isTarget(piece.colours);
  };
}

/** The cube in isometric three-quarter view: U, F and R. */
function drawIso(ctx, f, size, lit) {
  const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6);
  const project = ([x, y, z]) => [(x - z) * COS, (x + z) * SIN - y];
  const halfW = 3 * COS, halfH = 1.5 + 3 * SIN;
  const scale = Math.min(size / (2 * halfW), size / (2 * halfH)) * 0.96;
  const to2d = (p) => {
    const [px, py] = project(p);
    return [size / 2 + px * scale, size / 2 + py * scale];
  };

  const INSET = 0.44;   // < 0.5 leaves the grout line between stickers
  for (const face of ['U', 'F', 'R']) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const { pos, right, down, cubie } = stickerAt(face, r, c, 3);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
          to2d(pos.map((v, i) => v + a * INSET * right[i] + b * INSET * down[i])));
        ctx.beginPath();
        ctx.moveTo(corners[0][0], corners[0][1]);
        for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y);
        ctx.closePath();
        const s = f[face][r][c];
        ctx.fillStyle = s !== 'X' && lit(cubie) ? (LL_SCHEME[s] || ISO_IGNORED) : ISO_IGNORED;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.lineWidth = Math.max(1, size * 0.012);
        ctx.stroke();
      }
    }
  }
}

/* Canvases are drawn once they are in the document and have a size. Drawn in
   one pass after the whole grid is built — one layout, and no dependence on
   animation frames, which a background tab does not run. */
let pendingDraws = [];
const flushDraws = () => {
  const todo = pendingDraws;
  pendingDraws = [];
  for (const canvas of todo) drawCase(canvas, canvas.dataset.set, canvas.dataset.case);
};

/** The picture of a case: a canvas for a cube, SVG for everything else. */
function caseArt(set, caseId, big = false) {
  if (set.puzzle && set.puzzle !== 'cube') {
    return el('span', {
      class: `case-art svg ${set.puzzle}${big ? ' big' : ''}`,
      'aria-hidden': 'true',
      html: caseSvg(set.id, caseId) || '',
    });
  }
  const canvas = el('canvas', { class: `case-art${big ? ' big' : ''}`, 'aria-hidden': 'true', dataset: { set: set.id, case: caseId } });
  pendingDraws.push(canvas);
  return canvas;
}

const icon = (d) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
};

/* ---------------------------------------------------------
   Sortable list
   --------------------------------------------------------- */

/**
 * Reorder-within-a-list by pointer drag on the grip. The row snaps into a slot
 * and the list is what changes; listening on the window means a drag that
 * leaves the list still ends cleanly.
 */
function sortable(list, onDrop) {
  let row = null, rows = [], startY = 0, before = null;

  const rowsNow = () => [...list.querySelectorAll('.alg-row')];
  const order = () => rowsNow().map(r => r.dataset.alg);

  const onMove = (ev) => {
    if (!row) return;
    row.style.transform = `translateY(${ev.clientY - startY}px)`;
    const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
    for (const other of rows) {
      if (other === row) continue;
      const r = other.getBoundingClientRect();
      if (mid <= r.top || mid >= r.bottom) continue;
      const rowIsAfter = !!(other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
      row.style.transform = '';
      list.insertBefore(row, rowIsAfter ? other : other.nextSibling);
      startY = ev.clientY;
      rows = rowsNow();
      break;
    }
  };

  const end = () => {
    if (!row) return;
    row.style.transform = '';
    row.classList.remove('dragging');
    list.classList.remove('dragging');
    row = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    const now = order();
    if (now.join('|') !== before.join('|')) onDrop(now);
  };

  list.addEventListener('pointerdown', (ev) => {
    const handle = ev.target.closest('.alg-grip');
    if (!handle || ev.button) return;
    row = handle.closest('.alg-row');
    rows = rowsNow();
    before = order();
    startY = ev.clientY;
    row.classList.add('dragging');
    list.classList.add('dragging');
    ev.preventDefault();
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  });
}

/* ---------------------------------------------------------
   State
   --------------------------------------------------------- */

const state = { event: '333', set: 'PLL', q: '', group: null };

/* Selections per set, kept while you move between sets and events — clicking
   over to look at PLL must not throw away the twelve OLLs you picked. */
const selections = new Map();
const picks = () => {
  if (!selections.has(state.set)) selections.set(state.set, new Set());
  return selections.get(state.set);
};

/* The case a Shift-click range starts from, and the cases on screen in order —
   a range covers what you can see, not cases a filter is hiding. */
let anchor = null;
let shownIds = [];

const eventSets = (id) => eventEntry(id)?.sets || [];

/* Where you are is in the address bar, so a set is a link you can send someone
   and a reload puts you back where you were. */
function readUrl() {
  const p = new URLSearchParams(location.search);
  if (eventEntry(p.get('event'))) state.event = p.get('event');
  const set = p.get('set');
  state.set = set && eventSets(state.event).includes(set) ? set : eventSets(state.event)[0];
}

function writeUrl() {
  const p = new URLSearchParams({ event: state.event, set: state.set });
  history.replaceState(null, '', `${location.pathname}?${p}`);
}

/* A search that matched every ZBLL case would paint 472 pictures. Past this
   the query needs narrowing, not the page scrolling. */
const MAX_CARDS = 96;

function matches(c, set, q) {
  const hay = `${set.caseLabel(c)} ${c.name} ${c.id} ${c.group || ''} ${set.describe(c)}`.toLowerCase();
  return hay.includes(q);
}

/* A search reaches across the whole set; the subset picker only narrows when
   there is no search. Otherwise typing a case's own name would say it does not
   exist because a different subset was picked. */
function visibleCases(set) {
  const q = state.q.trim().toLowerCase();
  if (q) return set.cases.filter(c => matches(c, set, q));
  return set.cases.filter(c => !state.group || set.groupOf?.(c) === state.group);
}

/* ---------------------------------------------------------
   Grid
   --------------------------------------------------------- */

function renderGroups(set) {
  const host = $('#alglib-groups');
  host.textContent = '';
  const groups = set.groups || [];
  if (!groups.length) { host.hidden = true; return; }
  host.hidden = false;

  const options = [...(set.defaultGroup === null ? [[null, 'All']] : []), ...groups.map(g => [g, g])];
  /* OLLCP has 57 subsets. A row of 57 chips is a wall; a dropdown is not. */
  if (options.length > 12) {
    const select = el('select', { class: 'group-select', 'aria-label': 'Subset' });
    for (const [value, label] of options) select.appendChild(el('option', { value: value ?? '', text: label }));
    select.value = state.group ?? '';
    select.addEventListener('change', () => { state.group = select.value || null; renderGrid(); });
    host.appendChild(select);
    return;
  }
  for (const [value, label] of options) {
    const b = el('button', { class: `group-chip${state.group === value ? ' on' : ''}`, type: 'button', text: label });
    b.addEventListener('click', () => { state.group = value; renderGrid(); });
    host.appendChild(b);
  }
}

function renderGrid() {
  const host = $('#alglib-grid');
  host.textContent = '';
  host.hidden = false;
  $('#alglib-detail').hidden = true;
  $('#alglib-bar').hidden = false;

  const set = SETS[state.set];
  if (!set) return;
  renderGroups(set);

  const list = visibleCases(set);
  const shown = list.slice(0, MAX_CARDS);
  shownIds = shown.map(c => c.id);
  if (!list.length) {
    host.appendChild(el('p', { class: 'alglib-empty', text: `No ${set.label} case matches “${state.q}”.` }));
  }
  for (const c of shown) host.appendChild(card(set, c));
  if (list.length > shown.length) {
    host.appendChild(el('p', { class: 'alglib-empty',
      text: `Showing ${shown.length} of ${list.length} — narrow the search to see the rest.` }));
  }
  flushDraws();
  renderTrainBar();
}

function card(set, c) {
  const on = picks().has(c.id);
  const algs = displayOrder(set.id, c.id);

  const pick = el('button', {
    class: 'case-pick', type: 'button', 'aria-pressed': String(on),
    title: 'Select for training · Shift-click selects a range',
  },
    el('span', { class: 'case-check', 'aria-hidden': 'true' }),
    caseArt(set, c.id),
    el('span', { class: 'case-name', text: set.caseLabel(c) }),
    el('span', { class: 'case-desc', text: set.describe(c) }),
  );
  /* Shift-click would otherwise also select the text between the two cards. */
  pick.addEventListener('mousedown', (ev) => { if (ev.shiftKey) ev.preventDefault(); });
  pick.addEventListener('click', (ev) => toggleCase(c.id, ev.shiftKey));

  const open = el('button', {
    class: 'case-open', type: 'button', title: 'Open this case — every algorithm for it',
    'aria-label': `Open ${set.caseLabel(c)} — ${algs.length} algorithm${algs.length === 1 ? '' : 's'}`,
  },
    el('code', { class: 'case-alg', text: algs[0]?.alg || c.alg }),
    el('span', { class: 'case-more', text: `${algs.length} alg${algs.length === 1 ? '' : 's'}` }),
    icon('M9 6l6 6-6 6'),
  );
  open.addEventListener('click', () => openCase(c.id));

  const node = el('div', { class: `case-card${on ? ' on' : ''}`, 'data-case': c.id }, pick, open);
  if (hasCustomOrder(c.id)) node.appendChild(el('span', { class: 'case-flag', text: 'your order' }));
  return node;
}

/**
 * Click toggles one case. Shift-click sets every case from the last one you
 * clicked to this one to whatever that last one is now — so a click then a
 * Shift-click selects a run, and the same on a selected run clears it.
 */
function toggleCase(id, range) {
  const sel = picks();
  if (range && anchor && anchor !== id && shownIds.includes(anchor)) {
    const a = shownIds.indexOf(anchor), b = shownIds.indexOf(id);
    const on = sel.has(anchor);
    for (const x of shownIds.slice(Math.min(a, b), Math.max(a, b) + 1)) {
      if (on) sel.add(x); else sel.delete(x);
    }
  } else {
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    anchor = id;
  }
  syncCards();
  renderTrainBar();
}

function syncCards() {
  const sel = picks();
  for (const node of document.querySelectorAll('#alglib-grid .case-card')) {
    const on = sel.has(node.dataset.case);
    node.classList.toggle('on', on);
    node.querySelector('.case-pick').setAttribute('aria-pressed', String(on));
  }
}

/**
 * The selection bar: how many are picked, all / none / invert for what is on
 * screen, and the hand-off to the timer.
 *
 * "Train" writes a mode and the case ids into the timer's address bar and lets
 * the case picker's own setting do the rest — there is no second definition
 * of what a trainer scramble is. Nothing selected means the whole set.
 */
function renderTrainBar() {
  const host = $('#alglib-train');
  host.textContent = '';
  const set = SETS[state.set];
  if (!set) return;
  const sel = picks();
  const n = set.cases.filter(c => sel.has(c.id)).length;
  /* Only a changed count is written, so a screen reader is not told the same
     number again after every search keystroke. */
  const status = `${n} of ${set.cases.length} selected`;
  if ($('#alglib-status').textContent !== status) $('#alglib-status').textContent = status;

  const bulk = (label, title, fn) => {
    const b = el('button', { class: 'sel-btn', type: 'button', text: label, title, 'data-bulk': label });
    b.addEventListener('click', () => {
      fn(); anchor = null; syncCards(); renderTrainBar();
      /* The bar was rebuilt under the keyboard; put focus back on the button. */
      host.querySelector(`[data-bulk="${label}"]`)?.focus();
    });
    return b;
  };

  const go = el('button', {
    class: 'btn primary train-go', type: 'button',
    text: n ? `Train ${n} case${n === 1 ? '' : 's'}` : `Train all ${set.cases.length}`,
    disabled: !set.trainerMode,
  });
  go.addEventListener('click', () => train(set, set.cases.filter(c => sel.has(c.id)).map(c => c.id)));

  host.append(
    el('span', { class: 'sel-count' }, el('b', { text: String(n) }), ` of ${set.cases.length} selected`),
    el('div', { class: 'sel-actions', role: 'group', 'aria-label': 'Selection' },
      bulk('All', 'Select every case shown', () => shownIds.forEach(id => sel.add(id))),
      bulk('None', 'Clear the selection', () => sel.clear()),
      bulk('Invert', 'Flip every case shown', () => shownIds.forEach(id => (sel.has(id) ? sel.delete(id) : sel.add(id)))),
    ),
    go,
  );
}

function train(set, ids) {
  const p = new URLSearchParams({ train: set.trainerMode });
  if (ids.length && ids.length < set.cases.length) p.set('cases', ids.join(','));
  location.href = `index.html?${p}`;
}

/* ---------------------------------------------------------
   Detail view
   --------------------------------------------------------- */

/* The case whose detail view is open, so closing it can hand focus back to
   the card it was opened from instead of dropping a keyboard user at the top. */
let openId = null;

function closeCase() {
  const id = openId;
  openId = null;
  renderGrid();
  const btn = id && document.querySelector(`#alglib-grid .case-card[data-case="${CSS.escape(id)}"] .case-open`);
  if (btn) {
    btn.scrollIntoView({ block: 'center' });
    btn.focus({ preventScroll: true });
  }
}

function openCase(caseId) {
  openId = caseId;
  const set = SETS[state.set];
  const c = caseOf(set.id, caseId);
  const host = $('#alglib-detail');
  host.textContent = '';
  host.hidden = false;
  $('#alglib-grid').hidden = true;
  $('#alglib-bar').hidden = true;
  scrollTo({ top: 0 });

  const back = el('button', { class: 'btn back', type: 'button' }, icon('M15 18l-6-6 6-6'), el('span', { text: `All ${set.label}` }));
  back.addEventListener('click', closeCase);

  const actions = el('div', { class: 'case-actions' });
  if (set.trainerMode) {
    const one = el('button', { class: 'btn primary small', type: 'button', text: 'Train this case' });
    one.addEventListener('click', () => train(set, [caseId]));
    actions.appendChild(one);
  }

  const setup = el('section', { class: 'setup-box', hidden: true });
  const head = el('div', { class: 'case-head' },
    el('div', { class: 'case-head-art' }, caseArt(set, caseId, true)),
    el('div', { class: 'case-info' },
      el('p', { class: 'case-kicker', text: set.label }),
      el('h2', { text: set.caseLabel(c) }),
      el('p', { class: 'case-desc', text: set.describe(c) }),
      actions,
      setup,
    ),
  );

  const reset = el('button', { class: 'btn ghost small', type: 'button', text: 'Reset order' });
  const list = el('div', { class: 'alg-list' });
  const rebuild = () => {
    list.textContent = '';
    displayOrder(set.id, caseId).forEach((a, i) => list.appendChild(algRow(set.id, caseId, a, i, rebuild)));
    /* The setup is chosen against whichever alg is first, so it is rebuilt
       with the list. */
    paintSetup(setup, set.id, caseId);
    reset.hidden = !hasCustomOrder(caseId);
  };
  sortable(list, async (order) => {
    await saveOrder(caseId, order);
    rebuild();
    toast('Order saved');
  });
  reset.addEventListener('click', async () => {
    await resetOrder(caseId);
    rebuild();
    toast('Back to the listed order');
  });

  host.append(
    back,
    head,
    el('div', { class: 'alg-list-head' },
      el('h3', { text: 'Algorithms' }),
      el('span', { class: 'sub', text: 'Drag to reorder · the first one is what the trainer scrambles from' }),
      reset,
    ),
    list,
    addRow(set, caseId, rebuild),
  );
  rebuild();
  flushDraws();
  back.focus({ preventScroll: true });
}

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

/**
 * The moves that put the case on a solved cube, under its picture — look at the
 * case, build it, then try to solve it. No setup rather than a wrong one: a
 * case the search cannot place just shows its algorithms.
 */
function paintSetup(host, setId, caseId) {
  host.textContent = '';
  const s = setupFor(setId, caseId);
  if (!s) { host.hidden = true; return; }
  host.hidden = false;

  const btn = el('button', { class: 'btn ghost small setup-copy', type: 'button', text: 'Copy' });
  btn.addEventListener('click', async () => {
    const ok = await copy(s.setup);
    toast(ok ? 'Setup copied' : 'Your browser blocked the clipboard', ok ? {} : { kind: 'bad' });
  });

  const where = displayOrder(setId, caseId).findIndex(a => a.alg === s.from);
  const note = s.reversesFirst
    ? (s.alternative
        ? `Your 1st algorithm backwards — the shortest setup that is not is ${s.alternative.moves} moves (${s.alternative.setup}).`
        : 'Your 1st algorithm backwards. Nothing shorter sets this case up.')
    : where < 0
      ? 'It is not the algorithm you are drilling, in reverse.'
      : `Taken from the ${ORDINAL[where] || `${where + 1}th`} algorithm below, so it is not the one you are drilling in reverse.`;

  host.append(
    el('div', { class: 'setup-head' },
      el('h3', { text: 'Setup' }),
      el('span', { class: 'setup-count', text: `${s.moves} moves` }),
      btn,
    ),
    el('code', { class: 'setup-moves', text: s.setup }),
    el('p', { class: 'setup-note', text: note }),
  );
}

function algRow(setId, caseId, a, i, rebuild) {
  const row = el('div', { class: `alg-row${i === 0 ? ' first' : ''}`, 'data-alg': a.alg });
  const grip = el('span', { class: 'alg-grip', title: 'Drag to reorder' }, icon('M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01'));

  const meta = el('div', { class: 'alg-meta' },
    el('span', { class: 'alg-count', text: `${a.moveCount ?? countFor(setId, a.alg)} moves` }),
  );
  if (i === 0) meta.appendChild(el('span', { class: 'alg-badge first', text: 'trainer', title: 'Scrambles for this case are built from this algorithm' }));
  if (a.source === 'custom') meta.appendChild(el('span', { class: 'alg-badge yours', text: 'yours' }));
  if (a.notes) meta.appendChild(el('span', { class: 'alg-notes', text: a.notes }));

  const moves = el('code', { class: 'alg-moves', text: a.alg, title: 'Click to copy' });
  moves.addEventListener('click', async () => {
    const ok = await copy(a.alg);
    toast(ok ? 'Algorithm copied' : 'Your browser blocked the clipboard', ok ? {} : { kind: 'bad' });
  });

  row.append(grip, el('div', { class: 'alg-body' }, moves, meta));

  if (a.source === 'custom') {
    const del = el('button', { class: 'alg-del', type: 'button', title: 'Remove your algorithm', text: '×' });
    del.addEventListener('click', async () => {
      await removeCustom(caseId, a.alg);
      rebuild();
      toast('Removed');
    });
    row.appendChild(del);
  }
  return row;
}

const EXAMPLE = {
  cube: "R U R' U' R' F R2 U' R' U' R U R' F'",
  pyram: "R U R' U R U R'",
  skewb: "R' F R F'",
  sq1: '1,0 / -1,0 / 0,3 /',
};

function addRow(set, caseId, rebuild) {
  const input = el('input', {
    type: 'text', class: 'alg-input', placeholder: `e.g. ${EXAMPLE[set.puzzle || 'cube']}`,
    autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Your algorithm',
  });
  const err = el('p', { class: 'alg-error', hidden: true });
  const save = el('button', { class: 'btn primary', type: 'button', text: 'Add' });

  const submit = async () => {
    err.hidden = true;
    save.disabled = true;
    /* Verified before it is stored, never after. */
    const res = await addCustom(set.id, caseId, input.value);
    save.disabled = false;
    if (!res.ok) { err.textContent = res.error; err.hidden = false; return; }
    input.value = '';
    rebuild();
    toast('Checked on a simulated puzzle — added');
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

  return el('div', { class: 'alg-add' },
    el('h3', { text: 'Add your own' }),
    el('div', { class: 'alg-add-row' }, input, save),
    err,
  );
}

/* ---------------------------------------------------------
   Navigation
   --------------------------------------------------------- */

/* Rows of tabs are rebuilt on every pick. If the keyboard was in the row, it
   stays there — on the tab that is now selected. */
const keepFocus = (host, build) => {
  const had = host.contains(document.activeElement);
  build();
  if (had) host.querySelector('.on')?.focus();
};

function renderEvents() {
  keepFocus($('#alglib-events'), buildEvents);
}

function buildEvents() {
  const host = $('#alglib-events');
  host.textContent = '';
  for (const e of ALG_EVENTS) {
    const b = el('button', {
      class: `event-tab${e.id === state.event ? ' on' : ''}`, type: 'button',
      text: e.label, 'aria-pressed': String(e.id === state.event),
    });
    b.addEventListener('click', () => selectEvent(e.id));
    host.appendChild(b);
  }
}

function renderTabs() {
  keepFocus($('#alglib-tabs'), buildTabs);
}

function buildTabs() {
  const host = $('#alglib-tabs');
  host.textContent = '';
  for (const g of eventEntry(state.event).groups) {
    const wrap = el('div', { class: 'tab-group' });
    if (g.label) wrap.appendChild(el('span', { class: 'tab-group-label', text: g.label }));
    for (const id of g.sets) {
      const b = el('button', {
        class: `set-tab${id === state.set ? ' on' : ''}`, type: 'button',
        text: SETS[id]?.label || SET_LABELS[id] || id, 'aria-pressed': String(id === state.set),
      });
      b.addEventListener('click', () => selectSet(id));
      wrap.appendChild(b);
    }
    host.appendChild(wrap);
  }
}

function clearSearch() {
  state.q = '';
  $('#alglib-q').value = '';
  anchor = null;
}

async function selectEvent(id) {
  if (id === state.event) return;
  state.event = id;
  state.set = eventSets(id)[0];
  clearSearch();
  renderEvents();
  renderTabs();
  await showSet();
}

async function selectSet(id) {
  if (id === state.set) return;
  state.set = id;
  clearSearch();
  renderTabs();
  await showSet();
}

/**
 * Load whichever set is selected and draw it. The guard after the await is
 * not paranoia: every set past PLL and OLL is a dynamic import, and clicking
 * through tabs faster than they load would otherwise draw whichever landed last.
 */
async function showSet() {
  writeUrl();
  const want = state.set;
  $('#alglib-detail').hidden = true;
  /* The bar belongs to the set on screen. Left up while the next one loads,
     its Train button would still send the previous set to the timer. */
  $('#alglib-train').textContent = '';
  $('#alglib-groups').hidden = true;
  $('#alglib-sub').textContent = '';
  $('#alglib-grid').replaceChildren(el('p', { class: 'alglib-empty', text: 'Loading…' }));
  let set = null;
  try {
    set = await loadSet(want);
  } catch (err) {
    console.error('[alglib] could not load', want, err);
  }
  if (state.set !== want) return;
  if (!set) {
    $('#alglib-grid').replaceChildren(el('p', { class: 'alglib-empty', text: 'This set could not be loaded. Check your connection and try again.' }));
    return;
  }
  renderTabs();
  $('#alglib-sub').textContent = set.title;
  state.group = set.defaultGroup ?? null;
  renderGrid();
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

async function init() {
  const settings = await loadSettings();
  applyTheme(settings);
  /* Same metronome window as the timer — this is the page you sit on while
     drilling a case to a beat. */
  mountMetro(settings, () => saveSettings(settings));
  await loadLibraryPrefs();

  readUrl();
  renderEvents();
  renderTabs();
  await showSet();

  let t;
  $('#alglib-q').addEventListener('input', (ev) => {
    state.q = ev.target.value;
    clearTimeout(t);
    t = setTimeout(renderGrid, 90);
  });

  addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#alglib-detail').hidden) closeCase();
  });

  addEventListener('resize', () => {
    for (const canvas of document.querySelectorAll('canvas.case-art')) {
      drawCase(canvas, canvas.dataset.set, canvas.dataset.case);
    }
  });
}

init();
