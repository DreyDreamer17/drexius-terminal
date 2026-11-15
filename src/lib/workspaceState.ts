import type { MobilePage } from '../components/MobileNavigation';
import { ensureTree, type LayoutNode } from './splitTree';
import type { Host, PopoutPaneEntry, Tab } from './types';

/**
 * Upper bound on panes in one tab. The split tree has no structural limit; this protects the
 * machine: every pane is a PTY or SSH session plus an xterm renderer (and a WebGL context,
 * which browsers cap and which falls back to the DOM renderer when lost).
 */
export const MAX_PANES_PER_TAB = 16;

/** The split tree for a terminal tab: its stored tree if consistent with its panes, else a rebuilt one. */
export function tabTree(t: Tab): LayoutNode | null {
  return ensureTree(t.tree, t.panes.map((p) => p.id), t.layout);
}

export const RECENT_HOSTS_STORAGE_KEY = 'drx.recent_hosts.v1';

export function loadRecentHostIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_HOSTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecentHostIds(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_HOSTS_STORAGE_KEY, JSON.stringify(ids.slice(0, 20)));
  } catch {}
}

/** Tools that slide up over the phone terminal screen. */
export type TerminalDrawerKind = 'assistant' | 'snippets' | 'keypad' | 'history';

/** Side panel drawer kinds. */
export type WorkspacePanelKind = 'hosts' | 'snippets' | 'keychain' | 'tunnels' | 'logs' | 'known_hosts';

/** Phone settings picker sheet kinds. */
export type MobileSettingsPickerKind =
  | 'autolock'
  | 'theme'
  | 'font'
  | 'quickunlock'
  | 'directlaunch'
  | 'recovery_key'
  | 'storage_perms';

/** Split / Layout / Presets popover state. */
export interface SplitMenuState {
  tab: 'split' | 'layout' | 'presets';
  direction: 'right' | 'down' | 'left' | 'up';
  pref: 'vertical' | 'horizontal';
  left: number;
  top: number;
}

/** Identity tints of the AI and Snippets keys (fuchsia / violet), reused by their drawers. */
export const AI_TINT = '#e879f9';
export const SNIPPET_TINT = '#a78bfa';

export const LOCAL_HOST: Host = {
  id: '__local__',
  label: 'Local Terminal',
  hostname: 'localhost',
  port: 0,
  username: 'local',
  authMethod: 'agent',
  tags: ['local'],
  hasSecret: true,
  os: 'linux',
};

/** Auto-lock timeouts in minutes. 0 means off. */
export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60] as const;
export const AUTO_LOCK_STORAGE_KEY = 'drx.autolock_minutes';
export const AUTO_LOCK_DEFAULT = 15;

export function readAutoLockMinutes(): number {
  try {
    const raw = Number(localStorage.getItem(AUTO_LOCK_STORAGE_KEY));
    if (localStorage.getItem(AUTO_LOCK_STORAGE_KEY) !== null && (AUTO_LOCK_OPTIONS as readonly number[]).includes(raw)) {
      return raw;
    }
  } catch {
    /* storage unavailable: fall through to default */
  }
  return AUTO_LOCK_DEFAULT;
}

export const WORKSPACE_STORAGE_KEY = 'drx.workspace.state.v1';

export function readPersistedWorkspace(): { tabs: Tab[]; activeTabId: string | null; mobilePage: MobilePage } | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs = (parsed.tabs as Tab[]).map((tab) => {
      if (tab.kind === 'sftp') {
        return {
          ...tab,
          sftpSessionId: null,
          sftpLeftSessionId: null,
          sftpRightSessionId: null,
        };
      }
      if (!Array.isArray(tab.panes)) return tab;
      const panes = tab.panes.map((pane) => {
        try {
          const latestSid = localStorage.getItem('drx.pane.sid.' + pane.id);
          if (latestSid) return { ...pane, sessionId: latestSid };
        } catch {}
        return pane;
      });
      // Workspaces saved before split trees only have a named layout; settle on a tree once, at
      // load, so divider ids stay stable from here on.
      const tree = ensureTree(tab.tree, panes.map((p) => p.id), tab.layout);
      return { ...tab, panes, ...(tree ? { tree } : {}) };
    });
    return {
      tabs,
      activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
      mobilePage: typeof parsed.mobilePage === 'string' ? (parsed.mobilePage as MobilePage) : 'terminals',
    };
  } catch {
    return null;
  }
}

export const POPOUT_STORAGE_KEY = 'drx.workspace.popouts.v1';
export const POPOUT_ACTION_KEY = 'drx.popout.action.v1';

export function readPersistedPopouts(): PopoutPaneEntry[] {
  try {
    const raw = localStorage.getItem(POPOUT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as PopoutPaneEntry[]).map((entry) => {
      try {
        const latestSid = localStorage.getItem('drx.pane.sid.' + entry.pane.id);
        if (latestSid) {
          return { ...entry, pane: { ...entry.pane, sessionId: latestSid, resume: true } };
        }
      } catch {}
      return entry;
    });
  } catch {
    return [];
  }
}

export function getPopoutWindowParams(): {
  isPopout: boolean;
  paneId: string;
  hostId: string;
  isLocal: boolean;
  sessionId: string | null;
  title: string;
} {
  if (typeof window === 'undefined') {
    return { isPopout: false, paneId: '', hostId: '', isLocal: false, sessionId: null, title: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const isPopout = params.get('popout') === '1';
  const paneId = params.get('paneId') || '';
  const hostId = params.get('hostId') || LOCAL_HOST.id;
  const isLocal = params.get('isLocal') === '1' || hostId === LOCAL_HOST.id;
  const sessionId = params.get('sessionId') || null;
  const title = params.get('title') || (isLocal ? 'Local Terminal' : 'Remote Session');
  return { isPopout: isPopout && !!paneId, paneId, hostId, isLocal, sessionId, title };
}
