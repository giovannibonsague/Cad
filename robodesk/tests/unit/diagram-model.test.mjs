import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/js/lib/diagram-model.js';

const tpl = (kind) => M.TEMPLATES.find((t) => t.kind === kind);
function twoNodes() {
  const doc = M.emptyDoc();
  const a = M.addNode(doc, tpl('controller'), { x: 0, y: 0 });
  const b = M.addNode(doc, tpl('driver'), { x: 400, y: 0 });
  return { doc, a, b };
}

test('nodes get unique ids and snapped positions', () => {
  const { doc, a, b } = twoNodes();
  assert.notEqual(a.id, b.id);
  const c = M.addNode(doc, tpl('motor'), { x: 33, y: 47 });
  assert.deepEqual([c.x, c.y], [40, 40]);
  const d = M.addNode(doc, tpl('motor'), { x: 33, y: 47 }, { snapToGrid: false });
  assert.deepEqual([d.x, d.y], [33, 47]);
  assert.equal(M.validateDoc(doc), null);
});

test('wire rules: no self, no duplicates, pins must exist', () => {
  const { doc, a, b } = twoNodes();
  const from = { node: a.id, pin: a.pins[2].id };
  const to = { node: b.id, pin: b.pins[2].id };
  assert.ok(M.addWire(doc, from, to, '#e5484d').wire);
  assert.match(M.addWire(doc, from, to, '#e5484d').error, /already connected/);
  assert.match(M.addWire(doc, to, from, '#e5484d').error, /already connected/, 'reverse direction counts as duplicate');
  assert.match(M.addWire(doc, from, from, '#e5484d').error, /itself/);
  assert.match(M.addWire(doc, from, { node: b.id, pin: 'nope' }, '#e5484d').error, /pins/);
  // two wires may share a pin (e.g. a ground bus)
  assert.ok(M.addWire(doc, from, { node: b.id, pin: b.pins[3].id }, '#3b82f6').wire);
  assert.equal(doc.wires.length, 2);
  assert.equal(M.validateDoc(doc), null);
});

test('removing a node or pin removes attached wires only', () => {
  const { doc, a, b } = twoNodes();
  const c = M.addNode(doc, tpl('motor'), { x: 800, y: 0 });
  M.addWire(doc, { node: a.id, pin: a.pins[2].id }, { node: b.id, pin: b.pins[2].id }, '#e5484d');
  M.addWire(doc, { node: b.id, pin: b.pins[4].id }, { node: c.id, pin: c.pins[0].id }, '#3b82f6');
  M.removePin(doc, b.id, b.pins[4].id);
  assert.equal(doc.wires.length, 1);
  M.removeNode(doc, a.id);
  assert.equal(doc.wires.length, 0);
  assert.equal(doc.nodes.length, 2);
  assert.equal(M.validateDoc(doc), null);
});

test('pin positions sit on the node edges', () => {
  const { a } = twoNodes();
  const w = M.nodeWidth(a);
  const left = a.pins.filter((p) => p.side === 'left');
  const right = a.pins.filter((p) => p.side === 'right');
  for (const p of left) assert.equal(M.pinPos(a, p).x, a.x);
  for (const p of right) assert.equal(M.pinPos(a, p).x, a.x + w);
  const ys = left.map((p) => M.pinPos(a, p).y);
  assert.deepEqual(ys, [...ys].sort((x, y) => x - y));
  assert.equal(new Set(ys).size, ys.length, 'pins do not overlap');
  const top = { id: 't', name: 'T', side: 'top' };
  a.pins.push(top);
  assert.equal(M.pinPos(a, top).y, a.y);
  assert.ok(M.nodeHeight(a) >= M.NODE_MIN_H);
});

test('zoom keeps the point under the cursor fixed and clamps', () => {
  const v = { x: 30, y: -20, zoom: 1 };
  const at = { x: 400, y: 300 };
  const before = M.screenToWorld(v, at);
  const after = M.screenToWorld(M.zoomAt(v, 1.5, at), at);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(M.zoomAt(v, 1000, at).zoom, M.MAX_ZOOM);
  assert.equal(M.zoomAt(v, 0.0001, at).zoom, M.MIN_ZOOM);
});

