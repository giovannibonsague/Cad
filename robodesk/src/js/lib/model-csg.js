// Boolean (CSG) evaluation for the 3D modeler: union all solid objects, then subtract every cut.
// Pure geometry code (no DOM), so it runs in Node tests as well as in the app.
import * as THREE from '../../vendor/three/three-csg.bundle.js';

/** Unit-sized geometry for a primitive (Z is the long axis for cylinders/cones, matching the Rust exporter). */
export function makeUnitGeometry(shape) {
  let g;
  if (shape === 'box') g = new THREE.BoxGeometry(1, 1, 1);
  else if (shape === 'cylinder') { g = new THREE.CylinderGeometry(0.5, 0.5, 1, 48); g.rotateX(Math.PI / 2); }
  else if (shape === 'cone') { g = new THREE.CylinderGeometry(0, 0.5, 1, 48); g.rotateX(Math.PI / 2); }
  else { g = new THREE.SphereGeometry(0.5, 32, 16); g.rotateX(Math.PI / 2); }
  return g;
}

export const isCut = (o) => o.op === 'subtract';
export const hasCuts = (doc) => doc.objects.some((o) => isCut(o) && o.visible !== false);

const cache = {};
function brushFor(o) {
  const b = new THREE.Brush((cache[o.shape] ||= makeUnitGeometry(o.shape)));
  b.position.set(...o.position);
  b.rotation.set(...o.rotation.map((d) => (d * Math.PI) / 180), 'ZYX');
  b.scale.set(...o.size);
  b.updateMatrixWorld(true);
  return b;
}

/** Returns a world-space BufferGeometry of (solids - cuts), or null when there is nothing solid. */
export function buildResult(doc) {
  const visible = doc.objects.filter((o) => o.visible !== false);
  const solids = visible.filter((o) => !isCut(o));
  const cuts = visible.filter(isCut);
  if (!solids.length) return null;
  const ev = new THREE.Evaluator();
  ev.useGroups = false;
  let acc = brushFor(solids[0]);
  for (const o of solids.slice(1)) acc = ev.evaluate(acc, brushFor(o), THREE.ADDITION);
  for (const o of cuts) acc = ev.evaluate(acc, brushFor(o), THREE.SUBTRACTION);
  acc.updateMatrixWorld(true);
  const geo = acc.geometry.clone();
  geo.applyMatrix4(acc.matrixWorld);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

/** Flat [x,y,z x 3 per triangle] list, rounded to 1e-4 mm. */
export function trianglesOf(geo) {
  const p = geo.attributes.position; const idx = geo.index;
  const n = idx ? idx.count : p.count;
  const out = new Array(n * 3);
  const r = (v) => Math.round(v * 1e4) / 1e4;
  for (let i = 0; i < n; i++) {
    const k = idx ? idx.getX(i) : i;
    out[i * 3] = r(p.getX(k)); out[i * 3 + 1] = r(p.getY(k)); out[i * 3 + 2] = r(p.getZ(k));
  }
  return out;
}

export function volumeOf(flat) {
  let v = 0;
  for (let i = 0; i < flat.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = flat.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}
