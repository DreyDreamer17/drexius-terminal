/**
 * Drexius Terminal - User Preferences & Custom Keybindings Store
 * Persists general settings, UI element toggles, and customizable shortcuts.
 */

export type TerminalFontWeight = '300' | '400' | '500' | '600' | '700';

export interface TerminalFontOption {
  id: string;
  label: string;
  description: string;
  family: string;
}

export const DEFAULT_FONT_FAMILY = 'JetBrains Mono';

export const POPULAR_TERMINAL_FONTS: TerminalFontOption[] = [
  {
    id: 'JetBrains Mono',
    label: 'JetBrains Mono',
    description: 'Bundled default • Excellent ligature & coding clarity',
    family: '"JetBrainsMono Nerd Font", "JetBrains Mono Variable", "JetBrains Mono"',
  },
  {
    id: 'Fira Code',
    label: 'Fira Code',
    description: 'Iconic monospaced font with programming ligatures',
    family: '"Fira Code", "Fira Code Retina"',
  },
  {
    id: 'Cascadia Code',
    label: 'Cascadia Code',
    description: 'Modern Microsoft terminal monospace font',
    family: '"Cascadia Code", "Cascadia Mono"',
  },
  {
    id: 'Hack',
    label: 'Hack',
    description: 'Open source workhorse font designed for source code',
    family: '"Hack", "Hack Nerd Font"',
  },
  {
    id: 'Source Code Pro',
    label: 'Source Code Pro',
    description: "Adobe's clean, legible open-source monospace font",
    family: '"Source Code Pro"',
  },
  {
    id: 'MesloLGS NF',
    label: 'MesloLGS NF',
    description: 'Optimized for Powerlevel10k & Nerd Font glyphs',
    family: '"MesloLGS NF", "Meslo LG S NF", "Meslo LG S"',
  },
  {
    id: 'Roboto Mono',
    label: 'Roboto Mono',
    description: "Google's geometric monospaced typeface",
    family: '"Roboto Mono"',
  },
  {
    id: 'Ubuntu Mono',
    label: 'Ubuntu Mono',
    description: 'Warm, distinctive Ubuntu terminal typeface',
    family: '"Ubuntu Mono"',
  },
  {
    id: 'Inconsolata',
    label: 'Inconsolata',
    description: 'Raph Levien classic humanist monospace font',
    family: '"Inconsolata"',
  },
  {
    id: 'DejaVu Sans Mono',
    label: 'DejaVu Sans Mono',
    description: 'Vast Unicode coverage and clear character distinction',
    family: '"DejaVu Sans Mono"',
  },
  {
    id: 'Menlo',
    label: 'Menlo',
    description: 'macOS standard fixed-width terminal font',
    family: '"Menlo"',
  },
  {
    id: 'Monaco',
    label: 'Monaco',
    description: 'Classic compact Apple monospace typeface',
    family: '"Monaco"',
  },
  {
    id: 'Consolas',
    label: 'Consolas',
    description: 'Windows ClearType monospace standard',
    family: '"Consolas"',
  },
  {
    id: 'custom',
    label: 'Custom Font...',
    description: 'Enter any font family installed on your system',
    family: '',
  },
];

export const FONT_WEIGHT_OPTIONS: { id: TerminalFontWeight; label: string }[] = [
  { id: '300', label: 'Light' },
  { id: '400', label: 'Regular' },
  { id: '500', label: 'Medium' },
  { id: '600', label: 'Semibold' },
  { id: '700', label: 'Bold' },
];

export const FALLBACK_FONT_STACK =
  '"JetBrainsMono Nerd Font", "JetBrains Mono Variable", "JetBrains Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

export function resolveTerminalFontFamily(fontFamily?: string, customFont?: string): string {
  if (!fontFamily || fontFamily === 'JetBrains Mono') {
    return FALLBACK_FONT_STACK;
  }
  if (fontFamily === 'custom' && customFont?.trim()) {
    return `"${customFont.trim()}", ${FALLBACK_FONT_STACK}`;
  }
  const match = POPULAR_TERMINAL_FONTS.find((f) => f.id === fontFamily);
  if (match && match.family) {
    return `${match.family}, ${FALLBACK_FONT_STACK}`;
  }
  return `"${fontFamily}", ${FALLBACK_FONT_STACK}`;
}

export interface UiPreferences {
  // UI Customization Toggles (Show / Hide features)
  showSerial: boolean;
  showDocker: boolean;
  showAi: boolean;
  showSftp: boolean;
  showSnippets: boolean;
  showTunnels: boolean;
  showLocalTerminal: boolean;
  showThemeButton: boolean;
  showStatusBarToggle: boolean;
  showKeychain: boolean;
  showHistory: boolean;
  showKnownHosts: boolean;
  showPairing: boolean;
  showSync: boolean;
  showAutoLock: boolean;
  showLockVault: boolean;

