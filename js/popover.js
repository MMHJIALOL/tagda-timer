/* ===========================================================
   Tagda Timer — anchored popover menus
   =========================================================== */

import { $, el } from './util.js';

let openCleanup = null;

export function closePopover() {
  if (openCleanup) { openCleanup(); openCleanup = null; }
}

export const popoverOpen = () => !!openCleanup;

/**
 * items: array of
 *   { label, badge, on, icon, onSelect }  |  { sep: true }  |  { title: 'text' }
 */
export function popover(anchor, items, { columns = 1, minWidth } = {}) {
  closePopover();
  const pop = $('#popover');
  pop.innerHTML = '';
  pop.hidden = false;
  if (minWidth) pop.style.minWidth = minWidth + 'px';

  const body = columns > 1 ? el('div', { class: 'pop-cols' }) : pop;

  for (const it of items) {
    if (it.sep)   { pop.append(el('div', { class: 'pop-sep' })); continue; }
    if (it.title) { pop.append(el('div', { class: 'pop-title', text: it.title })); continue; }
    const btn = el('button', { class: `pop-item ${it.on ? 'on' : ''}` });
    if (it.on) btn.append(el('span', { class: 'pi-dot' }));
    btn.append(el('span', { text: it.label }));
    if (it.badge) btn.append(el('span', { class: 'pi-badge', text: it.badge }));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePopover();
      it.onSelect?.();
    });
    body.append(btn);
  }
  if (columns > 1) pop.append(body);

  // position under the anchor, clamped to the viewport
  const r = anchor.getBoundingClientRect();
  pop.style.left = '0px'; pop.style.top = '0px';
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(10, Math.min(left, innerWidth - pr.width - 10));
  let top = r.bottom + 8;
  if (top + pr.height > innerHeight - 10) top = Math.max(10, r.top - pr.height - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  openCleanup = () => {
    pop.hidden = true; pop.innerHTML = ''; pop.style.minWidth = '';
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
}
