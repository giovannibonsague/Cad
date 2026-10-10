import { h, mount } from '../lib/dom.js';
import { api, native } from '../api.js';
import { fmtBytes, fmtDateTime, plural } from '../lib/format.js';
import { navigate } from '../router.js';
import { resolveProject } from '../state.js';
import { badge, banner, btn, confirmDialog, createTable, emptyState, formModal, iconBtn, noProjects, pageHead, projectSelect, toast, alertDialog } from '../ui.js';

const STATUS = {
  ok: ['Found', 'green'],
  missing: ['Missing', 'red'],
  not_a_file: ['Not a file', 'red'],
  unreadable: ['No access', 'amber'],
};

export async function render({ params, view }) {
  const { projects, project } = await resolveProject(params.id);
  if (!project) { mount(view, pageHead({ title: 'CAD Files' }), noProjects(navigate)); return; }
  const pid = project.id;
  let files = [];

  const table = createTable({
    sort: { key: 'display_name', dir: 'asc' },
    rowClass: (f) => (f.status !== 'ok' ? 'row-missing' : ''),
    columns: [
      { key: 'display_name', label: 'File', className: 'cell-main', render: (f) => [f.display_name, h('span', { class: 'sub mono ellipsis', style: { maxWidth: '520px' }, title: f.path }, f.path)] },
      { key: 'extension', label: 'Type', render: (f) => badge(f.extension, '', 'mono-badge') },
      { key: 'status', label: 'State', render: (f) => badge(...STATUS[f.status]) },
      { key: 'size', label: 'Size', align: 'right', sortValue: (f) => f.current_size_bytes ?? f.size_bytes ?? -1, render: (f) => fmtBytes(f.current_size_bytes ?? f.size_bytes) },
      { key: 'modified', label: 'Modified', sortValue: (f) => f.current_modified_at || f.file_modified_at || '', render: (f) => fmtDateTime(f.current_modified_at || f.file_modified_at) },
      { key: 'notes', label: 'Notes', className: 'maxw', render: (f) => f.notes },
      { key: 'actions', label: '', sortable: false, className: 'actions', render: (f) => h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '2px' } },
        f.status === 'ok' ? btn('Open', { size: 'sm', icon: 'external', onClick: () => open(f), title: 'Open with the default application (Fusion 360)' }) : btn('Relocate', { size: 'sm', icon: 'link', kind: 'primary', onClick: () => relocate(f) }),
        f.status === 'ok' ? iconBtn('folderOpen', 'Show in folder', () => native.revealCad(f.id).catch((e) => toast(e.message, 'error'))) : null,
        iconBtn('edit', 'Edit name and notes', () => edit(f)),
        iconBtn('x', 'Remove from project (keeps the file)', () => remove(f)),
      ) },
    ],
    empty: emptyState({ icon: 'cad', title: 'No CAD files linked to this project', text: 'Link existing Fusion 360 .f3d or .f3z files. RoboDesk keeps a reference to each file; it never moves, copies or deletes your originals.', actions: [btn('Link files…', { icon: 'plus', kind: 'primary', onClick: () => link() })] }),
  });

  const bannerHost = h('div');
  async function load() {
    files = await api('cad.list', { project_id: pid });
    table.setRows(files);
    const missing = files.filter((f) => f.status !== 'ok').length;
    mount(bannerHost, missing ? banner('warn', `${plural(missing, 'file')} could not be found at the saved location. They may have been moved, renamed or are on a disconnected drive. Use Relocate to point to the new location, or remove the entry.`) : null);
  }

  async function link() {
    try {
      const paths = await native.pickFiles('cad', true);
      if (!paths.length) return;
      const res = await api('cad.register', { project_id: pid, paths });
      if (res.registered.length) toast(`Linked ${plural(res.registered.length, 'file')}`, 'success');
      if (res.skipped.length) {
        await alertDialog({ title: `${plural(res.skipped.length, 'file')} not added`, kind: 'warn', message: h('ul', { style: { margin: 0, paddingLeft: '18px' } }, res.skipped.map((s) => h('li', {}, h('span', { class: 'mono' }, s.path.split(/[\\/]/).pop()), ` — ${s.reason}`))) });
      }
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function open(f) { try { await native.openCad(f.id); } catch (e) { toast(e.message, 'error'); await load(); } }
  async function relocate(f) {
    try {
      const [path] = await native.pickFiles('cad', false);
      if (!path) return;
      await api('cad.relocate', { id: f.id, path });
      toast('File location updated', 'success');
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function edit(f) {
    const r = await formModal({ title: 'Edit CAD entry', size: 'narrow', fields: [
      { name: 'display_name', label: 'Display name', required: true, value: f.display_name, maxlength: 200, hint: 'Only changes the label in RoboDesk, not the file name.' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: f.notes, rows: 3 },
    ], onSubmit: (v) => api('cad.update', { id: f.id, display_name: v.display_name, notes: v.notes }) });
    if (r) { toast('Saved', 'success'); await load(); }
  }
  async function remove(f) {
    const ok = await confirmDialog({ title: 'Remove CAD entry?', message: `“${f.display_name}” will be removed from this project’s list. The file itself is NOT deleted and stays where it is.`, confirmLabel: 'Remove entry', danger: false });
    if (!ok) return;
    try { await api('cad.remove', { id: f.id }); toast('Entry removed (file untouched)', 'success'); await load(); } catch (e) { toast(e.message, 'error'); }
  }

  const select = projectSelect({ projects, value: pid, label: 'Project', onChange: (id) => navigate(`/cad/${id}`) });
  mount(view,
    pageHead({ title: 'CAD Files', sub: 'Fusion 360 .f3d / .f3z files linked to a project. Files open in their associated application; RoboDesk does not render or edit models.', actions: [select, btn('Link files…', { icon: 'plus', kind: 'primary', onClick: link })] }),
    bannerHost, table.el);
  await load();
}
