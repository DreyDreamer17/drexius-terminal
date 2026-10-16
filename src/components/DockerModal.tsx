import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Boxes,
  Play,
  Square,
  RefreshCw,
  Terminal,
  FileText,
  Search,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  X,
  ArrowLeft,
  ChevronDown,
} from 'lucide-react';
import type { DockerContainer, Host } from '../lib/types';
import { bridge } from '../lib/bridge';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { THEMES, type NexusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

interface Props {
  hosts: Host[];
  activeHostId?: string | null;
  onOpenTerminalWithCommand?: (host: Host, command: string, title?: string) => void;
  toast: (msg: string) => void;
  theme?: NexusTheme;
  onClose: () => void;
}

const LOCAL_HOST_OPTION: Host = {
  id: '__local__',
  label: 'Local Machine',
  hostname: 'localhost',
  port: 0,
  username: 'local',
  authMethod: 'agent',
  tags: ['local'],
  hasSecret: false,
  os: 'linux',
};

export function DockerModal({
  hosts,
  activeHostId,
  onOpenTerminalWithCommand,
  toast,
  theme,
  onClose,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const selectableHosts = useMemo(() => [LOCAL_HOST_OPTION, ...hosts], [hosts]);
  const initialHostId = activeHostId && selectableHosts.some((h) => h.id === activeHostId)
    ? activeHostId
    : selectableHosts[0]?.id ?? '__local__';

  const [selectedHostId, setSelectedHostId] = useState<string>(initialHostId);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState<'all' | 'running' | 'stopped'>('all');
  const [copiedPort, setCopiedPort] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Embedded logs viewer state
  const [viewingLogs, setViewingLogs] = useState<{
    container: DockerContainer;
    logs: string;
    loading: boolean;
    tail: number;
  } | null>(null);

  const selectedHost = useMemo(
    () => selectableHosts.find((h) => h.id === selectedHostId) ?? LOCAL_HOST_OPTION,
    [selectableHosts, selectedHostId]
  );

  useEffect(() => {
    if (activeHostId && selectableHosts.some((h) => h.id === activeHostId)) {
      setSelectedHostId(activeHostId);
    }
  }, [activeHostId, selectableHosts]);

  const fetchContainers = useCallback(async (hId: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await bridge.dockerListContainers(hId);
      setContainers(list);
    } catch (err: any) {
      setError(err?.message || String(err));
      setContainers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContainers(selectedHostId);
  }, [selectedHostId, fetchContainers]);

  const handleAction = async (container: DockerContainer, action: 'start' | 'stop' | 'restart') => {
    const key = `${container.id}-${action}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await bridge.dockerContainerAction(selectedHostId, container.id, action);
      toast(`Container ${container.names} ${action}ed`);
      await fetchContainers(selectedHostId);
    } catch (err: any) {
      toast(`Action failed: ${err?.message || String(err)}`);
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const openLogs = async (container: DockerContainer, tail = 200) => {
    setViewingLogs({ container, logs: '', loading: true, tail });
    try {
      const logs = await bridge.dockerContainerLogs(selectedHostId, container.id, tail);
      setViewingLogs({ container, logs, loading: false, tail });
    } catch (err: any) {
      setViewingLogs({
        container,
        logs: `Failed to fetch logs: ${err?.message || String(err)}`,
        loading: false,
        tail,
      });
    }
  };

  const handleShellExec = (container: DockerContainer) => {
    if (!onOpenTerminalWithCommand) {
      toast('Shell execution not available');
      return;
    }
    const cmd = `docker exec -it ${container.id} sh || docker exec -it ${container.id} bash`;
    onOpenTerminalWithCommand(selectedHost, cmd, `${container.names} (sh)`);
    toast(`Opening shell for ${container.names}...`);
    onClose();
  };

  const handleStreamLogsTerminal = (container: DockerContainer) => {
    if (!onOpenTerminalWithCommand) return;
    const cmd = `docker logs -f --tail 200 ${container.id}`;
    onOpenTerminalWithCommand(selectedHost, cmd, `${container.names} (logs)`);
    onClose();
  };

  const copyText = (txt: string, isPort = true) => {
    navigator.clipboard?.writeText(txt).then(() => {
      if (isPort) {
        setCopiedPort(txt);
        setTimeout(() => setCopiedPort(null), 1500);
      } else {
        setCopiedId(txt);
        setTimeout(() => setCopiedId(null), 1500);
      }
      toast(`Copied ${txt}`);
    });
  };

  const filtered = useMemo(() => {
    return containers.filter((c) => {
      if (filterState === 'running' && c.state !== 'running') return false;
      if (filterState === 'stopped' && c.state === 'running') return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        c.names.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.ports.toLowerCase().includes(q)
      );
    });
  }, [containers, search, filterState]);

  const runningCount = useMemo(() => containers.filter((c) => c.state === 'running').length, [containers]);
  const stoppedCount = containers.length - runningCount;

  return (
    <ResponsiveOverlay
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-in fade-in duration-150"
      onClose={onClose}
      label="Docker containers"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-4xl max-h-[88vh] max-md:max-h-[92dvh] rounded-2xl border shadow-2xl overflow-hidden overflow-x-hidden text-slate-200"
        style={{
          backgroundColor: bgColor,
          borderColor: `${accentColor}30`,
          '--nx-accent': accentColor,
        } as React.CSSProperties}
      >
        <SheetHandle onClose={onClose} />

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-20"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Modal Header */}
        <div className="relative border-b border-white/10 px-4 sm:px-5 py-3 sm:py-4 shrink-0 bg-white/[0.02]">
          {/* Top row: Title, badge, and pinned Close button */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
              <div
                className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl border shadow-sm shrink-0"
                style={{
                  backgroundColor: `${accentColor}18`,
                  borderColor: `${accentColor}35`,
                  color: accentColor,
                  boxShadow: `0 0 16px ${accentColor}25`,
                }}
              >
                <Boxes className="h-4 w-4 sm:h-5 sm:w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-sm sm:text-base font-semibold tracking-wide text-white truncate">Docker Containers</h2>
                  {containers.length > 0 && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold border shrink-0"
                      style={{
                        backgroundColor: `${accentColor}15`,
                        borderColor: `${accentColor}30`,
                        color: accentColor,
                      }}
                    >
                      {runningCount} Running{containers.length > 0 ? ` · ${containers.length} Total` : ''}
                    </span>
                  )}
                </div>
                <p className="hidden sm:block text-xs text-slate-400">
                  Inspect, restart, stream logs, and exec into containers on target hosts
                </p>
              </div>
            </div>

            {/* Close button - Always pinned top-right, never overflowed or pushed away */}
            <button
              type="button"
              onClick={onClose}
              title="Close (Esc)"
              className="grid h-8 w-8 sm:h-9 sm:w-9 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:bg-white/[0.08] hover:text-white transition shrink-0 ml-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Host Selector & Refresh bar: On mobile sits cleanly underneath, taking full width */}
          <div className="mt-2.5 sm:mt-3 flex items-center gap-2 w-full">
            <div className="relative flex-1 min-w-0">
              <select
                value={selectedHostId}
                onChange={(e) => setSelectedHostId(e.target.value)}
                className="w-full appearance-none flex items-center rounded-xl border border-white/10 bg-white/[0.05] pl-3 pr-8 py-2 sm:py-1.5 text-xs font-medium text-slate-200 hover:border-white/20 hover:bg-white/[0.08] focus:outline-none transition cursor-pointer truncate"
                style={{ outlineColor: accentColor }}
              >
                {selectableHosts.map((h) => (
                  <option key={h.id} value={h.id} className="bg-[#0e131d] text-slate-200">
                    {h.id === '__local__' ? '💻 Local Machine' : `🖥️ ${h.label} (${h.hostname})`}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>

            {/* Refresh button */}
            <button
              type="button"
              onClick={() => fetchContainers(selectedHostId)}
              disabled={loading}
              title="Refresh container list"
              className="flex h-9 sm:h-8 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-xs text-slate-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white transition disabled:opacity-50 shrink-0"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              <span className="hidden xs:inline sm:inline">Refresh</span>
            </button>
          </div>
        </div>

        {/* If viewing logs: show logs view. Otherwise: show search + container list */}
        {viewingLogs ? (
          <div className="flex flex-col flex-1 min-h-0 bg-black/40">
            {/* Logs subheader */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 px-4 sm:px-5 py-3 shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setViewingLogs(null)}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition shrink-0"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Back</span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-white truncate max-w-[140px] sm:max-w-none">{viewingLogs.container.names}</span>
                    <span className="font-mono text-[10px] text-slate-500 shrink-0">{viewingLogs.container.id.slice(0, 12)}</span>
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono truncate block">{viewingLogs.container.image}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
                {/* Tail line count selector */}
                <div className="flex items-center rounded-lg border border-white/10 bg-black/40 p-0.5 text-[11px]">
                  {[50, 100, 200, 500].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => openLogs(viewingLogs.container, n)}
                      className={cn(
                        'rounded px-2 py-0.5 font-mono transition',
                        viewingLogs.tail === n ? 'bg-white/15 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {/* Copy logs */}
                  <button
                    type="button"
                    onClick={() => copyText(viewingLogs.logs, false)}
                    title="Copy logs to clipboard"
                    className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition"
                  >
                    <Copy className="h-3 w-3" />
                    <span>Copy</span>
                  </button>

                  {/* Stream in terminal */}
                  {onOpenTerminalWithCommand && (
                    <button
                      type="button"
                      onClick={() => handleStreamLogsTerminal(viewingLogs.container)}
                      title="Open live streaming terminal"
                      className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold text-white transition hover:brightness-110 active:scale-95"
                      style={{
                        backgroundColor: `${accentColor}25`,
                        borderColor: `${accentColor}40`,
                      }}
                    >
                      <Terminal className="h-3 w-3" style={{ color: accentColor }} />
                      <span className="hidden xs:inline">Stream in Terminal</span>
                      <span className="xs:hidden">Stream</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Logs Console Body */}
            <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-slate-300 bg-black/60 select-text">
              {viewingLogs.loading ? (
                <div className="flex items-center justify-center py-20 gap-2 text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: accentColor }} />
                  <span>Fetching logs from daemon…</span>
                </div>
              ) : viewingLogs.logs ? (
                <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] text-slate-200">
                  {viewingLogs.logs}
                </pre>
              ) : (
                <div className="py-16 text-center text-slate-500">
                  (No logs found for this container)
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Filter and Search Bar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 sm:gap-3 border-b border-white/10 px-4 sm:px-5 py-2.5 sm:py-3 shrink-0 bg-white/[0.01]">
              <div className="relative flex-1 min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by container name, image, port, or ID…"
                  className="w-full rounded-xl border border-white/10 bg-black/40 pl-9 pr-8 py-2 sm:py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none transition"
                  style={{ outlineColor: accentColor }}
                />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              {/* Status filter tabs */}
              <div className="flex items-center rounded-xl border border-white/10 bg-black/30 p-1 text-xs w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => setFilterState('all')}
                  className={cn(
                    'flex-1 sm:flex-initial text-center justify-center rounded-lg px-2.5 py-1.5 sm:py-1 transition font-medium',
                    filterState === 'all'
                      ? 'bg-white/15 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  )}
                >
                  All ({containers.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterState('running')}
                  className={cn(
                    'flex-1 sm:flex-initial text-center justify-center rounded-lg px-2.5 py-1.5 sm:py-1 transition font-medium flex items-center gap-1.5',
                    filterState === 'running'
                      ? 'bg-emerald-500/20 text-emerald-300 shadow-sm border border-emerald-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                  <span>Running ({runningCount})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFilterState('stopped')}
                  className={cn(
                    'flex-1 sm:flex-initial text-center justify-center rounded-lg px-2.5 py-1.5 sm:py-1 transition font-medium flex items-center gap-1.5',
                    filterState === 'stopped'
                      ? 'bg-slate-500/20 text-slate-200 shadow-sm border border-white/15'
                      : 'text-slate-400 hover:text-slate-200'
                  )}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-500 shrink-0" />
                  <span>Stopped ({stoppedCount})</span>
                </button>
              </div>
            </div>

            {/* Containers List / Error View */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3">
              {loading && containers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin" style={{ color: accentColor }} />
                  <p className="text-xs">Querying Docker daemon on {selectedHost.label}…</p>
                </div>
              )}

              {error && (
                <div className="flex flex-col gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 sm:p-5 text-xs text-rose-200">
                  <div className="flex items-center gap-2 text-rose-300 font-semibold text-sm">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                    <span>Docker Daemon Notice</span>
                  </div>
                  <p className="text-rose-200/90 leading-relaxed font-mono text-[11.5px]">{error}</p>
                  <div className="mt-2 rounded-xl border border-rose-500/20 bg-black/40 p-3 text-[11px] text-rose-300/90 leading-relaxed">
                    <strong>Tip:</strong> Ensure Docker is installed and running on <code>{selectedHost.label}</code> (<code>sudo systemctl start docker</code>).
                    If permission is denied, add your user to the docker group: <code>sudo usermod -aG docker $USER</code> and reconnect.
                  </div>
                </div>
              )}

              {!loading && !error && filtered.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center text-slate-500 gap-2">
                  <Boxes className="h-10 w-10 text-slate-600" />
                  <p className="text-sm font-medium text-slate-300">
                    {search ? 'No matching containers' : 'No containers found'}
                  </p>
                  <p className="text-xs text-slate-500 max-w-sm">
                    {search
                      ? `No containers matched "${search}".`
                      : `There are currently no active or stopped Docker containers on ${selectedHost.label}.`}
                  </p>
                </div>
              )}

              {!loading &&
                filtered.map((c) => {
                  const isRunning = c.state === 'running';
                  const isBusy = !!(
                    actionLoading[`${c.id}-start`] ||
                    actionLoading[`${c.id}-stop`] ||
                    actionLoading[`${c.id}-restart`]
                  );

                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'flex flex-col gap-3 rounded-2xl border p-3.5 sm:p-4 transition shadow-sm',
                        isRunning
                          ? 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                          : 'border-white/5 bg-white/[0.01] opacity-75 hover:opacity-100'
                      )}
                    >
                      {/* Top Row: State dot, Name, ID, Image, Status badge, Uptime */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-2.5">
                        <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                          <span
                            className={cn(
                              'h-2.5 w-2.5 rounded-full shrink-0',
                              isRunning
                                ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)] animate-pulse'
                                : c.state === 'paused'
                                ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]'
                                : 'bg-slate-600'
                            )}
                            title={`State: ${c.state}`}
                          />
                          <span className="font-semibold text-sm text-white select-text truncate max-w-[180px] sm:max-w-none">
                            {c.names}
                          </span>
                          <button
                            type="button"
                            onClick={() => copyText(c.id, false)}
                            className="group/id flex items-center gap-1 rounded bg-black/40 border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:text-slate-200 hover:border-white/20 transition"
                            title="Click to copy container ID"
                          >
                            <span>{c.id.slice(0, 12)}</span>
                            {copiedId === c.id ? (
                              <Check className="h-2.5 w-2.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-2.5 w-2.5 opacity-40 group-hover/id:opacity-100" />
                            )}
                          </button>
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[9.5px] font-semibold border shrink-0',
                              isRunning
                                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                                : 'bg-white/5 border-white/10 text-slate-400'
                            )}
                          >
                            {c.status}
                          </span>
                        </div>

                        {/* Image name in top row */}
                        <div className="font-mono text-xs text-slate-400 truncate max-w-full sm:max-w-md select-text" title={c.image}>
                          <span className="text-slate-500">image: </span>
                          <span className="text-slate-300">{c.image}</span>
                        </div>
                      </div>

                      {/* Bottom Row: Ports on Left, Actions on Right */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-white/5">
                        {/* Mapped Ports */}
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0 w-full sm:flex-1">
                          {c.ports ? (
                            c.ports.split(',').map((pStr, idx) => {
                              const trimmed = pStr.trim();
                              if (!trimmed) return null;
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => copyText(trimmed)}
                                  className="group/port flex items-center gap-1 rounded-lg bg-black/40 border border-white/10 px-2 py-1 text-[11px] font-mono text-slate-300 hover:border-white/25 hover:text-white transition"
                                  title="Click to copy port mapping"
                                >
                                  <span>{trimmed}</span>
                                  {copiedPort === trimmed ? (
                                    <Check className="h-3 w-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="h-3 w-3 opacity-40 group-hover/port:opacity-100" />
                                  )}
                                </button>
                              );
                            })
                          ) : (
                            <span className="text-[11px] text-slate-500 font-mono">No exposed ports</span>
                          )}
                        </div>

                        {/* Actions Toolbar */}
                        <div className="flex items-center gap-1.5 sm:gap-2 w-full sm:w-auto shrink-0">
                          {/* Restart */}
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleAction(c, 'restart')}
                            title="Restart container"
                            className="flex-1 sm:flex-initial flex h-8 sm:h-7 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white transition disabled:opacity-50"
                          >
                            <RefreshCw className={cn('h-3.5 w-3.5', actionLoading[`${c.id}-restart`] && 'animate-spin')} />
                            <span>Restart</span>
                          </button>

                          {/* Stop / Start */}
                          {isRunning ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleAction(c, 'stop')}
                              title="Stop container"
                              className="flex-1 sm:flex-initial flex h-8 sm:h-7 items-center justify-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 text-xs text-rose-300 hover:border-rose-500/35 hover:bg-rose-500/20 hover:text-rose-100 transition disabled:opacity-50"
                            >
                              <Square className="h-3.5 w-3.5" />
                              <span>Stop</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleAction(c, 'start')}
                              title="Start container"
                              className="flex-1 sm:flex-initial flex h-8 sm:h-7 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2.5 text-xs text-emerald-300 hover:border-emerald-500/45 hover:bg-emerald-500/25 hover:text-emerald-100 transition disabled:opacity-50"
                            >
                              <Play className="h-3.5 w-3.5" />
                              <span>Start</span>
                            </button>
                          )}

                          {/* Logs */}
                          <button
                            type="button"
                            onClick={() => openLogs(c)}
                            title="View container logs"
                            className="flex-1 sm:flex-initial flex h-8 sm:h-7 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white transition"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            <span>Logs</span>
                          </button>

                          {/* Shell Exec */}
                          {isRunning && onOpenTerminalWithCommand && (
                            <button
                              type="button"
                              onClick={() => handleShellExec(c)}
                              title="Open interactive terminal shell inside container"
                              className="flex-1 sm:flex-initial flex h-8 sm:h-7 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold text-white transition shadow-sm hover:brightness-110 active:scale-95"
                              style={{
                                backgroundColor: `${accentColor}25`,
                                borderColor: `${accentColor}45`,
                              }}
                            >
                              <Terminal className="h-3.5 w-3.5" style={{ color: accentColor }} />
                              <span>Shell</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>
    </ResponsiveOverlay>
  );
}
