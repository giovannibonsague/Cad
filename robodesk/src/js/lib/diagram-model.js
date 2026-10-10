// Pure wiring-diagram logic: no DOM. Mirrors the document schema validated by the Rust
// backend (crates/robodesk-core/src/diagrams.rs), so anything produced here can be saved.

export const HEAD_H = 30;
export const ROW_H = 24;
export const NODE_MIN_W = 150;
export const NODE_MIN_H = 64;
export const PIN_R = 5.5;
export const GRID = 20;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

export const WIRE_COLORS = [
  { name: 'Red (power)', value: '#e5484d' },
  { name: 'Black (ground)', value: '#8b95a7' },
  { name: 'Yellow (signal)', value: '#f5c542' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#34c27a' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Purple', value: '#a78bfa' },
  { name: 'White', value: '#e6edf8' },
];

const p = (name, side) => ({ name, side });

export const TEMPLATES = [
  { kind: 'controller', label: 'Microcontroller', pins: [p('5V', 'left'), p('GND', 'left'), p('D2', 'right'), p('D3 (PWM)', 'right'), p('D4', 'right'), p('A0', 'right')] },
  { kind: 'driver', label: 'Motor driver', pins: [p('VM', 'left'), p('GND', 'left'), p('IN1', 'left'), p('IN2', 'left'), p('OUT1', 'right'), p('OUT2', 'right')] },
  { kind: 'motor', label: 'DC motor', pins: [p('M+', 'left'), p('M-', 'left')] },
  { kind: 'servo', label: 'Servo', pins: [p('VCC', 'left'), p('GND', 'left'), p('SIG', 'left')] },
  { kind: 'sensor', label: 'Sensor', pins: [p('VCC', 'left'), p('GND', 'left'), p('OUT', 'right')] },
  { kind: 'battery', label: 'Battery', pins: [p('+', 'right'), p('-', 'right')] },
  { kind: 'switch', label: 'Switch', pins: [p('IN', 'left'), p('OUT', 'right')] },
  { kind: 'generic', label: 'Custom component', pins: [p('PIN 1', 'left'), p('PIN 2', 'right')] },
];

export const KIND_COLOR = {
  controller: '#2d7dff', driver: '#a78bfa', motor: '#f97316', servo: '#f97316', sensor: '#34c27a', battery: '#f5c542', switch: '#3cb9f2', generic: '#8b95a7',
};

export function emptyDoc() {
  return { version: 1, view: { x: 0, y: 0, zoom: 1 }, nodes: [], wires: [] };
}

export function clone(doc) {
  return JSON.parse(JSON.stringify(doc));
}

let counter = 0;
/** Unique id not present in `taken`. */
export function newId(prefix, taken) {
  const used = new Set(taken);
  let id;
  do {
    counter += 1;
    id = `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
  } while (used.has(id));
  return id;
}

export const snap = (v, on = true) => (on ? Math.round(v / GRID) * GRID : v);

export function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

// ------------------------------------------------------------------ nodes

export function nodeWidth(node) {
  const longestLabel = Math.max(node.label.length * 7.2 + 32, 0);
  const side = (s) => node.pins.filter((q) => q.side === s);
  const left = Math.max(0, ...side('left').map((q) => q.name.length));
  const right = Math.max(0, ...side('right').map((q) => q.name.length));
  const body = (left + right) * 6.6 + 56;
  return Math.max(NODE_MIN_W, Math.ceil(Math.max(longestLabel, body) / 10) * 10);
}

export function nodeHeight(node) {
  const l = node.pins.filter((q) => q.side === 'left').length;
  const r = node.pins.filter((q) => q.side === 'right').length;
  const rows = Math.max(l, r, 1);
  const hasTop = node.pins.some((q) => q.side === 'top');
  const hasBottom = node.pins.some((q) => q.side === 'bottom');
  return Math.max(NODE_MIN_H, HEAD_H + rows * ROW_H + 10 + (hasBottom ? 14 : 0) + (hasTop ? 0 : 0));
}

export function pinPos(node, pin) {
  const w = nodeWidth(node);
  const h = nodeHeight(node);
  const same = node.pins.filter((q) => q.side === pin.side);
  const i = same.findIndex((q) => q.id === pin.id);
  switch (pin.side) {
    case 'left': return { x: node.x, y: node.y + HEAD_H + (i + 0.5) * ROW_H + 4 };
    case 'right': return { x: node.x + w, y: node.y + HEAD_H + (i + 0.5) * ROW_H + 4 };
    case 'top': return { x: node.x + ((i + 1) / (same.length + 1)) * w, y: node.y };
    default: return { x: node.x + ((i + 1) / (same.length + 1)) * w, y: node.y + h };
  }
}

export function findNode(doc, id) { return doc.nodes.find((n) => n.id === id) || null; }
export function findPin(node, id) { return node?.pins.find((q) => q.id === id) || null; }

export function endpointPos(doc, end) {
  const n = findNode(doc, end.node);
  const q = findPin(n, end.pin);
  return n && q ? { ...pinPos(n, q), side: q.side } : null;
}

/** Whether a node of `template` placed at (x, y) would overlap an existing node (with a margin). */
function overlaps(doc, w, h, x, y, margin = 24) {
  return doc.nodes.some((n) => x < n.x + nodeWidth(n) + margin && x + w + margin > n.x && y < n.y + nodeHeight(n) + margin && y + h + margin > n.y);
}

/** First position at or near `start` where a new component of this template does not overlap others. */
export function findFreeSpot(doc, template, start) {
  const probe = { label: template.label, pins: template.pins.map((q, i) => ({ id: `t${i}`, ...q })) };
  const w = nodeWidth(probe);
  const h = nodeHeight(probe);
  const x0 = snap(start.x - w / 2);
  const y0 = snap(start.y - h / 2);
  for (let ring = 0; ring < 40; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = x0 + dx * (w + 40);
        const y = y0 + dy * (h + 30);
        if (!overlaps(doc, w, h, x, y)) return { x, y };
      }
    }
  }
  return { x: x0, y: y0 };
}

export function addNode(doc, template, at, { snapToGrid = true } = {}) {
  const ids = doc.nodes.map((n) => n.id);
  const id = newId('n', ids);
  const pinIds = [];
  const node = {
    id,
    label: template.label,
    kind: template.kind,
    x: snap(at.x, snapToGrid),
    y: snap(at.y, snapToGrid),
    pins: template.pins.map((q) => {
      const pid = newId('p', pinIds);
      pinIds.push(pid);
      return { id: pid, name: q.name, side: q.side };
    }),
  };
  doc.nodes.push(node);
  return node;
}

export function removeNode(doc, nodeId) {
  doc.nodes = doc.nodes.filter((n) => n.id !== nodeId);
  doc.wires = doc.wires.filter((w) => w.from.node !== nodeId && w.to.node !== nodeId);
}

export function addPin(doc, nodeId, name, side) {
  const n = findNode(doc, nodeId);
  if (!n) return null;
  const pin = { id: newId('p', n.pins.map((q) => q.id)), name: name || `PIN ${n.pins.length + 1}`, side };
  n.pins.push(pin);
  return pin;
}

/** Removing a pin also removes wires attached to it. */
export function removePin(doc, nodeId, pinId) {
  const n = findNode(doc, nodeId);
  if (!n) return;
  n.pins = n.pins.filter((q) => q.id !== pinId);
  doc.wires = doc.wires.filter((w) => !(w.from.node === nodeId && w.from.pin === pinId) && !(w.to.node === nodeId && w.to.pin === pinId));
}

// ------------------------------------------------------------------ wires

const same = (a, b) => a.node === b.node && a.pin === b.pin;

/** Returns null if the connection is allowed, otherwise a human-readable reason. */
export function wireProblem(doc, from, to) {
  if (!findPin(findNode(doc, from.node), from.pin) || !findPin(findNode(doc, to.node), to.pin)) return 'Both ends must be pins.';
  if (same(from, to)) return 'A wire cannot connect a pin to itself.';
  const dup = doc.wires.some((w) => (same(w.from, from) && same(w.to, to)) || (same(w.from, to) && same(w.to, from)));
  if (dup) return 'Those two pins are already connected.';
  return null;
}

export function addWire(doc, from, to, color, label = '') {
  const problem = wireProblem(doc, from, to);
  if (problem) return { error: problem };
  const wire = { id: newId('w', doc.wires.map((w) => w.id)), from: { node: from.node, pin: from.pin }, to: { node: to.node, pin: to.pin }, color, label };
  doc.wires.push(wire);
  return { wire };
}

export function removeWire(doc, wireId) {
  doc.wires = doc.wires.filter((w) => w.id !== wireId);
}

const DIR = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** SVG path for a wire between two endpoint positions (each with `side`). */
export function wirePath(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.min(140, Math.max(36, dist * 0.4));
  const da = DIR[a.side] || [1, 0];
  const db = DIR[b.side] || [-1, 0];
  const c1 = [a.x + da[0] * k, a.y + da[1] * k];
  const c2 = [b.x + db[0] * k, b.y + db[1] * k];
  return `M ${a.x} ${a.y} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${b.x} ${b.y}`;
}

/** Midpoint of the cubic used by wirePath (for placing labels). */
export function wireMid(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.min(140, Math.max(36, dist * 0.4));
  const da = DIR[a.side] || [1, 0];
  const db = DIR[b.side] || [-1, 0];
  const p0 = [a.x, a.y];
  const p1 = [a.x + da[0] * k, a.y + da[1] * k];
  const p2 = [b.x + db[0] * k, b.y + db[1] * k];
  const p3 = [b.x, b.y];
  const t = 0.5;
  const mt = 1 - t;
  const f = (i) => mt ** 3 * p0[i] + 3 * mt * mt * t * p1[i] + 3 * mt * t * t * p2[i] + t ** 3 * p3[i];
  return { x: f(0), y: f(1) };
}

// ----------------------------------------------------------------- viewport

export function screenToWorld(view, pt) {
  return { x: (pt.x - view.x) / view.zoom, y: (pt.y - view.y) / view.zoom };
}

/** New view after zooming by `factor` keeping screen point `at` fixed. */
export function zoomAt(view, factor, at) {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k };
}

/** View that fits every node into a viewport of `size`, with padding. */
export function fitView(doc, size, pad = 60) {
  if (!doc.nodes.length) return { x: 0, y: 0, zoom: 1 };
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of doc.nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + nodeWidth(n)); y1 = Math.max(y1, n.y + nodeHeight(n));
  }
  const zoom = clampZoom(Math.min((size.w - pad * 2) / (x1 - x0 || 1), (size.h - pad * 2) / (y1 - y0 || 1), 1.25));
  return { zoom, x: size.w / 2 - ((x0 + x1) / 2) * zoom, y: size.h / 2 - ((y0 + y1) / 2) * zoom };
}

// ------------------------------------------------------------------ history

/** Snapshot-based undo/redo. `push` stores the state *before* a change. */
export class History {
  constructor(limit = 100) { this.limit = limit; this.past = []; this.future = []; }
  push(doc) {
    this.past.push(JSON.stringify(doc));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(this.past.pop());
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(this.future.pop());
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  clear() { this.past = []; this.future = []; }
}

// ---------------------------------------------------------------- validation

/** Client-side mirror of the backend's checks; returns an error string or null. */
export function validateDoc(doc) {
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.wires)) return 'Invalid diagram structure.';
  const pins = new Map();
  const ids = new Set();
  for (const n of doc.nodes) {
    if (ids.has(n.id)) return 'Duplicate component id.';
    ids.add(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return 'A component has an invalid position.';
    const set = new Set();
    for (const q of n.pins) {
      if (set.has(q.id)) return 'Duplicate pin id.';
      if (!['left', 'right', 'top', 'bottom'].includes(q.side)) return 'Invalid pin side.';
      set.add(q.id);
    }
    pins.set(n.id, set);
  }
  for (const w of doc.wires) {
    if (!/^#[0-9a-fA-F]{6}$/.test(w.color)) return 'Invalid wire colour.';
    for (const e of [w.from, w.to]) if (!pins.get(e.node)?.has(e.pin)) return 'A wire is attached to a missing pin.';
  }
  return null;
}
