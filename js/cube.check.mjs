// Self-check for the scramble preview's alg cleanup: node js/cube.check.mjs
// A megaminx scramble arrives as seven lines; all of it must reach the preview,
// while a numbered multi-blind block previews only its first cube.
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.navigator ??= { language: 'en' };
const { previewAlg, CubeView } = await import('./cube.js');
import assert from 'node:assert';

const line = 'R++ D-- R-- D++ R++ D-- R++ D++ R-- D-- U';
const minx = Array(7).fill(line).join('\n');
const got = previewAlg(minx);
assert.equal(got.split(/\s+/).length, 77, 'every megaminx line reaches the preview');
assert.ok(!got.includes('\n'));

assert.equal(previewAlg("1) R U F\n2) D L B'"), 'R U F', 'multi-blind previews its first cube');
assert.equal(previewAlg('  R U R\' U\'  '), "R U R' U'");
assert.equal(previewAlg(''), '');

// Megaminx has a flat net in twisty-player; it must not fall back to 3D.
const v = new CubeView(null, null);
v.puzzle = 'megaminx';
assert.ok(v.supports('2D'), 'megaminx supports 2D');
assert.ok(!v.supports('LL'));

console.log('cube.check: ok');
