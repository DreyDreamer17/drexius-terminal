// Desktop split-layout smoke test: instant keyboard splits, more than four panes, free-form
// geometry, draggable dividers, directional focus, close and equalize.
//
// Like the mobile smoke test this needs a real Chromium (CHROMIUM_PATH) and the Vite dev server
// (BASE_URL, default http://localhost:5173). It uses the browser demo sandbox and a throwaway vault.
import assert from 'node:assert/strict';
import { chromium as playwright } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

if (!process.env.CHROMIUM_PATH) throw new Error('Set CHROMIUM_PATH to your Chromium executable; see docs/DEVELOPMENT.md.');
const artifactDir = 'node_modules/.cache/split-layout';
await mkdir(artifactDir, { recursive: true });
const browser = await playwright.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
// xterm throws "Cannot read properties of undefined (reading 'dimensions')" from its own timers for
// every terminal in headless, GPU-less Chrome, including a lone first pane on the code before split
// trees existed. It is unrelated to layout, so ignore exactly that message and fail on any other.
const KNOWN_HEADLESS_XTERM_ERROR = /reading 'dimensions'/;
page.on('pageerror', (e) => {
  if (!KNOWN_HEADLESS_XTERM_ERROR.test(e.message)) errors.push(e.message);
});
page.setDefaultTimeout(10000);
const shot = (name) => page.screenshot({ path: `${artifactDir}/${name}.png` });

/** Visible panes with their on-screen boxes, in DOM (id) order. */
const panes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-pane-id]')]
      .filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.paneId, active: el.dataset.paneActive === 'true', x: r.x, y: r.y, w: r.width, h: r.height };
      })
  );
const activeId = async () => (await panes()).find((p) => p.active)?.id;
const press = async (combo) => {
  await page.keyboard.press(combo);
  await page.waitForTimeout(250);
};
const overlap = (a, b) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
const assertNoOverlap = (list) => {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) assert.ok(!overlap(list[i], list[j]), `panes ${i} and ${j} overlap`);
};

try {
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByPlaceholder(/^Master password/).fill('split-test-vault-42');
  await page.getByPlaceholder('Confirm master password').fill('split-test-vault-42');
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  await page.getByRole('button', { name: 'I have saved my recovery key' }).click();
  await page.getByRole('button', { name: /Local Terminal/ }).first().click();
  await page.waitForTimeout(800);
  assert.equal((await panes()).length, 1, 'starts with one pane');

  // Ctrl+Shift+D splits right immediately: no menu, no extra click.
  await press('Control+Shift+D');
  assert.equal((await panes()).length, 2);
  assert.equal(await page.getByText('Split with Host').count(), 0, 'no host picker opens');
  assert.equal(await page.locator('[role=separator]').count(), 1, 'one divider between two panes');

  // More than four panes, not snapping to a 2x2 grid: keep splitting right -> a row of five.
  for (let i = 0; i < 3; i++) await press('Control+Shift+D');
  let list = await panes();
  assert.equal(list.length, 5, 'five panes');
  assert.equal(await page.locator('.xterm:visible').count(), 5, 'five live terminals');
  assert.equal(new Set(list.map((p) => Math.round(p.y))).size, 1, 'a single row, not a grid');
  assertNoOverlap(list);
  await shot('five-columns');

  // Ctrl+Shift+E splits the focused (last) pane downward, leaving the others full height.
  const before = await panes();
  const focused = await activeId();
  await press('Control+Shift+E');
  list = await panes();
  assert.equal(list.length, 6);
  assertNoOverlap(list);
  const stillTall = before.filter((p) => p.id !== focused);
  for (const b of stillTall) {
    const now = list.find((p) => p.id === b.id);
    assert.ok(Math.abs(now.h - b.h) < 2, 'other panes keep their full height');
  }
  const halves = list.filter((p) => p.h < before[0].h * 0.6);
  assert.equal(halves.length, 2, 'only the split pane was halved');
  await shot('six-panes');

  // Alt+Shift+D / E split left and up.
  await press('Alt+Shift+D');
  await press('Alt+Shift+E');
  list = await panes();
  assert.equal(list.length, 8);
  assertNoOverlap(list);

  // Dragging a divider resizes its neighbours.
  const divider = page.locator('[role=separator][aria-orientation=vertical]').first();
  const widths = async () => Object.fromEntries((await panes()).map((p) => [p.id, p.w]));
  const w0 = await widths();
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const w1 = await widths();
  const grew = Object.keys(w0).filter((id) => w1[id] - w0[id] > 40);
  const shrank = Object.keys(w0).filter((id) => w0[id] - w1[id] > 40);
  assert.ok(grew.length >= 1 && shrank.length >= 1, 'dragging moved space from one pane to another');
  await shot('dragged');

  // Double-clicking a divider splits it evenly again.
  await divider.dblclick();
  await page.waitForTimeout(250);
  const w2 = await widths();
  assert.ok(grew.every((id) => Math.abs(w2[id] - w0[id]) < 6), 'double-click restores an even split');

  // Directional focus follows the geometry, and a missing direction does nothing harmful.
  const startId = await activeId();
  await press('Alt+ArrowRight');
  const afterRight = await activeId();
  await press('Alt+ArrowLeft');
  assert.equal(await activeId(), startId, 'left undoes right');
  assert.ok(afterRight, 'focus stays on a pane');

  // Ctrl+] cycles through every pane exactly once.
  const seen = new Set([await activeId()]);
  for (let i = 0; i < 8; i++) {
    await press('Control+]');
    seen.add(await activeId());
  }
  assert.equal(seen.size, 8, 'next-pane visits all eight panes');

  // Closing panes hands their space to a sibling and never leaves a gap or overlap.
  for (let i = 0; i < 3; i++) await press('Control+Shift+W');
  list = await panes();
  assert.equal(list.length, 5);
  assertNoOverlap(list);
  const area = list.reduce((s, p) => s + p.w * p.h, 0);
  const layer = await page.evaluate(() => {
    const el = document.querySelector('[data-pane-id]').parentElement.getBoundingClientRect();
    return el.width * el.height;
  });
  assert.ok(area / layer > 0.9, `panes fill the window after closing (${(area / layer).toFixed(3)})`);

  // Equalize.
  await press('Control+Shift+N');
  await shot('equalized');
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('split layout smoke test passed');
} catch (err) {
  await shot('failure').catch(() => {});
  throw err;
} finally {
  await browser.close();
}
