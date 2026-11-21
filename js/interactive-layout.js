import { el } from './util.js';
import { t } from './i18n.js';
import { GAP, ROW, canPlace, restoreLayout, pixelBox } from './layout-grid.js';

const DEFINITIONS = [
  { id: 'scramble', selector: '#scramble-zone', title: 'Scramble', min: [240, 88] },
  { id: 'timer', selector: '#timer-core', title: 'Timer', min: [240, 136] },
  { id: 'times', selector: '#panel-times', title: 'Times', min: [196, 160] },
  { id: 'stats', selector: '#panel-stats', title: 'Stats', min: [196, 136] },
  { id: 'spotify', selector: '#panel-spotify', title: 'Spotify', min: [196, 184], empty: 'Link Spotify to show now playing.' },
  { id: 'cube', selector: '#panel-cube', title: 'Scramble preview', min: [128, 160] },
  { id: 'ao5', selector: '#timer-ao5', title: 'ao5', min: [112, 40], average: true },
  { id: 'ao12', selector: '#timer-ao12', title: 'ao12', min: [112, 40], average: true },
  { id: 'bpa', selector: '#timer-bpa-value', title: 'BPA', min: [96, 40], average: true },
  { id: 'wpa', selector: '#timer-wpa-value', title: 'WPA', min: [96, 40], average: true },
  { id: 'race', selector: '#panel-race', title: 'Race', min: [240, 184], optional: true },
  { id: 'virtual', selector: '#vcube-wrap', title: 'Virtual cube', min: [240, 240], optional: true },
  { id: 'smart', selector: '#smart-cube-wrap', title: 'Smart cube', min: [280, 240], optional: true },
  { id: 'metronome', selector: '#metro', title: 'Metronome', min: [180, 208], optional: true },
  { id: 'mascot', selector: '#mascot', title: 'Mascot', min: [128, 128], optional: true },
];

