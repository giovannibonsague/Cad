// Shared app state: settings, metadata from the backend, and the "current project" convenience.

import { api } from './api.js';

export const state = {
  settings: {},
  meta: { project_statuses: [], task_statuses: [], task_priorities: [], categories: [], themes: [] },
  info: {},
};

const LAST_PROJECT_KEY = 'robodesk.lastProject';

export function getLastProject() {
  try {
    const v = Number(localStorage.getItem(LAST_PROJECT_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setLastProject(id) {
  try {
    if (id) localStorage.setItem(LAST_PROJECT_KEY, String(id));
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch { /* storage unavailable: harmless, only a convenience */ }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'navy';
}

export async function loadAppState() {
  const [meta, settings, info] = await Promise.all([api('app.meta'), api('settings.get'), api('app.info')]);
  state.meta = meta;
  state.settings = settings;
  state.info = info;
  applyTheme(settings.theme);
}

export async function saveSetting(key, value) {
  state.settings = await api('settings.set', { key, value });
  if (key === 'theme') applyTheme(state.settings.theme);
  return state.settings;
}

export async function refreshInfo() {
  state.info = await api('app.info');
  return state.info;
}

/** Pick the project to show on project-scoped pages: URL param, then last used, then newest. */
export async function resolveProject(preferredId) {
  const projects = await api('projects.list', {});
  let chosen = projects.find((p) => p.id === Number(preferredId)) || projects.find((p) => p.id === getLastProject()) || projects[0] || null;
  if (chosen) setLastProject(chosen.id);
  return { projects, project: chosen };
}
