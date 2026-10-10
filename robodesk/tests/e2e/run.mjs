// End-to-end tests. Run: cargo build -p robodesk-core --example devbridge && node tests/e2e/run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, launch, startBridge, tmpDir, apiCall, setNative } from './harness.mjs';

const shots = path.join(ROOT, 'tests/e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });
const only = process.argv[2]; // optional: run scenarios whose name includes this text

const work = tmpDir();
const dataDir = path.join(work, 'appdata');
let bridge = await startBridge(dataDir, 4311);
const { browser, page, problems } = await launch();
const url = (hash = '') => `${bridge.url}#${hash}`;
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

async function go(hash) {
  await page.goto('about:blank'); // forces a full boot even when only the hash differs
  await page.goto(url(hash));
  await page.waitForSelector('#view > *');
  await page.waitForTimeout(80);
}
const modal = () => page.locator('.modal');
const fill = (label, value) => page.getByLabel(label, { exact: false }).first().fill(value);
const toastText = () => page.locator('.toast').allInnerTexts();
async function waitToast(re) {
  await page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src, 'i').test(t.textContent)), re.source ?? re, { timeout: 5000 });
}

const results = [];
async function scenario(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ok   ${name}`); }
  catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
    await shot(`FAIL-${name.replace(/\W+/g, '-')}`).catch(() => {});
    await page.evaluate(() => document.querySelectorAll('.overlay').forEach((o) => o.remove())).catch(() => {});
  }
}

console.log('RoboDesk end-to-end');

await scenario('dashboard shows an informative empty state on first launch', async () => {
  await go('/dashboard');
  await page.getByRole('heading', { name: 'No projects yet' }).waitFor();
  assert.match(await page.locator('.tiles').innerText(), /projects\s+0/i);
  assert.equal(await page.locator('.nav-item[aria-current="page"]').innerText(), 'Dashboard');
  await shot('01-dashboard-empty');
});

await scenario('new project: validation, creation, overview page', async () => {
  await go('/dashboard');
  await page.getByRole('button', { name: 'New project' }).first().click();
  await modal().waitFor();
  await modal().getByRole('button', { name: 'Create project' }).click();
  await page.getByText('Project name is required.').waitFor();
  await fill('Project name', 'Line Follower Mk1');
  await modal().getByLabel('Description').fill('Two wheel robot following a line');
  await modal().getByLabel('Due date').fill('2025-01-01');
  await modal().getByLabel('Start date').fill('2026-02-01');
  await modal().getByRole('button', { name: 'Create project' }).click();
  await page.getByText('Due date cannot be before the start date.').waitFor(); // backend rule surfaced on the field
  await modal().getByLabel('Due date').fill('2026-12-01');
  await modal().getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/#\/projects\/1$/);
  await page.getByRole('heading', { name: 'Line Follower Mk1' }).waitFor();
  const p = await apiCall(page, 'projects.get', { id: 1 });
  assert.equal(p.name, 'Line Follower Mk1');
  assert.equal(p.due_date, '2026-12-01');
  await shot('02-project-overview');
});

await scenario('inventory: validation, add, edit, search, filter, totals', async () => {
  await go('/inventory');
  await page.getByRole('heading', { name: 'Your inventory is empty' }).waitFor();
  await page.getByRole('button', { name: 'Add part' }).first().click();
  await modal().getByLabel('Name').fill('N20 gear motor');
  await modal().getByLabel('Category').selectOption('motor');
  await modal().getByLabel('Quantity in stock').fill('10');
  await modal().getByLabel('Unit price').fill('abc');
  await modal().getByLabel('Datasheet URL').fill('javascript:alert(1)');
  await modal().getByRole('button', { name: 'Add part' }).click();
  await page.getByText(/Unit price must be a positive amount/).waitFor();
  await page.getByText('Enter a full http:// or https:// link.').waitFor();
  await modal().getByLabel('Unit price').fill('19.99');
  await modal().getByLabel('Datasheet URL').fill('https://example.com/n20.pdf');
  await modal().getByLabel('Voltage').fill('6');
  await modal().getByRole('button', { name: 'Add part' }).click();
  await page.locator('table.data tbody tr', { hasText: 'N20 gear motor' }).waitFor();

  await page.getByRole('button', { name: 'Add part' }).first().click();
  await modal().getByLabel('Name').fill('HC-SR04 ultrasonic');
  await modal().getByLabel('Category').selectOption('sensor');
  await modal().getByLabel('Quantity in stock').fill('5');
  await modal().getByLabel('Unit price').fill('2.75');
  await modal().getByRole('button', { name: 'Add part' }).click();
  await page.locator('table.data tbody tr', { hasText: 'HC-SR04' }).waitFor();

  // 10 * 19.99 + 5 * 2.75 = 199.90 + 13.75 = 213.65
  assert.match(await page.locator('.tiles').innerText(), /\$213\.65/);
  await page.getByLabel('Search parts').fill('ultra');
  await page.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length === 1);
  assert.match(await page.locator('.tiles').innerText(), /\$13\.75/);
  await page.getByLabel('Search parts').fill('100%'); // % must not act as a wildcard
  await page.getByText('No parts match your search or filter.').waitFor();
  await page.getByLabel('Search parts').fill('');
  await page.getByRole('button', { name: /^Motor/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length === 1);

  // edit
  await page.getByRole('button', { name: /^All/ }).click();
  await page.locator('table.data tbody tr', { hasText: 'N20 gear motor' }).getByLabel('Edit part').click();
  await modal().getByLabel('Quantity in stock').fill('12');
  await modal().getByRole('button', { name: 'Save changes' }).click();
  await page.waitForFunction(() => document.querySelector('.tiles')?.textContent.includes('$253.63'));
  await shot('03-inventory');
});

await scenario('BOM: add parts, quantities, tax/shipping math, stock check, CSV export', async () => {
  await go('/bom/1');
  await page.getByRole('heading', { name: 'This BOM is empty' }).waitFor();
  await page.getByRole('button', { name: 'Add parts' }).first().click();
  await modal().getByLabel('Quantity of N20 gear motor to add').fill('3');
  await modal().getByLabel('Quantity of HC-SR04 ultrasonic to add').fill('7');
  await modal().getByRole('button', { name: 'Add to BOM' }).click();
  await modal().waitFor({ state: 'detached' });
  await page.locator('table.data tbody tr').nth(1).waitFor();

  // 3 * 19.99 + 7 * 2.75 = 59.97 + 19.25 = 79.22
  let bom = await apiCall(page, 'bom.get', { project_id: 1 });
  assert.equal(bom.subtotal_cents, 7922);
  assert.match(await page.locator('.panel', { hasText: 'Cost summary' }).innerText(), /\$79\.22/);
  // sensor stock is 5 but BOM needs 7 -> shortage shown
  assert.match(await page.locator('table.data').innerText(), /short 2/i);

  await page.getByRole('button', { name: 'Edit tax & shipping' }).click();
  await modal().getByLabel('Sales tax rate').fill('8.25');
  await modal().getByLabel('Shipping & handling').fill('5.99');
  await modal().getByRole('button', { name: 'Save' }).click();
  // tax = 79.22 * 8.25% = 6.5357 -> $6.54 ; total = 79.22 + 6.54 + 5.99 = 91.75
  await page.waitForFunction(() => document.querySelector('.panel')?.parentElement?.textContent.includes('$91.75'));
  bom = await apiCall(page, 'bom.get', { project_id: 1 });
  assert.deepEqual([bom.tax_cents, bom.shipping_cents, bom.total_cents], [654, 599, 9175]);

  // bad quantity is rejected and reverted
  const qty = page.getByLabel('Quantity of N20 gear motor');
  await qty.fill('0'); await qty.press('Enter');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Quantity of N20 gear motor"]').value === '3');
  await qty.fill('4'); await qty.press('Enter');
  await page.waitForFunction(() => document.body.textContent.includes('$99.21'));
  bom = await apiCall(page, 'bom.get', { project_id: 1 });
  assert.equal(bom.subtotal_cents, 4 * 1999 + 7 * 275); // 99.21
  assert.equal(bom.lines.find((l) => l.name.startsWith('N20')).quantity, 4);

  // CSV export through the (mocked) save dialog
  const csvPath = path.join(work, 'bom.csv');
  await setNative(page, 'pick_save_path', csvPath);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await waitToast(/exported/);
  const csv = fs.readFileSync(csvPath, 'utf8');
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /N20 gear motor,motor,,,4,19\.99,79\.96,12,0/);
  assert.match(csv, /Subtotal,99\.21/);
  assert.match(csv, /Total,/);
  await shot('04-bom');
});

await scenario('planner: add tasks, complete one, progress, persistence across restart', async () => {
  await go('/planner/1');
  await page.getByRole('heading', { name: 'No tasks yet' }).waitFor();
  for (const [title, prio] of [['Wire motor driver', 'high'], ['Calibrate sensors', 'medium']]) {
    await page.getByRole('button', { name: 'Add task' }).first().click();
    await modal().getByLabel('Task').fill(title);
    await modal().getByLabel('Priority').selectOption(prio);
    await modal().getByRole('button', { name: /^(Add task|Save|Create)/ }).click();
    await modal().waitFor({ state: 'detached' });
    await page.getByText(title).first().waitFor();
  }
  await page.getByLabel('Mark “Wire motor driver” as done').check();
  await page.waitForFunction(async () => (await window.__TAURI__.core.invoke('api', { cmd: 'tasks.list', args: { project_id: 1 } }))
    .tasks?.some?.((t) => t.title === 'Wire motor driver' && t.status === 'done') ?? true);
  await shot('05-planner');

  // restart the backend on the same data directory: everything must still be there
  await bridge.stop();
  bridge = await startBridge(dataDir, 4311);
  await go('/planner/1');
  await page.getByText('Calibrate sensors').first().waitFor();
  assert.equal(await page.getByLabel('Mark “Wire motor driver” as not done').isChecked(), true);
  const inv = await apiCall(page, 'components.list', {});
  assert.equal((inv.items ?? inv.components ?? inv).length, 2);
});

// ------------------------------------------------------------------ wrap up
await page.close();
await browser.close();
await bridge.stop();
const bad = problems.filter((p) => !/status of 422/.test(p));
if (bad.length) { console.log('\nUnexpected browser errors:\n  ' + bad.join('\n  ')); results.push({ name: 'no unexpected console errors', ok: false }); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
