import React from 'react';
import {
  Folder,
  FileText,
  FileCode,
  Search,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Trash2,
  AlertTriangle,
  Edit2,
  X,
  Loader2,
  Server,
  ArrowRight,
  ArrowLeft,
  Laptop,
  HardDrive,
  ShieldCheck,
  Copy,
  CheckSquare,
  FolderOpen,
} from 'lucide-react';
import type { FileEntry, Host } from '../../lib/types';
import type { DrexiusTheme } from '../../lib/themes';
import { cn } from '../../utils/cn';
import { OsIcon } from '../OsIcon';
import { MobileSheet } from '../MobileSheet';
import {
  fmtSize,
  fmtDate,
  fmtPerm,
  type SftpContextMenuState,
  type SftpDeleteConfirmState,
  type SftpPromptDialogState,
  type SftpTransferStatus,
} from './sftpHelpers';

export function SftpTransferBanner({
  transferStatus,
  handleCancelTransfer,
}: {
  transferStatus: SftpTransferStatus | null;
  handleCancelTransfer: () => void;
}) {
  if (!transferStatus) return null;
  return (
    <div className="absolute top-3 right-6 z-50 flex items-center gap-3 rounded-xl border border-cyan-500/40 bg-slate-900/95 px-4 py-2.5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150">
      <Loader2 className="h-4 w-4 animate-spin text-cyan-400 shrink-0" />
      <div className="flex flex-col text-xs">
        <span className="font-medium text-slate-100 max-w-[200px] sm:max-w-xs truncate">
          {transferStatus.type === 'upload' ? 'Transferring' : 'Downloading'} {transferStatus.filename}
        </span>
        <div className="mt-1 h-1.5 w-40 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-150"
            style={{ width: `${Math.round(transferStatus.progress * 100)}%` }}
          />
        </div>
      </div>
      <span className="font-mono text-[11px] text-cyan-300 shrink-0">
        {Math.round(transferStatus.progress * 100)}%
      </span>
      <button
        type="button"
        onClick={handleCancelTransfer}
        title="Cancel transfer"
        aria-label="Cancel transfer"
        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function SftpMobileActionSheets({
  mobile,
  active,
  fileActions,
  setFileActions,
  permissions,
  setPermissions,
  leftHost,
  rightHost,
  activeTheme,
  transferStatus,
  loadPane,
  handleOpenFile,
  handleTransfer,
  setPromptDialog,
  setLeftSelected,
  setRightSelected,
  setFocusedSide,
  requestDelete,
}: {
  mobile: boolean;
  active: boolean;
  fileActions: { entry: FileEntry; side: 'left' | 'right' } | null;
  setFileActions: React.Dispatch<React.SetStateAction<{ entry: FileEntry; side: 'left' | 'right' } | null>>;
  permissions: FileEntry | null;
  setPermissions: React.Dispatch<React.SetStateAction<FileEntry | null>>;
  leftHost: Host | null;
  rightHost: Host | null;
  activeTheme: DrexiusTheme;
  transferStatus: SftpTransferStatus | null;
  loadPane: (side: 'left' | 'right', targetPath?: string) => Promise<void>;
  handleOpenFile: (entry: FileEntry, side: 'left' | 'right') => Promise<void>;
  handleTransfer: (entry: FileEntry, fromSide: 'left' | 'right') => Promise<void>;
  setPromptDialog: React.Dispatch<React.SetStateAction<SftpPromptDialogState | null>>;
  setLeftSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setRightSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setFocusedSide: React.Dispatch<React.SetStateAction<'left' | 'right'>>;
  requestDelete: (entry: FileEntry, side: 'left' | 'right') => void;
}) {
  if (!mobile || !active) return null;
  return (
    <>
      {fileActions && (
        <MobileSheet
          title={fileActions.entry.name}
          kicker={fileActions.entry.isDir ? 'Folder' : 'File'}
          subtitle={fileActions.side === 'left' ? leftHost?.label || 'Local' : rightHost?.label || 'Right'}
          icon={fileActions.entry.isDir ? Folder : FileCode}
          theme={activeTheme}
          onClose={() => setFileActions(null)}
        >
          <p className="mb-3 break-all font-mono text-[11px] leading-relaxed text-slate-500">
            {fileActions.entry.path}
          </p>
          <div className="nx-settings-group">
            {fileActions.entry.isDir ? (
              <button
                className="nx-settings-row"
                onClick={() => {
                  loadPane(fileActions.side, fileActions.entry.path);
                  setFileActions(null);
                }}
              >
                <Folder size={18} /> Open folder
              </button>
            ) : (
              <button
                className="nx-settings-row"
                onClick={() => {
                  handleOpenFile(fileActions.entry, fileActions.side);
                  setFileActions(null);
                }}
              >
                <FileCode size={18} /> Edit
              </button>
            )}
            <button
              className="nx-settings-row"
              disabled={!!transferStatus}
              onClick={() => {
                handleTransfer(fileActions.entry, fileActions.side);
                setFileActions(null);
              }}
            >
              <ArrowRight size={18} /> Transfer to other pane
            </button>
            <button
              className="nx-settings-row"
              onClick={() => {
                setPromptDialog({
                  type: 'rename',
                  side: fileActions.side,
                  title: `Rename ${fileActions.entry.name}`,
                  currentVal: fileActions.entry.name,
                  targetPath: fileActions.entry.path,
                });
                setFileActions(null);
              }}
            >
              <Edit2 size={18} /> Rename
            </button>
            <button
              className="nx-settings-row"
              onClick={() => {
                const isLeft = fileActions.side === 'left';
                const setSelected = isLeft ? setLeftSelected : setRightSelected;
                setSelected((prev) => {
                  const next = new Set(prev);
                  next.add(fileActions.entry.path);
                  return next;
                });
                setFocusedSide(fileActions.side);
                setFileActions(null);
              }}
            >
              <CheckSquare size={18} /> Select items…
            </button>
            <button
              className="nx-settings-row"
              onClick={() => {
                setPermissions(fileActions.entry);
                setFileActions(null);
              }}
            >
              <ShieldCheck size={18} /> Permissions
            </button>
            <button
              className="nx-settings-row text-rose-300"
              onClick={() => {
                requestDelete(fileActions.entry, fileActions.side);
                setFileActions(null);
              }}
            >
              <Trash2 size={18} /> Delete…
            </button>
          </div>
        </MobileSheet>
      )}

      {permissions && (
        <MobileSheet
          title="File permissions"
          subtitle={permissions.name}
          icon={ShieldCheck}
          theme={activeTheme}
          onClose={() => setPermissions(null)}
        >
          <p
            className="my-1 rounded-xl border border-white/[0.06] bg-black/30 p-4 font-mono text-lg"
            style={{ color: activeTheme.accent }}
          >
            {permissions.permissions == null
              ? 'Not reported'
              : `${fmtPerm(permissions.permissions, permissions.isDir)} · ${(permissions.permissions & 0o7777)
                  .toString(8)
                  .padStart(3, '0')}`}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            Read-only metadata. Permission changes are not exposed by the file API; use your terminal to change the
            mode.
          </p>
        </MobileSheet>
      )}
    </>
  );
}

export function SftpHostPickerModal({
  hostPickerSide,
  setHostPickerSide,
  hostPickerSearch,
  setHostPickerSearch,
  connectingHostId,
  connectingSide,
  hosts,
  filteredHosts,
  leftHostId,
  rightHostId,
  bgColor,
  accentColor,
  switchToLocal,
  connectHost,
}: {
  hostPickerSide: 'left' | 'right' | null;
  setHostPickerSide: React.Dispatch<React.SetStateAction<'left' | 'right' | null>>;
  hostPickerSearch: string;
  setHostPickerSearch: React.Dispatch<React.SetStateAction<string>>;
  connectingHostId: string | null;
  connectingSide: 'left' | 'right' | null;
  hosts: Host[];
  filteredHosts: Host[];
  leftHostId: string | null;
  rightHostId: string | null;
  bgColor: string;
  accentColor: string;
  switchToLocal: (side: 'left' | 'right') => Promise<void>;
  connectHost: (side: 'left' | 'right', hostId: string) => Promise<void>;
}) {
  if (!hostPickerSide) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="fixed inset-0"
        onClick={() => {
          if (connectingHostId) return;
          setHostPickerSide(null);
        }}
      />
      <div
        className="relative flex flex-col w-full max-w-lg max-h-[85vh] rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{
          backgroundColor: bgColor,
          boxShadow: `0 0 35px ${accentColor}18, 0 20px 45px rgba(0, 0, 0, 0.75)`,
        }}
      >
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-44 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />
        {/* Top glowing line */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-75"
          style={{ background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)` }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4 shrink-0 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-2xl border transition shadow-lg shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <HardDrive className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">
                Select Source for {hostPickerSide === 'left' ? 'Left' : 'Right'} Pane
              </h3>
              <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                {connectingHostId ? (
                  <span className="flex items-center gap-1.5 text-cyan-400 font-medium">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Connecting to {hosts.find((h) => h.id === connectingHostId)?.label || 'host'}…
                  </span>
                ) : (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    Choose Local Machine or any saved SFTP Host
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              if (connectingHostId) return;
              setHostPickerSide(null);
            }}
            disabled={!!connectingHostId}
            className={cn(
              'rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition',
              connectingHostId && 'opacity-40 cursor-not-allowed'
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search Input */}
        <div className="relative p-3.5 border-b border-white/5 bg-black/20 shrink-0">
          <div className="relative flex items-center">
            <Search className="absolute left-3.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={hostPickerSearch}
              onChange={(e) => setHostPickerSearch(e.target.value)}
              disabled={!!connectingHostId}
              placeholder="Search by label, host, username or tag..."
              className={cn(
                'h-9 w-full rounded-xl bg-white/[0.05] pl-10 pr-4 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:outline-none focus:ring-1 transition',
                connectingHostId && 'opacity-50 cursor-not-allowed'
              )}
              style={{
                borderColor: hostPickerSearch ? `${accentColor}50` : undefined,
              }}
            />
          </div>
        </div>

        {/* Source & Hosts List */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {/* Option 1: Local Machine */}
          {(!hostPickerSearch || 'local machine this computer'.includes(hostPickerSearch.toLowerCase())) && (
            <div
              onClick={() => {
                if (connectingHostId) return;
                switchToLocal(hostPickerSide);
              }}
              className={cn(
                'group flex items-center justify-between rounded-xl p-3 border transition shadow-sm cursor-pointer',
                (hostPickerSide === 'left' ? !leftHostId : !rightHostId)
                  ? 'bg-cyan-500/15 border-cyan-500/50 ring-1 ring-cyan-500/30 shadow-lg shadow-cyan-500/10'
                  : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/5 hover:border-white/15'
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-400/30 shrink-0">
                  <Laptop className="h-5 w-5" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-semibold text-xs text-slate-100 group-hover:text-white truncate">
                    Local Machine (This Computer)
                  </span>
                  <span className="text-[11px] font-mono text-slate-400 truncate">
                    Browse and transfer files from your local storage
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="rounded-md bg-cyan-500/20 border border-cyan-500/30 px-2 py-0.5 text-[10px] text-cyan-300 font-mono">
                  LOCAL
                </span>
                {(hostPickerSide === 'left' ? !leftHostId : !rightHostId) ? (
                  <span className="rounded-full bg-cyan-400/20 px-2 py-0.5 text-[10px] text-cyan-300 font-medium border border-cyan-400/30">
                    Active
                  </span>
                ) : (
                  <div
                    className="grid h-8 w-8 place-items-center rounded-xl border transition shadow-sm group-hover:translate-x-0.5"
                    style={{
                      backgroundColor: `${accentColor}18`,
                      borderColor: `${accentColor}35`,
                      color: accentColor,
                      boxShadow: `0 0 12px ${accentColor}15`,
                    }}
                  >
                    <ArrowRight className="h-4 w-4 transition-transform" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Saved Hosts Section Header */}
          <div className="flex items-center gap-2 px-1 pt-2 pb-1 text-[11px] font-medium text-slate-400 uppercase tracking-wider">
            <Server className="h-3 w-3 text-slate-500" />
            <span>Saved Remote SFTP Hosts</span>
          </div>

          {/* Option 2: Remote Hosts List */}
          {filteredHosts.map((h) => {
            const isConnectingThis = connectingHostId === h.id && connectingSide === hostPickerSide;
            const isConnectingAny = connectingHostId !== null;
            const isActiveOnThisSide = (hostPickerSide === 'left' ? leftHostId : rightHostId) === h.id;

            return (
              <div
                key={h.id}
                onClick={() => {
                  if (isConnectingAny) return;
                  connectHost(hostPickerSide, h.id);
                }}
                className={cn(
                  'group flex items-center justify-between rounded-xl p-3 border transition shadow-sm',
                  isConnectingThis
                    ? 'bg-cyan-500/15 border-cyan-500/50 ring-1 ring-cyan-500/30 cursor-wait shadow-lg shadow-cyan-500/10'
                    : isActiveOnThisSide
                    ? 'bg-cyan-500/15 border-cyan-500/40 ring-1 ring-cyan-500/30'
                    : isConnectingAny
                    ? 'bg-white/[0.02] border-white/5 opacity-40 cursor-not-allowed pointer-events-none'
                    : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/5 hover:border-white/15 cursor-pointer'
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <OsIcon os={h.os} color={h.color || accentColor} size={34} />
                  <div className="flex flex-col min-w-0">
                    <span className="font-semibold text-xs text-slate-100 group-hover:text-white truncate">
                      {h.label}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400 truncate">
                      {h.username}@{h.hostname}
                      {h.port !== 22 ? `:${h.port}` : ''}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {h.tags?.map((t) => (
                    <span
                      key={t}
                      className="rounded-md bg-white/[0.06] border border-white/5 px-1.5 py-0.5 text-[9px] text-slate-400 font-mono"
                    >
                      {t}
                    </span>
                  ))}
                  {isConnectingThis ? (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-xs font-medium animate-pulse shadow-sm">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Connecting…</span>
                    </div>
                  ) : isActiveOnThisSide ? (
                    <span className="rounded-full bg-cyan-400/20 px-2 py-0.5 text-[10px] text-cyan-300 font-medium border border-cyan-400/30">
                      Active
                    </span>
                  ) : (
                    <div
                      className={cn(
                        'grid h-8 w-8 place-items-center rounded-xl border transition shadow-sm',
                        isConnectingAny ? 'opacity-30' : 'group-hover:translate-x-0.5'
                      )}
                      style={{
                        backgroundColor: `${accentColor}18`,
                        borderColor: `${accentColor}35`,
                        color: accentColor,
                        boxShadow: `0 0 12px ${accentColor}15`,
                      }}
                    >
                      <ArrowRight className="h-4 w-4 transition-transform" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {!filteredHosts.length && (
            <div className="py-12 text-center text-xs text-slate-500">
              {hostPickerSearch ? 'No hosts match your search' : 'No saved hosts found in vault'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SftpPromptModal({
  promptDialog,
  setPromptDialog,
  bgColor,
  accentColor,
  handlePromptSubmit,
}: {
  promptDialog: SftpPromptDialogState | null;
  setPromptDialog: React.Dispatch<React.SetStateAction<SftpPromptDialogState | null>>;
  bgColor: string;
  accentColor: string;
  handlePromptSubmit: (val: string) => Promise<void>;
}) {
  if (!promptDialog) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="fixed inset-0" onClick={() => setPromptDialog(null)} />
      <div
        className="relative w-full max-w-sm rounded-2xl border border-white/10 p-5 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{
          backgroundColor: bgColor,
          boxShadow: `0 0 35px ${accentColor}18, 0 20px 45px rgba(0, 0, 0, 0.75)`,
        }}
      >
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />
        {/* Top glowing line */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-75"
          style={{ background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)` }}
        />

        <div className="relative flex items-center gap-3 mb-4">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl border transition shadow-md shrink-0"
            style={{
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}35`,
              color: accentColor,
              boxShadow: `0 0 16px ${accentColor}20`,
            }}
          >
            {promptDialog.type === 'newFile' ? (
              <FilePlus className="h-4 w-4" />
            ) : promptDialog.type === 'newFolder' ? (
              <FolderPlus className="h-4 w-4" />
            ) : (
              <Edit2 className="h-4 w-4" />
            )}
          </div>
          <h3 className="font-semibold text-sm text-slate-100">{promptDialog.title}</h3>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const input = form.elements.namedItem('val') as HTMLInputElement;
            handlePromptSubmit(input.value);
          }}
          className="relative"
        >
          <input
            name="val"
            defaultValue={promptDialog.currentVal}
            autoFocus
            className="h-9 w-full rounded-xl bg-white/[0.05] px-3 text-xs text-slate-200 border border-white/10 focus:outline-none focus:ring-1 transition"
            style={{
              borderColor: `${accentColor}40`,
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPromptDialog(null)}
              className="rounded-xl px-3.5 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-xl border px-4 py-1.5 text-xs font-semibold transition shadow-sm cursor-pointer"
              style={{
                backgroundColor: `${accentColor}25`,
                borderColor: `${accentColor}50`,
                color: accentColor,
                boxShadow: `0 0 12px ${accentColor}20`,
              }}
            >
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SftpDesktopContextMenu({
  mobile,
  contextMenu,
  setContextMenu,
  leftHost,
  rightHost,
  leftPath,
  rightPath,
  accentColor,
  transferStatus,
  loadPane,
  handleOpenFile,
  handleTransferBatch,
  setPromptDialog,
  copyPathsToClipboard,
  setPermissions,
  requestDeleteBatch,
  selectAllInPane,
}: {
  mobile: boolean;
  contextMenu: SftpContextMenuState | null;
  setContextMenu: React.Dispatch<React.SetStateAction<SftpContextMenuState | null>>;
  leftHost: Host | null;
  rightHost: Host | null;
  leftPath: string;
  rightPath: string;
  accentColor: string;
  transferStatus: SftpTransferStatus | null;
  loadPane: (side: 'left' | 'right', targetPath?: string, recordHistory?: boolean) => Promise<void>;
  handleOpenFile: (entry: FileEntry, side: 'left' | 'right') => Promise<void>;
  handleTransferBatch: (items: FileEntry[], fromSide: 'left' | 'right') => Promise<void>;
  setPromptDialog: React.Dispatch<React.SetStateAction<SftpPromptDialogState | null>>;
  copyPathsToClipboard: (items: FileEntry[]) => Promise<void>;
  setPermissions: React.Dispatch<React.SetStateAction<FileEntry | null>>;
  requestDeleteBatch: (entriesToDelete: FileEntry[], side: 'left' | 'right') => void;
  selectAllInPane: (side: 'left' | 'right') => void;
}) {
  if (mobile || !contextMenu) return null;

  const menuWidth = 232;
  const menuHeight = contextMenu.selectedEntries.length > 0 ? 340 : 200;
  const clampedX =
    typeof window !== 'undefined'
      ? Math.max(8, Math.min(contextMenu.x, window.innerWidth - menuWidth - 8))
      : contextMenu.x;
  const clampedY =
    typeof window !== 'undefined'
      ? Math.max(8, Math.min(contextMenu.y, window.innerHeight - menuHeight - 8))
      : contextMenu.y;

  const isLeft = contextMenu.side === 'left';
  const sideHost = isLeft ? leftHost : rightHost;
  const otherHost = isLeft ? rightHost : leftHost;
  const sidePath = isLeft ? leftPath : rightPath;
  const otherLabel = otherHost?.label || 'Local';
  const selList = contextMenu.selectedEntries;
  const singleEntry = selList.length === 1 ? selList[0] : null;

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={() => setContextMenu(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu(null);
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          left: clampedX,
          top: clampedY,
          width: menuWidth,
          backgroundColor: 'var(--nx-surface, #0e131d)',
          boxShadow: `0 0 30px ${accentColor}15, 0 16px 36px rgba(0, 0, 0, 0.75)`,
        }}
        className="fixed rounded-xl border border-white/15 p-1.5 text-xs text-slate-200 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100"
      >
        {/* Context Menu Header */}
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 mb-1 border-b border-white/[0.08]">
          <span className="font-semibold text-[11px] text-slate-100 truncate">
            {singleEntry
              ? singleEntry.name
              : selList.length > 1
              ? `${selList.length} items selected`
              : `${sideHost?.label || 'Local'} Directory`}
          </span>
          <span className="text-[9px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 bg-white/[0.06] text-slate-400 shrink-0">
            {singleEntry
              ? singleEntry.isDir
                ? 'Folder'
                : 'File'
              : selList.length > 1
              ? 'Batch'
              : isLeft
              ? 'Left'
              : 'Right'}
          </span>
        </div>

        {/* Item-Specific Actions */}
        {selList.length > 0 && (
          <>
            {singleEntry && singleEntry.isDir && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  loadPane(contextMenu.side, singleEntry.path);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
              >
                <FolderOpen className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                <span>Open Folder</span>
              </button>
            )}

            {singleEntry && !singleEntry.isDir && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  handleOpenFile(singleEntry, contextMenu.side);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
              >
                <FileCode className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                <span>Edit / View File</span>
              </button>
            )}

            <button
              disabled={!!transferStatus}
              onClick={() => {
                const items = [...selList];
                const side = contextMenu.side;
                setContextMenu(null);
                handleTransferBatch(items, side);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 hover:bg-emerald-500/15 hover:text-emerald-200 disabled:opacity-40 transition cursor-pointer"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {isLeft ? (
                  <ArrowRight className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <ArrowLeft className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                )}
                <span className="truncate">
                  Transfer{selList.length > 1 ? ` (${selList.length})` : ''} to {otherLabel}
                </span>
              </div>
            </button>

            {singleEntry && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setPromptDialog({
                    type: 'rename',
                    side: contextMenu.side,
                    title: `Rename ${singleEntry.name}`,
                    currentVal: singleEntry.name,
                    targetPath: singleEntry.path,
                  });
                }}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <Edit2 className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <span>Rename</span>
                </div>
                <span className="text-[10px] font-mono text-slate-500">F2</span>
              </button>
            )}

            <button
              onClick={() => {
                const items = [...selList];
                setContextMenu(null);
                copyPathsToClipboard(items);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <span>{selList.length > 1 ? `Copy ${selList.length} Paths` : 'Copy Path'}</span>
            </button>

            {singleEntry && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  setPermissions(singleEntry);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                <span>Permissions & Info</span>
              </button>
            )}

            <div className="my-1 h-[1px] bg-white/[0.08]" />

            <button
              onClick={() => {
                const items = [...selList];
                const side = contextMenu.side;
                setContextMenu(null);
                requestDeleteBatch(items, side);
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/15 hover:text-rose-200 transition cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Trash2 className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                <span>{selList.length > 1 ? `Delete ${selList.length} Items…` : 'Delete…'}</span>
              </div>
              <span className="text-[10px] font-mono text-rose-400/70">Del</span>
            </button>

            <div className="my-1 h-[1px] bg-white/[0.08]" />
          </>
        )}

        {/* Directory / Pane Actions */}
        <button
          onClick={() => {
            const side = contextMenu.side;
            setContextMenu(null);
            setPromptDialog({
              type: 'newFile',
              side,
              title: `New File (${sideHost?.label || 'Local'})`,
              currentVal: 'new-file.txt',
            });
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
        >
          <FilePlus className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
          <span>New File</span>
        </button>

        <button
          onClick={() => {
            const side = contextMenu.side;
            setContextMenu(null);
            setPromptDialog({
              type: 'newFolder',
              side,
              title: `New Folder (${sideHost?.label || 'Local'})`,
              currentVal: 'new-folder',
            });
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
        >
          <FolderPlus className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          <span>New Folder</span>
        </button>

        <button
          onClick={() => {
            const side = contextMenu.side;
            setContextMenu(null);
            selectAllInPane(side);
          }}
          className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <CheckSquare className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
            <span>Select All</span>
          </div>
          <span className="text-[10px] font-mono text-slate-500">Ctrl+A</span>
        </button>

        <button
          onClick={() => {
            const side = contextMenu.side;
            setContextMenu(null);
            loadPane(side, sidePath, false);
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition cursor-pointer"
        >
          <RefreshCw className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span>Refresh</span>
        </button>
      </div>
    </div>
  );
}

export function SftpPermissionsModal({
  mobile,
  permissions,
  setPermissions,
  bgColor,
  accentColor,
  copyPathsToClipboard,
}: {
  mobile: boolean;
  permissions: FileEntry | null;
  setPermissions: React.Dispatch<React.SetStateAction<FileEntry | null>>;
  bgColor: string;
  accentColor: string;
  copyPathsToClipboard: (items: FileEntry[]) => Promise<void>;
}) {
  if (mobile || !permissions) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="fixed inset-0" onClick={() => setPermissions(null)} />
      <div
        className="relative w-full max-w-sm rounded-2xl border border-white/10 p-5 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{
          backgroundColor: bgColor,
          boxShadow: `0 0 35px ${accentColor}18, 0 20px 45px rgba(0, 0, 0, 0.75)`,
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl border shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
              }}
            >
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm text-slate-100 truncate">{permissions.name}</h3>
              <p className="text-[11px] text-slate-400">
                {permissions.isDir ? 'Directory' : 'File'} Permissions & Details
              </p>
            </div>
          </div>
          <button
            onClick={() => setPermissions(null)}
            className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2.5 text-xs">
          <div
            className="rounded-xl border border-white/[0.08] bg-black/30 p-3 font-mono text-center text-base"
            style={{ color: accentColor }}
          >
            {permissions.permissions == null
              ? 'Not reported'
              : `${fmtPerm(permissions.permissions, permissions.isDir)} · ${(permissions.permissions & 0o7777)
                  .toString(8)
                  .padStart(3, '0')}`}
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-slate-400">Size:</span>
              <span className="font-mono text-slate-200">
                {permissions.isDir ? 'Directory' : fmtSize(permissions.size)}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-slate-400">Modified:</span>
              <span className="text-slate-200">{fmtDate(permissions.modified)}</span>
            </div>
            <div className="pt-1 border-t border-white/[0.06]">
              <span className="text-slate-400 block mb-1">Full Path:</span>
              <div className="font-mono text-[11px] text-slate-300 break-all bg-black/30 rounded-lg px-2.5 py-1.5 border border-white/5">
                {permissions.path}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => copyPathsToClipboard([permissions])}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white border border-white/10 transition cursor-pointer"
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Copy Path</span>
          </button>
          <button
            type="button"
            onClick={() => setPermissions(null)}
            className="rounded-xl border px-4 py-1.5 text-xs font-semibold transition cursor-pointer"
            style={{
              backgroundColor: `${accentColor}25`,
              borderColor: `${accentColor}50`,
              color: accentColor,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function SftpDeleteConfirmModal({
  deleteConfirm,
  setDeleteConfirm,
  leftHost,
  rightHost,
  bgColor,
  handleExecuteDelete,
}: {
  deleteConfirm: SftpDeleteConfirmState | null;
  setDeleteConfirm: React.Dispatch<React.SetStateAction<SftpDeleteConfirmState | null>>;
  leftHost: Host | null;
  rightHost: Host | null;
  bgColor: string;
  handleExecuteDelete: () => Promise<void>;
}) {
  if (!deleteConfirm || deleteConfirm.entries.length === 0) return null;

  const items = deleteConfirm.entries;
  const isSingle = items.length === 1;
  const single = items[0];
  const hasDirs = items.some((it) => it.isDir);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="fixed inset-0"
        onClick={() => {
          if (!deleteConfirm.deleting) setDeleteConfirm(null);
        }}
      />
      <div
        className="relative w-full max-w-md rounded-2xl border border-rose-500/30 p-6 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{
          backgroundColor: bgColor,
          boxShadow: '0 0 35px rgba(244, 63, 94, 0.18), 0 20px 45px rgba(0, 0, 0, 0.85)',
        }}
      >
        {/* Top ambient radial glow in crimson/rose */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25"
          style={{ background: 'radial-gradient(ellipse at top, #f43f5e 0%, transparent 70%)' }}
        />
        {/* Top glowing line in rose */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-80"
          style={{ background: 'linear-gradient(90deg, transparent, #f43f5e, transparent)' }}
        />

        <div className="relative flex items-start gap-3.5 mb-4">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-500/40 bg-rose-500/15 text-rose-400 transition shadow-md shrink-0"
            style={{
              boxShadow: '0 0 16px rgba(244, 63, 94, 0.25)',
            }}
          >
            <AlertTriangle className="h-5 w-5 text-rose-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-slate-100 flex items-center gap-2">
              <span>{isSingle ? `Delete ${single.isDir ? 'Folder' : 'File'}?` : `Delete ${items.length} Items?`}</span>
              <span className="text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 border border-rose-500/30 bg-rose-500/10 text-rose-400">
                {deleteConfirm.side === 'left' ? leftHost?.label || 'Local' : rightHost?.label || 'Local'}
              </span>
            </h3>

            {isSingle ? (
              <>
                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                  Are you sure you want to permanently delete{' '}
                  <span className="font-mono text-white font-semibold break-all bg-white/[0.06] px-1.5 py-0.5 rounded border border-white/10">
                    {single.name}
                  </span>
                  ?
                </p>
                <div className="mt-3 rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-400 font-mono truncate">
                  {single.path}
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                  Are you sure you want to permanently delete these{' '}
                  <span className="font-semibold text-white">{items.length} selected items</span>?
                </p>
                <div className="mt-2.5 max-h-32 overflow-y-auto rounded-lg bg-black/40 border border-white/10 p-2 space-y-1">
                  {items.map((it) => (
                    <div
                      key={it.path}
                      className="flex items-center gap-2 text-[11px] font-mono text-slate-300 truncate"
                    >
                      {it.isDir ? (
                        <Folder className="h-3 w-3 text-sky-400 shrink-0" />
                      ) : (
                        <FileText className="h-3 w-3 text-slate-400 shrink-0" />
                      )}
                      <span className="truncate">{it.name}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {hasDirs ? (
              <p className="text-[11px] text-amber-400/90 mt-2.5 flex items-center gap-1.5">
                <span>⚠️</span>
                <span>
                  {isSingle
                    ? 'This will permanently delete this directory and all contents inside.'
                    : 'Selected folders and all of their nested contents will be permanently deleted.'}
                </span>
              </p>
            ) : (
              <p className="text-[11px] text-slate-400 mt-2">This action is permanent and cannot be undone.</p>
            )}
          </div>
        </div>

        <div className="relative mt-5 flex items-center justify-end gap-2.5 pt-3 border-t border-white/10">
          <button
            type="button"
            disabled={deleteConfirm.deleting}
            onClick={() => setDeleteConfirm(null)}
            className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-white/10 hover:text-white transition disabled:opacity-50 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            disabled={deleteConfirm.deleting}
            onClick={handleExecuteDelete}
            className="flex items-center gap-1.5 rounded-xl border border-rose-500/50 bg-rose-500/25 px-4 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/35 transition disabled:opacity-50 cursor-pointer shadow-sm"
            style={{
              boxShadow: '0 0 16px rgba(244, 63, 94, 0.3)',
            }}
          >
            {deleteConfirm.deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            <span>
              {deleteConfirm.deleting
                ? 'Deleting...'
                : isSingle
                ? 'Delete Permanently'
                : `Delete ${items.length} Items`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
