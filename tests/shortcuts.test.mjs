import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_UI_PREFERENCES,
  RESERVED_SHORTCUTS,
  UNBOUND_SHORTCUT,
  applyShortcutOverride,
  bindingMatches,
  findShortcutConflict,
  isShortcutUnbound,
  loadShortcuts,
  loadUiPreferences,
  matchesShortcut,
  normalizeCombo,
  saveShortcuts,
  saveUiPreferences,
} from '../src/lib/settings.ts';
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, clampTerminalFontSize } from '../src/lib/mobileTerminal.ts';
import { createUserPreset } from '../src/lib/layoutPresets.ts';
import { leaf, splitLeaf } from '../src/lib/splitTree.ts';
import {
  THEMES,
  hexToRgba,
  exportThemeJson,
  importThemeFromText,
  loadCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
} from '../src/lib/themes.ts';

// Minimal in-memory localStorage for the persistence round-trip tests.
class MemoryStorage {
  #map = new Map();
  getItem(key) { return this.#map.has(key) ? this.#map.get(key) : null; }
  setItem(key, value) { this.#map.set(key, String(value)); }
  removeItem(key) { this.#map.delete(key); }
  clear() { this.#map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const keyEvent = (init) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });

test('no two default shortcuts share a key combination', () => {
  const seen = new Map();
  for (const s of Object.values(DEFAULT_SHORTCUTS)) {
    const combo = normalizeCombo(s.keys);
    assert.ok(combo, `${s.id} has a key combination`);
    assert.ok(!seen.has(combo), `${s.id} and ${seen.get(combo)} both use ${s.keys}`);
    seen.set(combo, s.id);
  }
});

test('no default shortcut shadows a built-in one', () => {
  for (const s of Object.values(DEFAULT_SHORTCUTS)) {
    const clash = Object.keys(RESERVED_SHORTCUTS).find((r) => normalizeCombo(r) === normalizeCombo(s.keys));
    assert.equal(clash, undefined, `${s.id} (${s.keys}) collides with built-in ${clash}`);
  }
});

test('every shortcut has an id matching its key, a label, a category and a description', () => {
  for (const [key, s] of Object.entries(DEFAULT_SHORTCUTS)) {
    assert.equal(s.id, key);
    assert.ok(s.label && s.description && s.category, `${key} is fully described`);
  }
});

test('the split shortcuts are present with the documented defaults', () => {
  const keys = (id) => DEFAULT_SHORTCUTS[id]?.keys;
  assert.equal(keys('split_vertical'), 'Ctrl+Shift+D');
  assert.equal(keys('split_horizontal'), 'Ctrl+Shift+E');
  assert.equal(keys('split_left'), 'Alt+Shift+D');
  assert.equal(keys('split_up'), 'Alt+Shift+E');
  assert.equal(keys('split_menu'), 'Ctrl+Shift+O');
  assert.equal(keys('equalize_splits'), 'Ctrl+Shift+N');
  assert.equal(keys('popout_pane'), 'Ctrl+Shift+P');
});

test('combos compare regardless of order, case and Ctrl/Cmd spelling', () => {
  assert.equal(normalizeCombo('Cmd+shift+d'), normalizeCombo('Shift+Ctrl+D'));
  assert.equal(normalizeCombo('Opt+Shift+ArrowLeft'), normalizeCombo('alt+shift+arrowleft'));
  assert.notEqual(normalizeCombo('Ctrl+D'), normalizeCombo('Ctrl+Shift+D'));
  assert.equal(normalizeCombo('Ctrl+/'), 'ctrl+/');
});

test('conflicts are still detected against other shortcuts and built-ins', () => {
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Ctrl+Shift+D'), 'Split Right');
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'shift+ctrl+d'), 'Split Right');
  assert.match(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Ctrl+Shift+C'), /Copy selection \(built-in\)/);
  assert.match(findShortcutConflict(DEFAULT_SHORTCUTS, 'toggle_zen', 'Ctrl+F'), /Find in terminal/);
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Alt+Shift+E'), null, 'its own key');
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Ctrl+Alt+Shift+Y'), null, 'a free key');
});

test('unbound shortcuts never register as a conflict', () => {
  const withUnbound = {
    ...DEFAULT_SHORTCUTS,
    save_layout_preset: { ...DEFAULT_SHORTCUTS.save_layout_preset, keys: UNBOUND_SHORTCUT },
  };
  assert.ok(isShortcutUnbound(withUnbound.save_layout_preset));
  // Ctrl+Shift+S now belongs to nobody, so assigning it raises no clash.
  assert.equal(findShortcutConflict(withUnbound, 'split_vertical', 'Ctrl+Shift+S'), null);
});

test('override moves the combination onto the target and unbinds the displaced shortcut', () => {
  const result = applyShortcutOverride(DEFAULT_SHORTCUTS, 'split_vertical', 'Ctrl+Shift+S');
  assert.equal(result.shortcuts.split_vertical.keys, 'Ctrl+Shift+S');
  assert.equal(result.displacedId, 'save_layout_preset');
  assert.equal(result.displacedLabel, 'Save Split Layout Preset');
  assert.equal(result.shortcuts.save_layout_preset.keys, UNBOUND_SHORTCUT);
  // Nothing is left claiming the combination, and every bound combo stays unique.
  assert.equal(findShortcutConflict(result.shortcuts, 'split_vertical', 'Ctrl+Shift+S'), null);
  const seen = new Set();
  for (const binding of Object.values(result.shortcuts)) {
    if (!binding.keys) continue;
    const combo = normalizeCombo(binding.keys);
    assert.ok(!seen.has(combo), `duplicate combo after override: ${combo}`);
    seen.add(combo);
  }
});

test('override without a clash changes only the target binding', () => {
  const result = applyShortcutOverride(DEFAULT_SHORTCUTS, 'split_vertical', 'Ctrl+Alt+Shift+Y');
  assert.equal(result.displacedId, null);
  assert.equal(result.displacedLabel, null);
  assert.equal(result.shortcuts.split_vertical.keys, 'Ctrl+Alt+Shift+Y');
  assert.equal(result.shortcuts.split_horizontal.keys, DEFAULT_SHORTCUTS.split_horizontal.keys);
});

test('bindingMatches: unbound never fires, missing binding uses the fallback', () => {
  const unbound = { ...DEFAULT_SHORTCUTS, toggle_zen: { ...DEFAULT_SHORTCUTS.toggle_zen, keys: '' } };
  const zenEvent = keyEvent({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  assert.equal(bindingMatches(zenEvent, unbound.toggle_zen, 'Ctrl+Shift+Z'), false);
  assert.equal(bindingMatches(zenEvent, DEFAULT_SHORTCUTS.toggle_zen, 'Ctrl+Shift+Z'), true);
  assert.equal(bindingMatches(zenEvent, undefined, 'Ctrl+Shift+Z'), true, 'fallback for a missing binding');
  assert.equal(
    bindingMatches(keyEvent({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), unbound.toggle_zen, 'Ctrl+Shift+Z'),
    false
  );
});

test('an explicit unbind round-trips through loadShortcuts while missing entries keep defaults', () => {
  const stored = {
    ...DEFAULT_SHORTCUTS,
    toggle_zen: { ...DEFAULT_SHORTCUTS.toggle_zen, keys: '' },
  };
  saveShortcuts(stored);
  const loaded = loadShortcuts();
  assert.equal(loaded.toggle_zen.keys, '', 'empty string is a deliberate unbind, not a missing value');
  assert.equal(loaded.split_vertical.keys, DEFAULT_SHORTCUTS.split_vertical.keys, 'untouched entry keeps its default');

  localStorage.clear();
  const fresh = loadShortcuts();
  assert.equal(fresh.toggle_zen.keys, DEFAULT_SHORTCUTS.toggle_zen.keys, 'no saved data means full defaults');
});

test('the font-size shortcuts exist with documented defaults', () => {
  assert.equal(DEFAULT_SHORTCUTS.font_zoom_in.keys, 'Ctrl+=');
  assert.equal(DEFAULT_SHORTCUTS.font_zoom_out.keys, 'Ctrl+-');
  assert.equal(DEFAULT_SHORTCUTS.font_zoom_reset.keys, 'Ctrl+0');
  assert.equal(DEFAULT_SHORTCUTS.font_zoom_in.category, 'Terminal Actions');
});

test('clampTerminalFontSize enforces the supported whole-pixel range', () => {
  assert.equal(clampTerminalFontSize(TERMINAL_FONT_MIN - 5), TERMINAL_FONT_MIN);
  assert.equal(clampTerminalFontSize(TERMINAL_FONT_MAX + 5), TERMINAL_FONT_MAX);
  assert.equal(clampTerminalFontSize(13.7), 14, 'rounds to whole pixels');
  assert.equal(clampTerminalFontSize(Number.NaN), TERMINAL_FONT_MIN);
});

test('matchesShortcut understands the new combinations', () => {
  const ev = (init) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
  assert.ok(matchesShortcut(ev({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+D'));
  assert.ok(matchesShortcut(ev({ key: 'D', code: 'KeyD', altKey: true, shiftKey: true }), 'Alt+Shift+D'));
  assert.ok(!matchesShortcut(ev({ key: 'D', code: 'KeyD', ctrlKey: true, altKey: true, shiftKey: true }), 'Ctrl+Shift+D'));
  assert.ok(matchesShortcut(ev({ key: 'N', code: 'KeyN', metaKey: true, shiftKey: true }), 'Ctrl+Shift+N'), 'Cmd counts as Ctrl');
});

test('default UI preferences include copyOnSelect and rightClickPaste', () => {
  assert.equal(typeof DEFAULT_UI_PREFERENCES.copyOnSelect, 'boolean');
  assert.equal(typeof DEFAULT_UI_PREFERENCES.rightClickPaste, 'boolean');
  assert.equal(DEFAULT_UI_PREFERENCES.copyOnSelect, false);
  assert.equal(DEFAULT_UI_PREFERENCES.rightClickPaste, false);
});

test('loadUiPreferences and saveUiPreferences round-trip copyOnSelect and rightClickPaste', () => {
  localStorage.clear();
  const initial = loadUiPreferences();
  assert.equal(initial.copyOnSelect, false);
  assert.equal(initial.rightClickPaste, false);

  saveUiPreferences({ ...initial, copyOnSelect: true, rightClickPaste: true });
  const updated = loadUiPreferences();
  assert.equal(updated.copyOnSelect, true);
  assert.equal(updated.rightClickPaste, true);

  localStorage.clear();
});

test('createUserPreset saves popped-out panes and their multi-monitor window bounds', () => {
  const tree = splitLeaf(leaf('p1'), 'p1', 'p2', 'right');
  const panes = [
    { id: 'p1', hostId: 'h1', isLocal: false },
    { id: 'p2', hostId: '__local__', isLocal: true },
  ];
  const hostMap = new Map([
    ['h1', { id: 'h1', label: 'prod-api-01', hostname: '10.0.0.1', port: 22, username: 'ubuntu', authMethod: 'key', tags: [], hasSecret: true, color: '#f43f5e' }],
  ]);
  const poppedOutEntries = [
    {
      pane: { id: 'p3', hostId: 'h1', isLocal: false },
      originTabId: 'tab-1',
      title: 'prod-api-01',
      bounds: { x: 1920, y: 120, width: 960, height: 640 },
    },
  ];
  const preset = createUserPreset('Multi-Monitor Setup', tree, panes, hostMap, poppedOutEntries);
  assert.equal(preset.panes.length, 2);
  assert.equal(preset.popoutPanes?.length, 1);
  assert.equal(preset.popoutPanes[0].hostId, 'h1');
  assert.equal(preset.popoutPanes[0].poppedOut, true);
  assert.deepEqual(preset.popoutPanes[0].popoutBounds, { x: 1920, y: 120, width: 960, height: 640 });
  assert.match(preset.description, /1 popped out/);
});

test('Cmd+T and Cmd+W tab shortcuts match and respect reserved built-ins', () => {
  assert.equal(DEFAULT_SHORTCUTS.new_terminal.keys, 'Ctrl+T');
  assert.equal(DEFAULT_SHORTCUTS.close_pane.keys, 'Ctrl+Shift+W');
  assert.match(DEFAULT_SHORTCUTS.new_terminal.description, /Duplicate the active terminal tab/);
  assert.match(DEFAULT_SHORTCUTS.close_pane.description, /close the active tab/);

  // On macOS, Cmd+T matches the default new_terminal binding ('Ctrl+T')
  const macCmdT = keyEvent({ key: 't', code: 'KeyT', metaKey: true });
  assert.equal(bindingMatches(macCmdT, DEFAULT_SHORTCUTS.new_terminal, 'Ctrl+T'), true);

  // Ctrl+Shift+T is reserved as the built-in alternate for Duplicate / new tab
  assert.match(findShortcutConflict(DEFAULT_SHORTCUTS, 'toggle_zen', 'Ctrl+Shift+T'), /Duplicate \/ new tab \(alternate\)/);
});

test('canvas styling and wallpaper preferences round-trip in UI preferences', () => {
  assert.equal(DEFAULT_UI_PREFERENCES.terminalPadding, 10);
  assert.equal(DEFAULT_UI_PREFERENCES.terminalOpacity, 1.0);
  assert.equal(DEFAULT_UI_PREFERENCES.terminalBlur, 0);
  assert.equal(DEFAULT_UI_PREFERENCES.terminalWallpaper, '');
  assert.equal(DEFAULT_UI_PREFERENCES.wallpaperOpacity, 0.25);

  const modified = {
    ...DEFAULT_UI_PREFERENCES,
    terminalPadding: 16,
    terminalOpacity: 0.85,
    terminalBlur: 12,
    terminalWallpaper: 'data:image/png;base64,sample',
    wallpaperOpacity: 0.4,
  };
  saveUiPreferences(modified);
  const loaded = loadUiPreferences();
  assert.equal(loaded.terminalPadding, 16);
  assert.equal(loaded.terminalOpacity, 0.85);
  assert.equal(loaded.terminalBlur, 12);
  assert.equal(loaded.terminalWallpaper, 'data:image/png;base64,sample');
  assert.equal(loaded.wallpaperOpacity, 0.4);
});

test('hexToRgba converts 6-digit, 3-digit and invalid hex strings with opacity clamping', () => {
  assert.equal(hexToRgba('#ff0000', 0.5), 'rgba(255, 0, 0, 0.5)');
  assert.equal(hexToRgba('#00ff00', 1.0), '#00ff00');
  assert.equal(hexToRgba('#0f0', 0.8), 'rgba(0, 255, 0, 0.8)');
  assert.equal(hexToRgba('#123456', 1.5), '#123456');
  assert.equal(hexToRgba('#123456', -0.5), 'rgba(18, 52, 86, 0)');
  assert.equal(hexToRgba('not-a-hex', 0.5), 'not-a-hex');
});

test('curated developer theme suite includes 34 high-fidelity themes', () => {
  assert.equal(THEMES.length, 34);

  const newlyAdded = [
    'vesper',
    'catppuccin-mocha',
    'catppuccin-macchiato',
    'tokyo-night-storm',
    'solarized-osaka',
    'cobalt2',
    'retro-amber',
    'gruvbox-material',
  ];

  for (const id of newlyAdded) {
    const theme = THEMES.find((t) => t.id === id);
    assert.ok(theme, `Theme ${id} must exist in THEMES`);
    assert.ok(theme.name, `Theme ${id} must have a name`);
    assert.ok(theme.accent, `Theme ${id} must have an accent`);
    assert.ok(theme.xterm.background, `Theme ${id} must have a background`);
    assert.ok(theme.xterm.foreground, `Theme ${id} must have a foreground`);
    assert.ok(theme.xterm.cursor, `Theme ${id} must have a cursor`);
    assert.ok(theme.xterm.black, `Theme ${id} must have ANSI black`);
    assert.ok(theme.xterm.brightWhite, `Theme ${id} must have ANSI brightWhite`);
  }
});

test('custom theme creator and export/import round-trip', () => {
  // Clear any existing custom themes in mock storage
  globalThis.localStorage.removeItem('drx.custom_themes.v1');
  assert.deepEqual(loadCustomThemes(), []);

  const sampleTheme = {
    id: 'custom-neon-matrix-1',
    name: 'Neon Matrix Custom',
    accent: '#00ff66',
    isLight: false,
    isCustom: true,
    xterm: {
      background: '#050a06',
      foreground: '#a3f7bf',
      cursor: '#00ff66',
      cursorAccent: '#050a06',
      selectionBackground: '#00ff6633',
      black: '#102015',
      red: '#ff4d6d',
      green: '#00ff66',
      yellow: '#ffd166',
      blue: '#118ab2',
      magenta: '#b5179e',
      cyan: '#06d6a0',
      white: '#e8f7ee',
      brightBlack: '#2d4a36',
      brightRed: '#ff758f',
      brightGreen: '#52b788',
      brightYellow: '#ffe082',
      brightBlue: '#48cae4',
      brightMagenta: '#f72585',
      brightCyan: '#70e000',
      brightWhite: '#ffffff',
    },
  };

  // Save custom theme
  saveCustomTheme(sampleTheme);
  const loaded = loadCustomThemes();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'custom-neon-matrix-1');
  assert.equal(loaded[0].name, 'Neon Matrix Custom');

  // Export to JSON
  const exported = exportThemeJson(loaded[0]);
  assert.match(exported, /"name": "Neon Matrix Custom"/);

  // Import from JSON text
  const imported = importThemeFromText(exported);
  assert.ok(imported);
  assert.equal(imported.name, 'Neon Matrix Custom');
  assert.equal(imported.accent, '#00ff66');
  assert.equal(imported.isCustom, true);

  // Import Ghostty config text format
  const ghosttyConfig = `
background = #1a1b26
foreground = #c0caf5
cursor-color = #c0caf5
selection-background = #33467c
palette = 0=#15161e
palette = 1=#f7768e
palette = 2=#9ece6a
palette = 3=#e0af68
palette = 4=#7aa2f7
palette = 5=#bb9af7
palette = 6=#7dcfff
palette = 7=#a9b1d6
palette = 8=#414868
palette = 9=#f7768e
palette = 10=#9ece6a
palette = 11=#e0af68
palette = 12=#7aa2f7
palette = 13=#bb9af7
palette = 14=#7dcfff
palette = 15=#c0caf5
`;
  const importedGhostty = importThemeFromText(ghosttyConfig);
  assert.ok(importedGhostty);
  assert.equal(importedGhostty.xterm.background, '#1a1b26');
  assert.equal(importedGhostty.xterm.foreground, '#c0caf5');
  assert.equal(importedGhostty.xterm.cursor, '#c0caf5');
  assert.equal(importedGhostty.xterm.black, '#15161e');
  assert.equal(importedGhostty.xterm.brightWhite, '#c0caf5');

  // Delete custom theme
  deleteCustomTheme('custom-neon-matrix-1');
  assert.deepEqual(loadCustomThemes(), []);
});
