/**
 * terminalInput.ts — Pure Alt / macOS Option-as-Meta key resolution and
 * Readline argument helpers for DrexiusTerminal.
 *
 * Solves cross-platform Meta/Alt key handling (e.g. `Alt+.` yank-last-arg,
 * `Alt+B`/`Alt+F` word movement, `Alt+D`/`Alt+Backspace` word kill,
 * `Alt+0..9` numeric repeat, `Alt+<`/`Alt+>` history bounds):
 *
 * - On macOS: bypasses Option symbol composition (`Option+.` -> `≥`,
 *   `Option+b` -> `∫`, dead keys `Option+e/u/i/n/\``, `Option+Space` -> NBSP)
 *   using physical `event.code` + `event.shiftKey`, with configurable
 *   `'both' | 'left' | 'right' | 'off'` modes (matching Ghostty / iTerm2).
 * - On Linux & Windows: uses layout-accurate printable ASCII `event.key`
 *   (supporting US, ISO, AZERTY, QWERTZ, Dvorak, and NumpadDecimal) while
 *   never hijacking `AltGraph` or Windows `Ctrl+Alt` third-level shift.
 */

export type OptionAsMetaMode = 'both' | 'left' | 'right' | 'off';

export const OPTION_AS_META_MODES: readonly OptionAsMetaMode[] = ['both', 'left', 'right', 'off'] as const;

export function normalizeOptionAsMetaMode(value: unknown): OptionAsMetaMode {
  if (value === 'both' || value === 'left' || value === 'right' || value === 'off') {
    return value;
  }
  return 'both';
}

export interface AltSidesState {
  left: boolean;
  right: boolean;
}

export interface KeyEventLike {
  type?: string;
  key: string;
  code?: string;
  location?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  getModifierState?: (keyArg: string) => boolean;
}

export interface AltMetaContext {
  isMac: boolean;
  optionAsMeta: OptionAsMetaMode;
  altSides: AltSidesState;
}

const MODIFIER_ONLY_KEYS = new Set([
  'Alt',
  'AltGraph',
  'Shift',
  'Control',
  'Meta',
  'OS',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
]);