test('fitView keeps all content inside the viewport', () => {
  const { doc } = twoNodes();
  const size = { w: 1000, h: 600 };
  const v = M.fitView(doc, size);
  for (const n of doc.nodes) {
    const x0 = n.x * v.zoom + v.x;
    const x1 = (n.x + M.nodeWidth(n)) * v.zoom + v.x;
    const y0 = n.y * v.zoom + v.y;
    const y1 = (n.y + M.nodeHeight(n)) * v.zoom + v.y;
    assert.ok(x0 >= 0 && x1 <= size.w && y0 >= 0 && y1 <= size.h, 'node inside viewport');
  }
  assert.deepEqual(M.fitView(M.emptyDoc(), size), { x: 0, y: 0, zoom: 1 });
});

test('wire path and midpoint are sane', () => {
  const a = { x: 0, y: 0, side: 'right' };
  const b = { x: 200, y: 100, side: 'left' };
  assert.match(M.wirePath(a, b), /^M 0 0 C [\d.\- ]+, [\d.\- ]+, 200 100$/);
  const m = M.wireMid(a, b);
  assert.ok(Math.abs(m.x - 100) < 1e-9 && Math.abs(m.y - 50) < 1e-9, 'symmetric curve midpoint is the centre');
});

test('history: undo/redo, and a new edit clears redo', () => {
  const h = new M.History();
  let doc = M.emptyDoc();
  h.push(doc); doc.nodes.push({ id: 'x' });
  h.push(doc); doc.nodes.push({ id: 'y' });
  doc = h.undo(doc); assert.equal(doc.nodes.length, 1);
  doc = h.undo(doc); assert.equal(doc.nodes.length, 0);
  assert.equal(h.undo(doc), null);
  doc = h.redo(doc); assert.equal(doc.nodes.length, 1);
  h.push(doc); doc.nodes.push({ id: 'z' });
  assert.equal(h.canRedo, false);
  const small = new M.History(3);
  for (let i = 0; i < 10; i++) small.push({ i });
  assert.equal(small.past.length, 3);
});

test('validateDoc rejects corrupt documents like the backend does', () => {
  const { doc, a, b } = twoNodes();
  M.addWire(doc, { node: a.id, pin: a.pins[2].id }, { node: b.id, pin: b.pins[2].id }, '#e5484d');
  assert.equal(M.validateDoc(doc), null);
  const bad1 = M.clone(doc); bad1.wires[0].color = 'red'; assert.ok(M.validateDoc(bad1));
  const bad2 = M.clone(doc); bad2.wires[0].to.pin = 'gone'; assert.ok(M.validateDoc(bad2));
  const bad3 = M.clone(doc); bad3.nodes[0].pins[0].side = 'diagonal'; assert.ok(M.validateDoc(bad3));
  const bad4 = M.clone(doc); bad4.nodes[1].id = bad4.nodes[0].id; assert.ok(M.validateDoc(bad4));
  assert.ok(M.validateDoc(null));
});

test('findFreeSpot avoids overlapping existing components', () => {
  const doc = M.emptyDoc();
  const centre = { x: 300, y: 200 };
  const placed = [];
  for (let i = 0; i < 8; i++) {
    const t = M.TEMPLATES[i % M.TEMPLATES.length];
    const at = M.findFreeSpot(doc, t, centre);
    const n = M.addNode(doc, t, at);
    for (const o of placed) {
      const apart = n.x >= o.x + M.nodeWidth(o) || o.x >= n.x + M.nodeWidth(n) || n.y >= o.y + M.nodeHeight(o) || o.y >= n.y + M.nodeHeight(n);
      assert.ok(apart, `component ${i} overlaps an earlier one`);
    }
    placed.push(n);
  }
});
