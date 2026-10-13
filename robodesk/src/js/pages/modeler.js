// 3D modeler: build parts from boxes, cylinders, cones and spheres, place/rotate/scale them,
// and export the result as an STL mesh. Rendering uses a vendored copy of three.js (works offline).
// Pure model logic lives in lib/model-doc.js; the backend validates and stores the document.
// Layout follows a CAD workspace: Items tree (left), floating tool rails, view cube, History (right).

import * as THREE from '../../vendor/three/three-csg.bundle.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api, native } from '../api.js';
import * as D from '../lib/model-doc.js';
import * as CSG from '../lib/model-csg.js';
import { navigate } from '../router.js';
import { state, resolveProject } from '../state.js';
import { btn, confirmDialog, emptyState, formModal, iconBtn, noProjects, projectSelect, selectEl, toast } from '../ui.js';

const LAST_KEY = 'robodesk.lastModel.';
const lastModel = (pid) => { try { return Number(localStorage.getItem(LAST_KEY + pid)) || null; } catch { return null; } };
const rememberModel = (pid, id) => { try { localStorage.setItem(LAST_KEY + pid, String(id)); } catch { /* optional convenience */ } };
const SNAP_KEY = 'robodesk.modelSnap';
const AXES = ['X', 'Y', 'Z'];
const fmt = (v) => String(D.round(v, 3));
const SHAPE_ICON = { box: 'cube3d', cylinder: 'shapeCyl', cone: 'shapeCone', sphere: 'shapeSphere' };
const SHAPE_PLURAL = { box: 'Boxes', cylinder: 'Cylinders', cone: 'Cones', sphere: 'Spheres' };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export async function render({ params, view }) {
  const { projects, project } = await resolveProject(params.id);
  if (!project) { mount(view, h('div', { style: { padding: '24px' } }, noProjects(navigate))); return; }
  const pid = project.id;
  let models = await api('models.list', { project_id: pid });

  let current = null; // { id, name }
  let doc = D.emptyModel();
  let selectedId = null;
  let snapStep = (() => { try { const v = Number(localStorage.getItem(SNAP_KEY)); return D.SNAP_STEPS.includes(v) || v === 0 ? v : 1; } catch { return 1; } })();
  let dirty = false; let saving = false; let saveFailed = false;
  let itemFilter = 'all';
  const collapsed = new Set();
  let wireframe = false; let gridOn = true; let previewCuts = true;
  let resultMesh = null; let resultSig = '';
  const timeline = new D.Timeline(doc);
  let destroyed = false;

  const root = h('div', { class: 'cad-root' });
  const toolbar = h('div', { class: 'cad-toolbar' });
  const stage = h('div', { class: 'cad-stage' });
  const canvasWrap = h('div', { class: 'cad-canvas' });
  const itemsPanel = h('aside', { class: 'cad-panel cad-items', 'aria-label': 'Items' });
  const railLeft = h('div', { class: 'cad-rail cad-rail-left', role: 'toolbar', 'aria-label': 'Add shapes' });
  const railRight = h('div', { class: 'cad-rail cad-rail-right', role: 'toolbar', 'aria-label': 'View tools' });
  const side = h('div', { class: 'cad-side' });
  const historyPanel = h('section', { class: 'cad-panel cad-history', 'aria-label': 'History' });
  const inspector = h('section', { class: 'cad-panel cad-props', 'aria-label': 'Properties' });
  const saveStatus = h('span', { class: 'save-status', role: 'status' });
  const hint = h('div', { class: 'canvas-hint hidden' });
  const cubeHost = h('div', { class: 'view-cube-host' });
  side.append(historyPanel, inspector);
  stage.append(canvasWrap, itemsPanel, railLeft, railRight, cubeHost, side);
  mount(root, toolbar, stage);
  mount(view, root);

  // ----------------------------------------------------------------- saving
  const delaySecs = () => state.settings.autosave_interval_secs || 5;
  const autosaveOn = () => state.settings.autosave_enabled !== false;
  let timer = null;
  function markDirty() {
    dirty = true; saveFailed = false; paintStatus();
    clearTimeout(timer);
    if (autosaveOn()) timer = setTimeout(() => save(), delaySecs() * 1000);
  }
  function paintStatus() {
    saveStatus.textContent = saving ? 'Saving…' : saveFailed ? 'Save failed — retry with Ctrl+S' : dirty ? (autosaveOn() ? 'Unsaved changes' : 'Unsaved changes (autosave off)') : current ? 'All changes saved' : '';
    saveStatus.dataset.kind = saveFailed ? 'error' : dirty ? 'dirty' : 'ok';
    const sb = document.querySelector('#status-project');
    if (sb) sb.textContent = current ? `${project.name} · ${current.name}` : project.name;
  }
  async function save() {
    clearTimeout(timer);
    if (!current || !dirty || saving) return !dirty;
    const problem = D.validateModel(doc);
    if (problem) { saveFailed = true; paintStatus(); toast(`Cannot save: ${problem}`, 'error'); return false; }
    saving = true; paintStatus();
    const snapshot = JSON.stringify(doc);
    try {
      const meta = await api('models.save', { id: current.id, data: doc });
      dirty = JSON.stringify(doc) !== snapshot;
      models = models.map((m) => (m.id === meta.id ? meta : m));
      saveFailed = false;
    } catch (e) { saveFailed = true; toast(`Could not save model: ${e.message}`, 'error'); }
    saving = false; paintStatus(); paintToolbar();
    if (dirty && !saveFailed && autosaveOn()) markDirty();
    return !dirty;
  }

  // --------------------------------------------------------------- mutations
  const selected = () => (selectedId ? D.findObject(doc, selectedId) : null);
  /** Apply an edit to a copy, validate it, then commit it as one labelled history entry. */
  function change(label, fn) {
    const next = D.clone(doc);
    let result;
    try { result = fn(next); } catch (e) { toast(e.message, 'error'); return false; }
    const problem = D.validateModel(next);
    if (problem) { toast(problem, 'error'); return false; }
    doc = next;
    timeline.push(label, doc);
    markDirty(); paintAll();
    return result ?? true;
  }
  function restore(next) {
    if (!next) return;
    doc = next;
    if (selectedId && !D.findObject(doc, selectedId)) selectedId = null;
    markDirty(); paintAll();
  }
  const undo = () => restore(timeline.undo());
  const redo = () => restore(timeline.redo());
  const jump = (i) => restore(timeline.jump(i));

  function addShape(shape, op = 'add') {
    if (!current) return;
    let id = null;
    const ok = change(`Add ${D.SHAPES.find((t) => t.shape === shape).label}${op === 'subtract' ? ' cut' : ''}`, (d) => { id = D.addObject(d, shape, { snapStep, op }).id; });
    if (ok && id) { selectedId = id; spawn.set(id, performance.now()); paintAll(); animate(); }
  }
  function deleteSelected() { const o = selected(); if (o) { selectedId = null; change(`Delete ${o.name}`, (d) => D.removeObject(d, o.id)); } }
  function duplicateSelected() {
    const o = selected(); if (!o) return;
    let id = null;
    if (change(`Duplicate ${o.name}`, (d) => { id = D.duplicateObject(d, o.id, Math.max(snapStep, 10)).id; })) { selectedId = id; spawn.set(id, performance.now()); paintAll(); animate(); }
  }

  // ------------------------------------------------------------------- 3D scene
  let renderer = null; let scene; let camera; let gridHelper; let rafPending = false;
  const meshes = new Map(); // id -> { mesh, edges, shape }
  const geoms = {};
  const spawn = new Map(); // id -> start time of the "pop in" animation
  const orbit = { target: new THREE.Vector3(0, 0, 20), radius: 260, theta: -Math.PI / 3.2, phi: Math.PI / 3 };
  let tween = null;
  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function unitGeometry(shape) {
    if (geoms[shape]) return geoms[shape];
    const g = CSG.makeUnitGeometry(shape);
    geoms[shape] = { geo: g, edges: new THREE.EdgesGeometry(g, 35) };
    return geoms[shape];
  }

  function initScene() {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      renderer = null;
      mount(canvasWrap, h('div', { class: 'canvas-hint' }, h('strong', {}, '3D view unavailable'), h('span', { class: 'muted' }, 'This computer could not start WebGL. Update your graphics driver or Microsoft Edge WebView2 runtime.')));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = 'cad-gl';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('role', 'application');
    renderer.domElement.setAttribute('aria-label', '3D viewport. Drag to orbit, right-drag to pan, scroll to zoom, click an object to select it.');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar('--canvas-bg', '#0c0c0e'));
    camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(300, -400, 600); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xb4c4ff, 0.55); fill.position.set(-400, 300, 200); scene.add(fill);
    gridHelper = new THREE.GridHelper(4000, 200, new THREE.Color(cssVar('--text-faint', '#70707a')), new THREE.Color(cssVar('--canvas-grid', '#26262b')));
    gridHelper.rotateX(Math.PI / 2);
    scene.add(gridHelper);
    const axis = (to, color) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([to.clone().multiplyScalar(-1), to]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    scene.add(axis(new THREE.Vector3(2000, 0, 0), 0xe5484d), axis(new THREE.Vector3(0, 2000, 0), 0x3fb950), axis(new THREE.Vector3(0, 0, 2000), 0x4c8dff));
    mount(canvasWrap, renderer.domElement, hint);
    placeCamera(); resize();
  }

  function placeCamera() {
    if (!camera) return;
    const { target, radius, theta, phi } = orbit;
    camera.position.set(target.x + radius * Math.sin(phi) * Math.cos(theta), target.y + radius * Math.sin(phi) * Math.sin(theta), target.z + radius * Math.cos(phi));
    camera.lookAt(target);
    camera.updateMatrixWorld();
    paintCube();
    requestRender();
  }
  function requestRender() {
    if (rafPending || !renderer || destroyed) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; if (renderer && !destroyed) renderer.render(scene, camera); });
  }
  function resize() {
    if (!renderer) return;
    const w = Math.max(canvasWrap.clientWidth, 10); const hh = Math.max(canvasWrap.clientHeight, 10);
    renderer.setSize(w, hh, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = w / hh; camera.updateProjectionMatrix();
    requestRender();
  }

  const applyTransform = (mesh, o) => {
    mesh.position.set(...o.position);
    mesh.rotation.set(...o.rotation.map((d) => (d * Math.PI) / 180), 'ZYX');
    mesh.scale.set(...o.size);
  };

  function syncScene() {
    if (!renderer) return;
    const live = new Set(doc.objects.map((o) => o.id));
    const drop = (id, m) => { scene.remove(m.mesh); m.mesh.material.dispose(); m.edges.material.dispose(); meshes.delete(id); };
    for (const [id, m] of meshes) if (!live.has(id)) drop(id, m);
    for (const o of doc.objects) {
      let m = meshes.get(o.id);
      const g = unitGeometry(o.shape);
      if (m && m.shape !== o.shape) { drop(o.id, m); m = null; }
      if (!m) {
        const mesh = new THREE.Mesh(g.geo, new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.45, metalness: 0.25 }));
        mesh.userData.id = o.id;
        const edges = new THREE.LineSegments(g.edges, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }));
        mesh.add(edges);
        scene.add(mesh);
        m = { mesh, edges, shape: o.shape };
        meshes.set(o.id, m);
      }
      applyTransform(m.mesh, o);
      const cut = CSG.isCut(o);
      const showResult = previewCuts && CSG.hasCuts(doc);
      m.mesh.visible = o.visible !== false;
      m.mesh.material.transparent = cut; m.mesh.material.opacity = cut ? 0.4 : 1; m.mesh.material.depthWrite = !cut;
      m.mesh.material.visible = !showResult;
      m.mesh.material.color.set(cut ? '#ff4d5e' : o.color);
      m.mesh.material.wireframe = wireframe;
      const sel = o.id === selectedId;
      m.mesh.material.emissive.set(sel ? 0x24467f : 0x000000);
      m.edges.material.color.set(sel ? 0x8dbbff : 0x000000);
      m.edges.material.opacity = sel ? 1 : 0.55;
      m.edges.visible = !wireframe && !showResult;
    }
    syncResult();
    if (gridHelper) gridHelper.visible = gridOn;
    requestRender();
  }

  function syncResult() {
    const want = previewCuts && CSG.hasCuts(doc);
    const sig = want ? JSON.stringify(doc.objects.map((o) => [o.shape, o.position, o.rotation, o.size, o.visible, o.op])) : '';
    if (sig === resultSig) { if (resultMesh) resultMesh.material.wireframe = wireframe; return; }
    resultSig = sig;
    if (resultMesh) { scene.remove(resultMesh); resultMesh.geometry.dispose(); resultMesh.material.dispose(); resultMesh = null; }
    if (!want) return;
    try {
      const geo = CSG.buildResult(doc);
      if (!geo) return;
      resultMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#8fb4ff', roughness: 0.45, metalness: 0.25, wireframe }));
      scene.add(resultMesh);
    } catch (e) { toast(`Could not compute the cut preview: ${e.message}`, 'error'); }
  }

  // -------------------------------------------------------------------- animation
  let animating = false;
  function animate() {
    if (animating || !renderer || reduceMotion()) { if (reduceMotion()) { spawn.clear(); syncScene(); } return; }
    animating = true;
    const step = (now) => {
      if (destroyed || !renderer) { animating = false; return; }
      let active = false;
      if (tween) {
        const t = Math.min((now - tween.t0) / tween.ms, 1); const k = ease(t);
        orbit.theta = tween.from.theta + (tween.to.theta - tween.from.theta) * k;
        orbit.phi = tween.from.phi + (tween.to.phi - tween.from.phi) * k;
        orbit.radius = tween.from.radius + (tween.to.radius - tween.from.radius) * k;
        orbit.target.lerpVectors(tween.from.target, tween.to.target, k);
        placeCamera();
        if (t >= 1) tween = null; else active = true;
      }
      for (const [id, t0] of spawn) {
        const m = meshes.get(id); const o = D.findObject(doc, id);
        if (!m || !o) { spawn.delete(id); continue; }
        const t = Math.min((now - t0) / 260, 1);
        const k = 1 - (1 - t) ** 3;
        const over = t < 1 ? 1 + 0.08 * Math.sin(t * Math.PI) : 1; // slight overshoot
        m.mesh.scale.set(o.size[0] * k * over, o.size[1] * k * over, o.size[2] * k * over);
        if (t >= 1) { spawn.delete(id); applyTransform(m.mesh, o); } else active = true;
      }
      requestRender();
      if (active) requestAnimationFrame(step); else animating = false;
    };
    requestAnimationFrame(step);
  }
  function flyTo(to) {
    // take the shortest way round in azimuth
    let dth = to.theta - orbit.theta;
    dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    if (reduceMotion()) { Object.assign(orbit, { theta: orbit.theta + dth, phi: to.phi, radius: to.radius }); orbit.target.copy(to.target); placeCamera(); return; }
    tween = { t0: performance.now(), ms: 360, from: { theta: orbit.theta, phi: orbit.phi, radius: orbit.radius, target: orbit.target.clone() }, to: { theta: orbit.theta + dth, phi: to.phi, radius: to.radius, target: to.target.clone() } };
    animate();
  }

  // ------------------------------------------------------------------ camera moves
  const PRESETS = { iso: [-Math.PI / 3.2, Math.PI / 3], front: [-Math.PI / 2, Math.PI / 2], back: [Math.PI / 2, Math.PI / 2], right: [0, Math.PI / 2], left: [Math.PI, Math.PI / 2], top: [-Math.PI / 2, 0.0001], bottom: [-Math.PI / 2, Math.PI - 0.0001] };
  const setView = (name) => { const p = PRESETS[name]; if (p) flyTo({ theta: p[0], phi: p[1], radius: orbit.radius, target: orbit.target }); };
  function fit() {
    const b = D.docBounds(doc, { visibleOnly: true });
    const target = b ? new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2) : new THREE.Vector3(0, 0, 20);
    flyTo({ theta: orbit.theta, phi: orbit.phi, radius: b ? Math.max(Math.hypot(...b.size) * 1.7, 60) : 260, target });
  }
  const zoomBy = (f) => { orbit.radius = Math.min(Math.max(orbit.radius * f, 5), 20000); placeCamera(); };

  // ---------------------------------------------------------------------- view cube
  const FACES = [['Right', 'rotateY(90deg)'], ['Left', 'rotateY(-90deg)'], ['Back', 'rotateX(-90deg)'], ['Front', 'rotateX(90deg)'], ['Top', ''], ['Bottom', 'rotateY(180deg)']];
  const FACE_VIEW = { Right: 'right', Left: 'left', Back: 'back', Front: 'front', Top: 'top', Bottom: 'bottom' };
  const cube = h('div', { class: 'cube' }, FACES.map(([name, tf]) => h('button', { class: 'cube-face', type: 'button', style: { transform: `${tf} translateZ(21px)` }, title: `${name} view`, 'aria-label': `${name} view`, onClick: () => setView(FACE_VIEW[name]) }, name)));
  mount(cubeHost, h('div', { class: 'cube-scene' }, cube));
  function paintCube() {
    // scene axes -> screen: use the camera's rotation, flipping y because CSS y points down
    const e = camera.matrixWorldInverse.elements; // column-major
    const m = [e[0], -e[1], e[2], 0, e[4], -e[5], e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1];
    cube.style.transform = `matrix3d(${m.map((v) => (Math.abs(v) < 1e-9 ? 0 : v.toFixed(5))).join(',')})`;
  }

  // -------------------------------------------------------------- pointer interaction
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function setRay(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  function pick(e) {
    setRay(e);
    const hits = ray.intersectObjects([...meshes.values()].map((m) => m.mesh).filter((m) => m.visible), false);
    return hits[0] ? hits[0].object.userData.id : null;
  }
  const planeHit = (e, z) => { setRay(e); const out = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), out) ? out : null; };
  const select = (id) => { if (selectedId === id) return; selectedId = id; syncScene(); paintInspector(); paintItems(); };
  let gesture = null;
  function bindPointer() {
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      el.focus({ preventScroll: true });
      tween = null;
      const id = e.button === 0 && !e.shiftKey ? pick(e) : null;
      if (id) {
        const o = D.findObject(doc, id);
        select(id);
        gesture = { type: 'move', id, hit: planeHit(e, o.position[2]), start: [...o.position], moved: false, sx: e.clientX, sy: e.clientY };
      } else if (e.button === 0 && !e.shiftKey) {
        gesture = { type: 'orbit', sx: e.clientX, sy: e.clientY, th: orbit.theta, ph: orbit.phi, moved: false };
      } else {
        gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, target: orbit.target.clone() };
      }
      el.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!gesture) return;
      const dx = e.clientX - gesture.sx; const dy = e.clientY - gesture.sy;
      if (gesture.type === 'orbit') {
        if (Math.hypot(dx, dy) > 3) gesture.moved = true;
        orbit.theta = gesture.th - dx * 0.008;
        orbit.phi = Math.min(Math.max(gesture.ph - dy * 0.008, 0.01), Math.PI - 0.01);
        placeCamera();
      } else if (gesture.type === 'pan') {
        const k = (orbit.radius * 2 * Math.tan((camera.fov * Math.PI) / 360)) / renderer.domElement.clientHeight;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        orbit.target.copy(gesture.target).addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
        placeCamera();
      } else if (gesture.type === 'move' && gesture.hit) {
        if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
        const o = D.findObject(doc, gesture.id); if (!o) return;
        gesture.moved = true;
        const p = planeHit(e, gesture.start[2]); if (!p) return;
        o.position[0] = D.round(D.snap(gesture.start[0] + p.x - gesture.hit.x, snapStep));
        o.position[1] = D.round(D.snap(gesture.start[1] + p.y - gesture.hit.y, snapStep));
        const m = meshes.get(o.id); if (m) { applyTransform(m.mesh, o); requestRender(); }
        paintValues();
      }
    });
    const end = (e) => {
      if (!gesture) return;
      const g = gesture; gesture = null;
      if (g.type === 'orbit' && !g.moved && selectedId) { selectedId = null; syncScene(); paintInspector(); paintItems(); }
      if (g.type === 'move' && g.moved) {
        const o = D.findObject(doc, g.id);
        timeline.push(`Move ${o ? o.name : 'object'}`, doc);
        markDirty(); paintAll();
      }
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { e.preventDefault(); tween = null; zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  }

  // ------------------------------------------------------------- UI: rails and Items
  function paintRails() {
    mount(railLeft, D.SHAPES.map((t) => h('button', { class: 'rail-btn', type: 'button', disabled: !current, title: `Add ${t.label}`, 'aria-label': `Add ${t.label}`, onClick: () => addShape(t.shape) }, icon(SHAPE_ICON[t.shape], 19))),
      h('span', { class: 'rail-sep' }),
      h('button', { class: 'rail-btn', type: 'button', disabled: !current, title: 'Add hole (cylinder cut)', 'aria-label': 'Add hole', onClick: () => addShape('cylinder', 'subtract') }, icon('hole', 19)));
    mount(railRight,
      h('button', { class: 'rail-btn', type: 'button', title: 'Fit model to window (F)', 'aria-label': 'Fit model to window', disabled: !current, onClick: fit }, icon('fit', 18)),
      h('button', { class: 'rail-btn', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', disabled: !current, onClick: () => zoomBy(1 / 1.25) }, icon('zoomIn', 18)),
      h('button', { class: 'rail-btn', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', disabled: !current, onClick: () => zoomBy(1.25) }, icon('zoomOut', 18)),
      h('span', { class: 'rail-sep' }),
      h('button', { class: 'rail-btn', type: 'button', title: 'Preview result of cuts', 'aria-label': 'Preview cuts', 'aria-pressed': String(previewCuts), onClick: () => { previewCuts = !previewCuts; syncScene(); paintRails(); } }, icon('hole', 18)),
      h('button', { class: 'rail-btn', type: 'button', title: 'Wireframe', 'aria-label': 'Wireframe', 'aria-pressed': String(wireframe), onClick: () => { wireframe = !wireframe; syncScene(); paintRails(); } }, icon('wire', 18)),
      h('button', { class: 'rail-btn', type: 'button', title: 'Show grid', 'aria-label': 'Show grid', 'aria-pressed': String(gridOn), onClick: () => { gridOn = !gridOn; syncScene(); paintRails(); } }, icon('grid', 18)));
  }

  function paintItems() {
    const visible = doc.objects.filter((o) => (itemFilter === 'all' ? true : itemFilter === 'visible' ? o.visible !== false : o.visible === false));
    const filter = selectEl({ label: 'Show items', value: itemFilter, className: 'sm', options: [{ value: 'all', label: 'All items' }, { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }], onChange: (v) => { itemFilter = v; paintItems(); } });
    const groups = D.SHAPES.map((t) => ({ t, list: visible.filter((o) => o.shape === t.shape) })).filter((g) => g.list.length);
    const row = (o) => h('div', { class: `obj-row ${o.id === selectedId ? 'selected' : ''}` },
      h('button', { class: 'obj-pick', type: 'button', 'aria-label': `Select ${o.name}`, 'aria-pressed': String(o.id === selectedId), onClick: () => select(o.id) },
        h('span', { class: 'swatch sm', style: { background: o.color } }), h('span', { class: 'ellipsis' }, o.name), CSG.isCut(o) ? h('span', { class: 'cut-badge' }, 'cut') : null),
      iconBtn(o.visible === false ? 'eyeOff' : 'eye', o.visible === false ? `Show ${o.name}` : `Hide ${o.name}`, () => change(`${o.visible === false ? 'Show' : 'Hide'} ${o.name}`, (d) => { const x = D.findObject(d, o.id); x.visible = x.visible === false; })));
    mount(itemsPanel,
      h('div', { class: 'cad-panel-head' }, h('h3', {}, 'Items'), h('span', { class: 'faint' }, String(doc.objects.length))),
      h('div', { class: 'cad-panel-tools' }, filter),
      h('div', { class: 'cad-scroll obj-list' }, groups.length ? groups.map(({ t, list }) => {
        const open = !collapsed.has(t.shape);
        return h('div', { class: 'obj-group' },
          h('button', { class: 'obj-group-head', type: 'button', 'aria-expanded': String(open), onClick: () => { if (open) collapsed.add(t.shape); else collapsed.delete(t.shape); paintItems(); } },
            h('span', { class: `chev ${open ? 'open' : ''}` }, icon('chevronRight', 13)), icon(SHAPE_ICON[t.shape], 15), h('span', { class: 'grow' }, SHAPE_PLURAL[t.shape]), h('span', { class: 'faint' }, String(list.length))),
          open ? h('div', { class: 'obj-group-body' }, list.map(row)) : null);
      }) : [h('div', { class: 'pal-hint', style: { padding: '14px' } }, doc.objects.length ? 'No items match this filter.' : 'Use the shape tools to add your first object.')]));
  }

  // --------------------------------------------------------------- UI: history panel
  function paintHistory() {
    const items = timeline.entries.map((e, i) => {
      const verb = e.label.split(' ')[0];
      const ic = { Add: 'plus', Delete: 'trash', Move: 'fit', Duplicate: 'copy', Start: 'cube3d' }[verb] || 'edit';
      return h('button', { class: `hist-row ${i === timeline.cursor ? 'current' : ''} ${i > timeline.cursor ? 'future' : ''}`, type: 'button', 'aria-current': i === timeline.cursor ? 'step' : null, onClick: () => jump(i) },
        icon(ic, 15), h('span', { class: 'grow ellipsis' }, e.label), icon('chevronRight', 13));
    });
    mount(historyPanel,
      h('div', { class: 'cad-panel-head' }, h('h3', {}, 'History'), h('span', { class: 'row', style: { gap: '2px' } },
        iconBtn('undo', 'Undo (Ctrl+Z)', undo, { disabled: !timeline.canUndo }), iconBtn('redo', 'Redo (Ctrl+Y)', redo, { disabled: !timeline.canRedo }))),
      h('div', { class: 'cad-scroll hist-list' }, items));
    const list = historyPanel.querySelector('.hist-list');
    const cur = list?.querySelector('.current');
    if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.clientHeight + 60);
  }

  // ------------------------------------------------------------------ UI: properties
  let valueInputs = {};
  function numberField(label, getter, setter, undoLabel) {
    const input = h('input', { class: 'input num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
    input.value = fmt(getter());
    input.addEventListener('change', () => {
      const n = D.parseNumber(input.value);
      if (n === null) { toast(`${label}: enter a number.`, 'error', 2500); input.value = fmt(getter()); return; }
      if (!change(undoLabel, (d) => setter(d, n))) input.value = fmt(getter());
    });
    return { input, refresh: () => { if (document.activeElement !== input) input.value = fmt(getter()); } };
  }
  function paintValues() { for (const f of Object.values(valueInputs)) f.refresh(); }

  function paintInspector() {
    valueInputs = {};
    const o = selected();
    inspector.classList.toggle('hidden', !o && !doc.objects.length);
    if (!o) {
      const b = D.docBounds(doc, { visibleOnly: true });
      mount(inspector, h('div', { class: 'cad-panel-head' }, h('h3', {}, 'Model')),
        h('div', { class: 'cad-body' },
          b ? h('div', { class: 'stat-list' },
            h('div', {}, h('span', { class: 'faint' }, 'Objects'), h('strong', {}, String(doc.objects.length))),
            h('div', {}, h('span', { class: 'faint' }, 'Overall size'), h('strong', { class: 'mono' }, `${fmt(b.size[0])} × ${fmt(b.size[1])} × ${fmt(b.size[2])} mm`))) : h('span', { class: 'muted' }, 'Nothing visible.'),
          h('div', { class: 'pal-hint', style: { marginTop: '10px' } }, 'Drag: orbit · Right-drag / Shift+drag: pan · Wheel: zoom · Arrows: nudge · Del: delete')));
      return;
    }
    const triple = (title, key) => h('div', { class: 'field', style: { marginTop: '8px' } }, h('div', { class: 'label' }, title),
      h('div', { class: 'xyz' }, AXES.map((ax, i) => {
        const f = numberField(`${title} ${ax}`, () => (D.findObject(doc, o.id) || o)[key][i], (d, n) => { D.findObject(d, o.id)[key][i] = n; }, `${key === 'size' ? 'Resize' : key === 'rotation' ? 'Rotate' : 'Move'} ${o.name}`);
        valueInputs[`${key}${i}`] = f;
        return h('label', { class: 'xyz-cell' }, h('span', {}, ax), f.input);
      })));
    const nameInput = h('input', { class: 'input', type: 'text', maxlength: 120, 'aria-label': 'Object name' });
    nameInput.value = o.name;
    nameInput.addEventListener('change', () => { const v = nameInput.value.trim(); if (!v) { nameInput.value = o.name; return; } change(`Rename ${o.name}`, (d) => { D.findObject(d, o.id).name = v; }); });
    mount(inspector,
      h('div', { class: 'cad-panel-head' }, h('h3', {}, D.SHAPES.find((t) => t.shape === o.shape).label), h('span', { class: 'row', style: { gap: '2px' } },
        iconBtn('copy', 'Duplicate (Ctrl+D)', duplicateSelected), iconBtn('trash', 'Delete (Del)', deleteSelected))),
      h('div', { class: 'cad-body cad-scroll' },
        h('div', { class: 'field' }, h('label', {}, 'Name'), nameInput),
        h('div', { class: 'field', style: { marginTop: '8px' } }, h('div', { class: 'label' }, 'Type'),
          selectEl({ label: 'Object type', value: o.op === 'subtract' ? 'subtract' : 'add', className: 'sm', options: [{ value: 'add', label: 'Solid (adds material)' }, { value: 'subtract', label: 'Cut (removes material)' }], onChange: (v) => change(`${v === 'subtract' ? 'Make cut' : 'Make solid'} ${o.name}`, (d) => { const x = D.findObject(d, o.id); if (v === 'subtract') x.op = 'subtract'; else delete x.op; }) })),
        h('div', { class: 'field', style: { marginTop: '8px' } }, h('div', { class: 'label' }, 'Colour'),
          h('div', { class: 'swatches' }, D.COLORS.map((c) => h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(c.value === o.color), title: c.name, 'aria-label': c.name, style: { background: c.value }, onClick: () => change(`Recolour ${o.name}`, (d) => { D.findObject(d, o.id).color = c.value; }) })))),
        triple('Position (mm)', 'position'), triple('Rotation (°)', 'rotation'), triple('Size (mm)', 'size'),
        h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Drop to ground', { size: 'sm', onClick: () => change(`Drop ${o.name}`, (d) => D.dropToGround(D.findObject(d, o.id))) }))));
  }

  // ------------------------------------------------------------------ toolbar
  function paintToolbar() {
    const sel = h('select', { class: 'select select-inline', 'aria-label': 'Model', disabled: !models.length }, models.length ? models.map((m) => h('option', { value: m.id }, `${m.name} (${m.objects} objects)`)) : [h('option', {}, 'No models')]);
    if (current) sel.value = String(current.id);
    sel.addEventListener('change', () => openModel(Number(sel.value)));
    const snapSel = selectEl({ label: 'Snap step', value: String(snapStep), className: 'sm', options: [{ value: '0', label: 'Snap off' }, ...D.SNAP_STEPS.map((v) => ({ value: String(v), label: `Snap ${v} mm` }))], onChange: (v) => { snapStep = Number(v); try { localStorage.setItem(SNAP_KEY, v); } catch { /* optional */ } } });
    mount(toolbar,
      projectSelect({ projects, value: pid, label: 'Project', onChange: async (id) => { await flush(); navigate(`/modeler/${id}`); } }),
      sel,
      btn('New', { size: 'sm', icon: 'plus', onClick: newModel }),
      iconBtn('edit', 'Rename model', renameModel, { disabled: !current }),
      iconBtn('trash', 'Delete model', deleteModel, { disabled: !current }),
      h('span', { class: 'tb-sep' }), snapSel,
      h('span', { class: 'grow' }), saveStatus,
      btn('Export STL', { size: 'sm', icon: 'download', disabled: !current || !doc.objects.some((o) => o.visible !== false), onClick: exportStl }),
      btn('Save', { size: 'sm', icon: 'save', kind: dirty ? 'primary' : '', disabled: !current || !dirty, onClick: () => save().then((ok) => ok && toast('Model saved', 'success', 1800)) }));
    paintStatus();
  }
  function paintAll() { syncScene(); paintItems(); paintHistory(); paintInspector(); paintToolbar(); paintHint(); }
  function paintHint() {
    hint.classList.toggle('hidden', doc.objects.length > 0 || !current);
    if (!doc.objects.length) mount(hint, h('div', { class: 'empty-icon' }, icon('cube3d', 24)), h('strong', {}, 'Empty model'), h('span', { class: 'muted' }, 'Pick a shape from the tool rail, then move, rotate and resize it. Export the result as an STL for printing.'));
  }

  // --------------------------------------------------------------------- model ops
  async function flush() {
    if (!current || !dirty) return true;
    if (autosaveOn()) return save();
    const yes = await confirmDialog({ title: 'Save model changes?', message: `“${current.name}” has unsaved changes.`, confirmLabel: 'Save changes', cancelLabel: 'Discard', danger: false });
    if (yes) return save();
    dirty = false; return true;
  }
  async function openModel(id) {
    if (current && current.id !== id) await flush();
    try {
      const m = await api('models.get', { id });
      current = { id: m.id, name: m.name };
      doc = { ...D.emptyModel(), ...m.data };
      selectedId = null; dirty = false; saveFailed = false; timeline.reset(doc);
      rememberModel(pid, id);
      if (!renderer && !scene) { initScene(); if (renderer) bindPointer(); }
      paintRails(); paintAll();
      requestAnimationFrame(() => { resize(); fit(); });
    } catch (e) { toast(e.message, 'error'); }
  }
  async function createModel(name) {
    const created = await formModal({ title: 'New 3D model', size: 'narrow', submitLabel: 'Create', fields: [{ name: 'name', label: 'Model name', required: true, value: name, maxlength: 120, placeholder: 'e.g. Chassis plate' }], onSubmit: (v) => api('models.create', { project_id: pid, name: v.name }) });
    if (!created) return null;
    models = await api('models.list', { project_id: pid });
    return created;
  }
  async function newModel() { if (!(await flush())) return; const c = await createModel(models.length ? '' : 'Chassis'); if (c) await openModel(c.id); }
  async function renameModel() {
    const r = await formModal({ title: 'Rename model', size: 'narrow', fields: [{ name: 'name', label: 'Name', required: true, value: current.name, maxlength: 120 }], onSubmit: async (v) => { await flush(); return api('models.save', { id: current.id, data: doc, name: v.name }); } });
    if (!r) return;
    current.name = r.name; dirty = false; models = await api('models.list', { project_id: pid }); paintToolbar();
  }
  async function deleteModel() {
    if (!(await confirmDialog({ title: 'Delete model?', message: `“${current.name}” (${doc.objects.length} objects) will be permanently deleted.`, confirmLabel: 'Delete model' }))) return;
    try {
      await api('models.delete', { id: current.id });
      dirty = false; models = await api('models.list', { project_id: pid }); current = null; doc = D.emptyModel(); selectedId = null;
      if (models.length) await openModel(models[0].id); else paintEmpty();
      toast('Model deleted', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function exportStl() {
    if (!(await flush())) return;
    try {
      const path = await native.pickSavePath('stl', `${current.name.replace(/[\\/:*?"<>|]+/g, '_')}.stl`);
      if (!path) return;
      let r;
      if (CSG.hasCuts(doc)) {
        const geo = CSG.buildResult(doc);
        if (!geo) { toast('Nothing to export: only cuts are visible.', 'error'); return; }
        r = await api('models.export_mesh', { name: current.name, path, vertices: CSG.trianglesOf(geo) });
        geo.dispose();
      } else r = await api('models.export_stl', { id: current.id, path });
      toast(`Exported ${r.triangles.toLocaleString()} triangles to ${path}`, 'success', 5000);
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
  }
  function paintEmpty() {
    mount(root, toolbar, h('div', { class: 'wiring-none' }, emptyState({ icon: 'cube3d', title: 'No 3D models for this project', text: 'Build parts from simple shapes — boxes, cylinders, cones and spheres — position them precisely, and export an STL for 3D printing or CAD import.', actions: [btn('Create model', { icon: 'plus', kind: 'primary', onClick: async () => { const c = await createModel('Chassis'); if (!c) return; mount(root, toolbar, stage); await openModel(c.id); } })] })));
    paintToolbar();
  }

  // -------------------------------------------------------------------- keyboard
  function onKey(e) {
    if (destroyed) return;
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save().then((ok) => ok && current && toast('Model saved', 'success', 1800)); return; }
    if (typing || document.querySelector('.overlay')) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedId) { e.preventDefault(); deleteSelected(); } }
    else if (e.key === 'Escape') { if (selectedId) { selectedId = null; syncScene(); paintInspector(); paintItems(); } }
    else if (e.key.toLowerCase() === 'f' && !mod) fit();
    else if (selectedId && (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      const step = (snapStep || 1) * (e.shiftKey ? 10 : 1);
      const v = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0], PageUp: [0, 0, step], PageDown: [0, 0, -step] }[e.key];
      const o = selected();
      if (v && o) change(`Move ${o.name}`, (d) => { const x = D.findObject(d, selectedId); x.position = x.position.map((p, i) => D.round(p + v[i])); });
    }
  }
  document.addEventListener('keydown', onKey);
  const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onVisibility);
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap);

  // ------------------------------------------------------------------------ start
  paintRails(); paintToolbar(); paintItems(); paintHistory(); paintInspector();
  if (!models.length) paintEmpty();
  else await openModel(models.find((m) => m.id === lastModel(pid))?.id ?? models[0].id);

  return {
    async destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect(); clearTimeout(timer);
      await flush();
      if (renderer) {
        for (const m of meshes.values()) { m.mesh.material.dispose(); m.edges.material.dispose(); }
        if (resultMesh) { resultMesh.geometry.dispose(); resultMesh.material.dispose(); }
        for (const g of Object.values(geoms)) { g.geo.dispose(); g.edges.dispose(); }
        renderer.dispose(); renderer.forceContextLoss(); renderer = null;
      }
      const sb = document.querySelector('#status-project'); if (sb) sb.textContent = '';
    },
  };
}
