export interface TerminalModifiers { ctrl: boolean; alt: boolean }

export function isTerminalModifierKey(data: string): boolean {
  return data.length === 1 || /^\x1b[\[O][ABCD]$/.test(data);
}

/** One-shot modifiers apply to a single key, never to a multi-character paste. */
export function modifiedTerminalInput(data: string, modifiers: TerminalModifiers): string {
  if (!isTerminalModifierKey(data)) return data;
  if (data.length > 1) {
    const code = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
    return code === 1 ? data : `\x1b[1;${code}${data[data.length - 1]}`;
  }
  let result = data;
  if (modifiers.ctrl) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) result = String.fromCharCode(code & 31);
    else if (data === ' ') result = '\0';
    else if (data === '?') result = '\x7f';
  }
  return modifiers.alt ? `\x1b${result}` : result;
}

export const accessoryKeys = [
  ['ESC', '\x1b'], ['TAB', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'], ['|', '|'], ['/', '/'], ['~', '~'], ['-', '-'],
] as const;

export const scrollableAccessoryKeys = [
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['^C', '\x03'],
  ['←', '\x1b[D'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['→', '\x1b[C'],
  ['/', '/'],
  ['-', '-'],
  ['|', '|'],
  ['~', '~'],
  [':', ':'],
  ['\\', '\\'],
  ['`', '`'],
  ['_', '_'],
  ['$', '$'],
  ['^D', '\x04'],
  ['^Z', '\x1a'],
] as const;

export const keyPaletteGroups = [
  {
    title: 'tmux / screen shortcuts',
    keys: [
      { label: 'ctrl+b, %', data: '\x02%' },
      { label: 'ctrl+b, "', data: '\x02"' },
      { label: 'ctrl+b, o', data: '\x02o' },
      { label: 'ctrl+b, x', data: '\x02x' },
      { label: 'ctrl+b, c', data: '\x02c' },
      { label: 'ctrl+b, n', data: '\x02n' },
      { label: 'ctrl+b, [', data: '\x02[' },
      { label: 'ctrl+b, d', data: '\x02d' },
    ],
  },
  {
    title: 'Navigation & Editing',
    keys: [
      { label: 'home', data: '\x1b[H' },
      { label: 'end', data: '\x1b[F' },
      { label: 'pgUp', data: '\x1b[5~' },
      { label: 'pgDn', data: '\x1b[6~' },
      { label: 'ins', data: '\x1b[2~' },
      { label: 'del', data: '\x1b[3~' },
    ],
  },
  {
    title: 'Function Keys',
    keys: [
      { label: 'F1', data: '\x1bOP' },
      { label: 'F2', data: '\x1bOQ' },
      { label: 'F3', data: '\x1bOR' },
      { label: 'F4', data: '\x1bOS' },
      { label: 'F5', data: '\x1b[15~' },
      { label: 'F6', data: '\x1b[17~' },
      { label: 'F7', data: '\x1b[18~' },
      { label: 'F8', data: '\x1b[19~' },
      { label: 'F9', data: '\x1b[20~' },
      { label: 'F10', data: '\x1b[21~' },
      { label: 'F11', data: '\x1b[23~' },
      { label: 'F12', data: '\x1b[24~' },
    ],
  },
  {
    title: 'Brackets & Symbols',
    keys: [
      { label: '{', data: '{' },
      { label: '}', data: '}' },
      { label: '[', data: '[' },
      { label: ']', data: ']' },
      { label: '(', data: '(' },
      { label: ')', data: ')' },
      { label: '<', data: '<' },
      { label: '>', data: '>' },
      { label: '"', data: '"' },
      { label: "'", data: "'" },
      { label: ';', data: ';' },
      { label: ':', data: ':' },
      { label: '?', data: '?' },
      { label: '&', data: '&' },
      { label: '*', data: '*' },
      { label: '+', data: '+' },
      { label: '=', data: '=' },
      { label: '#', data: '#' },
      { label: '@', data: '@' },
      { label: '%', data: '%' },
      { label: '^', data: '^' },
      { label: '!', data: '!' },
    ],
  },
];

/** Terminal font-size bounds shared by the desktop stepper and the phone pinch gesture. */
export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;

// ─────────────────────────────────────────────────────────────────────────────
// Smart Wrapped Line Progress Bar Rewind
// ─────────────────────────────────────────────────────────────────────────────

export interface TerminalLike {
  write(data: string | Uint8Array): void;
  buffer: {
    active: {
      type: string;
      cursorX: number;
      cursorY: number;
      baseY: number;
      length: number;
      getLine(y: number): { isWrapped: boolean } | undefined;
    };
  };
}

/**
 * Counts how many rows above the cursor are wrapped continuation lines.
 * Returns 0 if the cursor is on the first row of a logical line, or if the terminal
 * is in alternate screen buffer (e.g. htop, vim).
 */
export function getWrappedRowsAbove(term: TerminalLike): number {
  try {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return 0;
    let count = 0;
    let lineIdx = buf.baseY + buf.cursorY;
    while (lineIdx > 0 && lineIdx < buf.length) {
      const line = buf.getLine(lineIdx);
      if (!line || !line.isWrapped) break;
      count++;
      lineIdx--;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Streams terminal output while rewriting standalone Carriage Returns (`\r` without `\n`)
 * so that CLI progress bars (speedtest, curl, wget, npm, pip, docker) that wrap on narrow
 * mobile screens update in place instead of duplicating and scrolling down the terminal.
 */
export class SmartTerminalWriter {
  private term: TerminalLike;
  private pendingCr = false;
  private crTimer: ReturnType<typeof setTimeout> | null = null;
  private decoder: TextDecoder | null = null;

  constructor(term: TerminalLike) {
    this.term = term;
  }

  write(data: string | Uint8Array) {
    let chunk = typeof data === 'string' ? data : (this.decoder ??= new TextDecoder()).decode(data);
    if (this.crTimer) {
      clearTimeout(this.crTimer);
      this.crTimer = null;
    }

    if (this.pendingCr) {
      this.pendingCr = false;
      if (chunk.startsWith('\n')) {
        this.term.write('\r\n' + chunk.slice(1));
        return;
      } else {
        this._emitStandaloneCR();
      }
    }

    if (chunk.endsWith('\r')) {
      this.pendingCr = true;
      chunk = chunk.slice(0, -1);
      this.crTimer = setTimeout(() => this.flush(), 25);
      if (!chunk) return;
    }

    if (!chunk.includes('\r')) {
      this.term.write(chunk);
      return;
    }

    const parts = chunk.split(/\r(?!\n)/);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        this._emitStandaloneCR();
      }
      if (parts[i].length > 0) {
        this.term.write(parts[i]);
      }
    }
  }

  private _emitStandaloneCR() {
    const wrapped = getWrappedRowsAbove(this.term);
    if (wrapped > 0) {
      this.term.write(`\x1b[${wrapped}A\r\x1b[J`);
    } else {
      this.term.write('\r');
    }
  }

  flush() {
    if (this.pendingCr) {
      this.pendingCr = false;
      this._emitStandaloneCR();
    }
  }

  dispose() {
    if (this.crTimer) {
      clearTimeout(this.crTimer);
      this.crTimer = null;
    }
  }
}
