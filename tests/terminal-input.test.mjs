import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractLastShellArg,
  normalizeOptionAsMetaMode,
  resolveAltMetaSequence,
  shouldSwallowAltKeypress,
  updateAltSidesFromKeyEvent,
} from '../src/lib/terminalInput.ts';
import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  saveUiPreferences,
} from '../src/lib/settings.ts';
import { keyPaletteGroups } from '../src/lib/mobileTerminal.ts';

function makeEvent(overrides = {}) {
  return {
    type: 'keydown',
    key: '.',
    code: 'Period',
    location: 0,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    getModifierState: () => false,
    ...overrides,
  };
}

test('macOS Option+. (key="≥", code="Period") emits ESC+. in "both" mode (#60)', () => {
  const ctx = { isMac: true, optionAsMeta: 'both', altSides: { left: true, right: false } };
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '≥', code: 'Period' }), ctx),
    '\x1b.',
  );
  // Shifted Option+Shift+. (Readline end-of-history Alt+>) and Option+Shift+, (Alt+<)
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '˘', code: 'Period', shiftKey: true }), ctx),
    '\x1b>',
  );
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '¯', code: 'Comma', shiftKey: true }), ctx),
    '\x1b<',
  );
  // Numpad decimal with Option
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '.', code: 'NumpadDecimal' }), ctx),
    '\x1b.',
  );
});

