import assert from 'node:assert/strict';
import test from 'node:test';
import { accessoryKeys, isTerminalModifierKey, modifiedTerminalInput } from '../src/lib/mobileTerminal.ts';

const ctrl = { ctrl: true, alt: false };
const alt = { ctrl: false, alt: true };
const none = { ctrl: false, alt: false };

test('CTRL maps both cases to ASCII control codes, including Ctrl+C', () => {
  for (let i = 0; i < 26; i++) {
    assert.equal(modifiedTerminalInput(String.fromCharCode(97 + i), ctrl), String.fromCharCode(i + 1));
    assert.equal(modifiedTerminalInput(String.fromCharCode(65 + i), ctrl), String.fromCharCode(i + 1));
  }
  assert.equal(modifiedTerminalInput('c', ctrl), '\x03');
  assert.equal(modifiedTerminalInput(' ', ctrl), '\0');
  assert.equal(modifiedTerminalInput('[', ctrl), '\x1b');
  assert.equal(modifiedTerminalInput('?', ctrl), '\x7f');
});

test('ALT prefixes ESC; combined CTRL+ALT composes correctly', () => {
  assert.equal(modifiedTerminalInput('x', alt), '\x1bx');
  assert.equal(modifiedTerminalInput('c', { ctrl: true, alt: true }), '\x1b\x03');
});

test('unmodified keys, pastes and multi-character IME text are not rewritten', () => {
  for (const input of ['c', '|', '/', '~', '-', '\t', '\r', '中文', 'echo hello\r', '\x1b[200~paste\x1b[201~']) {
    assert.equal(modifiedTerminalInput(input, none), input);
    if (input.length > 1) {
      assert.equal(modifiedTerminalInput(input, ctrl), input);
      assert.equal(isTerminalModifierKey(input), false);
    }
  }
});

test('normal and application-mode arrows support one-shot modifiers', () => {
  for (const prefix of ['\x1b[', '\x1bO']) {
    for (const direction of 'ABCD') {
      const key = prefix + direction;
      assert.equal(isTerminalModifierKey(key), true);
      assert.equal(modifiedTerminalInput(key, none), key);
      assert.equal(modifiedTerminalInput(key, ctrl), `\x1b[1;5${direction}`);
      assert.equal(modifiedTerminalInput(key, alt), `\x1b[1;3${direction}`);
      assert.equal(modifiedTerminalInput(key, { ctrl: true, alt: true }), `\x1b[1;7${direction}`);
    }
  }
});

test('accessory emits standard terminal key sequences', () => {
  assert.deepEqual(Object.fromEntries(accessoryKeys), {
    ESC: '\x1b', TAB: '\t', '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C', '|': '|', '/': '/', '~': '~', '-': '-',
  });
});
