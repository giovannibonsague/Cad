import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../api.js';
import { fmtDate, label, BADGE_KIND, todayISO, plural } from '../lib/format.js';
import { navigate, currentQuery } from '../router.js';
import { state, resolveProject } from '../state.js';
import { badge, btn, chips, confirmDialog, emptyState, formModal, iconBtn, noProjects, pageHead, progress, projectSelect, toast } from '../ui.js';

export async function render({ params, view }) {
  const { projects, project } = await resolveProject(params.id);
  if (!project) { mount(view, pageHead({ title: 'Build Planner' }), noProjects(navigate)); return; }
  const pid = project.id;
  let tasks = [];
  let filter = 'all';

  const opts = (list, group) => list.map((v) => ({ value: v, label: label(group, v) }));

  function openTaskForm(existing = null) {
    return formModal({
      title: existing ? 'Edit task' : 'New task', submitLabel: existing ? 'Save changes' : 'Add task',
      fields: [
        { name: 'title', label: 'Task', required: true, value: existing?.title, maxlength: 200, placeholder: 'e.g. Calibrate line sensors' },
        [{ name: 'status', label: 'Status', type: 'select', options: opts(state.meta.task_statuses, 'task_status'), value: existing?.status || 'todo' },
          { name: 'priority', label: 'Priority', type: 'select', options: opts(state.meta.task_priorities, 'priority'), value: existing?.priority || 'medium' }],
        { name: 'due_date', label: 'Due date', type: 'date', value: existing?.due_date || '', parse: (v) => { const t = v.trim(); if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error('Use the date picker or YYYY-MM-DD.'); return t || null; } },
        { name: 'notes', label: 'Notes', type: 'textarea', value: existing?.notes, rows: 3 },
      ],
      onSubmit: (v) => (existing ? api('tasks.update', { id: existing.id, input: v }) : api('tasks.create', { project_id: pid, input: v })),
    });
  }

  const list = h('div', { class: 'panel' });
  const progressHost = h('div', { class: 'panel', style: { padding: '14px', marginBottom: '12px' } });
  const chipHost = h('div');

  const counts = () => ({ all: tasks.length, open: tasks.filter((t) => t.status !== 'done').length, done: tasks.filter((t) => t.status === 'done').length, blocked: tasks.filter((t) => t.status === 'blocked').length });

  function paint() {
    const done = tasks.filter((t) => t.status === 'done').length;
    const pct = tasks.length ? Math.round((done * 100) / tasks.length) : 0;
    mount(progressHost,
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '8px' } }, h('strong', {}, 'Project completion'), h('span', { class: 'muted' }, tasks.length ? `${done} of ${plural(tasks.length, 'task')} complete` : 'No tasks yet')),
      progress(pct, { big: true }));
    const c = counts();
    mount(chipHost, chips({ label: 'Show tasks', value: filter, onChange: (v) => { filter = v; paint(); },
      options: [{ value: 'all', label: 'All', count: c.all }, { value: 'open', label: 'Open', count: c.open }, { value: 'blocked', label: 'Blocked', count: c.blocked }, { value: 'done', label: 'Done', count: c.done }] }));

    const shown = tasks.filter((t) => filter === 'all' || (filter === 'open' && t.status !== 'done') || (filter === 'done' && t.status === 'done') || (filter === 'blocked' && t.status === 'blocked'));
    if (!tasks.length) { mount(list, emptyState({ icon: 'planner', title: 'No tasks yet', text: 'Break the build into steps. Completion is calculated automatically from task status.', actions: [btn('Add first task', { icon: 'plus', kind: 'primary', onClick: add })] })); return; }
    if (!shown.length) { mount(list, h('div', { class: 'table-empty' }, 'No tasks match this filter.')); return; }
    const today = todayISO();
    mount(list, shown.map((t) => {
      const idx = tasks.indexOf(t);
      const overdue = t.due_date && t.status !== 'done' && t.due_date < today;
      const reorderable = filter === 'all';
      const row = h('div', { class: 'list-row task-row', draggable: reorderable ? 'true' : 'false', dataset: { id: String(t.id) } },
        h('span', { class: 'task-grip', title: reorderable ? 'Drag to reorder' : 'Show All to reorder', 'aria-hidden': 'true', style: { opacity: reorderable ? 1 : 0.25 } }, icon('grip', 16)),
        h('label', { class: 'switch', style: { width: '20px', height: '20px' }, title: t.status === 'done' ? 'Mark as not done' : 'Mark done' },
          h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': `Mark “${t.title}” as ${t.status === 'done' ? 'not done' : 'done'}`, onChange: (e) => setStatus(t, e.target.checked ? 'done' : 'todo') }),
          h('span', { class: 'track', style: { borderRadius: '5px' } })),
        h('div', { class: 'grow' },
          h('div', { class: 'ellipsis', style: { textDecoration: t.status === 'done' ? 'line-through' : 'none', color: t.status === 'done' ? 'var(--text-faint)' : 'inherit', fontWeight: 500 } }, t.title),
          t.notes ? h('div', { class: 'faint ellipsis', style: { fontSize: '12px' } }, t.notes.split('\n')[0]) : null),
        badge(label('priority', t.priority), BADGE_KIND.priority[t.priority]),
        statusSelect(t),
        h('span', { class: overdue ? 'badge red' : 'faint', style: { minWidth: '92px', textAlign: 'right' } }, t.due_date ? (overdue ? `Overdue · ${fmtDate(t.due_date)}` : fmtDate(t.due_date)) : ''),
        h('div', { class: 'row', style: { gap: '2px' } },
          iconBtn('arrowUp', 'Move up', () => move(idx, -1), { disabled: !reorderable || idx === 0 }),
          iconBtn('arrowDown', 'Move down', () => move(idx, 1), { disabled: !reorderable || idx === tasks.length - 1 }),
          iconBtn('edit', 'Edit task', () => edit(t)), iconBtn('trash', 'Delete task', () => remove(t))));
      if (reorderable) wireDrag(row, t);
      return row;
    }));
  }

  function statusSelect(t) {
    const sel = h('select', { class: 'select sm', style: { width: '116px' }, 'aria-label': `Status of ${t.title}` }, state.meta.task_statuses.map((s) => h('option', { value: s }, label('task_status', s))));
    sel.value = t.status;
    sel.addEventListener('change', () => setStatus(t, sel.value));
    return sel;
  }

  let dragId = null;
  function wireDrag(row, t) {
    row.addEventListener('dragstart', (e) => { dragId = t.id; row.style.opacity = '0.45'; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); });
    row.addEventListener('dragend', () => { row.style.opacity = ''; dragId = null; list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); });
    row.addEventListener('dragover', (e) => {
      if (dragId === null || dragId === t.id) return;
      e.preventDefault();
      const after = e.offsetY > row.offsetHeight / 2;
      row.classList.toggle('drop-after', after); row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (dragId === null || dragId === t.id) return;
      const after = row.classList.contains('drop-after');
      const ids = tasks.map((x) => x.id).filter((id) => id !== dragId);
      let at = ids.indexOf(t.id) + (after ? 1 : 0);
      ids.splice(at, 0, dragId);
      await saveOrder(ids);
    });
  }

  async function saveOrder(ids) {
    try { tasks = await api('tasks.reorder', { project_id: pid, ids }); paint(); } catch (e) { toast(e.message, 'error'); await load(); }
  }
  const move = (idx, d) => { const ids = tasks.map((t) => t.id); const j = idx + d; if (j < 0 || j >= ids.length) return; [ids[idx], ids[j]] = [ids[j], ids[idx]]; return saveOrder(ids); };

  async function setStatus(t, status) {
    try { const u = await api('tasks.set_status', { id: t.id, status }); tasks = tasks.map((x) => (x.id === u.id ? u : x)); paint(); } catch (e) { toast(e.message, 'error'); paint(); }
  }
  async function add() { const t = await openTaskForm(); if (t) { toast('Task added', 'success'); await load(); } }
  async function edit(t) { const u = await openTaskForm(t); if (u) { toast('Task saved', 'success'); await load(); } }
  async function remove(t) {
    if (!(await confirmDialog({ title: 'Delete task?', message: `“${t.title}” will be permanently deleted.`, confirmLabel: 'Delete task', always: false }))) return;
    try { await api('tasks.delete', { id: t.id }); await load(); } catch (e) { toast(e.message, 'error'); }
  }
  async function load() { tasks = await api('tasks.list', { project_id: pid }); paint(); }

  const select = projectSelect({ projects, value: pid, label: 'Project', onChange: (id) => navigate(`/planner/${id}`) });
  mount(view,
    pageHead({ title: 'Build Planner', sub: 'Tasks for one project. Drag to reorder; completion updates automatically.', actions: [select, btn('Add task', { icon: 'plus', kind: 'primary', onClick: add })] }),
    progressHost, h('div', { class: 'toolbar' }, chipHost), list);
  await load();
  if (currentQuery().get('new') === '1') { history.replaceState(null, '', `#/planner/${pid}`); add(); }
}
