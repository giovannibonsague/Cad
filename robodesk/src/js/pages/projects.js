import { h, mount } from '../lib/dom.js';
import { api } from '../api.js';
import { money, fmtDate, relTime, label, BADGE_KIND, plural, todayISO } from '../lib/format.js';
import { navigate, currentQuery } from '../router.js';
import { state, setLastProject } from '../state.js';
import { badge, btn, chips, confirmDialog, createTable, emptyState, formModal, iconBtn, pageHead, progress, searchBox, toast } from '../ui.js';
import { debounce } from '../lib/dom.js';

const statusOptions = () => state.meta.project_statuses.map((s) => ({ value: s, label: label('project_status', s) }));

/** Create or edit dialog. Resolves with the saved project (or null if cancelled). */
export function openProjectForm(existing = null) {
  const dateParse = (v) => {
    const t = v.trim();
    if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error('Use the date picker or YYYY-MM-DD.');
    return t || null;
  };
  return formModal({
    title: existing ? 'Edit project' : 'New project',
    submitLabel: existing ? 'Save changes' : 'Create project',
    fields: [
      { name: 'name', label: 'Project name', required: true, value: existing?.name, maxlength: 120, placeholder: 'e.g. Line follower Mk2' },
      { name: 'description', label: 'Description', type: 'textarea', value: existing?.description, rows: 3, maxlength: 2000 },
      [
        { name: 'status', label: 'Status', type: 'select', options: statusOptions(), value: existing?.status || 'planning' },
        { name: 'start_date', label: 'Start date', type: 'date', value: existing?.start_date || (existing ? '' : todayISO()), parse: dateParse },
        { name: 'due_date', label: 'Due date', type: 'date', value: existing?.due_date || '', parse: dateParse },
      ],
      { name: 'notes', label: 'Notes', type: 'textarea', value: existing?.notes, rows: 4, hint: 'Design decisions, links, reminders…' },
    ],
    onSubmit: (v) => (existing ? api('projects.update', { id: existing.id, input: v }) : api('projects.create', { input: v })),
  });
}

export async function render({ view }) {
  const params = currentQuery();
  let search = '';
  let scope = 'active'; // active | archived | all
  let rows = [];

  const table = createTable({
    sort: { key: 'updated_at', dir: 'desc' },
    onRowClick: (p) => { setLastProject(p.id); navigate(`/projects/${p.id}`); },
    columns: [
      { key: 'name', label: 'Project', className: 'cell-main maxw', render: (p) => [p.name, p.description ? h('span', { class: 'sub ellipsis', style: { maxWidth: '380px' } }, p.description) : null] },
      { key: 'status', label: 'Status', render: (p) => [badge(label('project_status', p.status), BADGE_KIND.project_status[p.status]), p.archived ? badge('Archived', '', '') : null] },
      { key: 'progress', label: 'Progress', sortValue: (p) => p.stats.progress_pct, render: (p) => h('div', { style: { width: '140px' } }, progress(p.stats.progress_pct)) },
      { key: 'parts', label: 'BOM lines', align: 'right', sortValue: (p) => p.stats.bom_lines, render: (p) => p.stats.bom_lines },
      { key: 'cost', label: 'Est. cost', align: 'right', sortValue: (p) => p.stats.cost_cents, render: (p) => money(p.stats.cost_cents) },
      { key: 'due_date', label: 'Due', render: (p) => fmtDate(p.due_date) },
      { key: 'updated_at', label: 'Modified', render: (p) => relTime(p.updated_at) },
      { key: 'actions', label: '', sortable: false, className: 'actions', render: (p) => h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '2px' } },
        iconBtn('edit', 'Edit project', () => edit(p)),
        iconBtn('copy', 'Duplicate project', () => duplicate(p)),
        iconBtn(p.archived ? 'unarchive' : 'archive', p.archived ? 'Restore from archive' : 'Archive project', () => archive(p)),
        iconBtn('trash', 'Delete project', () => remove(p)),
      ) },
    ],
    empty: (hasRows) => (hasRows ? 'No projects match your filters.' : emptyState({
      icon: 'projects', title: scope === 'archived' ? 'No archived projects' : 'No projects yet',
      text: scope === 'archived' ? 'Archive a project to hide it from the dashboard without deleting it.' : 'Create a project for each robot you are building.',
      actions: scope === 'archived' ? [] : [btn('New project', { icon: 'plus', kind: 'primary', onClick: create })],
    })),
  });

  async function load() {
    rows = await api('projects.list', { search, include_archived: scope === 'all', archived_only: scope === 'archived' });
    table.setRows(rows);
    count.textContent = plural(rows.length, 'project');
  }
  const refresh = () => load().catch((e) => toast(e.message, 'error'));

  async function create() { const p = await openProjectForm(); if (p) { toast(`Created "${p.name}"`, 'success'); await refresh(); } }
  async function edit(p) { const u = await openProjectForm(p); if (u) { toast('Project saved', 'success'); await refresh(); } }
  async function duplicate(p) {
    try { const c = await api('projects.duplicate', { id: p.id }); toast(`Duplicated as "${c.name}"`, 'success'); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function archive(p) {
    try { await api('projects.set_archived', { id: p.id, archived: !p.archived }); toast(p.archived ? 'Project restored' : 'Project archived', 'success'); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function remove(p) {
    const ok = await confirmDialog({
      title: 'Delete project?',
      message: `"${p.name}" and its BOM lines, tasks, wiring diagrams and CAD references will be permanently deleted. Parts in your inventory and the CAD files on disk are not affected.`,
      confirmLabel: 'Delete project',
      details: p.archived ? null : h('p', { class: 'muted' }, 'Tip: archiving keeps everything and just hides the project.'),
    });
    if (!ok) return;
    try { await api('projects.delete', { id: p.id }); toast('Project deleted', 'success'); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }

  const count = h('span', { class: 'muted' });
  const sb = searchBox({ placeholder: 'Search projects…', label: 'Search projects', onInput: debounce((v) => { search = v; refresh(); }, 180) });
  mount(view,
    pageHead({ title: 'Projects', sub: 'One entry per robot. Open a project for its overview, BOM, files and tasks.', actions: btn('New project', { icon: 'plus', kind: 'primary', onClick: create }) }),
    h('div', { class: 'toolbar' }, sb.el,
      chips({ label: 'Show', value: scope, options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' }], onChange: (v) => { scope = v; refresh(); } }),
      h('span', { class: 'grow' }), count),
    table.el,
  );
  await load();
  if (params.get('new') === '1') { history.replaceState(null, '', '#/projects'); create(); }
}
