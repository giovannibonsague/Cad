// Wiring diagram editor: SVG canvas with draggable components, pin-to-pin wires,
// pan/zoom, undo/redo and autosave. Pure logic lives in lib/diagram-model.js.

import { h, s, mount, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../api.js';
import * as M from '../lib/diagram-model.js';
import { navigate } from '../router.js';
import { state, resolveProject } from '../state.js';
import { btn, confirmDialog, emptyState, formModal, iconBtn, noProjects, projectSelect, selectEl, toast } from '../ui.js';

const LAST_DIAGRAM_KEY = 'robodesk.lastDiagram.';
const lastDiagram = (pid) => { try { return Number(localStorage.getItem(LAST_DIAGRAM_KEY + pid)) || null; } catch { return null; } };
const rememberDiagram = (pid, id) => { try { localStorage.setItem(LAST_DIAGRAM_KEY + pid, String(id)); } catch { /* optional convenience */ } };

export async function render({ params, view }) {
  const { projects, project } = await resolveProject(params.id);
  if (!project) { mount(view, h('div', { style: { padding: '24px' } }, noProjects(navigate))); return; }
  const pid = project.id;
  let diagrams = await api('diagrams.list', { project_id: pid });

  // ---------------------------------------------------------------- editor state
  let current = null; // { id, name }
  let doc = M.emptyDoc();
  let selection = null; // { type: 'node' | 'wire', id }
  let wireColor = M.WIRE_COLORS[2].value;
  let snapOn = true;
  let dirty = false;
  let saving = false;
  let saveFailed = false;
  const history = new M.History();
  let pending = null; // { from: {node,pin}, cursor: {x,y}, clickMode }
  let destroyed = false;

  const root = h('div', { class: 'wiring-root' });
  const toolbar = h('div', { class: 'wiring-toolbar' });
  const palette = h('aside', { class: 'wiring-palette', 'aria-label': 'Component palette' });
  const canvasWrap = h('div', { class: 'wiring-canvas' });
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
    const t = saving ? 'Saving…' : saveFailed ? 'Save failed — retry with Ctrl+S' : dirty ? (autosaveOn() ? 'Unsaved changes' : 'Unsaved changes (autosave off)') : current ? 'All changes saved' : '';
    saveStatus.textContent = t;
    saveStatus.dataset.kind = saveFailed ? 'error' : dirty ? 'dirty' : 'ok';
    const sb = document.querySelector('#status-project');
    if (sb) sb.textContent = current ? `${project.name} · ${current.name}` : project.name;
  }
  async function save() {
    clearTimeout(timer);
    if (!current || !dirty || saving) return !dirty;
    const problem = M.validateDoc(doc);
    if (problem) { saveFailed = true; paintStatus(); toast(`Cannot save: ${problem}`, 'error'); return false; }
    saving = true; paintStatus();
    const snapshot = JSON.stringify(doc);
    try {
      const meta = await api('diagrams.save', { id: current.id, data: doc });
      dirty = JSON.stringify(doc) !== snapshot; // edits made while saving stay dirty
      diagrams = diagrams.map((d) => (d.id === meta.id ? meta : d));
      saveFailed = false;
    } catch (e) { saveFailed = true; toast(`Could not save diagram: ${e.message}`, 'error'); }
    saving = false; paintStatus();
    if (dirty && !saveFailed && autosaveOn()) markDirty();
    return !dirty;
  }

  // ----------------------------------------------------------------- mutations
  /** Run a change with undo support. */
  function change(fn, { keepSelection = true } = {}) {
    history.push(doc);
    fn(doc);
    if (!keepSelection) selection = null;
    markDirty();
    paintAll();
  }
  function undo() { const prev = history.undo(doc); if (prev) { doc = prev; fixSelection(); markDirty(); paintAll(); } }
  function redo() { const next = history.redo(doc); if (next) { doc = next; fixSelection(); markDirty(); paintAll(); } }
  function fixSelection() {
    if (selection?.type === 'node' && !M.findNode(doc, selection.id)) selection = null;
    if (selection?.type === 'wire' && !doc.wires.some((w) => w.id === selection.id)) selection = null;
  }
  function deleteSelection() {
    if (!selection) return;
    const sel = selection;
    change((d) => { if (sel.type === 'node') M.removeNode(d, sel.id); else M.removeWire(d, sel.id); }, { keepSelection: false });
  }

  // ----------------------------------------------------------------- canvas
  const svg = s('svg', { class: 'wiring-svg', tabindex: 0, role: 'application', 'aria-label': 'Wiring diagram canvas. Drag components to move them, drag from a pin to another pin to draw a wire.' });
  const gridPattern = s('pattern', { id: 'grid-pattern', width: M.GRID, height: M.GRID, patternUnits: 'userSpaceOnUse' }, s('circle', { cx: 1, cy: 1, r: 1, class: 'grid-dot' }));
  const world = s('g', { class: 'world' });
  const wireLayer = s('g', { class: 'wire-layer' });
  const nodeLayer = s('g', { class: 'node-layer' });
  const pendingPath = s('path', { class: 'wire-pending', fill: 'none' });
  world.append(wireLayer, nodeLayer, pendingPath);
  svg.append(s('defs', {}, gridPattern), s('rect', { class: 'grid-bg', width: '100%', height: '100%', fill: 'url(#grid-pattern)' }), world);

  const hint = h('div', { class: 'canvas-hint hidden' });
  const zoomLabel = h('span', { class: 'zoom-label' });
  canvasWrap.append(svg, hint);

  function applyView() {
    const v = doc.view;
    world.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.zoom})`);
    gridPattern.setAttribute('patternTransform', `translate(${v.x} ${v.y}) scale(${v.zoom})`);
    zoomLabel.textContent = `${Math.round(v.zoom * 100)}%`;
  }
  const size = () => { const r = svg.getBoundingClientRect(); return { w: r.width, h: r.height }; };
  const local = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const worldPt = (e) => M.screenToWorld(doc.view, local(e));
  // Pan/zoom is stored with the diagram but never counts as an unsaved change by itself.
  function setView(v) { doc.view = v; applyView(); }
  const zoomBy = (f) => { const sz = size(); setView(M.zoomAt(doc.view, f, { x: sz.w / 2, y: sz.h / 2 })); };
  const fit = () => { const sz = size(); setView(M.fitView(doc, { w: sz.w, h: sz.h })); };

  // ----------------------------------------------------------------- drawing
  const connectedPins = () => { const set = new Set(); for (const w of doc.wires) { set.add(`${w.from.node}:${w.from.pin}`); set.add(`${w.to.node}:${w.to.pin}`); } return set; };

  function drawNode(n, connected) {
    const w = M.nodeWidth(n); const hgt = M.nodeHeight(n);
    const selected = selection?.type === 'node' && selection.id === n.id;
    const accent = M.KIND_COLOR[n.kind] || M.KIND_COLOR.generic;
    const g = s('g', { class: `node ${selected ? 'selected' : ''}`, transform: `translate(${n.x} ${n.y})`, dataset: { node: n.id } },
      s('rect', { class: 'node-body', width: w, height: hgt, rx: 8 }),
      s('path', { class: 'node-head', d: `M0 8 a8 8 0 0 1 8 -8 h${w - 16} a8 8 0 0 1 8 8 v${M.HEAD_H - 8} h${-w} z` }),
      s('rect', { x: 0, y: 0, width: 4, height: M.HEAD_H, fill: accent, rx: 2 }),
      s('text', { class: 'node-title', x: 14, y: 20 }, n.label),
      s('title', {}, `${n.label} (${n.kind})`));
    for (const q of n.pins) {
      const pos = M.pinPos(n, q);
      const x = pos.x - n.x; const y = pos.y - n.y;
      const isConn = connected.has(`${n.id}:${q.id}`);
      const anchor = q.side === 'left' ? 'start' : q.side === 'right' ? 'end' : 'middle';
      const tx = q.side === 'left' ? x + 11 : q.side === 'right' ? x - 11 : x;
      const ty = q.side === 'top' ? y - 9 : q.side === 'bottom' ? y + 16 : y + 4;
      g.append(
        s('text', { class: 'pin-label', x: tx, y: ty, 'text-anchor': anchor }, q.name),
        s('circle', { class: `pin ${isConn ? 'connected' : ''}`, cx: x, cy: y, r: M.PIN_R }),
        s('circle', { class: 'pin-hit', cx: x, cy: y, r: 11, dataset: { node: n.id, pin: q.id }, 'aria-label': `${n.label} pin ${q.name}` }, s('title', {}, `${n.label} · ${q.name}`)),
      );
    }
    return g;
  }

  function drawWire(wr) {
    const a = M.endpointPos(doc, wr.from); const b = M.endpointPos(doc, wr.to);
    if (!a || !b) return null;
    const d = M.wirePath(a, b);
    const selected = selection?.type === 'wire' && selection.id === wr.id;
    const g = s('g', { class: `wire ${selected ? 'selected' : ''}`, dataset: { wire: wr.id } },
      s('path', { class: 'wire-hit', d, fill: 'none' }),
      s('path', { class: 'wire-line', d, fill: 'none', stroke: wr.color }));
    if (wr.label) {
      const m = M.wireMid(a, b);
      const tw = wr.label.length * 6.4 + 12;
      g.append(s('rect', { class: 'wire-label-bg', x: m.x - tw / 2, y: m.y - 9, width: tw, height: 18, rx: 4 }), s('text', { class: 'wire-label', x: m.x, y: m.y + 4, 'text-anchor': 'middle' }, wr.label));
    }
    return g;
  }

  function paintWires() { wireLayer.replaceChildren(...doc.wires.map(drawWire).filter(Boolean)); }
  function paintNodes() { const c = connectedPins(); nodeLayer.replaceChildren(...doc.nodes.map((n) => drawNode(n, c))); }
  function paintHint() {
    hint.classList.toggle('hidden', doc.nodes.length > 0);
    if (!doc.nodes.length) mount(hint, h('div', { class: 'empty-icon' }, icon('wiring', 24)), h('strong', {}, 'Empty diagram'), h('span', { class: 'muted' }, 'Drag a component from the palette, or click one to add it. Then drag from one pin to another to connect them.'));
  }
  function paintAll() { paintNodes(); paintWires(); paintPending(); applyView(); paintInspector(); paintToolbar(); paintHint(); }

  function paintPending() {
    if (!pending) { pendingPath.setAttribute('d', ''); return; }
    const a = M.endpointPos(doc, pending.from);
    if (!a) { pending = null; pendingPath.setAttribute('d', ''); return; }
    const b = { x: pending.cursor.x, y: pending.cursor.y, side: a.side === 'left' ? 'right' : a.side === 'right' ? 'left' : a.side === 'top' ? 'bottom' : 'top' };
    pendingPath.setAttribute('d', M.wirePath(a, b));
    pendingPath.setAttribute('stroke', wireColor);
  }

  // -------------------------------------------------------------- interactions
  let gesture = null; // { type: 'pan'|'node'|'wire', ... }
  const pinFromEvent = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.pin-hit');
    return el ? { node: el.dataset.node, pin: el.dataset.pin } : null;
  };
  const clearTargets = () => svg.querySelectorAll('.pin-target').forEach((p) => p.classList.remove('pin-target'));
  const showTarget = (end) => { clearTargets(); if (!end) return; const el = [...svg.querySelectorAll('.pin-hit')].find((p) => p.dataset.node === end.node && p.dataset.pin === end.pin); el?.previousSibling?.classList.add('pin-target'); };

  function finishWire(from, to) {
    const res = M.addWire(structuredClone(doc), from, to, wireColor);
    if (res.error) { toast(res.error, 'info'); return false; }
    change((d) => { const r = M.addWire(d, from, to, wireColor); selection = { type: 'wire', id: r.wire.id }; });
    return true;
  }

  svg.addEventListener('pointerdown', (e) => {
    svg.focus({ preventScroll: true });
    const pin = e.target.closest?.('.pin-hit');
    const nodeEl = e.target.closest?.('.node');
    const wireEl = e.target.closest?.('.wire');

    if (pending && pending.clickMode && e.button === 0) { // second click of click-click wiring
      const target = pinFromEvent(e);
      if (target) { finishWire(pending.from, target); }
      pending = null; paintPending(); clearTargets();
      e.preventDefault();
      return;
    }
    if (e.button === 1 || (e.button === 0 && !pin && !nodeEl && !wireEl)) {
      gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: doc.view.x, vy: doc.view.y, moved: false };
      svg.setPointerCapture(e.pointerId); svg.classList.add('panning'); e.preventDefault();
    } else if (e.button === 0 && pin) {
      const from = { node: pin.dataset.node, pin: pin.dataset.pin };
      const a = M.endpointPos(doc, from);
      pending = { from, cursor: worldPt(e), clickMode: false, moved: false, origin: { x: e.clientX, y: e.clientY } };
      gesture = { type: 'wire' };
      svg.setPointerCapture(e.pointerId); paintPending(); e.preventDefault();
      if (!a) pending = null;
    } else if (e.button === 0 && nodeEl) {
      const n = M.findNode(doc, nodeEl.dataset.node);
      select({ type: 'node', id: n.id });
      const wp = worldPt(e);
      gesture = { type: 'node', id: n.id, dx: wp.x - n.x, dy: wp.y - n.y, started: false, startX: e.clientX, startY: e.clientY };
      svg.setPointerCapture(e.pointerId); e.preventDefault();
    } else if (e.button === 0 && wireEl) {
      select({ type: 'wire', id: wireEl.dataset.wire }); e.preventDefault();
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!gesture && pending?.clickMode) { pending.cursor = worldPt(e); paintPending(); showTarget(pinFromEvent(e)); return; }
    if (!gesture) return;
    if (gesture.type === 'pan') {
      const dx = e.clientX - gesture.sx; const dy = e.clientY - gesture.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true;
      doc.view.x = gesture.vx + dx; doc.view.y = gesture.vy + dy; applyView();
    } else if (gesture.type === 'node') {
      const n = M.findNode(doc, gesture.id);
      if (!n) return;
      if (!gesture.started) { if (Math.abs(e.clientX - gesture.startX) + Math.abs(e.clientY - gesture.startY) < 3) return; history.push(doc); gesture.started = true; }
      const wp = worldPt(e);
      n.x = M.snap(wp.x - gesture.dx, snapOn && !e.altKey); n.y = M.snap(wp.y - gesture.dy, snapOn && !e.altKey);
      nodeLayer.querySelector(`[data-node="${CSS.escape(n.id)}"].node`)?.setAttribute('transform', `translate(${n.x} ${n.y})`);
      paintWires();
    } else if (gesture.type === 'wire' && pending) {
      pending.cursor = worldPt(e);
      if (Math.hypot(e.clientX - pending.origin.x, e.clientY - pending.origin.y) > 4) pending.moved = true;
      paintPending(); showTarget(pinFromEvent(e));
    }
  });

  const endGesture = (e) => {
    if (!gesture) return;
    const g = gesture; gesture = null;
    try { svg.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    svg.classList.remove('panning');
    if (g.type === 'pan') {
      if (!g.moved && e.type === 'pointerup') select(null);
    } else if (g.type === 'node') {
      if (g.started) { markDirty(); paintInspector(); }
    } else if (g.type === 'wire' && pending) {
      const target = pinFromEvent(e);
      if (e.type === 'pointercancel') { pending = null; }
      else if (target && !(target.node === pending.from.node && target.pin === pending.from.pin)) { finishWire(pending.from, target); pending = null; }
      else if (!pending.moved) { pending.clickMode = true; hintToast(); } // click without drag: finish with a second click
      else pending = null;
      clearTargets(); paintPending();
    }
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);
  let hinted = false;
  const hintToast = () => { if (!hinted) { hinted = true; toast('Now click the pin to connect to (Esc to cancel).', 'info', 2600); } };

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    setView(M.zoomAt(doc.view, f, local(e)));
  }, { passive: false });

  svg.addEventListener('dblclick', (e) => {
    if (e.target.closest?.('.node')) { inspector.querySelector('[data-focus="label"]')?.focus(); inspector.querySelector('[data-focus="label"]')?.select?.(); }
  });

  // drag from palette
  canvasWrap.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-robodesk-template')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  canvasWrap.addEventListener('drop', (e) => {
    const idx = Number(e.dataTransfer.getData('text/x-robodesk-template'));
    if (!Number.isInteger(idx) || !M.TEMPLATES[idx]) return;
    e.preventDefault();
    addFromTemplate(M.TEMPLATES[idx], worldPt(e));
  });

  function addFromTemplate(tpl, at) {
    if (!current) return;
    let node;
    const where = at || (() => { const sz = size(); return M.findFreeSpot(doc, tpl, M.screenToWorld(doc.view, { x: sz.w / 2, y: sz.h / 2 })); })();
    change((d) => { node = M.addNode(d, tpl, where, { snapToGrid: snapOn }); selection = { type: 'node', id: node.id }; });
  }

  // keyboard
  function onKey(e) {
    if (destroyed) return;
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save().then((ok) => ok && toast('Diagram saved', 'success', 1800)); return; }
    if (typing || document.querySelector('.overlay')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') { if (pending) { pending = null; paintPending(); clearTargets(); } else select(null); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
    if (selection?.type === 'node' && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? M.GRID : 2;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      change((d) => { const n = M.findNode(d, selection.id); n.x += dx; n.y += dy; });
    }
  }
  document.addEventListener('keydown', onKey);
  const onVisibility = () => { if (document.hidden && dirty) save(); };
  document.addEventListener('visibilitychange', onVisibility);
  const ro = new ResizeObserver(() => applyView());
  ro.observe(canvasWrap);

  function select(sel) {
    selection = sel;
    nodeLayer.querySelectorAll('.node').forEach((el) => el.classList.toggle('selected', sel?.type === 'node' && el.dataset.node === sel.id));
    wireLayer.querySelectorAll('.wire').forEach((el) => el.classList.toggle('selected', sel?.type === 'wire' && el.dataset.wire === sel.id));
    paintInspector();
  }

  // ------------------------------------------------------------------ palette
  function paintPalette() {
    mount(palette,
      h('div', { class: 'pal-title' }, 'Components'),
      h('div', { class: 'pal-hint' }, 'Click to add, or drag onto the canvas.'),
      M.TEMPLATES.map((t, i) => h('button', { class: 'pal-item', type: 'button', draggable: 'true', title: `Add ${t.label}`, disabled: !current,
        onClick: () => addFromTemplate(t), onDragstart: (e) => { e.dataTransfer.setData('text/x-robodesk-template', String(i)); e.dataTransfer.effectAllowed = 'copy'; } },
        h('span', { class: 'pal-swatch', style: { background: M.KIND_COLOR[t.kind] } }), h('span', { class: 'grow' }, t.label), h('span', { class: 'faint' }, `${t.pins.length} pins`))),
      h('div', { class: 'pal-title', style: { marginTop: '14px' } }, 'Wire colour'),
      h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Wire colour for new wires' }, M.WIRE_COLORS.map((c) => h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(c.value === wireColor), title: c.name, 'aria-label': c.name, style: { background: c.value }, onClick: () => { wireColor = c.value; paintPalette(); } }))),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: snapOn, onChange: (e) => { snapOn = e.target.checked; } }), 'Snap to grid'),
      h('div', { class: 'pal-hint', style: { marginTop: '12px' } }, 'Alt-drag moves without snapping. Wheel zooms, drag the background to pan. Del removes the selection.'));
  }

  // ---------------------------------------------------------------- inspector
  function textInput(value, onCommit, { label, focusKey, maxlength = 120, placeholder = '' } = {}) {
    const input = h('input', { class: 'input sm', type: 'text', value, maxlength, placeholder, 'aria-label': label, dataset: focusKey ? { focus: focusKey } : {} });
    let began = false;
    input.addEventListener('focus', () => { began = false; });
    input.addEventListener('input', () => { if (!began) { history.push(doc); began = true; } onCommit(input.value, true); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('blur', () => { if (!began) return; began = false; markDirty(); setTimeout(() => { if (!destroyed) paintAll(); }, 0); });
    return input;
  }

  function paintInspector() {
    // Do not rebuild while the user is typing in the inspector: it would steal focus.
    if (inspector.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && gesture === null && inspector.dataset.sel === selKey()) return;
    inspector.dataset.sel = selKey();
    if (!current) { mount(inspector, h('div', { class: 'insp-empty muted' }, 'Create a diagram to start.')); return; }
    if (!selection) {
      mount(inspector, h('div', { class: 'pal-title' }, 'Diagram'),
        h('div', { class: 'kv' }, h('dt', {}, 'Name'), h('dd', {}, current.name), h('dt', {}, 'Components'), h('dd', {}, String(doc.nodes.length)), h('dt', {}, 'Wires'), h('dd', {}, String(doc.wires.length))),
        h('div', { class: 'divider' }),
        h('div', { class: 'pal-hint' }, 'Select a component or wire to edit it. Draw a wire by dragging from one pin to another.'),
        doc.wires.length ? h('div', { class: 'pal-title', style: { marginTop: '14px' } }, 'Connections') : null,
        h('div', { class: 'conn-list' }, doc.wires.map((w) => h('button', { class: 'conn-item', type: 'button', onClick: () => select({ type: 'wire', id: w.id }) }, h('span', { class: 'swatch sm', style: { background: w.color } }), h('span', { class: 'ellipsis' }, describeWire(w))))));
      return;
    }
    if (selection.type === 'wire') {
      const w = doc.wires.find((x) => x.id === selection.id);
      if (!w) { selection = null; paintInspector(); return; }
      mount(inspector, h('div', { class: 'pal-title' }, 'Wire'),
        h('div', { class: 'faint', style: { fontSize: '12px', marginBottom: '10px', wordBreak: 'break-word' } }, describeWire(w)),
        h('div', { class: 'field' }, h('label', {}, 'Label'), textInput(w.label || '', (v) => { w.label = v; paintWires(); }, { label: 'Wire label', maxlength: 60, placeholder: 'e.g. PWM, 5V, GND' })),
        h('div', { class: 'field', style: { marginTop: '10px' } }, h('div', { class: 'label' }, 'Colour'),
          h('div', { class: 'swatches' }, M.WIRE_COLORS.map((c) => h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(c.value === w.color), title: c.name, 'aria-label': c.name, style: { background: c.value }, onClick: () => change((d) => { d.wires.find((x) => x.id === w.id).color = c.value; }) })))),
        h('div', { class: 'divider' }), btn('Delete wire', { icon: 'trash', kind: 'danger', onClick: deleteSelection }));
      return;
    }
    const n = M.findNode(doc, selection.id);
    if (!n) { selection = null; paintInspector(); return; }
    const sideOpts = [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']];
    const pinRow = (q) => h('div', { class: 'pin-row' },
      textInput(q.name, (v) => { q.name = v || ' '; }, { label: `Pin name`, maxlength: 60 }),
      (() => { const sel = h('select', { class: 'select sm', 'aria-label': `Side of pin ${q.name}`, style: { width: '84px' } }, sideOpts.map(([v, l]) => h('option', { value: v }, l))); sel.value = q.side; sel.addEventListener('change', () => change((d) => { M.findPin(M.findNode(d, n.id), q.id).side = sel.value; })); return sel; })(),
      iconBtn('x', `Delete pin ${q.name}`, () => { const attached = doc.wires.filter((w) => (w.from.node === n.id && w.from.pin === q.id) || (w.to.node === n.id && w.to.pin === q.id)).length; change((d) => M.removePin(d, n.id, q.id)); if (attached) toast(`Removed pin and ${attached} attached wire${attached > 1 ? 's' : ''}`, 'info'); }));
    const kindSel = h('select', { class: 'select sm', 'aria-label': 'Component type' }, M.TEMPLATES.map((t) => h('option', { value: t.kind }, t.kind[0].toUpperCase() + t.kind.slice(1))));
    kindSel.value = n.kind; kindSel.addEventListener('change', () => change((d) => { M.findNode(d, n.id).kind = kindSel.value; }));
    let newSide = 'left';
    mount(inspector, h('div', { class: 'pal-title' }, 'Component'),
      h('div', { class: 'field' }, h('label', {}, 'Label'), textInput(n.label, (v) => { n.label = v || ' '; paintNodes(); paintWires(); }, { label: 'Component label', focusKey: 'label' })),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', {}, 'Type'), kindSel),
      h('div', { class: 'pal-title', style: { marginTop: '14px' } }, `Pins (${n.pins.length})`),
      h('div', { class: 'pin-list' }, n.pins.map(pinRow)),
      h('div', { class: 'row', style: { marginTop: '8px' } }, selectEl({ label: 'Side for new pin', value: 'left', options: sideOpts.map(([v, l]) => ({ value: v, label: l })), onChange: (v) => { newSide = v; }, className: 'sm' }),
        btn('Add pin', { size: 'sm', icon: 'plus', onClick: () => change((d) => M.addPin(d, n.id, '', newSide)) })),
      h('div', { class: 'divider' }),
      h('div', { class: 'row' }, btn('Duplicate', { size: 'sm', icon: 'copy', onClick: () => change((d) => { const src = M.findNode(d, n.id); const c = M.addNode(d, { kind: src.kind, label: `${src.label} copy`.slice(0, 120), pins: src.pins.map((q) => ({ name: q.name, side: q.side })) }, { x: src.x + 40, y: src.y + 40 }); selection = { type: 'node', id: c.id }; }) }),
        btn('Delete', { size: 'sm', icon: 'trash', kind: 'danger', onClick: deleteSelection })));
  }
  const selKey = () => (selection ? `${selection.type}:${selection.id}` : 'none');
  function describeWire(w) {
    const end = (e) => { const n = M.findNode(doc, e.node); const q = M.findPin(n, e.pin); return n && q ? `${n.label}.${q.name}` : '?'; };
    return `${end(w.from)} → ${end(w.to)}${w.label ? ` (${w.label})` : ''}`;
  }

  // ------------------------------------------------------------------ toolbar
  function paintToolbar() {
    const diagSel = h('select', { class: 'select select-inline', 'aria-label': 'Diagram', disabled: !diagrams.length }, diagrams.length ? diagrams.map((d) => h('option', { value: d.id }, `${d.name} (${d.nodes} parts, ${d.wires} wires)`)) : [h('option', {}, 'No diagrams')]);
    if (current) diagSel.value = String(current.id);
    diagSel.addEventListener('change', () => openDiagram(Number(diagSel.value)));
    mount(toolbar,
      projectSelect({ projects, value: pid, label: 'Project', onChange: async (id) => { await flush(); navigate(`/wiring/${id}`); } }),
      diagSel,
      btn('New', { size: 'sm', icon: 'plus', onClick: newDiagram }),
      iconBtn('edit', 'Rename diagram', renameDiagram, { disabled: !current }),
      iconBtn('trash', 'Delete diagram', deleteDiagram, { disabled: !current }),
      h('span', { class: 'tb-sep' }),
      iconBtn('undo', 'Undo (Ctrl+Z)', undo, { disabled: !history.canUndo }),
      iconBtn('redo', 'Redo (Ctrl+Y)', redo, { disabled: !history.canRedo }),
      h('span', { class: 'tb-sep' }),
      iconBtn('zoomOut', 'Zoom out', () => zoomBy(1 / 1.25), { disabled: !current }), zoomLabel,
      iconBtn('zoomIn', 'Zoom in', () => zoomBy(1.25), { disabled: !current }),
      iconBtn('fit', 'Fit diagram to window', fit, { disabled: !current }),
      h('span', { class: 'grow' }), saveStatus,
      btn('Save', { size: 'sm', icon: 'save', kind: dirty ? 'primary' : '', disabled: !current || !dirty, onClick: () => save().then((ok) => ok && toast('Diagram saved', 'success', 1800)) }));
    applyView(); paintStatus();
  }

  // ---------------------------------------------------------------- diagram ops
  async function flush() {
    if (!current || !dirty) return true;
    if (autosaveOn()) return save();
    const yes = await confirmDialog({ title: 'Save diagram changes?', message: `“${current.name}” has unsaved changes.`, confirmLabel: 'Save changes', cancelLabel: 'Discard', danger: false });
    if (yes) return save();
    dirty = false; return true;
  }
  async function openDiagram(id) {
    if (current && current.id !== id) await flush();
    try {
      const d = await api('diagrams.get', { id });
      current = { id: d.id, name: d.name };
      doc = { ...M.emptyDoc(), ...d.data, view: { ...M.emptyDoc().view, ...(d.data.view || {}) } };
      selection = null; pending = null; dirty = false; saveFailed = false; history.clear();
      rememberDiagram(pid, id);
      paintPalette(); paintAll();
      requestAnimationFrame(() => { if (!d.data.view || (doc.view.x === 0 && doc.view.y === 0 && doc.view.zoom === 1)) { const sz = size(); if (doc.nodes.length && sz.w) { doc.view = M.fitView(doc, { w: sz.w, h: sz.h }); applyView(); } } });
    } catch (e) { toast(e.message, 'error'); }
  }
  async function newDiagram() {
    if (!(await flush())) return;
    const created = await formModal({ title: 'New wiring diagram', size: 'narrow', submitLabel: 'Create', fields: [{ name: 'name', label: 'Diagram name', required: true, value: diagrams.length ? '' : 'Main wiring', maxlength: 120, placeholder: 'e.g. Power distribution' }], onSubmit: (v) => api('diagrams.create', { project_id: pid, name: v.name }) });
    if (!created) return;
    diagrams = await api('diagrams.list', { project_id: pid });
    await openDiagram(created.id);
  }
  async function renameDiagram() {
    const r = await formModal({ title: 'Rename diagram', size: 'narrow', fields: [{ name: 'name', label: 'Name', required: true, value: current.name, maxlength: 120 }], onSubmit: async (v) => { await flush(); return api('diagrams.save', { id: current.id, data: doc, name: v.name }); } });
    if (!r) return;
    current.name = r.name; dirty = false; diagrams = await api('diagrams.list', { project_id: pid }); paintToolbar(); paintInspector();
  }
  async function deleteDiagram() {
    if (!(await confirmDialog({ title: 'Delete diagram?', message: `“${current.name}” (${doc.nodes.length} components, ${doc.wires.length} wires) will be permanently deleted.`, confirmLabel: 'Delete diagram' }))) return;
    try {
      await api('diagrams.delete', { id: current.id });
      dirty = false; diagrams = await api('diagrams.list', { project_id: pid }); current = null; doc = M.emptyDoc();
      if (diagrams.length) await openDiagram(diagrams[0].id); else { paintEmpty(); }
      toast('Diagram deleted', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  function paintEmpty() {
    mount(root, toolbar, h('div', { class: 'wiring-none' }, emptyState({ icon: 'wiring', title: 'No wiring diagrams for this project', text: 'Add labelled components, connect their pins with coloured wires, and keep the diagram with the project.', actions: [btn('Create diagram', { icon: 'plus', kind: 'primary', onClick: async () => { await newDiagramFirst(); } })] })));
    paintToolbar();
  }
  async function newDiagramFirst() {
    const created = await formModal({ title: 'New wiring diagram', size: 'narrow', submitLabel: 'Create', fields: [{ name: 'name', label: 'Diagram name', required: true, value: 'Main wiring', maxlength: 120 }], onSubmit: (v) => api('diagrams.create', { project_id: pid, name: v.name }) });
    if (!created) return;
    diagrams = await api('diagrams.list', { project_id: pid });
    mount(root, toolbar, palette, canvasWrap, inspector);
    await openDiagram(created.id);
  }

  // ------------------------------------------------------------------- start
  paintPalette(); paintToolbar();
  if (!diagrams.length) paintEmpty();
  else await openDiagram(diagrams.find((d) => d.id === lastDiagram(pid))?.id ?? diagrams[0].id);

  return {
    async destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect(); clearTimeout(timer);
      await flush();
      const sb = document.querySelector('#status-project'); if (sb) sb.textContent = '';
    },
  };
}
