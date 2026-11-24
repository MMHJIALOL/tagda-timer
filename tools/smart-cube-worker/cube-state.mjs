export const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
// Same sticker coordinates and face order as js/cubenet.js.
const geometry = [
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
  [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
];
const positions = geometry.flatMap(([normal, right, down]) => Array.from({ length: 9 }, (_, i) =>
  normal.map((n, axis) => n * 1.5 + right[axis] * (i % 3 - 1) + down[axis] * (Math.floor(i / 3) - 1))));
const key = position => position.join(',');
const indices = new Map(positions.map((position, i) => [key(position), i]));
const permutations = Object.fromEntries(FACES.map((face, index) => {
  const normal = geometry[index][0];
  const axis = normal.findIndex(n => n !== 0);
  const sign = normal[axis];
  const turns = sign === 1 ? 3 : 1;
  return [face, positions.map((position, i) => {
    if (position[axis] * sign < 0.5) return i;
    let [x, y, z] = position;
    for (let turn = 0; turn < turns; turn++) {
      if (axis === 0) [y, z] = [-z, y];
      if (axis === 1) [x, z] = [z, -x];
      if (axis === 2) [x, y] = [-y, x];
    }
    return indices.get(key([x, y, z]));
  })];
}));

export function validFacelets(facelets) {
  return typeof facelets === 'string' && /^[URFDLB]{54}$/.test(facelets)
    && FACES.every(face => facelets.split(face).length === 10);
}

export function applyTurn(facelets, move) {
  if (!validFacelets(facelets) || !/^[URFDLB][2']?$/.test(move)) throw new Error('Invalid cube state or turn');
  const turns = move.endsWith('2') ? 2 : move.endsWith("'") ? 3 : 1;
  const permutation = permutations[move[0]];
  let current = [...facelets];
  for (let turn = 0; turn < turns; turn++) {
    const next = [];
    permutation.forEach((destination, source) => { next[destination] = current[source]; });
    current = next;
  }
  return current.join('');
}
