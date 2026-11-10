import { KittyGraphicsProcessor } from './kittyGraphics.ts';

export interface TerminalModifiers { ctrl: boolean; alt: boolean }

export interface MobileInputTracker {
  fullText: string;
  time: number;
}

/**
 * Deduplicates mobile soft-keyboard (IME) cumulative token re-emissions.
 *
 * On mobile keyboards (such as Samsung Keyboard and Gboard on Android), typing
 * numbers and punctuation emits individual single-character events (e.g. "7" then "7",
 * "5" then "6", or "5" then "-"), and then typing a following letter causes the IME
 * to bundle the preceding token characters together with the new letter into a
 * multi-character composition string (e.g. "77t", "56y", "5-t", or "4-p").
 *
 * Because terminal input is streamed immediately to the PTY as each key is pressed,
 * re-sending the preceding token characters duplicates them (e.g. "77" + "77t" = "777t",
 * "56" + "56y" = "5656y", "mt5-" + "5-t" = "mt5-5-t").
 *
 * Design invariants to prevent keystroke loss:
 * 1. Single-character inputs (`data.length === 1`) are NEVER dropped, regardless of
 *    typing speed (preserving fast repeated digits/flags like `5522`, `777`, `1000`, `ls -ll`).
 * 2. Control characters (`\t`, `\r`, `\n`, `\x1b`, etc.) and whitespace reset the
 *    tracked token buffer so shell completions (`Tab`) or line edits never corrupt
 *    subsequent input.
 * 3. Multi-character IME strings (`data.length > 1`) only strip a strict prefix
 *    (`overlapLen <= data.length - 1`) matching a suffix of `sentBuffer`, so a
 *    printable input event is never swallowed into an empty string.
 */
export function deduplicateMobileInput(
  data: string,
  tracker: MobileInputTracker,
  now: number = Date.now(),
): { toSend: string; updatedTracker: MobileInputTracker } {
  if (!data) {
    return { toSend: '', updatedTracker: tracker };
  }

  const sentBuffer = tracker.fullText;

  // Backspace slices the last character from the tracked token buffer
  if (data === '\x7f' || data === '\x08') {
    return {
      toSend: data,
      updatedTracker: { fullText: sentBuffer.slice(0, -1), time: now },
    };
  }

  // Control characters (Tab, Enter, ESC sequences, Ctrl combos) or single space
  // invalidate the token buffer and pass through untouched
  if (data === ' ' || /[\x00-\x1f\x7f]/.test(data)) {
    return {
      toSend: data,
      updatedTracker: { fullText: '', time: now },
    };
  }

  // Multi-character cumulative IME / token re-emission overlap detection:
  // Find the longest strict prefix of `data` (`1 <= len < data.length`) that matches
  // a suffix of `sentBuffer`
  // (e.g. sentBuffer="77" + data="77t" -> overlap="77" -> toSend="t";
  //  sentBuffer="56" + data="56y" -> overlap="56" -> toSend="y";
  //  sentBuffer="mt5-" + data="5-t" -> overlap="5-" -> toSend="t").
  let toSend = data;
  if (sentBuffer && data.length > 1) {
    const maxOverlap = Math.min(sentBuffer.length, data.length - 1);
    let overlapLen = 0;
    for (let len = maxOverlap; len >= 1; len--) {
      if (sentBuffer.endsWith(data.slice(0, len))) {
        overlapLen = len;
        break;
      }
    }
    if (overlapLen > 0) {
      toSend = data.slice(overlapLen);
    }
  }

  // Append newly sent characters to the current token buffer, resetting past any space
  let nextBuffer = sentBuffer + toSend;
  const lastSpaceIdx = nextBuffer.lastIndexOf(' ');
  if (lastSpaceIdx !== -1) {
    nextBuffer = nextBuffer.slice(lastSpaceIdx + 1);
  }

  return {
    toSend,
    updatedTracker: { fullText: nextBuffer, time: now },
  };
}

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

export type GhostSuggestionKeyAction =
  | 'accept'
  | 'dismiss-consume'
  | 'dismiss-passthrough'
  | 'passthrough';

/**
 * Decides how a desktop keyboard event interacts with an active inline ghost suggestion.
 * `Tab` never accepts inline ghost suggestions so native shell Tab completion (such as
 * `cd <Tab>` on remote Linux shells) always reaches the PTY and never steals terminal focus.
 */