  // Terminal & Appearance Defaults
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
  confirmClosePane: boolean;
  defaultLocalShell: string;
  ghostSuggestions: boolean;

  // Font & Typography Configuration
  fontFamily: string;
  customFontFamily: string;
  fontWeight: TerminalFontWeight;
  letterSpacing: number;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  showSerial: true,
  showDocker: true,
  showAi: true,
  showSftp: true,
  showSnippets: true,
  showTunnels: true,
  showLocalTerminal: true,
  showThemeButton: true,
  showStatusBarToggle: true,
  showKeychain: true,
  showHistory: true,
  showKnownHosts: true,
  showPairing: true,
  showSync: true,
  showAutoLock: true,
  showLockVault: true,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 10000,
  confirmClosePane: true,
  defaultLocalShell: '',
  ghostSuggestions: true,
  fontFamily: 'JetBrains Mono',
  customFontFamily: '',
  fontWeight: '400',
  letterSpacing: 0,
};

export interface ShortcutBinding {
  id: string;
  label: string;
  category: 'Splits & Navigation' | 'Workspace' | 'Terminal Actions';
  keys: string; // e.g. "Alt+ArrowLeft" or "Ctrl+Shift+D"
  description: string;
}

export const DEFAULT_SHORTCUTS: Record<string, ShortcutBinding> = {
  focus_split_left: {
    id: 'focus_split_left',
    label: 'Focus Split Left',
    category: 'Splits & Navigation',
    keys: 'Alt+ArrowLeft',
    description: 'Move focus to the split terminal pane on the left',
  },
  focus_split_right: {
    id: 'focus_split_right',
    label: 'Focus Split Right',
    category: 'Splits & Navigation',
    keys: 'Alt+ArrowRight',
    description: 'Move focus to the split terminal pane on the right',
  },
  focus_split_up: {
    id: 'focus_split_up',
    label: 'Focus Split Above',
    category: 'Splits & Navigation',
    keys: 'Alt+ArrowUp',
    description: 'Move focus to the split terminal pane above',
  },
  focus_split_down: {
    id: 'focus_split_down',
    label: 'Focus Split Below',
    category: 'Splits & Navigation',
    keys: 'Alt+ArrowDown',
    description: 'Move focus to the split terminal pane below',
  },
  swap_split_left: {
    id: 'swap_split_left',
    label: 'Swap Pane Left',
    category: 'Splits & Navigation',
    keys: 'Alt+Shift+ArrowLeft',
    description: 'Exchange position with the split terminal pane on the left',
  },
  swap_split_right: {
    id: 'swap_split_right',
    label: 'Swap Pane Right',
    category: 'Splits & Navigation',
    keys: 'Alt+Shift+ArrowRight',
    description: 'Exchange position with the split terminal pane on the right',
  },
  swap_split_up: {
    id: 'swap_split_up',
    label: 'Swap Pane Up',
    category: 'Splits & Navigation',
    keys: 'Alt+Shift+ArrowUp',
    description: 'Exchange position with the split terminal pane above',
  },
  swap_split_down: {
    id: 'swap_split_down',
    label: 'Swap Pane Down',
    category: 'Splits & Navigation',
    keys: 'Alt+Shift+ArrowDown',
    description: 'Exchange position with the split terminal pane below',
  },
  split_vertical: {
    id: 'split_vertical',
    label: 'Split Right',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+D',
    description: 'Instantly split the focused pane to the right with a copy of it (same host, same directory)',
  },
  split_horizontal: {
    id: 'split_horizontal',
    label: 'Split Down',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+E',
    description: 'Instantly split the focused pane downward with a copy of it (same host, same directory)',
  },
  split_left: {
    id: 'split_left',
    label: 'Split Left',
    category: 'Splits & Navigation',
    keys: 'Alt+Shift+D',
    description: 'Instantly split the focused pane to the left with a copy of it',
  },
  split_up: {
    id: 'split_up',
    label: 'Split Up',
    category: 'Splits & Navigation',
    keys: 'Alt+Shift+E',
    description: 'Instantly split the focused pane upward with a copy of it',
  },
  split_menu: {
    id: 'split_menu',
    label: 'Split With Host…',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+O',
    description: 'Open the split menu to choose a direction and a different host or local shell',
  },
  equalize_splits: {
    id: 'equalize_splits',
    label: 'Equalize Splits',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+N',
    description: 'Resize every split in the tab so all panes get an equal share',
  },
  maximize_pane: {
    id: 'maximize_pane',
    label: 'Toggle Maximize / Zoom Pane',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+M',
    description: 'Zoom and expand the active pane to full size or restore split view',
  },
  save_layout_preset: {
    id: 'save_layout_preset',
    label: 'Save Split Layout Preset',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+S',
    description: 'Save current split layout and connected hosts as a reusable preset',
  },
  open_layout_menu: {
    id: 'open_layout_menu',
    label: 'Layout Presets & Switcher',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+L',
    description: 'Open the split layout switcher and recall saved layout presets',
  },
  close_pane: {
    id: 'close_pane',
    label: 'Close Active Pane',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+W',
    description: 'Close the currently focused split pane in tab',
  },
  next_pane: {
    id: 'next_pane',
    label: 'Next Split Pane',
    category: 'Splits & Navigation',
    keys: 'Ctrl+]',
    description: 'Cycle focus forward through active split panes',
  },
  prev_pane: {
    id: 'prev_pane',
    label: 'Previous Split Pane',
    category: 'Splits & Navigation',
    keys: 'Ctrl+[',
    description: 'Cycle focus backward through active split panes',
  },
  open_settings: {
    id: 'open_settings',
    label: 'Open Settings',
    category: 'Workspace',
    keys: 'Ctrl+,',
    description: 'Open General Settings dialog',
  },
  open_quick: {
    id: 'open_quick',
    label: 'Quick Switch / Connect',
    category: 'Workspace',
    keys: 'Ctrl+K',
    description: 'Open the quick connect & host search palette',
  },
  new_terminal: {
    id: 'new_terminal',
    label: 'New Local Terminal Tab',
    category: 'Workspace',
    keys: 'Ctrl+T',
    description: 'Open a new local shell terminal tab',
  },
  open_sftp: {
    id: 'open_sftp',
    label: 'Open SFTP Browser',
    category: 'Workspace',
    keys: 'Ctrl+Shift+F',
    description: 'Open the SFTP graphical file manager tab',
  },
  toggle_ai: {
    id: 'toggle_ai',
    label: 'Toggle AI Assistant',
    category: 'Workspace',
    keys: 'Ctrl+Shift+A',
    description: 'Toggle the AI copilot workspace side panel',
  },
  toggle_broadcast: {
    id: 'toggle_broadcast',
    label: 'Toggle Cluster Broadcast',
    category: 'Workspace',
    keys: 'Ctrl+Shift+I',
    description: 'Send input simultaneously to all split panes in the current tab',
  },
  toggle_zen: {
    id: 'toggle_zen',
    label: 'Toggle Zen Mode',
    category: 'Workspace',
    keys: 'Ctrl+Shift+Z',
    description: 'Hide workspace chrome for a distraction-free fullscreen terminal',
  },
  toggle_rail: {
    id: 'toggle_rail',
    label: 'Toggle Sidebar Rail',
    category: 'Workspace',
    keys: 'Ctrl+Shift+B',
    description: 'Show or hide the left navigation icon rail',
  },
  command_history: {
    id: 'command_history',
    label: 'Reverse Command History',
    category: 'Terminal Actions',
    keys: 'Ctrl+Shift+R',
    description: 'Search previously executed commands across sessions',
  },
};

