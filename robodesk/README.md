# RoboDesk

An offline Windows desktop workspace for robotics engineering: projects, parts inventory, bills of
materials, CAD file references, wiring diagrams and a build planner. Built with **Tauri 2**, plain
HTML/CSS/JS (no framework, no CDN) and **SQLite**. No account, subscription or network access is needed.

## Features
Dashboard · Projects (create / edit / duplicate / archive / delete) · Parts Inventory (search, category
filter, automatic inventory value) · Bill of Materials per project (exact cent math, tax, shipping, CSV
export) · CAD Files (links to local `.f3d`/`.f3z` files; originals are never modified or deleted; missing
files are flagged and can be relocated) · Wiring Diagrams (interactive SVG editor: components, pins, coloured
wires, drag, zoom/pan, undo/redo, autosave) · Build Planner (priority, status, due date, notes, reordering,
progress) · Settings (theme, autosave, data location, backups, JSON export/import, sample data, reset).

RoboDesk does **not** render or edit Fusion 360 files; it stores references and opens them with the app
Windows associates with that extension.

## Prerequisites (Windows 11)
1. [Rust](https://rustup.rs) (stable, MSVC toolchain) and Visual Studio Build Tools with "Desktop development with C++".
2. [Node.js](https://nodejs.org) 20+.
3. WebView2 runtime (preinstalled on Windows 11; the installer also bundles the bootstrapper).

## Develop
```
npm install
npx tauri dev
```

## Test
```
npm test                       # Rust core tests (48) + JS unit tests
cargo build -p robodesk-core --example devbridge
npm run test:e2e               # headless-Chromium UI tests against the real Rust core (needs `playwright`)
```
The e2e suite runs the real UI against the real data layer through a small dev-only HTTP bridge
(`crates/robodesk-core/examples/devbridge.rs`); only native file dialogs are mocked. It does not exercise
the Tauri shell itself.

## Build the installer
Easiest: `powershell -ExecutionPolicy Bypass -File build-installer.ps1` (runs the build in the background, shows progress, opens the output folder).
Or manually:
```
npm install
npx tauri build
```
Output: `target/release/bundle/nsis/RoboDesk_0.1.0_x64-setup.exe` (per-user install, no admin rights needed).
Alternatively run the **Build Windows installer** GitHub Actions workflow (`.github/workflows/build-windows.yml`).

## Data and backups
The database is `robodesk.db` in `%APPDATA%\com.robodesk.app\data` by default; the location can be changed in
Settings (the database is copied, and the old file is left in place). Backups are consistent snapshots (`VACUUM INTO`)
kept in a `backups` folder next to it; restore, import and reset always take a safety snapshot first. Schema
changes use versioned migrations (`PRAGMA user_version`) with a backup before upgrading. Nothing secret is stored.

## Architecture
- `crates/robodesk-core` – all data logic (SQLite, migrations, BOM math, backups, CSV). GUI-free and unit tested.
- `src-tauri` – thin shell: one `api` command forwarding to the core, plus narrow commands for file dialogs,
  opening files/links and revealing folders. Capabilities are limited to window controls.
- `src` – the UI (ES modules, strict CSP, no `innerHTML`).

## Status and known gaps
- The Windows executable/installer has **not been built or run** in the environment this was written in (Linux).
  The Rust core, UI and shell compilation (`cargo check`) were verified there; Tauri IPC, native dialogs,
  the custom title-bar buttons and the installer should be smoke-tested on Windows first.
- Automated UI tests cover dashboard, projects, inventory and BOM; CAD, wiring editor, planner and settings are
  covered by core/unit tests but not yet by browser tests.

