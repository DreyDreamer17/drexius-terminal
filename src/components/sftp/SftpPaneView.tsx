import React from 'react';
import {
  Folder,
  FileCode,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Trash2,
  Edit2,
  X,
  Loader2,
  Server,
  ArrowRight,
  ArrowLeft,
  ArrowLeftRight,
  Check,
  Laptop,
  CheckSquare,
} from 'lucide-react';
import type { FileEntry, Host } from '../../lib/types';
import { cn } from '../../utils/cn';
import { OsIcon } from '../OsIcon';
import {
  fmtSize,
  fmtDate,
  fmtPerm,
  fmtKind,
  fileIcon,
  type SftpContextMenuState,
  type SftpPromptDialogState,
  type SftpTransferStatus,
} from './sftpHelpers';

export interface SftpPaneViewProps {
  side: 'left' | 'right';
  mobile: boolean;
  mobileSide: 'left' | 'right';
  hostId: string | null;
  host: Host | null;
  hosts: Host[];
  sessionId: string | null;
  connecting: boolean;
  connectingHostId: string | null;
  path: string;
  crumbs: { name: string; fullPath: string }[];
  entries: FileEntry[];
  loading: boolean;
  filter: string;
  setFilter: React.Dispatch<React.SetStateAction<string>>;
  showSearch: boolean;
  setShowSearch: React.Dispatch<React.SetStateAction<boolean>>;
  showHidden: boolean;
  setShowHidden: React.Dispatch<React.SetStateAction<boolean>>;
  selected: Set<string>;
  histIdx: number;
  hist: string[];
  showActions: boolean;
  setShowActions: React.Dispatch<React.SetStateAction<boolean>>;
  transferStatus: SftpTransferStatus | null;
  setFocusedSide: React.Dispatch<React.SetStateAction<'left' | 'right'>>;
  setHostPickerSide: React.Dispatch<React.SetStateAction<'left' | 'right' | null>>;
  setPromptDialog: React.Dispatch<React.SetStateAction<SftpPromptDialogState | null>>;
  setFileActions: React.Dispatch<React.SetStateAction<{ entry: FileEntry; side: 'left' | 'right' } | null>>;
  setContextMenu: React.Dispatch<React.SetStateAction<SftpContextMenuState | null>>;
  connectHost: (side: 'left' | 'right', hostId: string) => Promise<void>;
  disconnectSide: (side: 'left' | 'right') => void;
  handleSwapPanes: () => void;
  loadPane: (
    side: 'left' | 'right',
    targetPath?: string,
    recordHistory?: boolean,
    overrideHostId?: string | null,
    overrideSid?: string | null
  ) => Promise<void>;
  navigateBack: (side: 'left' | 'right') => void;
  navigateForward: (side: 'left' | 'right') => void;
  selectAllInPane: (side: 'left' | 'right') => void;
  clearSelectionInPane: (side: 'left' | 'right') => void;
  handleTransfer: (entry: FileEntry, fromSide: 'left' | 'right') => Promise<void>;
  handleTransferBatch: (items: FileEntry[], fromSide: 'left' | 'right') => Promise<void>;
  requestDelete: (entry: FileEntry, side: 'left' | 'right') => void;
  requestDeleteBatch: (entriesToDelete: FileEntry[], side: 'left' | 'right') => void;
  handleOpenFile: (entry: FileEntry, side: 'left' | 'right') => Promise<void>;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent, targetSide: 'left' | 'right') => Promise<void>;
  handleDragStart: (e: React.DragEvent, entry: FileEntry, side: 'left' | 'right', visibleEntries: FileEntry[]) => void;
  handleRowTouchStart: (e: React.TouchEvent, entry: FileEntry, side: 'left' | 'right') => void;
  handleRowTouchMove: (e: React.TouchEvent) => void;
  handleRowTouchEnd: (e: React.TouchEvent) => void;
  handleRowClick: (e: React.MouseEvent, entry: FileEntry, side: 'left' | 'right', visibleEntries: FileEntry[]) => void;
  handleRowContextMenu: (
    e: React.MouseEvent,
    entry: FileEntry,
    side: 'left' | 'right',
    visibleEntries: FileEntry[]
  ) => void;
  handlePaneContextMenu: (e: React.MouseEvent, side: 'left' | 'right', visibleEntries: FileEntry[]) => void;
}

