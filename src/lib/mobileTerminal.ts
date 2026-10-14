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

