import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessoryKeys,
  isTerminalModifierKey,
  modifiedTerminalInput,
  resolveGhostAccessoryAction,
  resolveGhostSuggestionKeyAction,
  deduplicateMobileInput,
  getWrappedRowsAbove,
  SmartTerminalWriter,
} from '../src/lib/mobileTerminal.ts';
import { detectPortsInLine, PortStreamDetector } from '../src/lib/portDetector.ts';

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

test('getWrappedRowsAbove detects continuation rows and ignores wrapped shell prompts', () => {
  const makeTerm = (lines, cursorY, type = 'normal') => ({
    buffer: {
      active: {
        type,
        cursorX: 5,
        cursorY,
        baseY: 0,
        length: lines.length,
        getLine(y) {
          const entry = lines[y];
          if (!entry) return undefined;
          return {
            isWrapped: entry.isWrapped,
            translateToString: () => entry.text ?? '',
          };
        },
      },
    },
  });

  assert.equal(getWrappedRowsAbove(makeTerm([
    { isWrapped: false, text: '  Download:  13.19 Mbps' },
    { isWrapped: false, text: '  Upload:     8.42 Mbps' },
  ], 1)), 0);

  assert.equal(getWrappedRowsAbove(makeTerm([
    { isWrapped: false, text: '  Download:  13.19 Mbps (data used: 15.8 MB)     ' },
    { isWrapped: true, text: '                                                 ' },
    { isWrapped: true, text: '   254.08 ms' },
  ], 2)), 2);

  assert.equal(getWrappedRowsAbove(makeTerm([
    { isWrapped: false, text: '  Download:  13.19 Mbps' },
    { isWrapped: true, text: '  continuation' },
  ], 1, 'alternate')), 0);

  // Wrapped interactive shell prompts must NEVER be treated as progress bars
  for (const prompt of [
    'stephen@dreycore:~$ echo "very long command that wraps onto next line"',
    '(venv) [root@prod-db /var/log]# tail -f syslog',
    'bash-5.2$ export PATH="/usr/local/bin:$PATH"',
    '~/projects/nexus $ npm run build',
    '❯ git commit -m "long commit message"',
    '> continued multiline string',
  ]) {
    assert.equal(getWrappedRowsAbove(makeTerm([
      { isWrapped: false, text: prompt },
      { isWrapped: true, text: 'more wrapped command text' },
      { isWrapped: true, text: 'even more wrapped command text' },
    ], 2)), 0, `Prompt should not rewind: ${prompt}`);
  }
});

test('SmartTerminalWriter rewinds cursor and clears on standalone CR for wrapped progress bars', () => {
  const written = [];
  const mockTerm = {
    written,
    write(d) { written.push(d); },
    buffer: {
      active: {
        type: 'normal',
        cursorX: 5,
        cursorY: 2,
        baseY: 0,
        length: 3,
        getLine(y) {
          return {
            isWrapped: y > 0,
            translateToString: () => (y === 0 ? '  Download:  13.19 Mbps [=========>          ]' : '   padding'),
          };
        },
      },
    },
  };

  const writer = new SmartTerminalWriter(mockTerm);
  // Standard CRLF should pass through normally without rewinding
  writer.write('Progress: done\r\n');
  assert.deepEqual(written, ['Progress: done\r\n']);

  // Standalone CR at start of chunk should rewind wrapped rows
  written.length = 0;
  writer.write('\r  Download:  50.00 Mbps');
  assert.deepEqual(written, ['\x1b[2A\r\x1b[J', '  Download:  50.00 Mbps']);

  // Trailing CR held across chunks (like speedtest/curl) converts trailing padding spaces to \x1b[K
  written.length = 0;
  writer.write('  Download:  60.00 Mbps   \r');
  assert.deepEqual(written, ['  Download:  60.00 Mbps\x1b[K']);
  writer.write('  Download:  75.00 Mbps   \r');
  assert.deepEqual(written, ['  Download:  60.00 Mbps\x1b[K', '\x1b[2A\r\x1b[J', '  Download:  75.00 Mbps\x1b[K']);
  writer.write('\n');
  assert.deepEqual(written, ['  Download:  60.00 Mbps\x1b[K', '\x1b[2A\r\x1b[J', '  Download:  75.00 Mbps\x1b[K', '\r\n']);

  // Coalesced multi-CR burst in a single chunk tracks in-flight wrapped rows so no intermediate tick is left behind
  written.length = 0;
  mockTerm.cols = 45;
  writer.write(
    '\r    Download:   927.95 Mbps [===================-  ] 89%    ' +
    '\r    Download:   928.19 Mbps [====================\\] 97%    ' +
    '\r    Download:   928.13 Mbps (data used: 410.9 MB)          \r\n'
  );
  assert.deepEqual(written, [
    '\x1b[2A\r\x1b[J',
    '    Download:   927.95 Mbps [===================-  ] 89%\x1b[K',
    '\x1b[1A\r\x1b[J',
    '    Download:   928.19 Mbps [====================\\] 97%\x1b[K',
    '\x1b[1A\r\x1b[J',
    '    Download:   928.13 Mbps (data used: 410.9 MB)\x1b[K\r\n',
  ]);

  writer.dispose();
});

