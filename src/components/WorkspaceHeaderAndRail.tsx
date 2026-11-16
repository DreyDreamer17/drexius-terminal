import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Cloud,
  Code2,
  Columns2,
  ExternalLink,
  Folder,
  HardDrive,
  History,
  KeyRound,
  LayoutGrid,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Palette,
  PanelBottom,
  Plus,
  QrCode,
  Radio,
  Rocket,
  Rows2,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  Timer,
  X,
} from 'lucide-react';
import drexiusLogo from '../assets/drexius-logo.png';
import { bridge } from '../lib/bridge';
import type { LayoutPreset } from '../lib/layoutPresets';
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from '../lib/mobileTerminal';
import { registry, type LivePane } from '../lib/sessions';
import type { UiPreferences } from '../lib/settings';
import type { SplitDirection } from '../lib/splitTree';
import type { DrexiusTheme } from '../lib/themes';
import type {
  CloudInstance,
  Host,
  KeychainItem,
  Layout,
  Pane,
  PopoutPaneEntry,
  Snippet,
  Tab,
  TunnelConfig,
  Vault,
} from '../lib/types';
import {
  AUTO_LOCK_OPTIONS,
  AUTO_LOCK_STORAGE_KEY,
  MAX_PANES_PER_TAB,
  type SplitMenuState,
  type WorkspacePanelKind,
} from '../lib/workspaceState';
import { cn } from '../utils/cn';
import { HostSidebar } from './HostSidebar';
import { KeychainPanel } from './KeychainPanel';
import { KnownHostsPanel } from './KnownHostsPanel';
import { LogsPanel } from './LogsPanel';
import type { MobilePage } from './MobileNavigation';
import { PortForwardingPanel } from './PortForwardingPanel';
import type { SettingsTab } from './SettingsModal';
import { SnippetsPanel } from './SnippetsPanel';
import { VaultMenu } from './VaultMenu';
import { SplitMenuPopover } from './WorkspaceLayoutMenu';

export interface WorkspaceHeaderProps {
  isPopoutWindow: boolean;
  showRail: boolean;
  setShowRail: Dispatch<SetStateAction<boolean>>;
  vaults: Vault[];
  activeVaultId: string | 'all';
  setActiveVaultId: Dispatch<SetStateAction<string | 'all'>>;
  handleCreateVault: (v: Vault) => Promise<void>;
  handleDeleteVault: (id: string) => Promise<void>;
  setShareModal: Dispatch<SetStateAction<{ initialTab?: 'share' | 'import' } | null>>;
  setShowPairing: Dispatch<SetStateAction<{ initialTab?: 'share' | 'join' | 'devices' } | null>>;
  panel: WorkspacePanelKind | null;
  setPanel: Dispatch<SetStateAction<WorkspacePanelKind | null>>;
  uiPrefs: UiPreferences;
  activeTab: Tab | null;
  activeTabId: string | null;
  setActiveTabId: Dispatch<SetStateAction<string | null>>;
  tabs: Tab[];
  maximizedPaneId: string | null;
  toggleMaximizePane: (paneId?: string) => void;
  closeTab: (id: string) => void;
  quickBtnRef: RefObject<HTMLButtonElement | null>;
  quick: boolean;
  toggleQuick: () => void;
  openLocalTerminal: () => void;
  openSftpTab: (initialHostId?: string) => void;
  setShowSerial: Dispatch<SetStateAction<boolean>>;
  showDockerModal: boolean;
  setShowDockerModal: Dispatch<SetStateAction<boolean>>;
  showDeployModal: boolean;
  setShowDeployModal: Dispatch<SetStateAction<boolean>>;
  setDockerHostId: Dispatch<SetStateAction<string | null>>;
  terminalContext: Tab | undefined | null;
  activePaneId: string | null;
  activePane: Pane | undefined;
  activeLive: LivePane | undefined;
  showTerminalTools: boolean;
  toggleTerminalTools: () => void;
  splitMenu: SplitMenuState | null;
  setSplitMenu: Dispatch<SetStateAction<SplitMenuState | null>>;
  sendPopoutAction: (action: 'dock' | 'close') => void;
  popOutPane: (tabId: string, paneId: string) => void;
  poppedOutPanes: PopoutPaneEntry[];
  showPopoutMenu: boolean;
  setShowPopoutMenu: Dispatch<SetStateAction<boolean>>;
  openPopoutOsWindow: (entry: PopoutPaneEntry) => Promise<void>;
  dockBackPane: (paneId: string) => void;
  closePopoutPane: (paneId: string) => void;
  hosts: Host[];
  hostMap: Map<string, Host>;
  userPresets: LayoutPreset[];
  splitPaneInDirection: (direction: SplitDirection, targetHost?: Host, fromPaneId?: string) => void;
  changeActiveTabLayout: (layout: Layout) => void;
  equalizeActiveTab: () => void;
  setPresetNameInput: Dispatch<SetStateAction<string>>;
  setShowSavePresetModal: Dispatch<SetStateAction<boolean>>;
  applyLayoutPreset: (preset: LayoutPreset) => void;
  handleDeletePreset: (id: string, name: string) => void;
  broadcast: boolean;
  setBroadcast: Dispatch<SetStateAction<boolean>>;
  showThemes: boolean;
  setShowThemes: Dispatch<SetStateAction<boolean>>;
  allThemes: DrexiusTheme[];
  theme: DrexiusTheme;
  themeId: string;
  setThemeId: Dispatch<SetStateAction<string>>;
  fontSize: number;
  handleGlobalFontSizeChange: (nextOrUpdater: number | ((prev: number) => number)) => void;
  lineHeight: number;
  setLineHeight: Dispatch<SetStateAction<number>>;
  showAI: boolean;
  setShowAI: Dispatch<SetStateAction<boolean>>;
  showStatusBar: boolean;
  setShowStatusBar: Dispatch<SetStateAction<boolean>>;
  zen: boolean;
  setZen: Dispatch<SetStateAction<boolean>>;
  toast: (msg: string) => void;
}

