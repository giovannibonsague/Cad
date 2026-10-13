import { h, mount, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api, native } from '../api.js';
import { money, int, label, parseMoney, centsToInput, parseWholeNumber, parseOptionalNumber, plural } from '../lib/format.js';
import { currentQuery } from '../router.js';
import { state } from '../state.js';
import { badge, btn, chips, confirmDialog, createTable, emptyState, formModal, iconBtn, pageHead, searchBox, tile, toast } from '../ui.js';

const categoryOptions = () => state.meta.categories.map((c) => ({ value: c, label: label('category', c) }));

export function openPartForm(existing = null) {
  return formModal({
    title: existing ? 'Edit part' : 'Add part',
    submitLabel: existing ? 'Save changes' : 'Add part',
    size: 'wide',
    fields: [
      [{ name: 'name', label: 'Name', required: true, value: existing?.name, maxlength: 120, placeholder: 'e.g. N20 gear motor 6V' },
        { name: 'category', label: 'Category', type: 'select', options: categoryOptions(), value: existing?.category || 'sensor' }],
      [{ name: 'manufacturer', label: 'Manufacturer', value: existing?.manufacturer, maxlength: 120 },
        { name: 'model', label: 'Model / part number', value: existing?.model, maxlength: 120 }],
      [{ name: 'quantity', label: 'Quantity in stock', required: true, value: String(existing?.quantity ?? 0), type: 'number', parse: (v) => parseWholeNumber(v, { label: 'Quantity', max: 1_000_000 }) },
        { name: 'unit_price_cents', label: 'Unit price', required: true, type: 'money', prefix: '$', value: centsToInput(existing?.unit_price_cents ?? 0), parse: (v) => parseMoney(v, { label: 'Unit price', allowEmpty: false }) }],
      [{ name: 'voltage', label: 'Voltage (V)', type: 'number', value: existing?.voltage ?? '', suffix: 'V', hint: 'Nominal, optional', parse: (v) => parseOptionalNumber(v, { label: 'Voltage', max: 1000 }) },
        { name: 'current', label: 'Current (A)', type: 'number', value: existing?.current ?? '', suffix: 'A', hint: 'Typical or max draw, optional', parse: (v) => parseOptionalNumber(v, { label: 'Current', max: 1000 }) }],
      { name: 'datasheet_url', label: 'Datasheet URL', value: existing?.datasheet_url, placeholder: 'https://…', maxlength: 2048, parse: (v) => { const t = v.trim(); if (t && !/^https?:\/\/\S{3,}$/i.test(t)) throw new Error('Enter a full http:// or https:// link.'); return t; } },
      { name: 'notes', label: 'Notes', type: 'textarea', value: existing?.notes, rows: 3 },
    ],
    onSubmit: (v) => (existing ? api('components.update', { id: existing.id, input: v }) : api('components.create', { input: v })),
  });
}

