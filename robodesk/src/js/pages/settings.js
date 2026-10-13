import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api, native } from '../api.js';
import { fmtBytes, fmtDateTime, plural } from '../lib/format.js';
import { navigate } from '../router.js';
import { state, saveSetting, refreshInfo } from '../state.js';
import { badge, banner, btn, confirmDialog, pageHead, panel, selectEl, switchEl, toast, alertDialog, createTable, emptyState } from '../ui.js';

const THEME_LABELS = { graphite: 'Graphite (default)', navy: 'Navy', midnight: 'Midnight (darker)', light: 'Light' };
const KIND_LABELS = { backup: 'Manual / scheduled', preimport: 'Before import', prerestore: 'Before restore', prereset: 'Before reset', premigrate: 'Before upgrade' };

function row(title, desc, control) {
  return h('div', { class: 'list-row', style: { alignItems: 'center', gap: '16px', padding: '12px 14px' } },
    h('div', { class: 'grow' }, h('div', { style: { fontWeight: 500 } }, title), desc ? h('div', { class: 'faint', style: { fontSize: '12px', marginTop: '2px' } }, desc) : null),
    control);
}

async function guarded(fn) { try { return await fn(); } catch (e) { toast(e.message || 'Something went wrong.', 'error'); return null; } }

export async function render({ view }) {
  let backups = await api('data.list_backups');
  const info = state.info;

  const set = (key) => (value) => guarded(async () => { await saveSetting(key, value); toast('Setting saved', 'success'); if (key === 'autosave_enabled' || key === 'autosave_interval_secs') paintAutosave(); });

  const autosaveHost = h('div');
  const paintAutosave = () => mount(autosaveHost,
    row('Autosave wiring diagrams', 'Saves editor changes automatically after a short pause. Turn off to save only with Ctrl+S or the Save button.', switchEl({ checked: state.settings.autosave_enabled, label: 'Autosave', onChange: set('autosave_enabled') })),
    row('Autosave delay', 'Seconds of inactivity before an automatic save.', selectEl({ label: 'Autosave delay', value: state.settings.autosave_interval_secs, options: [2, 5, 10, 30, 60].map((n) => ({ value: n, label: `${n} seconds` })), onChange: (v) => set('autosave_interval_secs')(Number(v)) })));
  paintAutosave();

  // ---------------------------------------------------------------- location
  const locationHost = h('div');
  const paintLocation = () => mount(locationHost,
    h('div', { class: 'list-row', style: { padding: '12px 14px' } }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 500 } }, 'Data folder'), h('div', { class: 'mono faint selectable', style: { marginTop: '3px', wordBreak: 'break-all' } }, state.info.data_dir)),
      h('div', { class: 'row' }, btn('Open', { size: 'sm', icon: 'folderOpen', onClick: () => guarded(() => native.revealDataFolder()) }), btn('Change…', { size: 'sm', onClick: changeLocation }))),
    h('div', { class: 'list-row faint', style: { fontSize: '12px' } }, `Database file: ${state.info.db_path} · schema v${state.info.schema_version}`));

  async function changeLocation() {
    const dir = await guarded(() => native.pickFolder());
    if (!dir) return;
    const attempt = async (useExisting) => api('data.set_location', { path: dir, use_existing: useExisting });
    try {
      let res;
      try { res = await attempt(false); } catch (e) {
        if (e.code !== 'conflict') throw e;
        const ok = await confirmDialog({ title: 'Use existing RoboDesk data?', message: `A RoboDesk database already exists in “${dir}”. Switching will show that data instead of what you see now. Your current data is not deleted and remains in its old folder.`, confirmLabel: 'Switch to that data', danger: false });
        if (!ok) return;
        res = await attempt(true);
      }
      await refreshInfo();
      toast(res.changed ? 'Data location changed. Your data was copied there.' : 'Already using that folder.', 'success');
      document.querySelector('#status-data').textContent = state.info.db_path;
      backups = await api('data.list_backups');
      paintLocation(); paintBackups();
    } catch (e) { toast(e.message, 'error'); }
  }
  paintLocation();

  // ----------------------------------------------------------------- backups
  const backupHost = h('div');
  function paintBackups() {
    const t = createTable({
      sort: null,
      columns: [
        { key: 'name', label: 'Backup', sortable: false, className: 'cell-main mono', render: (b) => b.name },
        { key: 'kind', label: 'Reason', sortable: false, render: (b) => badge(KIND_LABELS[b.kind] || b.kind) },
        { key: 'modified_at', label: 'Created', sortable: false, render: (b) => fmtDateTime(b.modified_at) },
        { key: 'size_bytes', label: 'Size', align: 'right', sortable: false, render: (b) => fmtBytes(b.size_bytes) },
        { key: 'a', label: '', sortable: false, className: 'actions', render: (b) => btn('Restore…', { size: 'sm', icon: 'restore', onClick: () => restore(b) }) },
      ],
      empty: emptyState({ icon: 'database', title: 'No backups yet', text: 'Create a backup before big changes. RoboDesk also makes one automatically before imports, restores, resets and upgrades.' }),
    });
    t.setRows(backups);
    mount(backupHost, t.el);
  }
  async function backupNow() {
    const b = await guarded(() => api('data.backup'));
    if (b) { toast('Backup created', 'success'); backups = await api('data.list_backups'); paintBackups(); }
  }
  async function restore(b) {
    const ok = await confirmDialog({ title: 'Restore this backup?', message: `Everything now in RoboDesk will be replaced by the data in “${b.name}”. A safety backup of your current data is created first, so you can undo this.`, confirmLabel: 'Restore backup' });
    if (!ok) return;
    const res = await guarded(() => api('data.restore_backup', { name: b.name }));
    if (res) { toast('Backup restored', 'success'); await alertDialog({ title: 'Restored', message: `Your data was restored. The previous state was saved as “${res.safety_backup}”.` }); navigate('/dashboard'); location.reload(); }
  }
  paintBackups();

  // ----------------------------------------------------------- export/import
  async function exportJson() {
    const path = await guarded(() => native.pickSavePath('json', `robodesk-export-${new Date().toISOString().slice(0, 10)}.json`));
    if (!path) return;
    const r = await guarded(() => api('data.export_json', { path }));
    if (r) toast(`Exported ${plural(r.projects, 'project')} and ${plural(r.components, 'part')}`, 'success');
  }
  async function importJson() {
    const [path] = (await guarded(() => native.pickFiles('json', false))) || [];
    if (!path) return;
    const ok = await confirmDialog({ title: 'Import and replace all data?', message: 'Importing REPLACES all projects, parts, BOMs, CAD references, diagrams, tasks and settings with the contents of the file. The file is checked completely before anything changes, and a safety backup is made first.', confirmLabel: 'Import and replace', requireText: 'IMPORT' });
    if (!ok) return;
    const r = await guarded(() => api('data.import_json', { path }));
    if (r) { await alertDialog({ title: 'Import complete', message: `Imported ${plural(r.imported.projects, 'project')}, ${plural(r.imported.components, 'part')}, ${plural(r.imported.bom_items, 'BOM line')} and ${plural(r.imported.tasks, 'task')}. Your previous data was saved as “${r.safety_backup}”.` }); location.reload(); }
  }

  // -------------------------------------------------------------- sample/reset
  const sampleHost = h('div');
  function paintSample() {
    const loaded = state.info.sample_loaded;
    mount(sampleHost, row('Sample data', loaded ? 'A demo line-follower and servo-arm project with parts are loaded. Removing them leaves your own data untouched.' : 'Load two example projects with parts, a BOM, tasks and a wiring diagram to explore the app.',
      loaded ? btn('Remove sample data', { kind: 'danger', onClick: removeSample }) : btn('Load sample data', { onClick: loadSample })));
  }
  async function loadSample() { if (await guarded(() => api('sample.load'))) { await refreshInfo(); toast('Sample data loaded', 'success'); paintSample(); } }
  async function removeSample() {
    if (!(await confirmDialog({ title: 'Remove sample data?', message: 'Only the sample projects and sample parts are deleted. Anything you created yourself stays.', confirmLabel: 'Remove sample data' }))) return;
    const r = await guarded(() => api('sample.remove'));
    if (r) { await refreshInfo(); toast(`Removed ${plural(r.projects, 'project')} and ${plural(r.components, 'part')}`, 'success'); paintSample(); }
  }
  paintSample();

  async function resetAll() {
    const ok = await confirmDialog({ title: 'Delete ALL data?', message: 'This permanently deletes every project, part, BOM, CAD reference, wiring diagram and task. Your CAD files on disk are not touched. A safety backup is made first and listed above, so this can be undone by restoring it.', confirmLabel: 'Delete everything', requireText: state.meta.reset_confirmation });
    if (!ok) return;
    const r = await guarded(() => api('data.reset_all', { confirm: state.meta.reset_confirmation }));
    if (r) { toast('All data deleted. A safety backup was created.', 'success'); navigate('/dashboard'); location.reload(); }
  }

  mount(view,
    pageHead({ title: 'Settings', sub: 'Appearance, saving, and where your data lives. RoboDesk works fully offline and needs no account.' }),
    state.info.startup_warning ? banner('warn', state.info.startup_warning) : null,
    h('div', { class: 'stack', style: { maxWidth: '980px' } },
      panel({ title: 'Appearance & behavior', icon: 'settings', flush: true, body: [
        row('Theme', 'Applies immediately.', selectEl({ label: 'Theme', value: state.settings.theme, options: state.meta.themes.map((t) => ({ value: t, label: THEME_LABELS[t] || t })), onChange: set('theme') })),
        row('Confirm before deleting small items', 'Tasks are removed without a prompt when this is off. Projects, parts and data operations always ask.', switchEl({ checked: state.settings.confirm_destructive, label: 'Confirm deletes', onChange: set('confirm_destructive') })),
        autosaveHost,
      ] }),
      panel({ title: 'Data location', icon: 'database', flush: true, body: locationHost }),
      panel({ title: 'Backups', icon: 'save', flush: true,
        actions: [selectEl({ label: 'Backups to keep', value: state.settings.backup_keep, options: [5, 10, 20, 50].map((n) => ({ value: n, label: `Keep ${n}` })), onChange: (v) => set('backup_keep')(Number(v)) }), btn('Back up now', { size: 'sm', kind: 'primary', icon: 'save', onClick: backupNow })],
        body: backupHost }),
      panel({ title: 'Export & import', icon: 'download', flush: true, body: [
        row('Export all data (JSON)', 'A complete, human-readable copy you can keep or move to another computer.', btn('Export…', { icon: 'download', onClick: exportJson })),
        row('Import from export file', 'Replaces everything with the contents of a RoboDesk export. Checked first; safety backup made.', btn('Import…', { icon: 'upload', onClick: importJson })),
      ] }),
      panel({ title: 'Sample data & reset', icon: 'alert', flush: true, body: [
        sampleHost,
        row('Delete all data', 'Removes everything you have entered. A safety backup is created first.', btn('Delete all data…', { kind: 'danger', onClick: resetAll })),
      ] }),
      h('div', { class: 'faint', style: { fontSize: '12px', padding: '4px 2px 20px' } }, `RoboDesk v${info.version}. No passwords or API keys are stored, and nothing is sent over the network.`),
    ));
}
