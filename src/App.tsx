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
  Terminal as TerminalIcon,
  PanelBottom,
  Radio,
  QrCode,
  FolderInput,
  Timer,
  Check,
  Folder,
} from 'lucide-react';
import { bridge, isTauri } from './lib/bridge';
import { registry } from './lib/sessions';
import { THEMES, type NexusTheme } from './lib/themes';
import type { Host, HostSecret, KeychainItem, Layout, Pane, Snippet, Tab, TunnelConfig, Vault } from './lib/types';
import { LockScreen } from './components/LockScreen';
import { HostSidebar } from './components/HostSidebar';
import { HostModal } from './components/HostModal';
import { VaultMenu } from './components/VaultMenu';
import { TeamShareModal } from './components/TeamShareModal';
import { SerialModal } from './components/SerialModal';
import { DevicePairingModal } from './components/DevicePairingModal';
import { SshConfigModal } from './components/SshConfigModal';
import { OsIcon } from './components/OsIcon';
import { SnippetsPanel } from './components/SnippetsPanel';
import { TerminalPane } from './components/TerminalPane';
import { KeychainPanel } from './components/KeychainPanel';
import { PortForwardingPanel } from './components/PortForwardingPanel';
import { LogsPanel } from './components/LogsPanel';
import { KnownHostsPanel } from './components/KnownHostsPanel';
import { AIPanel } from './components/AIPanel';
import { SftpTab } from './components/SftpTab';
import { cn } from './utils/cn';

const uid = () => crypto.randomUUID();
const layoutFor = (n: number, pref?: Layout): Layout => (n <= 1 ? 'single' : n === 2 ? (pref === 'horizontal' ? 'horizontal' : 'vertical') : 'grid');

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
const AUTO_LOCK_STORAGE_KEY = 'nx.autolock_minutes';
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

