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
  Trash2,
  AlertTriangle,
  Edit2,
  X,
  Loader2,
  Server,
  ArrowRight,
  ArrowLeft,
  ArrowLeftRight,
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
import { THEMES, type DrexiusTheme } from '../lib/themes';
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
  theme?: DrexiusTheme;
}

export function SftpTab({ tab, hosts, onUpdateTab, toast, theme, active = true }: SftpTabProps) {
  const mobile = useMobile();
  const [mobileSide, setMobileSide] = useState<'left' | 'right'>('right');
  const [fileActions, setFileActions] = useState<{ entry: FileEntry; side: 'left' | 'right' } | null>(null);
  const [permissions, setPermissions] = useState<FileEntry | null>(null);

  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent || '#22d3ee';
  const bgColor = activeTheme.xterm.background || '#090d16';

  // ── LEFT PANE STATE (Defaults to Local Machine: hostId = null) ──
  const [leftHostId, setLeftHostId] = useState<string | null>(tab.sftpLeftHostId ?? null);
  const [leftSessionId, setLeftSessionId] = useState<string | null>(tab.sftpLeftSessionId ?? null);
  const leftSessionRef = useRef<string | null>(tab.sftpLeftSessionId ?? null);
  const [leftConnecting, setLeftConnecting] = useState<boolean>(false);
  const [leftPath, setLeftPath] = useState<string>('');
  const [leftEntries, setLeftEntries] = useState<FileEntry[]>([]);
  const [leftLoading, setLeftLoading] = useState<boolean>(false);
  const [leftFilter, setLeftFilter] = useState<string>('');
  const [showLeftSearch, setShowLeftSearch] = useState<boolean>(false);
  const [showLeftHidden, setShowLeftHidden] = useState<boolean>(false);
  const [leftSelected, setLeftSelected] = useState<string | null>(null);
  const [leftHistory, setLeftHistory] = useState<string[]>([]);
  const [leftHistoryIdx, setLeftHistoryIdx] = useState<number>(-1);
  const [showLeftActions, setShowLeftActions] = useState<boolean>(false);

  // ── RIGHT PANE STATE (Defaults to remote host if provided, else null) ──
  const initialRightHostId = tab.sftpRightHostId ?? tab.sftpHostId ?? null;
  const initialRightSessionId = tab.sftpRightSessionId ?? tab.sftpSessionId ?? null;
  const [rightHostId, setRightHostId] = useState<string | null>(initialRightHostId);
  const [rightSessionId, setRightSessionId] = useState<string | null>(initialRightSessionId);
  const rightSessionRef = useRef<string | null>(initialRightSessionId);
  const [rightConnecting, setRightConnecting] = useState<boolean>(false);
  const [rightPath, setRightPath] = useState<string>('');
  const [rightEntries, setRightEntries] = useState<FileEntry[]>([]);
  const [rightLoading, setRightLoading] = useState<boolean>(false);
  const [rightFilter, setRightFilter] = useState<string>('');
  const [showRightSearch, setShowRightSearch] = useState<boolean>(false);
  const [showRightHidden, setShowRightHidden] = useState<boolean>(false);
  const [rightSelected, setRightSelected] = useState<string | null>(null);
  const [rightHistory, setRightHistory] = useState<string[]>([]);
  const [rightHistoryIdx, setRightHistoryIdx] = useState<number>(-1);
  const [showRightActions, setShowRightActions] = useState<boolean>(false);

  // Keep references in sync for async callbacks
  const leftHostIdRef = useRef(leftHostId);
  leftHostIdRef.current = leftHostId;
  const rightHostIdRef = useRef(rightHostId);
  rightHostIdRef.current = rightHostId;
  const leftEntriesRef = useRef<FileEntry[]>([]);
  leftEntriesRef.current = leftEntries;
  const rightEntriesRef = useRef<FileEntry[]>([]);
  rightEntriesRef.current = rightEntries;

  // ── Connection & Lifecycle Refs ──
  const mountedRef = useRef(true);
  const connectGenerationRef = useRef({ left: 0, right: 0 });
  const connectingRef = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [connectingSide, setConnectingSide] = useState<'left' | 'right' | null>(null);

  // The tab owns its SFTP sessions. Close them when the tab unmounts.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (mountedRef.current) return;
        connectGenerationRef.current.left++;
        connectGenerationRef.current.right++;
        if (leftSessionRef.current) {
          bridge.sftpClose(leftSessionRef.current).catch(() => {});
          leftSessionRef.current = null;
        }
        if (rightSessionRef.current) {
          bridge.sftpClose(rightSessionRef.current).catch(() => {});
          rightSessionRef.current = null;
        }
      }, 0);
    };
  }, []);

  // ── Modals & Dialogs ──
  const [hostPickerSide, setHostPickerSide] = useState<'left' | 'right' | null>(null);
  const [hostPickerSearch, setHostPickerSearch] = useState<string>('');
  const [transferStatus, setTransferStatus] = useState<{
    type: 'upload' | 'download';
    filename: string;
    progress: number;
  } | null>(null);

  // Text file editor
  const [editingFile, setEditingFile] = useState<(EditorFile & { side: 'left' | 'right' }) | null>(null);

  // New file, new folder & rename dialogs
  const [promptDialog, setPromptDialog] = useState<{
    type: 'newFile' | 'newFolder' | 'rename';
    side: 'left' | 'right';
    title: string;
    currentVal: string;
    targetPath?: string;
  } | null>(null);

  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{
    entry: FileEntry;
    side: 'left' | 'right';
    deleting?: boolean;
  } | null>(null);

  const leftHost = useMemo(() => {
    return hosts.find((h) => h.id === leftHostId) || null;
  }, [hosts, leftHostId]);

  const rightHost = useMemo(() => {
    return hosts.find((h) => h.id === rightHostId) || null;
  }, [hosts, rightHostId]);

  // ── Generic Pane Loader ──
  const loadPane = useCallback(
    async (
      side: 'left' | 'right',
      targetPath?: string,
      recordHistory = true,
      overrideHostId?: string | null,
      overrideSid?: string | null
    ) => {
      const isLeft = side === 'left';
      const effectiveHostId = overrideHostId !== undefined ? overrideHostId : (isLeft ? leftHostIdRef.current : rightHostIdRef.current);
      const effectiveSid = overrideSid !== undefined ? overrideSid : (isLeft ? leftSessionRef.current : rightSessionRef.current);

      if (isLeft) setLeftLoading(true);
      else setRightLoading(true);

      try {
        if (!effectiveHostId) {
          // Local Filesystem
          const res = await bridge.localFsList(targetPath);
          if (isLeft) {
            setLeftPath(res.currentPath);
            setLeftEntries(res.entries);
            if (recordHistory) {
              setLeftHistory((prev) => [...prev.slice(0, leftHistoryIdx + 1), res.currentPath]);
              setLeftHistoryIdx((prev) => prev + 1);
            }
          } else {
            setRightPath(res.currentPath);
            setRightEntries(res.entries);
            if (recordHistory) {
              setRightHistory((prev) => [...prev.slice(0, rightHistoryIdx + 1), res.currentPath]);
              setRightHistoryIdx((prev) => prev + 1);
            }
          }
        } else {
          // Remote SFTP
          if (!effectiveSid) return;
          const currentP = isLeft ? leftPath : rightPath;
          const p = targetPath ?? currentP;
          const list = await bridge.sftpList(effectiveSid, p);
          if (isLeft) {
            setLeftPath(p);
            setLeftEntries(list);
            if (recordHistory) {
              setLeftHistory((prev) => [...prev.slice(0, leftHistoryIdx + 1), p]);
              setLeftHistoryIdx((prev) => prev + 1);
            }
          } else {
            setRightPath(p);
            setRightEntries(list);
            if (recordHistory) {
              setRightHistory((prev) => [...prev.slice(0, rightHistoryIdx + 1), p]);
              setRightHistoryIdx((prev) => prev + 1);
            }
          }
        }
      } catch (err) {
        toast(isBridgeError(err) ? err.message : String(err));
        throw err;
      } finally {
        if (isLeft) setLeftLoading(false);
        else setRightLoading(false);
      }
    },
    [leftHistoryIdx, rightHistoryIdx, leftPath, rightPath, toast]
  );

  // ── Connect Remote Host to a Side ──
  const connectHost = useCallback(
    async (side: 'left' | 'right', hostId: string) => {
      const isLeft = side === 'left';
      if (connectingRef.current[side]) return;
      connectingRef.current[side] = true;

      const targetHost = hosts.find((h) => h.id === hostId);
      const hostLabel = targetHost?.label || 'Host';

      const gen = isLeft
        ? ++connectGenerationRef.current.left
        : ++connectGenerationRef.current.right;
      if (isLeft) {
        setLeftConnecting(true);
        setLeftHostId(hostId);
      } else {
        setRightConnecting(true);
        setRightHostId(hostId);
      }
      setConnectingSide(side);
      setConnectingHostId(hostId);

      let sid: string | null = null;
      try {
        sid = await bridge.sftpConnect(hostId);
        const list = await bridge.sftpList(sid, '');
        if (!mountedRef.current) {
          await bridge.sftpClose(sid);
          return;
        }
        const currentGen = isLeft ? connectGenerationRef.current.left : connectGenerationRef.current.right;
        if (gen !== currentGen) {
          await bridge.sftpClose(sid);
          return;
        }

        const initialP = list[0]?.path.slice(0, list[0].path.lastIndexOf('/')) || bridge.homeFor(sid) || '/';

        if (isLeft) {
          const prev = leftSessionRef.current;
          leftSessionRef.current = sid;
          if (prev && prev !== sid) bridge.sftpClose(prev).catch(() => {});
          setLeftSessionId(sid);
          setLeftEntries(list);
          setLeftPath(initialP);
          setLeftHistory([initialP]);
          setLeftHistoryIdx(0);
          onUpdateTab({
            sftpLeftHostId: hostId,
            sftpLeftSessionId: sid,
            title: rightHostIdRef.current ? `SFTP: ${hostLabel} ↔ ${hosts.find((h) => h.id === rightHostIdRef.current)?.label || 'Remote'}` : `SFTP: ${hostLabel}`,
          });
        } else {
          const prev = rightSessionRef.current;
          rightSessionRef.current = sid;
          if (prev && prev !== sid) bridge.sftpClose(prev).catch(() => {});
          setRightSessionId(sid);
          setRightEntries(list);
          setRightPath(initialP);
          setRightHistory([initialP]);
          setRightHistoryIdx(0);
          onUpdateTab({
            sftpRightHostId: hostId,
            sftpRightSessionId: sid,
            sftpHostId: hostId,
            sftpSessionId: sid,
            title: leftHostIdRef.current ? `SFTP: ${hosts.find((h) => h.id === leftHostIdRef.current)?.label || 'Local'} ↔ ${hostLabel}` : `SFTP: ${hostLabel}`,
          });
        }
        setHostPickerSide(null);
        toast(`Connected to ${hostLabel}`);
      } catch (err) {
        if (sid) await bridge.sftpClose(sid);
        if (mountedRef.current) {
          toast(isBridgeError(err) ? err.message : `Connection failed: ${err}`);
        }
      } finally {
        connectingRef.current[side] = false;
        if (mountedRef.current) {
          if (isLeft) setLeftConnecting(false);
          else setRightConnecting(false);
          setConnectingSide(null);
          setConnectingHostId(null);
        }
      }
    },
    [hosts, onUpdateTab, toast]
  );

  // ── Switch Side to Local Filesystem ──
  const switchToLocal = useCallback(
    async (side: 'left' | 'right') => {
      setHostPickerSide(null);
      if (side === 'left') {
        connectGenerationRef.current.left++;
        if (leftSessionRef.current) {
          bridge.sftpClose(leftSessionRef.current).catch(() => {});
          leftSessionRef.current = null;
        }
        setLeftSessionId(null);
        setLeftHostId(null);
        onUpdateTab({
          sftpLeftHostId: null,
          sftpLeftSessionId: null,
          title: rightHostId ? `SFTP: ${hosts.find((h) => h.id === rightHostId)?.label || 'Remote'}` : 'Files: Local',
        });
        await loadPane('left', '', true, null, null);
        toast('Left pane switched to Local Machine');
      } else {
        connectGenerationRef.current.right++;
        if (rightSessionRef.current) {
          bridge.sftpClose(rightSessionRef.current).catch(() => {});
          rightSessionRef.current = null;
        }
        setRightSessionId(null);
        setRightHostId(null);
        onUpdateTab({
          sftpRightHostId: null,
          sftpRightSessionId: null,
          sftpHostId: null,
          sftpSessionId: null,
          title: leftHostId ? `SFTP: ${hosts.find((h) => h.id === leftHostId)?.label || 'Remote'}` : 'Files: Local',
        });
        await loadPane('right', '', true, null, null);
        toast('Right pane switched to Local Machine');
      }
    },
    [hosts, leftHostId, rightHostId, loadPane, onUpdateTab, toast]
  );

  // ── Disconnect a Remote Side ──
  const disconnectSide = useCallback(
    (side: 'left' | 'right') => {
      const isLeft = side === 'left';
      if (isLeft) {
        connectGenerationRef.current.left++;
        const sid = leftSessionRef.current;
        leftSessionRef.current = null;
        if (sid) bridge.sftpClose(sid).catch(() => {});
        setLeftSessionId(null);
        setLeftHostId(null);
        setLeftEntries([]);
        setLeftPath('');
        setLeftHistory([]);
        setLeftHistoryIdx(-1);
        onUpdateTab({ sftpLeftHostId: null, sftpLeftSessionId: null });
      } else {
        connectGenerationRef.current.right++;
        const sid = rightSessionRef.current;
        rightSessionRef.current = null;
        if (sid) bridge.sftpClose(sid).catch(() => {});
        setRightSessionId(null);
        setRightHostId(null);
        setRightEntries([]);
        setRightPath('');
        setRightHistory([]);
        setRightHistoryIdx(-1);
        onUpdateTab({ sftpRightHostId: null, sftpRightSessionId: null, sftpHostId: null, sftpSessionId: null });
      }
      toast(`${isLeft ? 'Left' : 'Right'} pane disconnected`);
    },
    [onUpdateTab, toast]
  );

  // ── Swap Left and Right Panes ──
  const handleSwapPanes = useCallback(() => {
    const oldLeftHost = leftHostId;
    const oldRightHost = rightHostId;
    const oldLeftSid = leftSessionId;
    const oldRightSid = rightSessionId;

    setLeftHostId(oldRightHost);
    setRightHostId(oldLeftHost);
    setLeftSessionId(oldRightSid);
    setRightSessionId(oldLeftSid);
    leftSessionRef.current = oldRightSid;
    rightSessionRef.current = oldLeftSid;

    const oldLeftPath = leftPath;
    const oldRightPath = rightPath;
    const oldLeftEntries = leftEntries;
    const oldRightEntries = rightEntries;

    setLeftPath(oldRightPath);
    setRightPath(oldLeftPath);
    setLeftEntries(oldRightEntries);
    setRightEntries(oldLeftEntries);

    const oldLeftHist = leftHistory;
    const oldRightHist = rightHistory;
    const oldLeftIdx = leftHistoryIdx;
    const oldRightIdx = rightHistoryIdx;

    setLeftHistory(oldRightHist);
    setRightHistory(oldLeftHist);
    setLeftHistoryIdx(oldRightIdx);
    setRightHistoryIdx(oldLeftIdx);

    setLeftSelected(null);
    setRightSelected(null);
    setLeftFilter('');
    setRightFilter('');

    onUpdateTab({
      sftpLeftHostId: oldRightHost,
      sftpLeftSessionId: oldRightSid,
      sftpRightHostId: oldLeftHost,
      sftpRightSessionId: oldLeftSid,
      sftpHostId: oldLeftHost,
      sftpSessionId: oldLeftSid,
    });
    toast('Swapped left and right panes');
  }, [
    leftHostId,
    rightHostId,
    leftSessionId,
    rightSessionId,
    leftPath,
    rightPath,
    leftEntries,
    rightEntries,
    leftHistory,
    rightHistory,
    leftHistoryIdx,
    rightHistoryIdx,
    onUpdateTab,
    toast,
  ]);

  // ── Initial Mount: Connect configured panes once ──
  useEffect(() => {
    // Left pane
    if (tab.sftpLeftHostId) {
      connectHost('left', tab.sftpLeftHostId);
    } else {
      loadPane('left', '', true, null, null).catch(() => {});
    }

    // Right pane
    const targetRight = tab.sftpRightHostId || tab.sftpHostId;
    if (targetRight) {
      connectHost('right', targetRight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ensure Connected: Only connects or reloads IF pane is configured but currently empty ──
  const ensureConnectedIfEmpty = useCallback(() => {
    // Re-check Left side: only connect if configured but no files currently displayed
    if (leftHostIdRef.current) {
      if (leftEntriesRef.current.length === 0 && !connectingRef.current.left) {
        if (leftSessionRef.current) {
          loadPane('left', undefined, false).catch(() => {
            if (leftHostIdRef.current) connectHost('left', leftHostIdRef.current);
          });
        } else {
          connectHost('left', leftHostIdRef.current);
        }
      }
    } else if (leftEntriesRef.current.length === 0 && !leftLoading) {
      loadPane('left', '', true, null, null).catch(() => {});
    }

    // Re-check Right side: only connect if configured but no files currently displayed
    const targetRight = rightHostIdRef.current || tab.sftpRightHostId || tab.sftpHostId;
    if (targetRight) {
      if (rightEntriesRef.current.length === 0 && !connectingRef.current.right) {
        if (rightSessionRef.current) {
          loadPane('right', undefined, false).catch(() => {
            if (targetRight) connectHost('right', targetRight);
          });
        } else {
          connectHost('right', targetRight);
        }
      }
    }
  }, [connectHost, loadPane, tab.sftpRightHostId, tab.sftpHostId, leftLoading]);

  // ── Tab Active Transition: connect only if pane has no files loaded ──
  const prevActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;

    if (!wasActive && active) {
      ensureConnectedIfEmpty();
    }
  }, [active, ensureConnectedIfEmpty]);

  // ── App Resume from Background: reconnect only if connection dropped and no files displayed ──
  useEffect(() => {
    if (!active) return;
    const handleResume = () => {
      if (document.visibilityState !== 'visible') return;
      ensureConnectedIfEmpty();
    };

    document.addEventListener('visibilitychange', handleResume);
    return () => {
      document.removeEventListener('visibilitychange', handleResume);
    };
  }, [active, ensureConnectedIfEmpty]);

  // ── Navigation Handlers ──
  const navigateBack = (side: 'left' | 'right') => {
    const isLeft = side === 'left';
    const hist = isLeft ? leftHistory : rightHistory;
    const idx = isLeft ? leftHistoryIdx : rightHistoryIdx;
    if (idx > 0) {
      const prev = hist[idx - 1];
      if (isLeft) setLeftHistoryIdx((i) => i - 1);
      else setRightHistoryIdx((i) => i - 1);
      loadPane(side, prev, false);
    }
  };

  const navigateForward = (side: 'left' | 'right') => {
    const isLeft = side === 'left';
    const hist = isLeft ? leftHistory : rightHistory;
    const idx = isLeft ? leftHistoryIdx : rightHistoryIdx;
    if (idx < hist.length - 1) {
      const next = hist[idx + 1];
      if (isLeft) setLeftHistoryIdx((i) => i + 1);
      else setRightHistoryIdx((i) => i + 1);
      loadPane(side, next, false);
    }
  };

  // Breadcrumbs parsing
  const leftCrumbs = useMemo(() => {
    if (!leftPath) return [];
    const parts = leftPath.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      fullPath: '/' + parts.slice(0, index + 1).join('/'),
    }));
  }, [leftPath]);

  const rightCrumbs = useMemo(() => {
    if (!rightPath) return [];
    const parts = rightPath.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      fullPath: '/' + parts.slice(0, index + 1).join('/'),
    }));
  }, [rightPath]);

  // ── Unified File Transfer (Local ↔ Remote, Remote ↔ Remote, Local ↔ Local) ──
  const handleTransfer = async (entry: FileEntry, fromSide: 'left' | 'right') => {
    const toSide = fromSide === 'left' ? 'right' : 'left';
    const fromIsRemote = fromSide === 'left' ? !!leftHostId : !!rightHostId;
    const toIsRemote = toSide === 'left' ? !!leftHostId : !!rightHostId;
    const fromSid = fromSide === 'left' ? leftSessionId : rightSessionId;
    const toSid = toSide === 'left' ? leftSessionId : rightSessionId;
    const toPath = toSide === 'left' ? leftPath : rightPath;

    const toLabel = toSide === 'left'
      ? (hosts.find((h) => h.id === leftHostId)?.label || 'Local')
      : (hosts.find((h) => h.id === rightHostId)?.label || 'Local');

    if (toIsRemote && !toSid) {
      toast(`Please connect ${toLabel} first`);
      return;
    }
    if (!toPath) {
      toast(`Invalid target path on ${toLabel}`);
      return;
    }

    const targetDestPath = `${toPath.replace(/\/$/, '')}/${entry.name}`;
    setTransferStatus({
      type: fromIsRemote && !toIsRemote ? 'download' : 'upload',
      filename: entry.name,
      progress: 0,
    });

    try {
      if (!fromIsRemote && !toIsRemote) {
        // Local -> Local
        await bridge.localFsCopy(entry.path, targetDestPath);
      } else if (!fromIsRemote && toIsRemote) {
        // Local -> Remote (Upload)
        await bridge.sftpUploadDirect(
          toSid!,
          entry.path,
          targetDestPath,
          (pct) => setTransferStatus((s) => s && { ...s, progress: pct })
        );
      } else if (fromIsRemote && !toIsRemote) {
        // Remote -> Local (Download)
        await bridge.sftpDownloadDirect(
          fromSid!,
          entry.path,
          targetDestPath,
          (pct) => setTransferStatus((s) => s && { ...s, progress: pct })
        );
      } else {
        // Remote -> Remote (Direct Server Transfer)
        await bridge.sftpTransferRemoteDirect(
          fromSid!,
          entry.path,
          toSid!,
          targetDestPath,
          (pct) => setTransferStatus((s) => s && { ...s, progress: pct })
        );
      }
      toast(`Transferred ${entry.name} to ${toLabel}`);
      await loadPane(toSide, toPath, false);
    } catch (err) {
      toast(isBridgeError(err) ? err.message : `Transfer failed: ${err}`);
    } finally {
      setTimeout(() => setTransferStatus(null), 400);
    }
  };

  // ── Drag and Drop Between Panes ──
  const handleDragStart = (e: React.DragEvent, entry: FileEntry, side: 'left' | 'right') => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ side, entry }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = async (e: React.DragEvent, targetSide: 'left' | 'right') => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.side && data.side !== targetSide && data.entry) {
        await handleTransfer(data.entry, data.side);
      }
    } catch (_) {}
  };

  // ── File Actions (Delete, Rename, New Folder, View/Edit) ──
  const requestDelete = (entry: FileEntry, side: 'left' | 'right') => {
    setDeleteConfirm({ entry, side });
  };

  const handleExecuteDelete = async () => {
    if (!deleteConfirm) return;
    const { entry, side } = deleteConfirm;
    const isRemote = side === 'left' ? !!leftHostId : !!rightHostId;
    const sid = side === 'left' ? leftSessionId : rightSessionId;
    const currentP = side === 'left' ? leftPath : rightPath;

    setDeleteConfirm((prev) => prev && { ...prev, deleting: true });
    try {
      if (!isRemote) {
        await bridge.localFsRemove(entry.path, entry.isDir);
        toast(`Deleted ${entry.name}`);
        setDeleteConfirm(null);
        loadPane(side, currentP, false);
      } else if (sid) {
        await bridge.sftpRemove(sid, entry.path, entry.isDir);
        toast(`Deleted ${entry.name}`);
        setDeleteConfirm(null);
        loadPane(side, currentP, false);
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
        hostPickerSide ||
        deleteConfirm
      ) {
        return;
      }

      if (e.key === 'Delete') {
        if (rightSelected) {
          const entry = rightEntries.find((r) => r.path === rightSelected);
          if (entry) {
            e.preventDefault();
            requestDelete(entry, 'right');
          }
        } else if (leftSelected) {
          const entry = leftEntries.find((l) => l.path === leftSelected);
          if (entry) {
            e.preventDefault();
            requestDelete(entry, 'left');
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, rightSelected, leftSelected, rightEntries, leftEntries, editingFile, promptDialog, hostPickerSide, deleteConfirm]);

  const handleOpenFile = async (entry: FileEntry, side: 'left' | 'right') => {
    if (entry.isDir) return;
    const isRemote = side === 'left' ? !!leftHostId : !!rightHostId;
    const sid = side === 'left' ? leftSessionId : rightSessionId;
    try {
      if (isRemote && sid) {
        const text = await bridge.sftpReadText(sid, entry.path);
        setEditingFile({
          path: entry.path,
          name: entry.name,
          content: text,
          isRemote: true,
          side,
        });
      } else if (!isRemote) {
        const text = await bridge.localFsReadText(entry.path);
        setEditingFile({
          path: entry.path,
          name: entry.name,
          content: text,
          isRemote: false,
          side,
        });
      }
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
    }
  };

  const handleSaveFile = async (newContent: string) => {
    if (!editingFile) return;
    const { side, isRemote } = editingFile;
    const sid = side === 'left' ? leftSessionId : rightSessionId;
    const currentP = side === 'left' ? leftPath : rightPath;

    if (isRemote && sid) {
      await bridge.sftpWriteText(sid, editingFile.path, newContent);
      setEditingFile((prev) => (prev ? { ...prev, content: newContent } : null));
      loadPane(side, currentP, false);
    } else if (!isRemote) {
      await bridge.localFsWriteText(editingFile.path, newContent);
      setEditingFile((prev) => (prev ? { ...prev, content: newContent } : null));
      loadPane(side, currentP, false);
    }
  };

  const handlePromptSubmit = async (val: string) => {
    if (!promptDialog || !val.trim()) {
      setPromptDialog(null);
      return;
    }
    const { type, side, targetPath } = promptDialog;
    const isRemote = side === 'left' ? !!leftHostId : !!rightHostId;
    const sid = side === 'left' ? leftSessionId : rightSessionId;
    const currentP = side === 'left' ? leftPath : rightPath;

    try {
      if (type === 'newFile') {
        const filename = val.trim();
        const newPath = `${currentP.replace(/\/$/, '')}/${filename}`;
        if (!isRemote) {
          await bridge.localFsWriteText(newPath, '');
          toast(`Created file "${filename}"`);
          await loadPane(side, currentP, false);
          setEditingFile({
            path: newPath,
            name: filename,
            content: '',
            isRemote: false,
            side,
          });
        } else if (sid) {
          await bridge.sftpWriteText(sid, newPath, '');
          toast(`Created file "${filename}"`);
          await loadPane(side, currentP, false);
          setEditingFile({
            path: newPath,
            name: filename,
            content: '',
            isRemote: true,
            side,
          });
        }
      } else if (type === 'newFolder') {
        const foldername = val.trim();
        const newDir = `${currentP.replace(/\/$/, '')}/${foldername}`;
        if (!isRemote) {
          await bridge.localFsMkdir(newDir);
          toast(`Created folder "${foldername}"`);
          loadPane(side, currentP, false);
        } else if (sid) {
          await bridge.sftpMkdir(sid, newDir);
          toast(`Created folder "${foldername}"`);
          loadPane(side, currentP, false);
        }
      } else if (type === 'rename' && targetPath) {
        const dir = targetPath.slice(0, targetPath.lastIndexOf('/'));
        const newPath = `${dir}/${val.trim()}`;
        if (!isRemote) {
          await bridge.localFsRename(targetPath, newPath);
          toast(`Renamed to "${val.trim()}"`);
          loadPane(side, currentP, false);
        } else if (sid) {
          await bridge.sftpRename(sid, targetPath, newPath);
          toast(`Renamed to "${val.trim()}"`);
          loadPane(side, currentP, false);
        }
      }
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
    } finally {
      setPromptDialog(null);
    }
  };

  // Filtered file lists
  const filteredLeft = useMemo(() => {
    return leftEntries.filter((e) => {
      if (!showLeftHidden && e.name.startsWith('.')) return false;
      if (leftFilter && !e.name.toLowerCase().includes(leftFilter.toLowerCase())) return false;
      return true;
    });
  }, [leftEntries, showLeftHidden, leftFilter]);

  const filteredRight = useMemo(() => {
    return rightEntries.filter((e) => {
      if (!showRightHidden && e.name.startsWith('.')) return false;
      if (rightFilter && !e.name.toLowerCase().includes(rightFilter.toLowerCase())) return false;
      return true;
    });
  }, [rightEntries, showRightHidden, rightFilter]);

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

  // ── Render Single Pane ──
  const renderPane = (side: 'left' | 'right') => {
    const isLeft = side === 'left';
    const hostId = isLeft ? leftHostId : rightHostId;
    const host = isLeft ? leftHost : rightHost;
    const sessionId = isLeft ? leftSessionId : rightSessionId;
    const connecting = isLeft ? leftConnecting : rightConnecting;
    const path = isLeft ? leftPath : rightPath;
    const crumbs = isLeft ? leftCrumbs : rightCrumbs;
    const entries = isLeft ? filteredLeft : filteredRight;
    const loading = isLeft ? leftLoading : rightLoading;
    const filter = isLeft ? leftFilter : rightFilter;
    const setFilter = isLeft ? setLeftFilter : setRightFilter;
    const showSearch = isLeft ? showLeftSearch : showRightSearch;
    const setShowSearch = isLeft ? setShowLeftSearch : setShowRightSearch;
    const showHidden = isLeft ? showLeftHidden : showRightHidden;
    const setShowHidden = isLeft ? setShowLeftHidden : setShowRightHidden;
    const selected = isLeft ? leftSelected : rightSelected;
    const setSelected = isLeft ? setLeftSelected : setRightSelected;
    const histIdx = isLeft ? leftHistoryIdx : rightHistoryIdx;
    const hist = isLeft ? leftHistory : rightHistory;
    const showActions = isLeft ? showLeftActions : showRightActions;
    const setShowActions = isLeft ? setShowLeftActions : setShowRightActions;

    const isDisconnectedRemote = hostId !== null && !sessionId && !connecting;

    return (
      <div
        key={side}
        className={cn(
          "flex flex-1 min-w-0 flex-col bg-transparent relative",
          mobileSide !== side && "max-md:hidden"
        )}
        role="region"
        aria-label={`${isLeft ? 'Left' : 'Right'} pane files`}
        onDragOver={handleDragOver}
        onDrop={(e) => handleDrop(e, side)}
      >
        {connecting ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400 mb-3" />
            <h3 className="text-sm font-semibold text-slate-200">
              Connecting to {hosts.find((h) => h.id === connectingHostId)?.label || host?.label || 'Host'}...
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Authenticating and establishing SFTP session
            </p>
          </div>
        ) : isDisconnectedRemote ? (
          /* ── DISCONNECTED REMOTE PLACEHOLDER ── */
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/[0.05] border border-white/10 shadow-xl mb-4">
              <Folder className="h-8 w-8 text-slate-300" />
            </div>

            <h2 className="text-base font-semibold text-slate-100 mb-1">
              Connect to {host?.label || 'host'}
            </h2>
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
                      <button
                        onClick={() => setFilter('')}
                        className="absolute right-2 text-slate-400 hover:text-white"
                      >
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

            {/* Breadcrumbs Bar */}
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-black/10 px-3 text-xs">
              <div className="flex items-center gap-0.5">
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
                  onClick={() => loadPane(side, '/')}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/[0.06] hover:text-white"
                >
                  <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  <span className="font-mono text-[11px]">/</span>
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

            {/* Table Header */}
            <div className="flex h-8 shrink-0 items-center border-b border-white/[0.06] bg-black/20 px-4 text-[11px] font-medium text-slate-400">
              <div className="flex-1 min-w-0">Name</div>
              <div className="w-44 text-left hidden md:block">Date Modified</div>
              <div className="w-24 text-left hidden md:block">Size</div>
              <div className="w-20 text-left hidden lg:block">Kind</div>
            </div>

            {/* File List */}
            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/[0.03]">
              {loading && (
                <div className="flex items-center justify-center py-12 text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin mr-2 text-cyan-400" />
                  <span>Loading files...</span>
                </div>
              )}

              {!loading && path !== '/' && (
                <div
                  onClick={() => {
                    const parentP = path.replace(/\/[^/]+\/?$/, '') || '/';
                    if (mobile) loadPane(side, parentP);
                  }}
                  onDoubleClick={() => {
                    const parentP = path.replace(/\/[^/]+\/?$/, '') || '/';
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
                  const isSelected = selected === entry.path;
                  const Icon = fileIcon(entry);
                  return (
                    <div
                      key={entry.path}
                      draggable
                      onDragStart={(e) => handleDragStart(e, entry, side)}
                      onClick={() => {
                        setSelected(entry.path);
                        if (mobile) {
                          if (entry.isDir) loadPane(side, entry.path);
                          else setFileActions({ entry, side });
                        }
                      }}
                      onContextMenu={(e) => {
                        if (mobile) {
                          e.preventDefault();
                          setFileActions({ entry, side });
                        }
                      }}
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
                      {/* Name + Permissions */}
                      <div className="flex items-center gap-3 flex-1 min-w-0 pr-3">
                        <Icon
                          className={cn('h-4 w-4 shrink-0', entry.isDir ? 'text-sky-400' : 'text-slate-400')}
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

                      <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                        {/* Transfer to the other pane button */}
                        {!entry.isDir && (
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
                        )}
                        {!entry.isDir && (
                          <button
                            title="Edit File"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenFile(entry, side);
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
  };

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
              {transferStatus.type === 'upload' ? 'Transferring' : 'Downloading'} {transferStatus.filename}
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

      {/* ── Mobile Pane Switcher & Swap ── */}
      <div className="nx-segmented md:hidden flex items-center justify-between gap-1 p-1 bg-black/30 border-b border-white/10" aria-label="File location">
        <button
          aria-pressed={mobileSide === 'left'}
          onClick={() => setMobileSide('left')}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 px-2 text-xs font-medium transition",
            mobileSide === 'left' ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
          )}
        >
          {leftHost ? <OsIcon os={leftHost.os} color={leftHost.color} size={16} /> : <Laptop size={16} />}
          <span className="truncate">{leftHost?.label || 'Local'}</span>
        </button>

        <button
          onClick={handleSwapPanes}
          title="Swap left and right panes"
          className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 hover:bg-white/10 text-cyan-400 border border-white/5 transition"
        >
          <ArrowLeftRight size={14} />
        </button>

        <button
          aria-pressed={mobileSide === 'right'}
          onClick={() => setMobileSide('right')}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 px-2 text-xs font-medium transition",
            mobileSide === 'right' ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"
          )}
        >
          {rightHost ? <OsIcon os={rightHost.os} color={rightHost.color} size={16} /> : <Laptop size={16} />}
          <span className="truncate">{rightHost?.label || (rightHostId ? 'Host' : 'Local')}</span>
        </button>
      </div>

      {/* ── Mobile Action Sheets ── */}
      {mobile && active && fileActions && (
        <MobileSheet
          title={fileActions.entry.name}
          kicker={fileActions.entry.isDir ? 'Folder' : 'File'}
          subtitle={fileActions.side === 'left' ? (leftHost?.label || 'Local') : (rightHost?.label || 'Right')}
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
              <>
                <button
                  className="nx-settings-row"
                  onClick={() => {
                    handleOpenFile(fileActions.entry, fileActions.side);
                    setFileActions(null);
                  }}
                >
                  <FileCode size={18} /> Edit
                </button>
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
              </>
            )}
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

      {mobile && active && permissions && (
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
              : `${fmtPerm(permissions.permissions, permissions.isDir)} · ${(permissions.permissions & 0o7777).toString(8).padStart(3, '0')}`}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            Read-only metadata. Permission changes are not exposed by the file API; use your terminal to change the mode.
          </p>
        </MobileSheet>
      )}

      {/* ── Main Dual-Pane View ── */}
      <div className="flex flex-1 min-h-0 min-w-0 md:divide-x divide-white/[0.08]">
        {renderPane('left')}
        {renderPane('right')}
      </div>

      {/* ==================================================================== */}
      {/* SOURCE & HOST PICKER MODAL (FOR LEFT OR RIGHT PANE) */}
      {/* ==================================================================== */}
      {hostPickerSide && (
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
                  "rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition",
                  connectingHostId && "opacity-40 cursor-not-allowed"
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
                    "h-9 w-full rounded-xl bg-white/[0.05] pl-10 pr-4 text-xs text-slate-200 placeholder-slate-500 border border-white/10 focus:outline-none focus:ring-1 transition",
                    connectingHostId && "opacity-50 cursor-not-allowed"
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
                    "group flex items-center justify-between rounded-xl p-3 border transition shadow-sm cursor-pointer",
                    (hostPickerSide === 'left' ? !leftHostId : !rightHostId)
                      ? "bg-cyan-500/15 border-cyan-500/50 ring-1 ring-cyan-500/30 shadow-lg shadow-cyan-500/10"
                      : "bg-white/[0.03] hover:bg-white/[0.07] border-white/5 hover:border-white/15"
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
                      "group flex items-center justify-between rounded-xl p-3 border transition shadow-sm",
                      isConnectingThis
                        ? "bg-cyan-500/15 border-cyan-500/50 ring-1 ring-cyan-500/30 cursor-wait shadow-lg shadow-cyan-500/10"
                        : isActiveOnThisSide
                        ? "bg-cyan-500/15 border-cyan-500/40 ring-1 ring-cyan-500/30"
                        : isConnectingAny
                        ? "bg-white/[0.02] border-white/5 opacity-40 cursor-not-allowed pointer-events-none"
                        : "bg-white/[0.03] hover:bg-white/[0.07] border-white/5 hover:border-white/15 cursor-pointer"
                    )}
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
                            "grid h-8 w-8 place-items-center rounded-xl border transition shadow-sm",
                            isConnectingAny ? "opacity-30" : "group-hover:translate-x-0.5"
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
      )}

      {/* ==================================================================== */}
      {/* PROMPT MODAL (New file / New folder / Rename) */}
      {/* ==================================================================== */}
      {promptDialog && (
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
                    {deleteConfirm.side === 'left'
                      ? (leftHost?.label || 'Local')
                      : (rightHost?.label || 'Local')}
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
          hostLabel={
            editingFile.isRemote
              ? ((editingFile.side === 'left' ? leftHost?.label : rightHost?.label) || 'Remote Host')
              : 'Local Machine'
          }
          onSave={handleSaveFile}
          onClose={() => setEditingFile(null)}
          toast={toast}
          theme={activeTheme}
        />
      )}
    </div>
  );
}