test('SmartTerminalWriter preserves UTF-8 characters split across PTY chunks', () => {
  const written = [];
  const mockTerm = {
    written,
    cols: 80,
    write(d) { written.push(d); },
    buffer: { active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, length: 1, getLine: () => undefined } },
  };
  const writer = new SmartTerminalWriter(mockTerm);
  const glyphs = '⠿界🎵';
  const bytes = new TextEncoder().encode(glyphs);

  // Feed one byte at a time so every multibyte sequence crosses PTY read boundaries.
  for (const byte of bytes) writer.write(Uint8Array.of(byte));
  assert.equal(written.join(''), glyphs);
  writer.dispose();
});

test('SmartTerminalWriter leaves alternate-screen TUI output and cursor controls untouched', () => {
  const written = [];
  const mockTerm = {
    written,
    cols: 12,
    write(d) { written.push(d); },
    buffer: { active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, length: 1, getLine: () => undefined } },
  };
  const writer = new SmartTerminalWriter(mockTerm);

  // The mode switch is split across PTY reads; preserve both pieces and don't run
  // the progress-bar CR rewrite on the redraw that completes the switch.
  writer.write('\x1b[?104');
  writer.write('9h\r\x1b[2;1H⠿');
  assert.deepEqual(written, ['\x1b[?104', '9h\r\x1b[2;1H⠿']);

  // Keep passing through even when a later read has no mode-switch sequence.
  written.length = 0;
  writer.write('visualizer\rnext frame');
  assert.deepEqual(written, ['visualizer\rnext frame']);

  // An exit restores normal-buffer progress-bar rewriting.
  written.length = 0;
  const exit = '\x1b[?1049l';
  writer.write(exit);
  assert.deepEqual(written, [exit]);
  written.length = 0;
  writer.write('normal output\rnext');
  assert.deepEqual(written, ['normal output', '\r', 'next']);
  writer.dispose();
});

test('SmartTerminalWriter never rewinds or clears during paste, arrow navigation, or Readline redraws', () => {
  const written = [];
  const mockTerm = {
    written,
    write(d) { written.push(d); },
    buffer: {
      active: {
        type: 'normal',
        cursorX: 0,
        cursorY: 2,
        baseY: 0,
        length: 3,
        getLine(y) {
          return {
            isWrapped: y > 0,
            translateToString: () => 'some wrapped line without standard prompt',
          };
        },
      },
    },
  };

  const writer = new SmartTerminalWriter(mockTerm);

  // 1. Readline Left Arrow across wrapped line boundary emits \r\x1b[A\x1b[53C
  writer.write('\r\x1b[A\x1b[53C');
  assert.deepEqual(written, ['\r', '\x1b[A\x1b[53C']);

  // 2. Pasting or typing suppresses rewind until command is submitted with Enter
  written.length = 0;
  writer.notifyUserInput('echo hello world', true);
  writer.write('\rredrawing pasted command line');
  assert.deepEqual(written, ['\rredrawing pasted command line']);

  // 3. Pressing Left Arrow key (\x1b[D) suppresses rewind
  written.length = 0;
  writer.notifyUserInput('\x1b[D');
  writer.write('\rredrawing after left arrow');
  assert.deepEqual(written, ['\rredrawing after left arrow']);

  // 4. Submitting command with Enter (\r) re-enables progress bar rewinding
  written.length = 0;
  writer.notifyUserInput('\r');
  writer.write('\r  Download:  99.99 Mbps');
  assert.deepEqual(written, ['\x1b[2A\r\x1b[J', '  Download:  99.99 Mbps']);

  // 5. Colored shell prompt after Enter (like cd navigation) must preserve trailing space and never erase line
  written.length = 0;
  writer.notifyUserInput('\r');
  const coloredPrompt = '\r\x1b[01;32mstephen@dreycore\x1b[00m:\x1b[01;34m~/MY PROJECTS\x1b[00m$ ';
  writer.write(coloredPrompt);
  assert.equal(written.join('').endsWith('$ '), true);
  assert.equal(written.join('').includes('\x1b[K'), false);

  writer.dispose();
});

