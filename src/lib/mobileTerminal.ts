import { KittyGraphicsProcessor } from './kittyGraphics.ts';

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
export const TERMINAL_FONT_MIN = 4;
export const TERMINAL_FONT_MAX = 22;

/** Coerce an arbitrary font-size value into the supported whole-pixel range. */
export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_MIN;
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Wrapped Line Progress Bar Rewind
// ─────────────────────────────────────────────────────────────────────────────

export interface TerminalLike {
  cols?: number;
  write(data: string | Uint8Array, callback?: () => void): void;
  buffer: {
    active: {
      type: string;
      cursorX: number;
      cursorY: number;
      baseY: number;
      length: number;
      getLine(y: number): {
        isWrapped: boolean;
        translateToString?(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
      } | undefined;
    };
  };
}

/**
 * Strips ANSI escape sequences from a string to measure its printable character width.
 */
function visibleLength(text: string): number {
  const clean = text.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\].*?(?:\x07|\x1b\\)|[A-Za-z0-9=<>])/g, '');
  let len = 0;
  for (const _ch of clean) len++;
  return len;
}

/**
 * Replaces trailing padding spaces on standalone-`\r` progress lines with `\x1b[K`
 * (Erase in Line) so CLI tools that pad lines to 70-80 columns with spaces do not
 * needlessly wrap onto a blank second row on narrow mobile screens.
 */
function replaceTrailingSpacesWithEraseLine(part: string): string {
  if (!part || isCursorNavigationAfterCr(part) || isShellPromptLine(part)) return part;
  if (!part.includes('\n')) {
    if (/^[ ]+$/.test(part)) return '\x1b[K';
    return part.replace(/(?<=\S)[ ]+$/, '\x1b[K');
  }
  return part.replace(/^([^\r\n]*?\S)[ ]+(\r?\n)/, '$1\x1b[K$2');
}

/**
 * Detects whether the root row of a wrapped logical line is an interactive
 * shell prompt (e.g. `user@host:~$ `, `[user@host ~]$ `, `❯ `, `> `).
 * Wrapped commands being edited at a shell prompt must never be rewound/cleared
 * as if they were CLI progress bars.
 */
