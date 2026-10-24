import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SHORTCUTS,
  RESERVED_SHORTCUTS,
  findShortcutConflict,
  matchesShortcut,
  normalizeCombo,
} from '../src/lib/settings.ts';

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

test('rebinding onto another shortcut or a built-in is refused, onto a free key or itself is not', () => {
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Ctrl+Shift+D'), 'Split Right');
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'shift+ctrl+d'), 'Split Right');
  assert.match(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Ctrl+Shift+C'), /Copy selection \(built-in\)/);
  assert.match(findShortcutConflict(DEFAULT_SHORTCUTS, 'toggle_zen', 'Ctrl+F'), /Find in terminal/);
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Alt+Shift+E'), null, 'its own key');
  assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS, 'split_up', 'Ctrl+Alt+Shift+Y'), null, 'a free key');
});

test('matchesShortcut understands the new combinations', () => {
  const ev = (init) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
  assert.ok(matchesShortcut(ev({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+D'));
  assert.ok(matchesShortcut(ev({ key: 'D', code: 'KeyD', altKey: true, shiftKey: true }), 'Alt+Shift+D'));
  assert.ok(!matchesShortcut(ev({ key: 'D', code: 'KeyD', ctrlKey: true, altKey: true, shiftKey: true }), 'Ctrl+Shift+D'));
  assert.ok(matchesShortcut(ev({ key: 'N', code: 'KeyN', metaKey: true, shiftKey: true }), 'Ctrl+Shift+N'), 'Cmd counts as Ctrl');
});
