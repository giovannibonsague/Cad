import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../api.js';
import { money, fmtDate, fmtDateTime, label, BADGE_KIND, plural, int } from '../lib/format.js';
import { navigate } from '../router.js';
import { setLastProject } from '../state.js';
import { badge, btn, confirmDialog, emptyState, pageHead, panel, progress, tile, toast, banner } from '../ui.js';
import { openProjectForm } from './projects.js';

export async function render({ params, view }) {
  const id = Number(params.id);
  let p;
  try { p = await api('projects.get', { id }); } catch (e) {
    mount(view, emptyState({ icon: 'projects', title: 'Project not found', text: 'It may have been deleted.', actions: [btn('Back to projects', { onClick: () => navigate('/projects') })] }));
    return;
  }
  setLastProject(id);
  const [bom, tasks, cad, diagrams] = await Promise.all([
    api('bom.get', { project_id: id }), api('tasks.list', { project_id: id }), api('cad.list', { project_id: id }), api('diagrams.list', { project_id: id }),
  ]);
  const st = p.stats;
  const nextTasks = tasks.filter((t) => t.status !== 'done').slice(0, 5);
  const missing = cad.filter((f) => f.status !== 'ok').length;

  const edit = async () => { if (await openProjectForm(p)) { toast('Project saved', 'success'); navigate(`/projects/${id}`); } };
  const duplicate = async () => { try { const c = await api('projects.duplicate', { id }); toast('Project duplicated', 'success'); navigate(`/projects/${c.id}`); } catch (e) { toast(e.message, 'error'); } };
  const archive = async () => { try { await api('projects.set_archived', { id, archived: !p.archived }); toast(p.archived ? 'Project restored' : 'Project archived', 'success'); navigate(`/projects/${id}`); } catch (e) { toast(e.message, 'error'); } };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `"${p.name}" and everything attached to it (BOM lines, tasks, diagrams, CAD references) will be permanently deleted. Your parts inventory and CAD files on disk are not affected.`, confirmLabel: 'Delete project' }))) return;
    try { await api('projects.delete', { id }); toast('Project deleted', 'success'); navigate('/projects'); } catch (e) { toast(e.message, 'error'); }
  };

  mount(view,
    h('div', { class: 'row', style: { marginBottom: '8px' } }, btn('Projects', { kind: 'ghost', size: 'sm', icon: 'right', onClick: () => navigate('/projects') })),
    pageHead({
      title: p.name,
      sub: h('span', { class: 'row' }, badge(label('project_status', p.status), BADGE_KIND.project_status[p.status]), p.archived ? badge('Archived') : null,
        h('span', { class: 'faint' }, [p.start_date ? `Started ${fmtDate(p.start_date)}` : null, p.due_date ? `Due ${fmtDate(p.due_date)}` : null].filter(Boolean).join(' · '))),
      actions: [btn('Edit', { icon: 'edit', onClick: edit }), btn('Duplicate', { icon: 'copy', onClick: duplicate }), btn(p.archived ? 'Restore' : 'Archive', { icon: p.archived ? 'unarchive' : 'archive', onClick: archive }), btn('Delete', { icon: 'trash', kind: 'danger', onClick: remove })],
    }),
    p.description ? h('p', { class: 'muted selectable', style: { marginBottom: '14px', maxWidth: '900px', whiteSpace: 'pre-wrap' } }, p.description) : null,
    h('div', { class: 'tiles' },
      tile({ label: 'Build progress', icon: 'planner', value: `${st.progress_pct}%`, sub: st.tasks_total ? `${st.tasks_done} of ${st.tasks_total} tasks done` : 'No tasks yet' }),
      tile({ label: 'Estimated cost', icon: 'dollar', value: money(st.cost_cents), sub: `${plural(st.bom_lines, 'line')} · ${plural(st.bom_units, 'unit')}`, subKind: bom.shortage_lines ? 'warn' : '' }),
      tile({ label: 'CAD files', icon: 'cad', value: int(st.cad_files), sub: missing ? `${missing} missing on disk` : 'All found', subKind: missing ? 'bad' : '' }),
      tile({ label: 'Wiring diagrams', icon: 'wiring', value: int(st.diagrams), sub: diagrams.length ? `${diagrams.reduce((n, d) => n + d.wires, 0)} wires total` : 'None yet' }),
    ),
    st.tasks_total ? h('div', { style: { marginBottom: '14px', maxWidth: '620px' } }, progress(st.progress_pct, { big: true })) : null,
    bom.shortage_lines ? banner('warn', `${plural(bom.shortage_lines, 'BOM line')} need more parts than are in stock. Review them in the `, h('a', { href: `#/bom/${id}` }, 'Bill of Materials'), '.') : null,
    h('div', { class: 'grid cols-2' },
      panel({
        title: 'Parts (BOM)', icon: 'bom', flush: true, actions: btn('Open BOM', { size: 'sm', onClick: () => navigate(`/bom/${id}`) }),
        body: bom.lines.length
          ? [...bom.lines.slice(0, 6).map((l) => h('div', { class: 'list-row' }, h('div', { class: 'grow ellipsis' }, l.name), h('span', { class: 'muted' }, `× ${l.quantity}`), h('span', { class: 'num', style: { width: '90px' } }, money(l.line_total_cents)))),
            bom.lines.length > 6 ? h('div', { class: 'list-row faint' }, `+ ${bom.lines.length - 6} more`) : null,
            h('div', { class: 'list-row', style: { fontWeight: 600 } }, h('div', { class: 'grow' }, 'Total'), h('span', { class: 'num' }, money(bom.total_cents)))]
          : emptyState({ icon: 'bom', title: 'No parts yet', text: 'Add parts from your inventory to build this robot’s BOM.', actions: [btn('Add parts', { icon: 'plus', onClick: () => navigate(`/bom/${id}?add=1`) })] }),
      }),
      panel({
        title: 'Next tasks', icon: 'planner', flush: true, actions: btn('Open planner', { size: 'sm', onClick: () => navigate(`/planner/${id}`) }),
        body: nextTasks.length
          ? nextTasks.map((t) => h('div', { class: 'list-row' }, h('span', { class: `dot ${t.priority === 'critical' ? 'red' : t.priority === 'high' ? 'amber' : 'blue'}` }), h('div', { class: 'grow ellipsis' }, t.title), badge(label('task_status', t.status), BADGE_KIND.task_status[t.status]), t.due_date ? h('span', { class: 'faint' }, fmtDate(t.due_date)) : null))
          : emptyState({ icon: 'planner', title: tasks.length ? 'All tasks done' : 'No tasks yet', text: tasks.length ? 'Nice work.' : 'Break the build into tasks to track progress.', actions: tasks.length ? [] : [btn('Add task', { icon: 'plus', onClick: () => navigate(`/planner/${id}?new=1`) })] }),
      }),
      panel({
        title: 'CAD files', icon: 'cad', flush: true, actions: btn('Manage', { size: 'sm', onClick: () => navigate(`/cad/${id}`) }),
        body: cad.length
          ? cad.slice(0, 5).map((f) => h('div', { class: 'list-row' }, h('span', { class: 'badge mono-badge' }, f.extension), h('div', { class: 'grow ellipsis' }, f.display_name), f.status === 'ok' ? h('span', { class: 'faint' }, 'Found') : badge('Missing', 'red')))
          : emptyState({ icon: 'cad', title: 'No CAD files linked', text: 'Link your Fusion 360 .f3d / .f3z files to keep them with the project.', actions: [btn('Link files', { icon: 'plus', onClick: () => navigate(`/cad/${id}`) })] }),
      }),
      panel({
        title: 'Notes', icon: 'edit',
        body: p.notes ? h('div', { class: 'notes-text selectable', style: { whiteSpace: 'pre-wrap' } }, p.notes) : h('span', { class: 'muted' }, 'No notes. Use Edit to add design decisions, links or reminders.'),
        foot: h('span', { class: 'faint' }, `Created ${fmtDateTime(p.created_at)} · Modified ${fmtDateTime(p.updated_at)}`),
      }),
    ),
  );
}
