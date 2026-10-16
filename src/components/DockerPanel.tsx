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
  ArrowUpRight,
} from 'lucide-react';
import type { DockerContainer, Host } from '../lib/types';
import { bridge } from '../lib/bridge';
import { CustomSelect } from './CustomSelect';
import { THEMES, type NexusTheme } from '../lib/themes';
import { OsIcon } from './OsIcon';
import { cn } from '../utils/cn';

interface Props {
  hosts: Host[];
  activeHostId?: string | null;
  onOpenTerminalWithCommand?: (host: Host, command: string, title?: string) => void;
  toast: (msg: string) => void;
  theme?: NexusTheme;
  onClose?: () => void;
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

export function DockerPanel({
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

  // Determine initial host selection: active session host, or first host, or local
  const selectableHosts = useMemo(() => [LOCAL_HOST_OPTION, ...hosts], [hosts]);
  const initialHostId = activeHostId && selectableHosts.some((h) => h.id === activeHostId)
    ? activeHostId
    : selectableHosts[0]?.id ?? '__local__';

  const [selectedHostId, setSelectedHostId] = useState<string>(initialHostId);

  useEffect(() => {
    if (activeHostId && selectableHosts.some((h) => h.id === activeHostId)) {
      setSelectedHostId(activeHostId);
    }
  }, [activeHostId, selectableHosts]);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [copiedPort, setCopiedPort] = useState<string | null>(null);

  // Logs modal state
  const [logModal, setLogModal] = useState<{
    container: DockerContainer;
    logs: string;
    loading: boolean;
    tail: number;
  } | null>(null);

  const selectedHost = useMemo(
    () => selectableHosts.find((h) => h.id === selectedHostId) ?? LOCAL_HOST_OPTION,
    [selectableHosts, selectedHostId]
  );

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
    setLogModal({ container, logs: '', loading: true, tail });
    try {
      const logs = await bridge.dockerContainerLogs(selectedHostId, container.id, tail);
      setLogModal({ container, logs, loading: false, tail });
    } catch (err: any) {
      setLogModal({
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
  };

  const handleStreamLogsTerminal = (container: DockerContainer) => {
    if (!onOpenTerminalWithCommand) return;
    const cmd = `docker logs -f --tail 200 ${container.id}`;
    onOpenTerminalWithCommand(selectedHost, cmd, `${container.names} (logs)`);
    setLogModal(null);
  };

  const copyText = (txt: string) => {
    navigator.clipboard?.writeText(txt).then(() => {
      setCopiedPort(txt);
      setTimeout(() => setCopiedPort(null), 1500);
      toast(`Copied ${txt}`);
    });
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return containers;
    const q = search.toLowerCase();
    return containers.filter(
      (c) =>
        c.names.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.ports.toLowerCase().includes(q)
    );
  }, [containers, search]);

  const runningCount = useMemo(() => containers.filter((c) => c.state === 'running').length, [containers]);
  const stoppedCount = containers.length - runningCount;

  return (
    <div
      className="flex flex-col h-full overflow-hidden text-slate-200"
      style={{
        backgroundColor: bgColor,
        '--nx-accent': accentColor,
      } as React.CSSProperties}
    >
      {/* Top Header */}
      <div className="relative flex items-center justify-between border-b border-white/10 px-4 py-3 shrink-0 bg-white/[0.02]">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-xl border shadow-sm shrink-0"
            style={{
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}35`,
              color: accentColor,
            }}
          >
            <Boxes className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-white flex items-center gap-2">
              Docker Containers
              {containers.length > 0 && (
                <span
                  className="rounded-full px-2 py-0.2 text-[10px] font-semibold border"
                  style={{
                    backgroundColor: `${accentColor}15`,
                    borderColor: `${accentColor}30`,
                    color: accentColor,
                  }}
                >
                  {containers.length}
                </span>
              )}
            </h2>
            <p className="text-[11px] text-slate-400">
              Inspect, restart, stream logs, and exec into containers
            </p>
          </div>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Host Selector & Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-white/10 bg-black/30 px-4 py-2.5 shrink-0 text-xs">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <span className="text-[11px] text-slate-400 shrink-0">Host:</span>
          <div className="flex-1 max-w-xs">
            <CustomSelect
              value={selectedHostId}
              options={selectableHosts.map((h) => ({
                value: h.id,
                label: h.label,
                sublabel: h.id === '__local__' ? 'localhost' : `${h.username}@${h.hostname}`,
                icon: <OsIcon os={h.os || (h.id === '__local__' ? 'linux' : 'server')} size={14} />,
              }))}
              onChange={(val) => setSelectedHostId(val)}
              theme={activeTheme}
              accentColor={accentColor}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {containers.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] mr-1">
              <span className="flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-emerald-300 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {runningCount} Running
              </span>
              {stoppedCount > 0 && (
                <span className="rounded bg-white/5 border border-white/10 px-2 py-0.5 text-slate-400 font-medium">
                  {stoppedCount} Stopped
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => fetchContainers(selectedHostId)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition disabled:opacity-50"
            title="Rescan Docker containers"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Filter search bar */}
      <div className="px-4 py-2 border-b border-white/5 bg-black/10 shrink-0">
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 shadow-inner transition focus-within:border-white/30">
          <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search containers by name, image, port..."
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none font-mono"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-slate-500 hover:text-white">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Containers List / Error View */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
        {loading && containers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
            <Loader2 className="h-7 w-7 animate-spin" style={{ color: accentColor }} />
            <p className="text-xs">Querying Docker daemon on {selectedHost.label}…</p>
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-200">
            <div className="flex items-center gap-2 text-rose-300 font-semibold">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>Docker Connection Notice</span>
            </div>
            <p className="text-rose-200/90 leading-relaxed">{error}</p>
            <div className="mt-1 rounded-lg border border-rose-500/20 bg-black/40 p-2 font-mono text-[11px] text-rose-300/80">
              Tip: Verify that the Docker daemon is active on the server (`sudo systemctl status docker`) and your user belongs to the `docker` group.
            </div>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500 gap-2">
            <Boxes className="h-8 w-8 text-slate-600" />
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
                  'group flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border p-3 transition shadow-sm',
                  isRunning
                    ? 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                    : 'border-white/5 bg-white/[0.01] opacity-75 hover:opacity-100'
                )}
              >
                {/* Left: Container Metadata */}
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="mt-0.5 shrink-0">
                    <span
                      className={cn(
                        'block h-2.5 w-2.5 rounded-full',
                        isRunning
                          ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                          : c.state === 'paused'
                          ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]'
                          : 'bg-slate-600'
                      )}
                      title={`State: ${c.state}`}
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-xs text-white truncate max-w-xs">
                        {c.names}
                      </span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {c.id}
                      </span>
                      <span
                        className={cn(
                          'rounded-md px-1.5 py-0.2 text-[9px] font-medium border',
                          isRunning
                            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                            : 'bg-white/5 border-white/10 text-slate-400'
                        )}
                      >
                        {c.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400 truncate">
                      <span className="font-mono text-slate-300 truncate max-w-sm" title={c.image}>
                        {c.image}
                      </span>
                    </div>

                    {/* Mapped Ports */}
                    {c.ports && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {c.ports.split(',').map((pStr, idx) => {
                          const trimmed = pStr.trim();
                          if (!trimmed) return null;
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => copyText(trimmed)}
                              className="group/port flex items-center gap-1 rounded bg-black/40 border border-white/10 px-1.5 py-0.5 text-[10px] font-mono text-slate-300 hover:border-white/25 hover:text-white transition"
                              title="Click to copy port mapping"
                            >
                              <span>{trimmed}</span>
                              {copiedPort === trimmed ? (
                                <Check className="h-2.5 w-2.5 text-emerald-400" />
                              ) : (
                                <Copy className="h-2.5 w-2.5 opacity-40 group-hover/port:opacity-100" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-1.5 shrink-0 self-end md:self-center">
                  {/* Restart button */}
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleAction(c, 'restart')}
                    title="Restart container"
                    className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition disabled:opacity-50"
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', actionLoading[`${c.id}-restart`] && 'animate-spin')} />
                    <span className="hidden sm:inline">Restart</span>
                  </button>

                  {/* Stop / Start button */}
                  {isRunning ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleAction(c, 'stop')}
                      title="Stop container"
                      className="flex h-7 items-center gap-1 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2 text-xs text-rose-300 hover:bg-rose-500/20 hover:text-rose-100 transition disabled:opacity-50"
                    >
                      <Square className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Stop</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleAction(c, 'start')}
                      title="Start container"
                      className="flex h-7 items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2 text-xs text-emerald-300 hover:bg-emerald-500/25 hover:text-emerald-100 transition disabled:opacity-50"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Start</span>
                    </button>
                  )}

                  {/* Logs button */}
                  <button
                    type="button"
                    onClick={() => openLogs(c)}
                    title="View container logs"
                    className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Logs</span>
                  </button>

                  {/* Shell exec button */}
                  {isRunning && onOpenTerminalWithCommand && (
                    <button
                      type="button"
                      onClick={() => handleShellExec(c)}
                      title="Open interactive terminal shell inside container"
                      className="flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition shadow-sm hover:brightness-110 active:scale-95"
                      style={{
                        backgroundColor: `${accentColor}20`,
                        borderColor: `${accentColor}40`,
                        color: accentColor,
                      }}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      <span>Shell</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {/* Logs Viewer Modal */}
      {logModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className="relative flex flex-col w-full max-w-3xl h-[80vh] rounded-2xl border border-white/15 shadow-2xl overflow-hidden text-slate-200"
            style={{ backgroundColor: bgColor }}
          >
            {/* Logs Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5 bg-white/[0.03] shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <FileText className="h-4 w-4 text-cyan-400 shrink-0" style={{ color: accentColor }} />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white truncate">
                    Logs: {logModal.container.names}
                  </h3>
                  <p className="text-[10px] font-mono text-slate-400 truncate">
                    {logModal.container.image} · Last {logModal.tail} lines
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {onOpenTerminalWithCommand && (
                  <button
                    type="button"
                    onClick={() => handleStreamLogsTerminal(logModal.container)}
                    className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.1] hover:text-white transition"
                    title="Stream live logs in a terminal tab"
                  >
                    <span>Stream in Tab</span>
                    <ArrowUpRight className="h-3 w-3" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => openLogs(logModal.container, logModal.tail)}
                  disabled={logModal.loading}
                  className="rounded-lg border border-white/10 bg-white/[0.05] p-1.5 text-slate-300 hover:bg-white/10 hover:text-white transition disabled:opacity-50"
                  title="Refresh logs"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', logModal.loading && 'animate-spin')} />
                </button>

                <button
                  onClick={() => setLogModal(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Logs Content Window */}
            <div className="flex-1 overflow-auto p-4 bg-black/60 font-mono text-xs text-slate-300 select-text leading-relaxed whitespace-pre-wrap">
              {logModal.loading ? (
                <div className="flex items-center justify-center h-full text-slate-500 gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: accentColor }} />
                  <span>Loading logs...</span>
                </div>
              ) : logModal.logs.trim() ? (
                logModal.logs
              ) : (
                <div className="text-center py-12 text-slate-600">
                  (No logs output recorded for this container)
                </div>
              )}
            </div>

            {/* Logs Footer Actions */}
            <div className="flex items-center justify-between border-t border-white/10 bg-black/40 px-5 py-2.5 shrink-0 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400 text-[11px]">Tail lines:</span>
                {[100, 200, 500, 1000].map((t) => (
                  <button
                    key={t}
                    onClick={() => openLogs(logModal.container, t)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[10px] font-medium border transition',
                      logModal.tail === t
                        ? 'border-white/30 text-white'
                        : 'border-white/5 text-slate-400 hover:text-slate-200'
                    )}
                    style={
                      logModal.tail === t
                        ? { backgroundColor: `${accentColor}25`, borderColor: `${accentColor}50`, color: accentColor }
                        : undefined
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => copyText(logModal.logs)}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1 text-slate-300 hover:bg-white/10 hover:text-white transition text-xs font-medium"
              >
                <Copy className="h-3 w-3" />
                <span>Copy Logs</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
