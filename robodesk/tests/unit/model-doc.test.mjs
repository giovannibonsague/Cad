import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../src/js/lib/model-doc.js';

test('new objects get unique ids/names and rest on the ground without overlapping', () => {
  const doc = D.emptyModel();
  const made = [];
  for (let i = 0; i < 10; i++) made.push(D.addObject(doc, D.SHAPES[i % 4].shape));
  assert.equal(new Set(made.map((o) => o.id)).size, 10);
  assert.equal(new Set(made.map((o) => o.name)).size, 10);
  for (const o of made) assert.equal(D.objectBounds(o).min[2], 0, 'rests on z = 0');
  for (let i = 0; i < made.length; i++) for (let j = i + 1; j < made.length; j++) {
    const a = D.objectBounds(made[i]); const b = D.objectBounds(made[j]);
    const apart = a.max[0] <= b.min[0] || b.max[0] <= a.min[0] || a.max[1] <= b.min[1] || b.max[1] <= a.min[1];
    assert.ok(apart, `objects ${i} and ${j} overlap`);
  }
  assert.equal(D.validateModel(doc), null);
});

test('rotation matrix and bounds', () => {
  const o = { position: [10, 0, 0], rotation: [0, 0, 90], size: [20, 4, 2] };
  const b = D.objectBounds(o);
  const near = (a, e) => assert.ok(Math.abs(a - e) < 1e-9, `${a} vs ${e}`);
  near(b.min[0], 8); near(b.max[0], 12); near(b.min[1], -10); near(b.max[1], 10); near(b.min[2], -1); near(b.max[2], 1);
  const I = D.rotMatrix([0, 0, 0]);
  I.forEach((row, i) => row.forEach((v, j) => near(v, i === j ? 1 : 0)));
});

test('duplicate, remove, drop to ground, bounds of the whole model', () => {
  const doc = D.emptyModel();
  const a = D.addObject(doc, 'box');
  const c = D.duplicateObject(doc, a.id);
  assert.notEqual(c.id, a.id);
  assert.match(c.name, /copy/);
  assert.deepEqual(c.position.slice(0, 2), [a.position[0] + 10, a.position[1] + 10]);
  c.position[2] = 50; D.dropToGround(c);
  assert.equal(D.objectBounds(c).min[2], 0);
  const all = D.docBounds(doc);
  assert.ok(all.size.every((v) => v > 0));
  D.removeObject(doc, a.id);
  assert.equal(doc.objects.length, 1);
  assert.equal(D.docBounds(D.emptyModel()), null);
  c.visible = false;
  assert.equal(D.docBounds(doc, { visibleOnly: true }), null);
});

test('validateModel mirrors the backend', () => {
  const doc = D.emptyModel(); const o = D.addObject(doc, 'cylinder');
  assert.equal(D.validateModel(doc), null);
  const bad = (mut) => { const d = D.clone(doc); mut(d.objects[0]); return D.validateModel(d); };
  assert.ok(bad((x) => { x.size = [0, 1, 1]; }));
  assert.ok(bad((x) => { x.shape = 'torus'; }));
  assert.ok(bad((x) => { x.color = 'red'; }));
  assert.ok(bad((x) => { x.position = [1, 2]; }));
  assert.ok(bad((x) => { x.position = [NaN, 0, 0]; }));
  assert.ok(bad((x) => { x.visible = 'yes'; }));
  const dup = D.clone(doc); dup.objects.push({ ...o }); assert.ok(D.validateModel(dup));
  assert.ok(D.validateModel(null));
});

test('number parsing and snapping', () => {
  assert.equal(D.parseNumber('12,5'), 12.5);
  assert.equal(D.parseNumber(' -3 '), -3);
  assert.equal(D.parseNumber('abc'), null);
  assert.equal(D.parseNumber(''), null);
  assert.equal(D.parseNumber('1e3'), null);
  assert.equal(D.snap(13, 5), 15);
  assert.equal(D.snap(13, 0), 13);
});
