// Preferences shared by the keyboard cube and its settings panel.
export const VIRTUAL_DEFAULTS = {
  virtualLayout: 'qwerty', virtualBindings: null,
  virtualCamera: { latitude: 35, longitude: 30 },
  virtualSize: 100, virtualTilt: 0, virtualOrientation: 'auto',
};

export const DEFAULT_KEYMAP = {
  KeyI: 'R', KeyK: "R'", KeyD: 'L', KeyE: "L'",
  KeyJ: 'U', KeyF: "U'", KeyS: 'D', KeyL: "D'",
  KeyH: 'F', KeyG: "F'", KeyW: 'B', KeyO: "B'",
  KeyU: 'Rw', KeyM: "Rw'", KeyV: 'Lw', KeyR: "Lw'",
  Comma: 'Uw', KeyC: "Uw'", KeyZ: 'Dw', Slash: "Dw'",
  Digit5: 'M', Digit6: 'M', KeyX: "M'", Period: "M'",
  Digit2: 'E', Digit9: "E'", Digit0: 'S', Digit1: "S'",
  KeyT: 'x', KeyY: 'x', KeyB: "x'", KeyN: "x'",
  Semicolon: 'y', KeyA: "y'", KeyP: 'z', KeyQ: "z'",
};
export const VIRTUAL_MOVES = [...new Set(Object.values(DEFAULT_KEYMAP))];
const PHYSICAL = [
  'Backquote', ...Array.from({ length: 10 }, (_, i) => `Digit${(i + 1) % 10}`), 'Minus', 'Equal',
  ...'QWERTYUIOP'.split('').map(c => `Key${c}`), 'BracketLeft', 'BracketRight', 'Backslash',
  ...'ASDFGHJKL'.split('').map(c => `Key${c}`), 'Semicolon', 'Quote',
  ...'ZXCVBNM'.split('').map(c => `Key${c}`), 'Comma', 'Period', 'Slash',
];
const LAYOUTS = {
  qwerty: "`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./",
  dvorak: "`1234567890[]',.pyfgcrl/=\\aoeuidhtns-;qjkxbmwvz",
  colemak: "`1234567890-=qwfpgjluy;[]\\arstdhneio'zxcvbkm,./",
};
export const canBindKey = code => PHYSICAL.includes(code);
export function keyName(code) {
  return LAYOUTS.qwerty[PHYSICAL.indexOf(code)]?.toUpperCase() || code;
}

// Presets label the keycaps on that layout; input remains based on physical keys.
export function virtualKeymap(settings = {}) {
  if (settings.virtualBindings && typeof settings.virtualBindings === 'object') {
    return Object.fromEntries(Object.entries(settings.virtualBindings)
      .filter(([code, move]) => canBindKey(code) && VIRTUAL_MOVES.includes(move)));
  }
  const layout = LAYOUTS[settings.virtualLayout] || LAYOUTS.qwerty;
  return Object.fromEntries(Object.entries(DEFAULT_KEYMAP).map(([code, move]) => {
    const char = layout[PHYSICAL.indexOf(code)];
    return [PHYSICAL[LAYOUTS.qwerty.indexOf(char)] || code, move];
  }));
}

// Reusing a key swaps its old move onto the edited move's previous key.
export function remapVirtualMove(map, move, code) {
  if (!VIRTUAL_MOVES.includes(move) || (code !== null && !canBindKey(code))) return { ...map };
  const previous = Object.keys(map).filter(key => map[key] === move);
  if (previous.includes(code)) return { ...map };
  const displaced = code && map[code];
  const next = Object.fromEntries(Object.entries(map).filter(([, value]) => value !== move));
  if (displaced && previous.length) next[previous[0]] = displaced;
  if (code) next[code] = move;
  return next;
}

const bounded = (v, fallback, min, max) => typeof v === 'number' && Number.isFinite(v)
  ? Math.max(min, Math.min(max, v)) : fallback;
export function virtualView(settings = {}) {
  const camera = settings.virtualCamera || VIRTUAL_DEFAULTS.virtualCamera;
  const size = bounded(settings.virtualSize, 100, 50, 150);
  return {
    latitude: bounded(camera.latitude, 35, -85, 85),
    longitude: bounded(camera.longitude, 30, -180, 180),
    distance: 6 * 100 / size,
    tilt: bounded(settings.virtualTilt, 0, -180, 180),
  };
}

// All 24 valid top/front combinations; generated from the same sticker model
// that checks solves, so orientation never changes the meaning of move keys.
import { faceletsFor } from './cubenet.js';
const FACE_NAME = { U: 'White', D: 'Yellow', F: 'Green', B: 'Blue', R: 'Red', L: 'Orange' };
const orientations = new Map();
for (const up of ['', 'x', 'x2', "x'", 'z', "z'"]) {
  for (const front of ['', 'y', 'y2', "y'"]) {
    const alg = `${up} ${front}`.trim();
    const state = faceletsFor(alg, 3);
    const top = state.U[1][1], face = state.F[1][1];
    orientations.set(`${top}${face}`, { value: alg, label: `${FACE_NAME[top]} top · ${FACE_NAME[face]} front (${top}${face})` });
  }
}
export const VIRTUAL_ORIENTATIONS = [
  { value: 'auto', label: 'Follow scramble / trainer' }, ...orientations.values(),
];
export const virtualOrientation = (settings = {}, fallback = '') =>
  settings.virtualOrientation === 'auto' || !VIRTUAL_ORIENTATIONS.some(o => o.value === settings.virtualOrientation)
    ? fallback : settings.virtualOrientation;
