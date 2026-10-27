import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SHORTCUTS,
  RESERVED_SHORTCUTS,
  UNBOUND_SHORTCUT,
  applyShortcutOverride,
  bindingMatches,
  findShortcutConflict,
  isShortcutUnbound,
  loadShortcuts,
  matchesShortcut,
  normalizeCombo,
  saveShortcuts,
} from '../src/lib/settings.ts';
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, clampTerminalFontSize } from '../src/lib/mobileTerminal.ts';

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
