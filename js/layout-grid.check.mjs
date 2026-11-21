import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlace, constrain, overlaps, restoreLayout, pixelBox } from './layout-grid.js';

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
    { x: 0, y: 239, w: 4, h: 3 }, { x: .5, y: 0, w: 4, h: 3 },
    { x: 0, y: 0, w: 3, h: 3 }, { x: 0, y: 0, w: NaN, h: 3 },
    { x: 0, y: 0, w: 4 },
  ]) assert.equal(canPlace({}, 'timer', box, 24, min), false);
  assert.deepEqual(constrain({ x: Infinity, y: -20, w: 90, h: .5 }, 16, min), { x: 0, y: 0, w: 16, h: 3 });
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
