// 3D modeler: build parts from boxes, cylinders, cones and spheres, place/rotate/scale them,
// and export the result as an STL mesh. Rendering uses a vendored copy of three.js (works offline).
// Pure model logic lives in lib/model-doc.js; the backend validates and stores the document.

import * as THREE from '../../vendor/three/three.module.min.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api, native } from '../api.js';
import * as D from '../lib/model-doc.js';
import { navigate } from '../router.js';
import { state, resolveProject } from '../state.js';
import { btn, confirmDialog, emptyState, formModal, iconBtn, noProjects, projectSelect, selectEl, toast } from '../ui.js';

const LAST_KEY = 'robodesk.lastModel.';
const lastModel = (pid) => { try { return Number(localStorage.getItem(LAST_KEY + pid)) || null; } catch { return null; } };
const rememberModel = (pid, id) => { try { localStorage.setItem(LAST_KEY + pid, String(id)); } catch { /* optional convenience */ } };
const SNAP_KEY = 'robodesk.modelSnap';
const AXES = ['X', 'Y', 'Z'];
const fmt = (v) => String(D.round(v, 3));

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
  const history = new D.History();
  let destroyed = false;

  const root = h('div', { class: 'wiring-root' });
  const toolbar = h('div', { class: 'wiring-toolbar' });
  const palette = h('aside', { class: 'wiring-palette', 'aria-label': 'Shapes and objects' });
  const canvasWrap = h('div', { class: 'wiring-canvas modeler-canvas' });
  const inspector = h('aside', { class: 'wiring-inspector', 'aria-label': 'Inspector' });
  const saveStatus = h('span', { class: 'save-status', role: 'status' });
  mount(root, toolbar, palette, canvasWrap, inspector);
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
  function change(fn, { select } = {}) {
    history.push(doc);
    try { fn(doc); } catch (e) { history.undo(doc); toast(e.message, 'error'); return; }
    if (select !== undefined) selectedId = select;
    markDirty(); paintAll();
  }
  function undo() { const prev = history.undo(doc); if (prev) { doc = prev; fixSelection(); markDirty(); paintAll(); } }
  function redo() { const next = history.redo(doc); if (next) { doc = next; fixSelection(); markDirty(); paintAll(); } }
  function fixSelection() { if (selectedId && !D.findObject(doc, selectedId)) selectedId = null; }
  const selected = () => (selectedId ? D.findObject(doc, selectedId) : null);
  function addShape(shape) {
    if (!current) return;
    let id = null;
    change((d) => { id = D.addObject(d, shape, { snapStep }).id; }, {});
    if (id) { selectedId = id; paintAll(); }
  }
  function deleteSelected() { const o = selected(); if (o) change((d) => D.removeObject(d, o.id), { select: null }); }
  function duplicateSelected() { const o = selected(); if (o) { let id = null; change((d) => { id = D.duplicateObject(d, o.id, Math.max(snapStep, 10)).id; }); if (id) { selectedId = id; paintAll(); } } }

  // ------------------------------------------------------------------- 3D scene
  let renderer = null; let scene; let camera; let rafPending = false;
  const meshes = new Map(); // id -> { mesh, edges }
  const geoms = {};
  const orbit = { target: new THREE.Vector3(0, 0, 20), radius: 260, theta: -Math.PI / 3.2, phi: Math.PI / 3 };
  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function unitGeometry(shape) {
    if (geoms[shape]) return geoms[shape];
    let g;
    if (shape === 'box') g = new THREE.BoxGeometry(1, 1, 1);
    else if (shape === 'cylinder') { g = new THREE.CylinderGeometry(0.5, 0.5, 1, 48); g.rotateX(Math.PI / 2); }
    else if (shape === 'cone') { g = new THREE.CylinderGeometry(0, 0.5, 1, 48); g.rotateX(Math.PI / 2); }
    else { g = new THREE.SphereGeometry(0.5, 32, 16); g.rotateX(Math.PI / 2); }
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
    renderer.domElement.className = 'modeler-gl';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('role', 'application');
    renderer.domElement.setAttribute('aria-label', '3D viewport. Drag to orbit, right-drag to pan, scroll to zoom, click an object to select it.');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar('--canvas-bg', '#0b1220'));
    camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(300, -400, 600); scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9db4ff, 0.6); fill.position.set(-400, 300, 200); scene.add(fill);
    const grid = new THREE.GridHelper(2000, 100, new THREE.Color(cssVar('--text-faint', '#5b6b88')), new THREE.Color(cssVar('--border-strong', '#2c3a56')));
    grid.rotateX(Math.PI / 2);
    scene.add(grid);
    const axis = (to, color) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), to]), new THREE.LineBasicMaterial({ color }));
    scene.add(axis(new THREE.Vector3(60, 0, 0), 0xe5484d), axis(new THREE.Vector3(0, 60, 0), 0x3fb950), axis(new THREE.Vector3(0, 0, 60), 0x4c8dff));
    mount(canvasWrap, renderer.domElement, hint, viewCube);
    placeCamera(); resize();
  }

  function placeCamera() {
    if (!camera) return;
    const { target, radius, theta, phi } = orbit;
    camera.position.set(target.x + radius * Math.sin(phi) * Math.cos(theta), target.y + radius * Math.sin(phi) * Math.sin(theta), target.z + radius * Math.cos(phi));
    camera.lookAt(target);
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
    for (const [id, m] of meshes) if (!live.has(id)) { scene.remove(m.mesh); m.mesh.material.dispose(); m.edges.material.dispose(); meshes.delete(id); }
    for (const o of doc.objects) {
      let m = meshes.get(o.id);
      const g = unitGeometry(o.shape);
      if (m && m.shape !== o.shape) { scene.remove(m.mesh); m.mesh.material.dispose(); m.edges.material.dispose(); meshes.delete(o.id); m = null; }
      if (!m) {
        const mesh = new THREE.Mesh(g.geo, new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.55, metalness: 0.15 }));
        mesh.userData.id = o.id;
        const edges = new THREE.LineSegments(g.edges, new THREE.LineBasicMaterial({ color: 0x0b1220 }));
        mesh.add(edges);
        scene.add(mesh);
        m = { mesh, edges, shape: o.shape };
        meshes.set(o.id, m);
      }
      applyTransform(m.mesh, o);
      m.mesh.visible = o.visible !== false;
      m.mesh.material.color.set(o.color);
      const sel = o.id === selectedId;
      m.mesh.material.emissive.set(sel ? 0x1d3a78 : 0x000000);
      m.edges.material.color.set(sel ? 0x7fb0ff : 0x0b1220);
    }
    requestRender();
  }

  // ------------------------------------------------------------------ camera moves
  function setView(name) {
    const presets = { iso: [-Math.PI / 3.2, Math.PI / 3], front: [-Math.PI / 2, Math.PI / 2], back: [Math.PI / 2, Math.PI / 2], right: [0, Math.PI / 2], left: [Math.PI, Math.PI / 2], top: [-Math.PI / 2, 0.0001] };
    const p = presets[name]; if (!p) return;
    [orbit.theta, orbit.phi] = p; placeCamera();
  }
  function fit() {
    const b = D.docBounds(doc, { visibleOnly: true });
    if (b) {
      orbit.target.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      const diag = Math.hypot(...b.size);
      orbit.radius = Math.max(diag * 1.6, 60);
    } else { orbit.target.set(0, 0, 20); orbit.radius = 260; }
    placeCamera();
  }
  const zoomBy = (f) => { orbit.radius = Math.min(Math.max(orbit.radius * f, 5), 20000); placeCamera(); };

  // -------------------------------------------------------------- pointer interaction
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...meshes.values()].map((m) => m.mesh).filter((m) => m.visible), false);
    return hits[0] ? hits[0].object.userData.id : null;
  }
  const planeHit = (e, z) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), out) ? out : null;
  };
  let gesture = null;
  function bindPointer() {
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      el.focus({ preventScroll: true });
      const id = e.button === 0 && !e.shiftKey ? pick(e) : null;
      if (id) {
        const o = D.findObject(doc, id);
        if (selectedId !== id) { selectedId = id; syncScene(); paintInspector(); paintList(); }
        const hit = planeHit(e, o.position[2]);
        gesture = { type: 'move', id, hit, start: [...o.position], moved: false, sx: e.clientX, sy: e.clientY };
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
        if (!gesture.moved) { history.push(doc); gesture.moved = true; }
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
      if (g.type === 'orbit' && !g.moved && selectedId) { selectedId = null; syncScene(); paintInspector(); paintList(); }
      if (g.type === 'move' && g.moved) { markDirty(); paintAll(); }
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  }

  // -------------------------------------------------------------------- UI: palette/list
  const hint = h('div', { class: 'canvas-hint hidden' });
  const viewCube = h('div', { class: 'view-presets', role: 'group', 'aria-label': 'Camera views' },
    [['iso', 'Iso'], ['front', 'Front'], ['right', 'Right'], ['top', 'Top']].map(([k, l]) => h('button', { class: 'chip', type: 'button', title: `${l} view`, onClick: () => setView(k) }, l)));
  const listHost = h('div', { class: 'obj-list' });

  function paintPalette() {
    mount(palette,
      h('div', { class: 'pal-title' }, 'Add shape'),
      h('div', { class: 'pal-hint' }, 'Click a shape to add it to the model. Drag objects in the viewport to move them.'),
      D.SHAPES.map((t) => h('button', { class: 'pal-item', type: 'button', disabled: !current, 'aria-label': `Add ${t.label}`, onClick: () => addShape(t.shape) }, icon('plus', 14), h('span', { class: 'grow' }, t.label), h('span', { class: 'faint mono', style: { fontSize: '10.5px' } }, t.size.join('×')))),
      h('div', { class: 'pal-title', style: { marginTop: '16px' } }, 'Objects'),
      listHost);
    paintList();
  }
  function paintList() {
    if (!doc.objects.length) { mount(listHost, h('div', { class: 'pal-hint' }, 'No objects yet.')); return; }
    mount(listHost, doc.objects.map((o) => h('div', { class: `obj-row ${o.id === selectedId ? 'selected' : ''}` },
      h('button', { class: 'obj-pick', type: 'button', 'aria-label': `Select ${o.name}`, 'aria-pressed': String(o.id === selectedId), onClick: () => { selectedId = o.id; syncScene(); paintInspector(); paintList(); } },
        h('span', { class: 'swatch sm', style: { background: o.color } }), h('span', { class: 'ellipsis' }, o.name)),
      iconBtn(o.visible === false ? 'eyeOff' : 'eye', o.visible === false ? `Show ${o.name}` : `Hide ${o.name}`, () => change((d) => { const x = D.findObject(d, o.id); x.visible = x.visible === false; })))));
  }

  // ------------------------------------------------------------------ UI: inspector
  let valueInputs = {};
  function numberField(label, getter, setter) {
    const input = h('input', { class: 'input num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': label });
    input.value = fmt(getter());
    input.addEventListener('change', () => {
      const n = D.parseNumber(input.value);
      if (n === null) { toast(`${label}: enter a number.`, 'error', 2500); input.value = fmt(getter()); return; }
      change((d) => setter(d, n));
      const problem = D.validateModel(doc);
      if (problem) { undo(); toast(`${label}: ${n} is out of range.`, 'error', 3000); }
    });
    return { input, refresh: () => { if (document.activeElement !== input) input.value = fmt(getter()); } };
  }
  function paintValues() { for (const f of Object.values(valueInputs)) f.refresh(); }

  function paintInspector() {
    valueInputs = {};
    const o = selected();
    if (!o) {
      const b = D.docBounds(doc, { visibleOnly: true });
      mount(inspector, h('div', { class: 'pal-title' }, 'Model'),
        h('div', { class: 'insp-empty muted' }, doc.objects.length ? 'Select an object to edit it.' : 'Add a shape from the left to start modelling.'),
        b ? h('div', { class: 'stat-list' },
          h('div', {}, h('span', { class: 'faint' }, 'Objects'), h('strong', {}, String(doc.objects.length))),
          h('div', {}, h('span', { class: 'faint' }, 'Overall size'), h('strong', { class: 'mono' }, `${fmt(b.size[0])} × ${fmt(b.size[1])} × ${fmt(b.size[2])} mm`))) : null,
        h('div', { class: 'pal-hint', style: { marginTop: '14px' } }, 'Left-drag: orbit · Right-drag or Shift+drag: pan · Wheel: zoom · Arrow keys: nudge · Del: delete'));
      return;
    }
    const triple = (title, key, step) => h('div', { class: 'field', style: { marginTop: '10px' } }, h('div', { class: 'label' }, title),
      h('div', { class: 'xyz' }, AXES.map((ax, i) => {
        const f = numberField(`${title} ${ax}`, () => (D.findObject(doc, o.id) || o)[key][i], (d, n) => { D.findObject(d, o.id)[key][i] = n; });
        valueInputs[`${key}${i}`] = f;
        return h('label', { class: 'xyz-cell' }, h('span', {}, ax), f.input);
      })));
    const nameInput = h('input', { class: 'input', type: 'text', maxlength: 120, 'aria-label': 'Object name' });
    nameInput.value = o.name;
    nameInput.addEventListener('change', () => { const v = nameInput.value.trim(); if (!v) { nameInput.value = o.name; return; } change((d) => { D.findObject(d, o.id).name = v; }); });
    mount(inspector,
      h('div', { class: 'pal-title' }, `${D.SHAPES.find((t) => t.shape === o.shape).label}`),
      h('div', { class: 'field' }, h('label', {}, 'Name'), nameInput),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('div', { class: 'label' }, 'Colour'),
        h('div', { class: 'swatches' }, D.COLORS.map((c) => h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(c.value === o.color), title: c.name, 'aria-label': c.name, style: { background: c.value }, onClick: () => change((d) => { D.findObject(d, o.id).color = c.value; }) })))),
      triple('Position (mm)', 'position'), triple('Rotation (°)', 'rotation'), triple('Size (mm)', 'size'),
      h('div', { class: 'divider' }),
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
        btn('Duplicate', { size: 'sm', icon: 'copy', onClick: duplicateSelected }),
        btn('Drop to ground', { size: 'sm', onClick: () => change((d) => D.dropToGround(D.findObject(d, o.id))) }),
        btn('Delete', { size: 'sm', icon: 'trash', kind: 'danger', onClick: deleteSelected })));
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
      h('span', { class: 'tb-sep' }),
      iconBtn('undo', 'Undo (Ctrl+Z)', undo, { disabled: !history.canUndo }),
      iconBtn('redo', 'Redo (Ctrl+Y)', redo, { disabled: !history.canRedo }),
      h('span', { class: 'tb-sep' }),
      iconBtn('zoomOut', 'Zoom out', () => zoomBy(1.25), { disabled: !current }),
      iconBtn('zoomIn', 'Zoom in', () => zoomBy(1 / 1.25), { disabled: !current }),
      iconBtn('fit', 'Fit model to window (F)', fit, { disabled: !current }),
      snapSel,
      h('span', { class: 'grow' }), saveStatus,
      btn('Export STL', { size: 'sm', icon: 'download', disabled: !current || !doc.objects.some((o) => o.visible !== false), onClick: exportStl }),
      btn('Save', { size: 'sm', icon: 'save', kind: dirty ? 'primary' : '', disabled: !current || !dirty, onClick: () => save().then((ok) => ok && toast('Model saved', 'success', 1800)) }));
    paintStatus();
  }
  function paintAll() { syncScene(); paintList(); paintInspector(); paintToolbar(); paintHint(); }
  function paintHint() {
    hint.classList.toggle('hidden', doc.objects.length > 0);
    if (!doc.objects.length) mount(hint, h('div', { class: 'empty-icon' }, icon('cube3d', 24)), h('strong', {}, 'Empty model'), h('span', { class: 'muted' }, 'Add a box, cylinder, cone or sphere from the left, then move, rotate and resize it. Export the result as an STL for printing.'));
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
      selectedId = null; dirty = false; saveFailed = false; history.clear();
      rememberModel(pid, id);
      if (!renderer && !scene) { initScene(); if (renderer) bindPointer(); }
      paintPalette(); paintAll();
      requestAnimationFrame(() => fit());
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
      const r = await api('models.export_stl', { id: current.id, path });
      toast(`Exported ${r.triangles.toLocaleString()} triangles to ${path}`, 'success', 5000);
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
  }
  function paintEmpty() {
    mount(root, toolbar, h('div', { class: 'wiring-none' }, emptyState({ icon: 'cube3d', title: 'No 3D models for this project', text: 'Build parts from simple shapes — boxes, cylinders, cones and spheres — position them precisely, and export an STL for 3D printing or CAD import.', actions: [btn('Create model', { icon: 'plus', kind: 'primary', onClick: async () => { const c = await createModel('Chassis'); if (!c) return; mount(root, toolbar, palette, canvasWrap, inspector); await openModel(c.id); } })] })));
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
    else if (e.key === 'Escape') { if (selectedId) { selectedId = null; syncScene(); paintInspector(); paintList(); } }
    else if (e.key.toLowerCase() === 'f' && !mod) fit();
    else if (selectedId && e.key.startsWith('Arrow') || (selectedId && (e.key === 'PageUp' || e.key === 'PageDown'))) {
      e.preventDefault();
      const step = (snapStep || 1) * (e.shiftKey ? 10 : 1);
      const v = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0], PageUp: [0, 0, step], PageDown: [0, 0, -step] }[e.key];
      if (v) change((d) => { const o = D.findObject(d, selectedId); o.position = o.position.map((p, i) => D.round(p + v[i])); });
    }
  }
  document.addEventListener('keydown', onKey);
  const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onVisibility);
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap);

  // ------------------------------------------------------------------------ start
  paintPalette(); paintToolbar();
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
        for (const g of Object.values(geoms)) { g.geo.dispose(); g.edges.dispose(); }
        renderer.dispose(); renderer.forceContextLoss(); renderer = null;
      }
      const sb = document.querySelector('#status-project'); if (sb) sb.textContent = '';
    },
  };
}
