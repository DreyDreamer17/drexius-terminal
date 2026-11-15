import { useMobile } from '../hooks/useMobile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Laptop } from 'lucide-react';
import { bridge, isBridgeError } from '../lib/bridge';
import type { FileEntry, Host, Tab } from '../lib/types';
import { cn } from '../utils/cn';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { OsIcon } from './OsIcon';
import { SftpCodeEditor, type EditorFile } from './SftpCodeEditor';
import {
  buildSftpCrumbs,
  type SftpContextMenuState,
  type SftpDeleteConfirmState,
  type SftpPromptDialogState,
  type SftpTransferStatus,
} from './sftp/sftpHelpers';
import { SftpPaneView } from './sftp/SftpPaneView';
import {
  SftpTransferBanner,
  SftpMobileActionSheets,
  SftpHostPickerModal,
  SftpPromptModal,
  SftpDesktopContextMenu,
  SftpPermissionsModal,
  SftpDeleteConfirmModal,
} from './sftp/SftpModalsAndSheets';

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

  const activeTheme =
    theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
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
  const [leftSelected, setLeftSelected] = useState<Set<string>>(() => new Set());
  const [leftLastClicked, setLeftLastClicked] = useState<string | null>(null);
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
  const [rightSelected, setRightSelected] = useState<Set<string>>(() => new Set());
  const [rightLastClicked, setRightLastClicked] = useState<string | null>(null);
  const [rightHistory, setRightHistory] = useState<string[]>([]);
  const [rightHistoryIdx, setRightHistoryIdx] = useState<number>(-1);
  const [showRightActions, setShowRightActions] = useState<boolean>(false);

  // Active pane focus for keyboard shortcuts (Ctrl+A, Delete, F2)
  const [focusedSide, setFocusedSide] = useState<'left' | 'right'>('left');

  // Mobile long-press touch tracker
  const touchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const didLongPressRef = useRef(false);

  // Desktop floating right-click context menu
  const [contextMenu, setContextMenu] = useState<SftpContextMenuState | null>(null);

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
  const [transferStatus, setTransferStatus] = useState<SftpTransferStatus | null>(null);
  const isCancelledRef = useRef<boolean>(false);

  const handleCancelTransfer = async () => {
    isCancelledRef.current = true;
    if (leftSessionId) {
      await bridge.sftpCancel(leftSessionId).catch(() => {});
    }
    if (rightSessionId) {
      await bridge.sftpCancel(rightSessionId).catch(() => {});
    }
    setTransferStatus(null);
    toast('Transfer cancelled');
  };

  // Text file editor
  const [editingFile, setEditingFile] = useState<(EditorFile & { side: 'left' | 'right' }) | null>(null);

  // New file, new folder & rename dialogs
  const [promptDialog, setPromptDialog] = useState<SftpPromptDialogState | null>(null);

  // Delete confirmation dialog (supports single or batch deletion)
  const [deleteConfirm, setDeleteConfirm] = useState<SftpDeleteConfirmState | null>(null);

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
      const effectiveHostId =
        overrideHostId !== undefined ? overrideHostId : isLeft ? leftHostIdRef.current : rightHostIdRef.current;
      const effectiveSid =
        overrideSid !== undefined ? overrideSid : isLeft ? leftSessionRef.current : rightSessionRef.current;

      if (isLeft) setLeftLoading(true);
      else setRightLoading(true);

      try {
        if (!effectiveHostId) {
          // Local Filesystem
          const res = await bridge.localFsList(targetPath);
          if (isLeft) {
            if (res.currentPath !== leftPath) {
              setLeftSelected(new Set());
              setLeftLastClicked(null);
            }
            setLeftPath(res.currentPath);
            setLeftEntries(res.entries);
            if (recordHistory) {
              setLeftHistory((prev) => [...prev.slice(0, leftHistoryIdx + 1), res.currentPath]);
              setLeftHistoryIdx((prev) => prev + 1);
            }
          } else {
            if (res.currentPath !== rightPath) {
              setRightSelected(new Set());
              setRightLastClicked(null);
            }
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
            if (p !== leftPath) {
              setLeftSelected(new Set());
              setLeftLastClicked(null);
            }
            setLeftPath(p);
            setLeftEntries(list);
            if (recordHistory) {
              setLeftHistory((prev) => [...prev.slice(0, leftHistoryIdx + 1), p]);
              setLeftHistoryIdx((prev) => prev + 1);
            }
          } else {
            if (p !== rightPath) {
              setRightSelected(new Set());
              setRightLastClicked(null);
            }
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

      const gen = isLeft ? ++connectGenerationRef.current.left : ++connectGenerationRef.current.right;
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
          setLeftSelected(new Set());
          setLeftLastClicked(null);
          onUpdateTab({
            sftpLeftHostId: hostId,
            sftpLeftSessionId: sid,
            title: rightHostIdRef.current
              ? `SFTP: ${hostLabel} ↔ ${hosts.find((h) => h.id === rightHostIdRef.current)?.label || 'Remote'}`
              : `SFTP: ${hostLabel}`,
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
          setRightSelected(new Set());
          setRightLastClicked(null);
          onUpdateTab({
            sftpRightHostId: hostId,
            sftpRightSessionId: sid,
            sftpHostId: hostId,
            sftpSessionId: sid,
            title: leftHostIdRef.current
              ? `SFTP: ${hosts.find((h) => h.id === leftHostIdRef.current)?.label || 'Local'} ↔ ${hostLabel}`
              : `SFTP: ${hostLabel}`,
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
        setLeftSelected(new Set());
        setLeftLastClicked(null);
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
        setRightSelected(new Set());
        setRightLastClicked(null);
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
        setLeftSelected(new Set());
        setLeftLastClicked(null);
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
        setRightSelected(new Set());
        setRightLastClicked(null);
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

    setLeftSelected(new Set());
    setRightSelected(new Set());
    setLeftLastClicked(null);
    setRightLastClicked(null);
    setLeftFilter('');
    setRightFilter('');
    setContextMenu(null);

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

  // Breadcrumbs parsing (treats `/storage/emulated/0` as root on Android Local)
  const leftCrumbs = useMemo(() => buildSftpCrumbs(leftPath, leftHostId), [leftPath, leftHostId]);
  const rightCrumbs = useMemo(() => buildSftpCrumbs(rightPath, rightHostId), [rightPath, rightHostId]);

  // ── Unified File & Folder Transfer (Single or Batch: Local ↔ Remote, Remote ↔ Remote, Local ↔ Local) ──
  const handleTransferBatch = async (items: FileEntry[], fromSide: 'left' | 'right') => {
    if (!items.length) return;
    const toSide = fromSide === 'left' ? 'right' : 'left';
    const fromIsRemote = fromSide === 'left' ? !!leftHostId : !!rightHostId;
    const toIsRemote = toSide === 'left' ? !!leftHostId : !!rightHostId;
    const fromSid = fromSide === 'left' ? leftSessionId : rightSessionId;
    const toSid = toSide === 'left' ? leftSessionId : rightSessionId;
    const toPath = toSide === 'left' ? leftPath : rightPath;

    const toLabel =
      toSide === 'left'
        ? hosts.find((h) => h.id === leftHostId)?.label || 'Local'
        : hosts.find((h) => h.id === rightHostId)?.label || 'Local';

    if (toIsRemote && !toSid) {
      toast(`Please connect ${toLabel} first`);
      return;
    }
    if (!toPath) {
      toast(`Invalid target path on ${toLabel}`);
      return;
    }

    isCancelledRef.current = false;
    try {
      for (let i = 0; i < items.length; i++) {
        if (isCancelledRef.current) break;
        const entry = items[i];
        const targetDestPath = `${toPath.replace(/\/$/, '')}/${entry.name}`;
        const labelName = items.length > 1 ? `${entry.name} (${i + 1}/${items.length})` : entry.name;
        setTransferStatus({
          type: fromIsRemote && !toIsRemote ? 'download' : 'upload',
          filename: labelName,
          progress: 0,
        });

        if (!fromIsRemote && !toIsRemote) {
          // Local -> Local (file or folder)
          await bridge.localFsCopy(entry.path, targetDestPath);
          setTransferStatus((s) => s && { ...s, progress: 1 });
        } else if (!fromIsRemote && toIsRemote) {
          // Local -> Remote (Upload file or folder)
          await bridge.sftpUploadDirect(toSid!, entry.path, targetDestPath, (pct) =>
            setTransferStatus((s) => s && { ...s, progress: pct })
          );
        } else if (fromIsRemote && !toIsRemote) {
          // Remote -> Local (Download file or folder)
          await bridge.sftpDownloadDirect(fromSid!, entry.path, targetDestPath, (pct) =>
            setTransferStatus((s) => s && { ...s, progress: pct })
          );
        } else {
          // Remote -> Remote (Direct Server Transfer of file or folder)
          await bridge.sftpTransferRemoteDirect(fromSid!, entry.path, toSid!, targetDestPath, (pct) =>
            setTransferStatus((s) => s && { ...s, progress: pct })
          );
        }
      }
      if (!isCancelledRef.current) {
        if (items.length === 1) {
          toast(`Transferred ${items[0].name} to ${toLabel}`);
        } else {
          toast(`Transferred ${items.length} items to ${toLabel}`);
        }
      }
      await loadPane(toSide, toPath, false);
    } catch (err) {
      if (isCancelledRef.current || String(err).toLowerCase().includes('cancel')) {
        toast('Transfer cancelled');
      } else {
        toast(isBridgeError(err) ? err.message : `Transfer failed: ${err}`);
      }
    } finally {
      setTimeout(() => {
        setTransferStatus(null);
        isCancelledRef.current = false;
      }, 300);
    }
  };

  const handleTransfer = async (entry: FileEntry, fromSide: 'left' | 'right') => {
    await handleTransferBatch([entry], fromSide);
  };

  // ── Drag and Drop Between Panes (Single or Multi-Select) ──
  const handleDragStart = (
    e: React.DragEvent,
    entry: FileEntry,
    side: 'left' | 'right',
    visibleEntries: FileEntry[]
  ) => {
    setContextMenu(null);
    const sel = side === 'left' ? leftSelected : rightSelected;
    const draggedEntries = sel.has(entry.path) ? visibleEntries.filter((it) => sel.has(it.path)) : [entry];
    e.dataTransfer.setData(
      'text/plain',
      JSON.stringify({ side, entry: draggedEntries[0], entries: draggedEntries })
    );
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
      if (data.side && data.side !== targetSide) {
        const list: FileEntry[] =
          Array.isArray(data.entries) && data.entries.length > 0
            ? data.entries
            : data.entry
            ? [data.entry]
            : [];
        if (list.length > 0) {
          await handleTransferBatch(list, data.side);
        }
      }
    } catch (_) {}
  };

  // ── File Actions (Delete, Rename, New Folder, View/Edit) ──
  const requestDeleteBatch = (entriesToDelete: FileEntry[], side: 'left' | 'right') => {
    if (!entriesToDelete.length) return;
    setDeleteConfirm({ entries: entriesToDelete, side });
  };

  const requestDelete = (entry: FileEntry, side: 'left' | 'right') => {
    requestDeleteBatch([entry], side);
  };

  const handleExecuteDelete = async () => {
    if (!deleteConfirm || !deleteConfirm.entries.length) return;
    const { entries: targetEntries, side } = deleteConfirm;
    const isRemote = side === 'left' ? !!leftHostId : !!rightHostId;
    const sid = side === 'left' ? leftSessionId : rightSessionId;
    const currentP = side === 'left' ? leftPath : rightPath;

    setDeleteConfirm((prev) => prev && { ...prev, deleting: true });
    try {
      for (const entry of targetEntries) {
        if (!isRemote) {
          await bridge.localFsRemove(entry.path, entry.isDir);
        } else if (sid) {
          await bridge.sftpRemove(sid, entry.path, entry.isDir);
        }
      }
      if (side === 'left') {
        setLeftSelected(new Set());
        setLeftLastClicked(null);
      } else {
        setRightSelected(new Set());
        setRightLastClicked(null);
      }
      toast(targetEntries.length === 1 ? `Deleted ${targetEntries[0].name}` : `Deleted ${targetEntries.length} items`);
      setDeleteConfirm(null);
      loadPane(side, currentP, false);
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
      setDeleteConfirm((prev) => prev && { ...prev, deleting: false });
    }
  };

  const copyPathsToClipboard = async (items: FileEntry[]) => {
    if (!items.length) return;
    const text = items.map((it) => it.path).join('\n');
    try {
      await bridge.writeClipboard(text);
      toast(items.length === 1 ? `Copied path: ${items[0].path}` : `Copied ${items.length} paths to clipboard`);
    } catch {
      toast('Could not copy path to clipboard');
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

  // ── Multi-Selection & Context Menu Handlers ──
  const selectAllInPane = useCallback(
    (side: 'left' | 'right') => {
      const list = side === 'left' ? filteredLeft : filteredRight;
      const next = new Set(list.map((it) => it.path));
      if (side === 'left') {
        setLeftSelected(next);
      } else {
        setRightSelected(next);
      }
    },
    [filteredLeft, filteredRight]
  );

  const clearSelectionInPane = useCallback((side: 'left' | 'right') => {
    if (side === 'left') {
      setLeftSelected(new Set());
      setLeftLastClicked(null);
    } else {
      setRightSelected(new Set());
      setRightLastClicked(null);
    }
  }, []);

  // ── Mobile Long-Press Touch Handlers ──
  const handleRowTouchStart = (e: React.TouchEvent, entry: FileEntry, side: 'left' | 'right') => {
    if (!mobile) return;
    didLongPressRef.current = false;
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    const touch = e.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };

    touchTimerRef.current = setTimeout(() => {
      touchTimerRef.current = null;
      didLongPressRef.current = true;
      if (window.navigator?.vibrate) {
        try {
          window.navigator.vibrate(40);
        } catch (_) {}
      }
      setFocusedSide(side);
      const setSelected = side === 'left' ? setLeftSelected : setRightSelected;
      setSelected((prev) => {
        const next = new Set(prev);
        next.add(entry.path);
        return next;
      });
    }, 420);
  };

  const handleRowTouchMove = (e: React.TouchEvent) => {
    if (!mobile || !touchStartPosRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartPosRef.current.x;
    const dy = touch.clientY - touchStartPosRef.current.y;
    // If finger moves more than 10px (user is scrolling), cancel long press
    if (Math.hypot(dx, dy) > 10) {
      if (touchTimerRef.current) {
        clearTimeout(touchTimerRef.current);
        touchTimerRef.current = null;
      }
    }
  };

  const handleRowTouchEnd = (e: React.TouchEvent) => {
    if (!mobile) return;
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
    touchStartPosRef.current = null;
    if (didLongPressRef.current) {
      if (e.cancelable) e.preventDefault();
      setTimeout(() => {
        didLongPressRef.current = false;
      }, 350);
    }
  };

  const handleRowClick = (
    e: React.MouseEvent,
    entry: FileEntry,
    side: 'left' | 'right',
    visibleEntries: FileEntry[]
  ) => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false;
      return;
    }

    setFocusedSide(side);
    setContextMenu(null);
    const isLeft = side === 'left';
    const setSelected = isLeft ? setLeftSelected : setRightSelected;
    const lastClicked = isLeft ? leftLastClicked : rightLastClicked;
    const setLastClicked = isLeft ? setLeftLastClicked : setRightLastClicked;

    if (mobile) {
      const currentSelected = isLeft ? leftSelected : rightSelected;
      // In mobile selection mode (any item selected), tapping any row toggles selection
      if (currentSelected.size > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        setLastClicked(entry.path);
        return;
      }

      // Normal mobile browsing mode: do not modify `selected` so selection mode never flashes
      if (entry.isDir) loadPane(side, entry.path);
      else setFileActions({ entry, side });
      return;
    }

    if (e.shiftKey && lastClicked) {
      const startIdx = visibleEntries.findIndex((it) => it.path === lastClicked);
      const endIdx = visibleEntries.findIndex((it) => it.path === entry.path);
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const rangePaths = visibleEntries.slice(lo, hi + 1).map((it) => it.path);
        setSelected((prev) => {
          const next = e.ctrlKey || e.metaKey ? new Set(prev) : new Set<string>();
          for (const p of rangePaths) next.add(p);
          return next;
        });
        return;
      }
    }

    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setLastClicked(entry.path);
      return;
    }

    setSelected(new Set([entry.path]));
    setLastClicked(entry.path);
  };

  const handleRowContextMenu = (
    e: React.MouseEvent,
    entry: FileEntry,
    side: 'left' | 'right',
    visibleEntries: FileEntry[]
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setFocusedSide(side);

    if (mobile) {
      // Native mobile contextmenu fires during a long press (~500ms).
      // Only add the entry if our touch timer hasn't already handled this press.
      if (!didLongPressRef.current) {
        didLongPressRef.current = true;
        if (window.navigator?.vibrate) {
          try {
            window.navigator.vibrate(40);
          } catch (_) {}
        }
        const isLeft = side === 'left';
        const setSelected = isLeft ? setLeftSelected : setRightSelected;
        setSelected((prev) => {
          const next = new Set(prev);
          next.add(entry.path);
          return next;
        });
      }
      return;
    }

    const isLeft = side === 'left';
    const selected = isLeft ? leftSelected : rightSelected;
    const setSelected = isLeft ? setLeftSelected : setRightSelected;
    const setLastClicked = isLeft ? setLeftLastClicked : setRightLastClicked;

    let selectedEntries: FileEntry[];
    if (selected.has(entry.path)) {
      selectedEntries = visibleEntries.filter((it) => selected.has(it.path));
      if (selectedEntries.length === 0) selectedEntries = [entry];
    } else {
      const next = new Set([entry.path]);
      setSelected(next);
      setLastClicked(entry.path);
      selectedEntries = [entry];
    }

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      side,
      targetEntry: entry,
      selectedEntries,
    });
  };

  const handlePaneContextMenu = (e: React.MouseEvent, side: 'left' | 'right', visibleEntries: FileEntry[]) => {
    e.preventDefault();
    setFocusedSide(side);
    if (mobile) return;

    const selected = side === 'left' ? leftSelected : rightSelected;
    const selectedEntries = visibleEntries.filter((it) => selected.has(it.path));

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      side,
      targetEntry: null,
      selectedEntries,
    });
  };

  // Keyboard shortcuts: Ctrl/Cmd+A (Select All), Delete (Batch Delete), F2 (Rename), Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active) return;

      if (e.key === 'Escape') {
        if (contextMenu) {
          e.preventDefault();
          setContextMenu(null);
          return;
        }
        if (permissions && !mobile) {
          e.preventDefault();
          setPermissions(null);
          return;
        }
      }

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

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAllInPane(focusedSide);
        return;
      }

      if (e.key === 'Escape') {
        clearSelectionInPane(focusedSide);
        return;
      }

      if (e.key === 'F2') {
        const activeSel = focusedSide === 'left' ? leftSelected : rightSelected;
        const activeList = focusedSide === 'left' ? filteredLeft : filteredRight;
        if (activeSel.size === 1) {
          const onlyPath = Array.from(activeSel)[0];
          const entry = activeList.find((it) => it.path === onlyPath);
          if (entry) {
            e.preventDefault();
            setPromptDialog({
              type: 'rename',
              side: focusedSide,
              title: `Rename ${entry.name}`,
              currentVal: entry.name,
              targetPath: entry.path,
            });
          }
        }
        return;
      }

      if (e.key === 'Delete') {
        const primarySide = focusedSide;
        const secondarySide = focusedSide === 'left' ? 'right' : 'left';
        const primarySel = primarySide === 'left' ? leftSelected : rightSelected;
        const secondarySel = secondarySide === 'left' ? leftSelected : rightSelected;

        const targetSide = primarySel.size > 0 ? primarySide : secondarySel.size > 0 ? secondarySide : null;
        if (targetSide) {
          const sel = targetSide === 'left' ? leftSelected : rightSelected;
          const entries = (targetSide === 'left' ? leftEntries : rightEntries).filter((it) => sel.has(it.path));
          if (entries.length > 0) {
            e.preventDefault();
            requestDeleteBatch(entries, targetSide);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    active,
    contextMenu,
    permissions,
    mobile,
    focusedSide,
    rightSelected,
    leftSelected,
    rightEntries,
    leftEntries,
    filteredLeft,
    filteredRight,
    editingFile,
    promptDialog,
    hostPickerSide,
    deleteConfirm,
    selectAllInPane,
    clearSelectionInPane,
  ]);

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

  // ── Render Single Pane ──
  const renderPane = (side: 'left' | 'right') => {
    const isLeft = side === 'left';
    return (
      <SftpPaneView
        key={side}
        side={side}
        mobile={mobile}
        mobileSide={mobileSide}
        hostId={isLeft ? leftHostId : rightHostId}
        host={isLeft ? leftHost : rightHost}
        hosts={hosts}
        sessionId={isLeft ? leftSessionId : rightSessionId}
        connecting={isLeft ? leftConnecting : rightConnecting}
        connectingHostId={connectingHostId}
        path={isLeft ? leftPath : rightPath}
        crumbs={isLeft ? leftCrumbs : rightCrumbs}
        entries={isLeft ? filteredLeft : filteredRight}
        loading={isLeft ? leftLoading : rightLoading}
        filter={isLeft ? leftFilter : rightFilter}
        setFilter={isLeft ? setLeftFilter : setRightFilter}
        showSearch={isLeft ? showLeftSearch : showRightSearch}
        setShowSearch={isLeft ? setShowLeftSearch : setShowRightSearch}
        showHidden={isLeft ? showLeftHidden : showRightHidden}
        setShowHidden={isLeft ? setShowLeftHidden : setShowRightHidden}
        selected={isLeft ? leftSelected : rightSelected}
        histIdx={isLeft ? leftHistoryIdx : rightHistoryIdx}
        hist={isLeft ? leftHistory : rightHistory}
        showActions={isLeft ? showLeftActions : showRightActions}
        setShowActions={isLeft ? setShowLeftActions : setShowRightActions}
        transferStatus={transferStatus}
        setFocusedSide={setFocusedSide}
        setHostPickerSide={setHostPickerSide}
        setPromptDialog={setPromptDialog}
        setFileActions={setFileActions}
        setContextMenu={setContextMenu}
        connectHost={connectHost}
        disconnectSide={disconnectSide}
        handleSwapPanes={handleSwapPanes}
        loadPane={loadPane}
        navigateBack={navigateBack}
        navigateForward={navigateForward}
        selectAllInPane={selectAllInPane}
        clearSelectionInPane={clearSelectionInPane}
        handleTransfer={handleTransfer}
        handleTransferBatch={handleTransferBatch}
        requestDelete={requestDelete}
        requestDeleteBatch={requestDeleteBatch}
        handleOpenFile={handleOpenFile}
        handleDragOver={handleDragOver}
        handleDrop={handleDrop}
        handleDragStart={handleDragStart}
        handleRowTouchStart={handleRowTouchStart}
        handleRowTouchMove={handleRowTouchMove}
        handleRowTouchEnd={handleRowTouchEnd}
        handleRowClick={handleRowClick}
        handleRowContextMenu={handleRowContextMenu}
        handlePaneContextMenu={handlePaneContextMenu}
      />
    );
  };

  return (
    <div
      className="nx-sftp relative flex h-full w-full flex-col overflow-hidden text-slate-200 select-none"
      style={{ background: bgColor }}
    >
      {/* ── Transfer Float Toast / Banner ── */}
      <SftpTransferBanner transferStatus={transferStatus} handleCancelTransfer={handleCancelTransfer} />

      {/* ── Mobile Pane Switcher & Swap ── */}
      <div
        className="nx-segmented md:hidden flex items-center justify-between gap-1 p-1 bg-black/30 border-b border-white/10"
        aria-label="File location"
      >
        <button
          aria-pressed={mobileSide === 'left'}
          onClick={() => setMobileSide('left')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 px-2 text-xs font-medium transition',
            mobileSide === 'left' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
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
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 px-2 text-xs font-medium transition',
            mobileSide === 'right' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
          )}
        >
          {rightHost ? <OsIcon os={rightHost.os} color={rightHost.color} size={16} /> : <Laptop size={16} />}
          <span className="truncate">{rightHost?.label || (rightHostId ? 'Host' : 'Local')}</span>
        </button>
      </div>

      {/* ── Mobile Action Sheets ── */}
      <SftpMobileActionSheets
        mobile={mobile}
        active={active}
        fileActions={fileActions}
        setFileActions={setFileActions}
        permissions={permissions}
        setPermissions={setPermissions}
        leftHost={leftHost}
        rightHost={rightHost}
        activeTheme={activeTheme}
        transferStatus={transferStatus}
        loadPane={loadPane}
        handleOpenFile={handleOpenFile}
        handleTransfer={handleTransfer}
        setPromptDialog={setPromptDialog}
        setLeftSelected={setLeftSelected}
        setRightSelected={setRightSelected}
        setFocusedSide={setFocusedSide}
        requestDelete={requestDelete}
      />

      {/* ── Main Dual-Pane View ── */}
      <div className="flex flex-1 min-h-0 min-w-0 md:divide-x divide-white/[0.08]">
        {renderPane('left')}
        {renderPane('right')}
      </div>

      {/* ── Source & Host Picker Modal ── */}
      <SftpHostPickerModal
        hostPickerSide={hostPickerSide}
        setHostPickerSide={setHostPickerSide}
        hostPickerSearch={hostPickerSearch}
        setHostPickerSearch={setHostPickerSearch}
        connectingHostId={connectingHostId}
        connectingSide={connectingSide}
        hosts={hosts}
        filteredHosts={filteredHosts}
        leftHostId={leftHostId}
        rightHostId={rightHostId}
        bgColor={bgColor}
        accentColor={accentColor}
        switchToLocal={switchToLocal}
        connectHost={connectHost}
      />

      {/* ── Prompt Modal (New File / New Folder / Rename) ── */}
      <SftpPromptModal
        promptDialog={promptDialog}
        setPromptDialog={setPromptDialog}
        bgColor={bgColor}
        accentColor={accentColor}
        handlePromptSubmit={handlePromptSubmit}
      />

      {/* ── Desktop Floating Right-Click Context Menu ── */}
      <SftpDesktopContextMenu
        mobile={mobile}
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        leftHost={leftHost}
        rightHost={rightHost}
        leftPath={leftPath}
        rightPath={rightPath}
        accentColor={accentColor}
        transferStatus={transferStatus}
        loadPane={loadPane}
        handleOpenFile={handleOpenFile}
        handleTransferBatch={handleTransferBatch}
        setPromptDialog={setPromptDialog}
        copyPathsToClipboard={copyPathsToClipboard}
        setPermissions={setPermissions}
        requestDeleteBatch={requestDeleteBatch}
        selectAllInPane={selectAllInPane}
      />

      {/* ── Desktop Permissions & Info Modal ── */}
      <SftpPermissionsModal
        mobile={mobile}
        permissions={permissions}
        setPermissions={setPermissions}
        bgColor={bgColor}
        accentColor={accentColor}
        copyPathsToClipboard={copyPathsToClipboard}
      />

      {/* ── Delete Confirmation Warning Modal (Single or Batch) ── */}
      <SftpDeleteConfirmModal
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        leftHost={leftHost}
        rightHost={rightHost}
        bgColor={bgColor}
        handleExecuteDelete={handleExecuteDelete}
      />

      {/* ── Text File Viewer / Editor (Full Screen Overlay) ── */}
      {editingFile && (
        <SftpCodeEditor
          file={editingFile}
          hostLabel={
            editingFile.isRemote
              ? (editingFile.side === 'left' ? leftHost?.label : rightHost?.label) || 'Remote Host'
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