test('detectPortsInLine strips ANSI formatting and detects Vite, FastAPI, Python, and generic listeners', () => {
  // Vite bolds the port number inside ANSI SGR codes
  const viteLine = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m';
  assert.deepEqual(detectPortsInLine(viteLine), [
    { port: 5173, protocol: 'http', sourceText: 'http://localhost:5173/' },
  ]);

  // Python http.server
  const pyLine = 'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...';
  assert.deepEqual(detectPortsInLine(pyLine), [
    { port: 8000, protocol: 'http', sourceText: 'http://0.0.0.0:8000/' },
  ]);

  // Generic listening announcement without URL
  const genericLine = 'Server listening on port 3000';
  assert.deepEqual(detectPortsInLine(genericLine), [
    { port: 3000, protocol: 'http', sourceText: 'listening on port 3000' },
  ]);
});

test('detectPortsInLine ignores connection errors and SSH ports', () => {
  assert.deepEqual(detectPortsInLine('curl: (7) Failed to connect to localhost port 3000: Connection refused'), []);
  assert.deepEqual(detectPortsInLine('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173'), []);
  assert.deepEqual(detectPortsInLine('Server listening on 0.0.0.0:22'), []);
  assert.deepEqual(detectPortsInLine('Listening on 127.0.0.1:8022'), []);
});

test('PortStreamDetector reassembles split chunks without premature partial-port detection', () => {
  const detector = new PortStreamDetector([2222]);
  // Split right in the middle of port 5173
  assert.deepEqual(detector.feed('  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m51'), []);
  assert.deepEqual(detector.feed('73\x1b[22m/\x1b[39m\r\n'), [
    { port: 5173, protocol: 'http', sourceText: 'http://localhost:5173/' },
  ]);
  // Subsequent output with the same port does not re-trigger unless unignored
  assert.deepEqual(detector.feed('http://localhost:5173/\r\n'), []);
  // Ignored SSH port is skipped
  assert.deepEqual(detector.feed('Listening on 0.0.0.0:2222\r\n'), []);
});

async function createHeadlessXterm(cols = 80, rows = 24) {
  globalThis.self ??= globalThis;
  globalThis.window ??= globalThis;
  const xtermMod = await import('@xterm/xterm');
  const Terminal = xtermMod.Terminal ?? xtermMod.default?.Terminal;
  return new Terminal({ cols, rows, allowProposedApi: true });
}

function flushXterm(term) {
  return new Promise((resolve) => term.write('', resolve));
}