export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(readAutoLockMinutes);
  const [showAutoLockMenu, setShowAutoLockMenu] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [keychain, setKeychain] = useState<KeychainItem[]>([]);
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'hosts' | 'snippets' | 'keychain' | 'tunnels' | 'logs' | 'known_hosts' | null>(null);
  const [showAI, setShowAI] = useState(false);
  const [newConnNonce, setNewConnNonce] = useState(0);
  const [aiWidth, setAiWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('nx.ai.panel_width');
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
        localStorage.setItem('nx.ai.panel_width', String(aiWidthRef.current));
      } catch {}
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);
  const [themeId, setThemeId] = useState(() => localStorage.getItem('nx.theme') ?? 'nexus');
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('nx.font') ?? 13));
  const [lineHeight, setLineHeight] = useState(() => Number(localStorage.getItem('nx.lineHeight') ?? 1.0));
  const [showThemes, setShowThemes] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [modal, setModal] = useState<{ host: Host | null } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');
  const [quickPos, setQuickPos] = useState<{ top: number; left: number }>({ top: 40, left: 200 });
  const quickBtnRef = useRef<HTMLButtonElement>(null);
  const [zen, setZen] = useState(() => localStorage.getItem('nx.zen') === '1');
  const [showRail, setShowRail] = useState(() => localStorage.getItem('nx.rail') === '1');
  const [showStatusBar, setShowStatusBar] = useState(() => localStorage.getItem('nx.status') === '1');
  const [broadcast, setBroadcast] = useState(false);

  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activePaneId = activeTab?.activePaneId ?? null;
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
    () => localStorage.getItem('nx.vault.active') ?? 'personal'
  );
  const [shareModal, setShareModal] = useState<{ initialTab?: 'share' | 'import' } | null>(null);
  const [showSerial, setShowSerial] = useState(false);
  const [showPairing, setShowPairing] = useState<{ initialTab?: 'share' | 'join' | 'devices' } | null>(null);
  const [showSshConfig, setShowSshConfig] = useState(false);

  useEffect(() => { localStorage.setItem('nx.theme', themeId); }, [themeId]);
  useEffect(() => { localStorage.setItem('nx.font', String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem('nx.lineHeight', String(lineHeight)); }, [lineHeight]);
  useEffect(() => { localStorage.setItem('nx.zen', zen ? '1' : '0'); }, [zen]);
  useEffect(() => { localStorage.setItem('nx.rail', showRail ? '1' : '0'); }, [showRail]);
  useEffect(() => { localStorage.setItem('nx.status', showStatusBar ? '1' : '0'); }, [showStatusBar]);
  useEffect(() => { localStorage.setItem('nx.vault.active', activeVaultId); }, [activeVaultId]);

  const refresh = useCallback(async () => {
    const [h, s, k, tun, v] = await Promise.all([
      bridge.listHosts(),
      bridge.listSnippets(),
      bridge.listKeychain(),
      bridge.listTunnels(),
      bridge.listVaults(),
    ]);
    setHosts(h);
    setSnippets(s);
    setKeychain(k);
    setTunnels(tun);
    setVaults(v);
  }, []);
  useEffect(() => { if (unlocked) refresh(); }, [unlocked, refresh]);

  // ── Tabs / panes ──
  const openHost = useCallback((h: Host) => {
    const pane: Pane = { id: uid(), hostId: h.id, resume: true };
    const tab: Tab = { id: uid(), title: h.label, color: h.color, panes: [pane], layout: 'single', activePaneId: pane.id };
    setTabs((t) => [...t, tab]);
    setActiveTabId(tab.id);
    setQuick(false);
    setPanel(null);
    setShowAI(false);
    setNewConnNonce((n) => n + 1);
  }, []);

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

  const splitWith = useCallback((h: Host, pref?: Layout) => {
    if (!activeTab) return openHost(h);
    if (activeTab.panes.length >= 4) { toast('Maximum 4 panes per tab'); return; }
    const pane: Pane = { id: uid(), hostId: h.id };
    setTabs((ts) => ts.map((t) => t.id !== activeTab.id ? t : { ...t, panes: [...t.panes, pane], layout: layoutFor(t.panes.length + 1, pref), activePaneId: pane.id, title: t.panes.length ? `${t.title.split(' +')[0]} +${t.panes.length}` : h.label }));
  }, [activeTab, openHost, toast]);

  const splitActive = (pref: Layout) => {
    const p = activeTab?.panes.find((x) => x.id === activeTab.activePaneId);
    const h = p && hostMap.get(p.hostId);
    if (h) splitWith(h, pref);
  };

  const closePane = useCallback((tabId: string, paneId: string) => {
    bridge.sftpClose(paneId).catch(() => {});
    setTabs((ts) => {
      return ts.map((t) => {
        if (t.id !== tabId) return t;
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
  }, [hostMap]);

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const target = ts[i];
      if (target) {
        if (target.kind === 'sftp' && target.sftpSessionId) {
          bridge.sftpClose(target.sftpSessionId).catch(() => {});
        }
        target.panes.forEach((p) => bridge.sftpClose(p.id).catch(() => {}));
      }
      const remaining = ts.filter((t) => t.id !== id);
      setActiveTabId((curr) => (curr === id ? remaining[Math.max(0, i - 1)]?.id ?? null : curr));
      return remaining;
    });
  }, []);

  const openSftpTab = useCallback((hostId?: string) => {
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
  }, [tabs, hostMap]);

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((ts) => ts.map((t) => (t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t)));
  }, []);

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
        if (quick || showThemes || panel || modal || showAutoLockMenu) {
          e.preventDefault();
          e.stopPropagation();
          setQuick(false);
          setShowThemes(false);
          setPanel(null);
          setModal(null);
          setShowAutoLockMenu(false);
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      // xterm's hidden textarea is a terminal surface, not a text input: the
      // Ctrl+Shift+* workspace shortcuts must keep working while a terminal
      // has focus (the TerminalPane also blocks those sequences from leaking
      // to the shell). Plain Ctrl+T/Ctrl+K stay with the shell (^T transpose,
      // ^K kill-line) when the terminal is focused.
      const inTerminal = !!(target && target.closest && target.closest('.xterm'));
      const isInput = target && !inTerminal && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isInput) return;

      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (!inTerminal && !e.shiftKey && k === 't') { e.preventDefault(); e.stopPropagation(); openLocalTerminal(); return; }
      if (!inTerminal && k === 'k') { e.preventDefault(); e.stopPropagation(); toggleQuick(); return; }
      if (k === 'k' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); toggleQuick(); return; }
      if (!e.shiftKey) return;
      if (k === 'i') { e.preventDefault(); e.stopPropagation(); setBroadcast((b) => !b); }
      else if (k === 'd') { e.preventDefault(); e.stopPropagation(); splitActive('vertical'); }
      else if (k === 'e') { e.preventDefault(); e.stopPropagation(); splitActive('horizontal'); }
      else if (k === 'a') { e.preventDefault(); e.stopPropagation(); setShowAI((v) => !v); }
      else if (k === 'f') { e.preventDefault(); e.stopPropagation(); openSftpTab(); }
      else if (k === 'z') { e.preventDefault(); e.stopPropagation(); setZen((v) => !v); }
      else if (k === 'b') { e.preventDefault(); e.stopPropagation(); setShowRail((v) => !v); }
      else if (k === '/') { e.preventDefault(); e.stopPropagation(); setShowStatusBar((v) => !v); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleQuick, openLocalTerminal, openSftpTab, broadcast, tabs, quick, showThemes, panel, modal, showAutoLockMenu]);

  // ── Hosts / snippets CRUD ──
  const saveHost = async (h: Host, s?: HostSecret, alreadySaved?: boolean) => {
    if (!alreadySaved) {
      await bridge.saveHost(h, s);
    }
    setModal(null);
    toast(`Saved ${h.label} to vault`);
    refresh();
  };
  const deleteHost = async (h: Host) => { if (confirm(`Delete ${h.label}? Stored credentials will be wiped.`)) { await bridge.deleteHost(h.id); refresh(); } };
  const saveSnippet = async (s: Snippet) => { await bridge.saveSnippet(s); refresh(); toast('Snippet saved'); };
  const deleteSnippet = async (id: string) => { await bridge.deleteSnippet(id); refresh(); };

  const lock = async () => { setTabs([]); setActiveTabId(null); await bridge.lock(); setUnlocked(false); };

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
    { id: 'tunnels', icon: Network, label: 'Port Forwarding (Tunnels)', on: panel === 'tunnels', act: () => setPanel((p) => (p === 'tunnels' ? null : 'tunnels')) },
    { id: 'snippets', icon: Code2, label: 'Snippets', on: panel === 'snippets', act: () => setPanel((p) => (p === 'snippets' ? null : 'snippets')) },
    { id: 'logs', icon: History, label: 'Session History & Audit', on: panel === 'logs', act: () => setPanel((p) => (p === 'logs' ? null : 'logs')) },
    { id: 'known_hosts', icon: ShieldCheck, label: 'Known Hosts', on: panel === 'known_hosts', act: () => setPanel((p) => (p === 'known_hosts' ? null : 'known_hosts')) },
    { id: 'sftp', icon: HardDrive, label: 'SFTP (⌘⇧F)', on: activeTab?.kind === 'sftp', act: () => openSftpTab() },
    { id: 'ai', icon: Sparkles, label: 'AI Assistant (⌘⇧A)', on: showAI, act: () => setShowAI((v) => !v) },
  ];

  return (
    <>
    {!unlocked && (
      <div className="fixed inset-0 z-[1000] overflow-auto bg-slate-950">
        <LockScreen onUnlocked={() => setUnlocked(true)} theme={theme} />
      </div>
    )}
    <div
      inert={!unlocked}
      className="flex h-screen w-screen flex-col overflow-hidden text-slate-200 selection:bg-cyan-400/30"
      style={{ background: theme.xterm.background }}
    >
      {/* Top Header Bar — floating controls across the top */}
      {!zen && (
        <header className="flex h-10 shrink-0 items-center gap-1.5 px-1 pt-1 pb-0.5 bg-transparent border-0 z-30">
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
                src="/nexus-logo.png"
                alt="NexusTerminal"
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
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 shrink-0" />

          {/* Floating Tabs */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pl-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                    'group relative flex h-7 min-w-[130px] max-w-[220px] cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs transition border shadow-sm',
                    isActive
                      ? isSftp
                        ? 'border-cyan-500/40 bg-cyan-950/70 text-cyan-200 ring-1 ring-cyan-500/20'
                        : 'border-emerald-500/40 bg-emerald-950/70 text-emerald-200 ring-1 ring-emerald-500/20'
                      : 'border-white/5 bg-white/[0.03] text-slate-400 hover:border-white/10 hover:bg-white/[0.07] hover:text-slate-200'
                  )}
                >
                  {isSftp ? (
                    <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  ) : (
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
                  )}
                  <span className="truncate font-medium">{t.title}</span>
                  {t.panes.length > 1 && (
                    <span className="rounded bg-white/10 px-1 text-[9px] text-slate-400">{t.panes.length}</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    className="ml-auto rounded p-0.5 text-slate-400 opacity-60 hover:bg-white/10 hover:text-white hover:opacity-100"
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
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Floating Right Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={openLocalTerminal}
              title="New local shell (⌘T)"
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/10 hover:text-cyan-300 transition"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Local Shell</span>
            </button>
            <button
              onClick={() => setShowSerial(true)}
              title="Serial terminal (UART / RS-232)"
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-amber-400/10 hover:text-amber-200 transition"
            >
              <Radio className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Serial</span>
            </button>
            <button title="Split vertical (⌘⇧D)" disabled={!activeTab} onClick={() => splitActive('vertical')} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30"><Columns2 className="h-3.5 w-3.5" /></button>
            <button title="Split horizontal (⌘⇧E)" disabled={!activeTab} onClick={() => splitActive('horizontal')} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-30"><Rows2 className="h-3.5 w-3.5" /></button>
            <button title="Grid" disabled={!activeTab || (activeTab?.panes.length ?? 0) < 3} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 disabled:opacity-30"><Grid2x2 className="h-3.5 w-3.5" /></button>
            {activeTab && activeTab.panes.length > 1 && (
              <button
                title={broadcast ? 'Broadcast input: ON (⌘⇧I) — Keys sent to all panes' : 'Broadcast input: OFF (⌘⇧I)'}
                onClick={() => setBroadcast((b) => !b)}
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
            <div className="relative">
              <button title="Theme" onClick={() => setShowThemes((v) => !v)} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><Palette className="h-3.5 w-3.5" /></button>
              {showThemes && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowThemes(false)} />
                  <div className="absolute right-0 top-9 z-40 w-56 rounded-xl border border-white/10 bg-[#0e131d] p-2 shadow-2xl">
                  {THEMES.map((t) => (
                    <button key={t.id} onClick={() => setThemeId(t.id)} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs', t.id === themeId ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5')}>
                      <span className="flex h-5 w-8 overflow-hidden rounded ring-1 ring-white/10" style={{ background: t.xterm.background }}>
                        {[t.xterm.red, t.xterm.green, t.xterm.blue, t.xterm.magenta].map((c, i) => <span key={i} className="mt-auto h-1.5 flex-1" style={{ background: c }} />)}
                      </span>{t.name}
                    </button>
                  ))}
                  <div className="mt-2 flex items-center justify-between border-t border-white/5 px-2 pt-2 text-xs text-slate-400">
                    Font size
                    <div className="flex items-center gap-1">
                      <button onClick={() => setFontSize((f) => Math.max(10, f - 1))} className="rounded p-1 hover:bg-white/10"><Minus className="h-3 w-3" /></button>
                      <span className="w-6 text-center font-mono text-white">{fontSize}</span>
                      <button onClick={() => setFontSize((f) => Math.min(22, f + 1))} className="rounded p-1 hover:bg-white/10"><Plus className="h-3 w-3" /></button>
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
            <button title="AI Assistant (⌘⇧A)" onClick={() => setShowAI((v) => !v)} className={cn('grid h-7 w-7 place-items-center rounded-lg transition', showAI ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-400/30' : 'text-slate-400 hover:bg-white/10 hover:text-white')}><Sparkles className="h-3.5 w-3.5" /></button>
            <button title={showStatusBar ? 'Hide status bar (⌘⇧/)' : 'Show status bar (⌘⇧/)'} onClick={() => setShowStatusBar((v) => !v)} className={cn('grid h-7 w-7 place-items-center rounded-lg transition', showStatusBar ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30' : 'text-slate-400 hover:bg-white/10 hover:text-white')}><PanelBottom className="h-3.5 w-3.5" /></button>
            <button title="Zen mode (⌘⇧Z)" onClick={() => setZen((v) => !v)} className={cn('grid h-7 w-7 place-items-center rounded-lg transition', zen ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30' : 'text-slate-400 hover:bg-white/10 hover:text-white')}><Maximize2 className="h-3.5 w-3.5" /></button>
          </div>
        </header>
      )}

      {/* Main App Body */}
      <div className="flex flex-1 min-h-0 min-w-0 relative">
        {/* Icon rail — floating buttons aligned directly underneath the logo button */}
        {!zen && showRail && (
          <nav className="flex w-12 shrink-0 flex-col items-center gap-1.5 py-1.5 z-20 bg-transparent">
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
                <r.icon className="h-4 w-4" />
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
              <button title="Lock vault" onClick={lock} className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-400/30"><Lock className="h-4 w-4" /></button>
            </div>
          </nav>
        )}

        {/* Side panel — overlay drawer */}
        {panel && (
          <>
            <div
              className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
              onClick={() => setPanel(null)}
            />
            <aside
              className="fixed bottom-0 top-10 z-40 w-[340px] border-r border-white/10 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-left-2 duration-150 flex flex-col"
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

              <div className="relative flex flex-1 flex-col min-h-0 overflow-y-auto">
                {panel === 'hosts' && (
                  <HostSidebar
                    hosts={hosts}
                    vaults={vaults}
                    activeVaultId={activeVaultId}
                    onConnect={openHost}
                    onOpenSftp={(h) => { openSftpTab(h.id); setPanel(null); }}
                    onSplit={(h) => splitWith(h)}
                    onEdit={(h) => setModal({ host: h })}
                    onDelete={deleteHost}
                    onOpenTerminal={openLocalTerminal}
                    onOpenSerial={() => setShowSerial(true)}
                    onOpenShareModal={() => setShareModal({ initialTab: 'share' })}
                    onOpenSshConfig={() => setShowSshConfig(true)}
                    onQuickConnectSsh={handleQuickConnectSsh}
                    onClose={() => setPanel(null)}
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
                    toast={toast}
                  />
                )}
                {panel === 'tunnels' && (
                  <PortForwardingPanel
                    hosts={hosts}
                    tunnels={tunnels}
                    onSave={async (t) => { await bridge.saveTunnel(t); refresh(); }}
                    onDelete={async (id) => { await bridge.deleteTunnel(id); refresh(); }}
                    toast={toast}
                  />
                )}
                {panel === 'snippets' && (
                  <SnippetsPanel snippets={snippets} activePaneId={activePaneId} onSave={saveSnippet} onDelete={deleteSnippet} toast={toast} />
                )}
                {panel === 'logs' && (
                  <LogsPanel toast={toast} />
                )}
                {panel === 'known_hosts' && (
                  <KnownHostsPanel toast={toast} />
                )}
              </div>
            </aside>
          </>
        )}

        {/* Main workspace */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Panes */}
        <div className="relative min-h-0 flex-1" onClick={() => { setShowThemes(false); setQuick(false); setPanel(null); }}>
          {!tabs.length && (
            <Welcome
              hosts={hosts}
              onOpen={openHost}
              onLocal={openLocalTerminal}
              onNew={() => setModal({ host: null })}
              onSshConfig={() => setShowSshConfig(true)}
            />
          )}
          {tabs.map((t) => {
            if (t.kind === 'sftp') {
              return (
                <div
                  key={t.id}
                  className={cn('absolute inset-0', t.id !== activeTabId && 'invisible')}
                >
                  <SftpTab
                    tab={t}
                    hosts={hosts}
                    onUpdateTab={(patch) =>
                      setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))
                    }
                    toast={toast}
                    theme={theme}
                  />
                </div>
              );
            }
            const isSplit = t.panes.length > 1;
            return (
              <div
                key={t.id}
                className={cn(
                  'absolute inset-0',
                  t.id !== activeTabId && 'invisible',
                  isSplit
                    ? cn(
                        'grid gap-1 p-1 bg-black/40',
                        t.layout === 'vertical' && 'grid-cols-2',
                        t.layout === 'horizontal' && 'grid-rows-2',
                        t.layout === 'grid' && 'grid-cols-2 grid-rows-2'
                      )
                    : 'flex p-0'
                )}
              >
                {t.panes.map((p) => {
                  const h = hostMap.get(p.hostId);
                  if (!h) return null;
                  return (
                    <TerminalPane
                      key={p.id}
                      pane={p}
                      host={h}
                      theme={theme}
                      fontSize={fontSize}
                      lineHeight={lineHeight}
                      active={t.id === activeTabId && t.activePaneId === p.id}
                      showHeader={isSplit}
                      onFocus={() => focusPane(t.id, p.id)}
                      onClose={() => closePane(t.id, p.id)}
                      onChange={bump}
                      onData={(d) => handlePaneData(t.id, p.id, d)}
                      toast={toast}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Status bar */}
        {showStatusBar && (
          <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-white/5 bg-[#080b12] px-3 text-[10.5px] text-slate-500">
            <span className="flex items-center gap-1 text-emerald-400/90"><ShieldCheck className="h-3 w-3" />{isTauri ? 'SQLCipher AES-256' : 'Vault AES-256-GCM (sandbox)'}</span>
            <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{connected} live session{connected === 1 ? '' : 's'}</span>
            {activeLive && <span className="flex items-center gap-1 font-mono"><History className="h-3 w-3 text-fuchsia-300" />snapshot: {activeLive.cwd}</span>}
            <span className="ml-auto flex items-center gap-1"><Command className="h-3 w-3" />^R history · ⇧V clips · ⇧A AI · ⇧F SFTP · ⇧K connect</span>
            <span className={cn('flex items-center gap-1', isTauri ? 'text-cyan-300' : 'text-amber-300/80')}><Zap className="h-3 w-3" />{isTauri ? 'Native (Tauri)' : 'Browser sandbox'}</span>
          </footer>
        )}

        {/* Zen restore */}
        {zen && (
          <button onClick={() => setZen(false)} title="Exit Zen (⌘⇧Z)" className="absolute bottom-10 right-3 z-40 grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-[#0e131d]/95 text-slate-400 shadow-2xl backdrop-blur hover:text-white"><Minimize2 className="h-4 w-4" /></button>
        )}
      </main>

      {/* Draggable Resizer Edge for AI Assistant */}
      {showAI && (
        <div
          onMouseDown={startAiResize}
          className={cn(
            "group relative z-30 w-1 shrink-0 cursor-col-resize select-none bg-transparent hover:bg-cyan-400/50 transition-colors",
            isResizingAi && "bg-cyan-400/80"
          )}
          title="Drag to resize AI Assistant (Double-click to reset)"
          onDoubleClick={() => {
            setAiWidth(420);
            localStorage.setItem('nx.ai.panel_width', '420');
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
        style={{ width: `${aiWidth}px` }}
        className={cn("shrink-0 border-l border-white/5 bg-transparent flex flex-col relative", !showAI && "hidden")}
      >
        <AIPanel
          activePaneId={activePaneId}
          toast={toast}
          onClose={() => setShowAI(false)}
          theme={theme}
          newConnectionNonce={newConnNonce}
          visible={showAI}
        />
      </aside>
      </div>

      {/* Quick Connect Floating Palette */}
      {quick && (
        <div className="fixed inset-0 z-50 select-none" onClick={() => setQuick(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              top: `${quickPos.top}px`,
              left: `${quickPos.left}px`,
            }}
            className="absolute w-80 overflow-hidden rounded-xl border border-white/10 bg-[#0e131d]/95 p-2 shadow-2xl backdrop-blur-xl ring-1 ring-white/10"
          >
            <div className="flex items-center justify-between px-2 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5">
              <span>Quick Connect</span>
              <span className="font-mono text-[9px] text-slate-500">Esc to close</span>
            </div>

            {/* Filter / Connect Input */}
            <div className="px-1 pt-2 pb-1.5">
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
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
              />
            </div>

            <div className="max-h-72 overflow-y-auto space-y-0.5 px-0.5">
              {/* Local Terminal Option */}
              {(!quickFilter || 'local terminal'.includes(quickFilter.toLowerCase())) && (
                <button
                  onClick={() => {
                    openLocalTerminal();
                    setQuick(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
                >
                  <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-cyan-500/20 text-cyan-300">
                    <TerminalIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-200 group-hover:text-white">Local Terminal</div>
                    <div className="text-[10px] text-slate-500">bash / zsh shell</div>
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
                  className="flex w-full items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 text-left hover:bg-cyan-500/20 text-cyan-200 transition"
                >
                  <Zap className="h-4 w-4 text-cyan-400 shrink-0" />
                  <div className="min-w-0 flex-1 truncate text-xs">
                    Quick setup & connect to <span className="font-semibold text-white">{quickFilter}</span>
                  </div>
                </button>
              )}
            </div>

            <div className="mt-1.5 border-t border-white/5 pt-1.5 flex items-center justify-between">
              <button
                onClick={() => {
                  setQuick(false);
                  setModal({ host: null });
                }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-cyan-300 hover:bg-white/5 transition"
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
          onClose={() => setShowPairing(null)}
          onRefresh={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showSync && (
        <SyncModal
          onClose={() => setShowSync(false)}
          onOpenPairing={() => setShowPairing({ initialTab: 'share' })}
          toast={toast}
          theme={theme}
        />
      )}
      {toastMsg && <div className="nx-rise fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-[#121826]/95 px-4 py-2 text-xs text-slate-200 shadow-2xl backdrop-blur">{toastMsg}</div>}
    </div>
    </>
  );
}

function Welcome({
  hosts,
  onOpen,
  onLocal,
  onNew,
  onSshConfig,
}: {
  hosts: Host[];
  onOpen: (h: Host) => void;
  onLocal: () => void;
  onNew: () => void;
  onSshConfig: () => void;
}) {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.08),transparent_60%)]" />
      <div className="nx-blob pointer-events-none absolute left-1/4 top-1/3 h-72 w-72 rounded-full bg-cyan-500/10 blur-[100px]" />
      <div className="nx-blob-2 pointer-events-none absolute right-1/4 bottom-1/4 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      <div className="relative w-full max-w-2xl px-6 text-center">
        <img src="/nexus-logo.png" alt="" className="nx-float mx-auto h-20 w-20 rounded-2xl shadow-[0_0_60px_-10px_rgba(34,211,238,0.5)]" />
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-white">Where to today?</h1>
        <p className="mt-2 text-sm text-slate-500">Pick a host to open an encrypted session. Hover a host in the sidebar to open it in a split pane.</p>
        <div className="mt-8 grid grid-cols-2 gap-3 text-left">
          {hosts.slice(0, 4).map((h) => (
            <button key={h.id} onClick={() => onOpen(h)} className="group flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.04]">
              <OsIcon os={h.os} color={h.color} size={40} />
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-200">{h.label}</div>
                <div className="truncate font-mono text-[11px] text-slate-500">{h.username}@{h.hostname}</div>
              </div>
              <span className="ml-auto text-xs text-cyan-300 opacity-0 transition group-hover:opacity-100">Connect →</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button onClick={onLocal} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/20 transition">
            <TerminalIcon className="h-3.5 w-3.5" />Open Local Terminal
          </button>
          <button onClick={onNew} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-4 py-2 text-xs text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200 transition">
            <Plus className="h-3.5 w-3.5" />Add a new host
          </button>
          <button onClick={onSshConfig} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-amber-400/25 bg-amber-400/[0.03] px-4 py-2 text-xs text-amber-300/80 hover:border-amber-400/50 hover:text-amber-200 transition">
            <FolderInput className="h-3.5 w-3.5 text-amber-400" />Import ~/.ssh/config
          </button>
        </div>
      </div>
    </div>
  );
}

function SyncModal({
  onClose,
  onOpenPairing,
  toast,
  theme,
}: {
  onClose: () => void;
  onOpenPairing: () => void;
  toast: (m: string) => void;
  theme?: NexusTheme;
}) {
  const accentColor = theme?.accent ?? '#22d3ee';
  const bgColor = theme?.xterm?.background ?? '#0e131d';
  const [url, setUrl] = useState(() => localStorage.getItem('nx.sync.relay') ?? '');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<{ lastSync: number | null; lastError: string | null; deviceId: string; hasToken?: boolean; relayUrl?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.removeItem('nx.sync.token');
    } catch {}
    if (isTauri) {
      bridge.syncStatus().then((st) => {
        setStatus(st);
        if (st.relayUrl) setUrl(st.relayUrl);
      }).catch(() => {});
    }
  }, []);

  const save = async () => {
    try {
      localStorage.removeItem('nx.sync.token');
      if (url) localStorage.setItem('nx.sync.relay', url);
      else localStorage.removeItem('nx.sync.relay');
    } catch {}
    if (isTauri) {
      const tokenArg = token ? token : (token === '' && status?.hasToken ? undefined : '');
      await bridge.syncConfigure(url || null, tokenArg).catch(() => {});
    }
    toast(url ? 'Relay configured — secrets stored exclusively in encrypted vault' : 'Sync disabled');
    onClose();
  };
  const doSync = async () => {
    setBusy(true);
    try {
      if (isTauri) {
        const tokenArg = token ? token : undefined;
        await bridge.syncConfigure(url || null, tokenArg);
      }
      const out = await bridge.syncNow();
      setStatus({ lastSync: out.lastSync, lastError: out.lastError, deviceId: out.deviceId, hasToken: out.hasToken });
      toast('Sync complete');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus((s) => ({ ...(s ?? { lastSync: null, deviceId: '?' }), lastError: msg }));
      toast(`Sync failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };
  const steps = [
    ['K_root', 'Argon2id(master password, salt)'],
    ['K_sync', 'HKDF-SHA256(K_root, "nexus/sync/v1")'],
    ['Seal', 'XChaCha20-Poly1305 · 256-byte padded CBOR'],
    ['Blind', 'blob id = HMAC(K_index, table:id)'],
    ['Merge', 'Hybrid logical clocks · last-writer-wins'],
  ];
  const lastSyncStr = status?.lastSync ? new Date(status.lastSync * 1000).toLocaleString() : 'never';
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 p-6 shadow-2xl"
        style={{ backgroundColor: bgColor }}
      >
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        <div className="relative flex items-center gap-3">
          <div
            className="grid h-10 w-10 place-items-center rounded-2xl border transition shadow-lg shrink-0"
            style={{
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}35`,
              color: accentColor,
              boxShadow: `0 0 20px ${accentColor}25`,
            }}
          >
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Zero-knowledge sync</h3>
            <p className="text-[11px] text-slate-500">End-to-end encrypted · bring your own relay</p>
          </div>
        </div>

        {/* Direct Wi-Fi / LAN Pairing Shortcut */}
        <div
          className="relative mt-4 rounded-xl border p-3 flex items-center justify-between"
          style={{
            backgroundColor: `${accentColor}0e`,
            borderColor: `${accentColor}25`,
          }}
        >
          <div>
            <div className="text-xs font-semibold" style={{ color: accentColor }}>No relay? Link directly over LAN</div>
            <div className="text-[10.5px] text-slate-400">Clone your vault to a second device in 2 seconds via QR & PIN.</div>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenPairing();
            }}
            className="flex items-center gap-1 rounded-xl border px-3 py-1.5 text-xs font-medium transition shrink-0 shadow-sm"
            style={{
              backgroundColor: `${accentColor}20`,
              borderColor: `${accentColor}40`,
              color: accentColor,
            }}
          >
            <QrCode className="h-3.5 w-3.5" />
            <span>Pair Device</span>
          </button>
        </div>

        <ol className="relative mt-4 space-y-2">
          {steps.map(([k, v], i) => (
            <li key={k} className="flex items-center gap-3 text-xs">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/5 text-[10px] text-slate-400 ring-1 ring-white/10">{i + 1}</span>
              <span className="w-14 font-semibold" style={{ color: accentColor }}>{k}</span>
              <span className="font-mono text-[11px] text-slate-400">{v}</span>
            </li>
          ))}
        </ol>

        <div className="relative">
          <label className="mt-4 block text-[10px] uppercase tracking-wider text-slate-500">Relay URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://relay.example.com" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none" />
          <label className="mt-3 block text-[10px] uppercase tracking-wider text-slate-500">
            Device token (optional bearer auth)
            {status?.hasToken && !token && (
              <span className="ml-2 font-normal text-emerald-400 lowercase">
                (saved in encrypted vault)
              </span>
            )}
          </label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder={status?.hasToken ? '•••••••• (leave blank to keep existing)' : '••••••••'}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none"
          />
          <p className="mt-2 text-[11px] text-slate-500">The relay only ever sees opaque, padded ciphertext blobs with HMAC-blinded IDs. Hosts, keys, snippets and tunnels sync E2EE.</p>

          {status && (
            <div className="mt-3 rounded-lg border border-white/5 bg-black/30 p-2 font-mono text-[10.5px] text-slate-400">
              device <span style={{ color: accentColor }}>{status.deviceId}</span> · last sync <span className="text-emerald-300">{lastSyncStr}</span>
              {status.lastError && <div className="mt-1 text-rose-300">error: {status.lastError}</div>}
            </div>
          )}

          <div className="mt-5 flex justify-between gap-2">
            <button
              onClick={doSync}
              disabled={!url || busy}
              className="rounded-xl border px-4 py-2 text-xs font-semibold transition disabled:opacity-40"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
              }}
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="rounded-xl px-4 py-2 text-xs text-slate-300 hover:bg-white/5">Close</button>
              <button
                onClick={save}
                className="rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg"
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 0 20px ${accentColor}35`,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
