import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../api.js';
import { money, int, fmtDate, relTime, label, BADGE_KIND, plural } from '../lib/format.js';
import { navigate } from '../router.js';
import { badge, btn, emptyState, pageHead, panel, progress, tile, toast } from '../ui.js';
import { openProjectForm } from './projects.js';
import { state, refreshInfo } from '../state.js';

export async function render({ view }) {
  const data = await api('dashboard.get');
  const t = data.totals;

  const newProject = async () => {
    const created = await openProjectForm();
    if (created) navigate(`/projects/${created.id}`);
  };

  const loadSample = async () => {
    try {
      await api('sample.load');
      await refreshInfo();
      toast('Sample data loaded. You can remove it any time in Settings.', 'success');
      navigate('/dashboard');
      location.reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  const empty = t.projects_total === 0 && t.components === 0;

  mount(view,
    pageHead({
      title: 'Dashboard',
      sub: empty ? 'Welcome to RoboDesk. Everything is stored locally on this computer.' : `${plural(t.projects_active, 'active project')} · ${plural(t.components, 'part type')} in inventory`,
      actions: [btn('New project', { icon: 'plus', kind: 'primary', onClick: newProject }), btn('Add part', { icon: 'parts', onClick: () => navigate('/inventory?new=1') })],
    }),
    h('div', { class: 'tiles' },
      tile({ label: 'Projects', icon: 'projects', value: int(t.projects_active), sub: t.projects_in_progress ? `${t.projects_in_progress} in progress` : (t.projects_archived ? `${t.projects_archived} archived` : 'None in progress') }),
      tile({ label: 'Components', icon: 'parts', value: int(t.components), sub: `${int(t.component_units)} units in stock · ${money(t.inventory_value_cents)}` }),
      tile({ label: 'Estimated project cost', icon: 'dollar', value: money(t.estimated_cost_cents), sub: 'All active BOMs incl. tax & shipping' }),
      tile({ label: 'Open tasks', icon: 'planner', value: int(t.open_tasks), sub: t.overdue_tasks ? `${t.overdue_tasks} overdue` : 'Nothing overdue', subKind: t.overdue_tasks ? 'bad' : '' }),
    ),
    empty
      ? panel({
        body: emptyState({
          icon: 'robot', title: 'No projects yet',
          text: 'Create a project to start tracking parts, costs, CAD files, wiring and build tasks. Or load a small sample workspace to explore (it can be removed with one click).',
          actions: [btn('Create your first project', { icon: 'plus', kind: 'primary', onClick: newProject }), btn('Load sample data', { onClick: loadSample })],
        }),
      })
      : h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)' } },
        panel({
          title: 'Recently modified projects', icon: 'clock', flush: true,
          actions: btn('All projects', { kind: 'ghost', size: 'sm', onClick: () => navigate('/projects') }),
          body: data.recent_projects.length
            ? data.recent_projects.map((p) => h('div', { class: 'list-row clickable', tabIndex: 0, role: 'link', onClick: () => navigate(`/projects/${p.id}`), onKeydown: (e) => { if (e.key === 'Enter') navigate(`/projects/${p.id}`); } },
              h('div', { class: 'grow' },
                h('div', { class: 'row' }, h('strong', { class: 'ellipsis' }, p.name), badge(label('project_status', p.status), BADGE_KIND.project_status[p.status])),
                h('div', { class: 'faint', style: { fontSize: '12px' } }, `Updated ${relTime(p.updated_at)} · ${plural(p.stats.bom_lines, 'BOM line')} · ${money(p.stats.cost_cents)}`),
              ),
              h('div', { style: { width: '150px' } }, progress(p.stats.progress_pct)),
              h('div', { class: 'row' },
                btn('BOM', { size: 'sm', kind: 'ghost', onClick: (e) => { e.stopPropagation(); navigate(`/bom/${p.id}`); } }),
                btn('Tasks', { size: 'sm', kind: 'ghost', onClick: (e) => { e.stopPropagation(); navigate(`/planner/${p.id}`); } }),
              ),
            ))
            : emptyState({ icon: 'projects', title: 'No active projects', text: 'Archived projects are hidden here.' }),
        }),
        h('div', { class: 'stack' },
          panel({
            title: 'Upcoming deadlines', icon: 'calendar', flush: true,
            body: data.upcoming_tasks.length
              ? data.upcoming_tasks.map((k) => h('div', { class: 'list-row clickable', tabIndex: 0, onClick: () => navigate(`/planner/${k.project_id}`), onKeydown: (e) => { if (e.key === 'Enter') navigate(`/planner/${k.project_id}`); } },
                h('span', { class: `dot ${k.overdue ? 'red' : 'blue'}` }),
                h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, k.title), h('div', { class: 'faint', style: { fontSize: '12px' } }, k.project_name)),
                h('span', { class: k.overdue ? 'badge red' : 'badge' }, k.overdue ? `Overdue · ${fmtDate(k.due_date)}` : fmtDate(k.due_date)),
              ))
              : h('div', { class: 'table-empty' }, 'No tasks with due dates.'),
          }),
          panel({
            title: 'Quick actions', icon: 'flag',
            body: h('div', { class: 'stack', style: { gap: '8px' } },
              btn('New project', { icon: 'plus', onClick: newProject }),
              btn('Manage parts inventory', { icon: 'parts', onClick: () => navigate('/inventory') }),
              btn('Open CAD files', { icon: 'cad', onClick: () => navigate('/cad') }),
              btn('Draw a wiring diagram', { icon: 'wiring', onClick: () => navigate('/wiring') }),
              btn('Back up data', { icon: 'database', onClick: () => navigate('/settings') }),
            ),
          }),
        ),
      ),
  );
}