test('SmartTerminalWriter.resetModes clears TUI modes and preserves history across disconnect -> reconnect (#44)', async (t) => {
  const term = await createHeadlessXterm(80, 24);
  const writer = new SmartTerminalWriter(term);
  t.after(() => {
    writer.dispose();
    term.dispose();
  });

  // 1. Run shell commands in normal buffer, then launch a full-screen TUI enabling mouse tracking,
  //    SGR mouse, focus reporting, bracketed paste, sync output, app cursor/keypad, no-wrap,
  //    insert mode, DEC line-drawing charset, scroll margins, hidden cursor, and an OSC 8 link.
  writer.write(
    'history line 0\r\nhistory line 1\r\nhistory line 2\r\nbalajie@chnbld04:~$ nvim\r\n' +
    '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?2026h' +
    '\x1b[?1h\x1b[?66h\x1b[?7l\x1b[4h\x1b[?25l\x1b[2;10r\x1b(0\x0e' +
    '\x1b]8;;https://stale.example\x07TUI FRAME'
  );
  await flushXterm(term);

  assert.equal(term.buffer.active.type, 'alternate');
  assert.equal(term.modes.mouseTrackingMode, 'any');
  assert.equal(term.modes.sendFocusMode, true);
  assert.equal(term.modes.bracketedPasteMode, true);
  assert.equal(term.modes.synchronizedOutputMode, true);
  assert.equal(term.modes.applicationCursorKeysMode, true);
  assert.equal(term.modes.applicationKeypadMode, true);
  assert.equal(term.modes.wraparoundMode, false);
  assert.equal(term.modes.insertMode, true);

  // 2. Simulate abrupt SSH disconnect: reset modes + write disconnect status line.
  writer.resetModes();
  term.write('\r\n\x1b[31m✖ connection lost\x1b[0m\r\n');
  await flushXterm(term);

  assert.equal(term.buffer.active.type, 'normal');
  assert.equal(term.modes.mouseTrackingMode, 'none');
  assert.equal(term.modes.sendFocusMode, false);
  assert.equal(term.modes.bracketedPasteMode, false);
  assert.equal(term.modes.synchronizedOutputMode, false);
  assert.equal(term.modes.applicationCursorKeysMode, false);
  assert.equal(term.modes.applicationKeypadMode, false);
  assert.equal(term.modes.wraparoundMode, true);
  assert.equal(term.modes.insertMode, false);
  assert.equal(term.modes.originMode, false);

  // 3. Simulate reconnect: calling resetModes() again (including back-to-back synchronously)
  //    must be idempotent and MUST NOT jump cursor to row 0 via DECRST 1049 restoreCursor().
  writer.resetModes();
  writer.resetModes();
  term.write('\r\n⟲ Resuming balajie@chnbld04:22…\r\n');
  writer.write('✔ Authenticated\r\nbalajie@chnbld04:~$ ascii_ok');
  await flushXterm(term);

  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'history line 0');
  assert.equal(term.buffer.active.getLine(1)?.translateToString(true), 'history line 1');
  assert.equal(term.buffer.active.getLine(2)?.translateToString(true), 'history line 2');
  assert.equal(term.buffer.active.getLine(3)?.translateToString(true), 'balajie@chnbld04:~$ nvim');
  assert.equal(term.buffer.active.getLine(5)?.translateToString(true), '✖ connection lost');
  assert.equal(term.buffer.active.getLine(7)?.translateToString(true), '⟲ Resuming balajie@chnbld04:22…');
  assert.equal(term.buffer.active.getLine(8)?.translateToString(true), '✔ Authenticated');
  // Confirms G0/GL charset returned to ASCII (`ascii_ok`, not DEC box-drawing glyphs).
  assert.equal(term.buffer.active.getLine(9)?.translateToString(true), 'balajie@chnbld04:~$ ascii_ok');
});

test('SmartTerminalWriter.resetModes preserves cursor row on normal-shell and ?1047h/?47h disconnects', async (t) => {
  const term = await createHeadlessXterm(80, 24);
  const writer = new SmartTerminalWriter(term);
  t.after(() => {
    writer.dispose();
    term.dispose();
  });

  // Case A: Disconnect from a normal shell (never entered alternate buffer) keeps cursor row intact.
  writer.write('row zero\r\nrow one\r\nrow two\r\nprompt$ ');
  await flushXterm(term);
  assert.equal(term.buffer.active.cursorY, 3);

  writer.resetModes();
  term.write('\r\n[disconnected]\r\n');
  await flushXterm(term);
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'row zero');
  assert.equal(term.buffer.active.getLine(1)?.translateToString(true), 'row one');
  assert.equal(term.buffer.active.getLine(2)?.translateToString(true), 'row two');
  assert.equal(term.buffer.active.getLine(3)?.translateToString(true), 'prompt$ ');
  assert.equal(term.buffer.active.getLine(4)?.translateToString(true), '[disconnected]');

  // Case B: Bare `?1047h` TUI (entered without saving cursor) restores normal buffer cursor row instead of row 0.
  writer.write('next prompt$ \r\n\x1b[?1047h\x1b[1;1HTUI TOP');
  await flushXterm(term);
  assert.equal(term.buffer.active.type, 'alternate');

  writer.resetModes();
  term.write('[after 1047]\r\n');
  await flushXterm(term);
  assert.equal(term.buffer.active.type, 'normal');
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), 'row zero');
  assert.equal(term.buffer.active.getLine(5)?.translateToString(true), 'next prompt$ ');
  assert.equal(term.buffer.active.getLine(6)?.translateToString(true), '[after 1047]');
});

