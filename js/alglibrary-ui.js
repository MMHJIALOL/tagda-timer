/* ===========================================================
   Tagda Timer — algorithm library page (algs.html).

   A grid of cases you recognise by shape, and a detail view where the
   alternates for a case can be dragged into your own order.

   Deliberately its own page rather than a panel or a topbar button: the
   topbar already holds seven icons, the sidebar is dense on a laptop and
   bad on a phone, and this is a thing you browse at leisure, not a thing
   you touch every solve. It costs the timer screen nothing.
   =========================================================== */

import { $, el } from './util.js';
import { SCHEME, stickerAt } from './cubenet.js';
import { loadSettings, applyTheme } from './theme.js';
import { toast } from './toast.js';
import {
  SETS, loadSet, caseOf, caseFacelets, displayOrder, loadLibraryPrefs,
  saveOrder, resetOrder, hasCustomOrder, addCustom, removeCustom, moveCount,
} from './alglibrary.js';

/* ---------------------------------------------------------
   Case pictures
   --------------------------------------------------------- */

/* An OLL diagram is about which stickers face up, not which colours they are,
   so anything unoriented goes flat grey — the same convention every printed
   OLL sheet uses. A PLL diagram is the opposite: the side bars *are* the
   information. */
const UNORIENTED = '#3b3b4e';

/* Yellow on top, because that is the cube you are actually looking at.

   The simulator in cubenet.js keeps white on U, which is right for a scramble
   preview — that is the orientation cubing.js scrambles assume. But by the time
   you are at a last-layer case you have solved the cross on the bottom, so the
   face you are staring at is yellow. Every printed sheet and every alg site
   draws it that way; white-on-top is the case upside down.

   This is `z2` — the rotation SpeedCubeDB itself stores as the setup for these
   cases — expressed as a recolour rather than a move. z2 swaps U with D and L
   with R and leaves F and B alone, so relabelling the colours gets the exact
   same picture as rotating the cube would.

   It has to be done this way round. drawCase's side-strip winding below is
   derived from the face geometry, so genuinely rotating the state would move
   the case onto the D face and mirror every side bar — the diagrams would be
   wrong in a way that reads as "this app cannot draw a cube". Recolouring
   leaves the geometry exactly where the winding expects it. */
const Z2 = { U: 'D', D: 'U', L: 'R', R: 'L', F: 'F', B: 'B' };
const LL_SCHEME = Object.fromEntries(
  Object.keys(SCHEME).map(face => [face, SCHEME[Z2[face]]]),
);

/**
 * The standard last-layer picture: the U face, plus the top row of each of
 * the four side faces around it.
 *
 * The strips are read straight out of the facelet grids the simulator
 * produces, so nothing here has to know what a T perm looks like.
 */
function drawCase(canvas, setId, caseId) {
  const f = caseFacelets(setId, caseId);
  if (!f) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const size = canvas.clientWidth || 96;
  canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  if (setId === 'F2L') return drawF2L(ctx, f, size);

  const cell = size / 4.2;
  const t = cell * 0.42, g = cell * 0.11;
  const span = 3 * cell + 2 * (t + g);
  const ox = (size - span) / 2, oy = (size - span) / 2;
  const gx = ox + t + g, gy = oy + t + g;

  const oll = setId === 'OLL';
  const paint = (s) => (oll ? (s === 'U' ? LL_SCHEME.U : UNORIENTED) : LL_SCHEME[s] || UNORIENTED);
  const box = (x, y, w, h, s) => {
    ctx.fillStyle = paint(s);
    ctx.beginPath();
    const r = Math.min(w, h) * 0.22;
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.fill();
  };

  const pad = cell * 0.06;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      box(gx + c * cell + pad, gy + r * cell + pad, cell - 2 * pad, cell - 2 * pad, f.U[r][c]);
    }
  }
  /* Winding, derived from the face geometry in cubenet.js rather than guessed:
     F and L are wound the same way as the U face they sit against, B and R are
     wound against it. Get one of these backwards and every case is silently
     mirrored, which reads as "the diagrams are wrong", not as a bug. */
  const B = f.B[0].slice().reverse();
  const R = f.R[0].slice().reverse();
  for (let i = 0; i < 3; i++) {
    box(gx + i * cell + pad, oy,                  cell - 2 * pad, t, B[i]);
    box(gx + i * cell + pad, oy + span - t,       cell - 2 * pad, t, f.F[0][i]);
    box(ox,                  gy + i * cell + pad, t, cell - 2 * pad, f.L[0][i]);
    box(ox + span - t,       gy + i * cell + pad, t, cell - 2 * pad, R[i]);
  }
}

