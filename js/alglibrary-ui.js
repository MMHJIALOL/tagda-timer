/* ===========================================================
   Tagda Timer — algorithm library page (algs.html).

   A grid of cases you recognise by shape, and a detail view where the
   alternates for a case can be dragged into your own order.

   Deliberately its own page rather than a panel or a topbar button: the
   topbar already holds seven icons, the sidebar is dense on a laptop and
   bad on a phone, and this is a thing you browse at leisure, not a thing
   you touch every solve. It costs the timer screen nothing.
   =========================================================== */

import { $, el, copy } from './util.js';
import { SCHEME, stickerAt } from './cubenet.js';
import { loadSettings, saveSettings, applyTheme } from './theme.js';
import { mountMetro } from './metro.js';
import { toast } from './toast.js';
import {
  SETS, ALG_EVENTS, SET_LABELS, loadSet, caseOf, caseFacelets, displayOrder, loadLibraryPrefs,
  saveOrder, resetOrder, hasCustomOrder, addCustom, removeCustom, moveCount,
} from './alglibrary.js';
import { EVENTS } from './events.js';
import { setupFor } from './alglibrary-setup.js';

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

  const set = SETS[setId] || {};
  if (set.picture === 'f2l') return drawF2L(ctx, f, size);

  /* The same drawing serves a 2x2 and a 3x3. Only the number of stickers
     changes — the layout, the winding and the colour rules are the puzzle's
     geometry, not its size, so nothing here is written twice. */
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
  /* Winding, derived from the face geometry in cubenet.js rather than guessed:
     F and L are wound the same way as the U face they sit against, B and R are
     wound against it. Get one of these backwards and every case is silently
     mirrored, which reads as "the diagrams are wrong", not as a bug. */
  const B = f.B[0].slice().reverse();
  const R = f.R[0].slice().reverse();
  for (let i = 0; i < n; i++) {
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

const state = { event: '333', set: 'PLL', q: '', group: null };

/* Where you are is in the address bar, so a set is a link you can send someone
   and a reload puts you back where you were rather than on PLL. */
function readUrl() {
  const p = new URLSearchParams(location.search);
  const ev = ALG_EVENTS.find(e => e.id === p.get('event'));
  if (ev) state.event = ev.id;
  const set = p.get('set');
  if (set && eventSets(state.event).includes(set)) state.set = set;
  else state.set = eventSets(state.event)[0] || null;
}

function writeUrl() {
  const p = new URLSearchParams();
  p.set('event', state.event);
  if (state.set) p.set('set', state.set);
  history.replaceState(null, '', `${location.pathname}?${p}`);
}

const eventSets = (id) => (ALG_EVENTS.find(e => e.id === id)?.sets) || [];
const eventName = (id) => EVENTS[id]?.short || id;

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
  const host = $('#alglib-grid');
  host.textContent = '';
  host.hidden = false;
  $('#alglib-detail').hidden = true;

  const set = SETS[state.set];
  renderTrainBar();
  if (!set) { $('#alglib-groups').hidden = true; host.appendChild(pendingPanel()); return; }
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

    /* The tick sits on the card rather than in a separate list of the same
       cases in a different order, which is how you end up drilling four cases
       you did not mean to pick. It is a button inside a button, so it has to
       swallow the click that would otherwise open the case. */
    if (set.trainerMode) {
      const tick = el('span', {
        class: `case-tick ${picked.has(c.id) ? 'on' : ''}`,
        role: 'checkbox',
        title: 'Include this case when you train',
        'aria-checked': picked.has(c.id) ? 'true' : 'false',
      });
      tick.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (picked.has(c.id)) picked.delete(c.id); else picked.add(c.id);
        tick.classList.toggle('on', picked.has(c.id));
        tick.setAttribute('aria-checked', picked.has(c.id) ? 'true' : 'false');
        renderTrainBar();
      });
      card.appendChild(tick);
    }

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
   Events with no data yet
   --------------------------------------------------------- */

/**
 * What an event says when this app has no algorithms for it.
 *
 * Deliberately a real answer rather than an empty grid. Every algorithm in
 * this library has been executed against the case it is filed under, and for
 * megaminx, pyraminx, skewb, square-1, clock and FTO there is no simulator
 * here to execute it on — so the honest state is "not yet, and here is the
 * thing that has to exist first", not a page of numbers nobody checked.
 */
function pendingPanel() {
  const entry = ALG_EVENTS.find(e => e.id === state.event);
  const wanted = entry?.pending || [];
  return el('section', { class: 'alglib-pending' },
    el('h2', { text: `No ${EVENTS[state.event]?.name || state.event} algorithms here yet` }),
    wanted.length
      ? el('p', {}, el('span', { text: 'Planned: ' }), el('b', { text: wanted.join(' · ') }))
      : null,
    el('p', { text:
      'Nothing is listed on this page that has not been run against its own case on a ' +
      'simulated puzzle. This app simulates NxN cubes, so 2x2, 3x3 and their sets can be ' +
      'checked; it has no model of this puzzle yet, and an unchecked algorithm list would ' +
      'teach someone the wrong thing rather than nothing.' }),
    el('p', { class: 'sub', text:
      'The timer still scrambles this event normally — this page is the only part that is waiting.' }),
  );
}

