import { useMobile, useMobileViewport } from './hooks/useMobile';
import { useBackHandler } from './hooks/useBackHandler';
import {
  BackPriority,
  pushMobileRouteHistory,
  resolveMobileBackTarget,
} from './lib/backNavigation';
import { MobileNavigation, type MobilePage } from './components/MobileNavigation';
import { clampTerminalFontSize } from './lib/mobileTerminal';
import { WorkspaceAccessContext } from './components/MobileSheet';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import {
  ShieldCheck,
  Activity,
  History,
  Zap,
  Command,
  Minimize2,
  LayoutGrid,
  ArrowLeftRight,
  Rocket,
} from 'lucide-react';
import { bridge, isTauri } from './lib/bridge';
import { registry } from './lib/sessions';
import {
  type SplitDirection,
  computeRects,
  computeSplits,
  ensureTree,
  equalize,
  fromPresetTree,
  hasLeaf,
  leaf,
  leafIds,
  lastLeafId,
  neighborPane,
  removeLeaf,
  setRatio,
  splitLeaf,
  swapLeaves,
  treeFromLayout,
} from './lib/splitTree';
import { THEMES, getAccentContrastText, isLightTheme, loadCustomThemes, type DrexiusTheme } from './lib/themes';
import type { CloudInstance, CloudProviderId, Host, HostSecret, KeychainItem, Layout, Pane, PopoutPaneEntry, PopoutWindowBounds, Snippet, Tab, TunnelConfig, Vault } from './lib/types';
import {
  type LayoutPreset,
  type LayoutPresetPane,
  loadUserLayoutPresets,
  saveUserLayoutPresets,
  createUserPreset,
  getLayoutDescription,
} from './lib/layoutPresets';
import { LockScreen } from './components/LockScreen';
import { LaunchSplash } from './components/LaunchSplash';
import { VaultMenu } from './components/VaultMenu';
import { isAndroidPlatform } from './lib/os';
import { SnippetsPanel } from './components/SnippetsPanel';
import { TerminalPane } from './components/TerminalPane';
import { AIPanel } from './components/AIPanel';
import { SftpTab } from './components/SftpTab';
import { PaneErrorBoundary } from './components/PaneErrorBoundary';
import { SplitDivider, paneRectStyle } from './components/SplitDivider';
import { cn } from './utils/cn';
import { safeUid } from './utils/uuid';
import { ConfirmHost, cancelPendingConfirm, confirmDialog } from './components/ConfirmDialog';
import { DrawerGrip, DrawerShell, useBottomDrawer } from './components/BottomDrawer';
import { ExtendedKeypad } from './components/ExtendedKeypad';
import { CommandSearchModal } from './components/CommandSearchModal';
import { type SettingsTab } from './components/SettingsModal';
import {
  loadUiPreferences,
  saveUiPreferences,
  loadShortcuts,
  saveShortcuts,
  DEFAULT_TERMINAL_FONT_SIZE,
  type UiPreferences,
  type ShortcutBinding,
} from './lib/settings';
import {
  AI_TINT,
  LOCAL_HOST,
  MAX_PANES_PER_TAB,
  POPOUT_ACTION_KEY,
  POPOUT_STORAGE_KEY,
  SNIPPET_TINT,
  WORKSPACE_STORAGE_KEY,
  getPopoutWindowParams,
  loadRecentHostIds,
  readAutoLockMinutes,
  readPersistedPopouts,
  readPersistedWorkspace,
  saveRecentHostIds,
  tabTree,
  type MobileSettingsPickerKind,
  type SplitMenuState,
  type TerminalDrawerKind,
  type WorkspacePanelKind,
} from './lib/workspaceState';
import { useWorkspaceShortcuts } from './hooks/useWorkspaceShortcuts';
import { Welcome } from './components/WelcomeScreen';
import { QuickConnectPalette } from './components/QuickConnectPalette';
import { SaveLayoutPresetModal } from './components/WorkspaceLayoutMenu';
import { WorkspaceHeader, WorkspaceSidebarRail, WorkspaceSidePanel } from './components/WorkspaceHeaderAndRail';
import { MobileSessionsSheet, MobileSettingsPickers, MobileSettingsSection } from './components/MobileWorkspaceSheets';
import { WorkspaceModals } from './components/WorkspaceModals';

const uid = safeUid;

