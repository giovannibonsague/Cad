// Pure logic for the 3D modeler: no DOM, no WebGL. Mirrors the backend rules in
// crates/robodesk-core/src/models3d.rs so a document that passes here is accepted there.
// Units are millimetres, Z is up, rotations are degrees applied in Z·Y·X order.

export { History, clone } from './diagram-model.js';

export const SHAPES = [
  { shape: 'box', label: 'Box', size: [40, 40, 40] },
  { shape: 'cylinder', label: 'Cylinder', size: [30, 30, 40] },
  { shape: 'cone', label: 'Cone', size: [30, 30, 40] },
  { shape: 'sphere', label: 'Sphere', size: [40, 40, 40] },
];

export const COLORS = [
  { name: 'Blue', value: '#4c8dff' }, { name: 'Teal', value: '#2dd4bf' }, { name: 'Green', value: '#3fb950' },
  { name: 'Amber', value: '#f5a524' }, { name: 'Red', value: '#e5484d' }, { name: 'Violet', value: '#a78bfa' },
  { name: 'Steel', value: '#9aa7b8' }, { name: 'White', value: '#e6edf7' },
];

export const MAX_OBJECTS = 1000;
export const SNAP_STEPS = [0.5, 1, 2, 5, 10];

export const emptyModel = () => ({ version: 1, units: 'mm', objects: [] });
export const findObject = (doc, id) => doc.objects.find((o) => o.id === id) || null;
export const snap = (v, step) => (step > 0 ? Math.round(v / step) * step : v);
export const round = (v, places = 3) => { const f = 10 ** places; return Math.round(v * f) / f; };

function nextId(doc) {
  let n = doc.objects.length + 1;
  const ids = new Set(doc.objects.map((o) => o.id));
  while (ids.has(`o${n}`)) n++;
  return `o${n}`;
}

