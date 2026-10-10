// Reusable UI components.

import { h, $, clear } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { state } from './state.js';

let uidCounter = 0;
export const uid = (p = 'id') => `${p}-${++uidCounter}`;

// ------------------------------------------------------------------ toasts

export function toast(message, kind = 'info', ms = 3800) {
  const root = $('#toast-root');
  const name = kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info';
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(name, 16), h('span', {}, message));
  root.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 6500) : ms);
  return el;
}

// ------------------------------------------------------------------ modals

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function openModal({ title, body, footer, size = '', persistent = false, initialFocus }) {
  const root = $('#overlay-root');
  const prevFocus = document.activeElement;
  const titleId = uid('modal-title');
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let isClosed = false;

  const close = (result) => {
    if (isClosed) return;
    isClosed = true;
    overlay.remove();
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    resolveClosed(result);
  };

  const footEl = h('div', { class: 'modal-foot' }, footer);
  const dialog = h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' },
      h('h2', { id: titleId }, title),
      h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close', onClick: () => close(undefined) }, icon('x')),
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? footEl : null,
  );
  const overlay = h('div', {
    class: 'overlay',
    onMousedown: (e) => { if (e.target === overlay && !persistent) close(undefined); },
    onKeydown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); return; }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
  }, dialog);
  root.append(overlay);
  requestAnimationFrame(() => {
    const target = (typeof initialFocus === 'function' ? initialFocus() : initialFocus) || dialog.querySelector('input:not([type=hidden]), select, textarea') || dialog.querySelector('.modal-foot .btn.primary') || dialog.querySelector('.modal-head button');
    target?.focus();
  });
  return { close, closed, el: dialog, footEl };
}

/** Yes/no confirmation. Resolves true/false. `requireText` forces the user to type a phrase. */
export function confirmDialog({ title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true, requireText = null, always = true, details = null }) {
  if (!always && state.settings.confirm_destructive === false) return Promise.resolve(true);
  const input = requireText ? h('input', { class: 'input', type: 'text', 'aria-label': `Type ${requireText} to confirm`, autocomplete: 'off', spellcheck: 'false' }) : null;
  const confirmBtn = h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', disabled: !!requireText }, confirmLabel);
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, cancelLabel);
  const body = h('div', { class: 'form' },
    h('p', {}, message),
    details,
    requireText ? h('div', { class: 'field' }, h('label', {}, ['Type ', h('span', { class: 'kbd' }, requireText), ' to confirm']), input) : null,
  );
  const m = openModal({ title, body, footer: [cancelBtn, confirmBtn], size: 'narrow', initialFocus: () => input || cancelBtn });
  cancelBtn.addEventListener('click', () => m.close(false));
  confirmBtn.addEventListener('click', () => m.close(true));
  if (input) {
    input.addEventListener('input', () => { confirmBtn.disabled = input.value !== requireText; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value === requireText) m.close(true); });
  }
  return m.closed.then((r) => r === true);
}

export function alertDialog({ title, message, kind = 'info' }) {
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'OK');
  const m = openModal({ title, body: h('div', { class: 'banner ' + kind, style: { margin: 0 } }, icon(kind === 'info' ? 'info' : 'alert', 18), h('div', { class: 'grow' }, message)), footer: ok, size: 'narrow' });
  ok.addEventListener('click', () => m.close());
  return m.closed;
}

// ------------------------------------------------------------------ forms

/**
 * spec: { name, label, type: text|textarea|select|date|money|number, value, options, required, hint,
 *         placeholder, rows, prefix, suffix, parse(raw) -> value (throw Error(msg) to reject) }
 */
