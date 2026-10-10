// Bridge to the Rust side. Data goes through one command ("api"); the few native
// operations (dialogs, opening files) have their own narrow commands.

export class ApiError extends Error {
  constructor(message, code = 'error', field = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.field = field;
  }
}

function tauri() {
  const t = window.__TAURI__;
  if (!t?.core?.invoke) throw new ApiError('RoboDesk is not running inside its desktop shell.', 'no_shell');
  return t;
}

function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e && typeof e === 'object' && 'message' in e) return new ApiError(String(e.message), e.code || 'error', e.field || null);
  return new ApiError(typeof e === 'string' ? e : 'Something went wrong.', 'error');
}

async function invoke(cmd, args) {
  try {
    return await tauri().core.invoke(cmd, args);
  } catch (e) {
    throw toApiError(e);
  }
}

/** Data command, e.g. api('projects.list', { search: 'arm' }). */
export const api = (cmd, args = {}) => invoke('api', { cmd, args });

export const native = {
  pickFiles: (kind, multiple = true) => invoke('pick_files', { kind, multiple }),
  pickSavePath: (kind, defaultName) => invoke('pick_save_path', { kind, defaultName }),
  pickFolder: () => invoke('pick_folder'),
  openCad: (id) => invoke('open_cad', { id }),
  revealCad: (id) => invoke('reveal_cad', { id }),
  openDatasheet: (id) => invoke('open_datasheet', { id }),
  revealDataFolder: () => invoke('reveal_data_folder'),
};

export const win = {
  current() {
    try {
      return window.__TAURI__?.window?.getCurrentWindow?.() ?? null;
    } catch {
      return null;
    }
  },
  minimize() { return this.current()?.minimize(); },
  toggleMaximize() { return this.current()?.toggleMaximize(); },
  close() { return this.current()?.close(); },
  isMaximized() { return this.current()?.isMaximized?.() ?? Promise.resolve(false); },
  onResized(cb) { return this.current()?.onResized?.(cb); },
};
