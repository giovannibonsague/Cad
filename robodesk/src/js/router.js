// Minimal hash router. A page module exports `render(ctx)`, which may return
// `{ destroy() }`; destroy is awaited before the next page renders (used to flush saves).

import { h, mount } from './lib/dom.js';
import { icon } from './lib/icons.js';

const routes = [];
let current = null;
let token = 0;
let viewEl = null;
let onChange = () => {};

export function defineRoutes(list, view, changed) {
  viewEl = view;
  onChange = changed || onChange;
  for (const r of list) {
    const keys = [];
    const re = new RegExp(
      '^' + r.path.replace(/\/:([a-zA-Z]+)(\?)?/g, (_, k, opt) => { keys.push(k); return opt ? '(?:/([^/]+))?' : '/([^/]+)'; }) + '/?$',
    );
    routes.push({ ...r, re, keys });
  }
}

function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return null;
}

export const currentPath = () => (location.hash.replace(/^#/, '').split('?')[0] || '/dashboard');
export const currentQuery = () => new URLSearchParams(location.hash.split('?')[1] || '');

export function navigate(path) {
  if (location.hash.replace(/^#/, '') === path) return render();
  location.hash = path;
}

export async function render() {
  const my = ++token;
  const path = currentPath();
  if (current?.destroy) {
    try { await current.destroy(); } catch (e) { console.error('page destroy failed', e); }
  }
  current = null;
  if (my !== token) return;

  const hit = match(path) || match('/dashboard');
  viewEl.className = 'view' + (hit.route.flush ? ' flush' : '');
  mount(viewEl, h('div', { class: 'empty' }, h('span', { class: 'muted' }, 'Loading…')));
  onChange(hit.route, hit.params, path);
  try {
    const page = await hit.route.load();
    const container = h('div', { style: hit.route.flush ? { height: '100%' } : {} });
    if (my !== token) return;
    mount(viewEl, container);
    const result = await page.render({ params: hit.params, view: container });
    if (my !== token) { await result?.destroy?.(); return; }
    current = result || null;
    viewEl.scrollTop = 0;
  } catch (e) {
    console.error(e);
    if (my !== token) return;
    mount(
      viewEl,
      h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon('alert', 24)),
        h('h3', {}, 'This page could not be shown'),
        h('p', {}, e?.message || 'Unexpected error.'),
        h('div', { class: 'empty-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => render() }, icon('refresh'), 'Try again')),
      ),
    );
  }
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  return render();
}
