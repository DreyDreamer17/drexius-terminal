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
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { bridge, isTauri } from './lib/bridge';
import { registry } from './lib/sessions';
import { THEMES } from './lib/themes';
import type { Host, HostSecret, KeychainItem, Layout, Pane, Snippet, Tab, TunnelConfig } from './lib/types';
import { LockScreen } from './components/LockScreen';
import { HostSidebar } from './components/HostSidebar';
import { HostModal } from './components/HostModal';
import { OsIcon } from './components/OsIcon';
import { SnippetsPanel } from './components/SnippetsPanel';
import { TerminalPane } from './components/TerminalPane';
import { KeychainPanel } from './components/KeychainPanel';
import { PortForwardingPanel } from './components/PortForwardingPanel';
import { LogsPanel } from './components/LogsPanel';
import { KnownHostsPanel } from './components/KnownHostsPanel';
import { AIPanel } from './components/AIPanel';
import { SftpDrawer } from './components/SftpDrawer';
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

export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [keychain, setKeychain] = useState<KeychainItem[]>([]);
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'hosts' | 'snippets' | 'keychain' | 'tunnels' | 'logs' | 'known_hosts' | null>(null);
  const [showAI, setShowAI] = useState(true);
  const [showSftp, setShowSftp] = useState(false);
  const [themeId, setThemeId] = useState(() => localStorage.getItem('nx.theme') ?? 'nexus');
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('nx.font') ?? 13));
  const [showThemes, setShowThemes] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [modal, setModal] = useState<{ host: Host | null } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
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
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const toast = useCallback((m: string) => { setToastMsg(m); setTimeout(() => setToastMsg((c) => (c === m ? null : c)), 2400); }, []);
  useEffect(() => { localStorage.setItem('nx.theme', themeId); }, [themeId]);
  useEffect(() => { localStorage.setItem('nx.font', String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem('nx.zen', zen ? '1' : '0'); }, [zen]);
  useEffect(() => { localStorage.setItem('nx.rail', showRail ? '1' : '0'); }, [showRail]);
  useEffect(() => { localStorage.setItem('nx.status', showStatusBar ? '1' : '0'); }, [showStatusBar]);

  const refresh = useCallback(async () => {
    const [h, s, k, tun] = await Promise.all([
      bridge.listHosts(),
      bridge.listSnippets(),
      bridge.listKeychain(),
      bridge.listTunnels(),
    ]);
    setHosts(h);
    setSnippets(s);
    setKeychain(k);
    setTunnels(tun);
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
  }, []);

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

  const closePane = (tabId: string, paneId: string) => {
    setTabs((ts) => {
      const next = ts.map((t) => {
        if (t.id !== tabId) return t;
        const panes = t.panes.filter((p) => p.id !== paneId);
        return { ...t, panes, layout: layoutFor(panes.length, t.layout), activePaneId: t.activePaneId === paneId ? panes[0]?.id ?? '' : t.activePaneId, title: panes.length > 1 ? `${t.title.split(' +')[0]} +${panes.length - 1}` : hostMap.get(panes[0]?.hostId ?? '')?.label ?? t.title };
      }).filter((t) => t.panes.length);
      if (!next.find((t) => t.id === activeTabId)) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  const closeTab = (id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === activeTabId) setActiveTabId(next[Math.max(0, i - 1)]?.id ?? null);
      return next;
    });
  };

  const focusPane = (tabId: string, paneId: string) => setTabs((ts) => ts.map((t) => (t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t)));

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
          if (p.isLocal) {
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
      if (e.key === 'Escape') { setQuick(false); setShowThemes(false); setPanel(null); setModal(null); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === 't') { e.preventDefault(); openLocalTerminal(); return; }
      if (k === 'k') { e.preventDefault(); toggleQuick(); return; }
      if (!e.shiftKey) return;
      if (k === 'i') { e.preventDefault(); setBroadcast((b) => !b); }
      else if (k === 'd') { e.preventDefault(); splitActive('vertical'); }
      else if (k === 'e') { e.preventDefault(); splitActive('horizontal'); }
      else if (k === 'a') { e.preventDefault(); setShowAI((v) => !v); }
      else if (k === 'f') { e.preventDefault(); setShowSftp((v) => !v); }
      else if (k === 'z') { e.preventDefault(); setZen((v) => !v); }
      else if (k === 'b') { e.preventDefault(); setShowRail((v) => !v); }
      else if (k === '/') { e.preventDefault(); setShowStatusBar((v) => !v); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleQuick, openLocalTerminal, broadcast, tabs]);

  // ── Hosts / snippets CRUD ──
  const saveHost = async (h: Host, s?: HostSecret) => { await bridge.saveHost(h, s); setModal(null); toast(`Saved ${h.label} to vault`); refresh(); };
  const deleteHost = async (h: Host) => { if (confirm(`Delete ${h.label}? Stored credentials will be wiped.`)) { await bridge.deleteHost(h.id); refresh(); } };
  const saveSnippet = async (s: Snippet) => { await bridge.saveSnippet(s); refresh(); toast('Snippet saved'); };
  const deleteSnippet = async (id: string) => { await bridge.deleteSnippet(id); refresh(); };

  const lock = async () => { setTabs([]); setActiveTabId(null); await bridge.lock(); setUnlocked(false); };

  if (!unlocked) return <LockScreen onUnlocked={() => setUnlocked(true)} />;

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
    { id: 'sftp', icon: HardDrive, label: 'SFTP (⌘⇧F)', on: showSftp, act: () => setShowSftp((v) => !v) },
    { id: 'ai', icon: Sparkles, label: 'AI Assistant (⌘⇧A)', on: showAI, act: () => setShowAI((v) => !v) },
  ];

  return (
    <div
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

          {/* Quick Hosts & SFTP buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setPanel((p) => (p === 'hosts' ? null : 'hosts'))}
              title="Hosts / Vaults (⌘⇧K)"
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition border shadow-sm',
                panel === 'hosts'
                  ? 'bg-cyan-400/20 text-cyan-200 border-cyan-400/40'
                  : 'bg-white/[0.06] border-white/10 text-slate-300 hover:bg-white/[0.12] hover:text-white hover:border-white/20'
              )}
            >
              <Server className="h-3.5 w-3.5 text-cyan-400" />
              <span className="font-medium hidden sm:inline">Hosts</span>
            </button>
            <button
              onClick={() => setShowSftp((v) => !v)}
              title="SFTP File Browser (⌘⇧F)"
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition border shadow-sm',
                showSftp
                  ? 'bg-emerald-400/20 text-emerald-200 border-emerald-400/40'
                  : 'bg-white/[0.06] border-white/10 text-slate-300 hover:bg-white/[0.12] hover:text-white hover:border-white/20'
              )}
            >
              <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
              <span className="font-medium hidden sm:inline">SFTP</span>
            </button>
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 shrink-0" />

          {/* Floating Tabs */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pl-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => {
              const tabLive = t.panes.map((p) => registry.get(p.id)?.status);
              const dot = tabLive.includes('disconnected') || tabLive.includes('error') ? 'bg-rose-500' : tabLive.every((s) => s === 'connected') ? 'bg-emerald-400' : 'bg-amber-400';
              const isActive = t.id === activeTabId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTabId(t.id)}
                  className={cn(
                    'group relative flex h-7 min-w-[130px] max-w-[220px] cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs transition border shadow-sm',
                    isActive
                      ? 'border-emerald-500/40 bg-emerald-950/70 text-emerald-200 ring-1 ring-emerald-500/20'
                      : 'border-white/5 bg-white/[0.03] text-slate-400 hover:border-white/10 hover:bg-white/[0.07] hover:text-slate-200'
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
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
              <button title="Zero-knowledge sync" onClick={() => setShowSync(true)} className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-white/[0.08] hover:text-white"><Cloud className="h-4 w-4" /></button>
              <button title="Lock vault" onClick={lock} className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-400/30"><Lock className="h-4 w-4" /></button>
            </div>
          </nav>
        )}

        {/* Side panel — overlay drawer */}
        {panel && (
          <>
            <div className="fixed inset-0 z-30 bg-black/40" onClick={() => setPanel(null)} />
            <aside className="fixed bottom-0 top-10 z-40 w-[320px] border-r border-white/10 bg-[#0b0f17] shadow-2xl" style={{ left: (zen || !showRail) ? 0 : 48 }}>
              {panel === 'hosts' && (
                <HostSidebar hosts={hosts} onConnect={openHost} onSplit={(h) => splitWith(h)} onEdit={(h) => setModal({ host: h })} onDelete={deleteHost} />
              )}
              {panel === 'keychain' && (
                <KeychainPanel
                  keychain={keychain}
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
            </aside>
          </>
        )}

        {/* Main workspace */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Panes */}
        <div className="relative min-h-0 flex-1" onClick={() => { setShowThemes(false); setQuick(false); setPanel(null); }}>
          {!tabs.length && <Welcome hosts={hosts} onOpen={openHost} onLocal={openLocalTerminal} onNew={() => setModal({ host: null })} />}
          {tabs.map((t) => {
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
                      active={t.id === activeTabId && t.activePaneId === p.id}
                      showHeader={isSplit}
                      onFocus={() => focusPane(t.id, p.id)}
                      onClose={() => closePane(t.id, p.id)}
                      onChange={bump}
                      onData={(d) => handlePaneData(t.id, p.id, d)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>

        {showSftp && <SftpDrawer activePaneId={activePaneId} tick={tick} onClose={() => setShowSftp(false)} toast={toast} />}

        {/* Status bar */}
        {showStatusBar && (
          <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-white/5 bg-[#080b12] px-3 text-[10.5px] text-slate-500">
            <span className="flex items-center gap-1 text-emerald-400/90"><ShieldCheck className="h-3 w-3" />{isTauri ? 'SQLCipher AES-256' : 'Vault AES-256-GCM (sandbox)'}</span>
            <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{connected} live session{connected === 1 ? '' : 's'}</span>
            {activeLive && <span className="flex items-center gap-1 font-mono"><History className="h-3 w-3 text-fuchsia-300" />snapshot: {activeLive.cwd}</span>}
            <span className="ml-auto flex items-center gap-1"><Command className="h-3 w-3" />⇧K connect · ⇧D split · ⇧A AI · ⇧F SFTP · ⇧B rail · ⇧/ status</span>
            <span className={cn('flex items-center gap-1', isTauri ? 'text-cyan-300' : 'text-amber-300/80')}><Zap className="h-3 w-3" />{isTauri ? 'Native (Tauri)' : 'Browser sandbox'}</span>
          </footer>
        )}

        {/* Zen restore */}
        {zen && (
          <button onClick={() => setZen(false)} title="Exit Zen (⌘⇧Z)" className="absolute bottom-10 right-3 z-40 grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-[#0e131d]/95 text-slate-400 shadow-2xl backdrop-blur hover:text-white"><Minimize2 className="h-4 w-4" /></button>
        )}
      </main>

      {showAI && (
        <aside className="w-[340px] shrink-0 border-l border-white/5 bg-[#0b0f17]">
          <AIPanel activePaneId={activePaneId} toast={toast} />
        </aside>
      )}
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

            <div className="mt-1.5 border-t border-white/5 pt-1.5">
              <button
                onClick={() => {
                  setQuick(false);
                  setModal({ host: null });
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-cyan-300 hover:bg-white/5 transition"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New host…</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {modal && <HostModal host={modal.host} onClose={() => setModal(null)} onSave={saveHost} />}
      {showSync && <SyncModal onClose={() => setShowSync(false)} toast={toast} />}
      {toastMsg && <div className="nx-rise fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-[#121826]/95 px-4 py-2 text-xs text-slate-200 shadow-2xl backdrop-blur">{toastMsg}</div>}
    </div>
  );
}

function Welcome({ hosts, onOpen, onLocal, onNew }: { hosts: Host[]; onOpen: (h: Host) => void; onLocal: () => void; onNew: () => void }) {
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
        <div className="mt-4 flex items-center justify-center gap-2">
          <button onClick={onLocal} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/20">
            <TerminalIcon className="h-3.5 w-3.5" />Open Local Terminal
          </button>
          <button onClick={onNew} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-4 py-2 text-xs text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200">
            <Plus className="h-3.5 w-3.5" />Add a new host
          </button>
        </div>
      </div>
    </div>
  );
}

function SyncModal({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const [url, setUrl] = useState(() => localStorage.getItem('nx.sync.relay') ?? '');
  const save = async () => {
    localStorage.setItem('nx.sync.relay', url);
    if (isTauri) await invoke('sync_configure', { relayUrl: url || null }).catch(() => {});
    toast(url ? 'Relay configured — data leaves this device only as ciphertext' : 'Sync disabled');
    onClose();
  };
  const steps = [
    ['K_root', 'Argon2id(master password, salt)'],
    ['K_sync', 'HKDF-SHA256(K_root, "nexus/sync/v1")'],
    ['Seal', 'XChaCha20-Poly1305 · 256-byte padded CBOR'],
    ['Blind', 'blob id = HMAC(K_index, table:id)'],
    ['Merge', 'Hybrid logical clocks · last-writer-wins'],
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0e131d] p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400/20 to-violet-500/20 ring-1 ring-white/10"><Cloud className="h-5 w-5 text-cyan-200" /></div>
          <div><h3 className="text-sm font-semibold text-white">Zero-knowledge sync</h3><p className="text-[11px] text-slate-500">End-to-end encrypted · bring your own relay</p></div>
        </div>
        <ol className="mt-5 space-y-2">
          {steps.map(([k, v], i) => (
            <li key={k} className="flex items-center gap-3 text-xs">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/5 text-[10px] text-slate-400 ring-1 ring-white/10">{i + 1}</span>
              <span className="w-14 font-semibold text-cyan-200">{k}</span>
              <span className="font-mono text-[11px] text-slate-400">{v}</span>
            </li>
          ))}
        </ol>
        <label className="mt-5 block text-[10px] uppercase tracking-wider text-slate-500">Relay URL (WebDAV / S3 / self-hosted)</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://relay.example.com" className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400/40 focus:outline-none" />
        <p className="mt-2 text-[11px] text-slate-500">The relay only ever sees opaque, padded ciphertext blobs with blinded IDs. New devices pair via an X25519 QR handshake.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-slate-300 hover:bg-white/5">Close</button>
          <button onClick={save} className="rounded-lg bg-gradient-to-r from-cyan-400 to-violet-400 px-4 py-2 text-xs font-semibold text-black">Save</button>
        </div>
      </div>
    </div>
  );
}
