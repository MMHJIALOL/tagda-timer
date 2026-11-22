import test from 'node:test';
import assert from 'node:assert/strict';
import { GAP, ROW, MAX_ROWS, canPlace, constrain, overlaps, restoreLayout, pixelBox, gridBox, resizeBox, reprojectLayout, isGeneratedLayout } from './layout-grid.js';

test('snapped rectangles have a fixed gap and never overlap at their edges', () => {
  const layout = { timer: { x: 4, y: 5, w: 8, h: 6 } };
  assert.equal(canPlace(layout, 'ao5', { x: 4, y: 11, w: 4, h: 2 }, 24), true);
  assert.equal(canPlace(layout, 'ao5', { x: 4, y: 10, w: 4, h: 2 }, 24), false);
  const a = pixelBox(layout.timer, 60), b = pixelBox({ x: 12, y: 5, w: 4, h: 2 }, 60);
  assert.equal(b.left - (a.left + a.width), 8);
});

test('out-of-bounds, fractional, corrupt and undersized placements are rejected', () => {
  const min = { w: 4, h: 3 };
  for (const box of [
    { x: -1, y: 0, w: 4, h: 3 }, { x: 23, y: 0, w: 4, h: 3 },
    { x: 0, y: MAX_ROWS - 1, w: 4, h: 3 }, { x: .5, y: 0, w: 4, h: 3 },
    { x: 0, y: 0, w: 3, h: 3 }, { x: 0, y: 0, w: NaN, h: 3 },
    { x: 0, y: 0, w: 4 },
  ]) assert.equal(canPlace({}, 'timer', box, 24, min), false);
  assert.deepEqual(constrain({ x: Infinity, y: -20, w: 90, h: .5 }, 16, min), { x: 0, y: 0, w: 16, h: 3 });
});

test('a live page capture preserves its bounds within one snap step', () => {
  const rect = { left: 510.8, top: 400.1, width: 418.4, height: 199.8 };
  const origin = { left: 12, top: 76 }, step = 8;
  const snapped = pixelBox(gridBox(rect, origin, step), step);
  assert.ok(Math.abs(snapped.left + origin.left - rect.left) <= step / 2);
  assert.ok(Math.abs(snapped.top + origin.top - rect.top) <= ROW / 2);
  assert.ok(snapped.width >= rect.width && snapped.width < rect.width + step);
  assert.ok(snapped.height >= rect.height && snapped.height < rect.height + ROW);
});

test('all eight resize handles keep the opposite edges fixed and clamp at the minimum', () => {
  const box = { x: 10, y: 10, w: 20, h: 20 }, min = { w: 10, h: 10 };
  for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const next = resizeBox(box, direction, 2, 3, min);
    assert.equal(next.x, box.x + (direction.includes('w') ? 2 : 0), direction);
    assert.equal(next.y, box.y + (direction.includes('n') ? 3 : 0), direction);
    assert.equal(next.w, box.w + (direction.includes('e') ? 2 : direction.includes('w') ? -2 : 0), direction);
    assert.equal(next.h, box.h + (direction.includes('s') ? 3 : direction.includes('n') ? -3 : 0), direction);
  }
  assert.deepEqual(resizeBox(box, 'nw', 100, 100, min), { x: 20, y: 20, w: 10, h: 10 });
  assert.deepEqual(resizeBox(box, 'se', -100, -100, min), { x: 10, y: 10, w: 10, h: 10 });
});

test('legacy layouts and changes in window width retain their proportions', () => {
  const old = { timer: { x: 6, y: 10, w: 12, h: 8 } };
  const fine = reprojectLayout(old, { columns: 24, row: 24 }, { columns: 180, row: ROW });
  assert.deepEqual(fine.timer, { x: 45, y: 30, w: 90, h: 24 });
  assert.equal(fine.timer.h * ROW - GAP, old.timer.h * 24 - GAP);
  assert.deepEqual(reprojectLayout(fine, { columns: 180, row: ROW }, { columns: 24, row: 24 }), old);
  assert.deepEqual(reprojectLayout({ ...fine, broken: null }, { columns: 0, row: 0 }, { columns: 180, row: ROW }), fine);
});

test('newly shown widgets and small capture overlaps keep existing widgets in place', () => {
  const saved = { timer: { x: 20, y: 20, w: 50, h: 25 } };
  const specs = [
    { id: 'ao5', minimum: { w: 5, h: 3 }, initial: { x: 20, y: 44, w: 16, h: 6 } },
    { id: 'timer', minimum: { w: 30, h: 17 }, initial: { x: 0, y: 0, w: 50, h: 25 } },
  ];
  const restored = restoreLayout(saved, specs, 180);
  assert.deepEqual(restored.timer, saved.timer);
  assert.deepEqual(restored.ao5, { x: 20, y: 45, w: 16, h: 6 });
});

test('only the untouched legacy generated template is replaced with the current appearance', () => {
  const template = {
    scramble: { x: 6, y: 0, w: 12, h: 5 }, timer: { x: 6, y: 20, w: 12, h: 8 },
    times: { x: 0, y: 0, w: 5, h: 39 }, spotify: { x: 0, y: 39, w: 5, h: 9 },
    stats: { x: 19, y: 0, w: 5, h: 11 }, cube: { x: 19, y: 39, w: 5, h: 9 },
    ao5: { x: 6, y: 28, w: 6, h: 3 }, ao12: { x: 12, y: 28, w: 6, h: 3 },
    bpa: { x: 6, y: 31, w: 6, h: 2 }, wpa: { x: 12, y: 31, w: 6, h: 2 },
  };
  assert.equal(isGeneratedLayout(template), true);
  assert.equal(isGeneratedLayout({ ...template, timer: { ...template.timer, x: 7 } }), false);
  assert.equal(isGeneratedLayout({ ...template, timer: { ...template.timer, h: 9 } }), false);
  assert.equal(isGeneratedLayout({ timer: template.timer }), false);
  assert.equal(isGeneratedLayout(null), false);
});

test('restoration repairs collisions and preserves all valid saved positions', () => {
  const specs = ['timer', 'ao5', 'ao12'].map(id => ({ id, minimum: { w: 3, h: 2 }, initial: { x: 0, y: 0, w: 4, h: 3 } }));
  const saved = { timer: { x: 5, y: 8, w: 8, h: 6 }, ao5: { x: 5, y: 8, w: 4, h: 3 }, ao12: { x: 17, y: 20, w: 4, h: 3 } };
  const restored = restoreLayout(saved, specs, 24);
  assert.deepEqual(restored.timer, saved.timer);
  assert.deepEqual(restored.ao12, saved.ao12);
  assert.equal(overlaps(restored.timer, restored.ao5), false);
  assert.deepEqual(restoreLayout(saved, specs, 24), restored);
});

test('narrower grids keep every widget reachable without collisions', () => {
  const specs = Array.from({ length: 14 }, (_, i) => ({ id: String(i), minimum: { w: 4, h: 3 }, initial: { x: 20, y: 4, w: 10, h: 6 } }));
  const layout = restoreLayout(null, specs, 16);
  assert.equal(Object.keys(layout).length, specs.length);
  for (const [id, box] of Object.entries(layout)) assert.equal(canPlace(layout, id, box, 16, { w: 4, h: 3 }), true);
});