test('SmartTerminalWriter.resetModes survives mid-stream Kitty APC, split UTF-8, unterminated OSC/DCS, and trailing CR', async (t) => {
  const term = await createHeadlessXterm(40, 24);
  const writer = new SmartTerminalWriter(term);
  t.after(() => {
    writer.dispose();
    term.dispose();
  });

  // 1. Wrapped output ending on a split `\r` (before `\n`) + mouse tracking + unterminated Kitty APC:
  //    resetModes() must NOT `\x1b[J` erase wrapped output and must NOT let kittyProcessor swallow the reset.
  writer.write('Download: 99.9 Mbps [====================] wrapping line\r');
  writer.write('\x1b[?1003h\x1b[?1006h\x1b_Ga=T,f=100;iVBORw0KGgoAAAANSUhEUgAA');
  await flushXterm(term);
  assert.equal(term.modes.mouseTrackingMode, 'any');

  writer.resetModes();
  await flushXterm(term);
  assert.equal(term.modes.mouseTrackingMode, 'none');
  assert.match(term.buffer.active.getLine(0)?.translateToString(true) ?? '', /^Download: 99\.9 Mbps/);

  // 2. Drop mid-UTF-8 multibyte sequence + mid-SIXEL DCS: next session's UTF-8 decodes cleanly without U+FFFD.
  const fullEmoji = new TextEncoder().encode('🚀');
  writer.write('\x1bPq#0;2;0;0;0~-');
  writer.write(fullEmoji.subarray(0, 2)); // incomplete 4-byte UTF-8 sequence at disconnect
  writer.resetModes();
  writer.write(new TextEncoder().encode('\r\nfresh: 🚀'));
  await flushXterm(term);

  const rendered = Array.from({ length: 6 }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  assert.equal(rendered.includes('\uFFFD'), false);
  assert.equal(rendered.includes('fresh: 🚀'), true);
});

test('ghost suggestion key resolution uses Right Arrow to accept and lets Tab pass through to the shell (#42)', () => {
  const keyEvent = (key, overrides = {}) => ({
    key,
    type: 'keydown',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  // Tab and Shift+Tab must NEVER accept inline ghost suggestions; they dismiss the ghost and pass through to xterm/shell
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('Tab'), true), 'dismiss-passthrough');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('Tab', { shiftKey: true }), true), 'dismiss-passthrough');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('Tab'), false), 'passthrough');

  // Unmodified Right Arrow accepts when a suggestion is active, and passes through otherwise or on keyup
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('ArrowRight'), true), 'accept');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('ArrowRight'), false), 'passthrough');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('ArrowRight', { type: 'keyup' }), true), 'passthrough');

  // Modified Right Arrow (word jump / selection) dismisses the ghost and passes through instead of accepting
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('ArrowRight', { ctrlKey: true }), true), 'dismiss-passthrough');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('ArrowRight', { shiftKey: true }), true), 'dismiss-passthrough');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('ArrowRight', { metaKey: true }), true), 'dismiss-passthrough');

  // Escape consumes the event to dismiss the ghost without sending ESC to the shell
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('Escape'), true), 'dismiss-consume');
  assert.equal(resolveGhostSuggestionKeyAction(keyEvent('Escape'), false), 'passthrough');

  // Shell history/cursor navigation keys dismiss the ghost and pass through
  for (const navKey of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'Home', 'End']) {
    assert.equal(resolveGhostSuggestionKeyAction(keyEvent(navKey), true), 'dismiss-passthrough');
  }
});

test('mobile accessory ghost suggestion action accepts only on unmodified Right Arrow and passes Tab through (#42)', () => {
  // Tab on mobile accessory bar dismisses ghost and sends \t to remote shell
  assert.equal(resolveGhostAccessoryAction('\t', true, none), 'dismiss-passthrough');
  assert.equal(resolveGhostAccessoryAction('\t', false, none), 'passthrough');

  // Unmodified Right Arrow (normal and application cursor modes) accepts ghost suggestion
  assert.equal(resolveGhostAccessoryAction('\x1b[C', true, none), 'accept');
  assert.equal(resolveGhostAccessoryAction('\x1bOC', true, none), 'accept');
  assert.equal(resolveGhostAccessoryAction('\x1b[C', false, none), 'passthrough');

  // Latched CTRL or ALT + Right Arrow dismisses ghost and passes modified arrow to shell
  assert.equal(resolveGhostAccessoryAction('\x1b[C', true, ctrl), 'dismiss-passthrough');
  assert.equal(resolveGhostAccessoryAction('\x1b[C', true, alt), 'dismiss-passthrough');

  // Escape and other arrows dismiss ghost and pass through
  for (const seq of ['\x1b', '\x1b[A', '\x1b[B', '\x1b[D', '\x1bOA', '\x1b[H', '\x1b[F']) {
    assert.equal(resolveGhostAccessoryAction(seq, true, none), 'dismiss-passthrough');
  }
});

