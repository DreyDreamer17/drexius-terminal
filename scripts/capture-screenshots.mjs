#!/usr/bin/env node
/**
 * Regenerate the README / docs demo images in `docs/images/`.
 *
 * The images are captured from the **browser preview** build — the real React UI wired
 * to the demo sandbox — so they are always in sync with the code in this repository.
 * Nothing here is a mock-up: every PNG is a screenshot of the running application.
 *
 * Usage:
 *   npm run dev                       # in one terminal
 *   CHROMIUM_PATH=/path/to/chromium npm run screenshots
 *
 * Environment:
 *   CHROMIUM_PATH  Path to a Chromium/Chrome executable. Required — `playwright-core`
 *                   deliberately ships no browser of its own.
 *   BASE_URL       Base URL of the running app. Defaults to http://127.0.0.1:5173.
 *   OUT_DIR        Output directory. Defaults to docs/images.
 *
 * Notes:
 *   * WebGL is disabled on purpose. The app prefers xterm's WebGL renderer, but a
 *     headless/software GL stack renders the terminal canvas blank. Disabling WebGL
 *     makes the app fall back to xterm's DOM renderer, which is deterministic and
 *     visually identical for the purposes of a screenshot.
 *   * The vault password is a throwaway constant. It only ever protects a disposable
 *     localStorage demo vault inside a throwaway browser context.
 */

import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT = process.env.OUT_DIR || 'docs/images';
const DEMO_PASSWORD = 'drexius-demo-2026';
const EXECUTABLE = process.env.CHROMIUM_PATH;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};

/** Take a screenshot without waiting on CSS animations to settle. */
async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 120_000 });
    note(`  ok   ${name}.png`);
  } catch (err) {
    note(`  FAIL ${name}.png — ${String(err.message).split('\n')[0]}`);
  }
}

/** Create the disposable demo vault and dismiss the recovery kit. */
async function createVault(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const create = page.getByRole('button', { name: 'Create vault' });
  if ((await create.count()) === 0) {
    // A vault already exists in this context — unlock it instead.
    await page.locator('input[placeholder*="Master password"]').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: /Unlock/i }).first().click();
    await page.waitForTimeout(3000);
    return;
  }

  await page.locator('input[placeholder*="Master password"]').fill(DEMO_PASSWORD);
  await page.locator('input[placeholder="Confirm master password"]').fill(DEMO_PASSWORD);
  await create.click();
  await page.waitForTimeout(3000);

  const ack = page.getByRole('button', { name: /I have saved my recovery key/i });
  if ((await ack.count()) > 0) {
    await ack.click();
    await page.waitForTimeout(2500);
  }
}

async function newPage(browser, { viewport, mobile = false }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? MOBILE_UA : undefined,
  });
  // The icon rail and the status bar are opt-in in the UI, and the rail is where the
  // sync / pairing / auto-lock buttons live. Turn both on so the screenshots show the
  // full chrome rather than a stripped-down variant.
  await context.addInitScript(() => {
    localStorage.setItem('drx.rail', '1');
    localStorage.setItem('drx.status', '1');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return { context, page, errors };
}

/** Run one capture step; a failure is logged and the run continues. */
async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    note(`  FAIL ${label} — ${String(err.message).split('\n')[0]}`);
  }
}

async function captureDesktop(browser) {
  note('desktop (1440x900)');
  const { context, page, errors } = await newPage(browser, { viewport: DESKTOP });

  // 1. load app & wait for splash to transition to lock screen
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  // 2. lock screen / create vault
  await shot(page, 'lock-screen');

  // 3. emergency recovery kit
  await step('create vault', async () => {
    await page.locator('input[placeholder*="Master password"]').fill(DEMO_PASSWORD);
    await page.locator('input[placeholder="Confirm master password"]').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Create vault' }).click();
    await page.waitForTimeout(3000);
    await shot(page, 'recovery-kit');
  });

  // 4. the workspace
  await step('workspace', async () => {
    await page.getByRole('button', { name: /I have saved my recovery key/i }).click();
    await page.waitForTimeout(2500);
    await shot(page, 'workspace');
  });

  // 5. hosts drawer
  await step('hosts', async () => {
    await page.locator('[title^="Hosts / Vaults"]').first().click();
    await page.waitForTimeout(2000);
    await shot(page, 'hosts');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
  });

  // 6. terminal with multi-pane split
  await step('terminal', async () => {
    await page.getByRole('button', { name: /Open Local Terminal/i }).click();
    await page.waitForTimeout(3000);

    // Command in first pane
    await page.keyboard.type('neofetch');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    // Split vertical to demonstrate multi-pane layout
    const splitBtn = page.locator('[title^="Split vertical"]').first();
    if ((await splitBtn.count()) > 0) {
      await splitBtn.click();
      await page.waitForTimeout(800);
      const opt = page.locator('.fixed.z-50 button').first();
      if ((await opt.count()) > 0) {
        await opt.click();
        await page.waitForTimeout(3000);
      }
    }

    // Command in second pane
    await page.keyboard.type('docker ps');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    await shot(page, 'terminal');
  });

  // 7. AI assistant
  await step('ai-assistant', async () => {
    await page.locator('[title^="AI Assistant"]').first().click();
    await page.waitForTimeout(2500);
    await shot(page, 'ai-assistant');
    await page.locator('[title^="AI Assistant"]').first().click();
    await page.waitForTimeout(1200);
  });

  // 8. SFTP browser
  await step('sftp-browser', async () => {
    await page.locator('[title^="SFTP File Browser"]').first().click();
    await page.waitForTimeout(2500);
    await shot(page, 'sftp-browser');
  });

  // 9. relay sync
  await step('sync-relay', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.locator('[title="Zero-knowledge sync"]').first().click();
    await page.waitForTimeout(2500);
    await shot(page, 'sync-relay');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
  });

  // 10. device pairing
  await step('pairing', async () => {
    await page.locator('[title^="Direct device pairing"]').first().click();
    await page.waitForTimeout(2500);
    await shot(page, 'pairing');
  });

  await context.close();
  return errors;
}

async function captureMobile(browser) {
  note('mobile (390x844)');
  const { context, page, errors } = await newPage(browser, { viewport: MOBILE, mobile: true });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await shot(page, 'mobile-lock');

  await step('mobile vault', () => createVault(page));
  await shot(page, 'mobile-hosts');

  await step('mobile terminal', async () => {
    await page.getByRole('button', { name: /Open Local Terminal/i }).click();
    await page.waitForTimeout(6000);
    await shot(page, 'mobile-terminal');
  });

  await context.close();
  return errors;
}

async function main() {
  if (!EXECUTABLE || !existsSync(EXECUTABLE)) {
    console.error(
      'CHROMIUM_PATH is not set (or does not exist).\n' +
        'Install a browser with `npx playwright-core install chromium`, then set\n' +
        'CHROMIUM_PATH to the downloaded executable.'
    );
    process.exit(1);
  }
  if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ['--disable-gpu', '--disable-webgl', '--disable-3d-apis'],
  });

  let errors = [];
  try {
    errors = errors.concat(await captureDesktop(browser));
    errors = errors.concat(await captureMobile(browser));
  } finally {
    await browser.close();
  }

  await writeFile(join(OUT, 'screenshots.log'), log.join('\n') + '\n');
  if (errors.length) {
    console.warn(`\n${errors.length} console/page error(s) during capture:`);
    for (const e of errors.slice(0, 10)) console.warn('  ' + e);
  } else {
    console.log('\nNo console or page errors during capture.');
  }
}

await main();
