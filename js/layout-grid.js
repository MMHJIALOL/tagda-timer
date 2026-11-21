// Grid geometry is shared by dragging, resizing, keyboard edits and restoration.
// Coordinates and dimensions are always whole cells, never saved screen pixels.
export const GAP = 8;
export const ROW = 24;
export const MAX_ROWS = 240;

const integer = (value, fallback) => Number.isFinite(value) ? Math.round(value) : fallback;
export const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x
  && a.y < b.y + b.h && a.y + a.h > b.y;

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
  const layout = {};
  for (const { id, minimum, initial } of specs) {
    const box = constrain(saved?.[id] || initial, columns, minimum);
    if (!canPlace(layout, id, box, columns, minimum)) {
      let found = false;
      for (let y = 0; y <= MAX_ROWS - box.h && !found; y++) {
        for (let x = 0; x <= columns - box.w; x++) {
          const candidate = { ...box, x, y };
          if (canPlace(layout, id, candidate, columns, minimum)) {
            Object.assign(box, candidate); found = true; break;
          }
        }
      }
      if (!found) continue;
    }
    layout[id] = box;
  }
  return layout;
}

export function pixelBox(box, columnStep) {
  return { left: box.x * columnStep, top: box.y * ROW,
    width: box.w * columnStep - GAP, height: box.h * ROW - GAP };
}
