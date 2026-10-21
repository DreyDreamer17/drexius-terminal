import { useMobile, useMobileViewport } from './hooks/useMobile';
import drexiusLogo from './assets/drexius-logo.png';
import { MobileNavigation, type MobilePage } from './components/MobileNavigation';
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX } from './lib/mobileTerminal';
import { MobileSheet, WorkspaceAccessContext } from './components/MobileSheet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Server,
  Code2,
  HardDrive,
  Sparkles,
  Lock,
  Plus,
  X,
  Columns2,
  Rows2,
  Grid2x2,
  Palette,
  Cloud,
  ShieldCheck,
  Activity,
  History,
  Zap,
  Command,
  Minus,
  Maximize2,
  Minimize2,
  KeyRound,
  Network,
  Globe2,
  Terminal as TerminalIcon,
  PanelBottom,
  Radio,
  QrCode,
  FolderInput,
  Timer,
  Check,
  Folder,
  LayoutGrid,
  ChevronRight,
  ChevronLeft,
  Type,
  Fingerprint,
  Copy,
  Download,
  Share2,
  FolderLock,
  Boxes,
  Loader2,
  Search,
  Clipboard,
  Settings,
  Bookmark,
  Trash2,
  PanelTop,
  PanelLeft,
  Columns3,
  Layers,
  ArrowLeft,
  ArrowLeftRight,
} from 'lucide-react';
import { bridge, isTauri } from './lib/bridge';
import { registry } from './lib/sessions';
import { THEMES, type DrexiusTheme } from './lib/themes';
import type { CloudInstance, CloudProviderId, Host, HostSecret, KeychainItem, Layout, Pane, Snippet, Tab, TunnelConfig, Vault } from './lib/types';
import {
  type LayoutPreset,
  type LayoutPresetPane,
  BUILTIN_LAYOUT_PRESETS,
  loadUserLayoutPresets,
  saveUserLayoutPresets,
  createUserPreset,
  getLayoutDescription,
} from './lib/layoutPresets';
import { LockScreen } from './components/LockScreen';
import { LaunchSplash } from './components/LaunchSplash';
import { HostSidebar } from './components/HostSidebar';
import { HostModal } from './components/HostModal';
import { VaultMenu } from './components/VaultMenu';
import { TeamShareModal } from './components/TeamShareModal';
import { SerialModal } from './components/SerialModal';
import { DevicePairingModal } from './components/DevicePairingModal';
import { SshConfigModal } from './components/SshConfigModal';
import { TailscaleModal } from './components/TailscaleModal';
import { NetbirdModal } from './components/NetbirdModal';
import { CloudSyncModal } from './components/CloudSyncModal';
import { SyncModal } from './components/SyncModal';
import { OsIcon } from './components/OsIcon';
import { isAndroidPlatform } from './lib/os';
import { SnippetsPanel } from './components/SnippetsPanel';
import { TerminalPane } from './components/TerminalPane';
import { KeychainPanel } from './components/KeychainPanel';
import { PortForwardingPanel } from './components/PortForwardingPanel';
import { LogsPanel } from './components/LogsPanel';
import { KnownHostsPanel } from './components/KnownHostsPanel';
import { DockerModal } from './components/DockerModal';
import { AIPanel } from './components/AIPanel';
import { SftpTab } from './components/SftpTab';
import { PaneErrorBoundary } from './components/PaneErrorBoundary';
import { cn } from './utils/cn';
import { safeUid } from './utils/uuid';
import { ConfirmHost, cancelPendingConfirm, confirmDialog, hasPendingConfirm } from './components/ConfirmDialog';
import { DrawerGrip, DrawerShell, useBottomDrawer } from './components/BottomDrawer';
import { ExtendedKeypad } from './components/ExtendedKeypad';
import { CommandSearchModal } from './components/CommandSearchModal';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import {
  loadUiPreferences,
  saveUiPreferences,
  loadShortcuts,
  saveShortcuts,
  matchesShortcut,
  getAdjacentPaneId,
  POPULAR_TERMINAL_FONTS,
  type UiPreferences,
  type ShortcutBinding,
} from './lib/settings';

const uid = safeUid;
const layoutFor = (n: number, pref?: Layout): Layout => (n <= 1 ? 'single' : n === 2 ? (pref === 'horizontal' ? 'horizontal' : 'vertical') : 'grid');

const RECENT_HOSTS_STORAGE_KEY = 'drx.recent_hosts.v1';

function loadRecentHostIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_HOSTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentHostIds(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_HOSTS_STORAGE_KEY, JSON.stringify(ids.slice(0, 20)));
  } catch {}
}

function getSplitContainerClasses(layout: Layout, paneCount: number): string {
  if (paneCount <= 1) return 'flex p-0';
  switch (layout) {
    case 'vertical':
      return 'grid grid-cols-2 grid-rows-1 gap-1 p-1 bg-black/40 max-md:!flex max-md:!p-0';
    case 'horizontal':
      return 'grid grid-cols-1 grid-rows-2 gap-1 p-1 bg-black/40 max-md:!flex max-md:!p-0';
    case '3-columns':
      return 'grid grid-cols-3 grid-rows-1 gap-1 p-1 bg-black/40 max-md:!flex max-md:!p-0';
    case '3-rows':
      return 'grid grid-cols-1 grid-rows-3 gap-1 p-1 bg-black/40 max-md:!flex max-md:!p-0';
    case '4-columns':
      return 'grid grid-cols-4 grid-rows-1 gap-1 p-1 bg-black/40 max-md:!flex max-md:!p-0';
    case 'main-left':
    case 'main-right':
    case 'main-top':
    case 'main-bottom':
    case 'grid':
    default:
      return 'grid grid-cols-2 grid-rows-2 gap-1 p-1 bg-black/40 max-md:!flex max-md:!p-0';
  }
}

function getPaneSpanClasses(layout: Layout, index: number, totalPanes: number): string {
  if (totalPanes <= 2) return '';

  if (layout === 'main-left') {
    if (index === 0) return 'col-start-1 col-span-1 row-start-1 row-span-2';
    if (index === 1) return 'col-start-2 col-span-1 row-start-1 row-span-1';
    if (index === 2) return 'col-start-2 col-span-1 row-start-2 row-span-1';
  }

  if (layout === 'main-right') {
    if (index === 0) return 'col-start-1 col-span-1 row-start-1 row-span-1';
    if (index === 1) return 'col-start-1 col-span-1 row-start-2 row-span-1';
    if (index === 2) return 'col-start-2 col-span-1 row-start-1 row-span-2';
  }

  if (layout === 'main-top') {
    if (index === 0) return 'col-start-1 col-span-2 row-start-1 row-span-1';
    if (index === 1) return 'col-start-1 col-span-1 row-start-2 row-span-1';
    if (index === 2) return 'col-start-2 col-span-1 row-start-2 row-span-1';
  }

  if (layout === 'main-bottom') {
    if (index === 0) return 'col-start-1 col-span-1 row-start-1 row-span-1';
    if (index === 1) return 'col-start-2 col-span-1 row-start-1 row-span-1';
    if (index === 2) return 'col-start-1 col-span-2 row-start-2 row-span-1';
  }

  if (layout === 'grid' && totalPanes === 3) {
    if (index === 2) return 'col-start-1 col-span-2 row-start-2 row-span-1';
  }

  return '';
}

/** Tools that slide up over the phone terminal screen. */
type TerminalDrawerKind = 'assistant' | 'snippets' | 'keypad' | 'history';
/** Identity tints of the AI and Snippets keys (fuchsia / violet), reused by their drawers. */
const AI_TINT = '#e879f9';
const SNIPPET_TINT = '#a78bfa';

const LOCAL_HOST: Host = {
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
const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60] as const;
const AUTO_LOCK_STORAGE_KEY = 'drx.autolock_minutes';
const AUTO_LOCK_DEFAULT = 15;

