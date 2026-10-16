/* ===========================================================
   Tagda Timer — the 8 puzzle (3x3 sliding puzzle), as csTimer has it

   Solved is 1-8 in reading order with the gap bottom right. A move is the
   direction a tile slides: "U" pushes the tile below the gap up into it, so
   the gap goes down. Runs of one move are written with a count, "R3".

   The scramble is random-state: a uniformly random solvable arrangement
   (gap anywhere), then the shortest way there from solved, found with IDA*
   on Manhattan distance. The longest any 8 puzzle needs is 31 moves, which
   that search finishes in milliseconds.
   =========================================================== */

const N = 3;
export const SLIDE_SOLVED = [1, 2, 3, 4, 5, 6, 7, 8, 0];

/* Where the gap goes when a tile slides that way. */
const GAP = { U: [1, 0], D: [-1, 0], L: [0, 1], R: [0, -1] };
const OPP = { U: 'D', D: 'U', L: 'R', R: 'L' };
const DIRS = ['U', 'D', 'L', 'R'];

/** The board after one tile slide, or null when no tile can go that way. */
function slide(board, dir) {
  const g = board.indexOf(0);
  const [dr, dc] = GAP[dir];
  const r = Math.floor(g / N) + dr, c = g % N + dc;
  if (r < 0 || r >= N || c < 0 || c >= N) return null;
  const out = board.slice();
  out[g] = out[r * N + c];
  out[r * N + c] = 0;
  return out;
}

/** The board a scramble leaves, from solved. Moves it cannot make are skipped. */
export function slideState(scramble = '') {
  let board = SLIDE_SOLVED.slice();
  for (const tok of String(scramble).trim().split(/\s+/)) {
    const m = /^([UDLR])(\d*)$/.exec(tok);
    if (!m) continue;
    for (let i = 0, n = +(m[2] || 1); i < n; i++) board = slide(board, m[1]) || board;
  }
  return board;
}

/** Even permutation parity of the tiles plus the gap's distance from home. */
function solvable(board) {
  let inv = 0;
  for (let i = 0; i < 9; i++) for (let j = i + 1; j < 9; j++) {
    if (board[i] && board[j] && board[i] > board[j]) inv++;
  }
  /* On an odd-width board a gap move never changes the tile inversion
     count's parity, so solvable is simply "even". */
  return inv % 2 === 0;
}

function manhattan(board) {
  let d = 0;
  for (let i = 0; i < 9; i++) {
    const v = board[i];
    if (!v) continue;
    d += Math.abs(Math.floor(i / N) - Math.floor((v - 1) / N)) + Math.abs(i % N - (v - 1) % N);
  }
  return d;
}

/** The shortest list of slides that solves `board`. */
export function solveSlide(board) {
  const path = [];
  let bound = manhattan(board);
  const search = (b, g, last) => {
    const h = manhattan(b);
    if (h === 0) return true;
    if (g + h > bound) { next = Math.min(next, g + h); return false; }
    for (const d of DIRS) {
      if (last && d === OPP[last]) continue;
      const nb = slide(b, d);
      if (!nb) continue;
      path.push(d);
      if (search(nb, g + 1, d)) return true;
      path.pop();
    }
    return false;
  };
  let next;
  for (;;) {
    next = Infinity;
    if (search(board, 0, null)) return path;
    bound = next;
  }
}

/** "U U U R L" -> "U3 R L". */
export function compressSlides(moves) {
  const out = [];
  for (const m of moves) {
    const top = out[out.length - 1];
    if (top && top[0] === m) top[1]++;
    else out.push([m, 1]);
  }
  return out.map(([m, n]) => (n > 1 ? m + n : m)).join(' ');
}

/** A random-state 8 puzzle scramble. */
export function slideScramble(rand = Math.random) {
  let board;
  do {
    board = SLIDE_SOLVED.slice();
    for (let i = board.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [board[i], board[j]] = [board[j], board[i]];
    }
  } while (!solvable(board) || manhattan(board) < 8);   // never a near-solved board
  /* Solving it backwards is the way there from solved. */
  return compressSlides(solveSlide(board).reverse().map(d => OPP[d]));
}

/* ---------------- the preview ---------------- */

/** Draw the board a scramble leaves into `host` as a 3x3 grid of tiles. */
export function drawSlide(host, scramble) {
  const board = slideState(scramble);
  let grid = host.querySelector(':scope > .slide-board');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'slide-board';
    grid.setAttribute('role', 'img');
    for (let i = 0; i < 9; i++) grid.append(document.createElement('span'));
    host.append(grid);
  }
  grid.setAttribute('aria-label', board.map(v => v || '·').join(' '));
  board.forEach((v, i) => {
    const cell = grid.children[i];
    cell.textContent = v ? String(v) : '';
    cell.className = v ? (v === SLIDE_SOLVED[i] ? 'tile home' : 'tile') : 'gap';
  });
  return grid;
}
