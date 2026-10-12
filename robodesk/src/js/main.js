import { h, $, mount } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { api, win } from './api.js';
import { state, loadAppState } from './state.js';
import { defineRoutes, startRouter, navigate } from './router.js';
import { toast, banner } from './ui.js';

const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', group: 'Workspace' },
  { path: '/projects', label: 'Projects', icon: 'projects' },
  { path: '/inventory', label: 'Parts Inventory', icon: 'parts', group: 'Engineering' },
  { path: '/bom', label: 'Bill of Materials', icon: 'bom' },
  { path: '/cad', label: 'CAD Files', icon: 'cad' },
  { path: '/modeler', label: '3D Modeler', icon: 'cube3d' },
  { path: '/wiring', label: 'Wiring Diagrams', icon: 'wiring' },
  { path: '/planner', label: 'Build Planner', icon: 'planner' },
];

const ROUTES = [
  { path: '/dashboard', title: 'Dashboard', nav: '/dashboard', load: () => import('./pages/dashboard.js') },
  { path: '/projects', title: 'Projects', nav: '/projects', load: () => import('./pages/projects.js') },
  { path: '/projects/:id', title: 'Project', nav: '/projects', load: () => import('./pages/project-detail.js') },
  { path: '/inventory', title: 'Parts Inventory', nav: '/inventory', load: () => import('./pages/inventory.js') },
  { path: '/bom/:id?', title: 'Bill of Materials', nav: '/bom', load: () => import('./pages/bom.js') },
  { path: '/cad/:id?', title: 'CAD Files', nav: '/cad', load: () => import('./pages/cad.js') },
  { path: '/modeler/:id?', title: '3D Modeler', nav: '/modeler', flush: true, load: () => import('./pages/modeler.js') },
  { path: '/wiring/:id?', title: 'Wiring Diagrams', nav: '/wiring', flush: true, load: () => import('./pages/wiring.js') },
  { path: '/planner/:id?', title: 'Build Planner', nav: '/planner', load: () => import('./pages/planner.js') },
  { path: '/settings', title: 'Settings', nav: '/settings', load: () => import('./pages/settings.js') },
];

function buildSidebar() {
  const nav = $('#sidebar');
  const items = [];
  for (const n of NAV) {
    if (n.group) items.push(h('div', { class: 'nav-label' }, n.group));
    items.push(h('a', { class: 'nav-item', href: `#${n.path}`, dataset: { nav: n.path } }, icon(n.icon, 17), n.label));
  }
  items.push(h('div', { class: 'nav-spacer' }));
  items.push(h('a', { class: 'nav-item', href: '#/settings', dataset: { nav: '/settings' } }, icon('settings', 17), 'Settings'));
  items.push(h('div', { class: 'nav-foot' }, `RoboDesk v${state.info.version || ''}`));
  mount(nav, items);
}

function onRouteChange(route) {
  $('#titlebar-section').textContent = route.title;
  document.title = `${route.title} · RoboDesk`;
  for (const a of document.querySelectorAll('.nav-item')) {
    if (a.dataset.nav === route.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function wireWindowControls() {
  const svg = (d) => {
    const el = icon('x', 12);
    el.firstChild.setAttribute('d', d);
    return el;
  };
  $('#win-min').append(svg('M5 12h14'));
  $('#win-max').append(svg('M5 5h14v14H5z'));
  $('#win-close').append(svg('M6 6l12 12 M18 6L6 18'));
  $('#brand-icon').append(icon('robot', 17));
  $('#win-min').addEventListener('click', () => win.minimize());
  $('#win-max').addEventListener('click', () => win.toggleMaximize());
  $('#win-close').addEventListener('click', () => win.close());
  $('.titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.window-controls')) return;
    win.toggleMaximize();
  });
}

function updateStatusData() {
  const el = $('#status-data');
  el.textContent = state.info.db_path || '';
  el.title = state.info.db_path ? `Database: ${state.info.db_path}` : '';
}

export function setStatus(text, kind = '') {
  const el = $('#status-text');
  el.textContent = `Status: ${text}`;
  el.dataset.kind = kind;
}

async function boot() {
  wireWindowControls();
  try {
    await loadAppState();
  } catch (e) {
    mount($('#view'), h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon('alert', 26)),
      h('h3', {}, 'RoboDesk could not start'),
      h('p', {}, e.message || 'The local database could not be opened.'),
    ));
    return;
  }
  buildSidebar();
  updateStatusData();
  defineRoutes(ROUTES, $('#view'), onRouteChange);

  if (state.info.startup_warning) {
    setTimeout(() => toast(state.info.startup_warning, 'error', 14000), 400);
  }
  window.addEventListener('unhandledrejection', (ev) => {
    console.error(ev.reason);
    toast(ev.reason?.message || 'Something went wrong.', 'error');
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-7]$/.test(e.key)) {
      const target = NAV[Number(e.key) - 1];
      if (target) { e.preventDefault(); navigate(target.path); }
    }
  });
  await startRouter();
}

export { banner };
boot();