function readAutoLockMinutes(): number {
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


/** Tiny theme preview: terminal background with its red/green/blue/magenta strip (same as the desktop theme popover). */
function ThemeSwatch({ t, large = false }: { t: DrexiusTheme; large?: boolean }) {
  return (
    <span className={cn('nx-theme-swatch', large && 'nx-theme-swatch-lg')} style={{ background: t.xterm.background, boxShadow: `0 0 0 1px ${t.accent}55` }} aria-hidden="true">
      {[t.xterm.red, t.xterm.green, t.xterm.blue, t.xterm.magenta].map((c, i) => <i key={i} style={{ background: c }} />)}
    </span>
  );
}

const WORKSPACE_STORAGE_KEY = 'drx.workspace.state.v1';

function readPersistedWorkspace(): { tabs: Tab[]; activeTabId: string | null; mobilePage: MobilePage } | null {
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
      return {
        ...tab,
        panes: tab.panes.map((pane) => {
          try {
            const latestSid = localStorage.getItem('drx.pane.sid.' + pane.id);
            if (latestSid) return { ...pane, sessionId: latestSid };
          } catch {}
          return pane;
        }),
      };
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

export default function App() {
  const mobile = useMobile();
  useMobileViewport();
  const isAndroid = useMemo(() => isAndroidPlatform(), []);
  const persistedWorkspace = useMemo(() => readPersistedWorkspace(), []);
  const [mobilePage, setMobilePage] = useState<MobilePage>(() => persistedWorkspace?.mobilePage ?? 'terminals');
  // Phone settings pickers (auto-lock, theme, font, quick unlock, direct launch, recovery key, storage permissions)
  const [settingsPicker, setSettingsPicker] = useState<'autolock' | 'theme' | 'font' | 'quickunlock' | 'directlaunch' | 'recovery_key' | 'storage_perms' | null>(null);
  const [deviceLockEnabled, setDeviceLockEnabled] = useState(() => bridge.osKeychainEnabled());
  const [directUnlockEnabled, setDirectUnlockEnabled] = useState(() => bridge.isDirectUnlockEnabled());
  const [directLaunchPw, setDirectLaunchPw] = useState('');
  const [directLaunchBusy, setDirectLaunchBusy] = useState(false);
  const [directLaunchErr, setDirectLaunchErr] = useState<string | null>(null);
  const directUnlockAttempted = useRef(false);
  const [directUnlocking, setDirectUnlocking] = useState(() => bridge.isDirectUnlockEnabled() && isTauri);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [downloadedRecoveryPath, setDownloadedRecoveryPath] = useState<string | null>(null);
  const [regeneratingRecovery, setRegeneratingRecovery] = useState(false);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [quickUnlockPw, setQuickUnlockPw] = useState('');
  const [quickUnlockBusy, setQuickUnlockBusy] = useState(false);
  const [quickUnlockErr, setQuickUnlockErr] = useState(null as string | null);
  const [storageGranted, setStorageGranted] = useState<boolean | null>(null);
  const [requestingPerm, setRequestingPerm] = useState(false);

  // Direct Launch auto-unlock on initial app startup
  useEffect(() => {
    if (directUnlockAttempted.current) return;
    directUnlockAttempted.current = true;

    if (bridge.isDirectUnlockEnabled() && isTauri) {
      bridge
        .osKeychainUnlock()
        .then(() => {
          setUnlocked(true);
        })
        .catch((err) => {
          console.warn('Direct launch auto-unlock failed, falling back to manual unlock:', err);
        })
        .finally(() => {
          setDirectUnlocking(false);
        });
    } else {
      setDirectUnlocking(false);
    }
  }, []);

  useEffect(() => {
    if (settingsPicker === 'recovery_key') {
      bridge.vaultGetRecoveryKey().then(setRecoveryKey).catch(() => {});
    } else if (settingsPicker === 'storage_perms') {
      bridge.checkStoragePermission().then(setStorageGranted).catch(() => {});
    }
  }, [settingsPicker]);

  const [sessionSheet, setSessionSheet] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  const [unlocked, setUnlocked] = useState(false);
  // The vault can be unlocked while this UI is not. Android recreates the
  // Activity/WebView when an app switch is worth more memory than the process,
  // and the Rust side keeps running with the key still in memory; a reload
  // remounts this tree on any platform. `vault_status` already reports whether
  // a key is held, so honour it instead of painting a lock screen over an
  // unlocked vault. Manual and idle locks both call `bridge.lock()`, which
  // clears the key, so this can never undo a deliberate lock.
  useEffect(() => {
    if (unlocked || !isTauri) {
      return;
    }
    let active = true;
    bridge
      .vaultStatus()
      .then((s) => {
        if (!active) return;
        if (s.unlocked) {
          setUnlocked(true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [unlocked]);
  // Initialize vault-backed AI settings only after the first unlock, then keep
  // the panel mounted through auto-lock and mobile navigation.
  const [workspaceReady, setWorkspaceReady] = useState(false);
  useEffect(() => { if (unlocked) setWorkspaceReady(true); }, [unlocked]);
  // A confirm left open across an auto-lock must not fire once the vault is locked.
  useEffect(() => { if (!unlocked) cancelPendingConfirm(); }, [unlocked]);

  // Quick-unlock status. `osKeychainStatus()` on its own only stats the
  // device-bound credential file, so it is safe to run on every mount/page
  // change. Reading the OS keyring can raise a platform prompt (Touch ID on
  // macOS, a Secret Service dialog on Linux), so that probe is limited to the
  // sheet the user opened *in order to manage quick unlock*.
  useEffect(() => {
    if (!isTauri) return;
    const probeKeyring = settingsPicker === 'quickunlock';
    bridge.osKeychainStatus(probeKeyring).then((hasStored) => {
      const enabled = hasStored || bridge.osKeychainEnabled();
      setDeviceLockEnabled(enabled);
      if (hasStored && !bridge.osKeychainEnabled()) {
        try { localStorage.setItem('drx.os_keychain', '1'); } catch {}
      }
    }).catch(() => {});
  }, [unlocked, mobilePage, settingsPicker]);

  // Once the user has authenticated it is safe to confirm the OS keyring, so the
  // quick-unlock button comes back if localStorage was cleared but the keychain
  // entry survives (Keychain Access cleanup, fresh profile, browser storage
  // reset). Guarded by the opt-in flag, so this never reads the keyring twice.
  useEffect(() => {
    if (!isTauri || !unlocked || bridge.osKeychainEnabled()) return;
    bridge.osKeychainStatus(true).then((hasStored) => {
      if (!hasStored) return;
      try { localStorage.setItem('drx.os_keychain', '1'); } catch {}
      setDeviceLockEnabled(true);
    }).catch(() => {});
  }, [unlocked]);
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(readAutoLockMinutes);
  const [showAutoLockMenu, setShowAutoLockMenu] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [keychain, setKeychain] = useState<KeychainItem[]>([]);
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [tabs, setTabs] = useState<Tab[]>(() => persistedWorkspace?.tabs ?? []);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => persistedWorkspace?.activeTabId ?? null);
  const [panel, setPanel] = useState<'hosts' | 'snippets' | 'keychain' | 'tunnels' | 'logs' | 'known_hosts' | null>(() => {
    if (persistedWorkspace?.mobilePage === 'hosts') return 'hosts';
    return null;
  });
  const [showDockerModal, setShowDockerModal] = useState(false);
  const [dockerHostId, setDockerHostId] = useState<string | null>(null);
  const [splitMenu, setSplitMenu] = useState<{
    tab: 'split' | 'layout' | 'presets';
    direction: 'right' | 'down' | 'left' | 'up';
    pref: 'vertical' | 'horizontal';
    left: number;
    top: number;
  } | null>(null);
  const [userPresets, setUserPresets] = useState<LayoutPreset[]>(() => loadUserLayoutPresets());
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const [recentHostIds, setRecentHostIds] = useState<string[]>(() => loadRecentHostIds());

  const markHostRecent = useCallback((hostId: string) => {
    if (!hostId || hostId === LOCAL_HOST.id) return;
    setRecentHostIds((prev) => {
      const next = [hostId, ...prev.filter((id) => id !== hostId)].slice(0, 20);
      saveRecentHostIds(next);
      return next;
    });
  }, []);

  const [showAI, setShowAI] = useState(false);

  // Persist workspace tabs, activeTabId, and mobilePage so WebView reloads or
  // Android Activity recreations restore the exact open terminal tabs.
  useEffect(() => {
    if (!unlocked) return;
    try {
      localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ tabs, activeTabId, mobilePage })
      );
    } catch {}
  }, [unlocked, tabs, activeTabId, mobilePage]);

  // Reconcile open tabs with live Rust SSH sessions once on startup/unlock
  // (e.g. if WebView reloaded while Rust kept sessions alive via SessionForegroundService).
  // Must NOT re-run on routine `hosts` refreshes (focus/sync), otherwise a pane that
  // reconnected under a new sessionId while its initial `pane.sessionId` prop was older
  // would cause the new sessionId to be mistaken for an unattached session and spawn a duplicate tab.
  const reconciledSessionsRef = useRef(false);
  useEffect(() => {
    if (!unlocked) {
      reconciledSessionsRef.current = false;
      return;
    }
    if (!isTauri || hosts.length === 0 || reconciledSessionsRef.current) return;
    reconciledSessionsRef.current = true;
    let cancelled = false;
    bridge.listSshSessions().then((liveSessions) => {
      if (cancelled || liveSessions.length === 0) return;
      setTabs((prevTabs) => {
        let changed = false;
        const claimedSessionIds = new Set<string>();
        const claimedPaneIds = new Set<string>();
        const nextTabs = prevTabs.map((tab) => {
          if (tab.kind === 'sftp') return tab;
          let tabChanged = false;
          const nextPanes = tab.panes.map((pane) => {
            const liveSid = registry.get(pane.id)?.sessionId;
            const storageSid = (() => {
              try { return localStorage.getItem('drx.pane.sid.' + pane.id); } catch { return null; }
            })();
            const storedSid = liveSid || storageSid || pane.sessionId;
            if (storedSid && liveSessions.some((s) => s.sessionId === storedSid)) {
              claimedSessionIds.add(storedSid);
              claimedPaneIds.add(pane.id);
              if (pane.sessionId !== storedSid) {
                tabChanged = true;
                changed = true;
                return { ...pane, sessionId: storedSid };
              }
            }
            return pane;
          });
          return tabChanged ? { ...tab, panes: nextPanes } : tab;
        });

        const extraTabs: Tab[] = [];
        for (const sess of liveSessions) {
          if (claimedSessionIds.has(sess.sessionId)) continue;
          let matchedExistingPane = false;
          for (let ti = 0; ti < nextTabs.length; ti++) {
            const t = nextTabs[ti];
            if (t.kind === 'sftp') continue;
            const pi = t.panes.findIndex(
              (p) => !p.isLocal && p.hostId === sess.hostId && !claimedPaneIds.has(p.id)
            );
            if (pi !== -1) {
              const pane = t.panes[pi];
              try { localStorage.setItem('drx.pane.sid.' + pane.id, sess.sessionId); } catch {}
              const updatedPanes = [...t.panes];
              updatedPanes[pi] = { ...pane, sessionId: sess.sessionId };
              nextTabs[ti] = { ...t, panes: updatedPanes };
              claimedSessionIds.add(sess.sessionId);
              claimedPaneIds.add(pane.id);
              matchedExistingPane = true;
              changed = true;
              break;
            }
          }
          if (!matchedExistingPane) {
            const h = hosts.find((x) => x.id === sess.hostId);
            if (h) {
              const paneId = uid();
              try { localStorage.setItem('drx.pane.sid.' + paneId, sess.sessionId); } catch {}
              const pane: Pane = { id: paneId, hostId: h.id, resume: true, sessionId: sess.sessionId };
              const tab: Tab = {
                id: uid(),
                title: h.label,
                color: h.color,
                panes: [pane],
                layout: 'single',
                activePaneId: pane.id,
              };
              extraTabs.push(tab);
              claimedSessionIds.add(sess.sessionId);
              changed = true;
            }
          }
        }
        if (!changed) return prevTabs;
        const merged = [...nextTabs, ...extraTabs];
        setActiveTabId((curr) => curr ?? merged[merged.length - 1]?.id ?? null);
        return merged;
      });
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [unlocked, hosts]);
  // Phone terminal screen: AI / snippets slide up over the terminal as drawers (one at a time).
  // Phone terminal screen: which tool is drawn up over the terminal. The AI opens as a full overlay;
  // the tools that are used *with* the terminal in view (snippets, keypad, history) open at half.
  const [terminalDrawer, setTerminalDrawer] = useState<TerminalDrawerKind | null>(null);
  const drawer = useBottomDrawer({ open: terminalDrawer, onClose: () => setTerminalDrawer(null), defaultDetent: terminalDrawer === 'assistant' ? 1 : 0.5 });
  const closeTerminalDrawerRef = useRef<(() => boolean) | null>(null);
  const [newConnNonce, setNewConnNonce] = useState(0);
  const [aiWidth, setAiWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('drx.ai.panel_width');
      if (saved) {
        const n = parseInt(saved, 10);
        if (Number.isFinite(n) && n >= 320 && n <= 1200) return n;
      }
    } catch {}
    return 420;
  });
  const [isResizingAi, setIsResizingAi] = useState(false);
  const aiWidthRef = useRef(aiWidth);
  aiWidthRef.current = aiWidth;

  const startAiResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingAi(true);

    const startX = e.clientX;
    const startW = aiWidthRef.current;
    let rafId = 0;
    let pendingWidth = startW;

    const apply = () => {
      rafId = 0;
      setAiWidth(pendingWidth);
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const maxAllowed = Math.max(380, window.innerWidth - 300);
      pendingWidth = Math.max(320, Math.min(maxAllowed, startW - deltaX));
      if (!rafId) {
        rafId = requestAnimationFrame(apply);
      }
    };

    const onMouseUp = () => {
      if (rafId) cancelAnimationFrame(rafId);
      setIsResizingAi(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      try {
        localStorage.setItem('drx.ai.panel_width', String(aiWidthRef.current));
      } catch {}
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);
  const [themeId, setThemeId] = useState(() => localStorage.getItem('drx.theme') ?? 'drexius');
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('drx.font') ?? 13));
  const [lineHeight, setLineHeight] = useState(() => Number(localStorage.getItem('drx.lineHeight') ?? 1.0));
  const [showThemes, setShowThemes] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [modal, setModal] = useState<{ host: Host | null } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');
  const [quickPos, setQuickPos] = useState<{ top: number; left: number }>({ top: 40, left: 200 });
  const quickBtnRef = useRef<HTMLButtonElement>(null);
  const [zen, setZen] = useState(() => localStorage.getItem('drx.zen') === '1');
  const [showRail, setShowRail] = useState(() => localStorage.getItem('drx.rail') === '1');
  const [showStatusBar, setShowStatusBar] = useState(() => localStorage.getItem('drx.status') === '1');
  const [broadcast, setBroadcast] = useState(false);
  const [showTerminalTools, setShowTerminalTools] = useState(() => localStorage.getItem('drx.terminalTools') === '1');
  const toggleTerminalTools = useCallback(() => {
    setShowTerminalTools((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('drx.terminalTools', next ? '1' : '0');
      } catch {}
      return next;
    });
  }, []);

  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const lastTerminalTab = useRef<string | null>(null);
  if (activeTab && activeTab.kind !== 'sftp') lastTerminalTab.current = activeTab.id;
  const terminalContext = mobile && activeTab?.kind === 'sftp' ? tabs.find(t => t.id === lastTerminalTab.current) : activeTab;
  const activePaneId = terminalContext?.activePaneId ?? null;
  const activePane = terminalContext?.panes.find((p) => p.id === activePaneId);
  const hostMap = useMemo(() => {
    const m = new Map(hosts.map((h) => [h.id, h]));
    m.set(LOCAL_HOST.id, LOCAL_HOST);
    return m;
  }, [hosts]);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const toast = useCallback((m: string) => { setToastMsg(m); setTimeout(() => setToastMsg((c) => (c === m ? null : c)), 2400); }, []);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | 'all'>(
    () => localStorage.getItem('drx.vault.active') ?? 'personal'
  );
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => (mobile ? 'appearance' : 'general'));
  const [returnToSettingsTab, setReturnToSettingsTab] = useState<SettingsTab | null>(null);

  const openFromSettings = useCallback((action: () => void, tab: SettingsTab) => {
    setReturnToSettingsTab(tab);
    setSettingsTab(tab);
    action();
  }, []);

  const handleReturnToSettings = useCallback(() => {
    if (returnToSettingsTab) {
      const tab = returnToSettingsTab;
      setReturnToSettingsTab(null);
      setSettingsTab(tab);
      setShowSettings(true);
    }
  }, [returnToSettingsTab]);

  const closePanel = useCallback(() => {
    if (returnToSettingsTab) {
      const tab = returnToSettingsTab;
      setPanel(null);
      setReturnToSettingsTab(null);
      setSettingsTab(tab);
      setShowSettings(true);
    } else if (mobile && mobilePage === 'hosts') {
      setPanel('hosts');
    } else {
      setPanel(null);
    }
  }, [returnToSettingsTab, mobile, mobilePage]);

  const [hostFabsVisible, setHostFabsVisible] = useState(true);
  const [uiPrefs, setUiPrefs] = useState<UiPreferences>(() => loadUiPreferences());
  const [shortcuts, setShortcuts] = useState<Record<string, ShortcutBinding>>(() => loadShortcuts());

  const handleUpdateUiPrefs = useCallback((next: UiPreferences) => {
    setUiPrefs(next);
    saveUiPreferences(next);
    if (!next.showAi) {
      setShowAI(false);
    }
  }, []);

  const handleUpdateShortcuts = useCallback((next: Record<string, ShortcutBinding>) => {
    setShortcuts(next);
    saveShortcuts(next);
  }, []);

  const [shareModal, setShareModal] = useState<{ initialTab?: 'share' | 'import' } | null>(null);
  const [showSerial, setShowSerial] = useState(false);
  const [showPairing, setShowPairing] = useState<{ initialTab?: 'share' | 'join' | 'devices' } | null>(null);
  const [showSshConfig, setShowSshConfig] = useState(false);
  const [showTailscale, setShowTailscale] = useState(false);
  const [showNetbird, setShowNetbird] = useState(false);
  const [showCloudSync, setShowCloudSync] = useState(false);
  const [cloudStatuses, setCloudStatuses] = useState<Record<string, CloudInstance>>(() => {
    try {
      return JSON.parse(localStorage.getItem('drx.cloud.statuses.v2') || '{}');
    } catch {
      return {};
    }
  });
  const [cloudRefreshing, setCloudRefreshing] = useState(false);

  const mergeCloudStatuses = useCallback((instances: CloudInstance[]) => {
    if (!instances.length) return;
    setCloudStatuses((prev) => {
      const next = { ...prev };
      for (const inst of instances) {
        next[`cloud:${inst.provider}:${inst.id}`] = inst;
        if (inst.ip) next[`ip:${inst.ip}`] = inst;
      }
      try {
        localStorage.setItem('drx.cloud.statuses.v2', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => { localStorage.setItem('drx.theme', themeId); }, [themeId]);
  useEffect(() => { localStorage.setItem('drx.font', String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem('drx.lineHeight', String(lineHeight)); }, [lineHeight]);
  useEffect(() => { localStorage.setItem('drx.zen', zen ? '1' : '0'); }, [zen]);
  useEffect(() => { localStorage.setItem('drx.rail', showRail ? '1' : '0'); }, [showRail]);
  useEffect(() => { localStorage.setItem('drx.status', showStatusBar ? '1' : '0'); }, [showStatusBar]);
  useEffect(() => { localStorage.setItem('drx.vault.active', activeVaultId); }, [activeVaultId]);

  const refresh = useCallback(async () => {
    const [h, s, k, tun, v] = await Promise.all([
      bridge.listHosts(),
      bridge.listSnippets(),
      bridge.listKeychain(),
      bridge.listTunnels(),
      bridge.listVaults(),
    ]);
    setHosts((prev) => (JSON.stringify(prev) === JSON.stringify(h) ? prev : h));
    setSnippets((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
    setKeychain((prev) => (JSON.stringify(prev) === JSON.stringify(k) ? prev : k));
    setTunnels((prev) => (JSON.stringify(prev) === JSON.stringify(tun) ? prev : tun));
    setVaults((prev) => (JSON.stringify(prev) === JSON.stringify(v) ? prev : v));
  }, []);
  useEffect(() => { if (unlocked) refresh(); }, [unlocked, refresh]);

  // Keep mobile hosts panel in sync with mobilePage
  useEffect(() => {
    if (mobile && mobilePage === 'hosts' && !panel) {
      setPanel('hosts');
    }
  }, [mobile, mobilePage, panel]);

  // Re-sync vault & UI on app resume (mobile or visibilitychange)
  useEffect(() => {
    if (!unlocked) return;
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        if (mobile && mobilePage === 'hosts' && !panel) {
          setPanel('hosts');
        }
      }
    };
    document.addEventListener('visibilitychange', handleResume);
    if (mobile) {
      window.addEventListener('focus', handleResume);
    }
    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      if (mobile) {
        window.removeEventListener('focus', handleResume);
      }
    };
  }, [unlocked, refresh, mobile, mobilePage]);

  const refreshCloudStatuses = useCallback(async (silent = false) => {
    if (!unlocked) return;
    const providers = new Set<CloudProviderId>();
    for (const h of hosts) {
      for (const t of h.tags) {
        if (t.startsWith('cloud:hetzner:')) providers.add('hetzner');
        else if (t.startsWith('cloud:digitalocean:')) providers.add('digitalocean');
        else if (t.startsWith('cloud:proxmox:')) providers.add('proxmox');
      }
    }
    if (providers.size === 0) return;
    setCloudRefreshing(true);
    try {
      const creds = await bridge.getCloudCredentials();
      const collected: CloudInstance[] = [];
      for (const p of providers) {
        try {
          if (p === 'hetzner' && creds.hetznerToken) {
            const list = await bridge.fetchCloudInstances('hetzner', creds.hetznerToken);
            collected.push(...list);
          } else if (p === 'digitalocean' && creds.digitaloceanToken) {
            const list = await bridge.fetchCloudInstances('digitalocean', creds.digitaloceanToken);
            collected.push(...list);
          } else if (p === 'proxmox' && creds.proxmoxToken && creds.proxmoxUrl) {
            const list = await bridge.fetchCloudInstances('proxmox', creds.proxmoxToken, creds.proxmoxUrl, creds.proxmoxInsecure);
            collected.push(...list);
          }
        } catch (err) {
          console.warn(`Cloud status refresh failed for ${p}:`, err);
        }
      }
      if (collected.length > 0) {
        mergeCloudStatuses(collected);
        if (!silent) toast('Updated live cloud power states');
      }
    } finally {
      setCloudRefreshing(false);
    }
  }, [unlocked, hosts, mergeCloudStatuses, toast]);

  const initialCloudPollDoneRef = useRef(false);
  useEffect(() => {
    if (!unlocked) {
      initialCloudPollDoneRef.current = false;
      return;
    }
    if (hosts.length === 0 || initialCloudPollDoneRef.current) return;
    if (hosts.some((h) => h.tags.some((t) => t.startsWith('cloud:')))) {
      initialCloudPollDoneRef.current = true;
      refreshCloudStatuses(true);
    }
  }, [unlocked, hosts, refreshCloudStatuses]);

  // Relay sync runs in the background only for a configured, unlocked vault.
  // No silent success toast: errors remain available in Sync Status for retry.
  useEffect(() => {
    if (!unlocked || !isTauri) return;
    let active = true;
    let running = false;
    const tick = async () => {
      if (!active || running || document.hidden || !navigator.onLine) return;
      running = true;
      try {
        const st = await bridge.syncStatus();
        if (st.enabled) {
          await bridge.syncNow();
          if (active) await refresh();
        }
      } catch (e) {
        console.warn('Background relay sync failed (retrying later)', e);
      } finally { running = false; }
    };
    const first = setTimeout(tick, 5000);
    const interval = setInterval(tick, 60_000);
    window.addEventListener('focus', tick);
    window.addEventListener('online', tick);
    return () => {
      active = false;
      clearTimeout(first);
      clearInterval(interval);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [unlocked, refresh]);

  // ── Tabs / panes ──
  const openHost = useCallback((h: Host) => {
    if (h.id && h.id !== LOCAL_HOST.id) {
      markHostRecent(h.id);
    }
    const pane: Pane = { id: uid(), hostId: h.id, resume: false };
    const tab: Tab = { id: uid(), title: h.label, color: h.color, panes: [pane], layout: 'single', activePaneId: pane.id };
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setQuick(false);
    setPanel(null);
    setShowAI(false);
    setNewConnNonce((n) => n + 1);
    setMobilePage('terminals');
  }, [markHostRecent]);

  const openLocalTerminal = useCallback(() => {
    const pane: Pane = { id: uid(), hostId: LOCAL_HOST.id, isLocal: true };
    const tab: Tab = {
      id: uid(),
      title: 'Local Shell',
      color: '#22d3ee',
      panes: [pane],
      layout: 'single',
      activePaneId: pane.id,
    };
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setQuick(false);
    setPanel(null);
    setShowAI(false);
    setNewConnNonce((n) => n + 1);
    setMobilePage('terminals');
  }, []);

  const openTerminalWithCommand = useCallback((targetHost: Host, command: string, title?: string) => {
    const isLocal = targetHost.id === LOCAL_HOST.id;
    const pane: Pane = {
      id: uid(),
      hostId: targetHost.id,
      isLocal,
      startupCommand: command,
    };
    const tab: Tab = {
      id: uid(),
      title: title || `${targetHost.label}`,
      color: targetHost.color || (isLocal ? '#22d3ee' : '#38bdf8'),
      panes: [pane],
      layout: 'single',
      activePaneId: pane.id,
    };
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setQuick(false);
    setPanel(null);
    setShowAI(false);
    setNewConnNonce((n) => n + 1);
    setMobilePage('terminals');
  }, []);

  const handleConnectSerial = useCallback((opts: { portName: string; baudRate: number; dataBits: number; parity: string; stopBits: number; flowControl: string }) => {
    const shortName = opts.portName.split('/').pop()?.split('\\').pop() || opts.portName;
    const idSafe = opts.portName.replace(/[^a-zA-Z0-9]/g, '_');
    const serialHost: Host = {
      id: `serial_${idSafe}`,
      label: `Serial ${shortName}`,
      hostname: opts.portName,
      port: opts.baudRate,
      username: 'serial',
      authMethod: 'agent',
      tags: ['serial', `${opts.baudRate}`],
      hasSecret: true,
      os: 'linux',
      color: '#f59e0b',
      vaultId: activeVaultId === 'all' ? 'personal' : activeVaultId,
    };
    const pane: Pane = {
      id: uid(),
      hostId: serialHost.id,
      kind: 'serial',
      serialOptions: {
        portName: opts.portName,
        baudRate: opts.baudRate,
        dataBits: opts.dataBits,
        parity: opts.parity as 'none' | 'odd' | 'even',
        stopBits: opts.stopBits === 2 ? 2 : 1,
        flowControl: opts.flowControl as 'none' | 'software' | 'hardware',
      },
    };
    const summary = `${opts.dataBits}/${opts.parity[0].toUpperCase()}/${opts.stopBits}`;
    const tab: Tab = {
      id: uid(),
      title: `⚡ ${shortName} (${opts.baudRate} ${summary})`,
      color: '#f59e0b',
      panes: [pane],
      layout: 'single',
      activePaneId: pane.id,
    };
    setHosts((prev) => (prev.some((h) => h.id === serialHost.id) ? prev : [serialHost, ...prev]));
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setQuick(false);
    setPanel(null);
    setShowAI(false);
    setNewConnNonce((n) => n + 1);
    setMobilePage('terminals');
    toast(`Opened serial ${opts.portName} @ ${opts.baudRate} baud ${summary}`);
  }, [activeVaultId, toast]);

  const handleCreateVault = useCallback(async (v: Vault) => {
    await bridge.saveVault(v);
    await refresh();
    toast(`Vault "${v.name}" created`);
  }, [refresh, toast]);

  const handleDeleteVault = useCallback(async (id: string) => {
    await bridge.deleteVault(id);
    if (activeVaultId === id) setActiveVaultId('personal');
    await refresh();
    toast('Vault deleted');
  }, [activeVaultId, refresh, toast]);

  const handleQuickConnectSsh = useCallback((target: { username: string; hostname: string; port: number }) => {
    const existing = hosts.find(
      (h) => h.hostname === target.hostname && h.username === target.username && h.port === target.port
    );
    if (existing) {
      openHost(existing);
      return;
    }
    const newHost: Host = {
      id: uid(),
      label: `${target.username}@${target.hostname}${target.port !== 22 ? `:${target.port}` : ''}`,
      hostname: target.hostname,
      port: target.port,
      username: target.username,
      authMethod: 'password',
      tags: ['quick'],
      hasSecret: false,
      color: '#22d3ee',
      vaultId: activeVaultId === 'all' ? 'personal' : activeVaultId,
    };
    setModal({ host: newHost });
  }, [hosts, openHost, activeVaultId]);

  const splitPaneInDirection = useCallback(
    (direction: 'right' | 'down' | 'left' | 'up', hostToUse?: Host) => {
      const h = hostToUse || (activePane ? hostMap.get(activePane.hostId) : undefined) || LOCAL_HOST;
      if (h.id && h.id !== LOCAL_HOST.id) {
        markHostRecent(h.id);
      }
      if (!activeTab || activeTab.kind === 'sftp') return openHost(h);
      if (activeTab.panes.length >= 4) {
        toast('Maximum 4 panes per tab');
        return;
      }

      if (maximizedPaneId) {
        setMaximizedPaneId(null);
      }
      const newPane: Pane = { id: uid(), hostId: h.id, isLocal: h.id === LOCAL_HOST.id };
      const currentPanes = activeTab.panes;
      const activeIdx = Math.max(0, currentPanes.findIndex((p) => p.id === activeTab.activePaneId));

      let nextLayout: Layout = activeTab.layout;
      let nextPanes: Pane[] = [...currentPanes];

      if (currentPanes.length === 1) {
        if (direction === 'right') {
          nextPanes = [currentPanes[0], newPane];
          nextLayout = 'vertical';
        } else if (direction === 'left') {
          nextPanes = [newPane, currentPanes[0]];
          nextLayout = 'vertical';
        } else if (direction === 'down') {
          nextPanes = [currentPanes[0], newPane];
          nextLayout = 'horizontal';
        } else if (direction === 'up') {
          nextPanes = [newPane, currentPanes[0]];
          nextLayout = 'horizontal';
        }
      } else if (currentPanes.length === 2) {
        if (activeTab.layout === 'vertical') {
          if (direction === 'down' || direction === 'up') {
            if (activeIdx === 0) {
              nextLayout = 'main-right';
              const insertIdx = direction === 'down' ? 1 : 0;
              nextPanes.splice(insertIdx, 0, newPane);
            } else {
              nextLayout = 'main-left';
              const insertIdx = direction === 'down' ? 2 : 1;
              nextPanes.splice(insertIdx, 0, newPane);
            }
          } else {
            nextLayout = '3-columns';
            const insertIdx = direction === 'right' ? activeIdx + 1 : activeIdx;
            nextPanes.splice(insertIdx, 0, newPane);
          }
        } else if (activeTab.layout === 'horizontal') {
          if (direction === 'right' || direction === 'left') {
            if (activeIdx === 0) {
              nextLayout = 'main-bottom';
              const insertIdx = direction === 'right' ? 1 : 0;
              nextPanes.splice(insertIdx, 0, newPane);
            } else {
              nextLayout = 'main-top';
              const insertIdx = direction === 'right' ? 2 : 1;
              nextPanes.splice(insertIdx, 0, newPane);
            }
          } else {
            nextLayout = '3-rows';
            const insertIdx = direction === 'down' ? activeIdx + 1 : activeIdx;
            nextPanes.splice(insertIdx, 0, newPane);
          }
        } else {
          nextLayout = 'main-left';
          nextPanes.push(newPane);
        }
      } else if (currentPanes.length === 3) {
        if (activeTab.layout === '3-columns' && (direction === 'right' || direction === 'left')) {
          nextLayout = '4-columns';
          const insertIdx = direction === 'right' ? activeIdx + 1 : activeIdx;
          nextPanes.splice(insertIdx, 0, newPane);
        } else {
          nextLayout = 'grid';
          const insertIdx = direction === 'right' || direction === 'down' ? activeIdx + 1 : activeIdx;
          nextPanes.splice(insertIdx, 0, newPane);
        }
      }

      setTabs((ts) =>
        ts.map((t) =>
          t.id !== activeTab.id
            ? t
            : {
                ...t,
                panes: nextPanes,
                layout: nextLayout,
                activePaneId: newPane.id,
                title: t.panes.length ? `${t.title.split(' +')[0]} +${nextPanes.length - 1}` : h.label,
              }
        )
      );
      toast(`Split ${direction} with ${h.label}`);
    },
    [activeTab, activePane, hostMap, openHost, toast]
  );

  const splitWith = useCallback(
    (h: Host, pref?: Layout) => {
      splitPaneInDirection(pref === 'horizontal' ? 'down' : 'right', h);
    },
    [splitPaneInDirection]
  );

  const changeActiveTabLayout = useCallback(
    (newLayout: Layout) => {
      if (!activeTab || activeTab.kind === 'sftp') return;
      if (maximizedPaneId) {
        setMaximizedPaneId(null);
      }
      setTabs((ts) => ts.map((t) => (t.id === activeTab.id ? { ...t, layout: newLayout } : t)));
      toast(`Switched layout: ${getLayoutDescription(newLayout)}`);
    },
    [activeTab, toast]
  );

  const applyLayoutPreset = useCallback(
    (preset: LayoutPreset) => {
      const currentHost = activePane ? hostMap.get(activePane.hostId) : LOCAL_HOST;
      const newPanes: Pane[] = preset.panes.map((pp: LayoutPresetPane) => {
        let hostId = pp.hostId;
        let isLocal = pp.isLocal;
        if (hostId === '__current__') {
          hostId = currentHost?.id ?? LOCAL_HOST.id;
          isLocal = hostId === LOCAL_HOST.id;
        }
        if (hostId !== LOCAL_HOST.id && !hostMap.has(hostId)) {
          hostId = LOCAL_HOST.id;
          isLocal = true;
        }
        return {
          id: uid(),
          hostId,
          isLocal: isLocal ?? (hostId === LOCAL_HOST.id),
        };
      });

      const tab: Tab = {
        id: uid(),
        title: preset.name,
        color: theme.accent,
        panes: newPanes,
        layout: preset.layout,
        activePaneId: newPanes[0]?.id ?? '',
      };

      setTabs((ts) => [...ts, tab]);
      setActiveTabId(tab.id);
      setNewConnNonce((n) => n + 1);
      toast(`Loaded preset: ${preset.name} (${newPanes.length} panes)`);
    },
    [activePane, hostMap, theme, toast]
  );

  const handleSavePreset = () => {
    if (!activeTab || activeTab.panes.length < 2) return;
    const name = presetNameInput.trim() || `Workspace ${userPresets.length + 1}`;
    const newPreset = createUserPreset(name, activeTab.layout, activeTab.panes, hostMap);
    const updated = [newPreset, ...userPresets];
    setUserPresets(updated);
    saveUserLayoutPresets(updated);
    setShowSavePresetModal(false);
    setPresetNameInput('');
    toast(`Saved layout preset: ${name}`);
  };

  const handleDeletePreset = (id: string, name: string) => {
    const updated = userPresets.filter((p) => p.id !== id);
    setUserPresets(updated);
    saveUserLayoutPresets(updated);
    toast(`Deleted preset: ${name}`);
  };

  const toggleMaximizePane = useCallback((paneId?: string) => {
    setMaximizedPaneId((prev) => {
      if (paneId) {
        return prev === paneId ? null : paneId;
      }
      const cur = activeTab?.activePaneId;
      if (!cur) return null;
      return prev ? null : cur;
    });
  }, [activeTab]);

  useEffect(() => {
    if (!activeTab || activeTab.panes.length <= 1) {
      if (maximizedPaneId !== null) setMaximizedPaneId(null);
    } else if (maximizedPaneId !== null && !activeTab.panes.some((p) => p.id === maximizedPaneId)) {
      setMaximizedPaneId(null);
    }
  }, [activeTab, maximizedPaneId]);

  const navigateSplitDirection = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
    if (!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length <= 1) return;
    const nextPaneId = getAdjacentPaneId(activeTab.activePaneId, activeTab.panes, activeTab.layout, direction);
    if (nextPaneId && nextPaneId !== activeTab.activePaneId) {
      setTabs((ts) => ts.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: nextPaneId } : t)));
      const live = registry.get(nextPaneId);
      if (live?.term) {
        live.term.focus();
      }
      if (maximizedPaneId) {
        setMaximizedPaneId(nextPaneId);
      }
    }
  }, [activeTab, maximizedPaneId]);

  const swapPanes = useCallback(
    (tabId: string, paneIdA: string, paneIdB: string) => {
      if (paneIdA === paneIdB) return;
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== tabId) return t;
          const idxA = t.panes.findIndex((p) => p.id === paneIdA);
          const idxB = t.panes.findIndex((p) => p.id === paneIdB);
          if (idxA === -1 || idxB === -1) return t;
          const nextPanes = [...t.panes];
          const temp = nextPanes[idxA];
          nextPanes[idxA] = nextPanes[idxB];
          nextPanes[idxB] = temp;
          return {
            ...t,
            panes: nextPanes,
            activePaneId: paneIdA,
          };
        })
      );
      const hostA = activeTab?.panes.find((p) => p.id === paneIdA)?.hostId;
      const hostB = activeTab?.panes.find((p) => p.id === paneIdB)?.hostId;
      const labelA = hostA ? (hostA === LOCAL_HOST.id ? 'Local Terminal' : hostMap.get(hostA)?.label || 'Pane') : 'Pane';
      const labelB = hostB ? (hostB === LOCAL_HOST.id ? 'Local Terminal' : hostMap.get(hostB)?.label || 'Pane') : 'Pane';
      toast(`Swapped ${labelA} ↔ ${labelB}`);
      setTimeout(() => {
        try {
          window.dispatchEvent(new Event('resize'));
          registry.get(paneIdA)?.term?.focus();
        } catch {}
      }, 50);
    },
    [activeTab, hostMap, toast]
  );

  const swapSplitDirection = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      if (!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length <= 1) return;
      const currentId = activeTab.activePaneId;
      const targetId = getAdjacentPaneId(currentId, activeTab.panes, activeTab.layout, direction);
      if (targetId && targetId !== currentId) {
        swapPanes(activeTab.id, currentId, targetId);
      }
    },
    [activeTab, swapPanes]
  );

  const cleanupPaneSession = useCallback((p: Pane) => {
    bridge.sftpClose(p.id).catch(() => {});
    const sid =
      registry.get(p.id)?.sessionId ||
      p.sessionId ||
      (() => {
        try { return localStorage.getItem('drx.pane.sid.' + p.id); } catch { return null; }
      })();
    try { localStorage.removeItem('drx.pane.sid.' + p.id); } catch {}
    if (!sid) return;
    if (p.kind === 'serial') {
      bridge.closeSerial(sid).catch(() => {});
    } else if (p.isLocal) {
      bridge.closeLocalPty(sid).catch(() => {});
    } else {
      bridge.disconnect(sid).catch(() => {});
    }
  }, []);

  const closePane = useCallback((tabId: string, paneId: string) => {
    setMaximizedPaneId((prev) => (prev === paneId ? null : prev));
    setTabs((ts) => {
      return ts.map((t) => {
        if (t.id !== tabId) return t;
        const closing = t.panes.find((p) => p.id === paneId);
        if (closing) cleanupPaneSession(closing);
        const panes = t.panes.filter((p) => p.id !== paneId);
        return {
          ...t,
          panes,
          layout: layoutFor(panes.length, t.layout),
          activePaneId: t.activePaneId === paneId ? panes[0]?.id ?? '' : t.activePaneId,
          title: panes.length > 1 ? `${t.title.split(' +')[0]} +${panes.length - 1}` : hostMap.get(panes[0]?.hostId ?? '')?.label ?? t.title,
        };
      }).filter((t) => t.panes.length);
    });
  }, [hostMap, cleanupPaneSession]);

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const target = ts[i];
      if (target) {
        if (target.kind === 'sftp' && target.sftpSessionId) {
          bridge.sftpClose(target.sftpSessionId).catch(() => {});
        }
        target.panes.forEach((p) => cleanupPaneSession(p));
      }
      const remaining = ts.filter((t) => t.id !== id);
      setActiveTabId((curr) => (curr === id ? remaining[Math.max(0, i - 1)]?.id ?? null : curr));
      return remaining;
    });
  }, [cleanupPaneSession]);

  const openSftpTab = useCallback((hostId?: string) => {
    setMobilePage('sftp');
    if (mobile) { setPanel(null); setShowAI(false); }
    const existing = tabs.find((t) => t.kind === 'sftp');
    if (existing) {
      setActiveTabId(existing.id);
      if (hostId && existing.sftpHostId !== hostId) {
        const h = hostMap.get(hostId);
        setTabs((ts) =>
          ts.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  sftpHostId: hostId,
                  sftpSessionId: null,
                  title: h ? `SFTP: ${h.label}` : 'SFTP',
                }
              : t
          )
        );
      }
      return;
    }
    const h = hostId ? hostMap.get(hostId) : undefined;
    const newTab: Tab = {
      id: uid(),
      title: h ? `SFTP: ${h.label}` : 'SFTP',
      kind: 'sftp',
      sftpHostId: hostId || null,
      panes: [],
      layout: 'single',
      activePaneId: '',
    };
    setTabs((ts) => [...ts, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs, hostMap, mobile]);

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((ts) => ts.map((t) => (t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t)));
  }, []);

  // Phone host list: tapping a host that already has a live session returns to that
  // session (Termius behaviour); a second session is an explicit action in the host sheet.
  const resumeOrOpenHost = useCallback((h: Host) => {
    if (mobile) {
      for (const t of tabs) {
        if (t.kind === 'sftp') continue;
        const p = t.panes.find((p) => p.hostId === h.id && !p.isLocal && ['connected', 'connecting'].includes(registry.get(p.id)?.status ?? ''));
        if (p) {
          setActiveTabId(t.id); focusPane(t.id, p.id);
          setPanel(null); setShowAI(false); setQuick(false); setMobilePage('terminals');
          return;
        }
      }
    }
    openHost(h);
  }, [mobile, tabs, openHost, focusPane]);

  const openTermuxPreset = useCallback(() => {
    const existing = hosts.find(
      (h) =>
        h.port === 8022 &&
        (h.hostname.trim() === '127.0.0.1' || h.hostname.trim().toLowerCase() === 'localhost')
    );
    if (existing) {
      setSessionSheet(false);
      setQuick(false);
      resumeOrOpenHost(existing);
      return;
    }
    setSessionSheet(false);
    setQuick(false);
    setModal({
      host: {
        id: uid(),
        label: 'Termux (Local)',
        hostname: '127.0.0.1',
        port: 8022,
        username: 'termux',
        authMethod: 'password',
        keychainId: null,
        jumpHostId: null,
        group: 'Local',
        tags: ['termux', 'local'],
        color: '#4ade80',
        hasSecret: false,
        os: 'android',
        vaultId: activeVaultId === 'all' ? 'personal' : activeVaultId,
        startupCommand: '',
      },
    });
  }, [hosts, resumeOrOpenHost, activeVaultId]);

  useEffect(() => {
    if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[tabs.length - 1]?.id ?? null);
    }
  }, [tabs, activeTabId]);

  const filteredHosts = useMemo(() => {
    if (!quickFilter.trim()) return hosts;
    const q = quickFilter.toLowerCase().trim();
    return hosts.filter(
      (h) =>
        h.label.toLowerCase().includes(q) ||
        h.hostname.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q)
    );
  }, [hosts, quickFilter]);

  const toggleQuick = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setQuick((prev) => {
      const next = !prev;
      if (next && quickBtnRef.current) {
        const rect = quickBtnRef.current.getBoundingClientRect();
        setQuickPos({
          top: rect.bottom + 6,
          left: Math.min(Math.max(8, rect.left), window.innerWidth - 300),
        });
        setQuickFilter('');
      }
      return next;
    });
  }, []);

  const handlePaneData = useCallback(
    (tabId: string, sourcePaneId: string, data: string) => {
      if (!broadcast) return;
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || tab.panes.length <= 1) return;
      for (const p of tab.panes) {
        if (p.id === sourcePaneId) continue;
        const reg = registry.get(p.id);
        if (reg?.sessionId) {
          if (p.kind === 'serial') {
            bridge.writeSerial(reg.sessionId, data);
          } else if (p.isLocal) {
            bridge.writeLocalPty(reg.sessionId, data);
          } else {
            bridge.write(reg.sessionId, data);
          }
        }
      }
    },
    [broadcast, tabs]
  );

  // ── Shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // An open confirm sheet owns Escape (it cancels itself); don't tear down the panel under it.
        if (hasPendingConfirm()) return;
        // A terminal-screen drawer (AI / snippets) is the topmost layer on mobile: Escape dismisses it first.
        if (closeTerminalDrawerRef.current?.()) { e.preventDefault(); e.stopPropagation(); return; }
        if (quick || showThemes || panel || modal || showAutoLockMenu || showDockerModal || splitMenu || showSettings || showSavePresetModal) {
          e.preventDefault();
          e.stopPropagation();
          setQuick(false);
          setShowThemes(false);
          setPanel(null);
          setModal(null);
          setShowAutoLockMenu(false);
          setShowDockerModal(false);
          setSplitMenu(null);
          setShowSettings(false);
          setShowSavePresetModal(false);
        }
        return;
      }
      const target = e.target as HTMLElement | null;

      // ── Never intercept when shortcut recorder is active ──
      if (target && target.closest('[data-shortcut-recorder]')) return;

      // ── When settings modal is open, don't execute background workspace shortcuts ──
      if (showSettings) {
        if (matchesShortcut(e, shortcuts.open_settings?.keys || 'Ctrl+,')) {
          e.preventDefault();
          e.stopPropagation();
          setShowSettings(false);
        }
        return;
      }

      // xterm's hidden textarea is a terminal surface, not a text input: the
      // Ctrl+Shift+* workspace shortcuts must keep working while a terminal
      // has focus (the TerminalPane also blocks those sequences from leaking
      // to the shell). Plain Ctrl+T/Ctrl+K stay with the shell (^T transpose,
      // ^K kill-line) when the terminal is focused.
      const inTerminal = !!(target && target.closest && target.closest('.xterm'));
      const isInput = target && !inTerminal && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput) return;

      // ── Directional Split Swap / Move (Alt+Shift+Arrow) ──
      if (matchesShortcut(e, shortcuts.swap_split_left?.keys || 'Alt+Shift+ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('left');
        return;
      }
      if (matchesShortcut(e, shortcuts.swap_split_right?.keys || 'Alt+Shift+ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('right');
        return;
      }
      if (matchesShortcut(e, shortcuts.swap_split_up?.keys || 'Alt+Shift+ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('up');
        return;
      }
      if (matchesShortcut(e, shortcuts.swap_split_down?.keys || 'Alt+Shift+ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        swapSplitDirection('down');
        return;
      }

      // ── Directional Split Navigation ──
      if (matchesShortcut(e, shortcuts.focus_split_left?.keys || 'Alt+ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('left');
        return;
      }
      if (matchesShortcut(e, shortcuts.focus_split_right?.keys || 'Alt+ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('right');
        return;
      }
      if (matchesShortcut(e, shortcuts.focus_split_up?.keys || 'Alt+ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('up');
        return;
      }
      if (matchesShortcut(e, shortcuts.focus_split_down?.keys || 'Alt+ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        navigateSplitDirection('down');
        return;
      }

      // ── Open Settings (Ctrl/Cmd + ,) ──
      if (matchesShortcut(e, shortcuts.open_settings?.keys || 'Ctrl+,')) {
        e.preventDefault();
        e.stopPropagation();
        setShowSettings((v) => !v);
        return;
      }

      // ── Close Active Split Pane (Ctrl+Shift+W) ──
      if (matchesShortcut(e, shortcuts.close_pane?.keys || 'Ctrl+Shift+W')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          closePane(activeTab.id, activeTab.activePaneId);
          return;
        }
      }

      // ── Toggle Maximize / Zoom Active Split Pane (Ctrl+Shift+M) ──
      if (matchesShortcut(e, shortcuts.maximize_pane?.keys || 'Ctrl+Shift+M')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          toggleMaximizePane();
          return;
        }
      }

      // ── Next / Previous Split Pane (Ctrl+] / Ctrl+[) ──
      if (matchesShortcut(e, shortcuts.next_pane?.keys || 'Ctrl+]')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          const idx = activeTab.panes.findIndex((p) => p.id === activeTab.activePaneId);
          const nextIdx = (idx + 1) % activeTab.panes.length;
          const nextP = activeTab.panes[nextIdx];
          if (nextP) {
            setTabs((ts) => ts.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: nextP.id } : t)));
            registry.get(nextP.id)?.term?.focus();
            if (maximizedPaneId) {
              setMaximizedPaneId(nextP.id);
            }
          }
          return;
        }
      }
      if (matchesShortcut(e, shortcuts.prev_pane?.keys || 'Ctrl+[')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          const idx = activeTab.panes.findIndex((p) => p.id === activeTab.activePaneId);
          const prevIdx = (idx - 1 + activeTab.panes.length) % activeTab.panes.length;
          const prevP = activeTab.panes[prevIdx];
          if (prevP) {
            setTabs((ts) => ts.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: prevP.id } : t)));
            registry.get(prevP.id)?.term?.focus();
            if (maximizedPaneId) {
              setMaximizedPaneId(prevP.id);
            }
          }
          return;
        }
      }

      // ── New Local Terminal (Ctrl+T) ──
      if (matchesShortcut(e, shortcuts.new_terminal?.keys || 'Ctrl+T')) {
        if (!inTerminal) {
          e.preventDefault();
          e.stopPropagation();
          openLocalTerminal();
          return;
        }
      }

      // ── Quick Connect / Palette (Ctrl+K) ──
      if (matchesShortcut(e, shortcuts.open_quick?.keys || 'Ctrl+K') || (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        if (!inTerminal || e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleQuick();
          return;
        }
      }

      // ── Cluster Broadcast (Ctrl+Shift+I) ──
      if (matchesShortcut(e, shortcuts.toggle_broadcast?.keys || 'Ctrl+Shift+I')) {
        e.preventDefault();
        e.stopPropagation();
        setBroadcast((b) => {
          const next = !b;
          toast(next ? '⚡ Broadcast Cluster Mode: ON (Input sent to all panes in tab)' : 'Broadcast Cluster Mode: OFF');
          return next;
        });
        return;
      }

      // ── Split Pane Vertical / Right (Ctrl+Shift+D) ──
      if (matchesShortcut(e, shortcuts.split_vertical?.keys || 'Ctrl+Shift+D')) {
        e.preventDefault();
        e.stopPropagation();
        setSplitMenu((prev) => (prev?.direction === 'right' && prev.tab === 'split' ? null : { tab: 'split', direction: 'right', pref: 'vertical', left: 400, top: 45 }));
        return;
      }

      // ── Split Pane Horizontal / Down (Ctrl+Shift+E) ──
      if (matchesShortcut(e, shortcuts.split_horizontal?.keys || 'Ctrl+Shift+E')) {
        e.preventDefault();
        e.stopPropagation();
        setSplitMenu((prev) => (prev?.direction === 'down' && prev.tab === 'split' ? null : { tab: 'split', direction: 'down', pref: 'horizontal', left: 430, top: 45 }));
        return;
      }

      // ── Open Layout & Presets Menu (Ctrl+Shift+L) ──
      if (matchesShortcut(e, shortcuts.open_layout_menu?.keys || 'Ctrl+Shift+L')) {
        e.preventDefault();
        e.stopPropagation();
        setSplitMenu((prev) => (prev?.tab === 'presets' ? null : { tab: 'presets', direction: 'right', pref: 'vertical', left: 460, top: 45 }));
        return;
      }

      // ── Save Layout Preset (Ctrl+Shift+S) ──
      if (matchesShortcut(e, shortcuts.save_layout_preset?.keys || 'Ctrl+Shift+S')) {
        if (activeTab && activeTab.panes.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          setPresetNameInput(activeTab.title || 'My Workspace');
          setShowSavePresetModal(true);
          return;
        }
      }

      // ── Toggle AI Assistant (Ctrl+Shift+A) ──
      if (matchesShortcut(e, shortcuts.toggle_ai?.keys || 'Ctrl+Shift+A')) {
        e.preventDefault();
        e.stopPropagation();
        setShowAI((v) => !v);
        return;
      }

      // ── Open SFTP Browser (Ctrl+Shift+F) ──
      if (matchesShortcut(e, shortcuts.open_sftp?.keys || 'Ctrl+Shift+F')) {
        e.preventDefault();
        e.stopPropagation();
        openSftpTab();
        return;
      }

      // ── Toggle Zen Mode (Ctrl+Shift+Z) ──
      if (matchesShortcut(e, shortcuts.toggle_zen?.keys || 'Ctrl+Shift+Z')) {
        e.preventDefault();
        e.stopPropagation();
        setZen((v) => !v);
        return;
      }

      // ── Toggle Sidebar Rail (Ctrl+Shift+B) ──
      if (matchesShortcut(e, shortcuts.toggle_rail?.keys || 'Ctrl+Shift+B')) {
        e.preventDefault();
        e.stopPropagation();
        setShowRail((v) => !v);
        return;
      }

      // ── Docker Manager (Ctrl+Shift+U or Alt+D) ──
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'u' || (e.altKey && e.key.toLowerCase() === 'd'))) {
        e.preventDefault();
        e.stopPropagation();
        const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
        setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
        setShowDockerModal((v) => !v);
        return;
      }

      // ── Toggle Status Bar (Ctrl+/) ──
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        e.stopPropagation();
        setShowStatusBar((v) => !v);
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    toggleQuick,
    openLocalTerminal,
    openSftpTab,
    broadcast,
    tabs,
    quick,
    showThemes,
    panel,
    modal,
    showAutoLockMenu,
    showDockerModal,
    splitMenu,
    showSettings,
    shortcuts,
    navigateSplitDirection,
    closePane,
    toggleMaximizePane,
    toast,
    terminalContext,
    activePaneId,
    activeTab,
  ]);

  // ── Hosts / snippets CRUD ──
  const saveHost = async (h: Host, s?: HostSecret, alreadySaved?: boolean) => {
    if (!alreadySaved) {
      await bridge.saveHost(h, s);
    }
    setModal(null);
    toast(`Saved ${h.label} to vault`);
    refresh();
  };
  const deleteHost = async (h: Host) => {
    if (await confirmDialog({ title: `Delete ${h.label}?`, message: 'Stored credentials for this host will be wiped from the vault.', confirmLabel: 'Delete host', danger: true })) {
      await bridge.deleteHost(h.id);
      refresh();
    }
  };
  const saveSnippet = async (s: Snippet) => { await bridge.saveSnippet(s); refresh(); toast('Snippet saved'); };
  const deleteSnippet = async (id: string) => { await bridge.deleteSnippet(id); refresh(); };

  const lock = async () => {
    tabs.forEach((t) => {
      if (t.kind === 'sftp' && t.sftpSessionId) {
        bridge.sftpClose(t.sftpSessionId).catch(() => {});
      }
      t.panes.forEach((p) => cleanupPaneSession(p));
    });
    try { localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch {}
    setTabs([]);
    setActiveTabId(null);
    await bridge.lock();
    setUnlocked(false);
  };

  // M6: auto-lock after a period with no user input (mouse, touch, scroll or key press in the app).
  // Only the vault is locked: root key cleared, tabs and SSH sessions left running, and the same
  // screen is shown on return. Terminal output doesn't count as input, so a long build can't keep it open.
  // The timeout is user-configurable (0 = off). It's stored in localStorage: it isn't secret, and the vault is locked at startup.
  const autoLock = async () => {
    await bridge.lock();
    setUnlocked(false);
  };

  useEffect(() => {
    if (!unlocked || autoLockMinutes <= 0) return;
    const AUTO_LOCK_MS = autoLockMinutes * 60 * 1000;
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;
    let timer: number | undefined;
    const arm = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void autoLock();
      }, AUTO_LOCK_MS);
    };
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, arm));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, autoLockMinutes]);

  // The app stays mounted while locked, so terminals, SSH sessions and open tabs survive a lock.
  // The lock screen covers it and the app is made inert, so nothing underneath can be focused or typed into.

  const live = registry.all();
  const connected = live.filter((p) => p.status === 'connected').length;
  const activeLive = activePaneId ? registry.get(activePaneId) : undefined;

  const rail = [
    { id: 'hosts', icon: Server, label: 'Hosts', on: panel === 'hosts', act: () => setPanel((p) => (p === 'hosts' ? null : 'hosts')) },
    { id: 'keychain', icon: KeyRound, label: 'Keychain (Identities)', on: panel === 'keychain', act: () => setPanel((p) => (p === 'keychain' ? null : 'keychain')) },
    ...(uiPrefs.showDocker ? [{
      id: 'docker',
      icon: showDockerModal ? Loader2 : Boxes,
      iconClass: showDockerModal ? 'animate-spin text-cyan-400' : undefined,
      label: showDockerModal ? 'Docker Containers (Opening…)' : 'Docker Containers (⌘⇧U)',
      on: showDockerModal,
      act: () => {
        const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
        setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
        setShowDockerModal((v) => !v);
      },
    }] : []),
    ...(uiPrefs.showTunnels ? [
      { id: 'tunnels', icon: Network, label: 'Port Forwarding (Tunnels)', on: panel === 'tunnels', act: () => setPanel((p) => (p === 'tunnels' ? null : 'tunnels')) },
    ] : []),
    ...(uiPrefs.showSnippets ? [
      { id: 'snippets', icon: Code2, label: 'Snippets', on: panel === 'snippets', act: () => setPanel((p) => (p === 'snippets' ? null : 'snippets')) },
    ] : []),
    { id: 'logs', icon: History, label: 'Session History & Audit', on: panel === 'logs', act: () => setPanel((p) => (p === 'logs' ? null : 'logs')) },
    { id: 'known_hosts', icon: ShieldCheck, label: 'Known Hosts', on: panel === 'known_hosts', act: () => setPanel((p) => (p === 'known_hosts' ? null : 'known_hosts')) },
    ...(uiPrefs.showSftp ? [
      { id: 'sftp', icon: HardDrive, label: 'SFTP (⌘⇧F)', on: activeTab?.kind === 'sftp', act: () => openSftpTab() },
    ] : []),
    ...(uiPrefs.showAi ? [
      { id: 'ai', icon: Sparkles, label: 'AI Assistant (⌘⇧A)', on: showAI, act: () => setShowAI((v) => !v) },
    ] : []),
  ];

  const navigateMobile = (page: MobilePage) => {
    if (page === 'settings') {
      setShowSettings(true);
      return;
    }
    setReturnToSettingsTab(null);
    setMobilePage(page);
    if (page === 'hosts') {
      setHostFabsVisible(true);
    }
    setTerminalDrawer(null);
    setPanel(page === 'hosts' ? 'hosts' : null);
    setShowAI(page === 'assistant');
    setSessionSheet(false);
    if (page === 'sftp') openSftpTab();
    if (page === 'terminals' && activeTab?.kind === 'sftp') {
      setActiveTabId(tabs.find(t => t.id === lastTerminalTab.current)?.id ?? tabs.find(t => t.kind !== 'sftp')?.id ?? null);
    }
    // Switching workspaces should not leave an invisible terminal keyboard open.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  const mobileWorkspaceVisible = mobilePage === 'terminals' || mobilePage === 'sftp';
  const terminalSessionCount = tabs.filter((t) => t.kind !== 'sftp').reduce((n, t) => n + t.panes.length, 0);
  // Phone terminal screen: only the terminal and its own bar — the bottom navigation gets out of the way.
  const terminalScreen = mobile && mobilePage === 'terminals' && terminalSessionCount > 0;
  const aiDrawerOpen = terminalScreen && terminalDrawer === 'assistant';
  const toolDrawer = terminalScreen && terminalDrawer && terminalDrawer !== 'assistant' ? terminalDrawer : null;
  const openDrawer = aiDrawerOpen || toolDrawer ? drawer : null;
  closeTerminalDrawerRef.current = openDrawer ? () => { openDrawer.requestClose(); return true; } : null;
  // The drawers only exist on the terminal screen; drop the state if it goes away underneath them
  // (last session closed, viewport grew past the mobile breakpoint).
  useEffect(() => { if (terminalDrawer && !terminalScreen) setTerminalDrawer(null); }, [terminalDrawer, terminalScreen]);
  // Half-open drawer: the terminal shrinks to the uncovered half; full / closed / closing: untouched.
  const terminalDrawerInset = openDrawer && !openDrawer.closing && openDrawer.detent < 1 ? openDrawer.detent : 0;
  const drawerBg = theme.xterm.background || '#0e131d';
  const aiVisible = unlocked && uiPrefs.showAi && (mobile ? (mobilePage === 'assistant' && showAI) || aiDrawerOpen : showAI);
  useEffect(() => {
    if (!terminalScreen || activeTab?.kind !== 'sftp') return;
    const t = tabs.find((t) => t.id === lastTerminalTab.current && t.panes.length) ?? [...tabs].reverse().find((t) => t.kind !== 'sftp' && t.panes.length);
    if (t) setActiveTabId(t.id);
  }, [terminalScreen, activeTab, tabs]);

  return (
    <>
    {showSplash && <LaunchSplash onFinished={() => setShowSplash(false)} />}
    {!unlocked && !showSplash && !directUnlocking && (
      <div className="fixed inset-0 z-[1000] overflow-auto bg-slate-950">
        <LockScreen onUnlocked={() => setUnlocked(true)}
          onJoinRequested={() => setShowPairing({ initialTab: 'join' })} theme={theme} />
      </div>
    )}
    <WorkspaceAccessContext.Provider value={unlocked}>
    <div
      inert={!unlocked}
      className={cn(
        "nx-app-shell flex h-screen w-screen flex-col overflow-hidden text-slate-200 selection:bg-cyan-400/30",
        !unlocked && "invisible"
      )}
      style={{ background: theme.xterm.background }}
    >
      {/* Top Header Bar — floating controls across the top */}
      {!zen && (
        <header className="max-md:hidden flex h-10 shrink-0 items-center gap-1.5 px-1 pt-1 pb-0.5 bg-transparent border-0 relative z-50">
          {/* Logo / Sidebar Toggle Button (replaces hamburger menu, aligned with rail below) */}
          <div className="flex w-12 shrink-0 items-center justify-center">
            <button
              onClick={() => setShowRail((v) => !v)}
              title={showRail ? 'Hide sidebar (⌘⇧B)' : 'Show sidebar (⌘⇧B)'}
              className={cn(
                'group relative grid h-8 w-8 place-items-center rounded-xl transition-all duration-200 cursor-pointer select-none',
                showRail
                  ? 'bg-cyan-500/15 border border-cyan-400/50 shadow-[0_0_16px_rgba(34,211,238,0.35)] hover:bg-cyan-500/25 hover:border-cyan-400/70 hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]'
                  : 'bg-white/[0.04] border border-white/10 opacity-70 hover:opacity-100 hover:bg-white/[0.08] hover:border-white/20'
              )}
            >
              <img
                src={drexiusLogo}
                alt="DrexiusTerminal"
                className="h-5.5 w-5.5 rounded-lg object-contain transition-transform duration-200 group-hover:scale-105 group-active:scale-95"
              />
            </button>
          </div>

          {/* Vault Switcher & Quick Hosts & SFTP buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <VaultMenu
              vaults={vaults}
              activeVaultId={activeVaultId}
              onSelectVault={setActiveVaultId}
              onCreateVault={handleCreateVault}
              onDeleteVault={handleDeleteVault}
              onOpenShareModal={() => setShareModal({ initialTab: 'share' })}
              onOpenImportModal={() => setShareModal({ initialTab: 'import' })}
              onOpenPairingModal={() => setShowPairing({ initialTab: 'share' })}
              theme={theme}
            />
            <button
              onClick={() => setPanel((p) => (p === 'hosts' ? null : 'hosts'))}
              title="Hosts / Vaults (⌘⇧K)"
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-all duration-150 border shadow-sm select-none',
                panel === 'hosts'
                  ? 'text-white'
                  : 'bg-white/[0.05] border-white/10 text-slate-300 hover:bg-white/[0.1] hover:text-white hover:border-white/20'
              )}
              style={
                panel === 'hosts'
                  ? {
                      backgroundColor: `${theme.accent}18`,
                      borderColor: `${theme.accent}45`,
                      boxShadow: `0 0 16px ${theme.accent}25`,
                    }
                  : undefined
              }
            >
              <Server className="h-3.5 w-3.5 transition-colors" style={{ color: panel === 'hosts' ? theme.accent : (theme?.accent || '#22d3ee') }} />
              <span className="font-semibold hidden sm:inline">Hosts</span>
            </button>
            {uiPrefs.showSftp && (
              <button
                onClick={() => openSftpTab()}
                title="SFTP File Browser (⌘⇧F)"
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-all duration-150 border shadow-sm select-none',
                  activeTab?.kind === 'sftp'
                    ? 'text-white'
                    : 'bg-white/[0.05] border-white/10 text-slate-300 hover:bg-white/[0.1] hover:text-white hover:border-white/20'
                )}
                style={
                  activeTab?.kind === 'sftp'
                    ? {
                        backgroundColor: `${theme.accent}18`,
                        borderColor: `${theme.accent}45`,
                        boxShadow: `0 0 16px ${theme.accent}25`,
                      }
                    : undefined
                }
              >
                <HardDrive className="h-3.5 w-3.5 transition-colors" style={{ color: activeTab?.kind === 'sftp' ? theme.accent : '#10b981' }} />
                <span className="font-semibold hidden sm:inline">SFTP</span>
              </button>
            )}
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 shrink-0" />

          {/* Floating Tabs */}
          <div
            onWheel={(e) => {
              if (e.deltaY !== 0) {
                e.currentTarget.scrollLeft += e.deltaY;
                e.preventDefault();
              }
            }}
            className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pl-0.5 py-0.5 select-none"
            style={{
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            {tabs.map((t) => {
              const isSftp = t.kind === 'sftp';
              const tabLive = t.panes.map((p) => registry.get(p.id)?.status);
              const dot = isSftp
                ? 'bg-cyan-400'
                : tabLive.includes('disconnected') || tabLive.includes('error')
                  ? 'bg-rose-500'
                  : tabLive.every((s) => s === 'connected')
                    ? 'bg-emerald-400'
                    : 'bg-amber-400';
              const isActive = t.id === activeTabId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTabId(t.id)}
                  className={cn(
                    'group relative flex h-7 min-w-[130px] max-w-[220px] cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs transition border shadow-sm select-none',
                    isActive
                      ? isSftp
                        ? 'border-cyan-500/40 bg-cyan-950/70 text-cyan-200 ring-1 ring-cyan-500/20'
                        : 'text-white font-medium border-transparent'
                      : 'border-white/5 bg-white/[0.03] text-slate-400 hover:border-white/10 hover:bg-white/[0.07] hover:text-slate-200'
                  )}
                  style={
                    isActive && !isSftp
                      ? {
                          backgroundColor: `${theme.accent}20`,
                          borderColor: `${theme.accent}50`,
                          boxShadow: `0 0 14px ${theme.accent}25`,
                        }
                      : undefined
                  }
                >
                  {isSftp ? (
                    <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  ) : (
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
                  )}
                  <span className="truncate font-medium">{t.title}</span>
                  {t.panes.length > 1 && (
                    maximizedPaneId && t.id === activeTabId ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMaximizePane();
                        }}
                        title="Tab is zoomed into single pane. Click to restore split view (Ctrl+Shift+M)"
                        className="flex items-center gap-1 rounded px-1.5 py-0.2 text-[9px] font-bold border border-cyan-400/40 bg-cyan-500/25 text-cyan-300 hover:bg-cyan-500/35 transition cursor-pointer"
                      >
                        <Minimize2 className="h-2.5 w-2.5" />
                        <span>ZOOMED</span>
                      </button>
                    ) : (
                      <span className="rounded bg-white/10 px-1 text-[9px] text-slate-400">{t.panes.length}</span>
                    )
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    title={`Close ${t.title}`}
                    className="ml-auto rounded p-0.5 text-slate-400 opacity-60 hover:bg-white/10 hover:text-white hover:opacity-100 transition z-10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <button
              ref={quickBtnRef}
              onClick={toggleQuick}
              title="Quick connect (⌘K / ⌘⇧K)"
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-all duration-150 border select-none',
                quick
                  ? 'text-white'
                  : 'text-slate-400 hover:text-white bg-white/[0.04] border-white/10 hover:bg-white/[0.08] hover:border-white/20'
              )}
              style={
                quick
                  ? {
                      backgroundColor: `${theme.accent}22`,
                      borderColor: `${theme.accent}60`,
                      boxShadow: `0 0 14px ${theme.accent}30`,
                      color: theme.accent,
                    }
                  : undefined
              }
            >
              <Plus className="h-3.5 w-3.5" style={{ color: quick ? theme.accent : undefined }} />
            </button>
          </div>

          {/* Floating Right Actions */}
          <div className="flex items-center gap-1 shrink-0">
            {uiPrefs.showLocalTerminal && (
              <button
                onClick={openLocalTerminal}
                title="New local shell (⌘T)"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/10 hover:text-cyan-300 transition"
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Local Shell</span>
              </button>
            )}
            {uiPrefs.showSerial && (
              <button
                onClick={() => setShowSerial(true)}
                title="Serial terminal (UART / RS-232)"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-amber-400/10 hover:text-amber-200 transition"
              >
                <Radio className="h-3.5 w-3.5 text-amber-400" />
                <span className="hidden sm:inline">Serial</span>
              </button>
            )}
            {uiPrefs.showDocker && (
              <button
                onClick={() => {
                  const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
                  setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
                  setShowDockerModal(true);
                }}
                title={showDockerModal ? "Docker Containers (Opening…)" : "Docker Containers (⌘⇧U)"}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition",
                  showDockerModal
                    ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-[0_0_10px_rgba(34,211,238,0.25)]"
                    : "text-slate-400 hover:bg-white/10 hover:text-cyan-300"
                )}
              >
                {showDockerModal ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                ) : (
                  <Boxes className="h-3.5 w-3.5 text-cyan-400" />
                )}
                <span className="hidden sm:inline">{showDockerModal ? 'Opening…' : 'Docker'}</span>
              </button>
            )}
            {activeTab && (activeTab.panes.length === 1 || (maximizedPaneId !== null && activeTab.id === activeTabId)) && (
              <div className="flex items-center gap-1 shrink-0">
                <div className="h-4 w-px bg-white/10 mx-0.5" />
                <button
                  onClick={toggleTerminalTools}
                  title={showTerminalTools ? 'Collapse terminal tools (Search, History, Clips)' : 'Expand terminal tools (Search, History, Clips)'}
                  className={cn(
                    'flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs transition border select-none',
                    showTerminalTools
                      ? 'border-transparent'
                      : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
                  )}
                  style={
                    showTerminalTools
                      ? {
                          backgroundColor: `${theme.accent}20`,
                          borderColor: `${theme.accent}50`,
                          color: theme.accent,
                          boxShadow: `0 0 10px ${theme.accent}20`,
                        }
                      : undefined
                  }
                >
                  {showTerminalTools ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <>
                      <ChevronLeft className="h-3.5 w-3.5" />
                      <Search className="h-3 w-3 opacity-60" />
                    </>
                  )}
                </button>
                {showTerminalTools && (
                  <div className="flex items-center gap-1 animate-in fade-in slide-in-from-right-2 duration-200">
                    <button
                      onClick={() => activeLive?.toggleSearch?.()}
                      title="Search buffer (⌘F / Ctrl+F)"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition"
                    >
                      <Search className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">Search</span>
                    </button>
                    <button
                      onClick={() => activeLive?.openHistory?.()}
                      title="Command History & Reverse Search (Ctrl+Shift+R)"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/10 hover:text-emerald-300 transition"
                    >
                      <History className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">History</span>
                    </button>
                    <button
                      onClick={() => activeLive?.openClipboard?.()}
                      title="Clipboard History (Ctrl+Shift+H / ⌘⇧H / ⌃⌥V)"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/10 hover:text-cyan-300 transition"
                    >
                      <Clipboard className="h-3.5 w-3.5" />
                      <span className="hidden md:inline">Clips</span>
                    </button>
                  </div>
                )}
                <div className="h-4 w-px bg-white/10 mx-0.5" />
              </div>
            )}
            {maximizedPaneId && activeTab && activeTab.panes.length > 1 && (
              <button
                type="button"
                onClick={() => toggleMaximizePane()}
                title="Restore split layout (Ctrl+Shift+M)"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold border border-cyan-400/50 bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 shadow-[0_0_12px_rgba(34,211,238,0.25)] transition animate-in fade-in duration-150 cursor-pointer"
              >
                <Minimize2 className="h-3.5 w-3.5 text-cyan-300" />
                <span className="hidden sm:inline">Restore Splits</span>
              </button>
            )}
            <button
              title="Split vertical (⌘⇧D)"
              disabled={!activeTab || (activeTab?.panes.length ?? 0) >= 4}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setSplitMenu((prev) => (prev?.tab === 'split' && prev.direction === 'right' ? null : { tab: 'split', direction: 'right', pref: 'vertical', left: rect.left, top: rect.bottom + 6 }));
              }}
              className={cn(
                'grid h-7 w-7 place-items-center rounded-lg transition border disabled:opacity-30',
                splitMenu?.tab === 'split' && splitMenu.direction === 'right' ? 'text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
              )}
              style={
                splitMenu?.tab === 'split' && splitMenu.direction === 'right'
                  ? {
                      backgroundColor: `${theme.accent}20`,
                      borderColor: `${theme.accent}60`,
                      color: theme.accent,
                      boxShadow: `0 0 12px ${theme.accent}25`,
                    }
                  : undefined
              }
            >
              <Columns2 className="h-3.5 w-3.5" style={{ color: splitMenu?.tab === 'split' && splitMenu.direction === 'right' ? theme.accent : undefined }} />
            </button>
            <button
              title="Split horizontal (⌘⇧E)"
              disabled={!activeTab || (activeTab?.panes.length ?? 0) >= 4}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setSplitMenu((prev) => (prev?.tab === 'split' && prev.direction === 'down' ? null : { tab: 'split', direction: 'down', pref: 'horizontal', left: rect.left, top: rect.bottom + 6 }));
              }}
              className={cn(
                'grid h-7 w-7 place-items-center rounded-lg transition border disabled:opacity-30',
                splitMenu?.tab === 'split' && splitMenu.direction === 'down' ? 'text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
              )}
              style={
                splitMenu?.tab === 'split' && splitMenu.direction === 'down'
                  ? {
                      backgroundColor: `${theme.accent}20`,
                      borderColor: `${theme.accent}60`,
                      color: theme.accent,
                      boxShadow: `0 0 12px ${theme.accent}25`,
                    }
                  : undefined
              }
            >
              <Rows2 className="h-3.5 w-3.5" style={{ color: splitMenu?.tab === 'split' && splitMenu.direction === 'down' ? theme.accent : undefined }} />
            </button>
            <button
              title="Layout Presets & Switcher (⌘⇧L)"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setSplitMenu((prev) => (prev?.tab === 'presets' || prev?.tab === 'layout' ? null : { tab: (activeTab?.panes.length ?? 0) > 1 ? 'layout' : 'presets', direction: 'right', pref: 'vertical', left: rect.left, top: rect.bottom + 6 }));
              }}
              className={cn(
                'grid h-7 w-7 place-items-center rounded-lg transition border',
                splitMenu?.tab === 'presets' || splitMenu?.tab === 'layout' ? 'text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
              )}
              style={
                splitMenu?.tab === 'presets' || splitMenu?.tab === 'layout'
                  ? {
                      backgroundColor: `${theme.accent}20`,
                      borderColor: `${theme.accent}60`,
                      color: theme.accent,
                      boxShadow: `0 0 12px ${theme.accent}25`,
                    }
                  : undefined
              }
            >
              <LayoutGrid className="h-3.5 w-3.5" style={{ color: splitMenu?.tab === 'presets' || splitMenu?.tab === 'layout' ? theme.accent : undefined }} />
            </button>
            {splitMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSplitMenu(null)} />
                <div
                  className="fixed z-50 w-80 overflow-hidden rounded-xl border p-2.5 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 text-slate-200"
                  style={{
                    top: splitMenu.top,
                    left: Math.min(splitMenu.left, window.innerWidth - 340),
                    backgroundColor: theme.xterm.background || '#0e131d',
                    borderColor: `${theme.accent}30`,
                    boxShadow: `0 16px 36px rgba(0,0,0,0.6), 0 0 20px ${theme.accent}15`,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-20 opacity-20"
                    style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
                  />

                  {/* Top Navigation Tabs */}
                  <div className="relative z-10 flex items-center gap-1 p-0.5 mb-2.5 rounded-lg bg-white/[0.04] border border-white/5 text-xs">
                    <button
                      type="button"
                      onClick={() => setSplitMenu((prev) => prev ? { ...prev, tab: 'split' } : null)}
                      className={cn(
                        'flex-1 py-1 rounded-md text-[11px] font-medium transition text-center flex items-center justify-center gap-1.5',
                        splitMenu.tab === 'split' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                      )}
                      style={splitMenu.tab === 'split' ? { color: theme.accent } : undefined}
                    >
                      <Columns2 className="h-3 w-3" />
                      Split
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitMenu((prev) => prev ? { ...prev, tab: 'layout' } : null)}
                      className={cn(
                        'flex-1 py-1 rounded-md text-[11px] font-medium transition text-center flex items-center justify-center gap-1.5',
                        splitMenu.tab === 'layout' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                      )}
                      style={splitMenu.tab === 'layout' ? { color: theme.accent } : undefined}
                    >
                      <Layers className="h-3 w-3" />
                      Layout
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitMenu((prev) => prev ? { ...prev, tab: 'presets' } : null)}
                      className={cn(
                        'flex-1 py-1 rounded-md text-[11px] font-medium transition text-center flex items-center justify-center gap-1.5',
                        splitMenu.tab === 'presets' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                      )}
                      style={splitMenu.tab === 'presets' ? { color: theme.accent } : undefined}
                    >
                      <Bookmark className="h-3 w-3" />
                      Presets
                    </button>
                  </div>

                  {/* Tab 1: Directional Split */}
                  {splitMenu.tab === 'split' && (
                    <div className="relative z-10 py-1 space-y-2">
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-1 flex items-center justify-between">
                          <span>Split Direction</span>
                          <span className="text-[9px] font-mono text-slate-500">From active pane</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-black/30 border border-white/5">
                          {(['left', 'right', 'up', 'down'] as const).map((dir) => {
                            const isSelected = splitMenu.direction === dir;
                            const label = dir === 'left' ? '← Left' : dir === 'right' ? 'Right →' : dir === 'up' ? '↑ Up' : '↓ Down';
                            return (
                              <button
                                key={dir}
                                type="button"
                                onClick={() => setSplitMenu((prev) => prev ? { ...prev, direction: dir } : null)}
                                className={cn(
                                  'py-1 rounded text-[10px] font-semibold tracking-wide transition border',
                                  isSelected
                                    ? 'text-white'
                                    : 'text-slate-400 hover:text-white border-transparent hover:bg-white/5'
                                )}
                                style={
                                  isSelected
                                    ? {
                                        backgroundColor: `${theme.accent}25`,
                                        borderColor: `${theme.accent}60`,
                                        color: theme.accent,
                                      }
                                    : undefined
                                }
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 pt-1 border-t border-white/5">
                        Split with Host
                      </div>

                      <div className="space-y-0.5 max-h-56 overflow-y-auto pr-0.5">
                        {/* Option 1: Current host (Duplicate) */}
                        {activePane && hostMap.get(activePane.hostId) && (
                          <button
                            type="button"
                            onClick={() => {
                              const h = hostMap.get(activePane.hostId);
                              if (h) splitPaneInDirection(splitMenu.direction, h);
                              setSplitMenu(null);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10 hover:text-white transition group"
                          >
                            <Zap className="h-4 w-4 shrink-0" style={{ color: theme.accent }} />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-white flex items-center gap-1.5">
                                <span className="truncate">{hostMap.get(activePane.hostId)?.label}</span>
                                <span
                                  className="text-[9px] rounded border px-1 py-0 font-mono shrink-0"
                                  style={{
                                    backgroundColor: `${theme.accent}18`,
                                    borderColor: `${theme.accent}35`,
                                    color: theme.accent,
                                  }}
                                >
                                  Current
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-400 truncate">
                                Duplicate session on this host
                              </div>
                            </div>
                          </button>
                        )}

                        {/* Option 2: Local Terminal */}
                        {(!activePane || !activePane.isLocal) && (
                          <button
                            type="button"
                            onClick={() => {
                              splitPaneInDirection(splitMenu.direction, LOCAL_HOST);
                              setSplitMenu(null);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10 hover:text-white transition group"
                          >
                            <TerminalIcon className="h-4 w-4 text-emerald-400 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-white">Local Terminal</div>
                              <div className="text-[10px] text-slate-400">Open local shell split</div>
                            </div>
                          </button>
                        )}

                        {/* Other saved hosts */}
                        {hosts.filter((h) => h.id !== activePane?.hostId).map((h) => (
                          <button
                            key={h.id}
                            type="button"
                            onClick={() => {
                              splitPaneInDirection(splitMenu.direction, h);
                              setSplitMenu(null);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10 hover:text-white transition group"
                          >
                            <OsIcon os={h.os} color={h.color} size={16} />
                            <div className="min-w-0 flex-1 truncate">
                              <div className="font-medium text-white truncate">{h.label}</div>
                              <div className="text-[10px] text-slate-400 font-mono truncate">
                                {h.username}@{h.hostname}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tab 2: Layout Switcher */}
                  {splitMenu.tab === 'layout' && (
                    <div className="relative z-10 py-1 space-y-1.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1">
                        Active Tab Layout ({activeTab?.panes.length ?? 0} panes)
                      </div>
                      {(!activeTab || activeTab.panes.length < 2) ? (
                        <div className="p-3 text-center text-xs text-slate-400 bg-white/[0.02] rounded-lg border border-white/5">
                          Split the current tab into 2+ panes to switch between multi-pane geometries.
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-0.5">
                          {(
                            activeTab.panes.length === 2
                              ? [
                                  { layout: 'vertical' as Layout, label: 'Vertical Split', desc: '2 Columns', icon: Columns2 },
                                  { layout: 'horizontal' as Layout, label: 'Horizontal Split', desc: '2 Rows', icon: Rows2 },
                                ]
                              : activeTab.panes.length === 3
                              ? [
                                  { layout: 'main-left' as Layout, label: 'Main Left', desc: 'Large left + 2 right', icon: PanelLeft },
                                  { layout: 'main-right' as Layout, label: 'Main Right', desc: '2 left + large right', icon: PanelLeft },
                                  { layout: 'main-top' as Layout, label: 'Main Top', desc: 'Wide top + 2 bottom', icon: PanelTop },
                                  { layout: 'main-bottom' as Layout, label: 'Main Bottom', desc: '2 top + wide bottom', icon: PanelTop },
                                  { layout: '3-columns' as Layout, label: '3 Columns', desc: '3 equal vertical cols', icon: Columns3 },
                                  { layout: '3-rows' as Layout, label: '3 Rows', desc: '3 equal horizontal rows', icon: Rows2 },
                                ]
                              : [
                                  { layout: 'grid' as Layout, label: '2x2 Grid', desc: '4 equal quadrants', icon: Grid2x2 },
                                  { layout: '4-columns' as Layout, label: '4 Columns', desc: '4 vertical columns', icon: Columns3 },
                                ]
                          ).map((item) => {
                            const isCurrent = activeTab.layout === item.layout;
                            const IconComponent = item.icon;
                            return (
                              <button
                                key={item.layout}
                                type="button"
                                onClick={() => {
                                  changeActiveTabLayout(item.layout);
                                  setSplitMenu(null);
                                }}
                                className={cn(
                                  'flex flex-col items-start p-2 rounded-lg border text-left transition',
                                  isCurrent
                                    ? 'bg-white/10 text-white'
                                    : 'bg-white/[0.03] text-slate-300 hover:bg-white/[0.07] border-white/5'
                                )}
                                style={
                                  isCurrent
                                    ? {
                                        backgroundColor: `${theme.accent}20`,
                                        borderColor: `${theme.accent}60`,
                                        boxShadow: `0 0 10px ${theme.accent}20`,
                                      }
                                    : undefined
                                }
                              >
                                <div className="flex items-center gap-1.5 w-full">
                                  <IconComponent className="h-3.5 w-3.5" style={{ color: isCurrent ? theme.accent : undefined }} />
                                  <span className="text-xs font-semibold">{item.label}</span>
                                </div>
                                <span className="text-[10px] text-slate-400 mt-0.5">{item.desc}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Tab 3: Presets & Templates */}
                  {splitMenu.tab === 'presets' && (
                    <div className="relative z-10 py-1 space-y-2">
                      <button
                        type="button"
                        disabled={!activeTab || activeTab.panes.length < 2}
                        onClick={() => {
                          setPresetNameInput(activeTab?.title || `Workspace ${userPresets.length + 1}`);
                          setShowSavePresetModal(true);
                          setSplitMenu(null);
                        }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium border transition disabled:opacity-40"
                        style={{
                          backgroundColor: `${theme.accent}20`,
                          borderColor: `${theme.accent}50`,
                          color: theme.accent,
                        }}
                      >
                        <Bookmark className="h-3.5 w-3.5" />
                        <span>Save Current Tab Layout Preset</span>
                      </button>

                      {/* User Presets */}
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-1">
                          My Saved Presets ({userPresets.length})
                        </div>
                        {userPresets.length === 0 ? (
                          <div className="px-2 py-1 text-[11px] text-slate-400 italic">
                            No custom presets saved yet.
                          </div>
                        ) : (
                          <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
                            {userPresets.map((p) => (
                              <div
                                key={p.id}
                                className="group flex items-center justify-between rounded-lg px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition"
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    applyLayoutPreset(p);
                                    setSplitMenu(null);
                                  }}
                                  className="flex-1 text-left min-w-0"
                                >
                                  <div className="text-xs font-medium text-white truncate flex items-center gap-1.5">
                                    <span>{p.name}</span>
                                    <span className="text-[9px] px-1 py-0 rounded bg-white/10 text-slate-300 font-mono">
                                      {p.layout}
                                    </span>
                                  </div>
                                  <div className="text-[10px] text-slate-400 truncate">
                                    {p.panes.length} panes: {p.panes.map((pp: LayoutPresetPane) => pp.hostLabel || pp.label || (pp.isLocal ? 'Local' : 'Host')).join(', ')}
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  title="Delete preset"
                                  onClick={() => handleDeletePreset(p.id, p.name)}
                                  className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-400 transition"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Builtin Templates */}
                      <div className="pt-1 border-t border-white/5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-1">
                          Built-in Templates
                        </div>
                        <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
                          {BUILTIN_LAYOUT_PRESETS.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                applyLayoutPreset(p);
                                setSplitMenu(null);
                              }}
                              className="w-full flex items-center justify-between rounded-lg px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition text-left"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-medium text-white truncate flex items-center gap-1.5">
                                  <span>{p.name}</span>
                                  <span className="text-[9px] px-1 py-0 rounded bg-white/10 text-slate-300 font-mono">
                                    {p.layout}
                                  </span>
                                </div>
                                <div className="text-[10px] text-slate-400 truncate">{p.description}</div>
                              </div>
                              <span className="text-[10px] font-mono shrink-0 ml-1" style={{ color: theme.accent }}>Launch →</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            {activeTab && activeTab.panes.length > 1 && (
              <button
                title={broadcast ? 'Broadcast input: ON (⌘⇧I) — Keys sent to all panes' : 'Broadcast input: OFF (⌘⇧I)'}
                onClick={() => {
                  setBroadcast((b) => {
                    const next = !b;
                    toast(next ? '⚡ Broadcast Cluster Mode: ON (Input sent to all panes in tab)' : 'Broadcast Cluster Mode: OFF');
                    return next;
                  });
                }}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition border font-medium',
                  broadcast
                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.3)] animate-pulse'
                    : 'bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white border-white/5'
                )}
              >
                <Radio className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Broadcast</span>
              </button>
            )}
            {uiPrefs.showThemeButton && (
              <div className="relative">
                <button title="Theme" onClick={() => setShowThemes((v) => !v)} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><Palette className="h-3.5 w-3.5" /></button>
                {showThemes && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setShowThemes(false)} />
                    <div className="absolute right-0 top-9 z-40 w-56 rounded-xl border border-white/10 bg-[#0e131d] p-2 shadow-2xl">
                      <div className="max-h-64 overflow-y-auto space-y-0.5 pr-0.5">
                        {THEMES.map((t) => (
                          <button key={t.id} onClick={() => setThemeId(t.id)} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs', t.id === themeId ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5')}>
                            <span className="flex h-5 w-8 shrink-0 overflow-hidden rounded ring-1 ring-white/10" style={{ background: t.xterm.background }}>
                              {[t.xterm.red, t.xterm.green, t.xterm.blue, t.xterm.magenta].map((c, i) => <span key={i} className="mt-auto h-1.5 flex-1" style={{ background: c }} />)}
                            </span>
                            <span className="truncate">{t.name}</span>
                          </button>
                        ))}
                      </div>
                    <div className="mt-2 flex items-center justify-between border-t border-white/5 px-2 pt-2 text-xs text-slate-400">
                      Font size
                      <div className="flex items-center gap-1">
                        <button onClick={() => setFontSize((f) => Math.max(TERMINAL_FONT_MIN, f - 1))} className="rounded p-1 hover:bg-white/10"><Minus className="h-3 w-3" /></button>
                        <span className="w-6 text-center font-mono text-white">{fontSize}</span>
                        <button onClick={() => setFontSize((f) => Math.min(TERMINAL_FONT_MAX, f + 1))} className="rounded p-1 hover:bg-white/10"><Plus className="h-3 w-3" /></button>
                      </div>
                    </div>
                    <div className="mt-1 flex items-center justify-between px-2 pt-1 text-xs text-slate-400">
                      Line height
                      <div className="flex items-center gap-1">
                        <button onClick={() => setLineHeight((lh) => Math.max(1.0, Number((lh - 0.05).toFixed(2))))} className="rounded p-1 hover:bg-white/10"><Minus className="h-3 w-3" /></button>
                        <span className="w-10 text-center font-mono text-white">{lineHeight.toFixed(2)}</span>
                        <button onClick={() => setLineHeight((lh) => Math.min(1.5, Number((lh + 0.05).toFixed(2))))} className="rounded p-1 hover:bg-white/10"><Plus className="h-3 w-3" /></button>
                      </div>
                    </div>
                  </div>
                </>
                )}
              </div>
            )}
            {uiPrefs.showAi && (
              <button title="AI Assistant (⌘⇧A)" onClick={() => setShowAI((v) => !v)} className={cn('grid h-7 w-7 place-items-center rounded-lg transition', showAI ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-400/30' : 'text-slate-400 hover:bg-white/10 hover:text-white')}><Sparkles className="h-3.5 w-3.5" /></button>
            )}
            {uiPrefs.showStatusBarToggle && (
              <button title={showStatusBar ? 'Hide status bar (⌘⇧/)' : 'Show status bar (⌘⇧/)'} onClick={() => setShowStatusBar((v) => !v)} className={cn('grid h-7 w-7 place-items-center rounded-lg transition', showStatusBar ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30' : 'text-slate-400 hover:bg-white/10 hover:text-white')}><PanelBottom className="h-3.5 w-3.5" /></button>
            )}
            <button title="Zen mode (⌘⇧Z)" onClick={() => setZen((v) => !v)} className={cn('grid h-7 w-7 place-items-center rounded-lg transition', zen ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30' : 'text-slate-400 hover:bg-white/10 hover:text-white')}><Maximize2 className="h-3.5 w-3.5" /></button>
          </div>
        </header>
      )}

      {/* No page header on phones: the bottom navigation already says where you are, and every
          section starts with its own working row (vault switcher, pane bar, panel header). The AI page
          is the assistant alone — snippets live in the terminal key row's Snippets drawer. */}
      {mobile && mobilePage === 'hosts' && <div className="relative z-30 flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
        <VaultMenu vaults={vaults} activeVaultId={activeVaultId} onSelectVault={setActiveVaultId}
          onCreateVault={handleCreateVault} onDeleteVault={handleDeleteVault}
          onOpenShareModal={() => setShareModal({ initialTab: 'share' })}
          onOpenImportModal={() => setShareModal({ initialTab: 'import' })}
          onOpenPairingModal={() => setShowPairing({ initialTab: 'share' })} theme={theme} />
        <span className="text-xs text-slate-500">
          {(() => { const n = activeVaultId === 'all' ? hosts.length : hosts.filter((h) => (h.vaultId || 'personal') === activeVaultId).length; return `${n} ${n === 1 ? 'profile' : 'profiles'}`; })()}
        </span>
      </div>}

      {/* Main App Body */}
      <div className="flex flex-1 min-h-0 min-w-0 relative">
        {/* Icon rail — floating buttons aligned directly underneath the logo button */}
        {!zen && showRail && (
          <nav className="max-md:hidden flex w-12 shrink-0 flex-col items-center gap-1.5 py-1.5 z-20 bg-transparent">
            {rail.map((r) => (
              <button
                key={r.id}
                title={r.label}
                onClick={r.act}
                className={cn(
                  'group relative grid h-8 w-8 place-items-center rounded-xl transition shadow-sm',
                  r.on
                    ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-[0_0_12px_rgba(34,211,238,0.25)]'
                    : 'bg-white/[0.04] text-slate-400 border border-white/5 hover:bg-white/[0.08] hover:text-white hover:border-white/15'
                )}
              >
                {r.on && <span className="absolute -left-1.5 h-4 w-1 rounded-r-full bg-gradient-to-b from-cyan-300 to-fuchsia-400" />}
                <r.icon className={cn('h-4 w-4', (r as any).iconClass)} />
              </button>
            ))}
            <div className="mt-auto flex flex-col items-center gap-1.5 pb-1">
              <button
                title="Direct device pairing (QR & PIN LAN sync)"
                onClick={() => setShowPairing({ initialTab: 'share' })}
                className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-amber-400/10 hover:border-amber-400/30 hover:text-amber-200 transition"
              >
                <QrCode className="h-4 w-4" />
              </button>
              <button title="Zero-knowledge sync" onClick={() => setShowSync(true)} className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-white/[0.08] hover:text-white"><Cloud className="h-4 w-4" /></button>
              {/* Auto-lock Settings Button */}
              <div className="relative">
                <button
                  type="button"
                  title={autoLockMinutes > 0 ? `Auto-lock: ${autoLockMinutes} min` : 'Auto-lock: Off'}
                  onClick={() => setShowAutoLockMenu((v) => !v)}
                  className={cn(
                    'group relative grid h-8 w-8 place-items-center rounded-xl transition shadow-sm',
                    showAutoLockMenu
                      ? 'border shadow-[0_0_12px_rgba(34,211,238,0.25)]'
                      : autoLockMinutes > 0
                        ? 'bg-white/[0.04] text-slate-300 border border-white/5 hover:bg-white/[0.08] hover:text-white hover:border-white/15'
                        : 'bg-white/[0.04] text-slate-500 border border-white/5 hover:bg-white/[0.08] hover:text-slate-300 hover:border-white/15'
                  )}
                  style={
                    showAutoLockMenu
                      ? {
                          backgroundColor: `${theme.accent}20`,
                          borderColor: `${theme.accent}50`,
                          color: theme.accent,
                          boxShadow: `0 0 12px ${theme.accent}30`,
                        }
                      : undefined
                  }
                >
                  {showAutoLockMenu && (
                    <span
                      className="absolute -left-1.5 h-4 w-1 rounded-r-full"
                      style={{ background: `linear-gradient(to bottom, ${theme.accent}, #a855f7)` }}
                    />
                  )}
                  <Timer className="h-4 w-4 transition-colors" style={showAutoLockMenu ? { color: theme.accent } : undefined} />
                  {autoLockMinutes > 0 && !showAutoLockMenu && (
                    <span
                      className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: theme.accent, boxShadow: `0 0 6px ${theme.accent}` }}
                    />
                  )}
                </button>

                {showAutoLockMenu && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setShowAutoLockMenu(false)} />
                    <div
                      className="absolute left-10 bottom-0 z-40 w-64 rounded-2xl border border-white/10 p-1.5 shadow-2xl backdrop-blur-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
                      style={{
                        background: theme.xterm.background || '#0e131d',
                        boxShadow: `0 0 30px ${theme.accent}18, 0 20px 45px rgba(0, 0, 0, 0.75)`,
                      }}
                    >
                      {/* Ambient radial glow */}
                      <div
                        className="pointer-events-none absolute inset-x-0 top-0 h-28 opacity-25"
                        style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
                      />
                      <div
                        className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-75"
                        style={{ background: `linear-gradient(90deg, transparent, ${theme.accent}, transparent)` }}
                      />

                      <div className="relative px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/5 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-slate-300">
                          <Timer className="h-3.5 w-3.5" style={{ color: theme.accent }} />
                          <span>Auto-Lock Timeout</span>
                        </span>
                        <span
                          className="text-[9px] px-2 py-0.5 rounded-full border font-mono tracking-normal shadow-sm font-semibold"
                          style={{
                            color: autoLockMinutes > 0 ? theme.accent : '#94a3b8',
                            backgroundColor: autoLockMinutes > 0 ? `${theme.accent}15` : 'rgba(255,255,255,0.05)',
                            borderColor: autoLockMinutes > 0 ? `${theme.accent}30` : 'rgba(255,255,255,0.1)',
                          }}
                        >
                          {autoLockMinutes > 0 ? `${autoLockMinutes} min` : 'Off'}
                        </span>
                      </div>

                      <div className="relative px-3 pt-2 pb-1 text-[11px] text-slate-400 leading-snug">
                        Locks vault after inactivity. Terminals and SSH sessions remain active in the background.
                      </div>

                      <div className="relative py-1 space-y-0.5">
                        {AUTO_LOCK_OPTIONS.map((m) => {
                          const selected = autoLockMinutes === m;
                          return (
                            <button
                              key={m}
                              type="button"
                              onClick={() => {
                                setAutoLockMinutes(m);
                                try { localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(m)); } catch { /* storage unavailable */ }
                                setShowAutoLockMenu(false);
                              }}
                              className={cn(
                                'flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-xs text-left transition-all',
                                selected
                                  ? 'text-white font-medium border'
                                  : 'text-slate-300 hover:bg-white/[0.06] hover:text-white border border-transparent'
                              )}
                              style={
                                selected
                                  ? {
                                      backgroundColor: `${theme.accent}18`,
                                      borderColor: `${theme.accent}35`,
                                      boxShadow: `0 0 14px ${theme.accent}18`,
                                    }
                                  : undefined
                              }
                            >
                              <span className="flex items-center gap-2">
                                <span
                                  className={cn('h-1.5 w-1.5 rounded-full', selected ? '' : 'bg-slate-600')}
                                  style={selected ? { backgroundColor: theme.accent } : undefined}
                                />
                                <span>{m === 0 ? 'Disabled (Never lock)' : `${m} minutes`}</span>
                              </span>
                              {selected && <Check className="h-3.5 w-3.5" style={{ color: theme.accent }} />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                title="General Settings (⌘,)"
                onClick={() => setShowSettings(true)}
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-xl transition shadow-sm',
                  showSettings
                    ? 'border shadow-[0_0_12px_rgba(34,211,238,0.25)]'
                    : 'bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-white/[0.08] hover:text-white'
                )}
                style={
                  showSettings
                    ? {
                        backgroundColor: `${theme.accent}20`,
                        borderColor: `${theme.accent}50`,
                        color: theme.accent,
                        boxShadow: `0 0 12px ${theme.accent}30`,
                      }
                    : undefined
                }
              >
                <Settings className="h-4 w-4" />
              </button>
              <button title="Lock vault" onClick={lock} className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-400/30"><Lock className="h-4 w-4" /></button>
            </div>
          </nav>
        )}

        {/* Side panel — overlay drawer */}
        {panel && (
          <>
            <div
              className="max-md:hidden fixed inset-0 z-30 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
              onClick={closePanel}
            />
            <aside
              className="nx-mobile-panel fixed bottom-0 top-10 z-40 w-[340px] border-r border-white/10 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-left-2 duration-150 flex flex-col"
              style={{
                left: (zen || !showRail) ? 0 : 48,
                background: theme.xterm.background || '#0e131d',
                boxShadow: `0 0 35px rgba(0, 0, 0, 0.8), 10px 0 40px rgba(0, 0, 0, 0.6)`,
              }}
            >
              {/* Top ambient radial glow */}
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-20"
                style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
              />
              {/* Top glowing line */}
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-75"
                style={{ background: `linear-gradient(90deg, transparent, ${theme.accent}, transparent)` }}
              />

              {mobile && panel !== 'hosts' && (
                <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 bg-black/40 px-3">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300 hover:text-white transition cursor-pointer"
                    onClick={closePanel}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>
                      {returnToSettingsTab
                        ? 'Back to Settings'
                        : mobilePage === 'hosts'
                        ? 'Back to Hosts'
                        : 'Back to Terminals'}
                    </span>
                  </button>
                  <span className="text-xs font-medium text-slate-300 capitalize">
                    {panel === 'tunnels' ? 'Port Forwarding' : panel === 'known_hosts' ? 'Known Hosts' : panel}
                  </span>
                  <div className="w-12" />
                </div>
              )}
              <div className="relative flex flex-1 flex-col min-h-0 overflow-y-auto">
                {panel === 'hosts' && (
                  <HostSidebar
                    hosts={hosts}
                    vaults={vaults}
                    activeVaultId={activeVaultId}
                    onConnect={resumeOrOpenHost}
                    onNewSession={openHost}
                    onOpenSftp={(h) => { openSftpTab(h.id); setPanel(null); }}
                    onSplit={(h) => { splitWith(h); if (mobile) { setPanel(null); setMobilePage('terminals'); } }}
                    onEdit={(h) => setModal({ host: h })}
                    onDelete={deleteHost}
                    onOpenTerminal={openLocalTerminal}
                    onOpenSerial={() => setShowSerial(true)}
                    showSerial={uiPrefs.showSerial}
                    onOpenShareModal={() => setShareModal({ initialTab: 'share' })}
                    onOpenSshConfig={() => setShowSshConfig(true)}
                    onOpenTailscale={() => setShowTailscale(true)}
                    onOpenNetbird={() => setShowNetbird(true)}
                    onOpenCloudSync={() => setShowCloudSync(true)}
                    cloudStatuses={cloudStatuses}
                    onRefreshCloudStatuses={() => refreshCloudStatuses(false)}
                    cloudRefreshing={cloudRefreshing}
                    onOpenTermuxPreset={isAndroid ? openTermuxPreset : undefined}
                    onOpenKeychain={() => setPanel('keychain')}
                    onOpenTunnels={() => setPanel('tunnels')}
                    onOpenLogs={() => setPanel('logs')}
                    onOpenDocker={() => setShowDockerModal(true)}
                    onScrollFabVisibilityChange={setHostFabsVisible}
                    onQuickConnectSsh={handleQuickConnectSsh}
                    onClose={() => { if (mobile) navigateMobile('terminals'); else setPanel(null); }}
                    theme={theme}
                  />
                )}
                {panel === 'keychain' && (
                  <KeychainPanel
                    keychain={keychain}
                    activeVaultId={activeVaultId}
                    onSave={async (k) => { await bridge.saveKeychain(k); refresh(); }}
                    onDelete={async (id) => { await bridge.deleteKeychain(id); refresh(); }}
                    onRefresh={refresh}
                    onClose={closePanel}
                    toast={toast}
                  />
                )}
                {panel === 'tunnels' && (
                  <PortForwardingPanel
                    hosts={hosts}
                    tunnels={tunnels}
                    onSave={async (t) => { await bridge.saveTunnel(t); refresh(); }}
                    onDelete={async (id) => { await bridge.deleteTunnel(id); refresh(); }}
                    onClose={closePanel}
                    toast={toast}
                  />
                )}
                {panel === 'snippets' && (
                  <SnippetsPanel snippets={snippets} activePaneId={activePaneId} onSave={saveSnippet} onDelete={deleteSnippet} toast={toast} />
                )}
                {panel === 'logs' && (
                  <LogsPanel
                    onClose={closePanel}
                    toast={toast}
                  />
                )}
                {panel === 'known_hosts' && (
                  <KnownHostsPanel
                    onClose={closePanel}
                    toast={toast}
                  />
                )}
              </div>
            </aside>
          </>
        )}

        {mobile && mobilePage === 'hosts' && panel === 'hosts' && (
          <button
            type="button"
            className={cn(
              "nx-fab",
              hostFabsVisible
                ? "opacity-100 translate-y-0 scale-100 pointer-events-auto"
                : "opacity-0 translate-y-12 scale-90 pointer-events-none"
            )}
            aria-label="Add host"
            onClick={() => setModal({ host: null })}
            style={{ background: `linear-gradient(145deg, ${theme.accent}, ${theme.accent}c0)`, boxShadow: `0 10px 26px -8px ${theme.accent}b0, 0 3px 8px rgb(0 0 0 / .5), inset 0 1px 0 rgb(255 255 255 / .25)` }}
          >
            <Plus size={24} strokeWidth={2.5} />
          </button>
        )}

        {mobile && unlocked && mobilePage === 'hosts' && panel === 'hosts' && !showSettings && uiPrefs.showDocker !== false && (
          <button
            type="button"
            className={cn(
              "nx-docker-fab",
              hostFabsVisible
                ? "opacity-100 translate-y-0 scale-100 pointer-events-auto"
                : "opacity-0 translate-y-12 scale-90 pointer-events-none"
            )}
            aria-label="Docker containers"
            title="Docker containers"
            onClick={() => setShowDockerModal(true)}
            style={{
              bottom: 76,
              borderColor: `${theme.accent}60`,
              color: theme.accent,
              boxShadow: `0 10px 25px -5px rgba(0, 0, 0, 0.7), 0 0 18px ${theme.accent}33, inset 0 1px 0 rgba(255, 255, 255, 0.2)`,
            }}
          >
            {showDockerModal ? (
              <Loader2 size={22} className="animate-spin" />
            ) : (
              <Boxes size={22} strokeWidth={2} />
            )}
          </button>
        )}

        {/* Main workspace */}
        <main inert={mobile && !mobileWorkspaceVisible} className={cn("relative flex min-w-0 flex-1 flex-col", mobile && !mobileWorkspaceVisible && "invisible")}>
          {/* Panes */}
        <div className="relative min-h-0 flex-1 overflow-hidden" onClick={() => { setShowThemes(false); setQuick(false); setPanel(null); }}>
          {(!tabs.length || (mobile && mobilePage === 'terminals' && !tabs.some(t => t.panes.length))) && (
            <Welcome
              hosts={hosts}
              recentHostIds={recentHostIds}
              theme={theme}
              onOpen={openHost}
              onLocal={openLocalTerminal}
              onTermux={isAndroid ? openTermuxPreset : undefined}
              onNew={() => setModal({ host: null })}
              onSshConfig={() => setShowSshConfig(true)}
              onViewAll={() => {
                if (mobile) {
                  navigateMobile('hosts');
                } else {
                  setPanel('hosts');
                }
              }}
            />
          )}
          {workspaceReady && tabs.map((t) => {
            if (t.kind === 'sftp') {
              return (
                <div
                  key={t.id}
                  className={cn('absolute inset-0', (t.id !== activeTabId || (mobile && mobilePage !== 'sftp')) && 'invisible')} inert={t.id !== activeTabId || (mobile && mobilePage !== 'sftp')}
                >
                  <PaneErrorBoundary label={t.title} background={theme.xterm.background} onClose={() => closeTab(t.id)}>
                    <SftpTab
                      tab={t}
                      active={unlocked && t.id === activeTabId && (!mobile || mobilePage === 'sftp')}
                      hosts={hosts}
                      onUpdateTab={(patch) =>
                        setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))
                      }
                      toast={toast}
                      theme={theme}
                    />
                  </PaneErrorBoundary>
                </div>
              );
            }
            const isSplit = t.panes.length > 1;
            const currentTabMaximized = (isSplit && t.id === activeTabId) ? maximizedPaneId : null;
            return (
              <div
                key={t.id}
                inert={t.id !== activeTabId || (mobile && mobilePage !== 'terminals')}
                className={cn(
                  'absolute inset-0',
                  (t.id !== activeTabId || (mobile && mobilePage !== 'terminals')) && 'invisible',
                  isSplit && !currentTabMaximized ? getSplitContainerClasses(t.layout, t.panes.length) : 'flex p-0'
                )}
              >
                {[...t.panes]
                  .sort((a, b) => a.id.localeCompare(b.id))
                  .map((p) => {
                    const h = hostMap.get(p.hostId);
                    if (!h) return null;
                    const slotIndex = t.panes.findIndex((item) => item.id === p.id);
                    const isPaneMaximized = currentTabMaximized === p.id;
                    const isPaneHidden = currentTabMaximized !== null && currentTabMaximized !== p.id;
                    const spanClasses = isSplit && !currentTabMaximized ? getPaneSpanClasses(t.layout, slotIndex, t.panes.length) : '';
                    const isDraggingThis = draggedPaneId === p.id;
                    const isDropTarget = dropTargetPaneId === p.id && draggedPaneId !== null && draggedPaneId !== p.id;
                    return (
                      <div
                        key={p.id}
                        inert={isPaneHidden || undefined}
                        style={{ order: currentTabMaximized ? (isPaneMaximized ? 0 : 99) : slotIndex }}
                        className={cn(
                          'min-h-0 min-w-0 h-full w-full flex relative',
                          spanClasses,
                          isDraggingThis && 'opacity-50 ring-2 ring-cyan-400/60 ring-dashed',
                          t.activePaneId !== p.id && mobile && 'max-md:hidden',
                          isPaneHidden
                            ? 'opacity-0 invisible pointer-events-none select-none absolute inset-0 -z-10'
                            : isPaneMaximized
                            ? 'flex-1 z-10'
                            : undefined
                        )}
                      >
                      {/* Drop overlay to capture drag-and-drop swaps cleanly across xterm canvas */}
                      {draggedPaneId !== null && draggedPaneId !== p.id && (
                        <div
                          className={cn(
                            'absolute inset-0 z-20 pointer-events-auto flex items-center justify-center transition-all duration-150 rounded-lg',
                            isDropTarget
                              ? 'border-2 border-dashed border-cyan-400/90 bg-cyan-500/20 backdrop-blur-[2px] shadow-[inset_0_0_30px_rgba(34,211,238,0.25)]'
                              : 'border-2 border-transparent bg-cyan-500/5 hover:border-cyan-400/40'
                          )}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dropTargetPaneId !== p.id) {
                              setDropTargetPaneId(p.id);
                            }
                          }}
                          onDragLeave={(e) => {
                            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                            if (dropTargetPaneId === p.id) {
                              setDropTargetPaneId(null);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const srcId = e.dataTransfer.getData('application/x-drexius-pane') || e.dataTransfer.getData('text/plain') || draggedPaneId;
                            if (srcId && srcId !== p.id) {
                              swapPanes(t.id, srcId, p.id);
                            }
                            setDraggedPaneId(null);
                            setDropTargetPaneId(null);
                          }}
                        >
                          {isDropTarget && (
                            <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-900/95 border border-cyan-400/70 text-cyan-200 text-xs font-semibold shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100">
                              <ArrowLeftRight className="h-4 w-4 text-cyan-400 animate-pulse" />
                              <span>Swap with {h.label}</span>
                            </div>
                          )}
                        </div>
                      )}
                      <PaneErrorBoundary
                        label={h.label}
                        background={theme.xterm.background}
                        className={cn(t.activePaneId !== p.id && mobile ? 'max-md:hidden' : undefined)}
                        onClose={() => closePane(t.id, p.id)}
                      >
                        <TerminalPane
                          pane={p}
                          host={h}
                          theme={theme}
                          fontSize={fontSize}
                          fontFamily={uiPrefs.fontFamily}
                          customFontFamily={uiPrefs.customFontFamily}
                          fontWeight={uiPrefs.fontWeight}
                          letterSpacing={uiPrefs.letterSpacing}
                          onFontSizeChange={setFontSize}
                          lineHeight={lineHeight}
                          cursorStyle={uiPrefs.cursorStyle}
                          cursorBlink={uiPrefs.cursorBlink}
                          scrollback={uiPrefs.scrollback}
                          ghostSuggestions={uiPrefs.ghostSuggestions}
                          active={t.id === activeTabId && t.activePaneId === p.id && (!mobile || (mobilePage === 'terminals' && unlocked))}
                          mobileHidden={t.activePaneId !== p.id}
                          hidden={isPaneHidden}
                          showHeader={isSplit && !currentTabMaximized && !mobile}
                          isSplit={isSplit}
                          isMaximized={isPaneMaximized}
                          onToggleMaximize={() => toggleMaximizePane(p.id)}
                          onSplitPane={(dir) => splitPaneInDirection(dir)}
                          onDragStart={(id) => setDraggedPaneId(id)}
                          onDragEnd={() => {
                            setDraggedPaneId(null);
                            setDropTargetPaneId(null);
                          }}
                          broadcast={broadcast && isSplit && !currentTabMaximized}
                          onOpenDocker={() => {
                            setDockerHostId(p.isLocal ? '__local__' : h.id);
                            setShowDockerModal(true);
                          }}
                          onTunnelChange={refresh}
                          onFocus={() => focusPane(t.id, p.id)}
                          onClose={() => closePane(t.id, p.id)}
                          onChange={bump}
                          onData={(d) => handlePaneData(t.id, p.id, d)}
                          toast={toast}
                          mobileBar={mobile ? {
                            sessionCount: terminalSessionCount,
                            onBack: () => navigateMobile('hosts'),
                            onOpenSessions: () => setSessionSheet(true),
                            onConnectHost: () => navigateMobile('hosts'),
                            onLocalTerminal: openLocalTerminal,
                            onTermuxPreset: isAndroid ? openTermuxPreset : undefined,
                            onSftp: () => openSftpTab(p.isLocal || p.kind === 'serial' ? undefined : h.id),
                            onSerial: () => setShowSerial(true),
                            onAssistant: () => setTerminalDrawer('assistant'),
                            onSnippets: () => setTerminalDrawer('snippets'),
                            onKeypad: () => setTerminalDrawer('keypad'),
                            onHistory: () => setTerminalDrawer('history'),
                          } : undefined}
                          drawerInset={terminalDrawerInset}
                        />
                      </PaneErrorBoundary>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Status bar */}
        {showStatusBar && (
          <footer className="max-md:hidden flex h-7 shrink-0 items-center gap-4 border-t border-white/5 bg-[#080b12] px-3 text-[10.5px] text-slate-500">
            <span className="flex items-center gap-1 text-emerald-400/90"><ShieldCheck className="h-3 w-3" />{isTauri ? 'SQLCipher AES-256' : 'Vault AES-256-GCM (sandbox)'}</span>
            <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{connected} live session{connected === 1 ? '' : 's'}</span>
            {activeLive && <span className="flex items-center gap-1 font-mono"><History className="h-3 w-3 text-fuchsia-300" />snapshot: {activeLive.cwd}</span>}
            <span className="ml-auto flex items-center gap-1"><Command className="h-3 w-3" />^R history · ⇧V clips · ⇧A AI · ⇧F SFTP · ⇧K connect</span>
            <span className={cn('flex items-center gap-1', isTauri ? 'text-cyan-300' : 'text-amber-300/80')}><Zap className="h-3 w-3" />{isTauri ? 'Native (Tauri)' : 'Browser sandbox'}</span>
          </footer>
        )}

        {/* Zen restore */}
        {zen && (
          <button onClick={() => setZen(false)} title="Exit Zen (⌘⇧Z)" className="max-md:hidden absolute bottom-10 right-3 z-40 grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-[#0e131d]/95 text-slate-400 shadow-2xl backdrop-blur hover:text-white"><Minimize2 className="h-4 w-4" /></button>
        )}
      </main>

      {/* Draggable Resizer Edge for AI Assistant */}
      {showAI && !mobile && (
        <div
          onMouseDown={startAiResize}
          className={cn(
            "group relative z-30 w-1 shrink-0 cursor-col-resize select-none bg-transparent hover:bg-cyan-400/50 transition-colors",
            isResizingAi && "bg-cyan-400/80"
          )}
          title="Drag to resize AI Assistant (Double-click to reset)"
          onDoubleClick={() => {
            setAiWidth(420);
            localStorage.setItem('drx.ai.panel_width', '420');
          }}
        >
          {/* Expanded transparent hit area so mouse easily catches the edge */}
          <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
      )}

      {isResizingAi && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none pointer-events-auto" />
      )}

      <aside
        ref={aiDrawerOpen ? (drawer.ref as React.RefObject<HTMLElement>) : undefined}
        style={aiDrawerOpen ? { ...drawer.style, background: drawerBg } : { width: `${aiWidth}px` }}
        className={cn("nx-mobile-ai shrink-0 border-l border-white/5 bg-transparent flex flex-col relative", !aiVisible && "hidden", aiDrawerOpen && drawer.className)}
        aria-label={aiDrawerOpen ? 'AI Assistant drawer' : 'AI Assistant'}
      >
        {aiDrawerOpen && <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-40 opacity-25" style={{ background: `radial-gradient(ellipse at top, ${AI_TINT} 0%, transparent 70%)` }} />}
        {aiDrawerOpen && <DrawerGrip label="Drag to resize or dismiss the assistant" detent={drawer.detent} {...drawer.gripProps} />}
        <div className="flex min-h-0 flex-1 flex-col">
          {workspaceReady && <AIPanel
            activePaneId={activePaneId}
            toast={toast}
            onClose={() => { if (aiDrawerOpen) drawer.requestClose(); else if (mobile) navigateMobile('terminals'); else setShowAI(false); }}
            theme={theme}
            newConnectionNonce={newConnNonce}
            visible={aiVisible}
          />}
        </div>
      </aside>
      {toolDrawer === 'snippets' && (
        <DrawerShell drawer={drawer} label="Snippets drawer" background={drawerBg} accent={SNIPPET_TINT}>
          <SnippetsPanel snippets={snippets} activePaneId={activePaneId} onSave={saveSnippet} onDelete={deleteSnippet} toast={toast}
            drawer={{ accent: SNIPPET_TINT, onClose: drawer.requestClose }} />
        </DrawerShell>
      )}
      {toolDrawer === 'keypad' && (
        <DrawerShell drawer={drawer} label="Extended keypad" background={drawerBg} accent={theme.accent}
          icon={LayoutGrid} title="Extended Keypad" subtitle="tmux · navigation · function keys · symbols">
          <ExtendedKeypad onKey={(data) => { const live = activePaneId ? registry.get(activePaneId) : undefined; if (live?.key) live.key(data); else toast('No active terminal'); }} />
        </DrawerShell>
      )}
      {toolDrawer === 'history' && (
        <DrawerShell drawer={drawer} label="Command history" background={drawerBg} accent={theme.accent}>
          <CommandSearchModal
            embedded
            theme={theme}
            toast={toast}
            initialHostLabel={activeLive ? hostMap.get(activeLive.hostId)?.label : undefined}
            onClose={drawer.requestClose}
            onSelect={(cmd, execute) => { const live = activePaneId ? registry.get(activePaneId) : undefined; if (live?.insert) live.insert(cmd, execute); else toast('No active terminal'); }}
            onSaveSnippet={(cmd) => saveSnippet({ id: uid(), name: cmd.slice(0, 32), command: cmd, tags: [(activeLive && hostMap.get(activeLive.hostId)?.label) || 'terminal'] })}
          />
        </DrawerShell>
      )}
      {mobile && mobilePage === 'settings' && !panel && <section className="absolute inset-0 overflow-y-auto p-4" aria-label="Settings" style={{ '--nx-accent': theme.accent } as React.CSSProperties}>
        <div className="relative mb-5 overflow-hidden rounded-2xl border p-4" style={{ borderColor: `${theme.accent}26`, background: `${theme.accent}0d` }}>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-20" style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }} />
          <div className="relative flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={18} style={{ color: theme.accent }} /> Your workspace, secured</div>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">{isTauri ? 'SQLCipher encrypted vault' : 'Browser sandbox vault'} · credentials stay in your vault.</p>
          <button className="nx-settings-row mt-3" onClick={lock}><Lock size={18} /> Lock vault now</button>
        </div>
        <h2 className="nx-section-label">Connections & security</h2>
        <div className="nx-settings-group">
          <button className="nx-settings-row" onClick={() => setShowPairing({ initialTab: 'share' })}><QrCode size={18} /> LAN device pairing</button>
          <button className="nx-settings-row" onClick={() => setShowTailscale(true)}><Network size={18} /> Tailscale sync & discovery</button>
          <button className="nx-settings-row" onClick={() => setShowNetbird(true)}><Globe2 size={18} /> NetBird mesh discovery</button>
          <button className="nx-settings-row" onClick={() => setShowCloudSync(true)}><Cloud size={18} /> Cloud Fleet Sync (Hetzner / DO / Proxmox)</button>
          <button className="nx-settings-row" onClick={() => setShowSync(true)}><Cloud size={18} /> Encrypted relay sync</button>
          <button className="nx-settings-row" onClick={() => setShowDockerModal(true)}><Boxes size={18} /> Docker containers</button>
          <button className="nx-settings-row" onClick={() => setPanel('keychain')}><KeyRound size={18} /> Keychain</button>
          <button className="nx-settings-row" onClick={() => setPanel('tunnels')}><Network size={18} /> Port forwarding & tunnels</button>
          <button className="nx-settings-row" onClick={() => setPanel('known_hosts')}><ShieldCheck size={18} /> Known hosts</button>
          <button className="nx-settings-row" onClick={() => setPanel('logs')}><Activity size={18} /> Logs</button>
          <button className="nx-settings-row justify-between" aria-haspopup="dialog" aria-label={`Auto-lock: ${autoLockMinutes ? `${autoLockMinutes} minutes` : 'Off'}`} onClick={() => setSettingsPicker('autolock')}>
            <span className="flex items-center gap-3"><Timer size={18} /> Auto-lock</span>
            <span className="nx-settings-value">{autoLockMinutes ? `${autoLockMinutes} min` : 'Off'}<ChevronRight size={16} /></span>
          </button>
          {isTauri && (
            <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('quickunlock')}>
              <span className="flex items-center gap-3"><Fingerprint size={18} /> Device Quick Unlock</span>
              <span className="nx-settings-value">{deviceLockEnabled ? 'Enabled' : 'Off'}<ChevronRight size={16} /></span>
            </button>
          )}
          {isTauri && (
            <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('directlaunch')}>
              <span className="flex items-center gap-3"><Zap size={18} /> Direct Launch</span>
              <span className="nx-settings-value">{directUnlockEnabled ? 'Enabled' : 'Off'}<ChevronRight size={16} /></span>
            </button>
          )}
          <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('recovery_key')}>
            <span className="flex items-center gap-3"><KeyRound size={18} /> Emergency Recovery Kit</span>
            <span className="nx-settings-value">View<ChevronRight size={16} /></span>
          </button>
          <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('storage_perms')}>
            <span className="flex items-center gap-3"><Folder size={18} /> Storage & Permissions</span>
            <span className="nx-settings-value">
              {storageGranted === true ? 'Granted' : storageGranted === false ? 'Action Needed' : 'Check'}
              <ChevronRight size={16} />
            </span>
          </button>
        </div>
        <h2 className="nx-section-label">Appearance</h2>
        <div className="nx-settings-group">
          <button className="nx-settings-row justify-between" aria-haspopup="dialog" aria-label={`Theme: ${theme.name}`} onClick={() => setSettingsPicker('theme')}>
            <span className="flex items-center gap-3"><Palette size={18} /> Theme</span>
            <span className="nx-settings-value"><ThemeSwatch t={theme} />{theme.name}<ChevronRight size={16} /></span>
          </button>
          <button className="nx-settings-row justify-between" aria-haspopup="dialog" aria-label={`Font: ${uiPrefs.fontFamily}`} onClick={() => setSettingsPicker('font')}>
            <span className="flex items-center gap-3"><Type size={18} /> Font family</span>
            <span className="nx-settings-value truncate max-w-[140px]">
              {uiPrefs.fontFamily === 'custom' ? (uiPrefs.customFontFamily || 'Custom') : uiPrefs.fontFamily}
              <ChevronRight size={16} />
            </span>
          </button>
          <div className="nx-settings-row justify-between">
            <span className="flex items-center gap-3"><Type size={18} /> Font size</span>
            <span className="nx-stepper" role="group" aria-label="Terminal font size">
              <button type="button" aria-label="Smaller font" disabled={fontSize <= TERMINAL_FONT_MIN} onClick={() => setFontSize((f) => Math.max(TERMINAL_FONT_MIN, f - 1))}><Minus size={16} /></button>
              <span aria-live="polite">{fontSize}<small>px</small></span>
              <button type="button" aria-label="Larger font" disabled={fontSize >= TERMINAL_FONT_MAX} onClick={() => setFontSize((f) => Math.min(TERMINAL_FONT_MAX, f + 1))}><Plus size={16} /></button>
            </span>
          </div>
          <div className="nx-settings-row justify-between">
            <span className="flex items-center gap-3"><Type size={18} /> Font weight</span>
            <div className="flex items-center gap-1">
              {(['300', '400', '500', '600', '700'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => handleUpdateUiPrefs({ ...uiPrefs, fontWeight: w })}
                  className={cn(
                    'px-2 py-1 rounded text-xs font-mono transition',
                    uiPrefs.fontWeight === w
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-400/40'
                      : 'text-slate-400 hover:text-white bg-white/5'
                  )}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          <div className="nx-settings-row justify-between">
            <span className="flex items-center gap-3"><Rows2 size={18} /> Letter spacing</span>
            <span className="nx-stepper" role="group" aria-label="Letter spacing">
              <button
                type="button"
                disabled={uiPrefs.letterSpacing <= -1}
                onClick={() => handleUpdateUiPrefs({ ...uiPrefs, letterSpacing: Math.max(-1, uiPrefs.letterSpacing - 1) })}
              >
                <Minus size={16} />
              </button>
              <span aria-live="polite">{uiPrefs.letterSpacing === 0 ? '0' : `${uiPrefs.letterSpacing > 0 ? '+' : ''}${uiPrefs.letterSpacing}`}<small>px</small></span>
              <button
                type="button"
                disabled={uiPrefs.letterSpacing >= 3}
                onClick={() => handleUpdateUiPrefs({ ...uiPrefs, letterSpacing: Math.min(3, uiPrefs.letterSpacing + 1) })}
              >
                <Plus size={16} />
              </button>
            </span>
          </div>
          <label className="nx-settings-row flex-wrap justify-between gap-y-1">
            <span className="flex items-center gap-3"><Rows2 size={18} /> Line height</span>
            <span className="nx-settings-value font-mono" style={{ color: theme.accent }}>{lineHeight.toFixed(2)}</span>
            <input aria-label="Terminal line height" className="nx-range" type="range" min="1" max="1.5" step="0.05" value={lineHeight}
              style={{ '--nx-fill': `${((lineHeight - 1) / 0.5) * 100}%` } as React.CSSProperties}
              onChange={e => setLineHeight(Number(e.target.value))} />
          </label>
        </div>
        <h2 className="nx-section-label">Terminal input</h2>
        <label className="nx-settings-row rounded-xl border border-white/10"><input type="checkbox" checked={broadcast} onChange={e => setBroadcast(e.target.checked)} /> Broadcast to all panes in this tab</label>
        {broadcast && <p className="mt-2 text-xs text-amber-300">Input also reaches hidden sessions in the same split tab.</p>}
      </section>}
      {mobile && settingsPicker === 'autolock' && <MobileSheet title="Auto-lock" kicker="Security" subtitle="Lock the vault after a period of inactivity" icon={Timer} theme={theme} onClose={() => setSettingsPicker(null)}>
        <div className="nx-settings-group" role="radiogroup" aria-label="Auto-lock timeout">
          {AUTO_LOCK_OPTIONS.map((n) => {
            const on = autoLockMinutes === n;
            return <button key={n} type="button" role="radio" aria-checked={on} className="nx-settings-row nx-option-row justify-between"
              onClick={() => { setAutoLockMinutes(n); localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(n)); setSettingsPicker(null); }}>
              <span>{n ? `${n} minutes` : 'Off'}</span>
              {on && <Check size={18} style={{ color: theme.accent }} />}
            </button>;
          })}
        </div>
      </MobileSheet>}
      {mobile && settingsPicker === 'theme' && <MobileSheet title="Theme" kicker="Appearance" subtitle="Applies everywhere, instantly" icon={Palette} theme={theme} onClose={() => setSettingsPicker(null)}>
        <div className="nx-settings-group" role="radiogroup" aria-label="Terminal theme">
          {THEMES.map((t) => {
            const on = t.id === themeId;
            return <button key={t.id} type="button" role="radio" aria-checked={on} className="nx-settings-row nx-option-row justify-between" onClick={() => setThemeId(t.id)}>
              <span className="flex min-w-0 items-center gap-3"><ThemeSwatch t={t} large /><span className="truncate">{t.name}</span></span>
              {on && <Check size={18} style={{ color: t.accent }} />}
            </button>;
          })}
        </div>
      </MobileSheet>}
      {mobile && settingsPicker === 'font' && <MobileSheet title="Font Family" kicker="Appearance" subtitle="Select standard coding font or custom system font" icon={Type} theme={theme} onClose={() => setSettingsPicker(null)}>
        <div className="nx-settings-group" role="radiogroup" aria-label="Terminal font family">
          {POPULAR_TERMINAL_FONTS.map((f) => {
            const on = uiPrefs.fontFamily === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={on}
                className="nx-settings-row nx-option-row justify-between"
                onClick={() => {
                  handleUpdateUiPrefs({ ...uiPrefs, fontFamily: f.id });
                  if (f.id !== 'custom') setSettingsPicker(null);
                }}
              >
                <div className="flex flex-col text-left py-0.5">
                  <span className="font-semibold text-white text-sm">{f.label}</span>
                  <span className="text-[11px] text-slate-400">{f.description}</span>
                </div>
                {on && <Check size={18} style={{ color: theme.accent }} />}
              </button>
            );
          })}
          {uiPrefs.fontFamily === 'custom' && (
            <div className="p-3 border-t border-white/10 bg-white/[0.02]">
              <label className="text-xs text-slate-300 font-medium block mb-1.5">Custom Font Name</label>
              <input
                type="text"
                placeholder="e.g. Comic Code, Iosevka, Victor Mono"
                value={uiPrefs.customFontFamily}
                onChange={(e) => handleUpdateUiPrefs({ ...uiPrefs, customFontFamily: e.target.value })}
                className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
          )}
        </div>
      </MobileSheet>}
      {mobile && settingsPicker === 'quickunlock' && (
        <MobileSheet title="Device Quick Unlock" kicker="Security" subtitle="Unlock your vault with biometrics or screen lock" icon={Fingerprint} theme={theme} onClose={() => { setSettingsPicker(null); setQuickUnlockErr(null); setQuickUnlockPw(''); }}>
          <div className="space-y-4 p-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs space-y-2">
              <div className="flex items-center gap-2 font-medium text-white">
                <Fingerprint size={18} style={{ color: theme.accent }} />
                <span>Biometrics & Screen Lock</span>
              </div>
              <p className="text-slate-400 leading-relaxed">
                Status: <strong className={deviceLockEnabled ? 'text-emerald-400' : 'text-slate-300'}>{deviceLockEnabled ? 'Enabled' : 'Disabled'}</strong>
              </p>
              <p className="text-slate-400 leading-relaxed">
                When enabled, you can quickly unlock your master vault on this device using your fingerprint, face recognition, or lock pattern/PIN without typing your master password every time.
              </p>
            </div>

            {deviceLockEnabled ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await bridge.osKeychainDelete();
                    setDeviceLockEnabled(false);
                    setSettingsPicker(null);
                  } catch (e) {
                    console.error('Failed to disable quick unlock', e);
                  }
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/15 py-3 text-xs font-semibold text-rose-300 hover:bg-rose-500/25 transition cursor-pointer"
              >
                Disable Device Quick Unlock
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-300">
                  Enter your master password to enable Quick Unlock on this device:
                </p>
                <input
                  type="password"
                  placeholder="Master password"
                  value={quickUnlockPw}
                  onChange={(e) => setQuickUnlockPw(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                  style={{ outlineColor: theme.accent }}
                />
                {quickUnlockErr && (
                  <p className="text-xs text-rose-400">{quickUnlockErr}</p>
                )}
                <button
                  type="button"
                  disabled={quickUnlockBusy || quickUnlockPw.length < 4}
                  onClick={async () => {
                    setQuickUnlockBusy(true);
                    setQuickUnlockErr(null);
                    try {
                      if (mobile) {
                        try {
                          const { authenticate } = await import('@tauri-apps/plugin-biometric');
                          await authenticate('Verify Biometric / Screen Lock to Enable', {
                            allowDeviceCredential: true,
                            title: 'Drexius Vault',
                            subtitle: 'Confirm fingerprint, face or device screen lock to enable quick unlock',
                          });
                        } catch (bioErr: any) {
                          const msg = bioErr?.message || String(bioErr);
                          if (/cancel|dismiss|fail|negative/i.test(msg)) {
                            setQuickUnlockErr('Biometric confirmation was cancelled.');
                            return;
                          }
                          console.warn('Biometric opt-in prompt note:', bioErr);
                        }
                      }
                      const success = await bridge.osKeychainStore(quickUnlockPw);
                      if (success) {
                        setDeviceLockEnabled(true);
                        setSettingsPicker(null);
                        setQuickUnlockPw('');
                      } else {
                        setQuickUnlockErr('Failed to enable quick unlock.');
                      }
                    } catch (e: any) {
                      setQuickUnlockErr(e?.message || String(e));
                    } finally {
                      setQuickUnlockBusy(false);
                    }
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold text-black hover:brightness-110 active:scale-[0.99] disabled:opacity-50 transition cursor-pointer"
                  style={{ backgroundColor: theme.accent }}
                >
                  {quickUnlockBusy ? 'Saving…' : 'Enable Device Quick Unlock'}
                </button>
              </div>
            )}
          </div>
        </MobileSheet>
      )}
      {mobile && settingsPicker === 'directlaunch' && (
        <MobileSheet
          title="Direct Launch"
          kicker="Security"
          subtitle="Open the app directly without authorization or password"
          icon={Zap}
          theme={theme}
          onClose={() => {
            setSettingsPicker(null);
            setDirectLaunchErr(null);
            setDirectLaunchPw('');
          }}
        >
          <div className="space-y-4 p-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs space-y-2">
              <div className="flex items-center gap-2 font-medium text-white">
                <Zap size={18} style={{ color: theme.accent }} />
                <span>Direct App Launch</span>
              </div>
              <p className="text-slate-400 leading-relaxed">
                Status:{' '}
                <strong className={directUnlockEnabled ? 'text-emerald-400' : 'text-slate-300'}>
                  {directUnlockEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </p>
              <p className="text-slate-400 leading-relaxed">
                When enabled, the app automatically unlocks your vault and opens your terminal directly on startup without prompting for authorization or your master password.
              </p>
              {directUnlockEnabled && (
                <p className="text-amber-400/90 text-[11px] leading-relaxed">
                  Notice: Master credentials will be stored locally on this device. Anyone who has physical access to this device can open your terminal.
                </p>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-xs text-slate-300">
                {directUnlockEnabled
                  ? 'Enter your master password to disable Direct Launch:'
                  : 'Enter your master password to enable Direct Launch:'}
              </p>
              <input
                type="password"
                placeholder="Master password"
                value={directLaunchPw}
                onChange={(e) => setDirectLaunchPw(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                style={{ outlineColor: theme.accent }}
              />
              {directLaunchErr && (
                <p className="text-xs text-rose-400">{directLaunchErr}</p>
              )}
              <button
                type="button"
                disabled={directLaunchBusy || !directLaunchPw}
                onClick={async () => {
                  setDirectLaunchBusy(true);
                  setDirectLaunchErr(null);
                  try {
                    const isValid = await bridge.vaultVerifyPassword(directLaunchPw);
                    if (!isValid) {
                      setDirectLaunchErr('Incorrect master password. Please verify and try again.');
                      setDirectLaunchBusy(false);
                      return;
                    }

                    if (!directUnlockEnabled) {
                      if (isTauri) {
                        try {
                          await bridge.osKeychainStore(directLaunchPw);
                        } catch (e) {
                          console.warn('Keychain store warning:', e);
                        }
                      }
                      bridge.setDirectUnlockEnabled(true);
                      setDirectUnlockEnabled(true);
                      toast('Direct Launch enabled');
                    } else {
                      bridge.setDirectUnlockEnabled(false);
                      if (isTauri) {
                        try {
                          await bridge.osKeychainDelete();
                        } catch (_) {}
                      }
                      setDirectUnlockEnabled(false);
                      toast('Direct Launch disabled');
                    }
                    setSettingsPicker(null);
                    setDirectLaunchPw('');
                  } catch (err: any) {
                    setDirectLaunchErr(err?.message || 'Verification failed');
                  } finally {
                    setDirectLaunchBusy(false);
                  }
                }}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold transition cursor-pointer disabled:opacity-50',
                  directUnlockEnabled
                    ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                    : 'text-black hover:brightness-110 active:scale-[0.99]'
                )}
                style={{
                  backgroundColor: directUnlockEnabled ? undefined : theme.accent,
                }}
              >
                {directLaunchBusy ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <span>{directUnlockEnabled ? 'Disable Direct Launch' : 'Enable Direct Launch'}</span>
                )}
              </button>
            </div>
          </div>
        </MobileSheet>
      )}
      {mobile && settingsPicker === 'recovery_key' && (
        <MobileSheet title="Emergency Recovery Kit" kicker="Vault Security" subtitle="Zero-knowledge recovery key for your vault" icon={KeyRound} theme={theme} onClose={() => { setSettingsPicker(null); setDownloadedRecoveryPath(null); setShowRegenConfirm(false); }}>
          <div className="space-y-4 p-2">
            <p className="text-xs text-slate-400 leading-relaxed">
              If you ever forget your master password, this 128-bit key is the <strong className="text-slate-200">ONLY way to recover your encrypted vault</strong>. Store it in a safe place.
            </p>
            {recoveryKey ? (
              <>
                <div className="rounded-xl border border-white/10 bg-black/60 p-3.5 text-center font-mono text-xs sm:text-sm font-bold tracking-wider select-all break-all" style={{ color: theme.accent }}>
                  {recoveryKey}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await bridge.writeClipboard(recoveryKey);
                        setCopiedRecovery(true);
                        setTimeout(() => setCopiedRecovery(false), 2000);
                      } catch (_) {}
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
                  >
                    {copiedRecovery ? <Check size={14} style={{ color: theme.accent }} /> : <Copy size={14} />}
                    {copiedRecovery ? 'Copied' : 'Copy Key'}
                  </button>

                  {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.share({
                            title: 'Drexius Recovery Kit',
                            text: `DREXIUS EMERGENCY RECOVERY KEY:\n${recoveryKey}\n\nKeep this secret and offline.`,
                          });
                        } catch (e: any) {
                          if (e?.name !== 'AbortError') console.warn(e);
                        }
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
                    >
                      <Share2 size={14} />
                      <span>Share / Save</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const text = `=====================================================\nDREXIUS EMERGENCY RECOVERY KIT\n=====================================================\n\nEmergency Recovery Key:\n${recoveryKey}\n\nGenerated: ${new Date().toISOString()}\n=====================================================`;
                        const path = await bridge.vaultSaveEmergencyKit(text);
                        setDownloadedRecoveryPath(path);
                      } catch (e) {
                        console.error('Download failed', e);
                      }
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
                  >
                    {downloadedRecoveryPath ? <Check size={14} className="text-emerald-400" /> : <Download size={14} />}
                    {downloadedRecoveryPath ? 'Saved' : 'Download .txt'}
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-white/10 bg-black/40 p-4 text-center space-y-3">
                <p className="text-xs text-slate-300">
                  No active recovery key is currently cached in this vault session.
                </p>
                <button
                  type="button"
                  disabled={regeneratingRecovery}
                  onClick={async () => {
                    setRegeneratingRecovery(true);
                    try {
                      const newKey = await bridge.vaultRegenerateRecoveryKey();
                      setRecoveryKey(newKey);
                    } catch (err) {
                      console.error('Failed to generate recovery key', err);
                    } finally {
                      setRegeneratingRecovery(false);
                    }
                  }}
                  className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 transition"
                >
                  {regeneratingRecovery ? 'Generating…' : 'Generate & Store Recovery Key'}
                </button>
              </div>
            )}

            {downloadedRecoveryPath && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                <p className="font-semibold text-white">Saved to Downloads:</p>
                <p className="mt-1 font-mono text-[10.5px] select-all break-all text-slate-300">{downloadedRecoveryPath}</p>
              </div>
            )}

            {recoveryKey && (
              <div className="pt-2 border-t border-white/10">
                {!showRegenConfirm ? (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => setShowRegenConfirm(true)}
                      className="text-[11px] text-slate-400 hover:text-amber-400 transition underline underline-offset-2"
                    >
                      Regenerate Emergency Recovery Key
                    </button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-2">
                    <p className="text-amber-200 font-medium leading-relaxed">
                      Warning: Regenerating will immediately invalidate any previously saved, printed, or downloaded emergency recovery kits.
                    </p>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={regeneratingRecovery}
                        onClick={async () => {
                          setRegeneratingRecovery(true);
                          try {
                            const newKey = await bridge.vaultRegenerateRecoveryKey();
                            setRecoveryKey(newKey);
                            setShowRegenConfirm(false);
                            setDownloadedRecoveryPath(null);
                          } catch (err) {
                            console.error('Failed to regenerate recovery key', err);
                          } finally {
                            setRegeneratingRecovery(false);
                          }
                        }}
                        className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 transition"
                      >
                        {regeneratingRecovery ? 'Regenerating…' : 'Yes, Replace Active Key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRegenConfirm(false)}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 transition"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </MobileSheet>
      )}
      {mobile && settingsPicker === 'storage_perms' && (
        <MobileSheet title="Storage & Permissions" kicker="System" subtitle="File access for SFTP, Downloads & terminal sessions" icon={Folder} theme={theme} onClose={() => setSettingsPicker(null)}>
          <div className="space-y-4 p-2 text-xs">
            {/* Status & 1-Click Action */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium text-white">
                  <ShieldCheck size={18} style={{ color: theme.accent }} />
                  <span>Storage Permission Status</span>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide border',
                    storageGranted === true
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : storageGranted === false
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                      : 'border-white/10 bg-white/5 text-slate-400'
                  )}
                >
                  {storageGranted === true ? 'Granted' : storageGranted === false ? 'Action Needed' : 'Checking…'}
                </span>
              </div>
              <p className="text-slate-400 leading-relaxed text-[11.5px]">
                {storageGranted === true
                  ? 'Drexius has storage access. You can browse internal storage, save recovery keys to Downloads, and transfer files via Local SFTP.'
                  : 'Storage permission is required to browse shared storage, save your Emergency Recovery Key to Downloads, and transfer files in SFTP.'}
              </p>

              {storageGranted !== true && (
                <button
                  type="button"
                  disabled={requestingPerm}
                  onClick={async () => {
                    setRequestingPerm(true);
                    try {
                      await bridge.requestStoragePermission();
                      setTimeout(async () => {
                        const ok = await bridge.checkStoragePermission();
                        setStorageGranted(ok);
                        setRequestingPerm(false);
                      }, 1200);
                    } catch (_) {
                      setRequestingPerm(false);
                    }
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold text-black hover:brightness-110 active:scale-[0.99] disabled:opacity-50 transition shadow-lg cursor-pointer"
                  style={{ backgroundColor: theme.accent }}
                >
                  <FolderLock size={16} />
                  <span>{requestingPerm ? 'Opening System Dialog…' : 'Grant Storage Permission'}</span>
                </button>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
              <div className="flex items-center gap-2 font-medium text-white">
                <Folder size={18} style={{ color: theme.accent }} />
                <span>Accessible Storage Directories</span>
              </div>
              <p className="text-slate-400 leading-relaxed text-[11.5px]">
                Drexius uses these shared storage paths for file operations:
              </p>
              <div className="font-mono text-[11px] text-cyan-300 bg-black/40 rounded-lg p-2.5 border border-white/5 space-y-1">
                <div>• /storage/emulated/0/Download</div>
                <div>• /storage/emulated/0/Documents</div>
                <div>• /storage/emulated/0</div>
              </div>
            </div>
          </div>
        </MobileSheet>
      )}

      </div>

      {!terminalScreen && <MobileNavigation page={mobilePage} sessions={terminalSessionCount} onChange={navigateMobile} theme={theme} />}
      {mobile && unlocked && sessionSheet && <MobileSheet title="Terminal sessions" kicker={`${terminalSessionCount} open`} icon={TerminalIcon} theme={theme} onClose={() => setSessionSheet(false)}>
        <p className="mb-3 text-xs text-slate-400">Switch sessions without disconnecting. Desktop splits remain intact.</p>
        <div className="space-y-2">
          {tabs.filter(t => t.kind !== 'sftp').flatMap(t => t.panes.map(p => { const current = t.id === activeTabId && t.activePaneId === p.id; return <div key={p.id} className={cn('flex items-center rounded-xl border p-1', !current && 'border-white/10 bg-white/[0.03]')}
            style={current ? { borderColor: `${theme.accent}66`, background: `${theme.accent}1a` } : undefined}>
            <button className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left" onClick={() => { navigateMobile('terminals'); setActiveTabId(t.id); focusPane(t.id, p.id); }}>
              <TerminalIcon size={19} className="shrink-0" style={{ color: theme.accent }} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{hostMap.get(p.hostId)?.label ?? t.title}</span><span className="block truncate text-xs text-slate-400">{registry.get(p.id)?.status ?? 'connecting'} · {hostMap.get(p.hostId)?.hostname}</span></span>
            </button>
            <button className="nx-touch-button text-slate-400" aria-label={`Close ${hostMap.get(p.hostId)?.label ?? 'session'}`} onClick={() => closePane(t.id, p.id)}><X size={18} /></button>
          </div>; }))}
          {!tabs.some(t => t.panes.length) && <p className="py-6 text-center text-sm text-slate-400">No sessions yet. Connect to a saved host to get started.</p>}
        </div>
        <button className="nx-settings-row mt-4 rounded-xl" style={{ background: `${theme.accent}1a`, color: theme.accent }} onClick={() => navigateMobile('hosts')}><Plus size={18} /> Connect to a host</button>
        <button className="nx-settings-row" onClick={() => { openLocalTerminal(); setSessionSheet(false); }}><TerminalIcon size={18} /> Open local terminal</button>
        {isAndroid && (
          <button className="nx-settings-row" onClick={() => { setSessionSheet(false); openTermuxPreset(); }}><TerminalIcon size={18} className="text-emerald-400" /> Termux (Local :8022)</button>
        )}
      </MobileSheet>}

      {/* Quick Connect Floating Palette */}
      {quick && (
        <div className="fixed inset-0 z-50 select-none" onClick={() => setQuick(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              top: `${quickPos.top}px`,
              left: `${quickPos.left}px`,
              backgroundColor: theme.xterm.background || '#0e131d',
              borderColor: `${theme.accent}30`,
              boxShadow: `0 16px 40px rgba(0,0,0,0.65), 0 0 24px ${theme.accent}15`,
            }}
            className="absolute w-80 overflow-hidden rounded-xl border p-2 shadow-2xl backdrop-blur-xl ring-1 ring-white/10"
          >
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-20"
              style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
            />
            <div className="relative z-10 flex items-center justify-between px-2 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5">
              <span className="flex items-center gap-1.5" style={{ color: theme.accent }}>
                <Zap className="h-3 w-3" />
                Quick Connect
              </span>
              <span className="font-mono text-[9px] text-slate-500">Esc to close</span>
            </div>

            {/* Filter / Connect Input */}
            <div className="relative z-10 px-1 pt-2 pb-1.5">
              <input
                autoFocus
                type="text"
                value={quickFilter}
                onChange={(e) => setQuickFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (filteredHosts.length > 0) {
                      openHost(filteredHosts[0]);
                      setQuick(false);
                    } else if (quickFilter.includes('@')) {
                      const [user, rest] = quickFilter.split('@');
                      const [hostStr, portStr] = (rest || '').split(':');
                      const port = parseInt(portStr) || 22;
                      setQuick(false);
                      setModal({
                        host: {
                          id: uid(),
                          label: quickFilter,
                          hostname: hostStr || '',
                          port,
                          username: user || 'root',
                          authMethod: 'key',
                          tags: [],
                          hasSecret: false,
                        },
                      });
                    } else if (!quickFilter || 'local terminal'.includes(quickFilter.toLowerCase())) {
                      openLocalTerminal();
                      setQuick(false);
                    }
                  }
                }}
                placeholder="Search hosts or user@host…"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors"
                style={{
                  borderColor: quickFilter ? `${theme.accent}60` : undefined,
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = `${theme.accent}70`;
                  e.currentTarget.style.boxShadow = `0 0 0 2px ${theme.accent}20`;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = quickFilter ? `${theme.accent}60` : 'rgba(255,255,255,0.1)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>

            <div className="relative z-10 max-h-72 overflow-y-auto space-y-0.5 px-0.5">
              {/* Local Terminal Option */}
              {(!quickFilter || 'local terminal'.includes(quickFilter.toLowerCase())) && (
                <button
                  onClick={() => {
                    openLocalTerminal();
                    setQuick(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
                >
                  <div
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition"
                    style={{
                      backgroundColor: `${theme.accent}20`,
                      color: theme.accent,
                    }}
                  >
                    <TerminalIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-200 group-hover:text-white">Local Terminal</div>
                    <div className="text-[10px] text-slate-500">{isAndroid ? 'Android /system/bin/sh' : 'bash / zsh shell'}</div>
                  </div>
                </button>
              )}

              {/* Termux Local Bridge Option (Android only) */}
              {isAndroid && (!quickFilter || 'termux local 8022'.includes(quickFilter.toLowerCase())) && (
                <button
                  onClick={() => {
                    openTermuxPreset();
                    setQuick(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
                >
                  <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400 transition">
                    <TerminalIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-200 group-hover:text-white">Termux (Local :8022)</div>
                    <div className="text-[10px] text-slate-500">127.0.0.1:8022 · full userland</div>
                  </div>
                </button>
              )}

              {/* Saved Hosts */}
              {filteredHosts.map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    openHost(h);
                    setQuick(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: h.color ?? '#64748b' }}
                  />
                  <div className="min-w-0 flex-1 truncate">
                    <div className="text-xs font-medium text-slate-200 group-hover:text-white">
                      {h.label}
                    </div>
                    <div className="truncate font-mono text-[10px] text-slate-500">
                      {h.username}@{h.hostname}:{h.port}
                    </div>
                  </div>
                </button>
              ))}

              {/* Quick connect to new user@host */}
              {quickFilter.includes('@') && (
                <button
                  onClick={() => {
                    const [user, rest] = quickFilter.split('@');
                    const [hostStr, portStr] = (rest || '').split(':');
                    const port = parseInt(portStr) || 22;
                    setQuick(false);
                    setModal({
                      host: {
                        id: uid(),
                        label: quickFilter,
                        hostname: hostStr || '',
                        port,
                        username: user || 'root',
                        authMethod: 'key',
                        tags: [],
                        hasSecret: false,
                      },
                    });
                  }}
                  className="flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition"
                  style={{
                    backgroundColor: `${theme.accent}15`,
                    borderColor: `${theme.accent}40`,
                    color: theme.accent,
                  }}
                >
                  <Zap className="h-4 w-4 shrink-0" style={{ color: theme.accent }} />
                  <div className="min-w-0 flex-1 truncate text-xs">
                    Quick setup & connect to <span className="font-semibold text-white">{quickFilter}</span>
                  </div>
                </button>
              )}
            </div>

            <div className="relative z-10 mt-1.5 border-t border-white/5 pt-1.5 flex items-center justify-between">
              <button
                onClick={() => {
                  setQuick(false);
                  setModal({ host: null });
                }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-white/5 transition"
                style={{ color: theme.accent }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New host…</span>
              </button>
              <button
                onClick={() => {
                  setQuick(false);
                  setShowSshConfig(true);
                }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-amber-300 hover:bg-white/5 transition"
              >
                <FolderInput className="h-3 w-3" />
                <span>Import ~/.ssh/config</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <HostModal
          host={modal.host}
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => setModal(null)}
          onSave={saveHost}
          theme={theme}
        />
      )}
      {showSshConfig && (
        <SshConfigModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => setShowSshConfig(false)}
          onSuccess={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showTailscale && (
        <TailscaleModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => {
            setShowTailscale(false);
            handleReturnToSettings();
          }}
          onSuccess={refresh}
          onDirectConnect={(h) => {
            setReturnToSettingsTab(null);
            const tempHost: Host = {
              id: uid(),
              label: h.label || 'Tailscale Host',
              hostname: h.hostname || '',
              port: h.port || 22,
              username: h.username || 'root',
              authMethod: h.authMethod || 'key',
              group: 'Tailscale',
              tags: ['tailscale'],
              hasSecret: false,
              os: h.os || null,
            };
            openHost(tempHost);
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showNetbird && (
        <NetbirdModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => {
            setShowNetbird(false);
            handleReturnToSettings();
          }}
          onSuccess={refresh}
          onDirectConnect={(h) => {
            setReturnToSettingsTab(null);
            const tempHost: Host = {
              id: uid(),
              label: h.label || 'NetBird Peer',
              hostname: h.hostname || '',
              port: h.port || 22,
              username: h.username || 'root',
              authMethod: h.authMethod || 'key',
              group: 'NetBird',
              tags: h.tags || ['netbird'],
              hasSecret: false,
              os: h.os || null,
            };
            openHost(tempHost);
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showCloudSync && (
        <CloudSyncModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => {
            setShowCloudSync(false);
            handleReturnToSettings();
          }}
          onSuccess={(liveInstances) => {
            if (liveInstances?.length) mergeCloudStatuses(liveInstances);
            refresh();
          }}
          onDirectConnect={(h) => {
            setReturnToSettingsTab(null);
            const tempHost: Host = {
              id: uid(),
              label: h.label || 'Cloud Instance',
              hostname: h.hostname || '',
              port: h.port || 22,
              username: h.username || 'root',
              authMethod: h.authMethod || 'key',
              group: h.group || 'Cloud',
              tags: h.tags || ['cloud'],
              hasSecret: false,
              os: h.os || null,
            };
            openHost(tempHost);
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showDockerModal && (
        <DockerModal
          hosts={hosts}
          activeHostId={dockerHostId || (terminalContext?.panes.find((p) => p.id === activePaneId)?.isLocal ? '__local__' : terminalContext?.panes.find((p) => p.id === activePaneId)?.hostId)}
          onOpenTerminalWithCommand={(cmd, hostId) => {
            setReturnToSettingsTab(null);
            openTerminalWithCommand(cmd, hostId);
          }}
          onClose={() => {
            setShowDockerModal(false);
            handleReturnToSettings();
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {shareModal && (
        <TeamShareModal
          vaults={vaults}
          hosts={hosts}
          activeVaultId={activeVaultId}
          initialTab={shareModal.initialTab}
          onClose={() => setShareModal(null)}
          onRefresh={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showSerial && (
        <SerialModal
          theme={theme}
          onClose={() => setShowSerial(false)}
          onConnect={handleConnectSerial}
        />
      )}
      {showPairing && (
        <DevicePairingModal
          initialTab={showPairing.initialTab}
          onClose={() => {
            setShowPairing(null);
            handleReturnToSettings();
          }}
          onRefresh={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showSync && (
        <SyncModal
          onClose={() => {
            setShowSync(false);
            handleReturnToSettings();
          }}
          onOpenPairing={() => {
            setShowSync(false);
            setShowPairing({ initialTab: 'share' });
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showSettings && (
        <SettingsModal
          initialTab={settingsTab}
          onTabChange={setSettingsTab}
          onClose={() => {
            setShowSettings(false);
            setReturnToSettingsTab(null);
          }}
          theme={theme}
          themeId={themeId}
          onThemeSelect={setThemeId}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          lineHeight={lineHeight}
          onLineHeightChange={setLineHeight}
          zen={zen}
          onZenChange={setZen}
          showRail={showRail}
          onShowRailChange={setShowRail}
          showStatusBar={showStatusBar}
          onShowStatusBarChange={setShowStatusBar}
          autoLockMinutes={autoLockMinutes}
          onAutoLockChange={(m) => {
            setAutoLockMinutes(m);
            try { localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(m)); } catch {}
          }}
          uiPrefs={uiPrefs}
          onUiPrefsChange={handleUpdateUiPrefs}
          shortcuts={shortcuts}
          onShortcutsChange={handleUpdateShortcuts}
          onOpenPairing={(fromTab) => openFromSettings(() => setShowPairing({ initialTab: 'share' }), fromTab ?? 'sync')}
          onOpenSync={(fromTab) => openFromSettings(() => setShowSync(true), fromTab ?? 'sync')}
          onOpenTailscale={(fromTab) => openFromSettings(() => setShowTailscale(true), fromTab ?? 'sync')}
          onOpenNetbird={(fromTab) => openFromSettings(() => setShowNetbird(true), fromTab ?? 'sync')}
          onOpenCloudSync={(fromTab) => openFromSettings(() => setShowCloudSync(true), fromTab ?? 'sync')}
          onOpenDocker={(fromTab) => openFromSettings(() => setShowDockerModal(true), fromTab ?? 'sync')}
          onOpenKeychain={(fromTab) => openFromSettings(() => setPanel('keychain'), fromTab ?? 'security')}
          onOpenTunnels={(fromTab) => openFromSettings(() => setPanel('tunnels'), fromTab ?? 'sync')}
          onOpenLogs={(fromTab) => openFromSettings(() => setPanel('logs'), fromTab ?? (settingsTab === 'terminal' ? 'terminal' : 'security'))}
          onOpenKnownHosts={(fromTab) => openFromSettings(() => setPanel('known_hosts'), fromTab ?? 'security')}
          onLockVault={lock}
          storageGranted={storageGranted}
          onRequestStoragePermission={async () => {
            try {
              await bridge.requestStoragePermission();
              const ok = await bridge.checkStoragePermission();
              setStorageGranted(ok);
            } catch {}
          }}
          toast={toast}
        />
      )}
      {showSavePresetModal && activeTab && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className="w-full max-w-md rounded-2xl border p-5 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 text-slate-200"
            style={{
              backgroundColor: theme.xterm.background || '#0e131d',
              borderColor: `${theme.accent}30`,
              boxShadow: `0 20px 50px rgba(0,0,0,0.8), 0 0 30px ${theme.accent}20`,
            }}
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Bookmark className="h-4 w-4" style={{ color: theme.accent }} />
                <h3 className="font-semibold text-white text-sm">Save Layout Preset</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSavePresetModal(false)}
                className="text-slate-400 hover:text-white transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Preset Name</label>
                <input
                  type="text"
                  autoFocus
                  value={presetNameInput}
                  onChange={(e) => setPresetNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSavePreset();
                    if (e.key === 'Escape') setShowSavePresetModal(false);
                  }}
                  placeholder="e.g. Full Stack Dev, Cloud Operations"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1"
                  style={{ borderColor: `${theme.accent}60` }}
                />
              </div>

              <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between text-slate-300">
                  <span className="text-slate-400">Layout Geometry:</span>
                  <span className="font-mono font-semibold" style={{ color: theme.accent }}>
                    {getLayoutDescription(activeTab.layout)}
                  </span>
                </div>
                <div className="flex items-start justify-between text-slate-300">
                  <span className="text-slate-400 shrink-0">Panes ({activeTab.panes.length}):</span>
                  <span className="text-right truncate ml-2 text-slate-300">
                    {activeTab.panes.map((p) => hostMap.get(p.hostId)?.label || (p.isLocal ? 'Local Terminal' : 'Host')).join(' • ')}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
              <button
                type="button"
                onClick={() => setShowSavePresetModal(false)}
                className="px-3 py-1.5 text-xs rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSavePreset}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg text-white transition shadow-sm"
                style={{
                  backgroundColor: theme.accent,
                  color: '#000000',
                }}
              >
                Save Preset
              </button>
            </div>
          </div>
        </div>
      )}
      {toastMsg && <div role="status" className="nx-toast nx-rise fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-[#121826]/95 px-4 py-2 text-xs text-slate-200 shadow-2xl backdrop-blur">{toastMsg}</div>}
    </div>
    </WorkspaceAccessContext.Provider>
    {/* In-app replacement for window.confirm(); portaled above the lock screen so it also serves the lock UI. */}
    <ConfirmHost theme={theme} />
    </>
  );
}

function Welcome({
  hosts,
  recentHostIds,
  theme,
  onOpen,
  onLocal,
  onTermux,
  onNew,
  onSshConfig,
  onViewAll,
}: {
  hosts: Host[];
  recentHostIds: string[];
  theme: DrexiusTheme;
  onOpen: (h: Host) => void;
  onLocal: () => void;
  onTermux?: () => void;
  onNew: () => void;
  onSshConfig: () => void;
  onViewAll?: () => void;
}) {
  const displayHosts = useMemo(() => {
    const hostMap = new Map(hosts.map((h) => [h.id, h]));
    const seen = new Set<string>();
    const list: (Host & { isRecent?: boolean })[] = [];

    // Prioritize recently used hosts
    for (const id of recentHostIds) {
      const h = hostMap.get(id);
      if (h && !seen.has(id)) {
        seen.add(id);
        list.push({ ...h, isRecent: true });
      }
    }

    // Then fill with any other saved hosts
    for (const h of hosts) {
      if (!seen.has(h.id)) {
        seen.add(h.id);
        list.push({ ...h, isRecent: false });
      }
    }

    return list.slice(0, 6);
  }, [hosts, recentHostIds]);

  const hasRecent = recentHostIds.some((id) => hosts.some((h) => h.id === id));

  return (
    <div className="relative grid h-full place-items-center overflow-y-auto overflow-x-hidden no-scrollbar">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.08),transparent_60%)]" />
        <div className="nx-blob pointer-events-none absolute left-1/4 top-1/3 h-72 w-72 rounded-full bg-cyan-500/10 blur-[100px]" />
        <div className="nx-blob-2 pointer-events-none absolute right-1/4 bottom-1/4 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      </div>
      <div className="relative w-full max-w-2xl px-6 py-6 text-center">
        <img src={drexiusLogo} alt="Drexius" className="nx-float mx-auto h-20 w-20 rounded-2xl shadow-[0_0_60px_-10px_rgba(34,211,238,0.5)]" />
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-white">Where to today?</h1>
        <p className="mt-2 text-sm text-slate-500">Pick a host to open an encrypted session. Select a host to get started; your sessions stay connected while you switch.</p>
        
        {displayHosts.length > 0 && (
          <div className="mt-8 text-left">
            <div className="flex items-center justify-between px-1 mb-2.5">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" style={{ color: theme.accent }} />
                <span>{hasRecent ? 'Recent & Saved Hosts' : 'Saved Hosts'}</span>
              </span>
              {hosts.length > displayHosts.length && onViewAll && (
                <button
                  type="button"
                  onClick={onViewAll}
                  className="text-xs font-medium hover:underline transition cursor-pointer"
                  style={{ color: theme.accent }}
                >
                  View all ({hosts.length}) →
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {displayHosts.map((h) => (
                <button
                  key={h.id}
                  onClick={() => onOpen(h)}
                  className="group relative flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.05] cursor-pointer"
                >
                  <OsIcon os={h.os} color={h.color} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-200 truncate">{h.label}</span>
                      {h.isRecent && (
                        <span
                          className="text-[9px] font-mono px-1.5 py-0 rounded border shrink-0"
                          style={{
                            backgroundColor: `${theme.accent}15`,
                            borderColor: `${theme.accent}30`,
                            color: theme.accent,
                          }}
                        >
                          Recent
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-slate-500">{h.username}@{h.hostname}</div>
                  </div>
                  <span className="ml-auto text-xs opacity-0 transition group-hover:opacity-100 shrink-0" style={{ color: theme.accent }}>Connect →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button onClick={onLocal} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/20 transition cursor-pointer">
            <TerminalIcon className="h-3.5 w-3.5" />Open Local Terminal
          </button>
          {onTermux && (
            <button onClick={onTermux} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-400/20 transition cursor-pointer">
              <TerminalIcon className="h-3.5 w-3.5" />Termux (Local :8022)
            </button>
          )}
          <button onClick={onNew} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-4 py-2 text-xs text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200 transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" />Add a new host
          </button>
          <button onClick={onSshConfig} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-amber-400/25 bg-amber-400/[0.03] px-4 py-2 text-xs text-amber-300/80 hover:border-amber-400/50 hover:text-amber-200 transition cursor-pointer">
            <FolderInput className="h-3.5 w-3.5 text-amber-400" />Import ~/.ssh/config
          </button>
        </div>
      </div>
    </div>
  );
}



