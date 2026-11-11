import { SOLVED, turnState } from './smart-cube-core.js';

export function inverseTurns(moves) {
  return moves.toReversed().map(move => move.endsWith('2') ? move : move.endsWith("'") ? move[0] : `${move}'`);
}

function appendTurn(moves, move) {
  const previous = moves.at(-1);
  if (!previous || previous[0] !== move[0]) {
    moves.push(move);
    return;
  }
  const amount = token => token.endsWith('2') ? 2 : token.endsWith("'") ? 3 : 1;
  const combined = (amount(previous) + amount(move)) % 4;
  moves.pop();
  if (combined) moves.push(move[0] + (combined === 2 ? '2' : combined === 3 ? "'" : ''));
}

/** Follow reported cube states, including either direction of a half turn.
 * A detour is undone back to the last recognised position. Raw capture moves
 * remain independent of this simplified instruction list. */
export class ScrambleGuide {
  constructor(scramble, initialState = SOLVED) {
    this.tokens = scramble.trim().split(/\s+/).filter(Boolean);
    this.positions = new Map();
    this.currentState = null;
    this.completed = 0;
    this.partial = false;
    this.anchored = false;
    this.detour = [];
    this.preferredTurn = null;
    let state = initialState;
    this.positions.set(state, { completed: 0, partial: false });
    this.tokens.forEach((move, index) => {
      if (!/^[URFDLB][2']?$/.test(move)) throw new Error('Unsupported scramble move');
      if (move.endsWith('2')) {
        for (const quarter of [move[0], `${move[0]}'`]) {
          this.positions.set(turnState(state, quarter), {
            completed: index, partial: true, preferredTurn: quarter,
          });
        }
      }
      state = turnState(state, move);
      this.positions.set(state, { completed: index + 1, partial: false });
    });
    this.target = state;
  }

  synchronize(state) {
    if (state === this.currentState) return;
    this.currentState = state;
    this.detour = [];
    this.recognize(state);
  }

  recognize(state) {
    const position = this.positions.get(state);
    this.anchored = !!position;
    if (!position) return false;
    this.completed = position.completed;
    this.partial = position.partial;
    this.preferredTurn = position.preferredTurn || null;
    this.detour = [];
    return true;
  }

  observe(move, before, after) {
    if (before !== this.currentState) this.synchronize(before);
    this.currentState = after;
    if (this.positions.has(after)) {
      this.recognize(after);
    } else if (this.anchored) {
      appendTurn(this.detour, move);
      if (this.detour.length > 128) {
        this.detour = [];
        this.anchored = false;
      }
    }
  }

  get corrections() { return inverseTurns(this.detour); }
  get nextTurn() { return this.preferredTurn || this.tokens[this.completed] || null; }
  get matched() { return this.currentState === this.target; }
}

/** Preserve the scramble text for copying and the existing line fitting. */
export function highlightScramble(host, guide, active) {
  if (!host) return;
  const original = host.querySelectorAll('.smart-scramble-token');
  if (!active) {
    host.classList.remove('smart-guided-scramble');
    original.forEach(token => {
      token.className = 'smart-scramble-token';
      token.removeAttribute('aria-current');
      token.removeAttribute('title');
    });
    return;
  }
  if (host.textContent.trim().replace(/\s+/g, ' ') !== guide.tokens.join(' ')) return;
  let tokens = original;
  if (tokens.length !== guide.tokens.length) {
    const fragment = document.createDocumentFragment();
    guide.tokens.forEach((move, index) => {
      if (index) fragment.append(document.createTextNode(' '));
      const token = document.createElement('span');
      token.className = 'smart-scramble-token';
      token.textContent = move;
      fragment.append(token);
    });
    host.replaceChildren(fragment);
    tokens = host.querySelectorAll('.smart-scramble-token');
  }
  host.classList.add('smart-guided-scramble');
  tokens.forEach((token, index) => {
    const completed = guide.anchored && index < guide.completed;
    const current = guide.anchored && index === guide.completed;
    token.classList.toggle('is-done', completed);
    token.classList.toggle('is-current', current);
    token.classList.toggle('is-partial', current && guide.partial);
    if (current) token.setAttribute('aria-current', 'step');
    else token.removeAttribute('aria-current');
  });
}