export default function App() {
  const mobile = useMobile();
  useMobileViewport();
  const isAndroid = useMemo(() => isAndroidPlatform(), []);
  const popoutParams = useMemo(() => getPopoutWindowParams(), []);
  const isPopoutWindow = popoutParams.isPopout;

  useEffect(() => {
    if (isPopoutWindow) {
      document.documentElement.dataset.popout = 'true';
    }
    if (isTauri && !isAndroid) {
      document.documentElement.dataset.platform = 'desktop';
    }
  }, [isPopoutWindow, isAndroid]);
  const persistedWorkspace = useMemo(() => (popoutParams.isPopout ? null : readPersistedWorkspace()), [popoutParams.isPopout]);
  const initialPopoutTab = useMemo<Tab | null>(() => {
    if (!popoutParams.isPopout || !popoutParams.paneId) return null;
    let paneObj: Pane = {
      id: popoutParams.paneId,
      hostId: popoutParams.hostId,
      isLocal: popoutParams.isLocal,
      sessionId: popoutParams.sessionId,
      resume: true,
    };
    try {
      const raw = localStorage.getItem('drx.popout.pane.' + popoutParams.paneId);
      if (raw) {
        const parsed = JSON.parse(raw) as Pane;
        const latestSid = localStorage.getItem('drx.pane.sid.' + popoutParams.paneId);
        paneObj = {
          ...parsed,
          sessionId: latestSid || parsed.sessionId || popoutParams.sessionId,
          resume: true,
        };
      }
    } catch {}
    return {
      id: `popout_tab_${paneObj.id}`,
      title: popoutParams.title || (paneObj.isLocal ? 'Local Terminal' : 'Remote Session'),
      panes: [paneObj],
      tree: leaf(paneObj.id),
      activePaneId: paneObj.id,
    };
  }, [popoutParams]);
  const [mobilePage, setMobilePageRaw] = useState<MobilePage>(() => persistedWorkspace?.mobilePage ?? 'terminals');
  const mobilePageRef = useRef<MobilePage>(mobilePage);
  mobilePageRef.current = mobilePage;
  const [mobilePageHistory, setMobilePageHistory] = useState<MobilePage[]>([]);
  const setMobilePage = useCallback(
    (next: SetStateAction<MobilePage>, opts?: { recordHistory?: boolean }) => {
      const prev = mobilePageRef.current;
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved !== prev && opts?.recordHistory !== false) {
        setMobilePageHistory((hist) => pushMobileRouteHistory(hist, prev, resolved));
      }
      mobilePageRef.current = resolved;
      setMobilePageRaw(resolved);
    },
    []
  );
  // Phone settings pickers (auto-lock, theme, font, quick unlock, direct launch, recovery key, storage permissions)
  const [settingsPicker, setSettingsPicker] = useState<MobileSettingsPickerKind | null>(null);
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
  const [showSplash, setShowSplash] = useState(() => !popoutParams.isPopout);

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
  const [tabs, setTabs] = useState<Tab[]>(() =>
    initialPopoutTab ? [initialPopoutTab] : (persistedWorkspace?.tabs ?? [])
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    initialPopoutTab ? initialPopoutTab.id : (persistedWorkspace?.activeTabId ?? null)
  );
  const [panel, setPanel] = useState<WorkspacePanelKind | null>(() => {
    if (persistedWorkspace?.mobilePage === 'hosts') return 'hosts';
    return null;
  });
  const [showDockerModal, setShowDockerModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [dockerHostId, setDockerHostId] = useState<string | null>(null);
  const [splitMenu, setSplitMenu] = useState<SplitMenuState | null>(null);
  const [userPresets, setUserPresets] = useState<LayoutPreset[]>(() => loadUserLayoutPresets());
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const [poppedOutPanes, setPoppedOutPanes] = useState<PopoutPaneEntry[]>(() =>
    popoutParams.isPopout ? [] : readPersistedPopouts()
  );
  const [showPopoutMenu, setShowPopoutMenu] = useState(false);
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
    if (!unlocked || isPopoutWindow) return;
    try {
      localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ tabs, activeTabId, mobilePage })
      );
    } catch {}
  }, [unlocked, isPopoutWindow, tabs, activeTabId, mobilePage]);

  useEffect(() => {
    if (!unlocked || isPopoutWindow) return;
    try {
      localStorage.setItem(POPOUT_STORAGE_KEY, JSON.stringify(poppedOutPanes));
    } catch {}
  }, [unlocked, isPopoutWindow, poppedOutPanes]);

  // Reconcile open tabs with live Rust SSH sessions once on startup/unlock
  // (e.g. if WebView reloaded while Rust kept sessions alive via SessionForegroundService).
  // Must NOT re-run on routine `hosts` refreshes (focus/sync), otherwise a pane that
  // reconnected under a new sessionId while its initial `pane.sessionId` prop was older
  // would cause the new sessionId to be mistaken for an unattached session and spawn a duplicate tab.
  const reconciledSessionsRef = useRef(false);
  useEffect(() => {
    if (!unlocked || isPopoutWindow) {
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
        for (const popEntry of poppedOutPanes) {
          claimedPaneIds.add(popEntry.pane.id);
          const popSid =
            (() => {
              try { return localStorage.getItem('drx.pane.sid.' + popEntry.pane.id); } catch { return null; }
            })() || popEntry.pane.sessionId;
          if (popSid) claimedSessionIds.add(popSid);
        }
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
  const [fontSize, setFontSize] = useState(() => {
    const stored = Number(localStorage.getItem('drx.font'));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TERMINAL_FONT_SIZE;
  });
  // Mirror for the capture-phase keyboard handler, whose listener is not re-registered per zoom step.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  // Brief on-screen readout while the font size changes from the keyboard (mirrors the pinch HUD).
  const [fontZoomHud, setFontZoomHud] = useState<number | null>(null);
  const fontZoomHudTimer = useRef<number | null>(null);
  const showFontZoomHud = useCallback((size: number) => {
    setFontZoomHud(size);
    if (fontZoomHudTimer.current !== null) window.clearTimeout(fontZoomHudTimer.current);
    fontZoomHudTimer.current = window.setTimeout(() => setFontZoomHud(null), 900);
  }, []);

  const updatePaneFontSize = useCallback((tabId: string, paneId: string, nextSize: number | undefined) => {
    const clamped = nextSize === undefined ? undefined : clampTerminalFontSize(nextSize);
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== tabId || t.kind === 'sftp') return t;
        const target = t.panes.find((p) => p.id === paneId);
        if (!target || (target.fontSize === clamped && t.activePaneId === paneId)) return t;
        return {
          ...t,
          activePaneId: paneId,
          panes: t.panes.map((p) =>
            p.id === paneId
              ? clamped === undefined
                ? (() => {
                    const { fontSize: _omit, ...rest } = p;
                    return rest;
                  })()
                : { ...p, fontSize: clamped }
              : p
          ),
        };
      })
    );
  }, []);

  const handleGlobalFontSizeChange = useCallback((nextOrUpdater: number | ((prev: number) => number)) => {
    setFontSize((prev) => {
      const raw = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      return clampTerminalFontSize(raw);
    });
    setTabs((ts) => {
      if (!ts.some((t) => t.panes.some((p) => p.fontSize !== undefined))) return ts;
      return ts.map((t) => ({
        ...t,
        panes: t.panes.map((p) => {
          if (p.fontSize === undefined) return p;
          const { fontSize: _omit, ...rest } = p;
          return rest;
        }),
      }));
    });
  }, []);
  const [lineHeight, setLineHeight] = useState(() => Number(localStorage.getItem('drx.lineHeight') ?? 1.0));
  const [showThemes, setShowThemes] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [modal, setModal] = useState<{ host: Host | null } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');
  const [quickPos, setQuickPos] = useState<{ top: number; left: number }>({ top: 40, left: 200 });
  const quickBtnRef = useRef<HTMLButtonElement>(null);
  const [zen, setZen] = useState(() => !popoutParams.isPopout && localStorage.getItem('drx.zen') === '1');
  const [showRail, setShowRail] = useState(() => !popoutParams.isPopout && localStorage.getItem('drx.rail') === '1');
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

  const [customThemes, setCustomThemes] = useState<DrexiusTheme[]>(() => loadCustomThemes());
  useEffect(() => {
    const onThemesChanged = () => {
      setCustomThemes(loadCustomThemes());
    };
    window.addEventListener('drx:themes-changed', onThemesChanged);
    return () => window.removeEventListener('drx:themes-changed', onThemesChanged);
  }, []);

  const allThemes = useMemo(() => [...THEMES, ...customThemes], [customThemes]);
  const theme = allThemes.find((t) => t.id === themeId) ?? allThemes[0];
  const lightTheme = isLightTheme(theme);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = lightTheme ? 'light' : 'dark';
    root.style.colorScheme = lightTheme ? 'light' : 'dark';
    root.style.setProperty('--nx-accent', theme.accent || '#22d3ee');
    root.style.setProperty('--nx-accent-fg', getAccentContrastText(theme.accent));
    root.style.setProperty('--nx-bg', theme.xterm.background || (lightTheme ? '#eff1f5' : '#0a0d14'));
    root.style.setProperty('--nx-surface', lightTheme ? '#ffffff' : '#0e131d');
    root.style.setProperty('--nx-surface-elevated', lightTheme ? '#f8fafc' : '#121826');
  }, [theme, lightTheme]);
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
  useEffect(() => { if (!isPopoutWindow) localStorage.setItem('drx.zen', zen ? '1' : '0'); }, [zen, isPopoutWindow]);

  useEffect(() => { if (!isPopoutWindow) localStorage.setItem('drx.rail', showRail ? '1' : '0'); }, [showRail, isPopoutWindow]);
  useEffect(() => { if (!isPopoutWindow) localStorage.setItem('drx.status', showStatusBar ? '1' : '0'); }, [showStatusBar, isPopoutWindow]);
  useEffect(() => { localStorage.setItem('drx.vault.active', activeVaultId); }, [activeVaultId]);

  const refresh = useCallback(async () => {
    const [h, s, k, tun, v] = await Promise.all([
      bridge.listHosts(),
      bridge.listSnippets(),
      bridge.listKeychain(),
      bridge.listTunnels(),
      bridge.listVaults(),
    ]);
    const corrupted = h.filter(
      (host) => host.port === 0 || (host.hostname === 'localhost' && host.username === 'local')
    );
    if (corrupted.length > 0) {
      const [logs, knownHosts] = await Promise.all([
        bridge.listLogs(500).catch(() => []),
        bridge.listKnownHosts().catch(() => []),
      ]);
      for (const bad of corrupted) {
        const matchingLog = logs.find(
          (l) =>
            (l.hostId === bad.id || l.hostLabel.toLowerCase() === bad.label.toLowerCase()) &&
            l.hostname &&
            l.hostname !== 'localhost' &&
            l.username !== 'local'
        );
        if (matchingLog) {
          const kh = knownHosts.find((x) => x.host === matchingLog.hostname && x.port > 0);
          const restoredPort = kh?.port ?? 22;
          let restoredKeychainId = bad.keychainId ?? null;
          let restoredAuth: Host['authMethod'] = bad.hasSecret ? 'password' : 'key';
          if (!bad.hasSecret && k.length > 0) {
            const matchedKc = k.find((item) => item.username === matchingLog.username) ?? k[0];
            if (matchedKc) {
              restoredKeychainId = matchedKc.id;
              restoredAuth = matchedKc.authMethod;
            }
          }
          const repairedHost: Host = {
            ...bad,
            hostname: matchingLog.hostname,
            port: restoredPort,
            username: matchingLog.username || 'root',
            authMethod: restoredAuth,
            keychainId: restoredKeychainId,
          };
          await bridge.saveHost(repairedHost).catch(() => {});
          const idx = h.findIndex((x) => x.id === bad.id);
          if (idx !== -1) h[idx] = repairedHost;
        }
      }
    }
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

  /**
   * Split a pane. With no `hostToUse` the new pane is a copy of the one being split: same host
   * (a fresh session), same local shell, and it starts in the same directory. `targetPaneId`
   * defaults to the focused pane.
   */
  const splitPaneInDirection = useCallback(
    async (direction: SplitDirection, hostToUse?: Host, targetPaneId?: string): Promise<void> => {
      const source: Pane | undefined =
        activeTab && activeTab.kind !== 'sftp'
          ? activeTab.panes.find((p) => p.id === (targetPaneId ?? activeTab.activePaneId)) ??
            activeTab.panes.find((p) => p.id === activeTab.activePaneId)
          : activePane;
      // A serial port can only be opened once, so "copying" one gives a local shell instead.
      const h = hostToUse || (source && source.kind !== 'serial' ? hostMap.get(source.hostId) : undefined) || LOCAL_HOST;
      if (h.id && h.id !== LOCAL_HOST.id) {
        markHostRecent(h.id);
      }
      if (!activeTab || activeTab.kind === 'sftp') return openHost(h);
      if (activeTab.panes.length >= MAX_PANES_PER_TAB) {
        toast(`Maximum ${MAX_PANES_PER_TAB} panes per tab`);
        return;
      }

      if (maximizedPaneId) {
        setMaximizedPaneId(null);
      }
      const clone = source && source.kind !== 'serial' && h.id === source.hostId ? source : undefined;
      // Local shells are asked the OS: one that never emits OSC 7 would otherwise leave the
      // tracked directory stuck at wherever the shell started. SSH relies on the OSC 7 hook.
      const liveSid = clone ? registry.get(clone.id)?.sessionId : null;
      const osCwd = clone?.isLocal && liveSid ? await bridge.localPtyCwd(liveSid) : null;
      const cwd = osCwd ?? (clone ? registry.get(clone.id)?.cwd : undefined);
      // A new SSH session already starts in the user's home directory, so only a different
      // directory is worth a `cd` (which would otherwise show up as a typed command).
      const user = h.username;
      const atRemoteHome =
        !clone?.isLocal && !!user && (cwd === `/home/${user}` || cwd === `/Users/${user}` || (user === 'root' && cwd === '/root'));
      const newPane: Pane = {
        id: uid(),
        hostId: h.id,
        isLocal: h.id === LOCAL_HOST.id,
        ...(clone?.customShell ? { customShell: clone.customShell } : {}),
        ...(cwd && (cwd.startsWith('/') || cwd.startsWith('~/')) && !atRemoteHome ? { initialCwd: cwd } : {}),
      };
      const anchorId = source && activeTab.panes.some((p) => p.id === source.id) ? source.id : activeTab.activePaneId;

      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== activeTab.id) return t;
          const current = tabTree(t);
          const anchor = current ? (hasLeaf(current, anchorId) ? anchorId : lastLeafId(current)) : null;
          const tree = current && anchor ? splitLeaf(current, anchor, newPane.id, direction) : leaf(newPane.id);
          const updatedPanes = t.panes.map((p) =>
            clone && p.id === clone.id && cwd && !atRemoteHome && p.initialCwd !== cwd
              ? { ...p, initialCwd: cwd }
              : p
          );
          const panes = [...updatedPanes, newPane];
          return {
            ...t,
            panes,
            tree,
            layout: undefined,
            activePaneId: newPane.id,
            title: t.panes.length ? `${t.title.split(' +')[0]} +${panes.length - 1}` : h.label,
          };
        })
      );
      toast(`Split ${direction} with ${h.label}`);
    },
    [activeTab, activePane, hostMap, openHost, toast, maximizedPaneId, markHostRecent]
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
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== activeTab.id) return t;
          const current = tabTree(t);
          if (!current) return t;
          return { ...t, layout: newLayout, tree: treeFromLayout(newLayout, leafIds(current)) };
        })
      );
      toast(`Switched layout: ${getLayoutDescription(newLayout)}`);
    },
    [activeTab, maximizedPaneId, toast]
  );

  const equalizeActiveTab = useCallback(() => {
    if (!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length < 2) return;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== activeTab.id) return t;
        const current = tabTree(t);
        return current ? { ...t, tree: equalize(current) } : t;
      })
    );
    toast('Equalized splits');
  }, [activeTab, toast]);

  const resizeSplit = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== tabId || t.kind === 'sftp') return t;
        const current = tabTree(t);
        if (!current) return t;
        const next = setRatio(current, splitId, ratio);
        return next === t.tree ? t : { ...t, tree: next };
      })
    );
  }, []);

  const resetSplit = useCallback((tabId: string, splitId: string) => resizeSplit(tabId, splitId, 0.5), [resizeSplit]);

  const openPopoutOsWindow = useCallback(async (entry: PopoutPaneEntry) => {
    try {
      localStorage.setItem('drx.popout.pane.' + entry.pane.id, JSON.stringify(entry.pane));
    } catch {}
    const query = `popout=1&paneId=${encodeURIComponent(entry.pane.id)}&hostId=${encodeURIComponent(
      entry.pane.hostId
    )}&isLocal=${entry.pane.isLocal ? '1' : '0'}&sessionId=${encodeURIComponent(
      entry.pane.sessionId || ''
    )}&title=${encodeURIComponent(entry.title)}`;
    try {
      await bridge.popoutOpenWindow(
        entry.pane.id,
        `${entry.title} — DrexiusTerminal`,
        query,
        entry.bounds
      );
    } catch (err) {
      toast(`Failed to open pop-out window: ${String(err)}`);
    }
  }, [toast]);

  const applyLayoutPreset = useCallback(
    (preset: LayoutPreset) => {
      const currentHost = activePane ? hostMap.get(activePane.hostId) : LOCAL_HOST;
      const resolvePresetPane = (pp: LayoutPresetPane): Pane => {
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
      };

      const newPanes: Pane[] = preset.panes.map(resolvePresetPane);
      if (newPanes.length === 0 && (!preset.popoutPanes || preset.popoutPanes.length === 0)) return;

      const tabId = uid();
      if (newPanes.length > 0) {
        const ids = newPanes.map((p) => p.id);
        const tree = (preset.tree ? fromPresetTree(preset.tree, ids) : null) ?? treeFromLayout(preset.layout, ids);
        const tab: Tab = {
          id: tabId,
          title: preset.name,
          color: theme.accent,
          panes: newPanes,
          tree,
          activePaneId: ids[0],
        };

        setTabs((ts) => [...ts, tab]);
        setActiveTabId(tab.id);
      }

      if (preset.popoutPanes && preset.popoutPanes.length > 0) {
        const createdPopouts: PopoutPaneEntry[] = preset.popoutPanes.map((pp) => {
          const pane = resolvePresetPane(pp);
          const h = hostMap.get(pane.hostId);
          const title = h?.label || pp.hostLabel || pp.label || (pane.isLocal ? 'Local Terminal' : 'Remote Session');
          return {
            pane,
            originTabId: tabId,
            title,
            bounds: pp.popoutBounds,
          };
        });
        setPoppedOutPanes((prev) => [...prev, ...createdPopouts]);
        createdPopouts.forEach((entry) => {
          void openPopoutOsWindow(entry);
        });
      }

      setNewConnNonce((n) => n + 1);
      const popCount = preset.popoutPanes?.length ?? 0;
      toast(
        popCount > 0
          ? `Loaded preset: ${preset.name} (${newPanes.length} panes + ${popCount} popped out)`
          : `Loaded preset: ${preset.name} (${newPanes.length} panes)`
      );
    },
    [activePane, hostMap, theme, toast, openPopoutOsWindow]
  );

  const handleSavePreset = async () => {
    if (!activeTab || (activeTab.panes.length < 2 && poppedOutPanes.length === 0)) return;
    const tree = tabTree(activeTab);
    if (!tree) return;
    const name = presetNameInput.trim() || `Workspace ${userPresets.length + 1}`;
    const entriesWithBounds: PopoutPaneEntry[] = await Promise.all(
      poppedOutPanes.map(async (entry) => {
        try {
          const liveBounds = await bridge.popoutGetBounds(entry.pane.id);
          return liveBounds ? { ...entry, bounds: liveBounds } : entry;
        } catch {
          return entry;
        }
      })
    );
    if (entriesWithBounds.length > 0) {
      setPoppedOutPanes(entriesWithBounds);
    }
    const newPreset = createUserPreset(name, tree, activeTab.panes, hostMap, entriesWithBounds);
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

  /** Focus a pane by id, keeping a zoomed pane zoomed onto the new target. */
  const focusPaneInTab = useCallback(
    (tabId: string, paneId: string) => {
      setTabs((ts) => ts.map((t) => (t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t)));
      registry.get(paneId)?.term?.focus();
      if (maximizedPaneId) {
        setMaximizedPaneId(paneId);
      }
    },
    [maximizedPaneId]
  );

  /** Pane ids in visual (left-to-right, top-to-bottom) order. */
  const visualPaneOrder = useCallback((t: Tab): string[] => {
    const tree = tabTree(t);
    return tree ? leafIds(tree) : t.panes.map((p) => p.id);
  }, []);

  const navigateSplitDirection = useCallback((direction: SplitDirection) => {
    if (!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length <= 1) return;
    const tree = tabTree(activeTab);
    if (!tree) return;
    const nextPaneId = neighborPane(tree, activeTab.activePaneId, direction);
    if (nextPaneId && nextPaneId !== activeTab.activePaneId) {
      focusPaneInTab(activeTab.id, nextPaneId);
    }
  }, [activeTab, focusPaneInTab]);

  /** Cycle focus through panes in visual order. */
  const cyclePane = useCallback((step: 1 | -1) => {
    if (!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length <= 1) return;
    const order = visualPaneOrder(activeTab);
    const idx = order.indexOf(activeTab.activePaneId);
    const next = order[(idx + step + order.length) % order.length];
    if (next) focusPaneInTab(activeTab.id, next);
  }, [activeTab, focusPaneInTab, visualPaneOrder]);

  /** Cycle forward/backward through open workspace tabs. */
  const cycleTab = useCallback(
    (step: 1 | -1) => {
      if (!unlocked || showSplash || isPopoutWindow || tabs.length <= 1) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const nextIdx = idx === -1 ? 0 : (idx + step + tabs.length) % tabs.length;
      const nextTab = tabs[nextIdx];
      if (nextTab) setActiveTabId(nextTab.id);
    },
    [unlocked, showSplash, isPopoutWindow, tabs, activeTabId]
  );

  /** Jump directly to open tab 1–8, or to the last open tab on 9. */
  const selectTabByNumber = useCallback(
    (tabNumber: number) => {
      if (!unlocked || showSplash || isPopoutWindow || tabs.length === 0) return;
      const targetIdx = tabNumber === 9 ? tabs.length - 1 : tabNumber - 1;
      const targetTab = tabs[targetIdx];
      if (targetTab) setActiveTabId(targetTab.id);
    },
    [unlocked, showSplash, isPopoutWindow, tabs]
  );

  const swapPanes = useCallback(
    (tabId: string, paneIdA: string, paneIdB: string) => {
      if (paneIdA === paneIdB) return;
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== tabId) return t;
          const current = tabTree(t);
          if (!current || !hasLeaf(current, paneIdA) || !hasLeaf(current, paneIdB)) return t;
          return {
            ...t,
            tree: swapLeaves(current, paneIdA, paneIdB),
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
    (direction: SplitDirection) => {
      if (!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length <= 1) return;
      const tree = tabTree(activeTab);
      if (!tree) return;
      const currentId = activeTab.activePaneId;
      const targetId = neighborPane(tree, currentId, direction);
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
        const before = tabTree(t);
        const removed = before && hasLeaf(before, paneId) ? removeLeaf(before, paneId) : null;
        const tree = ensureTree(removed ? removed.tree : before, panes.map((p) => p.id), t.layout) ?? undefined;
        const heir = removed?.focus && panes.some((p) => p.id === removed.focus) ? removed.focus : panes[0]?.id ?? '';
        return {
          ...t,
          panes,
          tree,
          layout: undefined,
          activePaneId: t.activePaneId === paneId ? heir : t.activePaneId,
          title: panes.length > 1 ? `${t.title.split(' +')[0]} +${panes.length - 1}` : hostMap.get(panes[0]?.hostId ?? '')?.label ?? t.title,
        };
      }).filter((t) => t.kind === 'sftp' || t.panes.length);
    });
  }, [hostMap, cleanupPaneSession]);

  const popOutPane = useCallback(
    (tabId?: string, targetPaneId?: string, initialBounds?: PopoutWindowBounds) => {
      if (mobile || isPopoutWindow) return;
      const tId = tabId ?? activeTab?.id;
      if (!tId) return;
      const targetTab = tabs.find((t) => t.id === tId);
      if (!targetTab || targetTab.kind === 'sftp' || targetTab.panes.length === 0) return;
      const pId = targetPaneId ?? targetTab.activePaneId;
      const targetPane = targetTab.panes.find((p) => p.id === pId) ?? targetTab.panes[0];
      if (!targetPane) return;

      const reg = registry.get(targetPane.id);
      const storageSid = (() => {
        try { return localStorage.getItem('drx.pane.sid.' + targetPane.id); } catch { return null; }
      })();
      const sid = reg?.sessionId || storageSid || targetPane.sessionId || null;
      if (sid) {
        try { localStorage.setItem('drx.pane.sid.' + targetPane.id, sid); } catch {}
      }

      const detachedPane: Pane = {
        ...targetPane,
        sessionId: sid,
        initialCwd: reg?.cwd || targetPane.initialCwd,
        resume: true,
      };
      const h = hostMap.get(detachedPane.hostId);
      const title = h?.label || (detachedPane.isLocal ? 'Local Terminal' : 'Remote Session');
      const entry: PopoutPaneEntry = {
        pane: detachedPane,
        originTabId: targetTab.id,
        title,
        bounds: initialBounds,
      };

      setMaximizedPaneId((prev) => (prev === targetPane.id ? null : prev));
      setTabs((ts) =>
        ts
          .map((t) => {
            if (t.id !== targetTab.id) return t;
            const panes = t.panes.filter((p) => p.id !== targetPane.id);
            const before = tabTree(t);
            const removed = before && hasLeaf(before, targetPane.id) ? removeLeaf(before, targetPane.id) : null;
            const tree = ensureTree(removed ? removed.tree : before, panes.map((p) => p.id), t.layout) ?? undefined;
            const heir =
              removed?.focus && panes.some((p) => p.id === removed.focus)
                ? removed.focus
                : panes[0]?.id ?? '';
            return {
              ...t,
              panes,
              tree,
              layout: undefined,
              activePaneId: t.activePaneId === targetPane.id ? heir : t.activePaneId,
              title:
                panes.length > 1
                  ? `${t.title.split(' +')[0]} +${panes.length - 1}`
                  : hostMap.get(panes[0]?.hostId ?? '')?.label ?? t.title,
            };
          })
          .filter((t) => t.kind === 'sftp' || t.panes.length > 0)
      );

      setPoppedOutPanes((prev) => [...prev.filter((x) => x.pane.id !== detachedPane.id), entry]);
      void openPopoutOsWindow(entry);
      toast(`Popped out ${title} to standalone window`);
    },
    [mobile, isPopoutWindow, activeTab, tabs, hostMap, openPopoutOsWindow, toast]
  );

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const popoutActionSentRef = useRef(false);

  const collectPopoutPanes = useCallback((sourceTabs: Tab[]): Pane[] => {
    const collected: Pane[] = [];
    for (const t of sourceTabs) {
      if (t.kind === 'sftp') continue;
      for (const p of t.panes) {
        const reg = registry.get(p.id);
        const storageSid = (() => {
          try { return localStorage.getItem('drx.pane.sid.' + p.id); } catch { return null; }
        })();
        const sid = reg?.sessionId || storageSid || p.sessionId || null;
        if (sid) {
          try { localStorage.setItem('drx.pane.sid.' + p.id, sid); } catch {}
        }
        collected.push({
          ...p,
          sessionId: sid,
          initialCwd: reg?.cwd || p.initialCwd,
          resume: true,
        });
      }
    }
    return collected;
  }, []);

  useEffect(() => {
    if (!isPopoutWindow || !popoutParams.paneId) return;
    const currentPanes = collectPopoutPanes(tabs);
    if (currentPanes.length > 0) {
      try {
        localStorage.setItem('drx.popout.panes.' + popoutParams.paneId, JSON.stringify(currentPanes));
      } catch {}
    }
  }, [isPopoutWindow, popoutParams.paneId, tabs, collectPopoutPanes]);

  const sendPopoutAction = useCallback(
    (action: 'dock' | 'close') => {
      if (!isPopoutWindow || !popoutParams.paneId || popoutActionSentRef.current) return;
      popoutActionSentRef.current = true;
      const currentPanes = collectPopoutPanes(tabsRef.current);
      if (action === 'close') {
        for (const p of currentPanes) {
          cleanupPaneSession(p);
        }
      }
      try {
        localStorage.setItem(
          POPOUT_ACTION_KEY,
          JSON.stringify({
            action,
            paneId: popoutParams.paneId,
            panes: currentPanes,
            ts: Date.now(),
          })
        );
      } catch {}
      bridge.popoutCloseWindow(popoutParams.paneId).catch(() => {});
      try { window.close(); } catch {}
    },
    [isPopoutWindow, popoutParams.paneId, collectPopoutPanes, cleanupPaneSession]
  );

  // If the user closes all tabs/panes inside a popped-out window, close the OS pop-out window
  useEffect(() => {
    if (!isPopoutWindow || !workspaceReady) return;
    if (tabs.length === 0) {
      sendPopoutAction('close');
    }
  }, [isPopoutWindow, workspaceReady, tabs.length, sendPopoutAction]);

  const dockBackPane = useCallback(
    (paneId: string, returnedPanes?: Pane[]) => {
      if (isPopoutWindow) return;
      const existingEntry = poppedOutPanes.find((x) => x.pane.id === paneId);
      const storedMultiRaw = (() => {
        try { return localStorage.getItem('drx.popout.panes.' + paneId); } catch { return null; }
      })();
      const storedPaneRaw = (() => {
        try { return localStorage.getItem('drx.popout.pane.' + paneId); } catch { return null; }
      })();
      let candidatePanes: Pane[] = [];
      if (Array.isArray(returnedPanes) && returnedPanes.length > 0) {
        candidatePanes = returnedPanes;
      } else if (storedMultiRaw) {
        try {
          const parsed = JSON.parse(storedMultiRaw);
          if (Array.isArray(parsed) && parsed.length > 0) candidatePanes = parsed as Pane[];
        } catch {}
      }
      if (candidatePanes.length === 0) {
        let singlePane: Pane | null = existingEntry?.pane ?? null;
        if (!singlePane && storedPaneRaw) {
          try { singlePane = JSON.parse(storedPaneRaw) as Pane; } catch {}
        }
        if (singlePane) candidatePanes = [singlePane];
      }
      try {
        localStorage.removeItem('drx.popout.pane.' + paneId);
        localStorage.removeItem('drx.popout.panes.' + paneId);
      } catch {}
      setPoppedOutPanes((prev) => prev.filter((x) => x.pane.id !== paneId));
      bridge.popoutCloseWindow(paneId).catch(() => {});

      if (candidatePanes.length === 0) return;
      const restoredPanes: Pane[] = candidatePanes.map((p) => {
        const latestSid =
          (() => {
            try { return localStorage.getItem('drx.pane.sid.' + p.id); } catch { return null; }
          })() ||
          p.sessionId ||
          null;
        return {
          ...p,
          sessionId: latestSid,
          resume: true,
        };
      });
      const primaryPane = restoredPanes[0];
      const h = hostMap.get(primaryPane.hostId) ?? LOCAL_HOST;
      const title = existingEntry?.title || h.label || 'Terminal';
      const targetOriginId = existingEntry?.originTabId;

      setTabs((ts) => {
        const existingPaneIds = new Set(ts.flatMap((t) => t.panes.map((p) => p.id)));
        const freshPanes = restoredPanes.filter((p) => !existingPaneIds.has(p.id));
        if (freshPanes.length === 0) return ts;

        const originIdx = targetOriginId
          ? ts.findIndex(
              (t) =>
                t.id === targetOriginId &&
                t.kind !== 'sftp' &&
                t.panes.length + freshPanes.length <= MAX_PANES_PER_TAB
            )
          : -1;
        if (originIdx !== -1) {
          return ts.map((t, idx) => {
            if (idx !== originIdx) return t;
            let nextTree = tabTree(t) ?? leaf(t.panes[0].id);
            let anchorId = hasLeaf(nextTree, t.activePaneId) ? t.activePaneId : lastLeafId(nextTree);
            for (const rp of freshPanes) {
              nextTree = splitLeaf(nextTree, anchorId, rp.id, 'right');
              anchorId = rp.id;
            }
            const nextPanes = [...t.panes, ...freshPanes];
            setActiveTabId(t.id);
            return {
              ...t,
              panes: nextPanes,
              tree: nextTree,
              layout: undefined,
              activePaneId: freshPanes[freshPanes.length - 1].id,
              title: `${t.title.split(' +')[0]} +${nextPanes.length - 1}`,
            };
          });
        }
        const newTabTree =
          freshPanes.length > 1
            ? treeFromLayout(
                'columns',
                freshPanes.map((p) => p.id)
              ) ?? leaf(freshPanes[0].id)
            : leaf(freshPanes[0].id);
        const newTab: Tab = {
          id: targetOriginId && !ts.some((t) => t.id === targetOriginId) ? targetOriginId : uid(),
          title: freshPanes.length > 1 ? `${h.label} +${freshPanes.length - 1}` : h.label,
          color: h.color,
          panes: freshPanes,
          tree: newTabTree,
          activePaneId: freshPanes[0].id,
        };
        setActiveTabId(newTab.id);
        return [...ts, newTab];
      });
      toast(
        restoredPanes.length > 1
          ? `Docked ${restoredPanes.length} panes (${title}) back to workspace`
          : `Docked ${title} back to workspace`
      );
    },
    [isPopoutWindow, poppedOutPanes, hostMap, toast]
  );

  const closePopoutPane = useCallback(
    (paneId: string) => {
      if (isPopoutWindow) return;
      const existingEntry = poppedOutPanes.find((x) => x.pane.id === paneId);
      const storedMultiRaw = (() => {
        try { return localStorage.getItem('drx.popout.panes.' + paneId); } catch { return null; }
      })();
      try {
        localStorage.removeItem('drx.popout.pane.' + paneId);
        localStorage.removeItem('drx.popout.panes.' + paneId);
      } catch {}
      setPoppedOutPanes((prev) => prev.filter((x) => x.pane.id !== paneId));
      bridge.popoutCloseWindow(paneId).catch(() => {});
      let cleanedAny = false;
      if (storedMultiRaw) {
        try {
          const parsed = JSON.parse(storedMultiRaw);
          if (Array.isArray(parsed)) {
            for (const p of parsed as Pane[]) {
              cleanupPaneSession(p);
              cleanedAny = true;
            }
          }
        } catch {}
      }
      if (existingEntry) {
        if (!cleanedAny) cleanupPaneSession(existingEntry.pane);
        toast(`Closed popped-out session: ${existingEntry.title}`);
      }
    },
    [isPopoutWindow, poppedOutPanes, cleanupPaneSession, toast]
  );

  // Listen for Dock Back / Close actions triggered from popped-out OS windows
  useEffect(() => {
    if (isPopoutWindow) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== POPOUT_ACTION_KEY || !e.newValue) return;
      try {
        const payload = JSON.parse(e.newValue) as {
          action?: 'dock' | 'close';
          paneId?: string;
          panes?: Pane[];
        };
        if (!payload?.paneId) return;
        if (payload.action === 'dock') {
          dockBackPane(payload.paneId, payload.panes);
        } else if (payload.action === 'close') {
          closePopoutPane(payload.paneId);
        }
      } catch {}
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isPopoutWindow, dockBackPane, closePopoutPane]);

  // Re-open any persisted popped-out windows once on initial unlock
  const reopenedPopoutsRef = useRef(false);
  useEffect(() => {
    if (!unlocked || isPopoutWindow) {
      reopenedPopoutsRef.current = false;
      return;
    }
    if (reopenedPopoutsRef.current) return;
    reopenedPopoutsRef.current = true;
    for (const entry of poppedOutPanes) {
      void openPopoutOsWindow(entry);
    }
  }, [unlocked, isPopoutWindow, poppedOutPanes, openPopoutOsWindow]);

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

  const lastTabShortcutTsRef = useRef(0);

  /**
   * Close the focused split pane when the active tab has multiple panes, or close the entire
   * active tab (terminal, serial, or SFTP) when it has a single pane.
   */
  const closeActivePaneOrTab = useCallback(() => {
    const now = Date.now();
    if (now - lastTabShortcutTsRef.current < 100) return;
    lastTabShortcutTsRef.current = now;

    if (!activeTab) return;
    if (activeTab.kind !== 'sftp' && activeTab.panes.length > 1) {
      closePane(activeTab.id, activeTab.activePaneId);
    } else {
      closeTab(activeTab.id);
    }
  }, [activeTab, closePane, closeTab]);

  /**
   * Duplicate the active terminal tab (same host, custom shell, and live working directory),
   * or open a fresh local terminal tab when no terminal tab is active.
   */
  const duplicateOrNewTab = useCallback(async () => {
    const now = Date.now();
    if (now - lastTabShortcutTsRef.current < 100) return;
    lastTabShortcutTsRef.current = now;

    if (activeTab && activeTab.kind === 'sftp') {
      const sftpHost = activeTab.sftpHostId ? hostMap.get(activeTab.sftpHostId) : undefined;
      if (sftpHost && sftpHost.id !== LOCAL_HOST.id) {
        openHost(sftpHost);
      } else {
        openLocalTerminal();
      }
      return;
    }

    const source: Pane | undefined =
      activeTab && activeTab.kind !== 'sftp'
        ? activeTab.panes.find((p) => p.id === activeTab.activePaneId) ?? activeTab.panes[0]
        : activePane;

    if (!source || source.kind === 'serial') {
      openLocalTerminal();
      return;
    }

    const h = hostMap.get(source.hostId) || LOCAL_HOST;
    if (h.id && h.id !== LOCAL_HOST.id) {
      markHostRecent(h.id);
    }

    const liveSid = registry.get(source.id)?.sessionId ?? null;
    const osCwd = source.isLocal && liveSid ? await bridge.localPtyCwd(liveSid) : null;
    const cwd = osCwd ?? registry.get(source.id)?.cwd ?? source.initialCwd;
    const user = h.username;
    const atRemoteHome =
      !source.isLocal &&
      !!user &&
      (cwd === `/home/${user}` || cwd === `/Users/${user}` || (user === 'root' && cwd === '/root'));

    const isLocal = h.id === LOCAL_HOST.id;
    const pane: Pane = {
      id: uid(),
      hostId: h.id,
      isLocal,
      ...(source.customShell ? { customShell: source.customShell } : {}),
      ...(cwd && (cwd.startsWith('/') || cwd.startsWith('~/')) && !atRemoteHome ? { initialCwd: cwd } : {}),
    };
    const shellName = source.customShell ? source.customShell.split('/').pop() || source.customShell : null;
    const tab: Tab = {
      id: uid(),
      title: isLocal ? (shellName ? `Local (${shellName})` : 'Local Shell') : h.label,
      color: isLocal ? '#22d3ee' : h.color,
      panes: [pane],
      tree: leaf(pane.id),
      activePaneId: pane.id,
    };
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setQuick(false);
    setPanel(null);
    setShowAI(false);
    setNewConnNonce((n) => n + 1);
    setMobilePage('terminals');
  }, [activeTab, activePane, hostMap, markHostRecent, openHost, openLocalTerminal]);

  useEffect(() => {
    return bridge.onMacosMenuAction((action) => {
      const recorder = document.querySelector('[data-shortcut-recorder]');
      if (recorder) {
        recorder.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: action === 'new-tab' ? 't' : 'w',
            code: action === 'new-tab' ? 'KeyT' : 'KeyW',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
        return;
      }
      if (showSettings) return;
      if (action === 'close-tab') {
        closeActivePaneOrTab();
      } else if (action === 'new-tab') {
        void duplicateOrNewTab();
      }
    });
  }, [showSettings, closeActivePaneOrTab, duplicateOrNewTab]);

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
  useWorkspaceShortcuts({
    shortcuts,
    quick,
    setQuick,
    showThemes,
    setShowThemes,
    panel,
    setPanel,
    modal,
    setModal,
    showAutoLockMenu,
    setShowAutoLockMenu,
    showDockerModal,
    setShowDockerModal,
    setDockerHostId,
    splitMenu,
    setSplitMenu,
    showSettings,
    setShowSettings,
    showSavePresetModal,
    setShowSavePresetModal,
    setPresetNameInput,
    showPopoutMenu,
    setShowPopoutMenu,
    closeTerminalDrawerRef,
    activeTab,
    terminalContext,
    activePaneId,
    activePane,
    tabs,
    broadcast,
    setBroadcast,
    setShowAI,
    setZen,
    setShowRail,
    setShowStatusBar,
    setFontSize,
    fontSizeRef,
    isPopoutWindow,
    popoutPaneId: popoutParams.paneId,
    poppedOutPanes,
    toggleQuick,
    openLocalTerminal,
    openSftpTab,
    navigateSplitDirection,
    swapSplitDirection,
    cyclePane,
    cycleTab,
    selectTabByNumber,
    splitPaneInDirection,
    equalizeActiveTab,
    closePane,
    closeActivePaneOrTab,
    duplicateOrNewTab,
    toggleMaximizePane,
    popOutPane,
    sendPopoutAction,
    updatePaneFontSize,
    showFontZoomHud,
    toast,
  });

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
    poppedOutPanes.forEach((entry) => {
      try { localStorage.removeItem('drx.popout.pane.' + entry.pane.id); } catch {}
      bridge.popoutCloseWindow(entry.pane.id).catch(() => {});
      cleanupPaneSession(entry.pane);
    });
    try { localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch {}
    try { localStorage.removeItem(POPOUT_STORAGE_KEY); } catch {}
    setTabs([]);
    setPoppedOutPanes([]);
    setActiveTabId(null);
    setMobilePageHistory([]);
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

  // Suppress default webview "Inspect Element / Reload" context menu across the app
  // while still permitting native cut/copy/paste inside text inputs.
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleGlobalContextMenu);
    return () => window.removeEventListener('contextmenu', handleGlobalContextMenu);
  }, []);

  // The app stays mounted while locked, so terminals, SSH sessions and open tabs survive a lock.
  // The lock screen covers it and the app is made inert, so nothing underneath can be focused or typed into.

  const live = registry.all();
  const connected = live.filter((p) => p.status === 'connected').length;
  const activeLive = activePaneId ? registry.get(activePaneId) : undefined;

  const navigateMobile = (page: MobilePage, opts?: { recordHistory?: boolean }) => {
    if (page === 'settings') {
      setShowSettings(true);
      return;
    }
    setReturnToSettingsTab(null);
    setMobilePage(page, opts);
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

  // Android system Back gesture / hardware Back integration for App-owned popovers, drawers, panels & tabs.
  const workspaceInteractive = unlocked && !showSplash;
  const hasOverlayPanel = panel !== null && !(mobile && mobilePage === 'hosts' && panel === 'hosts');
  const canNavigateMobileBack =
    mobile && (mobilePageHistory.length > 0 || terminalScreen || mobilePage === 'settings');

  useBackHandler(workspaceInteractive && showPopoutMenu, () => setShowPopoutMenu(false), BackPriority.POPOVER);
  useBackHandler(workspaceInteractive && showThemes, () => setShowThemes(false), BackPriority.POPOVER);
  useBackHandler(workspaceInteractive && showAutoLockMenu, () => setShowAutoLockMenu(false), BackPriority.POPOVER);
  useBackHandler(
    workspaceInteractive && mobile && openDrawer !== null && !openDrawer.closing,
    () => {
      openDrawer?.requestClose();
    },
    BackPriority.PANEL_OR_DRAWER,
  );
  useBackHandler(
    workspaceInteractive && hasOverlayPanel,
    () => {
      closePanel();
    },
    BackPriority.PANEL_OR_DRAWER,
  );
  useBackHandler(
    workspaceInteractive && canNavigateMobileBack,
    () => {
      const { target, nextHistory } = resolveMobileBackTarget({
        currentPage: mobilePageRef.current,
        history: mobilePageHistory,
        terminalScreen,
      });
      if (!target) return false;
      setMobilePageHistory(nextHistory);
      navigateMobile(target, { recordHistory: false });
      return true;
    },
    BackPriority.NAVIGATION,
  );
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

  useEffect(() => {
    if (!isPopoutWindow || !popoutParams.paneId) return;
    const onUnload = () => {
      sendPopoutAction('dock');
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [isPopoutWindow, popoutParams.paneId, sendPopoutAction]);

  return (
    <>
    {showSplash && <LaunchSplash onFinished={() => setShowSplash(false)} />}
    {!unlocked && !showSplash && !directUnlocking && (
      <div data-theme={lightTheme ? 'light' : 'dark'} className="fixed inset-0 z-[1000] overflow-auto bg-slate-950">
        <LockScreen onUnlocked={() => setUnlocked(true)}
          onJoinRequested={() => setShowPairing({ initialTab: 'join' })} theme={theme} />
      </div>
    )}
    <WorkspaceAccessContext.Provider value={unlocked}>
    <div
      data-theme={lightTheme ? 'light' : 'dark'}
      inert={!unlocked}
      className={cn(
        "nx-app-shell flex h-screen w-screen flex-col overflow-hidden text-slate-200 selection:bg-cyan-400/30",
        !unlocked && "invisible"
      )}
      style={{ background: theme.xterm.background }}
    >
      {/* Top Header Bar — floating controls across the top */}
      {!zen && (
        <WorkspaceHeader
          isPopoutWindow={isPopoutWindow}
          showRail={showRail}
          setShowRail={setShowRail}
          vaults={vaults}
          activeVaultId={activeVaultId}
          setActiveVaultId={setActiveVaultId}
          handleCreateVault={handleCreateVault}
          handleDeleteVault={handleDeleteVault}
          setShareModal={setShareModal}
          setShowPairing={setShowPairing}
          panel={panel}
          setPanel={setPanel}
          uiPrefs={uiPrefs}
          activeTab={activeTab}
          activeTabId={activeTabId}
          setActiveTabId={setActiveTabId}
          tabs={tabs}
          maximizedPaneId={maximizedPaneId}
          toggleMaximizePane={toggleMaximizePane}
          closeTab={closeTab}
          quickBtnRef={quickBtnRef}
          quick={quick}
          toggleQuick={toggleQuick}
          openLocalTerminal={openLocalTerminal}
          openSftpTab={openSftpTab}
          setShowSerial={setShowSerial}
          showDockerModal={showDockerModal}
          setShowDockerModal={setShowDockerModal}
          showDeployModal={showDeployModal}
          setShowDeployModal={setShowDeployModal}
          setDockerHostId={setDockerHostId}
          terminalContext={terminalContext}
          activePaneId={activePaneId}
          activePane={activePane}
          activeLive={activeLive}
          showTerminalTools={showTerminalTools}
          toggleTerminalTools={toggleTerminalTools}
          splitMenu={splitMenu}
          setSplitMenu={setSplitMenu}
          sendPopoutAction={sendPopoutAction}
          popOutPane={popOutPane}
          poppedOutPanes={poppedOutPanes}
          showPopoutMenu={showPopoutMenu}
          setShowPopoutMenu={setShowPopoutMenu}
          openPopoutOsWindow={openPopoutOsWindow}
          dockBackPane={dockBackPane}
          closePopoutPane={closePopoutPane}
          hosts={hosts}
          hostMap={hostMap}
          userPresets={userPresets}
          splitPaneInDirection={splitPaneInDirection}
          changeActiveTabLayout={changeActiveTabLayout}
          equalizeActiveTab={equalizeActiveTab}
          setPresetNameInput={setPresetNameInput}
          setShowSavePresetModal={setShowSavePresetModal}
          applyLayoutPreset={applyLayoutPreset}
          handleDeletePreset={handleDeletePreset}
          broadcast={broadcast}
          setBroadcast={setBroadcast}
          showThemes={showThemes}
          setShowThemes={setShowThemes}
          allThemes={allThemes}
          theme={theme}
          themeId={themeId}
          setThemeId={setThemeId}
          fontSize={fontSize}
          handleGlobalFontSizeChange={handleGlobalFontSizeChange}
          lineHeight={lineHeight}
          setLineHeight={setLineHeight}
          showAI={showAI}
          setShowAI={setShowAI}
          showStatusBar={showStatusBar}
          setShowStatusBar={setShowStatusBar}
          zen={zen}
          setZen={setZen}
          toast={toast}
        />
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
        <div className="flex items-center gap-2.5">
          {uiPrefs.showDeploy !== false && (
            <button
              type="button"
              onClick={() => {
                const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
                setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
                setShowDeployModal(true);
              }}
              aria-label="Application Deployment"
              title="1-Click Atomic Application Deployment"
              className="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition active:scale-95"
              style={{
                borderColor: `${theme.accent}45`,
                backgroundColor: `${theme.accent}16`,
                color: theme.accent,
              }}
            >
              <Rocket className="h-3.5 w-3.5" />
              <span>Deploy</span>
            </button>
          )}
          <span className="text-xs text-slate-500">
            {(() => { const n = activeVaultId === 'all' ? hosts.length : hosts.filter((h) => (h.vaultId || 'personal') === activeVaultId).length; return `${n} ${n === 1 ? 'profile' : 'profiles'}`; })()}
          </span>
        </div>
      </div>}

      {/* Main App Body */}
      <div className="flex flex-1 min-h-0 min-w-0 relative">
        {/* Icon rail — floating buttons aligned directly underneath the logo button */}
        {!zen && showRail && (
          <WorkspaceSidebarRail
            uiPrefs={uiPrefs}
            panel={panel}
            setPanel={setPanel}
            showDockerModal={showDockerModal}
            setShowDockerModal={setShowDockerModal}
            showDeployModal={showDeployModal}
            setShowDeployModal={setShowDeployModal}
            setDockerHostId={setDockerHostId}
            terminalContext={terminalContext}
            activePaneId={activePaneId}
            activeTab={activeTab}
            openSftpTab={openSftpTab}
            showAI={showAI}
            setShowAI={setShowAI}
            setShowPairing={setShowPairing}
            setShowSync={setShowSync}
            autoLockMinutes={autoLockMinutes}
            setAutoLockMinutes={setAutoLockMinutes}
            showAutoLockMenu={showAutoLockMenu}
            setShowAutoLockMenu={setShowAutoLockMenu}
            showSettings={showSettings}
            setShowSettings={setShowSettings}
            lock={lock}
            theme={theme}
          />
        )}

        {/* Side panel — overlay drawer & mobile FABs */}
        <WorkspaceSidePanel
          panel={panel}
          setPanel={setPanel}
          closePanel={closePanel}
          zen={zen}
          showRail={showRail}
          theme={theme}
          mobile={mobile}
          mobilePage={mobilePage}
          setMobilePage={setMobilePage}
          navigateMobile={navigateMobile}
          returnToSettingsTab={returnToSettingsTab}
          hosts={hosts}
          vaults={vaults}
          activeVaultId={activeVaultId}
          resumeOrOpenHost={resumeOrOpenHost}
          openHost={openHost}
          openSftpTab={openSftpTab}
          splitWith={splitWith}
          setModal={setModal}
          deleteHost={deleteHost}
          openLocalTerminal={openLocalTerminal}
          setShowSerial={setShowSerial}
          uiPrefs={uiPrefs}
          setShareModal={setShareModal}
          setShowSshConfig={setShowSshConfig}
          setShowTailscale={setShowTailscale}
          setShowNetbird={setShowNetbird}
          setShowCloudSync={setShowCloudSync}
          cloudStatuses={cloudStatuses}
          refreshCloudStatuses={refreshCloudStatuses}
          cloudRefreshing={cloudRefreshing}
          isAndroid={isAndroid}
          openTermuxPreset={openTermuxPreset}
          showDockerModal={showDockerModal}
          setShowDockerModal={setShowDockerModal}
          setShowDeployModal={setShowDeployModal}
          hostFabsVisible={hostFabsVisible}
          setHostFabsVisible={setHostFabsVisible}
          handleQuickConnectSsh={handleQuickConnectSsh}
          keychain={keychain}
          tunnels={tunnels}
          snippets={snippets}
          activePaneId={activePaneId}
          saveSnippet={saveSnippet}
          deleteSnippet={deleteSnippet}
          refresh={refresh}
          unlocked={unlocked}
          showSettings={showSettings}
          toast={toast}
        />

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
            // Desktop splits are laid out from the tab's split tree, each pane absolutely placed so a
            // split, close or resize never re-parents (and so never remounts) a terminal. Phones and a
            // zoomed pane fall back to one flex box that shows a single pane.
            const tree = isSplit ? tabTree(t) : null;
            const freeForm = !!tree && !currentTabMaximized && !mobile;
            const rects = freeForm && tree ? computeRects(tree) : null;
            const dividers = freeForm && tree && draggedPaneId === null ? computeSplits(tree) : [];
            const visualIndex = new Map((tree ? leafIds(tree) : t.panes.map((p) => p.id)).map((id, i) => [id, i]));
            return (
              <div
                key={t.id}
                inert={t.id !== activeTabId || (mobile && mobilePage !== 'terminals')}
                className={cn(
                  'absolute inset-0',
                  (t.id !== activeTabId || (mobile && mobilePage !== 'terminals')) && 'invisible',
                  freeForm ? ((uiPrefs.terminalWallpaper || (uiPrefs.terminalOpacity ?? 1) < 1) ? 'bg-transparent' : 'bg-black/40') : 'flex p-0'
                )}
              >
                {[...t.panes]
                  .sort((a, b) => a.id.localeCompare(b.id))
                  .map((p) => {
                    const h =
                      hostMap.get(p.hostId) ??
                      (p.isLocal
                        ? LOCAL_HOST
                        : p.kind === 'serial'
                          ? {
                              ...LOCAL_HOST,
                              id: p.hostId,
                              label: `Serial ${p.serialOptions?.portName || ''}`.trim(),
                              hostname: p.serialOptions?.portName || 'serial',
                              port: p.serialOptions?.baudRate || 115200,
                              username: 'serial',
                            }
                          : undefined);
                    if (!h) return null;
                    const rect = rects?.get(p.id);
                    const isPaneMaximized = currentTabMaximized === p.id;
                    const isPaneHidden = currentTabMaximized !== null && currentTabMaximized !== p.id;
                    const isDraggingThis = draggedPaneId === p.id;
                    const isDropTarget = dropTargetPaneId === p.id && draggedPaneId !== null && draggedPaneId !== p.id;
                    return (
                      <div
                        key={p.id}
                        data-pane-id={p.id}
                        data-pane-active={t.activePaneId === p.id ? 'true' : undefined}
                        inert={isPaneHidden || undefined}
                        style={rect ? paneRectStyle(rect) : { order: currentTabMaximized ? (isPaneMaximized ? 0 : 99) : (visualIndex.get(p.id) ?? 0) }}
                        className={cn(
                          rect ? 'absolute min-h-0 min-w-0 flex' : 'min-h-0 min-w-0 h-full w-full flex relative',
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
                          fontSize={p.fontSize ?? fontSize}
                          fontFamily={uiPrefs.fontFamily}
                          customFontFamily={uiPrefs.customFontFamily}
                          fontWeight={uiPrefs.fontWeight}
                          letterSpacing={uiPrefs.letterSpacing}
                          onFontSizeChange={(nextSize) => updatePaneFontSize(t.id, p.id, nextSize)}
                          lineHeight={lineHeight}
                          cursorStyle={uiPrefs.cursorStyle}
                          cursorBlink={uiPrefs.cursorBlink}
                          terminalPadding={uiPrefs.terminalPadding}
                          terminalOpacity={uiPrefs.terminalOpacity}
                          terminalBlur={uiPrefs.terminalBlur}
                          terminalWallpaper={uiPrefs.terminalWallpaper}
                          wallpaperOpacity={uiPrefs.wallpaperOpacity}
                          scrollback={uiPrefs.scrollback}
                          ghostSuggestions={uiPrefs.ghostSuggestions}
                          copyOnSelect={uiPrefs.copyOnSelect}
                          rightClickPaste={uiPrefs.rightClickPaste}
                          active={t.id === activeTabId && t.activePaneId === p.id && unlocked && !showSplash && (!mobile || mobilePage === 'terminals')}
                          mobileHidden={t.activePaneId !== p.id}
                          hidden={isPaneHidden}
                          showHeader={isSplit && !currentTabMaximized && !mobile}
                          isSplit={isSplit}
                          isMaximized={isPaneMaximized}
                          onToggleMaximize={() => toggleMaximizePane(p.id)}
                          onSplitPane={(dir) => splitPaneInDirection(dir, undefined, p.id)}
                          onPopOut={!mobile && !isPopoutWindow ? () => popOutPane(t.id, p.id) : undefined}
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
                          onCwdChange={(newCwd) => {
                            setTabs((ts) => {
                              const tab = ts.find((tab) => tab.id === t.id);
                              const targetPane = tab?.panes.find((pane) => pane.id === p.id);
                              if (!targetPane || targetPane.initialCwd === newCwd) return ts;
                              return ts.map((tab) =>
                                tab.id !== t.id
                                  ? tab
                                  : {
                                      ...tab,
                                      panes: tab.panes.map((pane) =>
                                        pane.id === p.id ? { ...pane, initialCwd: newCwd } : pane
                                      ),
                                    }
                              );
                            });
                          }}
                          onData={(d) => handlePaneData(t.id, p.id, d)}
                          toast={toast}
                          mobileBar={!isPopoutWindow && mobile ? {
                            sessionCount: terminalSessionCount,
                            onBack: () => {
                              setMobilePageHistory((hist) => hist.filter((p) => p !== 'hosts'));
                              navigateMobile('hosts', { recordHistory: false });
                            },
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
                {dividers.map((s) => (
                  <SplitDivider
                    key={s.id}
                    tabId={t.id}
                    split={s}
                    accent={theme.accent}
                    onRatio={resizeSplit}
                    onReset={resetSplit}
                  />
                ))}
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
          <div className={cn('group max-md:hidden absolute right-0 z-40 h-9 w-9', showStatusBar ? 'bottom-7' : 'bottom-0')}>
            <button
              type="button"
              onClick={() => setZen(false)}
              title="Exit Zen (⌘⇧Z)"
              aria-label="Exit zen mode"
              className={cn(
                // Faint at rest so it never competes with output; full strength on hover or keyboard focus.
                'absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-md border border-white/10 bg-[#0e131d]/80 text-slate-400 opacity-30 backdrop-blur transition-opacity duration-200',
                'hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60 group-hover:opacity-100'
              )}
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
          </div>
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
        className={cn("nx-mobile-ai shrink-0 border-l border-white/5 bg-transparent flex flex-col relative min-w-0 max-w-full overflow-hidden", !aiVisible && "hidden", aiDrawerOpen && drawer.className)}
        aria-label={aiDrawerOpen ? 'AI Assistant drawer' : 'AI Assistant'}
      >
        {aiDrawerOpen && <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-40 opacity-25" style={{ background: `radial-gradient(ellipse at top, ${AI_TINT} 0%, transparent 70%)` }} />}
        {aiDrawerOpen && <DrawerGrip label="Drag to resize or dismiss the assistant" detent={drawer.detent} {...drawer.gripProps} />}
        <div className="flex min-h-0 flex-1 flex-col min-w-0 max-w-full overflow-hidden">
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
          <SnippetsPanel snippets={snippets} activePaneId={activePaneId} onSave={saveSnippet} onDelete={deleteSnippet} onOpenDeploy={() => setShowDeployModal(true)} toast={toast}
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
      {mobile && mobilePage === 'settings' && !panel && (
        <MobileSettingsSection
          theme={theme}
          lock={lock}
          setShowPairing={setShowPairing}
          setShowTailscale={setShowTailscale}
          setShowNetbird={setShowNetbird}
          setShowCloudSync={setShowCloudSync}
          setShowSync={setShowSync}
          setShowDockerModal={setShowDockerModal}
          setPanel={setPanel}
          autoLockMinutes={autoLockMinutes}
          setSettingsPicker={setSettingsPicker}
          deviceLockEnabled={deviceLockEnabled}
          directUnlockEnabled={directUnlockEnabled}
          storageGranted={storageGranted}
          uiPrefs={uiPrefs}
          handleUpdateUiPrefs={handleUpdateUiPrefs}
          fontSize={fontSize}
          setFontSize={setFontSize}
          lineHeight={lineHeight}
          setLineHeight={setLineHeight}
          broadcast={broadcast}
          setBroadcast={setBroadcast}
        />
      )}
      <MobileSettingsPickers
        mobile={mobile}
        settingsPicker={settingsPicker}
        setSettingsPicker={setSettingsPicker}
        theme={theme}
        allThemes={allThemes}
        themeId={themeId}
        setThemeId={setThemeId}
        autoLockMinutes={autoLockMinutes}
        setAutoLockMinutes={setAutoLockMinutes}
        uiPrefs={uiPrefs}
        handleUpdateUiPrefs={handleUpdateUiPrefs}
        deviceLockEnabled={deviceLockEnabled}
        setDeviceLockEnabled={setDeviceLockEnabled}
        quickUnlockPw={quickUnlockPw}
        setQuickUnlockPw={setQuickUnlockPw}
        quickUnlockBusy={quickUnlockBusy}
        setQuickUnlockBusy={setQuickUnlockBusy}
        quickUnlockErr={quickUnlockErr}
        setQuickUnlockErr={setQuickUnlockErr}
        directUnlockEnabled={directUnlockEnabled}
        setDirectUnlockEnabled={setDirectUnlockEnabled}
        directLaunchPw={directLaunchPw}
        setDirectLaunchPw={setDirectLaunchPw}
        directLaunchBusy={directLaunchBusy}
        setDirectLaunchBusy={setDirectLaunchBusy}
        directLaunchErr={directLaunchErr}
        setDirectLaunchErr={setDirectLaunchErr}
        recoveryKey={recoveryKey}
        setRecoveryKey={setRecoveryKey}
        copiedRecovery={copiedRecovery}
        setCopiedRecovery={setCopiedRecovery}
        downloadedRecoveryPath={downloadedRecoveryPath}
        setDownloadedRecoveryPath={setDownloadedRecoveryPath}
        regeneratingRecovery={regeneratingRecovery}
        setRegeneratingRecovery={setRegeneratingRecovery}
        showRegenConfirm={showRegenConfirm}
        setShowRegenConfirm={setShowRegenConfirm}
        storageGranted={storageGranted}
        setStorageGranted={setStorageGranted}
        requestingPerm={requestingPerm}
        setRequestingPerm={setRequestingPerm}
        toast={toast}
      />

      </div>

      {!terminalScreen && <MobileNavigation page={mobilePage} sessions={terminalSessionCount} onChange={navigateMobile} theme={theme} />}
      {mobile && unlocked && sessionSheet && (
        <MobileSessionsSheet
          terminalSessionCount={terminalSessionCount}
          theme={theme}
          tabs={tabs}
          activeTabId={activeTabId}
          hostMap={hostMap}
          isAndroid={isAndroid}
          onClose={() => setSessionSheet(false)}
          navigateMobile={navigateMobile}
          setActiveTabId={setActiveTabId}
          focusPane={focusPane}
          closePane={closePane}
          openLocalTerminal={openLocalTerminal}
          openTermuxPreset={openTermuxPreset}
        />
      )}

      {/* Quick Connect Floating Palette */}
      {quick && (
        <QuickConnectPalette
          quickPos={quickPos}
          quickFilter={quickFilter}
          setQuickFilter={setQuickFilter}
          filteredHosts={filteredHosts}
          theme={theme}
          isAndroid={isAndroid}
          onClose={() => setQuick(false)}
          onOpenHost={openHost}
          onOpenLocalTerminal={openLocalTerminal}
          onOpenTermuxPreset={openTermuxPreset}
          onOpenHostModal={(host) => setModal({ host })}
          onOpenSshConfig={() => setShowSshConfig(true)}
        />
      )}

      <WorkspaceModals
        modal={modal}
        setModal={setModal}
        vaults={vaults}
        hosts={hosts}
        activeVaultId={activeVaultId}
        theme={theme}
        themeId={themeId}
        setThemeId={setThemeId}
        fontSize={fontSize}
        handleGlobalFontSizeChange={handleGlobalFontSizeChange}
        lineHeight={lineHeight}
        setLineHeight={setLineHeight}
        zen={zen}
        setZen={setZen}
        showRail={showRail}
        setShowRail={setShowRail}
        showStatusBar={showStatusBar}
        setShowStatusBar={setShowStatusBar}
        autoLockMinutes={autoLockMinutes}
        setAutoLockMinutes={setAutoLockMinutes}
        uiPrefs={uiPrefs}
        handleUpdateUiPrefs={handleUpdateUiPrefs}
        shortcuts={shortcuts}
        handleUpdateShortcuts={handleUpdateShortcuts}
        showSshConfig={showSshConfig}
        setShowSshConfig={setShowSshConfig}
        showTailscale={showTailscale}
        setShowTailscale={setShowTailscale}
        showNetbird={showNetbird}
        setShowNetbird={setShowNetbird}
        showCloudSync={showCloudSync}
        setShowCloudSync={setShowCloudSync}
        showDockerModal={showDockerModal}
        setShowDockerModal={setShowDockerModal}
        showDeployModal={showDeployModal}
        setShowDeployModal={setShowDeployModal}
        snippets={snippets}
        dockerHostId={dockerHostId}
        terminalContext={terminalContext}
        activePaneId={activePaneId}
        shareModal={shareModal}
        setShareModal={setShareModal}
        showSerial={showSerial}
        setShowSerial={setShowSerial}
        showPairing={showPairing}
        setShowPairing={setShowPairing}
        showSync={showSync}
        setShowSync={setShowSync}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        settingsTab={settingsTab}
        setSettingsTab={setSettingsTab}
        setReturnToSettingsTab={setReturnToSettingsTab}
        setPanel={setPanel}
        storageGranted={storageGranted}
        setStorageGranted={setStorageGranted}
        isAndroid={isAndroid}
        saveHost={saveHost}
        refresh={refresh}
        openHost={openHost}
        openTerminalWithCommand={openTerminalWithCommand}
        handleConnectSerial={handleConnectSerial}
        mergeCloudStatuses={mergeCloudStatuses}
        openFromSettings={openFromSettings}
        handleReturnToSettings={handleReturnToSettings}
        lock={lock}
        toast={toast}
      />
      {showSavePresetModal && activeTab && (
        <SaveLayoutPresetModal
          theme={theme}
          activeTab={activeTab}
          hostMap={hostMap}
          poppedOutPanes={poppedOutPanes}
          presetNameInput={presetNameInput}
          setPresetNameInput={setPresetNameInput}
          onSave={handleSavePreset}
          onClose={() => setShowSavePresetModal(false)}
        />
      )}
      {fontZoomHud !== null && (
        <div
          className="nx-zoom-hud"
          role="status"
          aria-live="polite"
          style={{ '--nx-accent': theme?.accent ?? '#22d3ee' } as React.CSSProperties}
        >
          <span className="nx-zoom-hud-glyph">Aa</span>
          <span className="nx-zoom-hud-size">{fontZoomHud}</span>
          <span className="nx-zoom-hud-unit">px</span>
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



