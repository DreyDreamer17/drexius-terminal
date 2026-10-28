import assert from 'node:assert/strict';
import test from 'node:test';
import { accessoryKeys, isTerminalModifierKey, modifiedTerminalInput, getWrappedRowsAbove, SmartTerminalWriter } from '../src/lib/mobileTerminal.ts';
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


