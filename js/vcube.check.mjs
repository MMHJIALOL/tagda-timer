import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faceletsFor } from './cubenet.js';
import { VirtualCube, movesFor, isSolved, viewMap, remap } from './vcube.js';
import { DEFAULT_KEYMAP, VIRTUAL_MOVES, VIRTUAL_ORIENTATIONS, virtualOrientation,
  virtualKeymap, remapVirtualMove, virtualView } from './vcube-settings.js';

test('presets keep every move and reserved controls cannot become bindings', () => {
  assert.deepEqual(virtualKeymap(), DEFAULT_KEYMAP);
  for (const virtualLayout of ['qwerty', 'dvorak', 'colemak']) {
    assert.deepEqual(new Set(Object.values(virtualKeymap({ virtualLayout }))), new Set(VIRTUAL_MOVES));
  }
  const map = virtualKeymap({ virtualBindings: { KeyA: 'R', Space: 'U', ArrowUp: 'F', KeyB: 'junk' } });
  assert.deepEqual(map, { KeyA: 'R' });
  assert.deepEqual(remapVirtualMove(DEFAULT_KEYMAP, 'R', 'Space'), DEFAULT_KEYMAP);
});

test('remapping swaps occupied keys, clears aliases, and allows an unbound move', () => {
  const swapped = remapVirtualMove(DEFAULT_KEYMAP, 'R', 'KeyF');
  assert.equal(swapped.KeyF, 'R');
  assert.equal(swapped.KeyI, "U'");
  const remapped = remapVirtualMove(swapped, 'M', 'Digit3');
  assert.equal(remapped.Digit3, 'M');
  assert.equal(remapped.Digit5, undefined);
  assert.equal(remapped.Digit6, undefined);
  assert.equal(Object.values(remapVirtualMove(remapped, 'M', null)).includes('M'), false);
  assert.deepEqual(remapVirtualMove(DEFAULT_KEYMAP, 'M', 'Digit6'), DEFAULT_KEYMAP);
});

test('24 starting orientations are distinct and remain solvable with unchanged move notation', () => {
  const options = VIRTUAL_ORIENTATIONS.filter(o => o.value !== 'auto');
  assert.equal(options.length, 24);
  const pairs = new Set();
  for (const { value } of options) {
    const f = faceletsFor(value, 3);
    pairs.add(`${f.U[1][1]}${f.F[1][1]}`);
    for (const n of [2, 3, 4, 7]) assert.ok(isSolved(`${value} R U F F' U' R'`, n));
  }
  assert.equal(pairs.size, 24);
  assert.equal(virtualOrientation({ virtualOrientation: 'auto' }, 'z2'), 'z2');
  assert.equal(virtualOrientation({ virtualOrientation: '' }, 'z2'), '');
  assert.equal(virtualOrientation({ virtualOrientation: 'junk' }, 'z2'), 'z2');
});

test('slice rendering and solve checking agree for every supported cube size', () => {
  for (const n of [2, 3, 4, 5, 6, 7]) {
    for (const [code, move] of Object.entries(DEFAULT_KEYMAP).filter(([, m]) => /^[MES]/.test(m))) {
      const actual = movesFor(code, n).join(' ');
      assert.deepEqual(faceletsFor(actual, n), faceletsFor(n === 2 ? '' : move, n), `${move} on ${n}`);
    }
  }
});

test('camera settings are bounded and never change scramble, turns, or timing', () => {
  let starts = 0;
  const view = { host: { style: {} }, setOrbit(o) { this.orbit = o; }, configure() {}, setOrientation() {}, set() {}, addMove() {} };
  const timer = { state: 'idle', start() { starts++; this.state = 'running'; }, stop() { this.state = 'idle'; } };
  const cube = new VirtualCube(view, timer);
  cube.reset({ puzzle: '3x3x3', n: 3, scramble: 'R U' });
  cube.configure({ virtualCamera: { latitude: 1000, longitude: NaN }, virtualSize: 150, virtualTilt: 25 });
  assert.deepEqual(view.orbit, { latitude: 85, longitude: 30, distance: 4 });
  assert.equal(view.host.style.transform, 'rotate(25deg)');
  assert.equal(cube.last.scramble, 'R U');
  assert.deepEqual(cube.moves, []);
  assert.equal(starts, 0);
  assert.equal(virtualView({ virtualSize: -50 }).distance, 12);
  assert.equal(virtualView({ virtualTilt: Infinity }).tilt, 0);
});

test('custom keys start at the first face turn, ignore repeats, and stop on a solved cube', () => {
  const played = [], events = [];
  const view = { host: { style: {} }, setOrbit() {}, configure() {}, setOrientation() {}, set() {}, addMove(move) { played.push(move); } };
  const timer = { state: 'idle', start() { events.push('start'); this.state = 'running'; }, stop() { events.push('stop'); this.state = 'idle'; } };
  const cube = new VirtualCube(view, timer);
  cube.configure({ virtualBindings: { KeyA: "U'", KeyB: "R'", KeyT: 'x' } });
  cube.reset({ puzzle: '3x3x3', n: 3, orientation: 'z2', scramble: 'R U' });
  assert.equal(cube.key('KeyI'), false);
  cube.key('KeyA', true);
  assert.deepEqual(events, []);
  cube.key('KeyA');
  assert.deepEqual(events, ['start']);
  cube.configure({ virtualBindings: { KeyB: "R'" }, virtualCamera: { latitude: 0, longitude: 0 } });
  assert.deepEqual(cube.moves, ["U'"]);
  cube.key('KeyB');
  assert.deepEqual(events, ['start', 'stop']);
  assert.deepEqual(played, ["U'", "R'"]);
  cube.key('KeyB');
  assert.equal(played.length, 2);
});

test('custom bindings preserve the current camera-relative move behaviour', () => {
  const played = [];
  const view = { host: { style: {} }, setOrbit() {}, configure() {}, setOrientation() {}, set() {}, addMove(move) { played.push(move); } };
  const timer = { state: 'idle', start() { this.state = 'running'; }, stop() { this.state = 'idle'; } };
  const cube = new VirtualCube(view, timer);
  cube.reset({ puzzle: '3x3x3', n: 3, scramble: 'U' });
  cube.configure({ virtualBindings: { KeyA: 'F' }, virtualCamera: { latitude: 35, longitude: 118 } });
  cube.key('KeyA');
  assert.deepEqual(played, ['R']);
  const red = viewMap({ latitude: 35, longitude: 118 });
  for (const move of ['F', "R'", 'U2', 'Lw', 'x', "z'", 'M', 'S']) {
    assert.deepEqual(faceletsFor(`y ${move}`, 3), faceletsFor(`${remap(move, red)} y`, 3));
  }
});

test('leaving virtual mode cleans up its camera listeners and renderer', () => {
  const disposed = [];
  const cube = new VirtualCube({ release() { disposed.push('view'); } }, {});
  cube.disposeCamera = () => disposed.push('camera');
  cube.release();
  assert.deepEqual(disposed, ['camera', 'view']);
});
