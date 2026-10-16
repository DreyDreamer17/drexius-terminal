import { useMobile } from '../hooks/useMobile';
import { MobileSheet } from './MobileSheet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder,
  FileText,
  FileArchive,
  FileCode,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Upload,
  Download,
  Trash2,
  AlertTriangle,
  Edit2,
  X,
  Loader2,
  Server,
  ArrowRight,
  Check,
  FileSpreadsheet,
  FileImage,
  FileAudio,
  FileVideo,
  Laptop,
  HardDrive,
  ShieldCheck,
} from 'lucide-react';
import { bridge, isBridgeError } from '../lib/bridge';
import type { FileEntry, Host, Tab } from '../lib/types';
import { cn } from '../utils/cn';
import { THEMES, type NexusTheme } from '../lib/themes';
import { OsIcon } from './OsIcon';
import { SftpCodeEditor, type EditorFile } from './SftpCodeEditor';

// ── Formatting Helpers ──
function fmtSize(n: number): string {
  if (n === 0) return '0 Bytes';
  if (n < 1024) return `${n}.00 Bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(sec?: number | null): string {
  if (!sec) return '- -';
  const d = new Date(sec * 1000);
  return d.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtPerm(m?: number | null, isDir?: boolean): string {
  if (m == null) return isDir ? 'drwxr-xr-x' : '-rw-r--r--';
  const d = isDir ? 'd' : '-';
  return (
    d +
    [6, 3, 0]
      .map((s) => ((m >> s) & 4 ? 'r' : '-') + ((m >> s) & 2 ? 'w' : '-') + ((m >> s) & 1 ? 'x' : '-'))
      .join('')
  );
}

function fmtKind(e: FileEntry): string {
  if (e.isDir) return 'folder';
  const parts = e.name.split('.');
  if (parts.length > 1 && parts[parts.length - 1]) {
    return parts[parts.length - 1].toLowerCase();
  }
  return 'file';
}

function fileIcon(e: FileEntry) {
  if (e.isDir) return Folder;
  const ext = e.name.split('.').pop()?.toLowerCase();
  if (['zip', 'tar', 'gz', 'tgz', 'xz', 'bz2', '7z', 'rar'].includes(ext || '')) return FileArchive;
  if (['sh', 'bash', 'zsh', 'py', 'js', 'ts', 'tsx', 'jsx', 'rs', 'go', 'c', 'cpp', 'h', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'sql'].includes(ext || '')) return FileCode;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext || '')) return FileImage;
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext || '')) return FileAudio;
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext || '')) return FileVideo;
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext || '')) return FileSpreadsheet;
  return FileText;
}

interface SftpTabProps {
  tab: Tab;
  active?: boolean;
  hosts: Host[];
  onUpdateTab: (patch: Partial<Tab>) => void;
  toast: (msg: string) => void;
  theme?: NexusTheme;
}

export function SftpTab({ tab, hosts, onUpdateTab, toast, theme, active = true }: SftpTabProps) {
  const mobile = useMobile();
  const [mobileSide, setMobileSide] = useState<'remote' | 'local'>('remote');
  const [fileActions, setFileActions] = useState<{ entry: FileEntry; side: 'local' | 'remote' } | null>(null);
  const [permissions, setPermissions] = useState<FileEntry | null>(null);

  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent || '#22d3ee';
  const bgColor = activeTheme.xterm.background || '#090d16';

  // ── Local Filesystem State ──
  const [localPath, setLocalPath] = useState<string>('');
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState<boolean>(false);
  const [localFilter, setLocalFilter] = useState<string>('');
  const [showLocalSearch, setShowLocalSearch] = useState<boolean>(false);
  const [showLocalHidden, setShowLocalHidden] = useState<boolean>(false);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [localHistory, setLocalHistory] = useState<string[]>([]);
  const [localHistoryIdx, setLocalHistoryIdx] = useState<number>(-1);
  const [showLocalActions, setShowLocalActions] = useState<boolean>(false);

  // ── Remote SFTP State ──
  const [remoteHostId, setRemoteHostId] = useState<string | null>(tab.sftpHostId || null);
  const [remoteSessionId, setRemoteSessionId] = useState<string | null>(tab.sftpSessionId || null);
  const remoteSessionRef = useRef<string | null>(tab.sftpSessionId || null);
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  const connectGenerationRef = useRef(0);
  // The tab owns its SFTP session. Close it when the tab is removed, even if
  // the user never clicked Disconnect (and avoid leaking in-flight connects).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React StrictMode immediately re-runs effects in development without
      // actually removing the tab. Defer the close one tick so that rehearsal
      // cleanup does not tear down a live session.
      setTimeout(() => {
        if (mountedRef.current) return;
        connectGenerationRef.current++;
        if (remoteSessionRef.current) {
          bridge.sftpClose(remoteSessionRef.current).catch(() => {});
          remoteSessionRef.current = null;
        }
      }, 0);
    };
  }, []);
  const [remoteConnecting, setRemoteConnecting] = useState<boolean>(false);
  const [remotePath, setRemotePath] = useState<string>('');
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState<boolean>(false);
  const [remoteFilter, setRemoteFilter] = useState<string>('');
  const [showRemoteSearch, setShowRemoteSearch] = useState<boolean>(false);
  const [showRemoteHidden, setShowRemoteHidden] = useState<boolean>(false);
  const [remoteSelected, setRemoteSelected] = useState<string | null>(null);
  const [remoteHistory, setRemoteHistory] = useState<string[]>([]);
  const [remoteHistoryIdx, setRemoteHistoryIdx] = useState<number>(-1);
  const [showRemoteActions, setShowRemoteActions] = useState<boolean>(false);

  // ── Modals & Dialogs ──
  const [showHostPicker, setShowHostPicker] = useState<boolean>(false);
  const [hostPickerSearch, setHostPickerSearch] = useState<string>('');
  const [transferStatus, setTransferStatus] = useState<{
    type: 'upload' | 'download';
    filename: string;
    progress: number;
  } | null>(null);

  // Text file editor
  const [editingFile, setEditingFile] = useState<EditorFile | null>(null);

  // New file, new folder & rename dialogs
  const [promptDialog, setPromptDialog] = useState<{
    type: 'newFile' | 'newFolder' | 'rename';
    side: 'local' | 'remote';
    title: string;
    currentVal: string;
    targetPath?: string;
  } | null>(null);

  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{
    entry: FileEntry;
    side: 'local' | 'remote';
    deleting?: boolean;
  } | null>(null);

  const remoteHost = useMemo(() => {
    return hosts.find((h) => h.id === remoteHostId) || null;
  }, [hosts, remoteHostId]);

  // ── Load Local Directory ──
  const loadLocal = useCallback(
    async (path?: string, recordHistory = true) => {
      setLocalLoading(true);
      try {
        const res = await bridge.localFsList(path);
        setLocalPath(res.currentPath);
        setLocalEntries(res.entries);
        if (recordHistory) {
          setLocalHistory((prev) => {
            const next = prev.slice(0, localHistoryIdx + 1);
            return [...next, res.currentPath];
          });
          setLocalHistoryIdx((prev) => prev + 1);
        }
      } catch (err) {
        toast(isBridgeError(err) ? err.message : String(err));
      } finally {
        setLocalLoading(false);
      }
    },
    [localHistoryIdx, toast]
  );

  // Initialize local path on mount
  useEffect(() => {
    loadLocal('', true);
  }, []);

  // ── Remote SFTP Connect & Load ──
  const connectRemote = useCallback(
    async (hostId: string) => {
      if (connectingRef.current) return;
      connectingRef.current = true;
      const generation = ++connectGenerationRef.current;
      setRemoteConnecting(true);
      let sid: string | null = null;
      try {
        sid = await bridge.sftpConnect(hostId);
        // Do not replace a working session until the new one can list files.
        const list = await bridge.sftpList(sid, '');
        if (!mountedRef.current || generation !== connectGenerationRef.current) {
          await bridge.sftpClose(sid);
          return;
        }
        const previous = remoteSessionRef.current;
        remoteSessionRef.current = sid;
        if (previous && previous !== sid) bridge.sftpClose(previous).catch(() => {});
        setRemoteSessionId(sid);
        setRemoteHostId(hostId);
        onUpdateTab({
          sftpHostId: hostId,
          sftpSessionId: sid,
          title: `SFTP: ${hosts.find((h) => h.id === hostId)?.label || 'Remote'}`,
        });
        setRemoteEntries(list);
        const initialRemotePath =
          list[0]?.path.slice(0, list[0].path.lastIndexOf('/')) || bridge.homeFor(sid) || '/';
        setRemotePath(initialRemotePath);
        setRemoteHistory([initialRemotePath]);
        setRemoteHistoryIdx(0);
        setShowHostPicker(false);
        toast(`Connected to ${hosts.find((h) => h.id === hostId)?.label || 'Host'}`);
      } catch (err) {
        if (sid) await bridge.sftpClose(sid);
        if (mountedRef.current && generation === connectGenerationRef.current) {
          toast(isBridgeError(err) ? err.message : `Connection failed: ${err}`);
        }
      } finally {
        connectingRef.current = false;
        if (mountedRef.current) setRemoteConnecting(false);
      }
    },
    [hosts, onUpdateTab, toast]
  );

  const disconnectRemote = useCallback(() => {
    connectGenerationRef.current++;
    const sid = remoteSessionRef.current;
    remoteSessionRef.current = null;
    if (sid) bridge.sftpClose(sid).catch(() => {});
    setRemoteSessionId(null);
    setRemoteHostId(null);
    setRemoteEntries([]);
    setRemotePath('');
    setRemoteHistory([]);
    setRemoteHistoryIdx(-1);
    onUpdateTab({ sftpHostId: null, sftpSessionId: null, title: 'SFTP' });
  }, [onUpdateTab]);

  // If tab already had a hostId on launch but no session, connect automatically
  useEffect(() => {
    if (tab.sftpHostId && !remoteSessionId && !remoteConnecting) {
      connectRemote(tab.sftpHostId);
    }
  }, [tab.sftpHostId]);

  const loadRemote = useCallback(
    async (p: string, recordHistory = true) => {
      if (!remoteSessionId) return;
      setRemoteLoading(true);
      try {
        const list = await bridge.sftpList(remoteSessionId, p);
        setRemoteEntries(list);
        setRemotePath(p);
        if (recordHistory) {
          setRemoteHistory((prev) => {
            const next = prev.slice(0, remoteHistoryIdx + 1);
            return [...next, p];
          });
          setRemoteHistoryIdx((prev) => prev + 1);
        }
      } catch (err) {
        toast(isBridgeError(err) ? err.message : String(err));
      } finally {
        setRemoteLoading(false);
      }
    },
    [remoteSessionId, remoteHistoryIdx, toast]
  );

  // ── Navigation Handlers ──
  const navigateLocalBack = () => {
    if (localHistoryIdx > 0) {
      const prev = localHistory[localHistoryIdx - 1];
      setLocalHistoryIdx((i) => i - 1);
      loadLocal(prev, false);
    }
  };

  const navigateLocalForward = () => {
    if (localHistoryIdx < localHistory.length - 1) {
      const next = localHistory[localHistoryIdx + 1];
      setLocalHistoryIdx((i) => i + 1);
      loadLocal(next, false);
    }
  };

  const navigateRemoteBack = () => {
    if (remoteHistoryIdx > 0) {
      const prev = remoteHistory[remoteHistoryIdx - 1];
      setRemoteHistoryIdx((i) => i - 1);
      loadRemote(prev, false);
    }
  };

  const navigateRemoteForward = () => {
    if (remoteHistoryIdx < remoteHistory.length - 1) {
      const next = remoteHistory[remoteHistoryIdx + 1];
      setRemoteHistoryIdx((i) => i + 1);
      loadRemote(next, false);
    }
  };

  // Breadcrumbs parsing
  const localCrumbs = useMemo(() => {
    if (!localPath) return [];
    const parts = localPath.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      fullPath: '/' + parts.slice(0, index + 1).join('/'),
    }));
  }, [localPath]);

  const remoteCrumbs = useMemo(() => {
    if (!remotePath) return [];
    const parts = remotePath.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      fullPath: '/' + parts.slice(0, index + 1).join('/'),
    }));
  }, [remotePath]);

  // ── File Transfers (Local <-> Remote) ──
  const handleUpload = async (localEntry: FileEntry) => {
    if (!remoteSessionId || !remotePath) {
      toast('Please connect to a host first');
      return;
    }
    const targetRemotePath = `${remotePath.replace(/\/$/, '')}/${localEntry.name}`;
    setTransferStatus({ type: 'upload', filename: localEntry.name, progress: 0 });
    try {
      await bridge.sftpUploadDirect(
        remoteSessionId,
        localEntry.path,
        targetRemotePath,
        (pct) => setTransferStatus((s) => s && { ...s, progress: pct })
      );
      toast(`Uploaded ${localEntry.name}`);
      await loadRemote(remotePath, false);
    } catch (err) {
      toast(isBridgeError(err) ? err.message : `Upload failed: ${err}`);
    } finally {
      setTimeout(() => setTransferStatus(null), 400);
    }
  };

  const handleDownload = async (remoteEntry: FileEntry) => {
    if (!remoteSessionId || !localPath) {
      toast('Invalid local target path');
      return;
    }
    const targetLocalPath = `${localPath.replace(/\/$/, '')}/${remoteEntry.name}`;
    setTransferStatus({ type: 'download', filename: remoteEntry.name, progress: 0 });
    try {
      await bridge.sftpDownloadDirect(
        remoteSessionId,
        remoteEntry.path,
        targetLocalPath,
        (pct) => setTransferStatus((s) => s && { ...s, progress: pct })
      );
      toast(`Downloaded ${remoteEntry.name}`);
      await loadLocal(localPath, false);
    } catch (err) {
      toast(isBridgeError(err) ? err.message : `Download failed: ${err}`);
    } finally {
      setTimeout(() => setTransferStatus(null), 400);
    }
  };

  // ── Drag and Drop Between Panes ──
  const handleDragStart = (e: React.DragEvent, entry: FileEntry, side: 'local' | 'remote') => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ side, entry }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDropOnRemote = async (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.side === 'local' && data.entry) {
        await handleUpload(data.entry);
      }
    } catch (_) {}
  };

  const handleDropOnLocal = async (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.side === 'remote' && data.entry) {
        await handleDownload(data.entry);
      }
    } catch (_) {}
  };

  // ── File Actions (Delete, Rename, New Folder, View/Edit) ──
  const requestDelete = (entry: FileEntry, side: 'local' | 'remote') => {
    setDeleteConfirm({ entry, side });
  };

  const handleExecuteDelete = async () => {
    if (!deleteConfirm) return;
    const { entry, side } = deleteConfirm;
    setDeleteConfirm((prev) => prev && { ...prev, deleting: true });
    try {
      if (side === 'local') {
        await bridge.localFsRemove(entry.path, entry.isDir);
        toast(`Deleted ${entry.name}`);
        setDeleteConfirm(null);
        loadLocal(localPath, false);
      } else if (remoteSessionId) {
        await bridge.sftpRemove(remoteSessionId, entry.path, entry.isDir);
        toast(`Deleted ${entry.name}`);
        setDeleteConfirm(null);
        loadRemote(remotePath, false);
      }
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
      setDeleteConfirm((prev) => prev && { ...prev, deleting: false });
    }
  };

  // Keyboard shortcut: Delete key for selected item
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active) return;
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        editingFile ||
        promptDialog ||
        showHostPicker ||
        deleteConfirm
      ) {
        return;
      }

      if (e.key === 'Delete') {
        if (remoteSelected) {
          const entry = remoteEntries.find((r) => r.path === remoteSelected);
          if (entry) {
            e.preventDefault();
            requestDelete(entry, 'remote');
          }
        } else if (localSelected) {
          const entry = localEntries.find((l) => l.path === localSelected);
          if (entry) {
            e.preventDefault();
            requestDelete(entry, 'local');
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    active,
    remoteSelected,
    localSelected,
    remoteEntries,
    localEntries,
    editingFile,
    promptDialog,
    showHostPicker,
    deleteConfirm,
  ]);

  const handleOpenFile = async (entry: FileEntry, isRemote: boolean) => {
    if (entry.isDir) return;
    try {
      if (isRemote && remoteSessionId) {
        const text = await bridge.sftpReadText(remoteSessionId, entry.path);
        setEditingFile({
          path: entry.path,
          name: entry.name,
          content: text,
          isRemote: true,
        });
      } else if (!isRemote) {
        const text = await bridge.localFsReadText(entry.path);
        setEditingFile({
          path: entry.path,
          name: entry.name,
          content: text,
          isRemote: false,
        });
      }
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
    }
  };

  const handleSaveFile = async (newContent: string) => {
    if (!editingFile) return;
    if (editingFile.isRemote && remoteSessionId) {
      await bridge.sftpWriteText(remoteSessionId, editingFile.path, newContent);
      setEditingFile((prev) => (prev ? { ...prev, content: newContent } : null));
      loadRemote(remotePath, false);
    } else if (!editingFile.isRemote) {
      await bridge.localFsWriteText(editingFile.path, newContent);
      setEditingFile((prev) => (prev ? { ...prev, content: newContent } : null));
      loadLocal(localPath, false);
    }
  };

  const handlePromptSubmit = async (val: string) => {
    if (!promptDialog || !val.trim()) {
      setPromptDialog(null);
      return;
    }
    const { type, side, targetPath } = promptDialog;
    try {
      if (type === 'newFile') {
        const filename = val.trim();
        if (side === 'local') {
          const newPath = `${localPath.replace(/\/$/, '')}/${filename}`;
          await bridge.localFsWriteText(newPath, '');
          toast(`Created file "${filename}"`);
          await loadLocal(localPath, false);
          setEditingFile({
            path: newPath,
            name: filename,
            content: '',
            isRemote: false,
          });
        } else if (remoteSessionId) {
          const newPath = `${remotePath.replace(/\/$/, '')}/${filename}`;
          await bridge.sftpWriteText(remoteSessionId, newPath, '');
          toast(`Created file "${filename}"`);
          await loadRemote(remotePath, false);
          setEditingFile({
            path: newPath,
            name: filename,
            content: '',
            isRemote: true,
          });
        }
      } else if (type === 'newFolder') {
        if (side === 'local') {
          const newDir = `${localPath.replace(/\/$/, '')}/${val.trim()}`;
          await bridge.localFsMkdir(newDir);
          toast(`Created folder "${val.trim()}"`);
          loadLocal(localPath, false);
        } else if (remoteSessionId) {
          const newDir = `${remotePath.replace(/\/$/, '')}/${val.trim()}`;
          await bridge.sftpMkdir(remoteSessionId, newDir);
          toast(`Created folder "${val.trim()}"`);
          loadRemote(remotePath, false);
        }
      } else if (type === 'rename' && targetPath) {
        const dir = targetPath.slice(0, targetPath.lastIndexOf('/'));
        const newPath = `${dir}/${val.trim()}`;
        if (side === 'local') {
          await bridge.localFsRename(targetPath, newPath);
          toast(`Renamed to "${val.trim()}"`);
          loadLocal(localPath, false);
        } else if (remoteSessionId) {
          await bridge.sftpRename(remoteSessionId, targetPath, newPath);
          toast(`Renamed to "${val.trim()}"`);
          loadRemote(remotePath, false);
        }
      }
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
    } finally {
      setPromptDialog(null);
    }
  };

  // Filtered lists
  const filteredLocal = useMemo(() => {
    return localEntries.filter((e) => {
      if (!showLocalHidden && e.name.startsWith('.')) return false;
      if (localFilter && !e.name.toLowerCase().includes(localFilter.toLowerCase())) return false;
      return true;
    });
  }, [localEntries, showLocalHidden, localFilter]);

  const filteredRemote = useMemo(() => {
    return remoteEntries.filter((e) => {
      if (!showRemoteHidden && e.name.startsWith('.')) return false;
      if (remoteFilter && !e.name.toLowerCase().includes(remoteFilter.toLowerCase())) return false;
      return true;
    });
  }, [remoteEntries, showRemoteHidden, remoteFilter]);

  const filteredHosts = useMemo(() => {
    if (!hostPickerSearch.trim()) return hosts;
    const q = hostPickerSearch.toLowerCase().trim();
    return hosts.filter(
      (h) =>
        h.label.toLowerCase().includes(q) ||
        h.hostname.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q)
    );
  }, [hosts, hostPickerSearch]);

  return (
    <div
      className="nx-sftp relative flex h-full w-full flex-col overflow-hidden text-slate-200 select-none"
      style={{ background: bgColor }}
    >
      {/* ── Transfer Float Toast / Banner ── */}
      {transferStatus && (
        <div className="absolute top-3 right-6 z-50 flex items-center gap-3 rounded-xl border border-cyan-500/40 bg-slate-900/95 px-4 py-2.5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150">
          <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
          <div className="flex flex-col text-xs">
            <span className="font-medium text-slate-100">
              {transferStatus.type === 'upload' ? 'Uploading' : 'Downloading'} {transferStatus.filename}
            </span>
            <div className="mt-1 h-1.5 w-40 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-150"
                style={{ width: `${Math.round(transferStatus.progress * 100)}%` }}
              />
            </div>
          </div>
          <span className="font-mono text-[11px] text-cyan-300">
            {Math.round(transferStatus.progress * 100)}%
          </span>
        </div>
      )}

      <div className="nx-segmented md:hidden" aria-label="File location">
        <button aria-pressed={mobileSide === 'remote'} onClick={() => setMobileSide('remote')}><Server size={16} /> Remote</button>
        <button aria-pressed={mobileSide === 'local'} onClick={() => setMobileSide('local')}><Laptop size={16} /> Local</button>
      </div>
      {mobile && active && fileActions && <MobileSheet title={fileActions.entry.name} kicker={fileActions.entry.isDir ? 'Folder' : 'File'} subtitle={fileActions.side === 'remote' ? 'Remote' : 'Local'}
        icon={fileActions.entry.isDir ? Folder : FileCode} theme={activeTheme} onClose={() => setFileActions(null)}>
        <p className="mb-3 break-all font-mono text-[11px] leading-relaxed text-slate-500">{fileActions.entry.path}</p>
        <div className="nx-settings-group">
          {fileActions.entry.isDir ? <button className="nx-settings-row" onClick={() => { fileActions.side === 'remote' ? loadRemote(fileActions.entry.path) : loadLocal(fileActions.entry.path); setFileActions(null); }}><Folder size={18} /> Open folder</button> : <>
            <button className="nx-settings-row" onClick={() => { handleOpenFile(fileActions.entry, fileActions.side === 'remote'); setFileActions(null); }}><FileCode size={18} /> Edit</button>
            <button className="nx-settings-row" disabled={!!transferStatus || !remoteSessionId || !localPath} onClick={() => { fileActions.side === 'remote' ? handleDownload(fileActions.entry) : handleUpload(fileActions.entry); setFileActions(null); }}><Download size={18} />{fileActions.side === 'remote' ? 'Download to Local' : 'Upload to Remote'}</button>
          </>}
          <button className="nx-settings-row" onClick={() => { setPromptDialog({ type: 'rename', side: fileActions.side, title: 'Rename', currentVal: fileActions.entry.name, targetPath: fileActions.entry.path }); setFileActions(null); }}><Edit2 size={18} /> Rename</button>
          <button className="nx-settings-row" onClick={() => { setPermissions(fileActions.entry); setFileActions(null); }}><ShieldCheck size={18} /> Permissions</button>
          <button className="nx-settings-row text-rose-300" onClick={() => { requestDelete(fileActions.entry, fileActions.side); setFileActions(null); }}><Trash2 size={18} /> Delete…</button>
        </div>
        <p className="mt-3 break-all text-xs text-slate-500">Transfer destination: {fileActions.side === 'remote' ? localPath || 'Select a local folder first' : remotePath || 'Connect to a remote host first'}. Change it in the {fileActions.side === 'remote' ? 'Local' : 'Remote'} tab before transferring.</p>
      </MobileSheet>}
      {mobile && active && permissions && <MobileSheet title="File permissions" subtitle={permissions.name} icon={ShieldCheck} theme={activeTheme} onClose={() => setPermissions(null)}>
        <p className="my-1 rounded-xl border border-white/[0.06] bg-black/30 p-4 font-mono text-lg" style={{ color: activeTheme.accent }}>{permissions.permissions == null ? 'Not reported' : `${fmtPerm(permissions.permissions, permissions.isDir)} · ${(permissions.permissions & 0o7777).toString(8).padStart(3, '0')}`}</p>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">Read-only metadata. Permission changes are not exposed by the file API; use your terminal to change the mode.</p>
      </MobileSheet>}

      {/* ── Main Dual-Pane View ── */}
      <div className="flex flex-1 min-h-0 min-w-0 md:divide-x divide-white/[0.08]">
        {/* ==================================================================== */}
        {/* LEFT PANE: LOCAL FILESYSTEM */}
        {/* ==================================================================== */}
        <div
          className={cn("flex flex-1 min-w-0 flex-col bg-transparent", mobileSide !== 'local' && "max-md:hidden")}
          role="region" aria-label="Local files"
          onDragOver={handleDragOver}
          onDrop={handleDropOnLocal}
        >
          {/* Header */}
          <div className="nx-sftp-toolbar flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] px-4">
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-400/30">
                <Laptop className="h-4 w-4" />
              </div>
              <span className="font-medium text-slate-100 text-sm">Local</span>
            </div>

            <div className="flex items-center gap-2">
              {showLocalSearch ? (
                <div className="relative flex items-center">
                  <Search className="absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={localFilter}
                    onChange={(e) => setLocalFilter(e.target.value)}
                    placeholder="Filter..."
                    autoFocus
                    className="h-7 w-36 rounded-lg bg-white/[0.06] pl-8 pr-6 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
                  />
                  {localFilter && (
                    <button
                      onClick={() => setLocalFilter('')}
                      className="absolute right-2 text-slate-400 hover:text-white"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setShowLocalSearch(true)}
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span>Filter</span>
                </button>
              )}

              {/* Quick New File & New Folder Buttons */}
              <button
                title="New File"
                onClick={() =>
                  setPromptDialog({
                    type: 'newFile',
                    side: 'local',
                    title: 'New Local File',
                    currentVal: 'new-file.txt',
                  })
                }
                className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
              >
                <FilePlus className="h-3.5 w-3.5 text-cyan-400" />
                <span className="hidden xl:inline">New File</span>
              </button>

              <button
                title="New Folder"
                onClick={() =>
                  setPromptDialog({
                    type: 'newFolder',
                    side: 'local',
                    title: 'New Local Folder',
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
                  onClick={() => setShowLocalActions((v) => !v)}
                  className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white border border-white/5 transition"
                >
                  <span>Actions</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
                {showLocalActions && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setShowLocalActions(false)} />
                    <div className="absolute right-0 top-8 z-40 w-44 rounded-xl border border-white/10 bg-[#0e131d] p-1 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100">
                      <button
                        onClick={() => {
                          setShowLocalActions(false);
                          setPromptDialog({
                            type: 'newFile',
                            side: 'local',
                            title: 'New Local File',
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
                          setShowLocalActions(false);
                          setPromptDialog({
                            type: 'newFolder',
                            side: 'local',
                            title: 'New Local Folder',
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
                          setShowLocalActions(false);
                          loadLocal(localPath, false);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <RefreshCw className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Refresh</span>
                      </button>
                      <div className="my-1 h-[1px] bg-white/10" />
                      <button
                        onClick={() => {
                          setShowLocalActions(false);
                          setShowLocalHidden((v) => !v);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                      >
                        <span>Show Hidden</span>
                        {showLocalHidden && <Check className="h-3 w-3 text-cyan-400" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Breadcrumbs Bar */}
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-black/10 px-3 text-xs">
            <div className="flex items-center gap-0.5">
              <button
                disabled={localHistoryIdx <= 0}
                onClick={navigateLocalBack}
                className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                disabled={localHistoryIdx >= localHistory.length - 1}
                onClick={navigateLocalForward}
                className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pl-1 text-slate-300">
              <button
                onClick={() => loadLocal('/')}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/[0.06] hover:text-white"
              >
                <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                <span className="font-mono text-[11px]">/</span>
              </button>
              {localCrumbs.map((crumb, idx) => (
                <div key={crumb.fullPath} className="flex items-center gap-1 shrink-0">
                  <ChevronRight className="h-3 w-3 text-slate-600 shrink-0" />
                  <button
                    onClick={() => loadLocal(crumb.fullPath)}
                    className={cn(
                      'flex items-center gap-1.5 rounded px-1.5 py-0.5 transition font-medium',
                      idx === localCrumbs.length - 1
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

          {/* Table Header */}
          <div className="flex h-8 shrink-0 items-center border-b border-white/[0.06] bg-black/20 px-4 text-[11px] font-medium text-slate-400">
            <div className="flex-1 min-w-0">Name</div>
            <div className="w-44 text-left hidden md:block">Date Modified</div>
            <div className="w-24 text-left hidden md:block">Size</div>
            <div className="w-20 text-left hidden lg:block">Kind</div>
          </div>

          {/* File List */}
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/[0.03]">
            {localLoading && (
              <div className="flex items-center justify-center py-12 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin mr-2 text-cyan-400" />
                <span>Loading directory...</span>
              </div>
            )}

            {!localLoading && localPath !== '/' && (
              <div
                onClick={() => { if (mobile) loadLocal(localPath.replace(/\/[^/]+\/?$/, '') || '/'); }}
                    onDoubleClick={() => loadLocal(localPath.replace(/\/[^/]+\/?$/, '') || '/')}
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

            {!localLoading &&
              filteredLocal.map((entry) => {
                const isSelected = localSelected === entry.path;
                const Icon = fileIcon(entry);
                return (
                  <div
                    key={entry.path}
                    draggable
                    onDragStart={(e) => handleDragStart(e, entry, 'local')}
                    onClick={() => {
                      setLocalSelected(entry.path);
                      if (mobile) { if (entry.isDir) loadLocal(entry.path); else setFileActions({ entry, side: 'local' }); }
                    }}
                    onContextMenu={e => { if (mobile) { e.preventDefault(); setFileActions({ entry, side: 'local' }); } }}
                    onDoubleClick={() => {
                      if (mobile) return;
                      if (entry.isDir) {
                        loadLocal(entry.path);
                      } else {
                        handleOpenFile(entry, false);
                      }
                    }}
                    className={cn(
                      'flex h-12 items-center px-4 cursor-pointer transition select-none group',
                      isSelected
                        ? 'bg-cyan-500/15 border-l-2 border-cyan-400'
                        : 'hover:bg-white/[0.04] border-l-2 border-transparent'
                    )}
                  >
                    {/* Name + Permissions */}
                    <div className="flex items-center gap-3 flex-1 min-w-0 pr-3">
                      <Icon
                        className={cn(
                          'h-4 w-4 shrink-0',
                          entry.isDir ? 'text-sky-400' : 'text-slate-400'
                        )}
                      />
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
                    <div className="w-20 text-slate-400 text-xs hidden lg:block">
                      {fmtKind(entry)}
                    </div>

                    {/* Quick Row Actions on Hover/Select */}
                    <button className="nx-touch-button md:hidden" aria-label={`Actions for ${entry.name}`} onClick={e => { e.stopPropagation(); setFileActions({ entry, side: 'local' }); }}>•••</button>
                    <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                      {remoteSessionId && !entry.isDir && (
                        <button
                          title={`Upload to ${remoteHost?.label || 'Remote'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUpload(entry);
                          }}
                          className="rounded p-1 text-slate-400 hover:bg-cyan-500/20 hover:text-cyan-300"
                        >
                          <Upload className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {!entry.isDir && (
                        <button
                          title="Edit File"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenFile(entry, false);
                          }}
                          className="rounded p-1 text-slate-400 hover:bg-cyan-500/20 hover:text-cyan-300"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPromptDialog({
                            type: 'rename',
                            side: 'local',
                            title: 'Rename File',
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
                          requestDelete(entry, 'local');
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}

            {!localLoading && !filteredLocal.length && (
              <div className="py-16 text-center text-xs text-slate-500">
                {localFilter ? 'No files match filter' : 'Empty directory'}
              </div>
            )}
          </div>
        </div>

        {/* ==================================================================== */}
        {/* RIGHT PANE: REMOTE SFTP HOST */}
        {/* ==================================================================== */}
        <div
          className={cn("flex flex-1 min-w-0 flex-col bg-transparent relative", mobileSide !== 'remote' && "max-md:hidden")}
          role="region" aria-label="Remote files"
          onDragOver={handleDragOver}
          onDrop={handleDropOnRemote}
        >
          {remoteConnecting ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-400 mb-3" />
              <h3 className="text-sm font-semibold text-slate-200">
                Connecting to {remoteHost?.label || 'Host'}...
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Authenticating and establishing SFTP session
              </p>
            </div>
          ) : !remoteSessionId ? (
            /* ── DISCONNECTED PLACEHOLDER (Exact Termius style from screenshot) ── */
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              {/* Rounded Folder Squircle */}
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/[0.05] border border-white/10 shadow-xl mb-4">
                <Folder className="h-8 w-8 text-slate-300" />
              </div>

              <h2 className="text-base font-semibold text-slate-100 mb-1">
                Connect to host
              </h2>
              <p className="max-w-xs text-xs text-slate-400 leading-relaxed mb-6">
                Start by connecting to a saved host to manage your files with SFTP.
              </p>

              <button
                onClick={() => setShowHostPicker(true)}
                className="flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700/90 text-slate-100 px-5 py-2.5 text-xs font-medium border border-white/10 shadow-lg hover:border-white/20 transition cursor-pointer"
              >
                <span>Select host</span>
              </button>
            </div>
          ) : (
            /* ── CONNECTED REMOTE BROWSER ── */
            <>
              {/* Header */}
              <div className="nx-sftp-toolbar flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] px-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <OsIcon os={remoteHost?.os} color={remoteHost?.color} size={28} />
                  <span className="font-semibold text-slate-100 text-sm truncate">
                    {remoteHost?.label || 'Remote Host'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {showRemoteSearch ? (
                    <div className="relative flex items-center">
                      <Search className="absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
                      <input
                        type="text"
                        value={remoteFilter}
                        onChange={(e) => setRemoteFilter(e.target.value)}
                        placeholder="Filter..."
                        autoFocus
                        className="h-7 w-36 rounded-lg bg-white/[0.06] pl-8 pr-6 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
                      />
                      {remoteFilter && (
                        <button
                          onClick={() => setRemoteFilter('')}
                          className="absolute right-2 text-slate-400 hover:text-white"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowRemoteSearch(true)}
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
                    >
                      <Search className="h-3.5 w-3.5" />
                      <span>Filter</span>
                    </button>
                  )}

                  {/* Quick New File & New Folder Buttons */}
                  <button
                    title="New Remote File"
                    onClick={() =>
                      setPromptDialog({
                        type: 'newFile',
                        side: 'remote',
                        title: 'New Remote File',
                        currentVal: 'new-file.txt',
                      })
                    }
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
                  >
                    <FilePlus className="h-3.5 w-3.5 text-cyan-400" />
                    <span className="hidden xl:inline">New File</span>
                  </button>

                  <button
                    title="New Remote Folder"
                    onClick={() =>
                      setPromptDialog({
                        type: 'newFolder',
                        side: 'remote',
                        title: 'New Remote Folder',
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
                      onClick={() => setShowRemoteActions((v) => !v)}
                      className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white border border-white/5 transition"
                    >
                      <span>Actions</span>
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </button>
                    {showRemoteActions && (
                      <>
                        <div
                          className="fixed inset-0 z-30"
                          onClick={() => setShowRemoteActions(false)}
                        />
                        <div className="absolute right-0 top-8 z-40 w-48 rounded-xl border border-white/10 bg-[#0e131d] p-1 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100">
                          <button
                            onClick={() => {
                              setShowRemoteActions(false);
                              setPromptDialog({
                                type: 'newFile',
                                side: 'remote',
                                title: 'New Remote File',
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
                              setShowRemoteActions(false);
                              setPromptDialog({
                                type: 'newFolder',
                                side: 'remote',
                                title: 'New Remote Folder',
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
                              setShowRemoteActions(false);
                              loadRemote(remotePath, false);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                          >
                            <RefreshCw className="h-3.5 w-3.5 text-emerald-400" />
                            <span>Refresh</span>
                          </button>
                          <button
                            onClick={() => {
                              setShowRemoteActions(false);
                              setShowHostPicker(true);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                          >
                            <Server className="h-3.5 w-3.5 text-amber-400" />
                            <span>Switch Host</span>
                          </button>
                          <div className="my-1 h-[1px] bg-white/10" />
                          <button
                            onClick={() => {
                              setShowRemoteActions(false);
                              setShowRemoteHidden((v) => !v);
                            }}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white"
                          >
                            <span>Show Hidden</span>
                            {showRemoteHidden && <Check className="h-3 w-3 text-cyan-400" />}
                          </button>
                          <div className="my-1 h-[1px] bg-white/10" />
                          <button
                            onClick={() => {
                              setShowRemoteActions(false);
                              disconnectRemote();
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-rose-400 hover:bg-rose-500/15"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>Disconnect</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Breadcrumbs Bar */}
              <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-black/10 px-3 text-xs">
                <div className="flex items-center gap-0.5">
                  <button
                    disabled={remoteHistoryIdx <= 0}
                    onClick={navigateRemoteBack}
                    className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    disabled={remoteHistoryIdx >= remoteHistory.length - 1}
                    onClick={navigateRemoteForward}
                    className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pl-1 text-slate-300">
                  <button
                    onClick={() => loadRemote('/')}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/[0.06] hover:text-white"
                  >
                    <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                    <span className="font-mono text-[11px]">/</span>
                  </button>
                  {remoteCrumbs.map((crumb, idx) => (
                    <div key={crumb.fullPath} className="flex items-center gap-1 shrink-0">
                      <ChevronRight className="h-3 w-3 text-slate-600 shrink-0" />
                      <button
                        onClick={() => loadRemote(crumb.fullPath)}
                        className={cn(
                          'flex items-center gap-1.5 rounded px-1.5 py-0.5 transition font-medium',
                          idx === remoteCrumbs.length - 1
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

              {/* Table Header */}
              <div className="flex h-8 shrink-0 items-center border-b border-white/[0.06] bg-black/20 px-4 text-[11px] font-medium text-slate-400">
                <div className="flex-1 min-w-0">Name</div>
                <div className="w-44 text-left hidden md:block">Date Modified</div>
                <div className="w-24 text-left hidden md:block">Size</div>
                <div className="w-20 text-left hidden lg:block">Kind</div>
              </div>

              {/* File List */}
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/[0.03]">
                {remoteLoading && (
                  <div className="flex items-center justify-center py-12 text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin mr-2 text-cyan-400" />
                    <span>Loading remote files...</span>
                  </div>
                )}

                {!remoteLoading && remotePath !== '/' && (
                  <div
                    onClick={() => { if (mobile) loadRemote(remotePath.replace(/\/[^/]+\/?$/, '') || '/'); }}
                    onDoubleClick={() => loadRemote(remotePath.replace(/\/[^/]+\/?$/, '') || '/')}
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

                {!remoteLoading &&
                  filteredRemote.map((entry) => {
                    const isSelected = remoteSelected === entry.path;
                    const Icon = fileIcon(entry);
                    return (
                      <div
                        key={entry.path}
                        draggable
                        onDragStart={(e) => handleDragStart(e, entry, 'remote')}
                        onClick={() => {
                      setRemoteSelected(entry.path);
                      if (mobile) { if (entry.isDir) loadRemote(entry.path); else setFileActions({ entry, side: 'remote' }); }
                    }}
                    onContextMenu={e => { if (mobile) { e.preventDefault(); setFileActions({ entry, side: 'remote' }); } }}
                        onDoubleClick={() => {
                          if (mobile) return;
                          if (entry.isDir) {
                            loadRemote(entry.path);
                          } else {
                            handleOpenFile(entry, true);
                          }
                        }}
                        className={cn(
                          'flex h-12 items-center px-4 cursor-pointer transition select-none group',
                          isSelected
                            ? 'bg-cyan-500/15 border-l-2 border-cyan-400'
                            : 'hover:bg-white/[0.04] border-l-2 border-transparent'
                        )}
                      >
                        {/* Name + Permissions */}
                        <div className="flex items-center gap-3 flex-1 min-w-0 pr-3">
                          <Icon
                            className={cn(
                              'h-4 w-4 shrink-0',
                              entry.isDir ? 'text-sky-400' : 'text-slate-400'
                            )}
                          />
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
                        <div className="w-20 text-slate-400 text-xs hidden lg:block">
                          {fmtKind(entry)}
                        </div>

                        {/* Quick Row Actions on Hover/Select */}
                        <button className="nx-touch-button md:hidden" aria-label={`Actions for ${entry.name}`} onClick={e => { e.stopPropagation(); setFileActions({ entry, side: 'remote' }); }}>•••</button>
                    <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                          {!entry.isDir && (
                            <button
                              title="Download to Local"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownload(entry);
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-emerald-500/20 hover:text-emerald-300"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {!entry.isDir && (
                            <button
                              title="Edit File"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenFile(entry, true);
                              }}
                              className="rounded p-1 text-slate-400 hover:bg-cyan-500/20 hover:text-cyan-300"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            title="Rename"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPromptDialog({
                                type: 'rename',
                                side: 'remote',
                                title: 'Rename Remote File',
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
                              requestDelete(entry, 'remote');
                            }}
                            className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                {!remoteLoading && !filteredRemote.length && (
                  <div className="py-16 text-center text-xs text-slate-500">
                    {remoteFilter ? 'No files match filter' : 'Empty directory'}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ==================================================================== */}
      {/* HOST PICKER MODAL */}
      {/* ==================================================================== */}
      {showHostPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div
            className="fixed inset-0"
            onClick={() => setShowHostPicker(false)}
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
                  <h3 className="text-sm font-semibold text-white">Select SFTP Host</h3>
                  <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    Connect directly to browse and transfer files
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowHostPicker(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
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
                  placeholder="Search by label, host, username or tag..."
                  autoFocus
                  className="h-9 w-full rounded-xl bg-white/[0.05] pl-10 pr-4 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:outline-none focus:ring-1 transition"
                  style={{
                    borderColor: hostPickerSearch ? `${accentColor}50` : undefined,
                  }}
                />
              </div>
            </div>

            {/* Hosts List */}
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {filteredHosts.map((h) => (
                <div
                  key={h.id}
                  onClick={() => connectRemote(h.id)}
                  className="group flex items-center justify-between rounded-xl p-3 bg-white/[0.03] hover:bg-white/[0.07] border border-white/5 hover:border-white/15 cursor-pointer transition shadow-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <OsIcon os={h.os} color={h.color || accentColor} size={34} />
                    <div className="flex flex-col min-w-0">
                      <span className="font-semibold text-xs text-slate-100 group-hover:text-white truncate">
                        {h.label}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400 truncate">
                        {h.username}@{h.hostname}{h.port !== 22 ? `:${h.port}` : ''}
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
                    <div
                      className="grid h-8 w-8 place-items-center rounded-xl border transition shadow-sm"
                      style={{
                        backgroundColor: `${accentColor}18`,
                        borderColor: `${accentColor}35`,
                        color: accentColor,
                        boxShadow: `0 0 12px ${accentColor}15`,
                      }}
                    >
                      <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>
                </div>
              ))}

              {!filteredHosts.length && (
                <div className="py-12 text-center text-xs text-slate-500">
                  {hostPickerSearch ? 'No hosts match your search' : 'No saved hosts found in vault'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* PROMPT MODAL (New folder / Rename) */}
      {/* ==================================================================== */}
      {promptDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div
            className="fixed inset-0"
            onClick={() => setPromptDialog(null)}
          />
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
              <h3 className="font-semibold text-sm text-slate-100">
                {promptDialog.title}
              </h3>
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
                  className="rounded-xl px-3.5 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl border px-4 py-1.5 text-xs font-semibold transition shadow-sm"
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
      )}

      {/* ==================================================================== */}
      {/* DELETE CONFIRMATION WARNING MODAL */}
      {/* ==================================================================== */}
      {deleteConfirm && (
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
                  <span>Delete {deleteConfirm.entry.isDir ? 'Folder' : 'File'}?</span>
                  <span className="text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 border border-rose-500/30 bg-rose-500/10 text-rose-400">
                    {deleteConfirm.side === 'remote' ? (remoteHost?.label || 'Remote') : 'Local'}
                  </span>
                </h3>
                <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                  Are you sure you want to permanently delete{' '}
                  <span className="font-mono text-white font-semibold break-all bg-white/[0.06] px-1.5 py-0.5 rounded border border-white/10">
                    {deleteConfirm.entry.name}
                  </span>
                  ?
                </p>
                {deleteConfirm.entry.isDir ? (
                  <p className="text-[11px] text-amber-400/90 mt-2 flex items-center gap-1.5">
                    <span>⚠️</span>
                    <span>This will permanently delete this directory and all contents inside.</span>
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-400 mt-2">
                    This file will be permanently removed. This action cannot be undone.
                  </p>
                )}
                <div className="mt-3 rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-400 font-mono truncate">
                  {deleteConfirm.entry.path}
                </div>
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
                {deleteConfirm.deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                <span>{deleteConfirm.deleting ? 'Deleting...' : 'Delete Permanently'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TEXT FILE VIEWER / EDITOR (FULL SCREEN OVERLAY) */}
      {/* ==================================================================== */}
      {editingFile && (
        <SftpCodeEditor
          file={editingFile}
          hostLabel={editingFile.isRemote ? (remoteHost?.label || 'Remote Host') : 'Local Machine'}
          onSave={handleSaveFile}
          onClose={() => setEditingFile(null)}
          toast={toast}
          theme={activeTheme}
        />
      )}
    </div>
  );
}
