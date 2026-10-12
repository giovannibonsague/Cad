// Small stroke icon set (24x24 grid). Drawn for this app; no external icon dependency.
import { s } from './dom.js';

const P = {
  dashboard: 'M3 3h8v8H3z M13 3h8v5h-8z M13 10h8v11h-8z M3 13h8v8H3z',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  parts: 'M7 7h10v10H7z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3',
  bom: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  cube3d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4.2 M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4-.9 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  cad: 'M12 2l9 5v10l-9 5-9-5V7z M12 12l9-5 M12 12v10 M12 12L3 7',
  wiring: 'M3 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M17 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M7 5h5a3 3 0 0 1 3 3v8a3 3 0 0 0 3 3',
  planner: 'M9 6h12 M9 12h12 M9 18h12 M3 6l1.5 1.5L7 5 M3 12l1.5 1.5L7 10 M3 18l1.5 1.5L7 16',
  settings: 'M4 6h10 M18 6h2 M4 12h2 M10 12h10 M4 18h12 M20 18h0 M14 4v4 M8 10v4 M16 16v4',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-4.3-4.3',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  copy: 'M9 9h11v11H9z M5 15V5a1 1 0 0 1 1-1h10',
  archive: 'M3 5h18v4H3z M5 9v10h14V9 M10 13h4',
  unarchive: 'M3 5h18v4H3z M5 9v10h14V9 M12 17v-6 M9 13l3-3 3 3',
  download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  upload: 'M12 16V5 M7 9l5-5 5 5 M5 20h14',
  x: 'M6 6l12 12 M18 6L6 18',
  max: 'M5 5h14v14H5z',
  restore: 'M8 8h11v11H8z M5 16V5h11',
  external: 'M14 4h6v6 M20 4L10 14 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  refresh: 'M20 11a8 8 0 0 0-14.5-4 M4 4v4h4 M4 13a8 8 0 0 0 14.5 4 M20 20v-4h-4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  alert: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  info: 'M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
  check: 'M5 12l5 5L20 7',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  right: 'M9 6l6 6-6 6',
  grip: 'M9 6h.01 M9 12h.01 M9 18h.01 M15 6h.01 M15 12h.01 M15 18h.01',
  folderOpen: 'M5 19h13l3-8H8l-3 8z M5 19V6h4l2 2h7v3',
  zoomIn: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-4.3-4.3 M11 8v6 M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-4.3-4.3 M8 11h6',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  save: 'M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6',
  robot: 'M12 2v4 M7 6h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M9 12h.01 M15 12h.01 M9 16h6',
  calendar: 'M5 5h14v15H5z M5 10h14 M9 3v4 M15 3v4',
  more: 'M12 5h.01 M12 12h.01 M12 19h.01',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  clock: 'M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18z M12 7v5l3 2',
  dollar: 'M12 3v18 M16 7.5C16 6 14.5 5 12 5S8 6.2 8 8c0 4 8 2.5 8 7 0 1.8-1.7 3-4 3s-4-1-4-2.5',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  flag: 'M5 21V4 M5 4h12l-2 4 2 4H5',
  cursor: 'M5 3l14 7-6 2-2 6z',
};

export function icon(name, size = 16, cls) {
  const d = P[name];
  if (!d) throw new Error(`Unknown icon "${name}"`);
  return s(
    'svg',
    {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: cls,
    },
    s('path', { d }),
  );
}

export const ICON_NAMES = Object.keys(P);