/* An F2L piece that is not part of the case. Darker than the OLL grey, because
   here it is the background against which two pieces have to stand out, rather
   than half the information in the picture. */
const F2L_IGNORED = '#2e2e3c';

/**
 * F2L is not a last-layer case, so it cannot use the picture above.
 *
 * That diagram is the U face ringed by the top row of each side — everything a
 * last-layer case consists of, and nothing else. An F2L case is a corner and an
 * edge on their way into the front-right slot, and the U face alone does not
 * show where either of them is.
 *
 * So it is drawn the way every F2L sheet draws it, and the way you actually see
 * it: the cube in three-quarter view, with the last layer greyed out.
 *
 * Three things are in colour, and the third is the one that makes the picture
 * make sense:
 *
 *   1. the corner of the pair, wherever it currently is;
 *   2. its edge, likewise;
 *   3. the first two layers you have already built.
 *
 * Leaving (3) grey was the first attempt and it was wrong. The pair on its own
 * says what you are holding but not where it is going, and the destination is
 * half of what you are looking at when you recognise an F2L case. Drawing the
 * finished layers solid leaves the empty slot as a notch in them — and *that*
 * notch is the target. It is drawn by not drawing it: every first-two-layers
 * sticker still sitting on its home face is painted, so the slot, which holds
 * displaced last-layer pieces, stays grey on its own.
 */
function drawF2L(ctx, f, size) {
  /* Which two pieces are the case. Identified by colour, not by position: the
     corner carrying the cross colour plus both slot colours, and the edge
     carrying just the slot colours. Wherever the algorithm has left them, those
     are the pieces — which is why this cannot be a fixed list of squares. */
  const isTarget = (colours) => {
    const k = [...colours].sort().join('');
    return k === 'DFR' || k === 'FR';
  };

  /* Group every facelet by the piece it is stuck to, so a corner's three
     stickers are known to be one object before anything is drawn. `home` is
     whether that whole piece is where it belongs, every sticker facing the
     right way. */
  const pieces = new Map();
  for (const face of ['U', 'R', 'F', 'D', 'L', 'B']) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const { cubie } = stickerAt(face, r, c, 3);
        if (!pieces.has(cubie)) pieces.set(cubie, { colours: new Set(), home: true });
        const p = pieces.get(cubie);
        p.colours.add(f[face][r][c]);
        /* Per-piece, not per-sticker. A displaced last-layer corner dropped
           into the slot can easily show the front colour on the front face; if
           one matching sticker were enough, it would be painted as finished
           F2L and the slot would stop reading as empty. */
        if (f[face][r][c] !== face) p.home = false;
      }
    }
  }

  /* Isometric three-quarter view: x to the lower right, z to the lower left,
     y straight up. The three faces this reveals are exactly U, F and R. */
  const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6);
  const project = ([x, y, z]) => [(x - z) * COS, (x + z) * SIN - y];

  /* Half-extents of the projected cube, so it can be fitted without measuring:
     the widest points are the left and right corners, the tallest the top and
     bottom ones. */
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

        /* Below the top layer (cubie y <= 0) and fully home: that is the F2L you
           have already built. Whatever is sitting in the slot is not home, so it
           stays grey — which is how the slot draws itself, as a notch in the
           two solid layers rather than as anything this code marks out. */
        const piece = pieces.get(cubie);
        const belowTop = Number(cubie.split(',')[1]) <= 0;
        const lit = (belowTop && piece.home) || isTarget(piece.colours);

        ctx.fillStyle = lit ? (LL_SCHEME[f[face][r][c]] || F2L_IGNORED) : F2L_IGNORED;
        ctx.fill();
        /* The grout has to be drawn, not left as a gap: three faces of the same
           grey meeting at the top corner would otherwise read as a flat
           hexagon rather than a cube. */
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.lineWidth = Math.max(1, size * 0.012);
        ctx.stroke();
      }
    }
  }
}

/* ---------------------------------------------------------
   Sortable list (§6)
   --------------------------------------------------------- */

/**
 * Reorder-within-a-list by pointer drag.
 *
 * drag.js's `makeDraggable` is the wrong primitive here — it moves one node to
 * an absolute {x, y} and remembers where you left it. This needs the opposite:
 * the row snaps into a slot and the *list* is what changes. Small enough to
 * own outright, and it keeps pointer capture so a drag that leaves the list
 * still ends cleanly.
 */