test('mobile IME deduplication prevents number/symbol + letter token duplication (7t, 77t, 56y, mt5-terminal, stev-4-pc)', () => {
  const simulateSequence = (events, defaultDelay = 150) => {
    let tracker = { fullText: '', time: 0 };
    let t = 1000;
    let output = '';
    for (const ev of events) {
      const data = typeof ev === 'string' ? ev : ev.data;
      const delay = typeof ev === 'string' ? defaultDelay : (ev.delay ?? defaultDelay);
      t += delay;
      const res = deduplicateMobileInput(data, tracker, t);
      output += res.toSend;
      tracker = res.updatedTracker;
    }
    return { output, tracker };
  };

  // 1. Single digit + letter: 7t -> 7t (not 77t)
  assert.equal(simulateSequence(['7', '7t']).output, '7t');

  // 2. Double digit + letter: 77t -> 77t (not 777t), both slow and fast (< 60ms)
  assert.equal(simulateSequence(['7', '7', '77t'], 150).output, '77t');
  assert.equal(simulateSequence(['7', '7', '77t'], 15).output, '77t');
  assert.equal(simulateSequence(['7', '77', '77t'], 15).output, '77t');

  // 3. Multi-digit + letter: 56y -> 56y (not 5656y)
  assert.equal(simulateSequence(['5', '6', '56y']).output, '56y');
  assert.equal(simulateSequence(['5', '6', '56y'], 15).output, '56y');

  // 4. Alphanumeric + hyphen + word: mt5-terminal -> mt5-terminal (not mt5-5-terminal)
  assert.equal(
    simulateSequence([
      'm', 'mt', '5', '-',
      '5-t', '5-te', '5-ter', '5-term', '5-termi', '5-termin', '5-termina', '5-terminal',
    ]).output,
    'mt5-terminal',
  );
  assert.equal(
    simulateSequence([
      'm', 'mt', '5', '5-',
      'mt5-t', 'mt5-te', 'mt5-ter', 'mt5-term', 'mt5-termi', 'mt5-termin', 'mt5-termina', 'mt5-terminal',
    ]).output,
    'mt5-terminal',
  );

  // 5. Hyphen + digit + hyphen + letters: stev-4-pc -> stev-4-pc (not stev-4-4-pc)
  assert.equal(
    simulateSequence(['s', 'st', 'ste', 'stev', '-', '4', '-', '4-p', '4-pc']).output,
    'stev-4-pc',
  );

  // 6. Destructive fast-typing regressions: repeated digits, flags, and paths at 0ms-15ms intervals MUST NEVER drop characters
  for (const fastDelay of [0, 10, 30, 150]) {
    assert.equal(simulateSequence([...'ssh 5522'], fastDelay).output, 'ssh 5522');
    assert.equal(simulateSequence([...'chmod 777'], fastDelay).output, 'chmod 777');
    assert.equal(simulateSequence([...'port 1000'], fastDelay).output, 'port 1000');
    assert.equal(simulateSequence([...'ls -ll'], fastDelay).output, 'ls -ll');
    assert.equal(simulateSequence([...'cd ../..'], fastDelay).output, 'cd ../..');
    assert.equal(simulateSequence(['c', 'd', ' ', '.', '..', '/', '.', '..'], fastDelay).output, 'cd ../..');
  }

  // 7. Shell-side / control key invalidation: Tab (\t), Enter (\r), and ESC sequences reset the token buffer
  // so typing `mt5-` -> TAB -> `5-t` never strips `5-` after Tab completion
  assert.equal(
    simulateSequence(['m', 't', '5', '-', '\t', '5-t']).output,
    'mt5-\t5-t',
  );
  assert.equal(
    simulateSequence(['m', 't', '5', '-', '\x1b[C', '5-t']).output,
    'mt5-\x1b[C5-t',
  );

  // 8. Backspace updates token buffer without losing remaining prefix
  assert.equal(
    simulateSequence(['5', '6', '7', '\x7f', '56y']).output,
    '567\x7f56y'.replace('567\x7f56y', '567\x7fy'),
  );
});




