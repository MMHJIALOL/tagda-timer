/* ===========================================================
   Tagda Timer — command palette (Ctrl+K)
   =========================================================== */

import { $, el } from './util.js';

let open = false;
let items = [];
let filtered = [];
let cursor = 0;

export const paletteOpen = () => open;

function score(item, q) {
  if (!q) return 1;
  const hay = (item.label + ' ' + (item.kind || '') + ' ' + (item.keywords || '')).toLowerCase();
  if (hay.startsWith(q)) return 100;
  const i = hay.indexOf(q);
  if (i >= 0) return 60 - i * 0.2;
  // subsequence match
  let pos = 0;
  for (const ch of q) {
    pos = hay.indexOf(ch, pos);
    if (pos === -1) return 0;
    pos++;
  }
  return 10;
}

function render() {
  const list = $('#pal-list');
  list.innerHTML = '';
  if (!filtered.length) {
    list.append(el('div', { class: 'pal-empty', text: 'Nothing matches that' }));
    return;
  }
  filtered.forEach((it, i) => {
    const node = el('button', { class: `pal-item ${i === cursor ? 'cursor' : ''}` },
      el('span', { class: 'pal-kind', text: it.kind || 'go' }),
      el('span', { text: it.label }),
      it.key ? el('kbd', { class: 'pal-key', text: it.key }) : null,
    );
    node.addEventListener('mousemove', () => { cursor = i; paint(); });
    node.addEventListener('click', () => run(it));
    list.append(node);
  });
  const cur = list.children[cursor];
  cur?.scrollIntoView({ block: 'nearest' });
}

function paint() {
  const list = $('#pal-list');
  [...list.children].forEach((c, i) => c.classList.toggle('cursor', i === cursor));
  list.children[cursor]?.scrollIntoView({ block: 'nearest' });
}

function run(it) {
  closePalette();
  setTimeout(() => it.run(), 30);
}

function filter(q) {
  const query = q.trim().toLowerCase();
  filtered = items
    .map(it => ({ it, s: score(it, query) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map(x => x.it);
  cursor = 0;
  render();
}

export function openPalette(buildItems) {
  items = buildItems();
  open = true;
  const pal = $('#palette');
  const input = $('#pal-input');
  pal.hidden = false;
  input.value = '';
  filter('');
  setTimeout(() => input.focus(), 10);

  input.oninput = () => filter(input.value);
  pal.onmousedown = (e) => { if (e.target === pal) closePalette(); };

  document.addEventListener('keydown', onKey, true);
}

export function closePalette() {
  if (!open) return;
  open = false;
  const pal = $('#palette');
  pal.hidden = true;
  // Give focus back to the page: while the (now hidden) input still holds it,
  // every keyboard shortcut — spacebar included — would be treated as typing.
  $('#pal-input').blur();
  if (pal.contains(document.activeElement)) document.activeElement.blur();
  document.removeEventListener('keydown', onKey, true);
}

function onKey(e) {
  if (!open) return;
  if (e.key === 'Escape')      { e.preventDefault(); e.stopPropagation(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); cursor = Math.min(filtered.length - 1, cursor + 1); paint(); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); e.stopPropagation(); cursor = Math.max(0, cursor - 1); paint(); }
  else if (e.key === 'Enter')     { e.preventDefault(); e.stopPropagation(); if (filtered[cursor]) run(filtered[cursor]); }
  else e.stopPropagation();      // keep global shortcuts from firing while typing
}