function sortable(list, onDrop) {
  let row = null, rows = [], startY = 0, before = null;

  const rowsNow = () => [...list.querySelectorAll('.alg-row')];
  const order = () => rowsNow().map(r => r.dataset.alg);

  const onMove = (ev) => {
    if (!row) return;
    row.style.transform = `translateY(${ev.clientY - startY}px)`;

    /* Compare the dragged row's centre against every other row's box. When it
       lands inside one, the dragged row takes that slot and the drag origin
       resets to the pointer, so the row stays under the finger instead of
       leaping by its own height. */
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
    // A grab that put everything back where it was is not a reorder to save.
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
   Grid
   --------------------------------------------------------- */

const state = { set: 'PLL', q: '', group: null };

/* A search that matched every ZBLL case would try to paint 472 canvases. The
   cap is not about the DOM so much as the pictures: each one runs the cube
   simulator. Anything past this is a query that needs narrowing, not a page. */
const MAX_CARDS = 96;

function matches(c, set, q) {
  if (!q) return true;
  const hay = `${c.name} ${c.id} ${c.label || ''} ${set.describe(c)}`.toLowerCase();
  return hay.includes(q);
}

/**
 * The second-level nav, for the sets too big or too oddly-shaped for one grid.
 *
 * ZBLL opens on a subset because 472 cards in a single scroll is not
 * navigation; F2L offers "All" as well, because 41 cases is a browsable
 * number and the six groups are a way to teach it, not a way to survive it.
 */
function renderGroups(set) {
  const host = $('#alglib-groups');
  host.textContent = '';
  if (!set.groups) { host.hidden = true; return; }
  host.hidden = false;

  const chip = (value, label) => {
    const b = el('button', { class: 'group-chip', text: label });
    if (state.group === value) b.classList.add('on');
    b.addEventListener('click', () => { state.group = value; renderGrid(); });
    return b;
  };
  if (set.defaultGroup === null) host.appendChild(chip(null, 'All'));
  for (const g of set.groups) host.appendChild(chip(g, g));
}

function renderGrid() {
  const set = SETS[state.set];
  const host = $('#alglib-grid');
  host.textContent = '';
  host.hidden = false;
  $('#alglib-detail').hidden = true;
  renderGroups(set);

  const q = state.q.trim().toLowerCase();
  /* A search reaches across the whole set. Making it obey the subset chip
     instead would mean typing a case's own name and being told it does not
     exist, purely because a different subset was selected. */
  const inGroup = (c) => !state.group || !set.groupOf || set.groupOf(c) === state.group;
  const all = set.cases.filter(c => matches(c, set, q) && (q ? true : inGroup(c)));

  if (!all.length) {
    host.appendChild(el('p', { class: 'alglib-empty', text: `No ${set.label} case matches “${state.q}”.` }));
    return;
  }

  const shown = all.slice(0, MAX_CARDS);
  for (const c of shown) {
    const canvas = el('canvas', { class: 'case-pic' });
    /* The picture leads. A card labelled only "T" means nothing to anyone who
       has not memorised PLL letters, and nobody recognises a case by its
       letter mid-solve anyway. */
    const card = el('button', { class: 'case-card', 'data-case': c.id },
      canvas,
      el('span', { class: 'case-name', text: set.caseLabel(c) }),
      el('span', { class: 'case-desc', text: set.describe(c) }),
    );
    if (hasCustomOrder(c.id)) card.appendChild(el('span', { class: 'case-flag', text: 'your order' }));
    card.addEventListener('click', () => openCase(c.id));
    host.appendChild(card);
    requestAnimationFrame(() => drawCase(canvas, set.id, c.id));
  }
  if (all.length > shown.length) {
    host.appendChild(el('p', { class: 'alglib-empty',
      text: `Showing ${shown.length} of ${all.length} matches — narrow the search to see the rest.` }));
  }
}

/* ---------------------------------------------------------
   Detail view
   --------------------------------------------------------- */

function openCase(caseId) {
  const set = SETS[state.set];
  const c = caseOf(set.id, caseId);
  const host = $('#alglib-detail');
  host.textContent = '';
  host.hidden = false;
  $('#alglib-grid').hidden = true;
  scrollTo({ top: 0 });

  const back = el('button', { class: 'btn back', html: '<span>All ' + set.label + ' cases</span>' });
  back.prepend(icon('M15 18l-6-6 6-6'));
  back.addEventListener('click', renderGrid);

  const canvas = el('canvas', { class: 'case-pic big' });
  const head = el('div', { class: 'case-head' },
    canvas,
    el('div', {},
      el('h2', { text: set.caseLabel(c) }),
      el('p', { class: 'case-desc', text: set.describe(c) }),
      /* Only PLL and OLL have a trainer mode. Telling someone their ZBLL
         reorder changes what the trainer drills would be a straight lie. */
      el('p', { class: 'case-note', text: set.trained
        ? 'Position 1 is the alg the trainer builds this case from. Drag to change it.'
        : 'Drag to keep these in your own order. The trainer has no mode for this set yet, so position 1 is for your reference.' }),
    ),
  );

  const list = el('div', { class: 'alg-list' });
  const rebuild = () => {
    list.textContent = '';
    displayOrder(set.id, caseId).forEach((a, i) => list.appendChild(algRow(set.id, caseId, a, i, rebuild)));
  };
  rebuild();

  sortable(list, async (order) => {
    await saveOrder(caseId, order);
    rebuild();
    toast('Order saved');
  });

  const reset = el('button', { class: 'btn ghost small', text: 'Reset to community order' });
  reset.addEventListener('click', async () => {
    await resetOrder(caseId);
    rebuild();
    toast('Back to community order');
  });

  host.append(back, head, list, addRow(set.id, caseId, rebuild));
  if (hasCustomOrder(caseId)) host.appendChild(reset);
  requestAnimationFrame(() => drawCase(canvas, set.id, caseId));
}

const icon = (d) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
};

function algRow(setId, caseId, a, i, rebuild) {
  const row = el('div', { class: 'alg-row', 'data-alg': a.alg });
  const grip = el('span', { class: 'alg-grip', title: 'Drag to reorder' });
  grip.appendChild(icon('M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01'));

  const meta = el('div', { class: 'alg-meta' },
    el('span', { class: 'alg-count', text: `${a.moveCount ?? moveCount(a.alg)} moves` }),
  );
  if (a.source === 'custom') meta.appendChild(el('span', { class: 'alg-badge yours', text: 'yours' }));
  if (i === 0) meta.appendChild(el('span', { class: 'alg-badge first', text: '★ 1st' }));

  const body = el('div', { class: 'alg-body' },
    el('code', { class: 'alg-moves', text: a.alg }),
    meta,
  );
  if (a.notes) body.appendChild(el('p', { class: 'alg-notes', text: a.notes }));

  row.append(grip, body);

  if (a.source === 'custom') {
    const del = el('button', { class: 'alg-del', title: 'Remove your algorithm', text: '×' });
    del.addEventListener('click', async () => {
      await removeCustom(caseId, a.alg);
      rebuild();
      toast('Removed');
    });
    row.appendChild(del);
  }
  return row;
}

function addRow(setId, caseId, rebuild) {
  const input = el('input', {
    type: 'text', class: 'alg-input', placeholder: "enter moves, e.g. R U R' U' R' F R2 U' R' U' R U R' F'",
    autocomplete: 'off', spellcheck: 'false',
  });
  const err = el('p', { class: 'alg-error', hidden: true });
  const save = el('button', { class: 'btn primary', text: 'Save' });

  const submit = async () => {
    err.hidden = true;
    save.disabled = true;
    /* Verified before it is stored, never after. An alg that does not solve
       the case would otherwise sit at the top of someone's list teaching them
       the wrong thing, which is worse than not having the feature. */
    const res = await addCustom(setId, caseId, input.value);
    save.disabled = false;
    if (!res.ok) { err.textContent = res.error; err.hidden = false; return; }
    input.value = '';
    rebuild();
    toast('Checked on a solved cube — added');
  };

  save.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

  return el('div', { class: 'alg-add' },
    el('h3', { text: '+ Add your algorithm' }),
    el('div', { class: 'alg-add-row' }, input, save),
    err,
  );
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

async function init() {
  applyTheme(await loadSettings());
  await loadLibraryPrefs();

  for (const btn of document.querySelectorAll('#alglib-tabs .seg-btn')) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.set;
      for (const b of document.querySelectorAll('#alglib-tabs .seg-btn')) {
        b.classList.toggle('on', b === btn);
      }
      /* ZBLL and F2L arrive as a dynamic import the first time their tab is
         opened, so the timer never pays for them. Switching tabs mid-load
         would otherwise render whichever set finished first. */
      const set = await loadSet(id);
      if (!btn.classList.contains('on')) return;
      state.set = id;
      state.group = set.defaultGroup ?? null;
      state.q = '';
      $('#alglib-q').value = '';
      $('#alglib-sub').textContent = set.title;
      renderGrid();
    });
  }
  document.querySelector('#alglib-tabs .seg-btn').classList.add('on');
  $('#alglib-sub').textContent = SETS.PLL.title;

  let t;
  $('#alglib-q').addEventListener('input', (ev) => {
    state.q = ev.target.value;
    clearTimeout(t);
    t = setTimeout(renderGrid, 90);
  });

  renderGrid();
  addEventListener('resize', () => {
    for (const c of document.querySelectorAll('.case-card')) {
      drawCase(c.querySelector('canvas'), state.set, c.dataset.case);
    }
  });
}

init();
