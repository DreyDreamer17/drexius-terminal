#!/usr/bin/env node
/**
 * Regression guard for Tauri Content Security Policy (CSP).
 *
 * In `tauri dev`, Vite bypasses production CSP headers, so CSP breakages
 * only surface in production release builds. This script enforces that:
 * 1. `script-src` includes 'wasm-unsafe-eval' (required for @xterm/addon-image WebAssembly decoders).
 * 2. `style-src` includes 'unsafe-inline' (required for xterm dynamic cursors and styling).
 * 3. `dangerousDisableAssetCspModification` includes 'style-src' (prevents Tauri from
 *    injecting SHA-256 hashes that trigger W3C CSP Level 2/3 rules ignoring 'unsafe-inline').
 *
 * Usage: node scripts/check-csp-guards.mjs
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CONF_PATH = resolve(process.cwd(), 'src-tauri/tauri.conf.json');

async function main() {
  const raw = await readFile(CONF_PATH, 'utf8');
  const conf = JSON.parse(raw);

  const sec = conf.app?.security || conf.security;
  if (!sec) {
    console.error('FAIL: No security configuration block found in tauri.conf.json');
    process.exit(1);
  }

  const csp = sec.csp || '';
  const errors = [];

  if (!csp.includes("'wasm-unsafe-eval'")) {
    errors.push("CSP script-src must contain 'wasm-unsafe-eval' so xterm-addon-image WebAssembly decoders can run.");
  }

  if (!csp.includes("'unsafe-inline'")) {
    errors.push("CSP style-src must contain 'unsafe-inline' for xterm.js dynamic styles and cursors.");
  }

  const disabled = sec.dangerousDisableAssetCspModification;
  if (!Array.isArray(disabled) || !disabled.includes('style-src')) {
    errors.push("security.dangerousDisableAssetCspModification must include 'style-src' to prevent Tauri from injecting SHA-256 hashes that disable 'unsafe-inline'.");
  }

  if (errors.length > 0) {
    console.error('CSP Regression Guard FAILED:');
    for (const err of errors) {
      console.error(`  ✖ ${err}`);
    }
    process.exit(1);
  }

  console.log('✔ CSP regression guard: tauri.conf.json satisfies all terminal WebAssembly and stylesheet requirements.');
}

main().catch((err) => {
  console.error('Fatal error checking CSP guards:', err);
  process.exit(1);
});
