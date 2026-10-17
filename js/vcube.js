import { t } from './i18n.js';
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

/*
 * Dragging the cube only moves twisty's camera, so a cube turned to show its
 * red side still turned green on F. csTimer turns what you are looking at:
 * the face nearest the camera is F, the one nearest the top of the screen U.
 * Axes are twisty's own: x out of R, y out of U, z out of F.
 */
const NORMAL = { R: [1, 0, 0], L: [-1, 0, 0], U: [0, 1, 0], D: [0, -1, 0], F: [0, 0, 1], B: [0, 0, -1] };
const OPP = { R: 'L', L: 'R', U: 'D', D: 'U', F: 'B', B: 'F' };
const AXIS = { x: 'R', y: 'U', z: 'F', M: 'L', E: 'D', S: 'F' };   // the face each one turns like
const ROT_OF = { R: 'x', U: 'y', F: 'z' };
const SLICE_OF = { L: 'M', D: 'E', F: 'S' };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nearest = (v, faces) => faces.reduce((a, f) => (dot(NORMAL[f], v) > dot(NORMAL[a], v) ? f : a));

/** Which real face sits where each face letter points, seen from `orbit`; null when unknown. */
export function viewMap(orbit) {
  if (!orbit || !Number.isFinite(orbit.latitude) || !Number.isFinite(orbit.longitude)) return null;
  const la = orbit.latitude * Math.PI / 180, lo = orbit.longitude * Math.PI / 180;
  const eye = [Math.sin(lo) * Math.cos(la), Math.sin(la), Math.cos(lo) * Math.cos(la)];
  const up = [-Math.sin(lo) * Math.sin(la), Math.cos(la), -Math.cos(lo) * Math.sin(la)];
  const F = nearest(eye, Object.keys(NORMAL));
  const U = nearest(up, Object.keys(NORMAL).filter(f => f !== F && f !== OPP[F]));
  const [a, b] = [NORMAL[U], NORMAL[F]];
  const right = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const R = nearest(right, Object.keys(NORMAL));
  return { U, F, R, D: OPP[U], B: OPP[F], L: OPP[R] };
}

const invert = (s) => (s === "'" ? '' : s === '' ? "'" : s.replace("'", ''));

/** `tok` as the turn of the face that `map` puts under its letter. */
export function remap(tok, map) {
  const m = map && /^([URFDLBxyzMES])(w?)(.*)$/.exec(tok);
  if (!m) return tok;
  const [, base, w, rest] = m;
  if (map[base]) return map[base] + w + rest;
  const to = map[AXIS[base]];
  const of = /[xyz]/.test(base) ? ROT_OF : SLICE_OF;
  return of[to] ? of[to] + rest : of[OPP[to]] + invert(rest);
}

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
    // configure() makes a new player when the puzzle changes: follow that one's camera.
    const p = this.view.player;
    if (p && p !== this.watched) {
      this.watched = p;
      this.map = null;
      try {
        p.experimentalModel.twistySceneModel.orbitCoordinates
          .addFreshListener((c) => { if (this.watched === p) this.map = viewMap(c); });
      } catch { /* an older twisty: keys stay on the fixed faces */ }
    }
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
    for (const tok of toks.map(k => remap(k, this.map))) {
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