const PREFS_STORAGE_KEY = 'drx.settings.preferences';
const SHORTCUTS_STORAGE_KEY = 'drx.settings.shortcuts';

export function loadUiPreferences(): UiPreferences {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_PREFERENCES };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_UI_PREFERENCES, ...parsed };
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function saveUiPreferences(prefs: UiPreferences): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

export function loadShortcuts(): Record<string, ShortcutBinding> {
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SHORTCUTS };
    const parsed = JSON.parse(raw);
    const result: Record<string, ShortcutBinding> = {};
    for (const [id, def] of Object.entries(DEFAULT_SHORTCUTS)) {
      // Only the key combination is user data; labels and descriptions always come from the
      // current defaults so wording fixes reach users who customised a shortcut.
      const saved = parsed?.[id]?.keys;
      result[id] = typeof saved === 'string' && saved ? { ...def, keys: saved } : { ...def };
    }
    return result;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function saveShortcuts(shortcuts: Record<string, ShortcutBinding>): void {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {}
}

export interface BuiltinShortcut {
  label: string;
  description: string;
  /** Combinations as shown to the user. */
  keys: string[];
  /** Combinations a rebindable shortcut must not take. Defaults to `keys`; narrower where a
   *  displayed key is only a macOS spelling of a combo that means something else elsewhere
   *  (Cmd+C copies on macOS, but Ctrl+C is the shell's interrupt). */
  reserved?: string[];
}

/**
 * Shortcuts handled outside the rebindable list (in TerminalPane.tsx and App.tsx). They are shown
 * read-only in Settings, and a rebindable shortcut may not shadow them. Keep in step with those
 * handlers; tests/shortcuts.test.mjs checks that no default collides with this list.
 */