test('macOS Option+letters, dead keys, numbers, space, and editing keys emit ESC sequences', () => {
  const ctx = { isMac: true, optionAsMeta: 'both', altSides: { left: true, right: false } };

  // Common Readline / Zsh / Emacs Meta bindings where macOS composes Unicode symbols
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '∫', code: 'KeyB' }), ctx), '\x1bb');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'ƒ', code: 'KeyF' }), ctx), '\x1bf');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '∂', code: 'KeyD' }), ctx), '\x1bd');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'ç', code: 'KeyC' }), ctx), '\x1bc');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '†', code: 'KeyT' }), ctx), '\x1bt');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'ı', code: 'KeyB', shiftKey: true }), ctx), '\x1bB');

  // macOS Dead keys (Option+e, Option+u, Option+i, Option+n, Option+`)
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Dead', code: 'KeyE' }), ctx), '\x1be');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Dead', code: 'KeyU' }), ctx), '\x1bu');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Dead', code: 'KeyI' }), ctx), '\x1bi');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Dead', code: 'KeyN' }), ctx), '\x1bn');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Dead', code: 'Backquote' }), ctx), '\x1b`');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Dead', code: 'Backquote', shiftKey: true }), ctx), '\x1b~');

  // Numeric prefix arguments (e.g. Alt+2 Alt+.)
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '™', code: 'Digit2' }), ctx), '\x1b2');

  // Option+Space (NBSP on macOS), Option+Backspace, Option+Enter, Option+Minus/Underscore
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '\u00a0', code: 'Space' }), ctx), '\x1b ');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Backspace', code: 'Backspace' }), ctx), '\x1b\x7f');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: 'Enter', code: 'Enter' }), ctx), '\x1b\r');
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '—', code: 'Minus', shiftKey: true }), ctx), '\x1b_');
});

test('macOS optionAsMeta "left", "right", and "off" respect physical Option side', () => {
  const optDot = makeEvent({ key: '≥', code: 'Period' });

  // Left only: Left Option -> ESC+., Right Option -> null (preserves macOS symbols)
  assert.equal(
    resolveAltMetaSequence(optDot, { isMac: true, optionAsMeta: 'left', altSides: { left: true, right: false } }),
    '\x1b.',
  );
  assert.equal(
    resolveAltMetaSequence(optDot, { isMac: true, optionAsMeta: 'left', altSides: { left: false, right: true } }),
    null,
  );

  // Right only: Right Option -> ESC+., Left Option -> null
  assert.equal(
    resolveAltMetaSequence(optDot, { isMac: true, optionAsMeta: 'right', altSides: { left: false, right: true } }),
    '\x1b.',
  );
  assert.equal(
    resolveAltMetaSequence(optDot, { isMac: true, optionAsMeta: 'right', altSides: { left: true, right: false } }),
    null,
  );

  // Off: neither Option side is rewritten
  assert.equal(
    resolveAltMetaSequence(optDot, { isMac: true, optionAsMeta: 'off', altSides: { left: true, right: true } }),
    null,
  );
});

test('updateAltSidesFromKeyEvent tracks Left/Right Alt and self-heals stale state', () => {
  let s = { left: false, right: false };
  s = updateAltSidesFromKeyEvent(s, { type: 'keydown', key: 'Alt', code: 'AltLeft', location: 1, altKey: true });
  assert.deepEqual(s, { left: true, right: false });

  s = updateAltSidesFromKeyEvent(s, { type: 'keydown', key: 'Alt', code: 'AltRight', location: 2, altKey: true });
  assert.deepEqual(s, { left: true, right: true });

  s = updateAltSidesFromKeyEvent(s, { type: 'keyup', key: 'Alt', code: 'AltLeft', location: 1, altKey: true });
  assert.deepEqual(s, { left: false, right: true });

  // Simulated missed keyup across window switch: non-Alt key arrives with altKey=false
  s = updateAltSidesFromKeyEvent(s, { type: 'keydown', key: 'a', code: 'KeyA', location: 0, altKey: false });
  assert.deepEqual(s, { left: false, right: false });
});

test('Linux and Windows Alt+. works across US, non-US layouts, and Numpad without hijacking AltGr', () => {
  const ctx = { isMac: false, optionAsMeta: 'both', altSides: { left: true, right: false } };

  // Standard US Alt+.
  assert.equal(resolveAltMetaSequence(makeEvent({ key: '.', code: 'Period' }), ctx), '\x1b.');

  // Non-US layout (e.g. French AZERTY where '.' sits on Semicolon+Shift)
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '.', code: 'Semicolon', shiftKey: true }), ctx),
    '\x1b.',
  );

  // Numpad decimal
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '.', code: 'NumpadDecimal' }), ctx),
    '\x1b.',
  );

  // AltGr on Linux/Windows must NEVER be intercepted
  assert.equal(
    resolveAltMetaSequence(
      makeEvent({ key: '@', code: 'KeyQ', getModifierState: (k) => k === 'AltGraph' }),
      ctx,
    ),
    null,
  );

  // Windows Ctrl+Alt (AltGr synthesis) must NEVER be intercepted
  assert.equal(
    resolveAltMetaSequence(makeEvent({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), ctx),
    null,
  );
});

test('shouldSwallowAltKeypress blocks duplicate composed chars on macOS and ignores non-keypress', () => {
  const ctx = { isMac: true, optionAsMeta: 'both', altSides: { left: true, right: false } };
  assert.equal(shouldSwallowAltKeypress(makeEvent({ type: 'keypress', key: '≥', code: 'Period' }), ctx), true);
  assert.equal(shouldSwallowAltKeypress(makeEvent({ type: 'keydown', key: '≥', code: 'Period' }), ctx), false);
  assert.equal(
    shouldSwallowAltKeypress(
      makeEvent({ type: 'keypress', key: '≥', code: 'Period' }),
      { isMac: true, optionAsMeta: 'off', altSides: { left: true, right: false } },
    ),
    false,
  );
});

test('arrows, navigation keys, F-keys, and modifier-only keys pass through to xterm.js', () => {
  const ctx = { isMac: true, optionAsMeta: 'both', altSides: { left: true, right: false } };
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F12', 'Alt', 'Shift']) {
    assert.equal(resolveAltMetaSequence(makeEvent({ key, code: key }), ctx), null, `Expected null for ${key}`);
  }
});

test('extractLastShellArg extracts last token respecting quotes and escaping', () => {
  assert.equal(extractLastShellArg('ls -la /var/log/nginx/error.log'), '/var/log/nginx/error.log');
  assert.equal(extractLastShellArg('mkdir -p "/opt/my app/config"   '), '"/opt/my app/config"');
  assert.equal(extractLastShellArg("grep 'hello world' file.txt"), 'file.txt');
  assert.equal(extractLastShellArg('cp a.txt my\\ file.txt'), 'my\\ file.txt');
  assert.equal(extractLastShellArg('   '), null);
});

test('optionAsMeta preference defaults to "both", normalizes invalid values, and round-trips', () => {
  assert.equal(DEFAULT_UI_PREFERENCES.optionAsMeta, 'both');
  assert.equal(normalizeOptionAsMetaMode('left'), 'left');
  assert.equal(normalizeOptionAsMetaMode('right'), 'right');
  assert.equal(normalizeOptionAsMetaMode('off'), 'off');
  assert.equal(normalizeOptionAsMetaMode('invalid'), 'both');
  assert.equal(normalizeOptionAsMetaMode(undefined), 'both');

  const store = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    saveUiPreferences({ ...DEFAULT_UI_PREFERENCES, optionAsMeta: 'left' });
    assert.equal(loadUiPreferences().optionAsMeta, 'left');

    store.set('drx.settings.preferences', JSON.stringify({ optionAsMeta: 'bogus' }));
    assert.equal(loadUiPreferences().optionAsMeta, 'both');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('mobile extended keypad includes Alt+. and Readline word-editing shortcuts', () => {
  const navGroup = keyPaletteGroups.find((g) => g.title === 'Navigation & Editing');
  assert.ok(navGroup, 'Navigation & Editing group should exist');
  const map = Object.fromEntries(navGroup.keys.map((k) => [k.label, k.data]));
  assert.equal(map['alt+.'], '\x1b.');
  assert.equal(map['alt+⌫'], '\x1b\x7f');
  assert.equal(map['alt+b'], '\x1bb');
  assert.equal(map['alt+f'], '\x1bf');
  assert.equal(map['alt+d'], '\x1bd');
});