function uniqueName(doc, base) {
  const names = new Set(doc.objects.map((o) => o.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Rotation matrix for Euler angles in degrees, R = Rz · Ry · Rx (same as the Rust exporter). */
export function rotMatrix([ax, ay, az]) {
  const [rx, ry, rz] = [ax, ay, az].map((d) => (d * Math.PI) / 180);
  const [sx, cx, sy, cy, sz, cz] = [Math.sin(rx), Math.cos(rx), Math.sin(ry), Math.cos(ry), Math.sin(rz), Math.cos(rz)];
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

/** Axis-aligned bounds of an object (conservative for round shapes once rotated). */
export function objectBounds(o) {
  const R = rotMatrix(o.rotation);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    const p = [sx * o.size[0], sy * o.size[1], sz * o.size[2]];
    for (let i = 0; i < 3; i++) {
      const v = R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2] + o.position[i];
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
  return { min, max };
}

export function docBounds(doc, { visibleOnly = false } = {}) {
  const list = doc.objects.filter((o) => !visibleOnly || o.visible !== false);
  if (!list.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const o of list) {
    const b = objectBounds(o);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  }
  return { min, max, size: max.map((v, i) => v - min[i]) };
}

const overlaps = (a, b) => a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1] && a.min[2] < b.max[2] && b.min[2] < a.max[2];

/** First position (stepping along +X then +Y) where `candidate` does not overlap any existing object. */
export function findFreeSpot(doc, candidate, step = 10) {
  const probe = { ...candidate, position: [...candidate.position] };
  for (let row = 0; row < 50; row++) {
    for (let col = 0; col < 50; col++) {
      probe.position = [candidate.position[0] + col * step, candidate.position[1] + row * step * 4, candidate.position[2]];
      const b = objectBounds(probe);
      if (!doc.objects.some((o) => overlaps(b, objectBounds(o)))) return probe.position;
    }
  }
  return [...candidate.position];
}

/** Add a new object resting on the ground plane (z = 0) at a free spot. Returns the object. */
export function addObject(doc, shape, { snapStep = 0, op = 'add' } = {}) {
  const tpl = SHAPES.find((t) => t.shape === shape);
  if (!tpl) throw new Error(`Unknown shape: ${shape}`);
  if (doc.objects.length >= MAX_OBJECTS) throw new Error(`A model can hold at most ${MAX_OBJECTS} objects.`);
  const o = {
    id: nextId(doc), name: uniqueName(doc, op === 'subtract' ? `${tpl.label} cut` : tpl.label), shape,
    position: [0, 0, tpl.size[2] / 2], rotation: [0, 0, 0], size: [...tpl.size],
    color: COLORS[doc.objects.length % COLORS.length].value, visible: true,
  };
  if (op === 'subtract') o.op = 'subtract';
  o.position = findFreeSpot(doc, o, Math.max(snapStep, 5)).map((v) => round(v));
  doc.objects.push(o);
  return o;
}

export function duplicateObject(doc, id, offset = 10) {
  const src = findObject(doc, id);
  if (!src) return null;
  if (doc.objects.length >= MAX_OBJECTS) throw new Error(`A model can hold at most ${MAX_OBJECTS} objects.`);
  const c = JSON.parse(JSON.stringify(src));
  c.id = nextId(doc);
  c.name = uniqueName(doc, `${src.name} copy`.slice(0, 120));
  c.position = [src.position[0] + offset, src.position[1] + offset, src.position[2]];
  doc.objects.push(c);
  return c;
}

export function removeObject(doc, id) { doc.objects = doc.objects.filter((o) => o.id !== id); }

/** Move an object so its lowest point rests on z = 0. */
export function dropToGround(o) { o.position[2] = round(o.position[2] - objectBounds(o).min[2]); }

const isTriple = (a, min, max) => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max);

/** Client-side mirror of the backend validation; returns an error string or null. */
export function validateModel(doc) {
  if (!doc || !Array.isArray(doc.objects)) return "'objects' must be a list.";
  if (doc.objects.length > MAX_OBJECTS) return 'Too many objects.';
  const ids = new Set();
  for (const o of doc.objects) {
    if (typeof o.id !== 'string' || !o.id || o.id.length > 64) return 'An object has no id.';
    if (ids.has(o.id)) return 'Duplicate object id.';
    ids.add(o.id);
    if (typeof o.name !== 'string' || [...o.name].length > 120 || /[\u0000-\u001f\u007f]/.test(o.name)) return `Object name “${o.name}” is invalid.`;
    if (!SHAPES.some((t) => t.shape === o.shape)) return 'Shape must be box, cylinder, cone or sphere.';
    if (!isTriple(o.position, -1e5, 1e5)) return `Position of “${o.name}” must be three numbers.`;
    if (!isTriple(o.rotation, -3600, 3600)) return `Rotation of “${o.name}” must be three numbers.`;
    if (!isTriple(o.size, 0.001, 1e5)) return `Size of “${o.name}” must be three positive numbers.`;
    if (!/^#[0-9a-fA-F]{6}$/.test(o.color || '')) return 'Colour must look like #rrggbb.';
    if (o.visible !== undefined && typeof o.visible !== 'boolean') return "'visible' must be true or false.";
    if (o.op !== undefined && o.op !== 'add' && o.op !== 'subtract') return "'op' must be add or subtract.";
  }
  return null;
}

/** Parse a number typed by the user (accepts "12,5"); returns null when not a finite number. */
export function parseNumber(text) {
  const t = String(text).trim().replace(',', '.');
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Labelled edit history: every entry is a full snapshot, so jumping to any point is exact. */
export class Timeline {
  constructor(doc, limit = 200) { this.limit = limit; this.reset(doc); }
  reset(doc) { this.entries = [{ label: 'Start', snap: JSON.stringify(doc) }]; this.cursor = 0; }
  push(label, doc) {
    this.entries.length = this.cursor + 1; // a new edit discards the redo branch
    this.entries.push({ label, snap: JSON.stringify(doc) });
    if (this.entries.length > this.limit + 1) this.entries.shift();
    this.cursor = this.entries.length - 1;
  }
  get canUndo() { return this.cursor > 0; }
  get canRedo() { return this.cursor < this.entries.length - 1; }
  doc() { return JSON.parse(this.entries[this.cursor].snap); }
  undo() { if (!this.canUndo) return null; this.cursor--; return this.doc(); }
  redo() { if (!this.canRedo) return null; this.cursor++; return this.doc(); }
  jump(i) { if (!Number.isInteger(i) || i < 0 || i >= this.entries.length) return null; this.cursor = i; return this.doc(); }
}
