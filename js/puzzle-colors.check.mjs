import assert from 'node:assert/strict';
import { COLOR_PUZZLES, colorFamily, installPuzzleColors, updatePuzzleColors, customColors, netColors } from './puzzle-colors.js';
import { f as puzzles } from '../vendor/cubing/chunks/chunk-BI4EPFJB.js';
await installPuzzleColors();
// Exercise the actual pinned renderer sources, including all face identities.
for (const id of ['2x2x2','3x3x3','4x4x4','5x5x5','6x6x6','7x7x7','fto','megaminx','pyraminx','skewb','square1']) {
  const family = colorFamily(id);
  for (const face of Object.keys(COLOR_PUZZLES[family].colors)) {
    updatePuzzleColors({ puzzleColors: { [family]: { [face]:'#123456' } } });
    assert.ok((await puzzles[id].svg()).includes('#123456'), `${id} ${face}: flat source`);
    if (puzzles[id].pg) {
      const data = (await puzzles[id].pg()).get3d();
      const stickers = data.stickers.filter(s => data.faces[s.face].name === face);
      assert.ok(stickers.length, `${id} ${face}: face exists`);
      assert.ok(stickers.every(s => s.color === '#123456'), `${id} ${face}: 3D source`);
    }
  }
}
updatePuzzleColors({ cubeColors:{U:'#112233'}, puzzleColors:{fto:{U:'#abcdef'}} });
assert.equal(customColors('7x7x7').U, '#112233');
assert.equal(customColors('fto').U, '#abcdef');
assert.equal(netColors.U, '#112233');
updatePuzzleColors({puzzleColors:{nxn:{U:'invalid'}}});
assert.equal(customColors('3x3x3'), null);
updatePuzzleColors({});
assert.ok(!(await puzzles.fto.svg()).includes('#abcdef'));
console.log('puzzle colors: all faces, puzzle isolation, legacy settings, validation and reset passed');