export function isShellPromptLine(text: string): boolean {
  if (!text) return false;
  // 1. user@host:path[$#%>] (standard Linux, macOS, bash, zsh)
  if (/^(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+[^$#%>]*[$#%>]\s/.test(text)) return true;
  // 2. Bracketed prompt: [user@host path]$ or (venv) [user@host path]#
  if (/^(?:\([^)]+\)\s*)?\[[^\]]+\]\s*[$#%>]\s/.test(text)) return true;
  // 3. Shell name or path prompt: bash-5.2$, sh-5.1#, ~/dir $, /etc #
  if (/^(?:\([^)]+\)\s*)?(?:(?:ba|z|da|k|c|tc|fi)?sh(?:-[0-9.]+)?|~|\/[a-zA-Z0-9_.\-/]*)[^$#%\r\n]{0,40}[$#%]\s/.test(text)) return true;
  // 4. PowerShell / Windows cmd prompt: PS C:\Users> or C:\Users>
  if (/^(?:PS\s+)?[A-Za-z]:\\[^>]*>\s*/.test(text)) return true;
  // 5. Multi-line box-drawing prompt (Kali, Arch, Starship): ┌── / └─❯
  if (/^[┌└╭╰─│]/.test(text)) return true;
  // 6. Modern prompt glyphs: ❯, ➜, λ, »
  if (/^.{0,64}[❯➜λ»]\s/.test(text)) return true;
  // 7. Bare prompt or secondary continuation prompt (PS2): "$ ", "# ", "% ", "> "
  if (/^[$#%>]\s/.test(text)) return true;
  return false;
}

/**
 * Detects whether text immediately following a standalone `\r` begins with an
 * ANSI/VT100 cursor-positioning sequence (as emitted by GNU Readline when
 * moving across wrapped command lines) rather than a line-overwrite progress update.
 */
export function isCursorNavigationAfterCr(afterCr: string): boolean {
  if (!afterCr) return false;
  return /^\x1b(?:\[\d*(?:;\d+)*[ABCDEFGHfsu]|M|7|8)/.test(afterCr);
}

/**
 * Counts how many rows above the cursor are wrapped continuation lines.
 * Returns 0 if the cursor is on the first row of a logical line, if the terminal
 * is in alternate screen buffer (e.g. htop, vim), or if the wrapped block starts
 * with an interactive shell prompt.
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
    if (count > 0) {
      const rootLine = buf.getLine(lineIdx);
      const rootText = rootLine?.translateToString?.(true) ?? '';
      if (isShellPromptLine(rootText)) return 0;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Streams terminal output while rewriting standalone Carriage Returns (`\r` without `\n`)
 * so that CLI progress bars (speedtest, curl, wget, npm, pip, docker) that wrap on narrow
 * mobile screens update in place instead of duplicating and scrolling down the terminal,
 * while never interfering with interactive shell command editing, pasting, or arrow navigation.
 */
export class SmartTerminalWriter {
  private term: TerminalLike;
  public kittyProcessor = new KittyGraphicsProcessor();
  private pendingCr = false;
  private decoder: TextDecoder | null = null;
  private editingPrompt = false;
  private suppressRewindUntil = 0;
  private inFlightWrappedRows: number | null = null;
  private inFlightCol = 0;
  private writeSeq = 0;

  constructor(term: TerminalLike) {
    this.term = term;
  }

  /**
   * Notifies the writer of user input so interactive prompt editing (typing,
   * pasting, arrow-key cursor movement, backspace) never triggers progress-bar
   * line rewinding, while submitting a command with Enter re-enables it.
   */
  notifyUserInput(data: string, isPaste = false) {
    if (!data) return;
    if (isPaste || data.startsWith('\x1b[200~')) {
      this.editingPrompt = true;
      this.suppressRewindUntil = Date.now() + 800;
      this._flushPlainCr();
      return;
    }
    if (data === '\x03' || data === '\x04' || data === '\x1a') {
      this.editingPrompt = true;
      this.suppressRewindUntil = Date.now() + 400;
      this._flushPlainCr();
      return;
    }
    if (data.endsWith('\r') || data.endsWith('\n')) {
      this.editingPrompt = false;
      this.suppressRewindUntil = 0;
      return;
    }
    this.editingPrompt = true;
    this.suppressRewindUntil = Date.now() + 800;
    this._flushPlainCr();
  }

  private _flushPlainCr() {
    if (this.pendingCr) {
      this.pendingCr = false;
      this.term.write('\r');
    }
  }

  write(data: string | Uint8Array) {
    let chunk = typeof data === 'string' ? data : (this.decoder ??= new TextDecoder()).decode(data);
    if (!chunk) return;

    // Filter and convert Kitty graphics protocol escape codes before terminal processing
    chunk = this.kittyProcessor.feed(chunk);
    if (!chunk) return;

    if (this.pendingCr) {
      this.pendingCr = false;
      chunk = '\r' + chunk;
    }

    if (this.editingPrompt || Date.now() < this.suppressRewindUntil) {
      this.term.write(chunk);
      return;
    }

    // Replace trailing padding spaces immediately before a standalone \r with \x1b[K
    if (chunk.includes('\r')) {
      chunk = chunk.replace(/(?<=\S)[ ]+(?=\r(?!\n))/g, '\x1b[K');
    }

    while (chunk.endsWith('\r')) {
      this.pendingCr = true;
      chunk = chunk.slice(0, -1);
    }
    if (!chunk) return;

    if (!chunk.includes('\r')) {
      this._writeTracked(chunk, false);
      if (this.term.write.length < 2) this.inFlightWrappedRows = null;
      return;
    }

    const parts = chunk.split(/\r(?!\n)/);
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      if (i > 0) {
        // Collapse consecutive standalone CRs (`\r\r`) so we only rewind once
        if (part.length === 0 && i < parts.length - 1) continue;
        this._emitStandaloneCR(part);
        part = replaceTrailingSpacesWithEraseLine(part);
      }
      if (part.length > 0) {
        this._writeTracked(part, i > 0);
      }
    }
    if (this.term.write.length < 2) {
      this.inFlightWrappedRows = null;
    }
  }

  private _writeTracked(part: string, afterStandaloneCr: boolean) {
    const cols = this.term.cols ?? 0;
    if (cols > 0) {
      if (part.includes('\n')) {
        const afterLastNewline = part.slice(part.lastIndexOf('\n') + 1);
        this.inFlightCol = visibleLength(afterLastNewline);
        this.inFlightWrappedRows = this.inFlightCol > cols ? Math.floor((this.inFlightCol - 1) / cols) : 0;
      } else if (afterStandaloneCr) {
        this.inFlightCol = visibleLength(part);
        this.inFlightWrappedRows = this.inFlightCol > cols ? Math.floor((this.inFlightCol - 1) / cols) : 0;
      } else if (this.inFlightWrappedRows !== null) {
        this.inFlightCol += visibleLength(part);
        this.inFlightWrappedRows = this.inFlightCol > cols ? Math.floor((this.inFlightCol - 1) / cols) : 0;
      }
    }

    if (this.term.write.length >= 2) {
      const seq = ++this.writeSeq;
      this.term.write(part, () => {
        if (this.writeSeq === seq) {
          this.inFlightWrappedRows = null;
        }
      });
    } else {
      this.term.write(part);
    }
  }

  private _emitStandaloneCR(nextText = '') {
    if (isCursorNavigationAfterCr(nextText) || isShellPromptLine(nextText)) {
      this.term.write('\r');
      return;
    }
    const wrapped = this.inFlightWrappedRows !== null
      ? this.inFlightWrappedRows
      : getWrappedRowsAbove(this.term);
    this.inFlightWrappedRows = 0;
    this.inFlightCol = 0;
    if (wrapped > 0) {
      if (this.term.write.length >= 2) {
        const seq = ++this.writeSeq;
        this.term.write(`\x1b[${wrapped}A\r\x1b[J`, () => {
          if (this.writeSeq === seq) {
            this.inFlightWrappedRows = null;
          }
        });
      } else {
        this.term.write(`\x1b[${wrapped}A\r\x1b[J`);
      }
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
    this.pendingCr = false;
    this.inFlightWrappedRows = null;
    this.kittyProcessor.reset();
  }
}