export function initInteractiveLayout(app, { busy, beforeEdit, onLayout, onEditing, notice }) {
  const root = document.querySelector('#app');
  const viewport = el('div', { id: 'layout-viewport', hidden: true });
  const canvas = el('div', { id: 'layout-canvas' });
  const preview = el('div', { class: 'layout-preview', hidden: true, 'aria-hidden': 'true' });
  canvas.append(preview); viewport.append(canvas); root.append(viewport);
  const entries = new Map();
  let layout = {}, grid = null, profile = '', editing = false, active = false;
  let selected = 'timer', gesture = null, scheduled = false, undoStack = [];
  let scrollFrame = 0;
  let lastGeometry = '', lastSaved = '';

  const status = el('span', { class: 'layout-status', role: 'status', 'aria-live': 'polite', text: t('All changes snap to the grid.') });
  const picker = el('select', { 'aria-label': t('Widget to resize') });
  const width = el('input', { type: 'number', min: 1, step: 1, 'aria-label': t('Widget width in columns') });
  const height = el('input', { type: 'number', min: 1, step: 1, 'aria-label': t('Widget height in rows') });
  const dimensions = el('span', { class: 'layout-dimensions' });
  const undo = el('button', { type: 'button', class: 'ghost-btn sm', text: t('Undo'), onclick: () => undoEdit() });
  const toolbar = el('div', { id: 'layout-toolbar', role: 'toolbar', 'aria-label': t('Layout editor'), hidden: true },
    el('div', { class: 'layout-toolbar-main' },
      el('strong', { text: t('Edit layout') }), picker,
      el('label', {}, t('Width'), width, el('small', { text: t('cols') })),
      el('label', {}, t('Height'), height, el('small', { text: t('rows') })), dimensions,
      undo,
      el('button', { type: 'button', class: 'ghost-btn sm', text: t('Reset widget'), onclick: () => resetWidget(selected) }),
      el('button', { type: 'button', class: 'ghost-btn sm', text: t('Reset layout'), onclick: () => reset() }),
      el('button', { type: 'button', class: 'layout-done', text: t('Done'), onclick: () => app.setSetting('interactiveResizing', false) })),
    status);
  root.append(toolbar);

  const toggleClass = (node, name, value) => {
    if (node.classList.contains(name) !== value) node.classList.toggle(name, value);
  };
  const saved = () => app.settings.widgetLayouts?.[profile] || {};
  const supported = () => innerWidth > 860 && !document.body.matches('.zen, .sotd, .scrambles-only, .fmc');
  const primary = () => !busy();

  function initial(id) {
    const c = grid.columns, side = Math.floor(c * .22), center = side + 1, middle = c - 2 * center;
    const ty = Math.max(6, Math.floor(grid.visibleRows / 2) - 4);
    const aw = Math.floor(middle / 2), ay = ty + 8;
    const boxes = {
      scramble: { x: center, y: 0, w: middle, h: 5 },
      timer: { x: center, y: ty, w: middle, h: 8 },
      times: { x: 0, y: 0, w: side, h: Math.max(12, grid.visibleRows - 10) },
      spotify: { x: 0, y: Math.max(12, grid.visibleRows - 10), w: side, h: 9 },
      stats: { x: c - side, y: 0, w: side, h: 11 },
      cube: { x: c - side, y: Math.max(12, grid.visibleRows - 10), w: side, h: 9 },
      ao5: { x: center, y: ay, w: aw, h: 3 },
      ao12: { x: center + aw, y: ay, w: middle - aw, h: 3 },
      bpa: { x: center, y: ay + 3, w: aw, h: 2 },
      wpa: { x: center + aw, y: ay + 3, w: middle - aw, h: 2 },
      metronome: { x: 0, y: grid.visibleRows + 1, w: side, h: 10 },
      mascot: { x: c - side, y: grid.visibleRows + 1, w: side, h: 9 },
    };
    return boxes[id] || { x: center, y: grid.visibleRows + 1, w: middle, h: 12 };
  }

  function visible(entry) {
    const { id, node } = entry;
    const avgs = document.querySelector('#timer-avgs');
    if (id === 'ao5') return !avgs.hidden && !avgs.classList.contains('no-avg');
    if (id === 'ao12') return !avgs.hidden && !avgs.classList.contains('solo') && !avgs.classList.contains('no-avg');
    if (id === 'bpa' || id === 'wpa') return !avgs.hidden && !document.querySelector('#timer-bpa').hidden;
    return !node.hidden && node.style.display !== 'none';
  }

  function register() {
    for (const def of DEFINITIONS) {
      if (entries.has(def.id)) continue;
      const node = document.querySelector(def.selector);
      if (!node) continue;
      const anchor = document.createComment(`layout home: ${def.id}`);
      node.before(anchor);
      const grip = el('button', { type: 'button', class: 'layout-move',
        text: `⠿ ${t(def.title)}`, 'aria-label': t('Move {widget}', { widget: t(def.title) }),
        title: t('Drag to move. Arrow keys move; Shift + arrows resize.') });
      const tools = el('div', { class: 'layout-widget-tools' }, grip);
      const content = el('div', { class: `layout-content${def.average ? ' layout-average' : ''}` });
      const placeholder = el('div', { class: 'layout-placeholder', text: t(def.empty || 'Hidden during normal use.') });
      const shell = el('section', { class: 'layout-widget', dataset: { widget: def.id },
        'aria-label': t('{widget} widget', { widget: t(def.title) }) }, content, placeholder, tools);
      for (const direction of ['e', 's', 'se']) shell.append(el('button', {
        type: 'button', class: `layout-resize layout-resize-${direction}`, dataset: { resize: direction },
        'aria-label': t('Resize {widget}', { widget: t(def.title) }),
        title: t('Drag to resize. Arrow keys resize one grid step.') }));
      entries.set(def.id, { ...def, node, anchor, shell, content, grip });
      observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
    }
  }

  const minimum = id => {
    const entry = entries.get(id);
    return { w: Math.min(grid.columns, Math.ceil((entry.min[0] + GAP) / grid.step)),
      h: Math.ceil((entry.min[1] + GAP) / ROW) };
  };
  const specifications = () => [...entries.values()].filter(e => !e.optional || visible(e) || saved()[e.id])
    .map(e => ({ id: e.id, initial: initial(e.id), minimum: minimum(e.id) }));

  function mount() {
    for (const entry of entries.values()) {
      if (!layout[entry.id]) continue;
      if (entry.node.parentElement !== entry.content) {
        if (entry.node.dataset.tile) {
          entry.legacyDock = entry.node.dataset.dock;
          entry.node.dataset.dock = 'grid';
        }
        entry.content.append(entry.node);
      }
      if (entry.shell.parentElement !== canvas) canvas.append(entry.shell);
    }
  }

  function unmount() {
    // Restore children before their parents (averages belong inside the timer).
    for (const entry of [...entries.values()].reverse()) {
      if (entry.node.parentElement === entry.content) entry.anchor.after(entry.node);
      if (entry.node.dataset.dock === 'grid') {
        if (entry.legacyDock) entry.node.dataset.dock = entry.legacyDock;
        else delete entry.node.dataset.dock;
      }
      entry.shell.remove();
    }
  }

  function place(node, box) {
    const rect = pixelBox(box, grid.step);
    for (const [key, value] of Object.entries(rect)) node.style[key] = `${value}px`;
  }

  function render() {
    if (!active) return;
    mount();
    for (const entry of entries.values()) {
      const box = layout[entry.id];
      if (!box) { entry.shell.hidden = true; continue; }
      place(entry.shell, box);
      const shown = visible(entry);
      entry.shell.hidden = !shown && !editing;
      entry.shell.classList.toggle('layout-empty', !shown && !entry.average);
      entry.shell.classList.toggle('layout-selected', selected === entry.id);
      entry.shell.style.setProperty('--widget-width', `${box.w * grid.step - GAP}px`);
      entry.shell.style.setProperty('--widget-height', `${box.h * ROW - GAP}px`);
    }
    const rows = Math.max(grid.visibleRows, ...Object.values(layout).map(b => b.y + b.h));
    canvas.style.height = `${rows * ROW}px`;
    canvas.style.setProperty('--layout-column', `${grid.step}px`);
    picker.replaceChildren(...[...entries.values()].filter(e => layout[e.id]).map(e =>
      el('option', { value: e.id, text: t(e.title) })));
    picker.value = selected;
    syncFields();
  }

  function syncFields() {
    const box = layout[selected];
    if (!box || !grid) return;
    const min = minimum(selected), px = pixelBox(box, grid.step);
    width.min = min.w; width.max = grid.columns; width.value = box.w;
    height.min = min.h; height.max = 240; height.value = box.h;
    dimensions.textContent = `${Math.round(px.width)} × ${Math.round(px.height)} px`;
    undo.disabled = !undoStack.length;
  }

  function select(id) {
    if (!layout[id]) return;
    selected = id; picker.value = id;
    for (const e of entries.values()) e.shell.classList.toggle('layout-selected', e.id === id);
    syncFields();
  }

  function persist() {
    app.settings.widgetLayouts = { ...app.settings.widgetLayouts,
      [profile]: { ...saved(), ...structuredClone(layout) } };
    lastSaved = JSON.stringify(saved());
    app.persist({ immediate: true });
  }

  function commit(id, box) {
    if (!canPlace(layout, id, box, grid.columns, minimum(id))) {
      status.textContent = t('That space is occupied or outside the grid. Your layout has been kept.');
      syncFields(); return false;
    }
    if (JSON.stringify(box) === JSON.stringify(layout[id])) return true;
    undoStack.push(structuredClone(layout));
    if (undoStack.length > 40) undoStack.shift();
    layout[id] = { ...box }; persist(); render(); onLayout();
    status.textContent = t('Layout saved.'); return true;
  }

  function undoEdit() {
    cancelGesture();
    if (!undoStack.length) return;
    layout = undoStack.pop(); persist(); render(); onLayout();
    status.textContent = t('Last layout change undone.');
  }

  function resetWidget(id) {
    const specs = specifications(), spec = specs.find(s => s.id === id);
    if (!spec) return;
    const remaining = { ...layout }; delete remaining[id];
    const placed = restoreLayout({ ...remaining, [id]: initial(id) },
      [...specs.filter(s => s.id !== id), spec], grid.columns);
    commit(id, placed[id]);
  }

  function reset() {
    cancelGesture();
    if (!active) {
      app.settings.widgetLayouts = null; app.settings.interactiveResizing = false;
      app.persist(); update(); return;
    }
    undoStack.push(structuredClone(layout));
    layout = restoreLayout(null, specifications(), grid.columns);
    persist(); render(); onLayout(); status.textContent = t('Default grid restored.');
  }

  function cancelGesture() {
    if (!gesture) return;
    const g = gesture; gesture = null; preview.hidden = true;
    cancelAnimationFrame(scrollFrame);
    entries.get(g.id)?.shell.classList.remove('layout-moving');
    if (g.handle.hasPointerCapture?.(g.pointerId)) g.handle.releasePointerCapture(g.pointerId);
  }

  function candidate(event) {
    const g = gesture, dx = Math.round((event.clientX - g.x) / grid.step);
    const dy = Math.round((event.clientY - g.y + viewport.scrollTop - g.scrollTop) / ROW);
    const box = { ...g.box };
    if (!g.direction) { box.x += dx; box.y += dy; }
    else {
      if (g.direction.includes('e')) box.w += dx;
      if (g.direction.includes('s')) box.h += dy;
    }
    // Resizes stop at minimum size; invalid positions are shown and rejected.
    if (g.direction) {
      const min = minimum(g.id); box.w = Math.max(min.w, box.w); box.h = Math.max(min.h, box.h);
    }
    return box;
  }

  function paintCandidate(event) {
    gesture.next = candidate(event);
    const valid = canPlace(layout, gesture.id, gesture.next, grid.columns, minimum(gesture.id));
    place(preview, gesture.next); preview.hidden = false;
    preview.classList.toggle('invalid', !valid);
    status.textContent = valid ? t('Release to snap into place.') : t('Occupied or outside the grid. Choose a clear space.');
  }

  function autoScroll() {
    if (!gesture) return;
    const rect = viewport.getBoundingClientRect(), event = gesture.lastEvent;
    const delta = event.clientY < rect.top + 28 ? -8 : event.clientY > rect.bottom - 28 ? 8 : 0;
    const previous = viewport.scrollTop;
    if (delta) viewport.scrollTop += delta;
    if (previous !== viewport.scrollTop) paintCandidate(event);
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  canvas.addEventListener('pointerdown', event => {
    if (!editing || !event.isPrimary || event.button !== 0) return;
    const shell = event.target.closest('.layout-widget');
    if (!shell) return;
    select(shell.dataset.widget);
    const handle = event.target.closest('.layout-move, .layout-resize');
    if (!handle) return;
    cancelGesture();
    gesture = { id: selected, x: event.clientX, y: event.clientY, pointerId: event.pointerId,
      box: { ...layout[selected] }, direction: handle.dataset.resize || '', handle, next: null,
      scrollTop: viewport.scrollTop, lastEvent: event };
    handle.setPointerCapture(event.pointerId); event.preventDefault();
    shell.classList.add('layout-moving');
    scrollFrame = requestAnimationFrame(autoScroll);
  });
  canvas.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (event.buttons === 0) { cancelGesture(); return; }
    gesture.lastEvent = event; paintCandidate(event);
  });
  canvas.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const { id } = gesture, box = candidate(event);
    cancelGesture(); commit(id, box);
  });
  canvas.addEventListener('pointercancel', cancelGesture);
  canvas.addEventListener('lostpointercapture', cancelGesture);
  addEventListener('blur', cancelGesture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGesture(); });

  picker.addEventListener('change', () => {
    select(picker.value); entries.get(selected)?.shell.scrollIntoView({ block: 'nearest' });
  });
  const resizeFields = () => {
    if (!editing || !layout[selected]) return;
    commit(selected, { ...layout[selected], w: Number(width.value), h: Number(height.value) });
  };
  width.addEventListener('change', resizeFields); height.addEventListener('change', resizeFields);
  for (const input of [width, height]) input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); resizeFields(); }
  });

  function keydown(event) {
    if (!editing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (gesture) cancelGesture(); else app.setSetting('interactiveResizing', false);
      return;
    }
    const control = event.target.closest('.layout-move, .layout-resize');
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'
        && !event.target.matches('input, textarea')) {
      event.preventDefault(); event.stopImmediatePropagation(); undoEdit(); return;
    }
    if (control && direction) {
      event.preventDefault(); event.stopImmediatePropagation();
      const id = control.closest('[data-widget]').dataset.widget; select(id);
      const box = { ...layout[id] }, resizing = event.shiftKey || control.matches('.layout-resize');
      box[resizing ? 'w' : 'x'] += direction[0]; box[resizing ? 'h' : 'y'] += direction[1];
      if (commit(id, box)) entries.get(id).shell.scrollIntoView({ block: 'nearest' });
    }
  }

  function update() {
    scheduled = false;
    if (!app.settings || busy()) return;
    const want = supported() && (!!app.settings.interactiveResizing || !!app.settings.widgetLayouts?.desktop || !!app.settings.widgetLayouts?.tablet);
    if (!want) {
      const wasActive = active;
      const wasEditing = editing;
      cancelGesture(); editing = active = false;
      toggleClass(document.body, 'layout-custom', false); toggleClass(document.body, 'layout-editing', false);
      toolbar.hidden = viewport.hidden = true; unmount(); lastGeometry = ''; lastSaved = '';
      if (wasEditing) onEditing(false);
      if (wasActive) onLayout();
      return;
    }
    profile = innerWidth <= 1100 ? 'tablet' : 'desktop';
    const top = Math.ceil(document.querySelector('#topbar').getBoundingClientRect().bottom + 24);
    viewport.style.top = `${top}px`;
    const available = Math.max(240, innerHeight - top - 76), columns = profile === 'tablet' ? 16 : 24;
    const nextGrid = { columns, step: (innerWidth - 24 + GAP) / columns, visibleRows: Math.max(26, Math.floor(available / ROW)) };
    const geometry = JSON.stringify([profile, nextGrid]);
    const wasActive = active, wasEditing = editing;
    active = true; editing = !!app.settings.interactiveResizing;
    if (wasEditing !== editing) onEditing(editing);
    toggleClass(document.body, 'layout-custom', true); toggleClass(document.body, 'layout-editing', editing);
    toolbar.hidden = !editing; viewport.hidden = false;
    grid = nextGrid; register();
    const specs = specifications();
    const regenerated = !wasActive || geometry !== lastGeometry || JSON.stringify(saved()) !== lastSaved || specs.some(s => !layout[s.id]);
    if (regenerated) {
      cancelGesture(); undoStack = [];
      layout = restoreLayout(saved(), specs, columns); lastGeometry = geometry; lastSaved = JSON.stringify(saved());
      if (!Object.keys(saved()).length) persist();
    }
    if (!layout[selected]) selected = 'timer';
    render();
    if (regenerated) onLayout();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true; requestAnimationFrame(update);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-input'], childList: true });
  for (const selector of ['#sidebar', '#sidebar-right', '#tile-float-layer']) {
    const host = document.querySelector(selector);
    if (host) observer.observe(host, { childList: true });
  }
  for (const selector of ['#timer-avgs', '#timer-bpa']) {
    const node = document.querySelector(selector);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
  new ResizeObserver(schedule).observe(document.querySelector('#topbar'));
  addEventListener('resize', () => { cancelGesture(); schedule(); });
  const api = {
    get editing() { return editing; }, get active() { return active; },
    update, keydown, reset, resetWidget,
    start() {
      if (!supported()) { notice(t('Layout editing is available in a desktop or tablet window wider than 860px.')); return; }
      if (!primary()) { notice(t('Finish the current attempt before editing the layout.')); return; }
      beforeEdit(); app.setSetting('interactiveResizing', true); update();
      entries.get('timer')?.grip.focus();
    },
  };
  update(); return api;
}