/* ---------------------------------------------------------
   Handing a set to the trainer
   --------------------------------------------------------- */

/* Which cases are ticked for a training run. Module-level rather than rebuilt
   with the grid: searching or switching subset must not quietly forget the
   four cases you already chose. Cleared when you change set, because a
   selection of PLL cases means nothing in F2L. */
const picked = new Set();

/**
 * "Train these cases" — the point of the whole page, in one button.
 *
 * The timer already knows how to drill part of a set: the case picker writes
 * `settings.allowedCases[mode]` and the scramble queue reads it. What was
 * missing was a way to say *which* cases from the place you can actually see
 * them. So this hands the timer a mode and a list of case ids in the address
 * bar and lets the machinery that already exists do the rest — there is no
 * second definition anywhere of what a trainer scramble is.
 */
function renderTrainBar() {
  const host = $('#alglib-train');
  host.textContent = '';
  const set = SETS[state.set];
  if (!set || !set.trainerMode) { host.hidden = true; return; }
  host.hidden = false;

  const n = picked.size;
  const btn = el('button', {
    class: 'btn primary',
    text: n ? `Train these ${n} ${n === 1 ? 'case' : 'cases'}` : `Train all ${set.cases.length} cases`,
  });
  btn.addEventListener('click', () => {
    const p = new URLSearchParams({ train: set.trainerMode });
    if (n) p.set('cases', [...picked].join(','));
    location.href = `index.html?${p}`;
  });

  host.append(btn, el('span', { class: 'sub', text: n
    ? 'the timer will only hand you these, timed, with a per-case average'
    : 'or tick the corner of a card to drill only some of them' }));

  if (n) {
    const clear = el('button', { class: 'ghost-btn', text: 'clear' });
    clear.addEventListener('click', () => { picked.clear(); renderGrid(); });
    host.append(clear);
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
  $('#alglib-train').hidden = true;
  scrollTo({ top: 0 });

  const back = el('button', { class: 'btn back', html: '<span>All ' + set.label + ' cases</span>' });
  back.prepend(icon('M15 18l-6-6 6-6'));
  back.addEventListener('click', renderGrid);

  /* Drilling the one case you are looking at is a different intent from
     drilling a set, and wanting it while reading a case is the common one. */
  const trainOne = set.trainerMode
    ? el('button', { class: 'btn ghost small', text: 'Train only this case' })
    : null;
  trainOne?.addEventListener('click', () => {
    location.href = `index.html?${new URLSearchParams({ train: set.trainerMode, cases: caseId })}`;
  });

  const canvas = el('canvas', { class: 'case-pic big' });
  const setup = el('section', { class: 'setup-box' });
  /* The setup belongs to the case, not to the list of algorithms, so it sits
     inside the heading block with the picture and the name rather than
     floating between the two as its own band — which read as unattached to
     either. It replaces the note that used to be here: the drag hint is on the
     grip and in the page footer, and it was explaining a mechanism nobody had
     asked about yet at the moment they opened a case. */
  const head = el('div', { class: 'case-head' },
    canvas,
    el('div', { class: 'case-info' },
      el('h2', { text: set.caseLabel(c) }),
      el('p', { class: 'case-desc', text: set.describe(c) }),
      setup,
    ),
  );

  const list = el('div', { class: 'alg-list' });
  const rebuild = () => {
    list.textContent = '';
    displayOrder(set.id, caseId).forEach((a, i) => list.appendChild(algRow(set.id, caseId, a, i, rebuild)));
    /* Rebuilt with the list, not once on open: the setup is chosen against
       whichever alg is currently first (see alglibrary-setup.js rule 2), so a
       drag that changes your first alg can change the setup under it. */
    paintSetup(setup, set.id, caseId);
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
  const actions = el('div', { class: 'case-actions' });
  if (trainOne) actions.appendChild(trainOne);
  if (hasCustomOrder(caseId)) actions.appendChild(reset);
  if (actions.children.length) host.appendChild(actions);
  requestAnimationFrame(() => drawCase(canvas, set.id, caseId));
}

/* ---------------------------------------------------------
   Setup moves
   --------------------------------------------------------- */

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

/**
 * The moves that put the case on the cube, above the algorithms that take it
 * off again.
 *
 * It sits directly under the picture and above the list, because that is the
 * order you do things in: look at the case, build it, then try to solve it.
 * Practising a case used to mean reading the first alg backwards a move at a
 * time; this is the sequence that saves you doing that.
 */
function paintSetup(host, setId, caseId) {
  host.textContent = '';
  const s = setupFor(setId, caseId);
  /* No setup rather than a wrong one. Nothing is printed here that has not
     been executed against the case, so a case the search cannot place simply
     shows the algorithms, exactly as before this feature existed. */
  if (!s) { host.hidden = true; return; }
  host.hidden = false;

  const btn = el('button', { class: 'btn ghost small setup-copy', text: 'Copy' });
  btn.addEventListener('click', async () => {
    const ok = await copy(s.setup);
    toast(ok ? 'Setup copied' : 'Your browser blocked the clipboard', ok ? {} : { kind: 'bad' });
  });

  const where = displayOrder(setId, caseId).findIndex(a => a.alg === s.from);
  const note = s.reversesFirst
    /* Said out loud, because it looks like the feature failed otherwise. It has
       not: on a case whose best alg is also its shortest, its reverse is the
       shortest possible setup, and a longer one would be worse for the sake of
       looking different. */
    ? (s.alternative
        ? `Your 1st algorithm backwards — the shortest setup that is not is ${s.alternative.moves} moves (${s.alternative.setup}).`
        : 'Your 1st algorithm backwards. Nothing shorter sets this case up.')
    : where < 0
      ? 'It is not the algorithm you are drilling, in reverse.'
      : `Taken from the ${ORDINAL[where] || `${where + 1}th`} algorithm below, so it is not the one you are drilling in reverse.`;

  host.append(
    el('div', { class: 'setup-head' },
      el('h3', { text: 'Setup moves' }),
      el('span', { class: 'setup-count', text: `${s.moves} moves` }),
      btn,
    ),
    el('code', { class: 'setup-moves', text: s.setup }),
    el('p', { class: 'setup-note', text: 'Do these on a solved cube and the case above is what you are holding. ' + note }),
  );
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
   Navigation
   --------------------------------------------------------- */

/** The event row. Every event the timer has, whether or not it has algs yet. */
function renderEvents() {
  const host = $('#alglib-events');
  host.textContent = '';
  for (const e of ALG_EVENTS) {
    const b = el('button', {
      class: `event-chip ${e.id === state.event ? 'on' : ''} ${e.sets.length ? '' : 'empty'}`,
      text: eventName(e.id),
      title: e.sets.length ? `${e.sets.length} set${e.sets.length === 1 ? '' : 's'}` : 'no algorithms here yet',
    });
    b.addEventListener('click', () => selectEvent(e.id));
    host.appendChild(b);
  }
}

/** The set tabs for whichever event is showing. */
function renderTabs() {
  const host = $('#alglib-tabs');
  host.textContent = '';
  for (const id of eventSets(state.event)) {
    const set = SETS[id];
    const b = el('button', {
      class: `seg-btn ${id === state.set ? 'on' : ''}`,
      role: 'tab',
      /* A set's own label lives in the module that has not loaded yet, so the
         catalogue carries one too. The row is complete and clickable from the
         first frame rather than filling itself in as imports land. */
      text: set?.label || SET_LABELS[id] || id,
    });
    b.addEventListener('click', () => selectSet(id));
    host.appendChild(b);
  }
}

async function selectEvent(id) {
  if (id === state.event) return;
  state.event = id;
  state.set = eventSets(id)[0] || null;
  picked.clear();
  state.q = '';
  $('#alglib-q').value = '';
  renderEvents();
  renderTabs();
  await showSet();
}

async function selectSet(id) {
  if (id === state.set) return;
  state.set = id;
  picked.clear();
  state.q = '';
  $('#alglib-q').value = '';
  renderTabs();
  await showSet();
}

/**
 * Load whichever set is selected and draw it.
 *
 * The guard at the end is not paranoia: every set past PLL and OLL arrives as
 * a dynamic import, and clicking through three tabs faster than they load
 * would otherwise render whichever one finished last.
 */
async function showSet() {
  writeUrl();
  const want = state.set;
  const set = want ? await loadSet(want) : null;
  if (state.set !== want) return;
  renderTabs();
  $('#alglib-sub').textContent = set
    ? set.title
    : 'Pick an event. Every case as a picture, with the alternates people actually use.';
  state.group = set?.defaultGroup ?? null;
  $('#alglib-q').parentElement.hidden = !set;
  renderGrid();
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

async function init() {
  const settings = await loadSettings();
  applyTheme(settings);
  /* The metronome belongs here more than anywhere: this is the page you sit on
     while drilling a case to a beat. Same settings, same window as the timer's
     — turned on in Settings › Timer › Metronome window over there. */
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

  addEventListener('resize', () => {
    for (const c of document.querySelectorAll('.case-card')) {
      drawCase(c.querySelector('canvas'), state.set, c.dataset.case);
    }
  });
}

init();