export function resolveGhostSuggestionKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'type' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>,
  hasSuggestion: boolean,
): GhostSuggestionKeyAction {
  if (!hasSuggestion || event.type !== 'keydown') return 'passthrough';

  const hasModifier = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;

  if (event.key === 'ArrowRight') {
    return hasModifier ? 'dismiss-passthrough' : 'accept';
  }

  if (event.key === 'Escape' && !hasModifier) {
    return 'dismiss-consume';
  }

  if (
    event.key === 'Tab' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'ArrowLeft' ||
    event.key === 'Home' ||
    event.key === 'End'
  ) {
    return 'dismiss-passthrough';
  }

  return 'passthrough';
}

/**
 * Decides how a mobile accessory-bar key press interacts with an active inline ghost suggestion.
 * Only unmodified Right Arrow accepts; Tab and navigation keys dismiss the ghost and pass through to the shell.
 */
export function resolveGhostAccessoryAction(
  data: string,
  hasSuggestion: boolean,
  modifiers: TerminalModifiers,
): 'accept' | 'dismiss-passthrough' | 'passthrough' {
  if (!hasSuggestion) return 'passthrough';

  const isRightArrow = data === '\x1b[C' || data === '\x1bOC';
  if (isRightArrow && !modifiers.ctrl && !modifiers.alt) {
    return 'accept';
  }

  if (data === '\t' || data === '\x1b' || /^\x1b(\[|O)[ABCDHF]$/.test(data)) {
    return 'dismiss-passthrough';
  }

  return 'passthrough';
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
    normal?: {
      cursorX: number;
      cursorY: number;
    };
  };
}

/**
 * Undo the input/render modes a full-screen TUI (neovim, claude, htop, less, tmux…) leaves enabled
 * when its session dies without sending teardown sequences. Without this, xterm.js keeps reporting
 * mouse moves, focus changes, and app-mode cursor keys into the *next* shell, which echoes them as
 * junk such as `65;133;35M` or `^[[I`.
 *
 * NOTE: Alternate-screen exit (`\x1b[?1049l` / `\x1b[?1047l`) is intentionally omitted here and
 * emitted conditionally by `SmartTerminalWriter.resetModes()` only while the alternate buffer is
 * active: in xterm.js, sending `\x1b[?1049l` while already in the normal buffer unconditionally
 * invokes `restoreCursor()`, jumping the cursor to `savedY` (row 0 after `DECSTR`) and overwriting
 * prior viewport output. Scrollback is preserved (no RIS `\x1bc`).
 */
export const TERMINAL_MODE_RESET =
  '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' + // mouse tracking protocols
  '\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l' + // mouse coordinate encodings & alt-scroll
  '\x1b[?1004l' + // focus in/out reporting
  '\x1b[?2004l' + // bracketed paste
  '\x1b[?2026l' + // synchronized output (also flushes held row refresh)
  '\x1b[<99u\x1b[=0u' + // kitty keyboard protocol stack pop + flags reset (ignored if unsupported)
  '\x1b[>4;0m\x1b[>4m' + // xterm modifyOtherKeys off (ignored if unsupported)
  '\x1b]8;;\x07' + // close any unterminated OSC 8 hyperlink
  '\x1b[!p' + // DECSTR: cursor/keypad modes, SGR, charsets, scroll region, wraparound, origin, insert
  '\x1b[?25h' + // show cursor
  '\x1b[0 q'; // reset DECSCUSR cursor shape override to user default

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
 * Strips ANSI escape sequences and OSC escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[\(\)][A-Za-z0-9]|M|7|8|[A-Za-z0-9=<>])/g, '');
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
    return part.replace(/(?<=\S)[ ]{2,}$/, '\x1b[K');
  }
  return part.replace(/^([^\r\n]*?\S)[ ]{2,}(\r?\n)/, '$1\x1b[K$2');
}

/**
 * Detects whether the root row of a wrapped logical line is an interactive
 * shell prompt (e.g. `user@host:~$ `, `[user@host ~]$ `, `❯ `, `> `).
 * Wrapped commands being edited at a shell prompt must never be rewound/cleared
 * as if they were CLI progress bars.
 */
