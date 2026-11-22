import { el } from './util.js';
import { t } from './i18n.js';
import { GAP, ROW, MAX_ROWS, canPlace, restoreLayout, pixelBox, gridBox, resizeBox, reprojectLayout, isGeneratedLayout } from './layout-grid.js';

const DEFINITIONS = [
  { id: 'scramble', selector: '#scramble-zone', title: 'Scramble', min: [240, 88] },
  { id: 'timer', selector: '#timer-core', title: 'Timer', min: [240, 136] },
  { id: 'times', selector: '#panel-times', title: 'Times', min: [196, 160] },
  { id: 'stats', selector: '#panel-stats', title: 'Stats', min: [196, 112] },
  { id: 'spotify', selector: '#panel-spotify', title: 'Spotify', min: [196, 184], empty: 'Link Spotify to show now playing.' },
  { id: 'cube', selector: '#panel-cube', title: 'Scramble preview', min: [128, 160] },
  { id: 'ao5', selector: '#timer-ao5', title: 'ao5', min: [64, 32], average: true },
  { id: 'ao12', selector: '#timer-ao12', title: 'ao12', min: [64, 32], average: true },
  { id: 'bpa', selector: '#timer-bpa-value', title: 'BPA', min: [64, 24], average: true },
  { id: 'wpa', selector: '#timer-wpa-value', title: 'WPA', min: [64, 24], average: true },
  { id: 'race', selector: '#panel-race', title: 'Race', min: [240, 184], optional: true },
  { id: 'virtual', selector: '#vcube-wrap', title: 'Virtual cube', min: [240, 240], optional: true },
  { id: 'smart', selector: '#smart-cube-wrap', title: 'Smart cube', min: [280, 240], optional: true },
  { id: 'metronome', selector: '#metro', title: 'Metronome', min: [180, 208], optional: true },
  { id: 'mascot', selector: '#mascot', title: 'Mascot', min: [128, 128], optional: true },
];