/** Physical US-ANSI punctuation & digit shift pairs for macOS Option-as-Meta decoding. */
const MAC_CODE_MAP: Record<string, readonly [string, string]> = {
  Digit0: ['0', ')'],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Backquote: ['`', '~'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  IntlBackslash: ['\\', '|'],
};

const NUMPAD_CHAR_MAP: Record<string, string> = {
  Numpad0: '0',
  Numpad1: '1',
  Numpad2: '2',
  Numpad3: '3',
  Numpad4: '4',
  Numpad5: '5',
  Numpad6: '6',
  Numpad7: '7',
  Numpad8: '8',
  Numpad9: '9',
  NumpadDecimal: '.',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
};

/**
 * Pure state transition tracking which physical Alt/Option side(s) are held.
 * Self-heals if a keyup was missed across an OS window switch (`!event.altKey`).
 */
export function updateAltSidesFromKeyEvent(
  state: AltSidesState,
  event: Pick<KeyEventLike, 'type' | 'key' | 'code' | 'location' | 'altKey'>,
): AltSidesState {
  const isLeft = event.code === 'AltLeft' || (event.key === 'Alt' && event.location === 1);
  const isRight = event.code === 'AltRight' || (event.key === 'Alt' && event.location === 2);

  if (event.type === 'keydown') {
    if (isLeft) return { left: true, right: state.right };
    if (isRight) return { left: state.left, right: true };
    if (!event.altKey && (state.left || state.right)) {
      return { left: false, right: false };
    }
    return state;
  }

  if (event.type === 'keyup') {
    if (isLeft) return { left: false, right: state.right };
    if (isRight) return { left: state.left, right: false };
    if (!event.altKey && (state.left || state.right)) {
      return { left: false, right: false };
    }
    return state;
  }

  return state;
}

/**
 * Returns true if the current Alt/Option modifier should act as terminal Meta (ESC prefix)
 * rather than native OS character composition (macOS special chars or Windows/Linux AltGr).
 */
export function shouldTreatAltAsMeta(event: KeyEventLike, ctx: AltMetaContext): boolean {
  if (!event.altKey || event.metaKey) return false;
  if (MODIFIER_ONLY_KEYS.has(event.key)) return false;

  // Never hijack AltGraph (international 3rd-level shift on Linux/Windows keyboards).
  if (!ctx.isMac) {
    if (event.getModifierState?.('AltGraph')) return false;
    // On Windows/Linux, Ctrl+Alt is frequently AltGr (e.g. @, {, }, [, ], \),
    // and non-AltGr Ctrl+Alt combos are handled by xterm or workspace shortcuts.
    if (event.ctrlKey) return false;
    return true;
  }

  // macOS Option-as-Meta policy
  switch (ctx.optionAsMeta) {
    case 'off':
      return false;
    case 'both':
      return true;
    case 'left':
      return ctx.altSides.left;
    case 'right':
      return ctx.altSides.right;
  }
}

function isPrintableAscii(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

function resolveMacBaseChar(event: KeyEventLike): string | null {
  const code = event.code || '';

  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    if (event.ctrlKey) {
      return String.fromCharCode(letter.charCodeAt(0) - 64);
    }
    return event.shiftKey ? letter : letter.toLowerCase();
  }

  if (code in MAC_CODE_MAP) {
    const [unshifted, shifted] = MAC_CODE_MAP[code];
    return event.shiftKey ? shifted : unshifted;
  }

  if (code in NUMPAD_CHAR_MAP) {
    return NUMPAD_CHAR_MAP[code];
  }

  if (isPrintableAscii(event.key)) {
    return event.key;
  }

  return null;
}

/**
 * Resolves a `keydown` event with Alt/Option held into its VT/Readline ESC-prefixed
 * terminal sequence, or returns `null` to let xterm.js handle the event natively
 * (for example, CSI arrow/navigation/F-key sequences or disabled Option-as-Meta).
 */
export function resolveAltMetaSequence(event: KeyEventLike, ctx: AltMetaContext): string | null {
  if (event.type && event.type !== 'keydown') return null;
  if (!shouldTreatAltAsMeta(event, ctx)) return null;

  const code = event.code || '';
  const key = event.key;

  // Special non-printable editing keys with standard ESC-prefixed Meta bindings
  if (key === 'Backspace' || code === 'Backspace') {
    return event.ctrlKey ? '\x1b\x08' : '\x1b\x7f';
  }
  if (key === 'Enter' || code === 'Enter' || code === 'NumpadEnter') {
    return '\x1b\r';
  }
  if (key === 'Escape' || code === 'Escape') {
    return '\x1b\x1b';
  }
  if (key === 'Tab' || code === 'Tab') {
    return '\x1b\t';
  }
  if (code === 'Space' || key === ' ' || key === '\u00a0') {
    return event.ctrlKey ? '\x1b\x00' : '\x1b ';
  }
  if (key === 'Delete' || code === 'Delete') {
    return event.shiftKey ? '\x1b[3;4~' : '\x1b[3;3~';
  }

  // Let xterm.js handle arrows, navigation keys (Home/End/PgUp/PgDn/Insert), and F1-F12 natively.
  if (
    key.startsWith('Arrow') ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown' ||
    key === 'Insert' ||
    /^F([1-9]|1[0-2])$/.test(key)
  ) {
    return null;
  }

  if (ctx.isMac) {
    const ch = resolveMacBaseChar(event);
    return ch !== null ? `\x1b${ch}` : null;
  }

  // Linux & Windows: prefer layout-accurate printable ASCII from `event.key` so non-US
  // layouts (AZERTY, QWERTZ, Dvorak, etc.) send the exact character printed on the key.
  if (isPrintableAscii(key)) {
    return `\x1b${key}`;
  }

  // Fallback for numpad or dead-key codes on non-Mac layouts
  if (code in NUMPAD_CHAR_MAP) {
    return `\x1b${NUMPAD_CHAR_MAP[code]}`;
  }
  if (code in MAC_CODE_MAP) {
    const [unshifted, shifted] = MAC_CODE_MAP[code];
    return `\x1b${event.shiftKey ? shifted : unshifted}`;
  }
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return `\x1b${event.shiftKey ? letter : letter.toLowerCase()}`;
  }

  return null;
}

/**
 * Returns true if a follow-up `keypress` event for an intercepted Alt/Option-as-Meta
 * keystroke should be swallowed so WebViews cannot also insert a composed Unicode char
 * (e.g. `≥` on macOS Option+.).
 */
export function shouldSwallowAltKeypress(event: KeyEventLike, ctx: AltMetaContext): boolean {
  if (event.type !== 'keypress') return false;
  return shouldTreatAltAsMeta(event, ctx);
}

/**
 * Extracts the last shell argument token from a command string for Readline
 * `yank-last-arg` (`Alt+.`) emulation in the browser preview DemoShell.
 * Respects single/double-quoted tokens and trailing whitespace.
 */
export function extractLastShellArg(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      current += ch;
      escaping = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);

  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}
