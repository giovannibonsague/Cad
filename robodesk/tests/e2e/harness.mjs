// E2E harness: starts the real Rust core behind a tiny HTTP bridge and drives the real
// frontend in headless Chromium. Only native OS dialogs/openers are mocked.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright', path.join(os.homedir(), '.npm-global/lib/node_modules/playwright')]) {
    try { return require(p); } catch { /* try next */ }
  }
  throw new Error('playwright is not installed (npm i -D playwright)');
}

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (d.startsWith('chromium-') && fs.existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return undefined; // let Playwright use its own download
}

export const SHIM = `
window.__calls = [];
window.__native = window.__native || {};
window.__TAURI__ = {
  core: {
    async invoke(cmd, args) {
      window.__calls.push({ cmd, args });
      if (cmd === 'api') {
        const r = await fetch('/api', { method: 'POST', body: JSON.stringify(args) });
        const body = await r.json();
        if (!r.ok) throw body;
        return body;
      }
      const fn = window.__native[cmd];
      if (!fn) throw { code: 'error', message: 'Unmocked native command: ' + cmd };
      return typeof fn === 'function' ? fn(args) : fn;
    },
  },
  window: { getCurrentWindow: () => ({ minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false }) },
};
`;

export async function startBridge(dataDir, port) {
  const bin = path.join(ROOT, 'target/debug/examples/devbridge');
  if (!fs.existsSync(bin)) throw new Error('Build the bridge first: cargo build -p robodesk-core --example devbridge');
  const child = spawn(bin, [String(port), path.join(ROOT, 'src'), dataDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge did not start')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error(`bridge exited early (${c})`)));
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }),
  };
}

export async function launch({ width = 1440, height = 900 } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.addInitScript(SHIM);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  return { browser, context, page, problems };
}

export function tmpDir(prefix = 'robodesk-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Call the Rust core directly (bypassing the UI) to verify what was really persisted. */
export const apiCall = (page, cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI__.core.invoke('api', { cmd: c, args: a }), [cmd, args]);

/** Mock a native (non-data) command with a fixed JSON-serialisable return value. */
export const setNative = (page, name, value) => page.evaluate(([n, v]) => { window.__native[n] = () => v; }, [name, value]);