export async function render({ view }) {
  let search = '';
  let category = 'all';
  let list = { items: [], summary: { count: 0, total_units: 0, total_value_cents: 0 } };
  const allCounts = {};
  let selected = null;
  const side = h('aside', { class: 'side-panel' });
  let sideTab = 'props';

  const table = createTable({
    filterRow: true,
    sort: { key: 'name', dir: 'asc' },
    onSelect: (c) => { selected = c; paintSide(); },
    columns: [
      { key: 'name', label: 'Name', className: 'cell-main', filter: 'text', filterValue: (c) => `${c.name} ${c.manufacturer} ${c.model}`, render: (c) => [c.name, c.model || c.manufacturer ? h('span', { class: 'sub' }, [c.manufacturer, c.model].filter(Boolean).join(' · ')) : null] },
      { key: 'category', label: 'Category', filter: { options: categoryOptions() }, render: (c) => badge(label('category', c.category), 'blue') },
      { key: 'quantity', label: 'Qty', align: 'right', filter: 'text', render: (c) => (c.quantity === 0 ? h('span', { class: 'badge red' }, '0') : int(c.quantity)) },
      { key: 'unit_price_cents', label: 'Unit price', align: 'right', render: (c) => money(c.unit_price_cents) },
      { key: 'value_cents', label: 'Value', align: 'right', render: (c) => money(c.value_cents) },
      { key: 'voltage', label: 'Voltage', align: 'right', render: (c) => (c.voltage === null ? '' : `${c.voltage} V`) },
      { key: 'current', label: 'Current', align: 'right', render: (c) => (c.current === null ? '' : `${c.current} A`) },
      { key: 'used_in_projects', label: 'Used in', align: 'right', render: (c) => (c.used_in_projects ? plural(c.used_in_projects, 'project') : h('span', { class: 'faint' }, '—')) },
      { key: 'actions', label: '', sortable: false, className: 'actions', render: (c) => h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '2px' } },
        c.datasheet_url ? iconBtn('external', 'Open datasheet', () => native.openDatasheet(c.id).catch((e) => toast(e.message, 'error'))) : null,
        iconBtn('edit', 'Edit part', () => edit(c)),
        iconBtn('copy', 'Duplicate part', () => duplicate(c)),
        iconBtn('trash', 'Delete part', () => remove(c)),
      ) },
    ],
    empty: (hasRows) => (hasRows || search || category !== 'all' ? 'No parts match your search or filter.' : emptyState({
      icon: 'parts', title: 'Your inventory is empty', text: 'Add the sensors, motors, controllers, batteries and structural parts you own or plan to buy.',
      actions: [btn('Add part', { icon: 'plus', kind: 'primary', onClick: create })],
    })),
  });

  const tiles = h('div', { class: 'tiles' });
  const paintTiles = () => mount(tiles,
    tile({ label: 'Part types', icon: 'parts', value: int(list.summary.count), sub: search || category !== 'all' ? 'Matching current filter' : 'In inventory' }),
    tile({ label: 'Units in stock', icon: 'box', value: int(list.summary.total_units) }),
    tile({ label: 'Inventory value', icon: 'dollar', value: money(list.summary.total_value_cents), sub: 'Quantity × unit price' }),
  );
  const chipsHost = h('div');

  const CAT_ICON = { sensor: 'parts', motor: 'settings', controller: 'parts', battery: 'box', structural: 'cad' };
  async function paintSide() {
    if (!selected) {
      mount(side, h('div', { class: 'panel side-card' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Part properties')),
        h('div', { class: 'side-empty' }, h('div', { class: 'part-art' }, icon('parts', 34)), h('span', { class: 'muted' }, 'Select a part to see its details and where it is used.'))));
      return;
    }
    const c = selected;
    const row = (k, v) => h('div', { class: 'prop' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v === null || v === '' || v === undefined ? '—' : v));
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['props', 'Properties'], ['used', 'Where used']].map(([k, l]) =>
      h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(sideTab === k), onClick: () => { sideTab = k; paintSide(); } }, l)));
    let body;
    if (sideTab === 'props') {
      body = h('div', { class: 'props' },
        row('Name', c.name), row('Category', label('category', c.category)), row('Manufacturer', c.manufacturer), row('Model', c.model),
        row('In stock', int(c.quantity)), row('Unit price', money(c.unit_price_cents)), row('Stock value', money(c.value_cents)),
        row('Voltage', c.voltage === null ? null : `${c.voltage} V`), row('Current', c.current === null ? null : `${c.current} A`),
        row('Notes', c.notes),
        h('div', { class: 'row', style: { gap: '6px', marginTop: '10px' } },
          btn('Edit', { size: 'sm', icon: 'edit', onClick: () => edit(c) }),
          c.datasheet_url ? btn('Datasheet', { size: 'sm', icon: 'external', onClick: () => native.openDatasheet(c.id).catch((e) => toast(e.message, 'error')) }) : null));
    } else {
      let usage = [];
      try { usage = await api('components.usage', { id: c.id }); } catch { /* shown as empty */ }
      if (selected !== c) return;
      body = usage.length ? h('div', { class: 'props' }, usage.map((n) => h('div', { class: 'prop' }, icon('projects', 14), h('span', { class: 'v' }, n))))
        : h('div', { class: 'side-empty' }, h('span', { class: 'muted' }, 'Not used in any project BOM yet.'));
    }
    mount(side, h('div', { class: 'panel side-card' },
      h('div', { class: 'part-hero' }, h('div', { class: 'part-art' }, icon(CAT_ICON[c.category] || 'parts', 44)), h('div', { class: 'part-name ellipsis' }, c.name)),
      tabs, body));
  }

  async function load() {
    const [filtered, all] = await Promise.all([api('components.list', { search, category }), api('components.list', {})]);
    list = filtered;
    state.meta.categories.forEach((c) => { allCounts[c] = 0; });
    all.items.forEach((c) => { allCounts[c.category] = (allCounts[c.category] || 0) + 1; });
    table.setRows(list.items);
    if (selected) selected = list.items.find((x) => x.id === selected.id) || null;
    paintSide();
    paintTiles();
    mount(chipsHost, chips({
      label: 'Category', value: category,
      options: [{ value: 'all', label: 'All', count: all.items.length }, ...state.meta.categories.filter((c) => allCounts[c] > 0 || c === category).map((c) => ({ value: c, label: label('category', c), count: allCounts[c] }))],
      onChange: (v) => { category = v; refresh(); },
    }));
  }
  const refresh = () => load().catch((e) => toast(e.message, 'error'));

  async function create() { const c = await openPartForm(); if (c) { toast(`Added "${c.name}"`, 'success'); await refresh(); } }
  async function edit(c) { const u = await openPartForm(c); if (u) { toast('Part saved', 'success'); await refresh(); } }
  async function duplicate(c) {
    try {
      const input = { name: `${c.name} (copy)`.slice(0, 120), category: c.category, manufacturer: c.manufacturer, model: c.model, quantity: c.quantity, unit_price_cents: c.unit_price_cents, voltage: c.voltage, current: c.current, datasheet_url: c.datasheet_url, notes: c.notes };
      await api('components.create', { input });
      toast('Part duplicated', 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function remove(c) {
    let usage = [];
    try { usage = await api('components.usage', { id: c.id }); } catch (e) { toast(e.message, 'error'); return; }
    const ok = await confirmDialog({
      title: 'Delete part?',
      message: usage.length ? `"${c.name}" is used in ${plural(usage.length, 'project')}: ${usage.join(', ')}. Deleting it also removes it from those BOMs.` : `"${c.name}" will be permanently deleted from your inventory.`,
      confirmLabel: usage.length ? 'Delete and remove from BOMs' : 'Delete part',
    });
    if (!ok) return;
    try { await api('components.delete', { id: c.id, force: usage.length > 0 }); toast('Part deleted', 'success'); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const sb = searchBox({ placeholder: 'Search name, maker, model, notes…', label: 'Search parts', onInput: debounce((v) => { search = v; refresh(); }, 180) });
  sb.el.style.width = '320px';
  mount(view,
    pageHead({ title: 'Parts Inventory', sub: 'Every component you own or plan to use. Prices here drive all BOM totals.', actions: btn('Add part', { icon: 'plus', kind: 'primary', onClick: create }) }),
    tiles,
    h('div', { class: 'toolbar' }, sb.el, chipsHost),
    h('div', { class: 'split' }, table.el, side),
  );
  await load();
  if (currentQuery().get('new') === '1') { history.replaceState(null, '', '#/inventory'); create(); }
}