export function SftpPaneView({
  side,
  mobile,
  mobileSide,
  hostId,
  host,
  hosts,
  sessionId,
  connecting,
  connectingHostId,
  path,
  crumbs,
  entries,
  loading,
  filter,
  setFilter,
  showSearch,
  setShowSearch,
  showHidden,
  setShowHidden,
  selected,
  histIdx,
  hist,
  showActions,
  setShowActions,
  transferStatus,
  setFocusedSide,
  setHostPickerSide,
  setPromptDialog,
  setFileActions,
  setContextMenu,
  connectHost,
  disconnectSide,
  handleSwapPanes,
  loadPane,
  navigateBack,
  navigateForward,
  selectAllInPane,
  clearSelectionInPane,
  handleTransfer,
  handleTransferBatch,
  requestDelete,
  requestDeleteBatch,
  handleOpenFile,
  handleDragOver,
  handleDrop,
  handleDragStart,
  handleRowTouchStart,
  handleRowTouchMove,
  handleRowTouchEnd,
  handleRowClick,
  handleRowContextMenu,
  handlePaneContextMenu,
}: SftpPaneViewProps) {
  const isLeft = side === 'left';
  const isDisconnectedRemote = hostId !== null && !sessionId && !connecting;
  const selectedEntriesInPane = entries.filter((it) => selected.has(it.path));
  const isAndroidStorage = !hostId && path.startsWith('/storage/emulated/0');
  const rootPath = isAndroidStorage ? '/storage/emulated/0' : '/';
  const rootLabel = isAndroidStorage ? 'Internal Storage' : '/';

  return (
    <div
      key={side}
      className={cn('flex flex-1 min-w-0 flex-col bg-transparent relative', mobileSide !== side && 'max-md:hidden')}
      role="region"
      aria-label={`${isLeft ? 'Left' : 'Right'} pane files`}
      onMouseDown={() => setFocusedSide(side)}
      onDragOver={handleDragOver}
      onDrop={(e) => handleDrop(e, side)}
    >
      {connecting ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400 mb-3" />
          <h3 className="text-sm font-semibold text-slate-200">
            Connecting to {hosts.find((h) => h.id === connectingHostId)?.label || host?.label || 'Host'}...
          </h3>
          <p className="text-xs text-slate-500 mt-1">Authenticating and establishing SFTP session</p>
        </div>
      ) : isDisconnectedRemote ? (
        /* ── DISCONNECTED REMOTE PLACEHOLDER ── */
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/[0.05] border border-white/10 shadow-xl mb-4">
            <Folder className="h-8 w-8 text-slate-300" />
          </div>

          <h2 className="text-base font-semibold text-slate-100 mb-1">Connect to {host?.label || 'host'}</h2>
          <p className="max-w-xs text-xs text-slate-400 leading-relaxed mb-6">
            Start by connecting to manage your files with SFTP.
          </p>

          <div className="flex items-center gap-2">
            <button
              onClick={() => connectHost(side, hostId)}
              className="flex items-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white px-5 py-2.5 text-xs font-semibold shadow-lg transition cursor-pointer"
            >
              <span>Connect</span>
            </button>
            <button
              onClick={() => setHostPickerSide(side)}
              className="flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700/90 text-slate-100 px-4 py-2.5 text-xs font-medium border border-white/10 transition cursor-pointer"
            >
              <span>Switch Host</span>
            </button>
          </div>
        </div>
      ) : (
        /* ── ACTIVE BROWSER (LOCAL OR CONNECTED REMOTE) ── */
        <>
          {/* Header Toolbar */}
          <div className="nx-sftp-toolbar flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] px-4">
            <div className="flex items-center gap-2 min-w-0">
              {/* Source Picker Pill Dropdown */}
              <button
                onClick={() => setHostPickerSide(side)}
                className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 -ml-1 text-slate-100 hover:bg-white/[0.07] border border-white/5 hover:border-white/15 transition group cursor-pointer"
                title={`Switch source for ${side} pane`}
              >
                <div className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-400/30 shrink-0">
                  {host ? <OsIcon os={host.os} color={host.color} size={22} /> : <Laptop className="h-4 w-4" />}
                </div>
                <span className="font-semibold text-slate-100 text-sm truncate max-w-[120px] sm:max-w-[170px]">
                  {host?.label || 'Local Machine'}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400 group-hover:text-slate-200 transition-transform group-hover:translate-y-0.5 shrink-0" />
              </button>

              {/* Swap Button on Left Pane Toolbar */}
              {isLeft && (
                <button
                  onClick={handleSwapPanes}
                  title="Swap left and right panes"
                  className="hidden md:flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-slate-400 hover:bg-white/[0.08] hover:text-white border border-white/5 transition ml-1"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 text-cyan-400" />
                  <span className="text-[11px] font-medium">Swap</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {showSearch ? (
                <div className="relative flex items-center">
                  <Search className="absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter..."
                    autoFocus
                    className="h-7 w-36 rounded-lg bg-white/[0.06] pl-8 pr-6 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
                  />
                  {filter && (
                    <button onClick={() => setFilter('')} className="absolute right-2 text-slate-400 hover:text-white">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setShowSearch(true)}
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span>Filter</span>
                </button>
              )}

              {/* Quick New File Button */}
              <button
                title={`New File on ${host?.label || 'Local'}`}
                onClick={() =>
                  setPromptDialog({
                    type: 'newFile',
                    side,
                    title: `New File (${host?.label || 'Local'})`,
                    currentVal: 'new-file.txt',
                  })
                }
                className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
              >
                <FilePlus className="h-3.5 w-3.5 text-cyan-400" />
                <span className="hidden xl:inline">New File</span>
              </button>

              {/* Quick New Folder Button */}
              <button
                title={`New Folder on ${host?.label || 'Local'}`}
                onClick={() =>
                  setPromptDialog({
                    type: 'newFolder',
                    side,
                    title: `New Folder (${host?.label || 'Local'})`,
                    currentVal: 'new-folder',
                  })
                }
                className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
              >
                <FolderPlus className="h-3.5 w-3.5 text-sky-400" />
                <span className="hidden xl:inline">New Folder</span>
              </button>

              {/* Actions Dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowActions((v) => !v)}
                  className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white border border-white/5 transition"
                >
                  <span>Actions</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
                {showActions && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setShowActions(false)} />
                    <div className="absolute right-0 top-8 z-40 w-48 rounded-xl border border-white/10 bg-[#0e131d] p-1 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100">
                      <button
                        onClick={() => {
                          setShowActions(false);
                          setPromptDialog({
                            type: 'newFile',
                            side,
                            title: `New File (${host?.label || 'Local'})`,
                            currentVal: 'new-file.txt',
                          });
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <FilePlus className="h-3.5 w-3.5 text-cyan-400" />
                        <span>New File</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowActions(false);
                          setPromptDialog({
                            type: 'newFolder',
                            side,
                            title: `New Folder (${host?.label || 'Local'})`,
                            currentVal: 'new-folder',
                          });
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <FolderPlus className="h-3.5 w-3.5 text-sky-400" />
                        <span>New Folder</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowActions(false);
                          loadPane(side, path, false);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <RefreshCw className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Refresh</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowActions(false);
                          if (selected.size > 0) {
                            clearSelectionInPane(side);
                          } else {
                            selectAllInPane(side);
                          }
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <div className="flex items-center gap-2">
                          <CheckSquare className="h-3.5 w-3.5 text-cyan-400" />
                          <span>{selected.size > 0 ? 'Clear Selection' : 'Select All / Multi-Select'}</span>
                        </div>
                        {selected.size > 0 && (
                          <span className="font-mono text-[10px] text-cyan-300">{selected.size}</span>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setShowActions(false);
                          setHostPickerSide(side);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <Server className="h-3.5 w-3.5 text-amber-400" />
                        <span>Switch Source</span>
                      </button>
                      <div className="my-1 h-[1px] bg-white/10" />
                      <button
                        onClick={() => {
                          setShowActions(false);
                          setShowHidden((v) => !v);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <span>Show Hidden</span>
                        {showHidden && <Check className="h-3 w-3 text-cyan-400" />}
                      </button>
                      {hostId !== null && (
                        <>
                          <div className="my-1 h-[1px] bg-white/10" />
                          <button
                            onClick={() => {
                              setShowActions(false);
                              disconnectSide(side);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-rose-400 hover:bg-rose-500/15"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>Disconnect</span>
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Breadcrumbs Bar & In-Flow Selection Bar (Never covers files) */}
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-black/10 px-3 text-xs">
            {mobile && selectedEntriesInPane.length > 0 ? (
              /* Mobile In-Flow Selection Bar (replaces breadcrumbs while selecting, covers 0 files) */
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => clearSelectionInPane(side)}
                    className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.08] text-slate-300 hover:text-white transition shrink-0"
                    title="Exit selection mode"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-semibold text-xs text-cyan-300 truncate">
                    {selectedEntriesInPane.length} selected
                  </span>
                  <button
                    onClick={() => {
                      if (selected.size === entries.length) {
                        clearSelectionInPane(side);
                      } else {
                        selectAllInPane(side);
                      }
                    }}
                    className="rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 transition shrink-0"
                  >
                    {selected.size === entries.length ? 'None' : 'All'}
                  </button>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    disabled={!!transferStatus}
                    onClick={() => handleTransferBatch(selectedEntriesInPane, side)}
                    className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40 transition"
                  >
                    {isLeft ? <ArrowRight className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />}
                    <span>Transfer</span>
                  </button>
                  <button
                    onClick={() => requestDeleteBatch(selectedEntriesInPane, side)}
                    className="flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/20 px-2 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/30 transition"
                    title="Delete selected"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      disabled={histIdx <= 0}
                      onClick={() => navigateBack(side)}
                      className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      disabled={histIdx >= hist.length - 1}
                      onClick={() => navigateForward(side)}
                      className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pl-1 text-slate-300">
                    <button
                      onClick={() => loadPane(side, rootPath)}
                      className={cn(
                        'flex items-center gap-1 rounded px-1.5 py-0.5 transition shrink-0',
                        crumbs.length === 0
                          ? 'text-slate-100 bg-white/[0.05] font-medium'
                          : 'text-slate-400 hover:bg-white/[0.06] hover:text-white'
                      )}
                    >
                      <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                      <span className={cn(isAndroidStorage ? 'text-xs' : 'font-mono text-[11px]')}>{rootLabel}</span>
                    </button>
                    {crumbs.map((crumb, idx) => (
                      <div key={crumb.fullPath} className="flex items-center gap-1 shrink-0">
                        <ChevronRight className="h-3 w-3 text-slate-600 shrink-0" />
                        <button
                          onClick={() => loadPane(side, crumb.fullPath)}
                          className={cn(
                            'flex items-center gap-1.5 rounded px-1.5 py-0.5 transition font-medium',
                            idx === crumbs.length - 1
                              ? 'text-slate-100 bg-white/[0.05]'
                              : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
                          )}
                        >
                          <Folder className="h-3.5 w-3.5 text-sky-400" />
                          <span>{crumb.name}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedEntriesInPane.length > 0 && (
                  <div className="flex items-center gap-1 shrink-0 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">
                    <span className="font-medium pr-1">{selectedEntriesInPane.length} selected</span>
                    <button
                      title={isLeft ? 'Transfer selected to Right Pane' : 'Transfer selected to Left Pane'}
                      disabled={!!transferStatus}
                      onClick={() => handleTransferBatch(selectedEntriesInPane, side)}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 transition cursor-pointer"
                    >
                      {isLeft ? <ArrowRight className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />}
                      <span className="hidden sm:inline">Transfer</span>
                    </button>
                    <button
                      title="Delete selected"
                      onClick={() => requestDeleteBatch(selectedEntriesInPane, side)}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 transition cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span className="hidden sm:inline">Delete</span>
                    </button>
                    <button
                      title="Clear selection (Esc)"
                      onClick={() => clearSelectionInPane(side)}
                      className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Table Header */}
          <div className="flex h-8 shrink-0 items-center border-b border-white/[0.06] bg-black/20 px-4 text-[11px] font-medium text-slate-400">
            <div className="flex-1 min-w-0">Name</div>
            <div className="w-44 text-left hidden md:block">Date Modified</div>
            <div className="w-24 text-left hidden md:block">Size</div>
            <div className="w-20 text-left hidden lg:block">Kind</div>
          </div>

          {/* File List */}
          <div
            className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/[0.03]"
            onContextMenu={(e) => handlePaneContextMenu(e, side, entries)}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                clearSelectionInPane(side);
                setContextMenu(null);
              }
            }}
          >
            {loading && (
              <div className="flex items-center justify-center py-12 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin mr-2 text-cyan-400" />
                <span>Loading files...</span>
              </div>
            )}

            {!loading && path !== rootPath && path !== '/' && (
              <div
                onClick={() => {
                  const parentP = path.replace(/\/[^/]+\/?$/, '') || rootPath;
                  if (mobile) loadPane(side, parentP);
                }}
                onDoubleClick={() => {
                  const parentP = path.replace(/\/[^/]+\/?$/, '') || rootPath;
                  loadPane(side, parentP);
                }}
                className="flex h-11 items-center px-4 hover:bg-white/[0.04] cursor-pointer text-slate-300 transition group"
              >
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <Folder className="h-4 w-4 text-sky-400" />
                  <span className="font-medium text-sm">..</span>
                </div>
                <div className="w-44 text-slate-500 text-xs hidden md:block">- -</div>
                <div className="w-24 text-slate-500 text-xs hidden md:block">- -</div>
                <div className="w-20 text-slate-500 text-xs hidden lg:block">folder</div>
              </div>
            )}

            {!loading &&
              entries.map((entry) => {
                const isSelected = selected.has(entry.path);
                const Icon = fileIcon(entry);
                const inSelectionMode = mobile && selected.size > 0;
                return (
                  <div
                    key={entry.path}
                    draggable={!mobile}
                    onDragStart={(e) => handleDragStart(e, entry, side, entries)}
                    onTouchStart={(e) => handleRowTouchStart(e, entry, side)}
                    onTouchMove={handleRowTouchMove}
                    onTouchEnd={handleRowTouchEnd}
                    onTouchCancel={handleRowTouchEnd}
                    onClick={(e) => handleRowClick(e, entry, side, entries)}
                    onContextMenu={(e) => handleRowContextMenu(e, entry, side, entries)}
                    onDoubleClick={() => {
                      if (mobile) return;
                      if (entry.isDir) {
                        loadPane(side, entry.path);
                      } else {
                        handleOpenFile(entry, side);
                      }
                    }}
                    className={cn(
                      'flex h-12 items-center px-4 cursor-pointer transition select-none group',
                      isSelected
                        ? 'bg-cyan-500/15 border-l-2 border-cyan-400'
                        : 'hover:bg-white/[0.04] border-l-2 border-transparent'
                    )}
                  >
                    {/* Mobile Selection Checkbox Indicator */}
                    {inSelectionMode && (
                      <div
                        className={cn(
                          'mr-3 grid h-5 w-5 place-items-center rounded-full border transition shrink-0',
                          isSelected
                            ? 'bg-cyan-400 border-cyan-300 text-slate-950 shadow-sm shadow-cyan-400/40'
                            : 'border-white/25 bg-white/5'
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                      </div>
                    )}

                    {/* Name + Permissions */}
                    <div className="flex items-center gap-3 flex-1 min-w-0 pr-3">
                      <Icon className={cn('h-4 w-4 shrink-0', entry.isDir ? 'text-sky-400' : 'text-slate-400')} />
                      <div className="flex flex-col min-w-0">
                        <span className="truncate text-xs font-normal text-slate-200 group-hover:text-white">
                          {entry.name}
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">
                          {fmtPerm(entry.permissions, entry.isDir)}
                        </span>
                      </div>
                    </div>

                    {/* Date Modified */}
                    <div className="w-44 text-slate-400 text-xs hidden md:block truncate">
                      {fmtDate(entry.modified)}
                    </div>

                    {/* Size */}
                    <div className="w-24 text-slate-400 text-xs hidden md:block font-mono text-[11px]">
                      {entry.isDir ? '- -' : fmtSize(entry.size)}
                    </div>

                    {/* Kind */}
                    <div className="w-20 text-slate-400 text-xs hidden lg:block">{fmtKind(entry)}</div>

                    {/* Quick Row Actions on Hover/Select (hidden on mobile when in multi-selection mode) */}
                    {!inSelectionMode && (
                      <button
                        className="nx-touch-button md:hidden"
                        aria-label={`Actions for ${entry.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFileActions({ entry, side });
                        }}
                      >
                        •••
                      </button>
                    )}

                    <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                      {/* Transfer file or folder to the other pane */}
                      <button
                        title={isLeft ? 'Transfer to Right Pane' : 'Transfer to Left Pane'}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTransfer(entry, side);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-emerald-500/20 hover:text-emerald-300"
                      >
                        {isLeft ? <ArrowRight className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />}
                      </button>
                      {!entry.isDir && (
                        <button
                          title="Edit File"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenFile(entry, side);
                          }}
                          className="rounded p-1 text-slate-400 hover:bg-cyan-500/20 hover:text-cyan-300"
                        >
                          <FileCode className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPromptDialog({
                            type: 'rename',
                            side,
                            title: `Rename ${entry.name}`,
                            currentVal: entry.name,
                            targetPath: entry.path,
                          });
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          requestDelete(entry, side);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}

            {!loading && !entries.length && (
              <div className="py-16 text-center text-xs text-slate-500">
                {filter ? 'No files match filter' : 'Empty directory'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
