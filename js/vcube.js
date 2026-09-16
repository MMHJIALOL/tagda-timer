/* ===========================================================
   Tagda Timer — virtual cube

   csTimer's keyboard cube: every key on the letter block is one turn,
   the first real turn starts the clock and a solved cube stops it.

   The drawing is a second twisty-player (cube.js) animating each turn.
   Whether the cube is solved is asked of cubenet's sticker simulator,
   because twisty-player's closed shadow root cannot answer it.
   =========================================================== */

import { faceletsFor } from './cubenet.js';

/**
 * csTimer's default layout, by physical key rather than by character, so it is
 * the same turns on AZERTY, with caps lock on, or with a non-Latin layout.
 */
export const KEYMAP = {
  KeyI: 'R',  KeyK: "R'",  KeyD: 'L',  KeyE: "L'",
  KeyJ: 'U',  KeyF: "U'",  KeyS: 'D',  KeyL: "D'",
  KeyH: 'F',  KeyG: "F'",  KeyW: 'B',  KeyO: "B'",
  KeyU: 'Rw', KeyM: "Rw'", KeyV: 'Lw', KeyR: "Lw'",
  Comma: 'Uw', KeyC: "Uw'", KeyZ: 'Dw', Slash: "Dw'",
  Digit5: 'M', Digit6: 'M', KeyX: "M'", Period: "M'",
  KeyT: 'x',  KeyY: 'x',  KeyB: "x'", KeyN: "x'",
  Semicolon: 'y', KeyA: "y'", KeyP: 'z', KeyQ: "z'",
};

/* A 2x2 has no inner layer, so a two-layer turn is the whole cube. */
const WIDE_ON_2 = { Rw: 'x', "Rw'": "x'", Lw: "x'", "Lw'": 'x', Uw: 'y', "Uw'": "y'", Dw: "y'", "Dw'": 'y' };
/* M on a big cube is every inner layer: the whole cube, minus both outer faces.
   Spelled out so the drawing and the simulator cannot disagree about it. */
const SLICE_AS = { M: ['R', "L'", "x'"], "M'": ["R'", 'L', 'x'] };

/** The moves a key makes on an n-cube, [] for a key that does nothing there, null if unmapped. */
export function movesFor(code, n) {
  const m = KEYMAP[code];
  if (!m) return null;
  if (n === 2 && WIDE_ON_2[m]) return [WIDE_ON_2[m]];
  if (m[0] === 'M' && n !== 3) return n === 2 ? [] : SLICE_AS[m];
  return [m];
}

const isRotation = (tok) => /^[xyz]/.test(tok);

/** Every face one colour, whichever way up the cube is held. */
export function isSolved(alg, n) {
  const f = faceletsFor(alg, n);
  return Object.values(f).every(g => g.every(row => row.every(c => c === g[0][0])));
}

export class VirtualCube {
  /** `view` is a CubeView, `timer` the app's Timer. */
  constructor(view, timer) {
    this.view = view;
    this.timer = timer;
    this.last = null;
    this.moves = [];
    this.armed = false;      // a scramble is on the cube and it has not been solved yet
  }

  get moved() { return this.moves.length > 0; }

  /** Put `scramble` on the cube, instantly. An empty scramble disarms it. */
  reset({ puzzle, n, orientation = '', scramble = '' }) {
    this.last = { puzzle, n, orientation, scramble };
    this.moves = [];
    this.armed = !!scramble.trim();
    this.view.configure(puzzle, '3D');
    this.view.setOrientation(orientation);
    this.view.set(scramble, { force: true });
  }

  restart() { if (this.last) this.reset(this.last); }

  /**
   * One key press. Returns false when the key is not a turn, so the caller can
   * let it through to the shortcuts.
   */
  key(code, repeat = false) {
    const toks = movesFor(code, this.last?.n || 3);
    if (!toks) return false;
    // A held key is one turn. Between a solve and the next scramble arriving,
    // swallow too: never start a clock on a cube that is already solved.
    if (repeat || !this.armed) return true;
    const t = this.timer;
    for (const tok of toks) {
      if (!isRotation(tok) && (t.state === 'idle' || t.state === 'inspecting')) t.start();
      this.moves.push(tok);
      this.view.addMove(tok);
    }
    // ponytail: re-simulates scramble + every move per turn — ~1ms on a 7x7 at
    // a few hundred moves; keep the sticker state between turns if that grows.
    if (t.state === 'running' && !toks.every(isRotation)) {
      const { orientation, scramble, n } = this.last;
      if (isSolved(`${orientation} ${scramble} ${this.moves.join(' ')}`, n)) {
        this.armed = false;
        t.stop();
      }
    }
    return true;
  }
}