export function field(spec) {
  const { label, name, type = 'text', value = '', options = [], required = false, hint, placeholder, rows = 3, prefix, suffix, maxlength, readonly = false, parse, onInput } = spec;
  const id = uid('f');
  let input;
  if (type === 'textarea') input = h('textarea', { class: 'textarea', id, rows, maxlength, placeholder });
  else if (type === 'select') {
    input = h('select', { class: 'select', id }, options.map((o) => h('option', { value: o.value }, o.label)));
  } else {
    input = h('input', { class: 'input', id, type: type === 'money' || type === 'number' ? 'text' : type, placeholder, maxlength, autocomplete: 'off', spellcheck: type === 'text' ? 'true' : 'false', inputmode: type === 'money' || type === 'number' ? 'decimal' : null });
  }
  input.value = value ?? '';
  if (readonly) input.readOnly = true;
  input.name = name;
  const err = h('div', { class: 'error', id: `${id}-err`, role: 'alert' });
  const setError = (msg) => {
    err.textContent = msg || '';
    input.classList.toggle('invalid', !!msg);
    if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', err.id); }
    else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  };
  input.addEventListener('input', () => { setError(''); onInput?.(input.value); });
  input.addEventListener('change', () => onInput?.(input.value));

  let control = input;
  if (prefix || suffix) {
    if (prefix) input.classList.add('pad-left');
    if (suffix) input.classList.add('pad-right');
    control = h('div', { class: 'input-affix' }, prefix ? h('span', { class: 'affix' }, prefix) : null, input, suffix ? h('span', { class: 'affix right' }, suffix) : null);
  }
  const el = h('div', { class: 'field' },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, '*') : null),
    control,
    hint ? h('div', { class: 'hint' }, hint) : null,
    err,
  );
  return {
    name, el, input, setError,
    raw: () => input.value,
    /** Parsed value; throws Error(message) when invalid. */
    value() {
      const raw = input.value;
      if (required && String(raw).trim() === '') throw new Error(`${label} is required.`);
      return parse ? parse(raw) : raw;
    },
  };
}