export const BUILTIN_SHORTCUTS: BuiltinShortcut[] = [
  {
    label: 'Copy selection',
    description: 'Copy the selected terminal text to the clipboard',
    keys: ['Ctrl+Shift+C', 'Cmd+C (macOS)'],
    reserved: ['Ctrl+Shift+C'],
  },
  {
    label: 'Paste',
    description: 'Paste the system clipboard into the terminal',
    keys: ['Ctrl+Shift+V', 'Cmd+V (macOS)'],
    reserved: ['Ctrl+Shift+V'],
  },
  {
    label: 'Find in terminal',
    description: 'Search the focused terminal\u2019s scrollback',
    keys: ['Ctrl+F'],
  },
  {
    label: 'Clipboard history',
    description: 'Open the clipboard history and paste an earlier entry',
    keys: ['Ctrl+Shift+H', 'Ctrl+Alt+V'],
  },
  {
    label: 'Docker manager',
    description: 'Open the container manager for the focused host',
    keys: ['Ctrl+Shift+U', 'Ctrl+Alt+D'],
  },
  {
    label: 'Quick connect (alternate)',
    description: 'Same as Quick Switch, and works while a terminal has focus',
    keys: ['Ctrl+Shift+K'],
  },
  {
    label: 'Toggle status bar',
    description: 'Show or hide the status bar along the bottom',
    keys: ['Ctrl+/'],
  },
];

/** Every reserved combination mapped to the built-in it belongs to. */
export const RESERVED_SHORTCUTS: Record<string, string> = Object.fromEntries(
  BUILTIN_SHORTCUTS.flatMap((b) => (b.reserved ?? b.keys).map((k) => [k, b.label] as [string, string]))
);

/** Canonical form of a combo ("Cmd+shift+d" and "Shift+Ctrl+D" compare equal), as `matchesShortcut` reads it. */
export function normalizeCombo(keys: string): string {
  const parts = keys.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'cmd') mods.add('ctrl');
    else if (p === 'alt' || p === 'opt') mods.add('alt');
    else if (p === 'shift') mods.add('shift');
    else if (!key) key = p;
  }
  return [...['ctrl', 'alt', 'shift'].filter((m) => mods.has(m)), key].join('+');
}

/** What `combo` would collide with if assigned to shortcut `id`: another binding's label, a built-in's name, or null. */
export function findShortcutConflict(
  shortcuts: Record<string, ShortcutBinding>,
  id: string,
  combo: string
): string | null {
  const wanted = normalizeCombo(combo);
  for (const other of Object.values(shortcuts)) {
    if (other.id !== id && normalizeCombo(other.keys) === wanted) return other.label;
  }
  for (const [reserved, label] of Object.entries(RESERVED_SHORTCUTS)) {
    if (normalizeCombo(reserved) === wanted) return `${label} (built-in)`;
  }
  return null;
}

/**
 * Matches a keyboard event against a shortcut definition like "Ctrl+Shift+D" or "Alt+ArrowLeft"
 */
export function matchesShortcut(e: KeyboardEvent, shortcutKey: string): boolean {
  if (!shortcutKey) return false;
  const parts = shortcutKey.split('+').map((p) => p.trim());
  const reqCtrl = parts.some((p) => p.toLowerCase() === 'ctrl' || p.toLowerCase() === 'cmd');
  const reqAlt = parts.some((p) => p.toLowerCase() === 'alt' || p.toLowerCase() === 'opt');
  const reqShift = parts.some((p) => p.toLowerCase() === 'shift');

  const mainKeyPart = parts.find(
    (p) => !['ctrl', 'cmd', 'alt', 'opt', 'shift'].includes(p.toLowerCase())
  );
  if (!mainKeyPart) return false;

  const hasCtrl = e.ctrlKey || e.metaKey;
  if (reqCtrl !== hasCtrl) return false;
  if (reqAlt !== e.altKey) return false;
  if (reqShift !== e.shiftKey) return false;

  const eventKey = e.key.toLowerCase();
  const targetKey = mainKeyPart.toLowerCase();

  if (targetKey === eventKey) return true;

  // Handle e.code matching (e.g. Digit1 when Shift produces '!', KeyZ, Space)
  if (e.code) {
    const codeLower = e.code.toLowerCase();
    if (codeLower === `key${targetKey}`) return true;
    if (codeLower === `digit${targetKey}`) return true;
    if (targetKey === 'space' && codeLower === 'space') return true;
  }

  // Handle named special keys
  if (targetKey === 'arrowleft' && (eventKey === 'arrowleft' || eventKey === 'left')) return true;
  if (targetKey === 'arrowright' && (eventKey === 'arrowright' || eventKey === 'right')) return true;
  if (targetKey === 'arrowup' && (eventKey === 'arrowup' || eventKey === 'up')) return true;
  if (targetKey === 'arrowdown' && (eventKey === 'arrowdown' || eventKey === 'down')) return true;
  if ((targetKey === 'space' || targetKey === ' ') && eventKey === ' ') return true;

  return false;
}
