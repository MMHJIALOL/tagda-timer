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
import { SCHEME } from './cubenet.js';
import { loadSettings, applyTheme } from './theme.js';
import { toast } from './toast.js';
import {
  SETS, caseOf, caseFacelets, displayOrder, loadLibraryPrefs,
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

  const cell = size / 4.2;
  const t = cell * 0.42, g = cell * 0.11;
  const span = 3 * cell + 2 * (t + g);
  const ox = (size - span) / 2, oy = (size - span) / 2;
  const gx = ox + t + g, gy = oy + t + g;

  const oll = setId === 'OLL';
  const paint = (s) => (oll ? (s === 'U' ? SCHEME.U : UNORIENTED) : SCHEME[s] || UNORIENTED);
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

const state = { set: 'PLL', q: '' };

function matches(c, set, q) {
  if (!q) return true;
  const hay = `${c.name} ${c.id} ${c.label || ''} ${set.describe(c)}`.toLowerCase();
  return hay.includes(q);
}

function renderGrid() {
  const set = SETS[state.set];
  const host = $('#alglib-grid');
  host.textContent = '';
  host.hidden = false;
  $('#alglib-detail').hidden = true;

  const q = state.q.trim().toLowerCase();
  const shown = set.cases.filter(c => matches(c, set, q));

  if (!shown.length) {
    host.appendChild(el('p', { class: 'alglib-empty', text: `No ${set.label} case matches “${state.q}”.` }));
    return;
  }

  for (const c of shown) {
    const canvas = el('canvas', { class: 'case-pic' });
    /* The picture leads. A card labelled only "T" means nothing to anyone who
       has not memorised PLL letters, and nobody recognises a case by its
       letter mid-solve anyway. */
    const card = el('button', { class: 'case-card', 'data-case': c.id },
      canvas,
      el('span', { class: 'case-name', text: set.id === 'OLL' ? `OLL ${c.name}` : `${c.name} perm` }),
      el('span', { class: 'case-desc', text: set.describe(c) }),
    );
    if (hasCustomOrder(c.id)) card.appendChild(el('span', { class: 'case-flag', text: 'your order' }));
    card.addEventListener('click', () => openCase(c.id));
    host.appendChild(card);
    requestAnimationFrame(() => drawCase(canvas, set.id, c.id));
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
      el('h2', { text: set.id === 'OLL' ? `OLL ${c.name}` : `${c.name} perm` }),
      el('p', { class: 'case-desc', text: set.describe(c) }),
      el('p', { class: 'case-note', text: 'Position 1 is the alg the trainer builds this case from. Drag to change it.' }),
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
    btn.addEventListener('click', () => {
      state.set = btn.dataset.set;
      for (const b of document.querySelectorAll('#alglib-tabs .seg-btn')) {
        b.classList.toggle('on', b === btn);
      }
      $('#alglib-sub').textContent = SETS[state.set].title;
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