/** Modal form. Fields may be nested one level ([a, b]) to share a row. Resolves with the submit result or null. */
export function formModal({ title, fields, submitLabel = 'Save', size = '', onSubmit, extraFooter, note }) {
  const built = [];
  const rows = fields.map((f) => {
    if (Array.isArray(f)) {
      const group = f.map((s) => { const x = field(s); built.push(x); return x.el; });
      return h('div', { class: 'field-row', style: { '--cols': group.length } }, group);
    }
    const x = field(f);
    built.push(x);
    return x.el;
  });
  const formError = h('div', { class: 'form-error hidden', role: 'alert' });
  const form = h('form', { class: 'form', novalidate: true }, note ? h('div', { class: 'banner info', style: { margin: 0 } }, icon('info', 16), h('div', { class: 'grow' }, note)) : null, rows, formError);
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const m = openModal({ title, body: form, footer: [extraFooter ? h('span', { class: 'left' }, extraFooter) : null, cancel, submit], size, persistent: true });
  submit.setAttribute('form', '');
  cancel.addEventListener('click', () => m.close(null));

  let busy = false;
  const run = async () => {
    if (busy) return;
    formError.classList.add('hidden');
    const values = {};
    let firstBad = null;
    for (const f of built) {
      try { values[f.name] = f.value(); f.setError(''); }
      catch (e) { f.setError(e.message); firstBad = firstBad || f; }
    }
    if (firstBad) { firstBad.input.focus(); return; }
    busy = true;
    submit.disabled = true;
    try {
      const result = await onSubmit(values);
      m.close(result === undefined ? true : result);
    } catch (e) {
      const target = e?.field && built.find((f) => f.name === e.field);
      if (target) { target.setError(e.message); target.input.focus(); }
      else { formError.textContent = e?.message || 'Could not save.'; formError.classList.remove('hidden'); }
      busy = false;
      submit.disabled = false;
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  submit.addEventListener('click', (e) => { e.preventDefault(); run(); });
  return m.closed.then((r) => (r === undefined ? null : r));
}

// --------------------------------------------------------------- small bits

export const badge = (text, kind = '', extra = '') => h('span', { class: `badge ${kind} ${extra}`.trim() }, text);

export function progress(pct, { big = false, done = pct >= 100 } = {}) {
  return h('div', { class: `progress ${big ? 'big' : ''} ${done ? 'done' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Progress' },
    h('div', { class: 'bar' }, h('div', { class: 'fill', style: { width: `${Math.max(0, Math.min(100, pct))}%` } })),
    h('span', { class: 'pct' }, `${pct}%`),
  );
}

export function emptyState({ icon: ic = 'box', title, text, actions = [] }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(ic, 26)),
    h('h3', {}, title),
    text ? h('p', {}, text) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null,
  );
}

export function tile({ label, value, sub, subKind = '', icon: ic }) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, ic ? icon(ic, 14) : null, label),
    h('div', { class: 'tile-value' }, value),
    sub ? h('div', { class: `tile-sub ${subKind}` }, sub) : null,
  );
}

export function panel({ title, icon: ic, actions, body, flush = false, foot, className = '' }) {
  return h('section', { class: `panel ${className}`.trim() },
    title || actions ? h('div', { class: 'panel-head' }, h('h2', {}, ic ? icon(ic, 16) : null, title), h('div', { class: 'row' }, actions)) : null,
    h('div', { class: `panel-body ${flush ? 'flush' : ''}` }, body),
    foot ? h('div', { class: 'panel-foot' }, foot) : null,
  );
}

export function banner(kind, ...content) {
  const ic = kind === 'error' || kind === 'warn' ? 'alert' : 'info';
  return h('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : null }, icon(ic, 16), h('div', { class: 'grow' }, content));
}

export function pageHead({ title, sub, actions }) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-title' }, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
    h('div', { class: 'page-actions' }, actions),
  );
}

export function btn(label, { icon: ic, kind = '', onClick, title, size = '', disabled = false, type = 'button' } = {}) {
  return h('button', { class: `btn ${kind} ${size}`.trim(), type, title, disabled, onClick }, ic ? icon(ic, 15) : null, label);
}

export function iconBtn(ic, label, onClick, { kind = 'ghost', size = 'sm', disabled = false } = {}) {
  return h('button', { class: `btn ${kind} icon ${size}`, type: 'button', title: label, 'aria-label': label, disabled, onClick }, icon(ic, 15));
}

export function searchBox({ placeholder = 'Search…', value = '', onInput, label = 'Search' }) {
  const input = h('input', { class: 'input', type: 'search', placeholder, value, 'aria-label': label, autocomplete: 'off' });
  input.addEventListener('input', () => onInput?.(input.value));
  return { el: h('div', { class: 'search' }, icon('search', 15), input), input };
}

export function selectEl({ options, value, onChange, label, className = '' }) {
  const el = h('select', { class: `select select-inline ${className}`.trim(), 'aria-label': label }, options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = String(value ?? '');
  el.addEventListener('change', () => onChange?.(el.value));
  return el;
}

export function chips({ options, value, onChange, label = 'Filter' }) {
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  const paint = (v) => [...wrap.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.value === v)));
  for (const o of options) {
    wrap.append(h('button', { class: 'chip', type: 'button', dataset: { value: o.value }, 'aria-pressed': String(o.value === value), onClick: () => { paint(o.value); onChange?.(o.value); } }, o.label, o.count !== undefined ? h('span', { class: 'count' }, o.count) : null));
  }
  return wrap;
}

export function switchEl({ checked, onChange, label }) {
  const input = h('input', { type: 'checkbox', checked: !!checked, 'aria-label': label });
  input.addEventListener('change', () => onChange?.(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
}

/** Project dropdown. Calls onChange(id). */
export function projectSelect({ projects, value, onChange, includeAll = false, label = 'Project' }) {
  const opts = (includeAll ? [{ value: '', label: 'All projects' }] : []).concat(projects.map((p) => ({ value: String(p.id), label: p.name + (p.archived ? ' (archived)' : '') })));
  return selectEl({ options: opts, value: value ?? '', onChange: (v) => onChange(v ? Number(v) : null), label });
}

export function noProjects(navigateFn) {
  return emptyState({
    icon: 'projects', title: 'Create a project first',
    text: 'This section works on one robot project at a time. Create your first project to get started.',
    actions: [btn('New project', { icon: 'plus', kind: 'primary', onClick: () => navigateFn('/projects?new=1') })],
  });
}

// ------------------------------------------------------------------- table

/**
 * columns: { key, label, align, sortable, sortValue(row), render(row)->Node|string, className,
 *            filter: 'text' | { options: [{value,label}] }, filterValue(row) }
 */
export function createTable({ columns, rowId = (r) => r.id, onRowClick, onSelect, rowClass, empty, filterRow = false, sort, stickyActions = false }) {
  let rows = [];
  let selectedId = null;
  const filters = {};
  let sortKey = sort?.key ?? null;
  let sortDir = sort?.dir ?? 'asc';

  const thead = h('thead');
  const tbody = h('tbody');
  const table = h('table', { class: 'data' }, thead, tbody);
  const wrap = h('div', { class: 'table-wrap' }, table);

  const headRow = h('tr');
  for (const c of columns) {
    const th = h('th', { class: `${c.align === 'right' ? 'num' : ''} ${c.sortable !== false && c.key ? 'sortable' : ''} ${c.className || ''}`.trim(), scope: 'col', 'aria-sort': 'none' });
    if (c.sortable !== false && c.key) {
      th.tabIndex = 0;
      const act = () => { sortDir = sortKey === c.key && sortDir === 'asc' ? 'desc' : 'asc'; sortKey = c.key; paintHead(); paintBody(); };
      th.addEventListener('click', act);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    }
    th.dataset.key = c.key || '';
    headRow.append(th);
  }
  thead.append(headRow);
  const paintHead = () => {
    [...headRow.children].forEach((th, i) => {
      const c = columns[i];
      th.replaceChildren(...[c.label || '', sortKey && c.key === sortKey ? h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, sortDir === 'asc' ? '▲' : '▼') : null].filter((x) => x !== null));
      th.setAttribute('aria-sort', c.key === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  };

  if (filterRow) {
    const fr = h('tr', { class: 'filters' });
    for (const c of columns) {
      const th = h('th', { class: c.className || '' });
      if (c.filter === 'text') {
        const inp = h('input', { class: 'input sm', type: 'text', 'aria-label': `Filter ${c.label}`, placeholder: 'Filter…' });
        inp.addEventListener('input', () => { filters[c.key] = inp.value.trim().toLowerCase(); paintBody(); });
        th.append(inp);
      } else if (c.filter && c.filter.options) {
        const sel = h('select', { class: 'select sm', 'aria-label': `Filter ${c.label}` }, [h('option', { value: '' }, 'All'), ...c.filter.options.map((o) => h('option', { value: o.value }, o.label))]);
        sel.addEventListener('change', () => { filters[c.key] = sel.value; paintBody(); });
        th.append(sel);
      }
      fr.append(th);
    }
    thead.append(fr);
  }

  const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' }));
  const visible = () => {
    let out = rows.filter((r) => columns.every((c) => {
      const f = filters[c.key];
      if (!f) return true;
      const v = c.filterValue ? c.filterValue(r) : r[c.key];
      return c.filter === 'text' ? String(v ?? '').toLowerCase().includes(f) : String(v) === f;
    }));
    const sc = columns.find((c) => c.key === sortKey);
    if (sc) {
      const val = sc.sortValue || ((r) => r[sc.key]);
      out = [...out].sort((a, b) => (sortDir === 'asc' ? 1 : -1) * cmp(val(a), val(b)));
    }
    return out;
  };

  const select = (id, { notify = true } = {}) => {
    selectedId = id;
    [...tbody.children].forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === String(id)));
    if (notify) onSelect?.(rows.find((r) => rowId(r) === id) || null);
  };

  function paintBody() {
    clear(tbody);
    const list = visible();
    if (!list.length) {
      const msg = typeof empty === 'function' ? empty(rows.length > 0) : empty;
      tbody.append(h('tr', {}, h('td', { colspan: columns.length, class: 'table-empty', style: { height: 'auto' } }, msg || 'Nothing to show.')));
      return;
    }
    for (const r of list) {
      const id = rowId(r);
      const clickable = !!(onRowClick || onSelect);
      const tr = h('tr', { class: `${clickable ? 'clickable' : ''} ${selectedId === id ? 'selected' : ''} ${rowClass?.(r) || ''}`.trim(), dataset: { id: String(id) }, tabIndex: clickable ? 0 : null });
      for (const c of columns) {
        const content = c.render ? c.render(r) : r[c.key];
        tr.append(h('td', { class: `${c.align === 'right' ? 'num' : ''} ${c.className || ''}`.trim() }, content));
      }
      if (clickable) {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, select, textarea, label')) return;
          if (onSelect) select(id);
          onRowClick?.(r);
        });
        tr.addEventListener('keydown', (e) => {
          if (e.target !== tr) return;
          if (e.key === 'Enter') { if (onSelect) select(id); onRowClick?.(r); }
          const go = (sib) => {
            if (!sib?.dataset.id) return;
            e.preventDefault();
            sib.focus();
            const row = rows.find((x) => String(rowId(x)) === sib.dataset.id);
            if (row && onSelect) select(rowId(row));
          };
          if (e.key === 'ArrowDown') go(tr.nextElementSibling);
          if (e.key === 'ArrowUp') go(tr.previousElementSibling);
        });
      }
      tbody.append(tr);
    }
  }

  paintHead();
  paintBody();
  return {
    el: wrap,
    setRows(next) { rows = next; if (selectedId !== null && !rows.some((r) => rowId(r) === selectedId)) selectedId = null; paintBody(); },
    select,
    selectedId: () => selectedId,
    visibleRows: visible,
  };
}
