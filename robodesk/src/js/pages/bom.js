import { h, mount } from '../lib/dom.js';
import { api, native } from '../api.js';
import { money, int, label, parsePercentToBp, bpToInput, parseMoney, centsToInput, formatBp, plural } from '../lib/format.js';
import { navigate, currentQuery } from '../router.js';
import { resolveProject } from '../state.js';
import { badge, btn, createTable, emptyState, formModal, iconBtn, noProjects, pageHead, panel, projectSelect, searchBox, tile, toast, openModal } from '../ui.js';
import { icon } from '../lib/icons.js';

export async function render({ params, view }) {
  const { projects, project } = await resolveProject(params.id);
  if (!project) { mount(view, pageHead({ title: 'Bill of Materials' }), noProjects(navigate)); return; }
  const pid = project.id;
  let bom = await api('bom.get', { project_id: pid });

  const table = createTable({
    sort: null,
    columns: [
      { key: 'n', label: '#', sortable: false, className: 'faint', render: (l) => bom.lines.indexOf(l) + 1 },
      { key: 'name', label: 'Part', className: 'cell-main', render: (l) => [l.name, l.manufacturer || l.model ? h('span', { class: 'sub' }, [l.manufacturer, l.model].filter(Boolean).join(' · ')) : null] },
      { key: 'category', label: 'Category', render: (l) => badge(label('category', l.category), 'blue') },
      { key: 'quantity', label: 'Qty', align: 'right', sortable: false, render: (l) => qtyControl(l) },
      { key: 'unit', label: 'Unit price', align: 'right', render: (l) => money(l.unit_price_cents) },
      { key: 'total', label: 'Line total', align: 'right', render: (l) => h('strong', {}, money(l.line_total_cents)) },
      { key: 'stock', label: 'In stock', align: 'right', render: (l) => (l.shortage ? h('span', { class: 'badge red', title: `Need ${l.shortage} more` }, `${int(l.in_stock)} · short ${int(l.shortage)}`) : int(l.in_stock)) },
      { key: 'actions', label: '', sortable: false, className: 'actions', render: (l) => iconBtn('trash', 'Remove from BOM', () => removeLine(l)) },
    ],
    empty: emptyState({ icon: 'bom', title: 'This BOM is empty', text: 'Add parts from your inventory. Prices and stock come from there, so totals always stay current.', actions: [btn('Add parts', { icon: 'plus', kind: 'primary', onClick: () => addParts() })] }),
  });

  function qtyControl(l) {
    const input = h('input', { class: 'input sm cell-input', type: 'text', inputmode: 'numeric', value: String(l.quantity), 'aria-label': `Quantity of ${l.name}` });
    const commit = async () => {
      const t = input.value.trim();
      if (t === String(l.quantity)) return;
      if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 100000) { input.classList.add('invalid'); toast('Quantity must be a whole number from 1 to 100,000.', 'error'); input.value = String(l.quantity); setTimeout(() => input.classList.remove('invalid'), 1200); return; }
      try { bom = await api('bom.set_quantity', { line_id: l.id, quantity: Number(t) }); paint(); } catch (e) { toast(e.message, 'error'); input.value = String(l.quantity); }
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = String(l.quantity); input.blur(); } });
    const step = (d) => async () => { const q = l.quantity + d; if (q < 1) return; try { bom = await api('bom.set_quantity', { line_id: l.id, quantity: q }); paint(); } catch (e) { toast(e.message, 'error'); } };
    return h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '2px' } }, iconBtn('minus', 'Decrease quantity', step(-1), { disabled: l.quantity <= 1 }), input, iconBtn('plus', 'Increase quantity', step(1)));
  }

  async function removeLine(l) {
    try { bom = await api('bom.remove', { line_id: l.id }); toast(`Removed ${l.name}`, 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
  }

  async function addParts() {
    const inv = await api('components.list', {});
    if (!inv.items.length) {
      const go = btn('Go to inventory', { kind: 'primary', onClick: () => { m.close(); navigate('/inventory?new=1'); } });
      const m = openModal({ title: 'Add parts', size: 'narrow', body: emptyState({ icon: 'parts', title: 'Inventory is empty', text: 'Add parts to your inventory first, then put them in a BOM.' }), footer: go });
      return;
    }
    const inBom = new Map(bom.lines.map((l) => [l.component_id, l.quantity]));
    let q = '';
    const qtyInputs = new Map();
    const list = h('div', { class: 'table-wrap', style: { maxHeight: '48vh' } });
    const paintList = () => {
      const rows = inv.items.filter((c) => !q || `${c.name} ${c.manufacturer} ${c.model} ${c.category}`.toLowerCase().includes(q));
      mount(list, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Part', 'Category', 'Price', 'In BOM', 'Add qty'].map((t, i) => h('th', { class: i >= 2 ? 'num' : '' }, t)))),
        h('tbody', {}, rows.length ? rows.map((c) => {
          if (!qtyInputs.has(c.id)) qtyInputs.set(c.id, h('input', { class: 'input sm cell-input', type: 'text', inputmode: 'numeric', placeholder: '0', 'aria-label': `Quantity of ${c.name} to add` }));
          return h('tr', {}, h('td', { class: 'cell-main' }, c.name, c.model ? h('span', { class: 'sub' }, c.model) : null), h('td', {}, badge(label('category', c.category), 'blue')), h('td', { class: 'num' }, money(c.unit_price_cents)), h('td', { class: 'num' }, inBom.get(c.id) ?? '—'), h('td', { class: 'num' }, qtyInputs.get(c.id)));
        }) : h('tr', {}, h('td', { colspan: 5, class: 'table-empty' }, 'No parts match.')))));
    };
    const sb = searchBox({ placeholder: 'Filter parts…', label: 'Filter parts', onInput: (v) => { q = v.trim().toLowerCase(); paintList(); } });
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const add = btn('Add to BOM', { kind: 'primary' });
    const m = openModal({ title: `Add parts to “${project.name}”`, size: 'wide', persistent: true, body: h('div', { class: 'stack' }, sb.el, list, h('div', { class: 'hint faint' }, 'Enter a quantity next to each part you want, then add them all at once. Parts already in the BOM get their quantity increased.'), err), footer: [btn('Cancel', { onClick: () => m.close(null) }), add] });
    paintList();
    add.addEventListener('click', async () => {
      err.classList.add('hidden');
      const picks = [];
      for (const [id, input] of qtyInputs) {
        const t = input.value.trim();
        if (!t) continue;
        if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 100000) { err.textContent = 'Quantities must be whole numbers from 1 to 100,000.'; err.classList.remove('hidden'); input.focus(); return; }
        picks.push([id, Number(t)]);
      }
      if (!picks.length) { err.textContent = 'Enter a quantity for at least one part.'; err.classList.remove('hidden'); return; }
      add.disabled = true;
      try { for (const [id, qty] of picks) bom = await api('bom.add', { project_id: pid, component_id: id, quantity: qty }); m.close(true); toast(`Added ${plural(picks.length, 'part')}`, 'success'); paint(); }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); add.disabled = false; }
    });
  }

  async function editCosts() {
    const saved = await formModal({
      title: 'Tax & shipping', submitLabel: 'Save', size: 'narrow',
      note: 'Applied to this project’s BOM subtotal. Tax is rounded to the nearest cent.',
      fields: [
        { name: 'tax_bp', label: 'Sales tax rate', type: 'number', suffix: '%', value: bpToInput(bom.tax_bp), parse: (v) => parsePercentToBp(v, 'Tax rate') },
        { name: 'shipping_cents', label: 'Shipping & handling', type: 'money', prefix: '$', value: centsToInput(bom.shipping_cents), parse: (v) => parseMoney(v, { label: 'Shipping' }) },
      ],
      onSubmit: (v) => api('bom.set_costs', { project_id: pid, tax_bp: v.tax_bp, shipping_cents: v.shipping_cents }),
    });
    if (saved) { bom = saved; paint(); toast('Costs updated', 'success'); }
  }

  async function exportCsv() {
    try {
      const safe = project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'project';
      const path = await native.pickSavePath('csv', `${safe}-BOM.csv`);
      if (!path) return;
      await api('bom.export_csv', { project_id: pid, path });
      toast('BOM exported to CSV', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  const summary = h('div');
  const tiles = h('div', { class: 'tiles' });
  const host = h('div');

  function paint() {
    table.setRows(bom.lines);
    mount(tiles,
      tile({ label: 'Lines', icon: 'bom', value: int(bom.lines.length), sub: `${plural(bom.total_units, 'unit')} total` }),
      tile({ label: 'Subtotal', icon: 'dollar', value: money(bom.subtotal_cents) }),
      tile({ label: 'Total', icon: 'dollar', value: money(bom.total_cents), sub: `incl. ${formatBp(bom.tax_bp)} tax & shipping` }),
      tile({ label: 'Stock check', icon: 'box', value: bom.shortage_lines ? `${bom.shortage_lines} short` : 'OK', sub: bom.shortage_lines ? 'Need more than in inventory' : 'Everything is in stock', subKind: bom.shortage_lines ? 'warn' : '' }),
    );
    const row = (k, v, strong) => h('div', { class: 'list-row', style: strong ? { fontWeight: 700, fontSize: '14px' } : {} }, h('div', { class: 'grow' }, k), h('span', { class: 'num', style: { minWidth: '110px' } }, v));
    mount(summary, panel({ title: 'Cost summary', icon: 'dollar', flush: true, actions: btn('Edit tax & shipping', { size: 'sm', icon: 'edit', onClick: editCosts }),
      body: [row('Subtotal', money(bom.subtotal_cents)), row(`Tax (${formatBp(bom.tax_bp)})`, money(bom.tax_cents)), row('Shipping', money(bom.shipping_cents)), row('Total', money(bom.total_cents), true)] }));
  }

  const select = projectSelect({ projects, value: pid, label: 'Project', onChange: (id) => navigate(`/bom/${id}`) });
  mount(view,
    pageHead({ title: 'Bill of Materials', sub: 'Quantities, unit prices and totals for one project. Prices come from the parts inventory.', actions: [select, btn('Add parts', { icon: 'plus', kind: 'primary', onClick: addParts }), btn('Export CSV', { icon: 'download', onClick: exportCsv, disabled: false })] }),
    tiles, table.el, h('div', { style: { maxWidth: '520px', marginTop: '14px', marginLeft: 'auto' } }, summary), host);
  paint();
  if (currentQuery().get('add') === '1') { history.replaceState(null, '', `#/bom/${pid}`); addParts(); }
}