export function initInteractiveLayout(app, { busy, ready = () => true, beforeEdit, onLayout, onEditing, notice }) {
  const root = document.querySelector('#app');
  const viewport = el('div', { id: 'layout-viewport', hidden: true });
  const canvas = el('div', { id: 'layout-canvas' });
  const preview = el('div', { class: 'layout-preview', hidden: true, 'aria-hidden': 'true' });
  canvas.append(preview); viewport.append(canvas); root.append(viewport);
  const entries = new Map();
  let layout = {}, grid = null, profile = '', editing = false, active = false;
  let bases = {}, manual = new Set();
  let selected = 'timer', gesture = null, scheduled = false, undoStack = [];
  let captureProfile = '';
  let scrollFrame = 0;
  let lastGeometry = '', lastSaved = '', lastAverages = '';
  const initialLayouts = {}, initialGrids = {};

  const status = el('span', { class: 'layout-status', role: 'status', 'aria-live': 'polite', text: t('Drag any border or corner to resize. Drag inside a widget to move it.') });
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
  const savedSignature = () => JSON.stringify([saved(), app.settings.widgetLayouts?.grids?.[profile],
    app.settings.widgetLayouts?.bases?.[profile], app.settings.widgetLayouts?.manual?.[profile]]);
  const projected = (boxes = saved()) => reprojectLayout(boxes, app.settings.widgetLayouts?.grids?.[profile]
    || { columns: profile === 'tablet' ? 16 : 24, row: 24 }, { columns: grid.columns, row: ROW });
  const supported = () => innerWidth > 860 && !document.body.matches('.zen, .sotd, .scrambles-only, .fmc');
  const primary = () => !busy();

  function initial(id) {
    if (initialLayouts[profile]?.[id]) return reprojectLayout({ [id]: initialLayouts[profile][id] },
      initialGrids[profile], { columns: grid.columns, row: ROW })[id];
    if (entries.get(id)?.average) return averageBoxes(projected())[id];
    const c = grid.columns, side = Math.floor(c * .22), center = side + 1, middle = c - 2 * center;
    const ty = Math.max(18, Math.floor(grid.visibleRows / 2) - 12);
    const aw = Math.floor(middle / 2), ay = ty + 24;
    const boxes = {
      scramble: { x: center, y: 0, w: middle, h: 15 },
      timer: { x: center, y: ty, w: middle, h: 24 },
      times: { x: 0, y: 0, w: side, h: Math.max(36, grid.visibleRows - 30) },
      spotify: { x: 0, y: Math.max(36, grid.visibleRows - 30), w: side, h: 27 },
      stats: { x: c - side, y: 0, w: side, h: 33 },
      cube: { x: c - side, y: Math.max(36, grid.visibleRows - 30), w: side, h: 27 },
      ao5: { x: center, y: ay, w: aw, h: 9 },
      ao12: { x: center + aw, y: ay, w: middle - aw, h: 9 },
      bpa: { x: center, y: ay + 9, w: aw, h: 6 },
      wpa: { x: center + aw, y: ay + 9, w: middle - aw, h: 6 },
      metronome: { x: 0, y: grid.visibleRows + 1, w: side, h: 30 },
      mascot: { x: c - side, y: grid.visibleRows + 1, w: side, h: 27 },
    };
    return boxes[id] || { x: center, y: grid.visibleRows + 1, w: middle, h: 36 };
  }

  function visible(entry) {
    const { id, node } = entry;
    const avgs = document.querySelector('#timer-avgs');
    if (id === 'ao5') return !avgs.hidden && !avgs.classList.contains('no-avg');
    if (id === 'ao12') return !avgs.hidden && !avgs.classList.contains('solo') && !avgs.classList.contains('no-avg');
    if (id === 'bpa' || id === 'wpa') return !avgs.hidden && !document.querySelector('#timer-bpa').hidden;
    return !node.hidden && getComputedStyle(node).display !== 'none';
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
      for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) shell.append(el('button', {
        type: 'button', class: `layout-resize layout-resize-${direction}`, dataset: { resize: direction },
        'aria-label': `${t('Resize {widget}', { widget: t(def.title) })} (${direction})`,
        title: t('Drag to resize. Arrow keys resize one grid step.') }));
      entries.set(def.id, { ...def, node, anchor, shell, content, grip });
      observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
    }
  }

  const minimum = id => {
    const entry = entries.get(id);
    const captured = initialLayouts[profile]?.[id];
    const current = captured && reprojectLayout({ [id]: captured }, initialGrids[profile],
      { columns: grid.columns, row: ROW })[id];
    return { w: Math.min(grid.columns, current?.w ?? grid.columns, Math.ceil((entry.min[0] + GAP) / grid.step)),
      h: Math.min(current?.h ?? MAX_ROWS, Math.ceil((entry.min[1] + GAP) / ROW)) };
  };
  const specifications = () => [...entries.values()].filter(visible)
    .map(e => ({ id: e.id, initial: initial(e.id), minimum: minimum(e.id) }));

  const textMeasure = document.createElement('canvas').getContext('2d');
  function averageBoxes(current) {
    const timer = current.timer || initial('timer'), boxes = {};
    let y = timer.y + timer.h + 1;
    for (const [ids, gap] of [[['ao5', 'ao12'], 2], [['bpa', 'wpa'], 0]]) {
      const row = ids.filter(id => visible(entries.get(id)) && !manual.has(id)).map(id => {
        const entry = entries.get(id), parts = [...entry.node.querySelectorAll('b, i')];
        const metrics = parts.map(node => {
          const css = getComputedStyle(node);
          textMeasure.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
          return { width: textMeasure.measureText(node.textContent).width
            + (parseFloat(css.letterSpacing) || 0) * node.textContent.length,
          height: parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.2 };
        });
        const min = minimum(id);
        return { id, w: Math.max(min.w, Math.ceil((metrics.reduce((sum, m) => sum + m.width, 12) + GAP) / grid.step)),
          h: Math.max(min.h, Math.ceil((Math.max(...metrics.map(m => m.height)) + GAP) / ROW)) };
      });
      if (!row.length) continue;
      const total = row.reduce((sum, box) => sum + box.w, 0) + gap * (row.length - 1);
      let x = Math.max(0, Math.min(grid.columns - total, Math.round(timer.x + (timer.w - total) / 2)));
      for (const { id, w, h } of row) { boxes[id] = { x, y, w, h }; x += w + gap; }
      y += Math.max(...row.map(box => box.h));
    }
    return boxes;
  }

  function arrangeAverages(current) {
    const automatic = averageBoxes(current), fixed = Object.fromEntries(Object.entries(current)
      .filter(([id]) => !automatic[id]));
    const specs = Object.keys(current).map(id => ({ id, minimum: minimum(id), initial: automatic[id] || current[id] }));
    const arranged = restoreLayout(fixed, specs, grid.columns);
    for (const id of Object.keys(automatic)) if (arranged[id]) bases[id] = { ...arranged[id] };
    return arranged;
  }

  const snapshot = () => ({ layout: structuredClone(layout), bases: structuredClone(bases), manual: [...manual] });
  const collisionLayout = id => id === 'timer' ? Object.fromEntries(Object.entries(layout)
    .filter(([other]) => !entries.get(other).average || manual.has(other))) : layout;

  function captureLayout(top) {
    const measured = {};
    for (const entry of entries.values()) {
      if (!visible(entry)) continue;
      const rect = entry.node.getBoundingClientRect();
      if (rect.width && rect.height) measured[entry.id] = gridBox(rect, { left: 12, top }, grid.step);
    }
    initialLayouts[profile] = measured;
    initialGrids[profile] = { columns: grid.columns, row: ROW };
  }

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
      const base = bases[entry.id] || box;
      const scale = Math.min((box.w * grid.step - GAP) / (base.w * grid.step - GAP),
        (box.h * ROW - GAP) / (base.h * ROW - GAP));
      entry.shell.style.setProperty('--layout-scale', Math.max(.15, scale));
    }
    const rows = Math.max(grid.visibleRows, ...Object.values(layout).map(b => b.y + b.h)) + (editing ? 10 : 0);
    canvas.style.height = `${rows * ROW}px`;
    canvas.style.setProperty('--layout-column', `${grid.step}px`);
    canvas.style.setProperty('--layout-row', `${ROW}px`);
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
    height.min = min.h; height.max = MAX_ROWS; height.value = box.h;
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
      [profile]: { ...projected(), ...structuredClone(layout) },
      grids: { ...app.settings.widgetLayouts?.grids, [profile]: { columns: grid.columns, row: ROW } },
      bases: { ...app.settings.widgetLayouts?.bases, [profile]: { ...projected(app.settings.widgetLayouts?.bases?.[profile] || {}), ...structuredClone(bases) } },
      manual: { ...app.settings.widgetLayouts?.manual, [profile]: [...manual] } };
    lastSaved = savedSignature();
    app.persist({ immediate: true });
  }

  function commit(id, box, { resetBase = false } = {}) {
    if (!canPlace(collisionLayout(id), id, box, grid.columns, minimum(id))) {
      status.textContent = t('That space is occupied or outside the grid. Your layout has been kept.');
      syncFields(); return false;
    }
    if (!resetBase && JSON.stringify(box) === JSON.stringify(layout[id])) return true;
    undoStack.push(snapshot());
    if (undoStack.length > 40) undoStack.shift();
    layout[id] = { ...box };
    if (entries.get(id).average) { if (resetBase) manual.delete(id); else manual.add(id); }
    if (resetBase) bases[id] = { ...box };
    if (id === 'timer') layout = arrangeAverages(layout);
    persist(); render(); onLayout();
    status.textContent = t('Layout saved.'); return true;
  }

  function undoEdit() {
    cancelGesture();
    if (!undoStack.length) return;
    const previous = undoStack.pop();
    layout = previous.layout; bases = previous.bases; manual = new Set(previous.manual);
    persist(); render(); onLayout();
    status.textContent = t('Last layout change undone.');
  }

  function resetWidget(id) {
    const specs = specifications(), spec = specs.find(s => s.id === id);
    if (!spec) return;
    const remaining = { ...layout }; delete remaining[id];
    const placed = restoreLayout({ ...remaining, [id]: initial(id) },
      [...specs.filter(s => s.id !== id), spec], grid.columns);
    commit(id, placed[id], { resetBase: true });
  }

  function reset() {
    cancelGesture();
    if (!active) {
      app.settings.widgetLayouts = null; app.settings.interactiveResizing = false;
      app.persist(); update(); return;
    }
    undoStack.push(snapshot()); manual.clear();
    layout = restoreLayout(null, specifications(), grid.columns);
    bases = structuredClone(layout); viewport.scrollTop = 0;
    persist(); render(); onLayout(); status.textContent = t('Starting layout restored.');
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
    else return resizeBox(box, g.direction, dx, dy, minimum(g.id));
    return box;
  }

  function paintCandidate(event) {
    gesture.next = candidate(event);
    const valid = canPlace(collisionLayout(gesture.id), gesture.id, gesture.next, grid.columns, minimum(gesture.id));
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

  function borderDirection(shell, event) {
    const rect = shell.getBoundingClientRect(), edge = 10;
    return (event.clientY - rect.top <= edge ? 'n' : rect.bottom - event.clientY <= edge ? 's' : '')
      + (event.clientX - rect.left <= edge ? 'w' : rect.right - event.clientX <= edge ? 'e' : '');
  }

  canvas.addEventListener('pointerdown', event => {
    if (!editing || !event.isPrimary || event.button !== 0) return;
    const shell = event.target.closest('.layout-widget');
    if (!shell) return;
    select(shell.dataset.widget);
    // In edit mode the whole widget is a move surface, on every side.
    const handle = event.target.closest('.layout-move, .layout-resize') || shell;
    cancelGesture();
    gesture = { id: selected, x: event.clientX, y: event.clientY, pointerId: event.pointerId,
      box: { ...layout[selected] }, direction: handle.dataset.resize
        || (handle === shell || entries.get(selected).average ? borderDirection(shell, event) : ''), handle, next: null,
      scrollTop: viewport.scrollTop, lastEvent: event };
    handle.setPointerCapture(event.pointerId); event.preventDefault();
    shell.classList.add('layout-moving');
    scrollFrame = requestAnimationFrame(autoScroll);
  });
  canvas.addEventListener('pointermove', event => {
    if (editing && !gesture) {
      const shell = event.target.closest('.layout-widget');
      if (shell) {
        const direction = borderDirection(shell, event);
        shell.style.cursor = ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
          ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' })[direction] || 'grab';
      }
    }
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
    select(picker.value); reveal(selected);
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
      let box = { ...layout[id] };
      if (control.matches('.layout-resize')) {
        box = resizeBox(box, control.dataset.resize, ...direction, minimum(id));
      } else {
        box[event.shiftKey ? 'w' : 'x'] += direction[0]; box[event.shiftKey ? 'h' : 'y'] += direction[1];
      }
      if (commit(id, box)) reveal(id);
    }
  }

  function reveal(id) {
    const box = layout[id], top = box.y * ROW, bottom = (box.y + box.h) * ROW;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
  }

  function update() {
    scheduled = false;
    if (!app.settings || !ready() || busy()) return;
    const want = supported() && (!!app.settings.interactiveResizing || !!app.settings.widgetLayouts?.desktop || !!app.settings.widgetLayouts?.tablet);
    if (!want) {
      const wasActive = active;
      const wasEditing = editing;
      cancelGesture(); editing = active = false;
      toggleClass(document.body, 'layout-custom', false); toggleClass(document.body, 'layout-editing', false);
      toolbar.hidden = viewport.hidden = true; unmount(); lastGeometry = ''; lastSaved = ''; lastAverages = '';
      if (wasEditing) onEditing(false);
      if (wasActive) onLayout();
      return;
    }
    const nextProfile = innerWidth <= 1100 ? 'tablet' : 'desktop';
    const wasActive = active, wasEditing = editing;
    // Measure before the canvas CSS and reparenting change the live page.
    const capture = !wasActive || profile !== nextProfile;
    if (capture && profile && profile !== nextProfile && captureProfile !== nextProfile) {
      cancelGesture(); unmount(); active = false;
      captureProfile = nextProfile;
      toggleClass(document.body, 'layout-custom', false); toggleClass(document.body, 'layout-editing', false);
      toolbar.hidden = viewport.hidden = true;
      onLayout();
      // The natural timer/preview positions are measured by ResizeObservers.
      // Let those settle after leaving the phone or another profile first.
      schedule(); return;
    }
    captureProfile = '';
    profile = nextProfile;
    if (!app.settings.widgetLayouts?.grids?.[profile]
        && isGeneratedLayout(saved(), profile === 'tablet' ? 16 : 24)) {
      delete app.settings.widgetLayouts[profile];
    }
    manual = new Set(app.settings.widgetLayouts?.manual?.[profile] || []);
    const top = Math.ceil(document.querySelector('#topbar').getBoundingClientRect().bottom + 16);
    viewport.style.top = `${top}px`;
    const available = Math.max(240, innerHeight - top - 12), columns = Math.floor((innerWidth - 24 + GAP) / 8);
    const nextGrid = { columns, step: (innerWidth - 24 + GAP) / columns, visibleRows: Math.max(26, Math.floor(available / ROW)) };
    const geometry = JSON.stringify([profile, nextGrid]);
    grid = nextGrid; register();
    if (capture) captureLayout(top);
    active = true; editing = !!app.settings.interactiveResizing;
    if (wasEditing !== editing) onEditing(editing);
    toggleClass(document.body, 'layout-custom', true); toggleClass(document.body, 'layout-editing', editing);
    toolbar.hidden = !editing; viewport.hidden = false;
    const specs = specifications();
    const averageSignature = JSON.stringify([app.settings.timerSize, [...entries.values()]
      .filter(entry => entry.average && visible(entry)).map(entry => [entry.id, entry.node.textContent])]);
    const averagesChanged = wasActive && !capture && averageSignature !== lastAverages;
    const widgetsChanged = specs.length !== Object.keys(layout).length || specs.some(s => !layout[s.id]);
    const regenerated = !wasActive || geometry !== lastGeometry || savedSignature() !== lastSaved
      || widgetsChanged || averagesChanged;
    if (regenerated) {
      cancelGesture(); undoStack = [];
      layout = restoreLayout(projected(), specs, columns); lastGeometry = geometry;
      const previousBases = projected(app.settings.widgetLayouts?.bases?.[profile] || {});
      bases = Object.fromEntries(Object.entries(layout).map(([id, box]) => [id, previousBases[id] || { ...box }]));
      if ((widgetsChanged || averagesChanged) && wasActive && !capture) layout = arrangeAverages(layout);
      // Resizing a window projects the canonical saved layout without repeatedly
      // rounding and overwriting it. Only an edit or a new widget changes it.
      lastSaved = savedSignature();
      if (!app.settings.widgetLayouts?.bases?.[profile] || ((widgetsChanged || averagesChanged) && wasActive && !capture)) persist();
    }
    lastAverages = averageSignature;
    if (!layout[selected]) selected = 'timer';
    if (wasEditing !== editing) viewport.scrollTop = 0;
    if (regenerated || wasEditing !== editing) render();
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
    update, refresh: schedule, keydown, reset, resetWidget,
    start() {
      if (!supported()) { notice(t('Layout editing is available in a desktop or tablet window wider than 860px.')); return; }
      if (!primary()) { notice(t('Finish the current attempt before editing the layout.')); return; }
      beforeEdit(); app.setSetting('interactiveResizing', true); update();
      entries.get('timer')?.grip.focus({ preventScroll: true });
    },
  };
  update(); return api;
}
