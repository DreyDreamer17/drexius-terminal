/**
 * Drexius Terminal - User Preferences & Custom Keybindings Store
 * Persists general settings, UI element toggles, and customizable shortcuts.
 */

import type { Layout, Pane } from './types';

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

  // Terminal & Appearance Defaults
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
  confirmClosePane: boolean;
  defaultLocalShell: string;
  ghostSuggestions: boolean;
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
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 10000,
  confirmClosePane: true,
  defaultLocalShell: '',
  ghostSuggestions: true,
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
  split_vertical: {
    id: 'split_vertical',
    label: 'Split Pane Vertical',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+D',
    description: 'Split the current terminal pane vertically (side-by-side)',
  },
  split_horizontal: {
    id: 'split_horizontal',
    label: 'Split Pane Horizontal',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+E',
    description: 'Split the current terminal pane horizontally (top/bottom)',
  },
  maximize_pane: {
    id: 'maximize_pane',
    label: 'Toggle Maximize / Zoom Pane',
    category: 'Splits & Navigation',
    keys: 'Ctrl+Shift+M',
    description: 'Zoom and expand the active pane to full size or restore split view',
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
      result[id] = { ...def, ...(parsed[id] || {}) };
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

/**
 * Directional Split Navigation
 * Finds the adjacent pane in the active tab based on layout and direction.
 */
export function getAdjacentPaneId(
  currentPaneId: string,
  panes: Pane[],
  layout: Layout,
  direction: 'left' | 'right' | 'up' | 'down'
): string | null {
  if (panes.length <= 1) return null;
  const idx = panes.findIndex((p) => p.id === currentPaneId);
  if (idx === -1) return panes[0]?.id ?? null;

  if (layout === 'vertical') {
    // 2 panes side-by-side: Index 0 (Left), Index 1 (Right)
    if (direction === 'left' && idx > 0) return panes[idx - 1].id;
    if (direction === 'right' && idx < panes.length - 1) return panes[idx + 1].id;
    // Allow Alt+Left/Right to wrap or switch between two panes
    if (direction === 'left' && idx === 0) return panes[panes.length - 1].id;
    if (direction === 'right' && idx === panes.length - 1) return panes[0].id;
    return null;
  }

  if (layout === 'horizontal') {
    // 2 panes stacked: Index 0 (Top), Index 1 (Bottom)
    if (direction === 'up' && idx > 0) return panes[idx - 1].id;
    if (direction === 'down' && idx < panes.length - 1) return panes[idx + 1].id;
    // Allow Alt+Up/Down to wrap
    if (direction === 'up' && idx === 0) return panes[panes.length - 1].id;
    if (direction === 'down' && idx === panes.length - 1) return panes[0].id;
    return null;
  }

  if (layout === 'grid') {
    // 2x2 Grid:
    // [0] [1]
    // [2] [3]
    switch (direction) {
      case 'left':
        if (idx === 1) return panes[0]?.id ?? null;
        if (idx === 3) return panes[2]?.id ?? null;
        if (idx === 0 && panes.length > 1) return panes[1]?.id ?? null;
        if (idx === 2 && panes.length > 3) return panes[3]?.id ?? null;
        break;
      case 'right':
        if (idx === 0) return panes[1]?.id ?? null;
        if (idx === 2) return panes[3]?.id ?? panes[1]?.id ?? null;
        if (idx === 1) return panes[0]?.id ?? null;
        if (idx === 3) return panes[2]?.id ?? null;
        break;
      case 'up':
        if (idx === 2) return panes[0]?.id ?? null;
        if (idx === 3) return panes[1]?.id ?? panes[0]?.id ?? null;
        if (idx === 0 && panes.length > 2) return panes[2]?.id ?? null;
        if (idx === 1 && panes.length > 3) return panes[3]?.id ?? null;
        break;
      case 'down':
        if (idx === 0) return panes[2]?.id ?? panes[1]?.id ?? null;
        if (idx === 1) return panes[3]?.id ?? panes[2]?.id ?? null;
        if (idx === 2) return panes[0]?.id ?? null;
        if (idx === 3) return panes[1]?.id ?? null;
        break;
    }
  }

  return null;
}