export function isShellPromptLine(text: string): boolean {
  if (!text) return false;
  const clean = stripAnsi(text).trimStart();
  if (!clean) return false;
  // 1. user@host:path[$#%>] (standard Linux, macOS, bash, zsh)
  if (/^(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+[^$#%>]*[$#%>](?:\s|$)/.test(clean)) return true;
  // 2. Bracketed prompt: [user@host path]$ or (venv) [user@host path]#
  if (/^(?:\([^)]+\)\s*)?\[[^\]]+\]\s*[$#%>](?:\s|$)/.test(clean)) return true;
  // 3. Shell name or path prompt: bash-5.2$, sh-5.1#, ~/dir $, /etc #
  if (/^(?:\([^)]+\)\s*)?(?:(?:ba|z|da|k|c|tc|fi)?sh(?:-[0-9.]+)?|~|\/[a-zA-Z0-9_.\-/]*)[^$#%\r\n]{0,60}[$#%](?:\s|$)/.test(clean)) return true;
  // 4. PowerShell / Windows cmd prompt: PS C:\Users> or C:\Users>
  if (/^(?:PS\s+)?[A-Za-z]:\\[^>]*>\s*/.test(clean)) return true;
  // 5. Multi-line box-drawing prompt (Kali, Arch, Starship): ┌── / └─❯
  if (/^[┌└╭╰─│]/.test(clean)) return true;
  // 6. Modern prompt glyphs: ❯, ➜, λ, »
  if (/^.{0,64}[❯➜λ»](?:\s|$)/.test(clean)) return true;
  // 7. Bare prompt or secondary continuation prompt (PS2): "$ ", "# ", "% ", "> "
  if (/^[$#%>]\s/.test(clean)) return true;
  // 8. General prompt ending with prompt sigil and whitespace (excluding percentages like 89%)
  if (!/\d+%/.test(clean) && /(?:^|[\s)\]:~])[$#%>]\s+$/.test(clean)) return true;
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
  private alternateScreen = false;
  private alternateSavedCursor = false;
  private cursorSavedInNormal = false;
  private pendingAltExit = false;
  private modeSequenceTail = '';
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

  /**
   * Track DEC alternate-screen mode switches before xterm parses the chunk. PTY reads
   * are arbitrary byte slices, so keep a short tail to recognize a CSI sequence split
   * across two writes. Rewriting carriage returns inside a full-screen TUI changes its
   * cursor semantics and can leave visual artifacts behind.
   */
  private updateAlternateScreenMode(chunk: string): boolean {
    const combined = this.modeSequenceTail + chunk;
    const modeChanges = /\x1b(?:\[\?([0-9;]+)([hl])|(7)|(\[s)|(\[!p))/g;
    let match: RegExpExecArray | null;
    let sawAlternateSwitch = false;
    while ((match = modeChanges.exec(combined)) !== null) {
      if (match[3] || match[4]) {
        if (!this.alternateScreen) this.cursorSavedInNormal = true;
        continue;
      }
      if (match[5]) {
        this.cursorSavedInNormal = false;
        continue;
      }
      const enabling = match[2] === 'h';
      const modes = match[1].split(';').map(Number);
      for (const mode of modes) {
        if (mode === 1048 && enabling && !this.alternateScreen) {
          this.cursorSavedInNormal = true;
        } else if (mode === 47 || mode === 1047 || mode === 1049) {
          sawAlternateSwitch = true;
          if (enabling) {
            if (!this.alternateScreen) {
              this.alternateSavedCursor = mode === 1049 || this.cursorSavedInNormal;
            }
            this.alternateScreen = true;
            this.pendingAltExit = false;
          } else {
            this.alternateScreen = false;
            this.alternateSavedCursor = false;
            this.pendingAltExit = false;
          }
        }
      }
    }
    // Retain only an unfinished escape / private-mode CSI prefix, not completed commands;
    // otherwise a recent enter/exit sequence would be replayed as a fresh switch
    // on every following PTY chunk while it remained in the rolling tail.
    this.modeSequenceTail = combined.match(/\x1b(?:\[\?[0-9;]*|\[!?|)$/)?.[0].slice(-64) ?? '';
    return sawAlternateSwitch;
  }

  write(data: string | Uint8Array) {
    // Keep incomplete UTF-8 sequences between PTY reads. SSH/local-PTY reads do not
    // align to character boundaries; decoding each byte chunk independently silently
    // replaces split Unicode TUI glyphs (Braille, box drawing, emoji) with U+FFFD.
    let chunk = typeof data === 'string' ? data : (this.decoder ??= new TextDecoder()).decode(data, { stream: true });
    if (!chunk) return;

    // Filter and convert Kitty graphics protocol escape codes before terminal processing
    chunk = this.kittyProcessor.feed(chunk);
    if (!chunk) return;

    if (this.pendingCr) {
      this.pendingCr = false;
      chunk = '\r' + chunk;
    }

    const switchedAlternateScreen = this.updateAlternateScreenMode(chunk);
    const activeBufferIsAlternate = !this.pendingAltExit && this.term.buffer.active.type === 'alternate';
    if (this.alternateScreen || activeBufferIsAlternate || switchedAlternateScreen) {
      // This writer's wrapped-progress-bar workaround is only safe in the normal
      // scrollback buffer. Full-screen TUIs own cursor addressing and CR behavior.
      this.inFlightWrappedRows = null;
      this.inFlightCol = 0;
      this.term.write(chunk);
      return;
    }

    if (this.editingPrompt || Date.now() < this.suppressRewindUntil) {
      this.term.write(chunk);
      return;
    }

    // Replace trailing padding spaces (>= 2 spaces) on non-prompt lines immediately before a standalone \r with \x1b[K
    if (chunk.includes('\r') && !isShellPromptLine(chunk)) {
      chunk = chunk.replace(/(?<=\S)[ ]{2,}(?=\r(?!\n))/g, '\x1b[K');
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

  /**
   * Resets stale TUI modes (mouse tracking, focus reporting, bracketed paste, synchronized
   * output, keyboard protocols, charsets, SGR, scroll margins, alternate screen) and discards
   * any incomplete mid-stream UTF-8 / Kitty APC / escape state left behind by a dropped link.
   *
   * Idempotent across repeated calls (e.g. disconnect followed by reconnect): `\x1b[?1049l` is
   * emitted only when actually leaving the alternate screen so normal-buffer cursor coordinates
   * and scrollback history are never overwritten.
   */
  resetModes() {
    const wasAltTracked = this.alternateScreen;
    const hadSavedCursor = this.alternateSavedCursor;
    const alreadyExitingAlt = this.pendingAltExit;

    // Discard incomplete stream state from the dead session rather than calling `flush()`,
    // which would treat a split `\r\n` at EOF as a standalone progress-bar CR and `\x1b[J`
    // erase wrapped lines above the cursor.
    this.pendingCr = false;
    this.inFlightWrappedRows = null;
    this.inFlightCol = 0;
    this.editingPrompt = false;
    this.suppressRewindUntil = 0;
    this.alternateScreen = false;
    this.alternateSavedCursor = false;
    this.cursorSavedInNormal = false;
    this.modeSequenceTail = '';
    this.decoder = null;
    this.kittyProcessor.reset();

    const bufIsAlt = !alreadyExitingAlt && this.term.buffer.active.type === 'alternate';
    const shouldExitAlt = wasAltTracked || bufIsAlt;
    let altExit = '';
    if (shouldExitAlt) {
      if (hadSavedCursor || !wasAltTracked) {
        altExit = '\x1b[?1049l';
      } else if (this.term.buffer.active.type === 'alternate' && this.term.buffer.normal) {
        const nx = Math.max(0, this.term.buffer.normal.cursorX) + 1;
        const ny = Math.max(0, this.term.buffer.normal.cursorY) + 1;
        altExit = `\x1b[?6l\x1b[${ny};${nx}H\x1b[?1047l\x1b[?47l`;
      } else {
        altExit = '\x1b[?1047l\x1b[?47l';
      }
    }

    // Prefix `\x18` (CAN) so xterm's VT500 parser aborts any half-transmitted CSI, OSC,
    // DCS/SIXEL, or APC sequence from the dead stream before parsing the mode resets.
    const payload = '\x18' + altExit + TERMINAL_MODE_RESET;
    if (shouldExitAlt && this.term.write.length >= 2) {
      this.pendingAltExit = true;
      this.term.write(payload, () => {
        if (!this.alternateScreen) {
          this.pendingAltExit = false;
        }
      });
    } else {
      this.pendingAltExit = false;
      this.term.write(payload);
    }
  }

  dispose() {
    this.pendingCr = false;
    this.inFlightWrappedRows = null;
    this.inFlightCol = 0;
    this.editingPrompt = false;
    this.suppressRewindUntil = 0;
    this.alternateScreen = false;
    this.alternateSavedCursor = false;
    this.cursorSavedInNormal = false;
    this.pendingAltExit = false;
    this.modeSequenceTail = '';
    this.decoder = null;
    this.kittyProcessor.reset();
  }
}
