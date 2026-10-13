import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, trianglesOf, volumeOf, hasCuts } from '../../src/js/lib/model-csg.js';

const o = (id, shape, position, size, extra = {}) => ({ id, name: id, shape, position, rotation: [0, 0, 0], size, color: '#4c8dff', visible: true, ...extra });
const vol = (doc) => volumeOf(trianglesOf(buildResult(doc)));

test('a box with a through-hole loses the cylinder volume', () => {
  const doc = { objects: [o('b', 'box', [0, 0, 5], [10, 10, 10]), o('h', 'cylinder', [0, 0, 5], [4, 4, 40], { op: 'subtract' })] };
  assert.ok(hasCuts(doc));
  const expected = 1000 - Math.PI * 4 * 10; // 48-sided prism is slightly smaller than a true circle
  assert.ok(Math.abs(vol(doc) - expected) < 4, `${vol(doc)} vs ${expected}`);
});

test('a cut that misses the solid changes nothing; a hidden cut is ignored', () => {
  const far = { objects: [o('b', 'box', [0, 0, 5], [10, 10, 10]), o('h', 'box', [100, 0, 5], [4, 4, 4], { op: 'subtract' })] };
  assert.ok(Math.abs(vol(far) - 1000) < 1e-3);
  const hidden = { objects: [o('b', 'box', [0, 0, 5], [10, 10, 10]), o('h', 'box', [0, 0, 5], [4, 4, 40], { op: 'subtract', visible: false })] };
  assert.equal(hasCuts(hidden), false);
  assert.ok(Math.abs(vol(hidden) - 1000) < 1e-3);
});

test('overlapping solids union; only cuts means no result', () => {
  const two = { objects: [o('a', 'box', [0, 0, 5], [10, 10, 10]), o('b', 'box', [5, 0, 5], [10, 10, 10])] };
  assert.ok(Math.abs(vol(two) - 1500) < 1e-3);
  assert.equal(buildResult({ objects: [o('h', 'box', [0, 0, 0], [1, 1, 1], { op: 'subtract' })] }), null);
});
