import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — bottom sheets (phones)

   On a phone a menu that drops down from a button lands wherever the button
   was, often half off the screen, and a thumb cannot reach the top of it. A
   sheet comes up from the bottom edge instead, where the thumb already is.

   One sheet open at a time is the normal case, but they stack: a menu sheet
   can open a second one (pick a solve from a list) and Escape, the scrim or a
   swipe down closes the top one only.

   It slides in with a transform and nothing else. A panel that starts at
   opacity 0 stays invisible for as long as the frames stall, and a phone
   opening the solver for the first time stalls; a transform runs on the
   compositor and lands regardless. The scrim simply appears.
   =========================================================== */

import { el } from './util.js';

const stack = [];

/* Escape closes the top sheet and nothing else: the capture phase, so the
   timer's own Escape (which would close the whole workbench behind it) never
   sees the key. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stack.at(-1).close();
}, true);

const SWIPE_CLOSE_PX = 80;
const SWIPE_CLOSE_SPEED = 0.6; // px per ms

/**
 * Open a sheet.
 *   title     heading at the top (also its accessible name)
 *   content   a node, or an array of them, for the body
 *   done      show a "Done" button beside the title
 *   onClose   called once, after it has gone
 *   className extra class on the sheet, for its own styles
 * Returns { el, body, close, setContent }.
 */
export function openSheet({ title = '', label = '', content = [], done = false, onClose = null, className = '' } = {}) {
  const restore = document.activeElement;
  const titleId = `sheet-t-${Math.random().toString(36).slice(2, 8)}`;

  const scrim = el('div', { class: 'sheet-scrim' });
  const body = el('div', { class: 'sheet-body' });
  const handle = el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }, el('span'));
  const head = el('div', { class: 'sheet-head' + (title ? '' : ' bare') },
    title ? el('h2', { class: 'sheet-title', id: titleId, text: title }) : null,
    done ? el('button', { class: 'sheet-done', type: 'button', text: t('Done'), onclick: () => api.close() }) : null);
  const sheet = el('div', {
    class: 'sheet' + (className ? ` ${className}` : ''), role: 'dialog', 'aria-modal': 'true',
    tabindex: '-1', ...(title ? { 'aria-labelledby': titleId } : { 'aria-label': label || t('Menu') }),
  }, handle, head, body);

  let closed = false;
  const api = {
    el: sheet,
    body,
    setContent(nodes) { body.replaceChildren(...[].concat(nodes).filter(Boolean)); },
    close() {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      scrim.remove();
      const done = () => {
        sheet.remove();
        if (restore && restore.isConnected && typeof restore.focus === 'function') {
          try { restore.focus({ preventScroll: true }); } catch { /* gone */ }
        }
        onClose?.();
      };
      sheet.classList.add('closing');
      sheet.addEventListener('animationend', done, { once: true });
      // Reduced motion, a hidden tab, an animation that never ran: go anyway.
      setTimeout(() => { if (sheet.isConnected) done(); }, 420);
    },
  };
  api.setContent(content);

  scrim.addEventListener('click', () => api.close());
  wireSwipe(sheet, [handle, head], api);

  document.body.append(scrim, sheet);
  stack.push(api);
  try { sheet.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
  return api;
}

/** Close every open sheet — the layout changed under them, or the host went. */
export function closeAllSheets() {
  for (const s of [...stack].reverse()) s.close();
}

export const sheetOpen = () => stack.length > 0;

/**
 * Drag the sheet down by its handle or title row to put it away. Only there:
 * the body scrolls, and a downward drag in a list is a scroll, not a dismissal.
 */
function wireSwipe(sheet, grips, api) {
  let start = null;
  const move = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = Math.max(0, e.clientY - start.y);
    start.dy = dy;
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const { dy = 0, t0 } = start;
    start = null;
    const speed = dy / Math.max(1, performance.now() - t0);
    sheet.style.transition = 'transform 220ms cubic-bezier(.22,1,.36,1)';
    if (dy > SWIPE_CLOSE_PX || (dy > 12 && speed > SWIPE_CLOSE_SPEED)) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => api.close(), 200);
    } else {
      sheet.style.transform = '';
      setTimeout(() => { sheet.style.transition = ''; }, 240);
    }
  };
  for (const g of grips) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('button')) return;
      start = { id: e.pointerId, y: e.clientY, t0: performance.now(), dy: 0 };
      sheet.style.transition = 'none';
      try { g.setPointerCapture(e.pointerId); } catch { /* fine */ }
    });
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
  }
}

/**
 * A list of rows for a menu sheet: [{ label, sub, icon, danger, onSelect }].
 * Each row closes the sheet first unless it says `keep: true`.
 */
export function sheetRows(items, sheet) {
  return el('div', { class: 'sheet-rows' },
    ...items.filter(Boolean).map((it) => el('button', {
      class: 'sheet-row' + (it.danger ? ' danger' : ''), type: 'button',
      disabled: it.disabled || null,
      onclick: () => { if (!it.keep) sheet()?.close(); it.onSelect?.(); },
    },
    it.icon ? el('span', { class: 'sheet-row-ico', html: it.icon, 'aria-hidden': 'true' }) : null,
    el('span', { class: 'sheet-row-txt' },
      el('span', { class: 'sheet-row-label', text: it.label }),
      it.sub ? el('span', { class: 'sheet-row-sub', text: it.sub }) : null),
    it.value ? el('span', { class: 'sheet-row-val', text: it.value }) : null)));
}
