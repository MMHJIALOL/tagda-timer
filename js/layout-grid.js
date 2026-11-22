// Grid geometry is shared by dragging, resizing, keyboard edits and restoration.
// Coordinates and dimensions are always whole cells, never saved screen pixels.
export const GAP = 8;
export const ROW = 8;
export const MAX_ROWS = 720;

// The first editor saved its generated template even if no widget was edited.
// Recognize only that exact template; genuinely customized layouts are retained.
export function isGeneratedLayout(layout, columns = 24) {
  if (!layout?.times || Object.keys(layout).length !== 10) return false;
  const side = Math.floor(columns * .22), center = side + 1, middle = columns - 2 * center;
  const rows = layout.times.h + 10, ty = Math.max(6, Math.floor(rows / 2) - 4), aw = Math.floor(middle / 2);
  const expected = {
    scramble: { x: center, y: 0, w: middle, h: 5 }, timer: { x: center, y: ty, w: middle, h: 8 },
    times: { x: 0, y: 0, w: side, h: Math.max(12, rows - 10) },
    spotify: { x: 0, y: Math.max(12, rows - 10), w: side, h: 9 },
    stats: { x: columns - side, y: 0, w: side, h: 11 },
    cube: { x: columns - side, y: Math.max(12, rows - 10), w: side, h: 9 },
    ao5: { x: center, y: ty + 8, w: aw, h: 3 }, ao12: { x: center + aw, y: ty + 8, w: middle - aw, h: 3 },
    bpa: { x: center, y: ty + 11, w: aw, h: 2 }, wpa: { x: center + aw, y: ty + 11, w: middle - aw, h: 2 },
  };
  return rows >= 26 && Object.entries(expected).every(([id, box]) =>
    ['x', 'y', 'w', 'h'].every(key => layout[id]?.[key] === box[key]));
}

const integer = (value, fallback) => Number.isFinite(value) ? Math.round(value) : fallback;
export const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x
  && a.y < b.y + b.h && a.y + a.h > b.y;

// Start with the live page, within one small snap step of its current bounds.
export function gridBox(rect, origin, step) {
  return { x: Math.round((rect.left - origin.left) / step), y: Math.round((rect.top - origin.top) / ROW),
    w: Math.ceil((rect.width + GAP) / step), h: Math.ceil((rect.height + GAP) / ROW) };
}

// Keep the opposite edge fixed, including when a north/west handle hits its minimum.
export function resizeBox(box, direction, dx, dy, minimum = { w: 1, h: 1 }) {
  const next = { ...box };
  if (direction.includes('e')) next.w = Math.max(minimum.w, box.w + dx);
  if (direction.includes('s')) next.h = Math.max(minimum.h, box.h + dy);
  if (direction.includes('w')) {
    next.w = Math.max(minimum.w, box.w - dx); next.x = box.x + box.w - next.w;
  }
  if (direction.includes('n')) {
    next.h = Math.max(minimum.h, box.h - dy); next.y = box.y + box.h - next.h;
  }
  return next;
}

// Older layouts used 24px rows and 24/16 wide columns. Save the grid with the
// layout so those placements, and subsequent window resizes, retain their scale.
export function reprojectLayout(layout, from, to) {
  const sx = Number.isFinite(from?.columns) && from.columns > 0 ? to.columns / from.columns : 1;
  const sy = Number.isFinite(from?.row) && from.row > 0 ? from.row / to.row : 1;
  return Object.fromEntries(Object.entries(layout || {}).filter(([, box]) => box && typeof box === 'object').map(([id, box]) => [id, {
    x: Math.round(box.x * sx), y: Math.round(box.y * sy),
    w: Math.round(box.w * sx), h: Math.round(box.h * sy),
  }]));
}

export function constrain(box, columns, minimum = { w: 1, h: 1 }) {
  const w = Math.min(columns, Math.max(minimum.w, integer(box?.w, minimum.w)));
  const h = Math.min(MAX_ROWS, Math.max(minimum.h, integer(box?.h, minimum.h)));
  return { x: Math.max(0, Math.min(columns - w, integer(box?.x, 0))),
    y: Math.max(0, Math.min(MAX_ROWS - h, integer(box?.y, 0))), w, h };
}

export function canPlace(layout, id, box, columns, minimum = { w: 1, h: 1 }) {
  if (!box || !['x', 'y', 'w', 'h'].every(key => Number.isInteger(box[key]))) return false;
  if (box.x < 0 || box.y < 0 || box.w < minimum.w || box.h < minimum.h
      || box.x + box.w > columns || box.y + box.h > MAX_ROWS) return false;
  return Object.entries(layout).every(([other, rect]) => other === id || !overlaps(box, rect));
}

// Repair old/malformed layouts and changed minimum sizes deterministically.
// Valid placements stay exactly where they were; only a conflicting box moves.
export function restoreLayout(saved, specs, columns) {
  const layout = {}, pending = [];
  // A newly revealed widget must not displace the user's existing placements.
  const ordered = [...specs].sort((a, b) => Number(!!saved?.[b.id]) - Number(!!saved?.[a.id]));
  for (const { id, minimum, initial } of ordered) {
    const box = constrain(saved?.[id] || initial, columns, minimum);
    if (canPlace(layout, id, box, columns, minimum)) layout[id] = box;
    else pending.push({ id, minimum, box });
  }
  for (const { id, minimum, box } of pending) {
    // The nearest clear position is at the desired coordinate or an obstacle's
    // edge. Avoid moving a slightly overlapping capture to the top of the page.
    const rects = Object.values(layout);
    const xs = new Set([box.x, 0, columns - box.w, ...rects.flatMap(r => [r.x + r.w, r.x - box.w])]);
    const ys = new Set([box.y, 0, MAX_ROWS - box.h, ...rects.flatMap(r => [r.y + r.h, r.y - box.h])]);
    let best = null, distance = Infinity;
    for (const y of ys) for (const x of xs) {
      const delta = (x - box.x) ** 2 + (y - box.y) ** 2;
      if (delta >= distance) continue;
      const candidate = { ...box, x, y };
      if (canPlace(layout, id, candidate, columns, minimum)) { best = candidate; distance = delta; }
    }
    if (best) layout[id] = best;
  }
  return layout;
}

export function pixelBox(box, columnStep) {
  return { left: box.x * columnStep, top: box.y * ROW,
    width: box.w * columnStep - GAP, height: box.h * ROW - GAP };
}