export function WorkspaceHeader({
  isPopoutWindow,
  showRail,
  setShowRail,
  vaults,
  activeVaultId,
  setActiveVaultId,
  handleCreateVault,
  handleDeleteVault,
  setShareModal,
  setShowPairing,
  panel,
  setPanel,
  uiPrefs,
  activeTab,
  activeTabId,
  setActiveTabId,
  tabs,
  maximizedPaneId,
  toggleMaximizePane,
  closeTab,
  quickBtnRef,
  quick,
  toggleQuick,
  openLocalTerminal,
  openSftpTab,
  setShowSerial,
  showDockerModal,
  setShowDockerModal,
  showDeployModal,
  setShowDeployModal,
  setDockerHostId,
  terminalContext,
  activePaneId,
  activePane,
  activeLive,
  showTerminalTools,
  toggleTerminalTools,
  splitMenu,
  setSplitMenu,
  sendPopoutAction,
  popOutPane,
  poppedOutPanes,
  showPopoutMenu,
  setShowPopoutMenu,
  openPopoutOsWindow,
  dockBackPane,
  closePopoutPane,
  hosts,
  hostMap,
  userPresets,
  splitPaneInDirection,
  changeActiveTabLayout,
  equalizeActiveTab,
  setPresetNameInput,
  setShowSavePresetModal,
  applyLayoutPreset,
  handleDeletePreset,
  broadcast,
  setBroadcast,
  showThemes,
  setShowThemes,
  allThemes,
  theme,
  themeId,
  setThemeId,
  fontSize,
  handleGlobalFontSizeChange,
  lineHeight,
  setLineHeight,
  showAI,
  setShowAI,
  showStatusBar,
  setShowStatusBar,
  zen,
  setZen,
  toast,
}: WorkspaceHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-10 shrink-0 items-center gap-1.5 px-1 pt-1 pb-0.5 bg-transparent border-0 relative z-50',
        !isPopoutWindow && 'max-md:hidden'
      )}
    >
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
          <Server
            className="h-3.5 w-3.5 transition-colors"
            style={{ color: panel === 'hosts' ? theme.accent : theme?.accent || '#22d3ee' }}
          />
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
            <HardDrive
              className="h-3.5 w-3.5 transition-colors"
              style={{ color: activeTab?.kind === 'sftp' ? theme.accent : '#10b981' }}
            />
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
              {t.panes.length > 1 &&
                (maximizedPaneId && t.id === activeTabId ? (
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
                ))}
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
            title={showDockerModal ? 'Docker Containers (Opening…)' : 'Docker Containers (⌘⇧U)'}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition',
              showDockerModal
                ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-[0_0_10px_rgba(34,211,238,0.25)]'
                : 'text-slate-400 hover:bg-white/10 hover:text-cyan-300'
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
        {uiPrefs.showDeploy && (
          <button
            onClick={() => {
              const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
              setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
              setShowDeployModal(true);
            }}
            title="1-Click Atomic Application Deployment"
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition',
              showDeployModal
                ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 shadow-[0_0_10px_rgba(52,211,153,0.25)]'
                : 'text-slate-400 hover:bg-white/10 hover:text-emerald-300'
            )}
          >
            <Rocket className="h-3.5 w-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Deploy</span>
          </button>
        )}
        {activeTab && (activeTab.panes.length === 1 || (maximizedPaneId !== null && activeTab.id === activeTabId)) && (
          <div className="flex items-center gap-1 shrink-0">
            <div className="h-4 w-px bg-white/10 mx-0.5" />
            <button
              onClick={toggleTerminalTools}
              title={
                showTerminalTools
                  ? 'Collapse terminal tools (Search, History, Clips)'
                  : 'Expand terminal tools (Search, History, Clips)'
              }
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
          disabled={!activeTab || (activeTab?.panes.length ?? 0) >= MAX_PANES_PER_TAB}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSplitMenu((prev) =>
              prev?.tab === 'split' && prev.direction === 'right'
                ? null
                : { tab: 'split', direction: 'right', pref: 'vertical', left: rect.left, top: rect.bottom + 6 }
            );
          }}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-lg transition border disabled:opacity-30',
            splitMenu?.tab === 'split' && splitMenu.direction === 'right'
              ? 'text-white'
              : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
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
          <Columns2
            className="h-3.5 w-3.5"
            style={{ color: splitMenu?.tab === 'split' && splitMenu.direction === 'right' ? theme.accent : undefined }}
          />
        </button>
        <button
          title="Split horizontal (⌘⇧E)"
          disabled={!activeTab || (activeTab?.panes.length ?? 0) >= MAX_PANES_PER_TAB}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSplitMenu((prev) =>
              prev?.tab === 'split' && prev.direction === 'down'
                ? null
                : { tab: 'split', direction: 'down', pref: 'horizontal', left: rect.left, top: rect.bottom + 6 }
            );
          }}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-lg transition border disabled:opacity-30',
            splitMenu?.tab === 'split' && splitMenu.direction === 'down'
              ? 'text-white'
              : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
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
          <Rows2
            className="h-3.5 w-3.5"
            style={{ color: splitMenu?.tab === 'split' && splitMenu.direction === 'down' ? theme.accent : undefined }}
          />
        </button>
        <button
          title="Layout Presets & Switcher (⌘⇧L)"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSplitMenu((prev) =>
              prev?.tab === 'presets' || prev?.tab === 'layout'
                ? null
                : {
                    tab: (activeTab?.panes.length ?? 0) > 1 ? 'layout' : 'presets',
                    direction: 'right',
                    pref: 'vertical',
                    left: rect.left,
                    top: rect.bottom + 6,
                  }
            );
          }}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-lg transition border',
            splitMenu?.tab === 'presets' || splitMenu?.tab === 'layout'
              ? 'text-white'
              : 'text-slate-400 hover:bg-white/10 hover:text-white border-transparent'
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
          <LayoutGrid
            className="h-3.5 w-3.5"
            style={{ color: splitMenu?.tab === 'presets' || splitMenu?.tab === 'layout' ? theme.accent : undefined }}
          />
        </button>
        {isPopoutWindow ? (
          <div className="flex items-center gap-1 shrink-0">
            <span
              className="hidden xl:inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider uppercase"
              style={{
                backgroundColor: `${theme.accent}18`,
                borderColor: `${theme.accent}45`,
                color: theme.accent,
              }}
            >
              Popped Out
            </span>
            <button
              type="button"
              onClick={() => sendPopoutAction('dock')}
              title="Dock all panes in this window back into main workspace (⌘⇧P / Ctrl+Shift+P)"
              className="flex h-7 items-center gap-1.5 rounded-lg border border-cyan-400/45 bg-cyan-500/15 px-2.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 transition cursor-pointer select-none"
            >
              <Minimize2 className="h-3.5 w-3.5 text-cyan-300" />
              <span>Dock Back</span>
            </button>
            <button
              type="button"
              onClick={() => sendPopoutAction('close')}
              title="Terminate session(s) and close popped-out window"
              className="grid h-7 w-7 place-items-center rounded-lg border border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            title="Pop out active pane into standalone window (⌘⇧P / Ctrl+Shift+P)"
            disabled={!activeTab || activeTab.kind === 'sftp' || activeTab.panes.length === 0}
            onClick={() => {
              if (activeTab && activeTab.kind !== 'sftp' && activeTab.panes.length > 0) {
                popOutPane(activeTab.id, activeTab.activePaneId);
              }
            }}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-cyan-300 transition border border-transparent disabled:opacity-30 cursor-pointer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        {poppedOutPanes.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowPopoutMenu((v) => !v)}
              title={`${poppedOutPanes.length} popped-out terminal window${poppedOutPanes.length > 1 ? 's' : ''} — click to manage or dock back`}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold border transition cursor-pointer select-none',
                showPopoutMenu
                  ? 'bg-cyan-500/25 text-cyan-200 border-cyan-400/60 shadow-[0_0_12px_rgba(34,211,238,0.25)]'
                  : 'bg-cyan-500/15 text-cyan-300 border-cyan-400/35 hover:bg-cyan-500/25'
              )}
            >
              <ExternalLink className="h-3 w-3" />
              <span className="hidden lg:inline">Popped Out</span>
              <span className="rounded bg-cyan-400/25 px-1 font-mono text-[10px] text-cyan-100">
                {poppedOutPanes.length}
              </span>
            </button>
            {showPopoutMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowPopoutMenu(false)} />
                <div
                  className="absolute right-0 top-9 z-50 w-72 rounded-xl border border-white/10 p-2 shadow-2xl backdrop-blur-xl text-xs text-slate-200"
                  style={{
                    backgroundColor: theme.xterm.background || '#0e131d',
                    borderColor: `${theme.accent}35`,
                    boxShadow: `0 16px 36px rgba(0,0,0,0.65), 0 0 20px ${theme.accent}15`,
                  }}
                >
                  <div className="flex items-center justify-between px-2 py-1 mb-1 border-b border-white/10">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Popped-Out Panes ({poppedOutPanes.length})
                    </span>
                    {poppedOutPanes.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowPopoutMenu(false);
                          poppedOutPanes.forEach((entry) => dockBackPane(entry.pane.id));
                        }}
                        className="text-[10px] font-semibold text-cyan-300 hover:text-white transition cursor-pointer"
                      >
                        Dock All Back
                      </button>
                    )}
                  </div>
                  <div className="space-y-1 max-h-56 overflow-y-auto">
                    {poppedOutPanes.map((entry) => (
                      <div
                        key={entry.pane.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] border border-white/5 px-2.5 py-1.5"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setShowPopoutMenu(false);
                            void openPopoutOsWindow(entry);
                          }}
                          title="Focus popped-out window"
                          className="min-w-0 flex-1 text-left hover:text-white transition cursor-pointer"
                        >
                          <div className="font-medium text-white truncate">{entry.title}</div>
                          <div className="font-mono text-[10px] text-slate-400 truncate">
                            {entry.pane.initialCwd || '~'}
                          </div>
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setShowPopoutMenu(false);
                              dockBackPane(entry.pane.id);
                            }}
                            title="Dock pane back into main window"
                            className="flex items-center gap-1 rounded bg-cyan-500/15 border border-cyan-400/35 px-2 py-1 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/25 transition cursor-pointer"
                          >
                            <Minimize2 className="h-2.5 w-2.5" />
                            <span>Dock</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowPopoutMenu(false);
                              closePopoutPane(entry.pane.id);
                            }}
                            title="Close session"
                            className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 transition cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {splitMenu && (
          <SplitMenuPopover
            splitMenu={splitMenu}
            setSplitMenu={setSplitMenu}
            theme={theme}
            activeTab={activeTab}
            activePane={activePane}
            hosts={hosts}
            hostMap={hostMap}
            userPresets={userPresets}
            poppedOutPanes={poppedOutPanes}
            onSplitPaneInDirection={splitPaneInDirection}
            onChangeActiveTabLayout={changeActiveTabLayout}
            onEqualizeActiveTab={equalizeActiveTab}
            onOpenSavePresetModal={(defaultName) => {
              setPresetNameInput(defaultName);
              setShowSavePresetModal(true);
            }}
            onApplyLayoutPreset={applyLayoutPreset}
            onDeletePreset={handleDeletePreset}
          />
        )}
        {activeTab && activeTab.panes.length > 1 && (
          <button
            title={
              broadcast
                ? 'Broadcast input: ON (⌘⇧I) — Keys sent to all panes'
                : 'Broadcast input: OFF (⌘⇧I)'
            }
            onClick={() => {
              setBroadcast((b) => {
                const next = !b;
                toast(
                  next
                    ? '⚡ Broadcast Cluster Mode: ON (Input sent to all panes in tab)'
                    : 'Broadcast Cluster Mode: OFF'
                );
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
            <button
              title="Theme"
              onClick={() => setShowThemes((v) => !v)}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
            {showThemes && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowThemes(false)} />
                <div className="absolute right-0 top-9 z-40 w-56 rounded-xl border border-white/10 bg-[#0e131d] p-2 shadow-2xl">
                  <div className="max-h-64 overflow-y-auto space-y-0.5 pr-0.5">
                    {allThemes.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setThemeId(t.id)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs',
                          t.id === themeId ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5'
                        )}
                      >
                        <span
                          className="flex h-5 w-8 shrink-0 overflow-hidden rounded ring-1 ring-white/10"
                          style={{ background: t.xterm.background }}
                        >
                          {[t.xterm.red, t.xterm.green, t.xterm.blue, t.xterm.magenta].map((c, i) => (
                            <span key={i} className="mt-auto h-1.5 flex-1" style={{ background: c }} />
                          ))}
                        </span>
                        <span className="truncate">{t.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-white/5 px-2 pt-2 text-xs text-slate-400">
                    Font size
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleGlobalFontSizeChange((f) => Math.max(TERMINAL_FONT_MIN, f - 1))}
                        className="rounded p-1 hover:bg-white/10"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-6 text-center font-mono text-white">{fontSize}</span>
                      <button
                        onClick={() => handleGlobalFontSizeChange((f) => Math.min(TERMINAL_FONT_MAX, f + 1))}
                        className="rounded p-1 hover:bg-white/10"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center justify-between px-2 pt-1 text-xs text-slate-400">
                    Line height
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setLineHeight((lh) => Math.max(1.0, Number((lh - 0.05).toFixed(2))))}
                        className="rounded p-1 hover:bg-white/10"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-10 text-center font-mono text-white">{lineHeight.toFixed(2)}</span>
                      <button
                        onClick={() => setLineHeight((lh) => Math.min(1.5, Number((lh + 0.05).toFixed(2))))}
                        className="rounded p-1 hover:bg-white/10"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {uiPrefs.showAi && (
          <button
            title="AI Assistant (⌘⇧A)"
            onClick={() => setShowAI((v) => !v)}
            className={cn(
              'grid h-7 w-7 place-items-center rounded-lg transition',
              showAI
                ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-400/30'
                : 'text-slate-400 hover:bg-white/10 hover:text-white'
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
        )}
        {uiPrefs.showStatusBarToggle && (
          <button
            title={showStatusBar ? 'Hide status bar (⌘⇧/)' : 'Show status bar (⌘⇧/)'}
            onClick={() => setShowStatusBar((v) => !v)}
            className={cn(
              'grid h-7 w-7 place-items-center rounded-lg transition',
              showStatusBar
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30'
                : 'text-slate-400 hover:bg-white/10 hover:text-white'
            )}
          >
            <PanelBottom className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          title="Zen mode (⌘⇧Z)"
          onClick={() => setZen((v) => !v)}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-lg transition',
            zen
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/30'
              : 'text-slate-400 hover:bg-white/10 hover:text-white'
          )}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

export interface WorkspaceSidebarRailProps {
  uiPrefs: UiPreferences;
  panel: WorkspacePanelKind | null;
  setPanel: Dispatch<SetStateAction<WorkspacePanelKind | null>>;
  showDockerModal: boolean;
  setShowDockerModal: Dispatch<SetStateAction<boolean>>;
  showDeployModal: boolean;
  setShowDeployModal: Dispatch<SetStateAction<boolean>>;
  setDockerHostId: Dispatch<SetStateAction<string | null>>;
  terminalContext: Tab | undefined | null;
  activePaneId: string | null;
  activeTab: Tab | null;
  openSftpTab: (initialHostId?: string) => void;
  showAI: boolean;
  setShowAI: Dispatch<SetStateAction<boolean>>;
  setShowPairing: Dispatch<SetStateAction<{ initialTab?: 'share' | 'join' | 'devices' } | null>>;
  setShowSync: Dispatch<SetStateAction<boolean>>;
  autoLockMinutes: number;
  setAutoLockMinutes: Dispatch<SetStateAction<number>>;
  showAutoLockMenu: boolean;
  setShowAutoLockMenu: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  lock: () => Promise<void>;
  theme: DrexiusTheme;
}

export function WorkspaceSidebarRail({
  uiPrefs,
  panel,
  setPanel,
  showDockerModal,
  setShowDockerModal,
  showDeployModal,
  setShowDeployModal,
  setDockerHostId,
  terminalContext,
  activePaneId,
  activeTab,
  openSftpTab,
  showAI,
  setShowAI,
  setShowPairing,
  setShowSync,
  autoLockMinutes,
  setAutoLockMinutes,
  showAutoLockMenu,
  setShowAutoLockMenu,
  showSettings,
  setShowSettings,
  lock,
  theme,
}: WorkspaceSidebarRailProps) {
  const rail = [
    {
      id: 'hosts',
      icon: Server,
      label: 'Hosts',
      on: panel === 'hosts',
      act: () => setPanel((p) => (p === 'hosts' ? null : 'hosts')),
    },
    ...(uiPrefs.showKeychain !== false
      ? [
          {
            id: 'keychain',
            icon: KeyRound,
            label: 'Keychain (Identities)',
            on: panel === 'keychain',
            act: () => setPanel((p) => (p === 'keychain' ? null : 'keychain')),
          },
        ]
      : []),
    ...(uiPrefs.showDocker
      ? [
          {
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
          },
        ]
      : []),
    ...(uiPrefs.showTunnels
      ? [
          {
            id: 'tunnels',
            icon: Network,
            label: 'Port Forwarding (Tunnels)',
            on: panel === 'tunnels',
            act: () => setPanel((p) => (p === 'tunnels' ? null : 'tunnels')),
          },
        ]
      : []),
    ...(uiPrefs.showSnippets
      ? [
          {
            id: 'snippets',
            icon: Code2,
            label: 'Snippets',
            on: panel === 'snippets',
            act: () => setPanel((p) => (p === 'snippets' ? null : 'snippets')),
          },
        ]
      : []),
    ...(uiPrefs.showDeploy
      ? [
          {
            id: 'deploy',
            icon: Rocket,
            label: 'Application Deployment (1-Click Release)',
            on: showDeployModal,
            act: () => {
              const activeP = terminalContext?.panes.find((p) => p.id === activePaneId);
              setDockerHostId(activeP?.isLocal ? '__local__' : activeP?.hostId ?? null);
              setShowDeployModal((v) => !v);
            },
          },
        ]
      : []),
    ...(uiPrefs.showHistory !== false
      ? [
          {
            id: 'logs',
            icon: History,
            label: 'Session History & Audit',
            on: panel === 'logs',
            act: () => setPanel((p) => (p === 'logs' ? null : 'logs')),
          },
        ]
      : []),
    ...(uiPrefs.showKnownHosts !== false
      ? [
          {
            id: 'known_hosts',
            icon: ShieldCheck,
            label: 'Known Hosts',
            on: panel === 'known_hosts',
            act: () => setPanel((p) => (p === 'known_hosts' ? null : 'known_hosts')),
          },
        ]
      : []),
    ...(uiPrefs.showSftp
      ? [
          {
            id: 'sftp',
            icon: HardDrive,
            label: 'SFTP (⌘⇧F)',
            on: activeTab?.kind === 'sftp',
            act: () => openSftpTab(),
          },
        ]
      : []),
    ...(uiPrefs.showAi
      ? [
          {
            id: 'ai',
            icon: Sparkles,
            label: 'AI Assistant (⌘⇧A)',
            on: showAI,
            act: () => setShowAI((v) => !v),
          },
        ]
      : []),
  ];

  return (
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
          {r.on && (
            <span className="absolute -left-1.5 h-4 w-1 rounded-r-full bg-gradient-to-b from-cyan-300 to-fuchsia-400" />
          )}
          <r.icon className={cn('h-4 w-4', (r as { iconClass?: string }).iconClass)} />
        </button>
      ))}
      <div className="mt-auto flex flex-col items-center gap-1.5 pb-1">
        {uiPrefs.showPairing !== false && (
          <button
            title="Direct device pairing (QR & PIN LAN sync)"
            onClick={() => setShowPairing({ initialTab: 'share' })}
            className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-amber-400/10 hover:border-amber-400/30 hover:text-amber-200 transition"
          >
            <QrCode className="h-4 w-4" />
          </button>
        )}
        {uiPrefs.showSync !== false && (
          <button
            title="Zero-knowledge sync"
            onClick={() => setShowSync(true)}
            className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-white/[0.08] hover:text-white"
          >
            <Cloud className="h-4 w-4" />
          </button>
        )}
        {/* Auto-lock Settings Button */}
        {uiPrefs.showAutoLock !== false && (
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
              <Timer
                className="h-4 w-4 transition-colors"
                style={showAutoLockMenu ? { color: theme.accent } : undefined}
              />
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
                      className="text-[9px] px-2 py-0.5 rounded-full border border-white/10 bg-white/5 font-mono tracking-normal shadow-sm font-semibold"
                      style={{
                        color: autoLockMinutes > 0 ? theme.accent : '#64748b',
                        backgroundColor: autoLockMinutes > 0 ? `${theme.accent}15` : undefined,
                        borderColor: autoLockMinutes > 0 ? `${theme.accent}30` : undefined,
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
                            try {
                              localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(m));
                            } catch {
                              /* storage unavailable */
                            }
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
        )}
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
        {uiPrefs.showLockVault !== false && (
          <button
            title="Lock vault"
            onClick={lock}
            className="grid h-8 w-8 place-items-center rounded-xl bg-white/[0.04] border border-white/5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-400/30"
          >
            <Lock className="h-4 w-4" />
          </button>
        )}
      </div>
    </nav>
  );
}

export interface WorkspaceSidePanelProps {
  panel: WorkspacePanelKind | null;
  setPanel: Dispatch<SetStateAction<WorkspacePanelKind | null>>;
  closePanel: () => void;
  zen: boolean;
  showRail: boolean;
  theme: DrexiusTheme;
  mobile: boolean;
  mobilePage: MobilePage;
  setMobilePage: Dispatch<SetStateAction<MobilePage>>;
  navigateMobile: (page: MobilePage) => void;
  returnToSettingsTab: SettingsTab | null;
  hosts: Host[];
  vaults: Vault[];
  activeVaultId: string | 'all';
  resumeOrOpenHost: (h: Host) => void;
  openHost: (h: Host) => Promise<void> | void;
  openSftpTab: (initialHostId?: string) => void;
  splitWith: (h: Host, pref?: Layout) => void;
  setModal: Dispatch<SetStateAction<{ host: Host | null } | null>>;
  deleteHost: (h: Host) => Promise<void>;
  openLocalTerminal: () => void;
  setShowSerial: Dispatch<SetStateAction<boolean>>;
  uiPrefs: UiPreferences;
  setShareModal: Dispatch<SetStateAction<{ initialTab?: 'share' | 'import' } | null>>;
  setShowSshConfig: Dispatch<SetStateAction<boolean>>;
  setShowTailscale: Dispatch<SetStateAction<boolean>>;
  setShowNetbird: Dispatch<SetStateAction<boolean>>;
  setShowCloudSync: Dispatch<SetStateAction<boolean>>;
  cloudStatuses: Record<string, CloudInstance>;
  refreshCloudStatuses: (silent?: boolean) => Promise<void>;
  cloudRefreshing: boolean;
  isAndroid: boolean;
  openTermuxPreset: () => Promise<void> | void;
  showDockerModal: boolean;
  setShowDockerModal: Dispatch<SetStateAction<boolean>>;
  setShowDeployModal: Dispatch<SetStateAction<boolean>>;
  hostFabsVisible: boolean;
  setHostFabsVisible: Dispatch<SetStateAction<boolean>>;
  handleQuickConnectSsh: (target: { username: string; hostname: string; port: number }) => void;
  keychain: KeychainItem[];
  tunnels: TunnelConfig[];
  snippets: Snippet[];
  activePaneId: string | null;
  saveSnippet: (s: Snippet) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  unlocked: boolean;
  showSettings: boolean;
  toast: (msg: string) => void;
}

export function WorkspaceSidePanel({
  panel,
  setPanel,
  closePanel,
  zen,
  showRail,
  theme,
  mobile,
  mobilePage,
  setMobilePage,
  navigateMobile,
  returnToSettingsTab,
  hosts,
  vaults,
  activeVaultId,
  resumeOrOpenHost,
  openHost,
  openSftpTab,
  splitWith,
  setModal,
  deleteHost,
  openLocalTerminal,
  setShowSerial,
  uiPrefs,
  setShareModal,
  setShowSshConfig,
  setShowTailscale,
  setShowNetbird,
  setShowCloudSync,
  cloudStatuses,
  refreshCloudStatuses,
  cloudRefreshing,
  isAndroid,
  openTermuxPreset,
  showDockerModal,
  setShowDockerModal,
  setShowDeployModal,
  hostFabsVisible,
  setHostFabsVisible,
  handleQuickConnectSsh,
  keychain,
  tunnels,
  snippets,
  activePaneId,
  saveSnippet,
  deleteSnippet,
  refresh,
  unlocked,
  showSettings,
  toast,
}: WorkspaceSidePanelProps) {
  return (
    <>
      {panel && (
        <>
          <div
            className="max-md:hidden fixed inset-0 z-30 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
            onClick={closePanel}
          />
          <aside
            className="nx-mobile-panel fixed bottom-0 top-10 z-40 w-[340px] border-r border-white/10 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-left-2 duration-150 flex flex-col"
            style={{
              left: zen || !showRail ? 0 : 48,
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
                  onOpenSftp={(h) => {
                    openSftpTab(h.id);
                    setPanel(null);
                  }}
                  onSplit={(h) => {
                    splitWith(h);
                    if (mobile) {
                      setPanel(null);
                      setMobilePage('terminals');
                    }
                  }}
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
                  onClose={() => {
                    if (mobile) navigateMobile('terminals');
                    else setPanel(null);
                  }}
                  theme={theme}
                />
              )}
              {panel === 'keychain' && (
                <KeychainPanel
                  keychain={keychain}
                  activeVaultId={activeVaultId}
                  onSave={async (k) => {
                    await bridge.saveKeychain(k);
                    refresh();
                  }}
                  onDelete={async (id) => {
                    await bridge.deleteKeychain(id);
                    refresh();
                  }}
                  onRefresh={refresh}
                  onClose={closePanel}
                  toast={toast}
                />
              )}
              {panel === 'tunnels' && (
                <PortForwardingPanel
                  hosts={hosts}
                  tunnels={tunnels}
                  onSave={async (t) => {
                    await bridge.saveTunnel(t);
                    refresh();
                  }}
                  onDelete={async (id) => {
                    await bridge.deleteTunnel(id);
                    refresh();
                  }}
                  onClose={closePanel}
                  toast={toast}
                />
              )}
              {panel === 'snippets' && (
                <SnippetsPanel
                  snippets={snippets}
                  activePaneId={activePaneId}
                  onSave={saveSnippet}
                  onDelete={deleteSnippet}
                  onOpenDeploy={() => {
                    setPanel(null);
                    setShowDeployModal(true);
                  }}
                  toast={toast}
                />
              )}
              {panel === 'logs' && <LogsPanel onClose={closePanel} toast={toast} />}
              {panel === 'known_hosts' && <KnownHostsPanel onClose={closePanel} toast={toast} />}
            </div>
          </aside>
        </>
      )}

      {mobile && mobilePage === 'hosts' && panel === 'hosts' && (
        <button
          type="button"
          className={cn(
            'nx-fab',
            hostFabsVisible
              ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
              : 'opacity-0 translate-y-12 scale-90 pointer-events-none'
          )}
          aria-label="Add host"
          onClick={() => setModal({ host: null })}
          style={{
            background: `linear-gradient(145deg, ${theme.accent}, ${theme.accent}c0)`,
            boxShadow: `0 10px 26px -8px ${theme.accent}b0, 0 3px 8px rgb(0 0 0 / .5), inset 0 1px 0 rgb(255 255 255 / .25)`,
          }}
        >
          <Plus size={24} strokeWidth={2.5} />
        </button>
      )}

      {mobile && unlocked && mobilePage === 'hosts' && panel === 'hosts' && !showSettings && uiPrefs.showDocker !== false && (
        <button
          type="button"
          className={cn(
            'nx-docker-fab',
            hostFabsVisible
              ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
              : 'opacity-0 translate-y-12 scale-90 pointer-events-none'
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
          {showDockerModal ? <Loader2 size={22} className="animate-spin" /> : <Boxes size={22} strokeWidth={2} />}
        </button>
      )}
    </>
  );
}
