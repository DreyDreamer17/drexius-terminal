import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Trash2, ArrowLeftRight, Play, Square, Network, Check, X, HardDrive } from 'lucide-react';
import type { ActiveTunnelInfo, Host, TunnelConfig } from '../lib/types';
import { bridge } from '../lib/bridge';
import { CustomSelect } from './CustomSelect';
import { cn } from '../utils/cn';
import { confirmDialog } from './ConfirmDialog';

interface Props {
  hosts: Host[];
  tunnels: TunnelConfig[];
  onSave: (t: TunnelConfig) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose?: () => void;
  toast: (m: string) => void;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function PortForwardingPanel({ hosts, tunnels, onSave, onDelete, onClose, toast }: Props) {
  const [q, setQ] = useState('');
  const [activeList, setActiveList] = useState<ActiveTunnelInfo[]>([]);
  const [editing, setEditing] = useState<TunnelConfig | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const hostMap = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);

  // Poll tunnel status
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const statuses = await bridge.activeTunnels();
        if (mounted) setActiveList(statuses);
      } catch {
        /* ignore */
      }
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const activeMap = useMemo(() => new Map(activeList.map((a) => [a.id, a])), [activeList]);

  const filtered = useMemo(() => {
    return tunnels.filter((t) => {
      const h = hostMap.get(t.hostId);
      const str = `${t.label} ${t.forwardType} ${t.localPort} ${t.remoteHost} ${h?.label ?? ''}`.toLowerCase();
      return str.includes(q.toLowerCase());
    });
  }, [tunnels, hostMap, q]);

  const toggleTunnel = async (t: TunnelConfig) => {
    const isRunning = activeMap.get(t.id)?.running;
    setBusy((prev) => ({ ...prev, [t.id]: true }));
    try {
      if (isRunning) {
        await bridge.stopTunnel(t.id);
        toast(`Tunnel "${t.label}" stopped`);
      } else {
        const info = await bridge.startTunnel(t.id);
        if (t.forwardType === 'remote') {
          const boundPort = info.boundPort || t.remotePort;
          toast(`Reverse tunnel "${t.label}" active — ${t.remoteHost || '0.0.0.0'}:${boundPort} → ${t.localHost}:${t.localPort}`);
        } else {
          toast(`Tunnel "${t.label}" started on port ${t.localPort}`);
        }
      }
      const updated = await bridge.activeTunnels();
      setActiveList(updated);
    } catch (e) {
      toast(`Tunnel error: ${String(e)}`);
    } finally {
      setBusy((prev) => ({ ...prev, [t.id]: false }));
    }
  };

  const handleSave = async () => {
    if (!editing || !editing.label.trim()) {
      toast('Please enter a tunnel name');
      return;
    }
    if (!editing.hostId) {
      toast('Please select an SSH host');
      return;
    }
    if (editing.forwardType === 'remote') {
      if (!editing.localPort || editing.localPort <= 0) {
        toast('Please specify a valid local target port');
        return;
      }
    } else {
      if (!editing.localPort || editing.localPort <= 0) {
        toast('Please specify a valid local port');
        return;
      }
    }
    if ((editing.forwardType === 'local' || editing.forwardType === 'remote') && (!editing.remotePort && editing.remotePort !== 0)) {
      // Allow 0 for remote forwards as "allocate ephemeral port"
      if (editing.forwardType !== 'remote') {
        toast('Please specify a valid target port');
        return;
      }
    }
    try {
      await onSave(editing);
      toast(`Tunnel "${editing.label}" saved`);
      setEditing(null);
    } catch (e) {
      toast(`Failed to save tunnel: ${String(e)}`);
    }
  };

  const handleDelete = async (t: TunnelConfig) => {
    if (await confirmDialog({ title: `Delete tunnel "${t.label}"?`, message: activeMap.get(t.id)?.running ? 'The tunnel is running and will be stopped first.' : undefined, confirmLabel: 'Delete tunnel', danger: true })) {
      if (activeMap.get(t.id)?.running) {
        await bridge.stopTunnel(t.id).catch(() => {});
      }
      await onDelete(t.id);
      toast(`Tunnel "${t.label}" deleted`);
    }
  };

  const inputClass =
    'w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Port Forwarding</h2>
          <p className="text-[11px] text-slate-500">Local, Remote (reverse) & SOCKS5 dynamic SSH tunnels</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() =>
              setEditing({
                id: '',
                label: '',
                hostId: hosts[0]?.id ?? '',
                forwardType: 'local',
                localHost: '127.0.0.1',
                localPort: 8080,
                remoteHost: 'localhost',
                remotePort: 80,
              })
            }
            disabled={!hosts.length}
            className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-400/10 text-cyan-300 ring-1 ring-cyan-400/20 hover:bg-cyan-400/20 disabled:opacity-40 cursor-pointer"
            title="New Tunnel"
          >
            <Plus className="h-4 w-4" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title="Close panel"
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tunnels…"
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
          />
        </div>
      </div>

      {editing && (
        <div className="mx-3 mb-2 space-y-2.5 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.04] p-3 shadow-lg">
          <div className="flex items-center justify-between text-xs font-semibold text-cyan-300">
            <span>{editing.id ? 'Edit Tunnel' : 'New SSH Tunnel'}</span>
            <button onClick={() => setEditing(null)} className="text-slate-500 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Tunnel Name *</label>
            <input
              className={inputClass}
              placeholder="e.g. Postgres Staging, Dev Web App"
              value={editing.label}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Forward Type</label>
            <div className="grid grid-cols-3 gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => setEditing({ ...editing, forwardType: 'local' })}
                className={cn(
                  'rounded border py-1.5 text-center transition',
                  editing.forwardType === 'local'
                    ? 'border-cyan-400/50 bg-cyan-400/20 font-medium text-cyan-200'
                    : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5'
                )}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => setEditing({ ...editing, forwardType: 'remote', localHost: editing.localHost || '127.0.0.1', localPort: editing.localPort || 8080, remoteHost: editing.remoteHost || '0.0.0.0', remotePort: editing.remotePort || 8080 })}
                className={cn(
                  'rounded border py-1.5 text-center transition',
                  editing.forwardType === 'remote'
                    ? 'border-violet-400/50 bg-violet-400/20 font-medium text-violet-200'
                    : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5'
                )}
              >
                Remote
              </button>
              <button
                type="button"
                onClick={() => setEditing({ ...editing, forwardType: 'dynamic' })}
                className={cn(
                  'rounded border py-1.5 text-center transition',
                  editing.forwardType === 'dynamic'
                    ? 'border-fuchsia-400/50 bg-fuchsia-400/20 font-medium text-fuchsia-200'
                    : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5'
                )}
              >
                SOCKS5
              </button>
            </div>
            {editing.forwardType === 'remote' && (
              <div className="mt-1.5 rounded-md bg-violet-500/[0.06] px-2 py-1.5 text-[10px] leading-snug text-violet-300/80 ring-1 ring-violet-500/20">
                Reverse tunnel: the SSH server will listen on <b>{editing.remoteHost || '0.0.0.0'}:{editing.remotePort || '?'}</b> and forward connections back to <b>{editing.localHost || '127.0.0.1'}:{editing.localPort || '?'}</b> on this machine. Use port <b>0</b> to let the server allocate an ephemeral port.
              </div>
            )}
            {editing.forwardType === 'local' && (
              <div className="mt-1.5 text-[10px] text-slate-500">Forward local port to a destination reachable from the SSH server.</div>
            )}
            {editing.forwardType === 'dynamic' && (
              <div className="mt-1.5 text-[10px] text-slate-500">Run a SOCKS5 proxy locally; point apps at it to route traffic through the SSH host.</div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Through SSH Host *</label>
            <CustomSelect
              value={editing.hostId}
              onChange={(val) => setEditing({ ...editing, hostId: val })}
              options={hosts.map((h) => ({
                value: h.id,
                label: `${h.label} (${h.username}@${h.hostname}:${h.port})`,
              }))}
            />
          </div>

          {/* Local bind address (forwards that listen on OUR machine: local + dynamic) */}
          {(editing.forwardType === 'local' || editing.forwardType === 'dynamic') && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Local Bind Host</label>
                <input
                  className={inputClass}
                  placeholder="127.0.0.1"
                  value={editing.localHost}
                  onChange={(e) => setEditing({ ...editing, localHost: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Local Port *</label>
                <input
                  type="number"
                  className={inputClass}
                  placeholder="8080"
                  value={editing.localPort || ''}
                  onChange={(e) => setEditing({ ...editing, localPort: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          {/* Forwards that have a "far side" address (local + remote) */}
          {(editing.forwardType === 'local' || editing.forwardType === 'remote') && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">
                  {editing.forwardType === 'local' ? 'Target Host' : 'Remote Bind Host'}
                </label>
                <input
                  className={inputClass}
                  placeholder={editing.forwardType === 'local' ? 'localhost' : '0.0.0.0'}
                  value={editing.remoteHost}
                  onChange={(e) => setEditing({ ...editing, remoteHost: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">
                  {editing.forwardType === 'local' ? 'Target Port' : 'Remote Listen Port'}
                </label>
                <input
                  type="number"
                  className={inputClass}
                  placeholder={editing.forwardType === 'local' ? '80' : '8080'}
                  value={editing.remotePort || ''}
                  onChange={(e) => setEditing({ ...editing, remotePort: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          {/* Remote forwards need a LOCAL target (where to forward connections TO) */}
          {editing.forwardType === 'remote' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Local Target Host</label>
                <input
                  className={inputClass}
                  placeholder="127.0.0.1"
                  value={editing.localHost}
                  onChange={(e) => setEditing({ ...editing, localHost: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Local Target Port *</label>
                <input
                  type="number"
                  className={inputClass}
                  placeholder="8080"
                  value={editing.localPort || ''}
                  onChange={(e) => setEditing({ ...editing, localPort: Number(e.target.value) })}
                />
              </div>
            </div>
          )}

          {/* Dynamic SOCKS5: no remote side, but show a local port field */}
          {editing.forwardType === 'dynamic' && (
            <div className="text-[10px] text-slate-500">
              Local SOCKS5 server will listen on <b>{editing.localHost || '127.0.0.1'}:{editing.localPort || '?'}</b>.
              Configure your browser/tool to use it as a SOCKS5 proxy.
            </div>
          )}

          <div className="flex justify-end gap-1.5 pt-1">
            <button
              onClick={() => setEditing(null)}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-400 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-1 rounded-lg bg-cyan-400 px-3 py-1 text-xs font-semibold text-black hover:bg-cyan-300"
            >
              <Check className="h-3.5 w-3.5" />
              Save
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {!filtered.length && (
          <div className="py-12 text-center text-xs text-slate-500">
            <Network className="mx-auto mb-2 h-8 w-8 opacity-30 text-cyan-300" />
            No port forwards configured.
            <div className="mt-1 text-[11px] text-slate-600">Forward ports, expose local services (reverse), or run a SOCKS5 proxy through a host.</div>
          </div>
        )}

        {filtered.map((t) => {
          const host = hostMap.get(t.hostId);
          const active = activeMap.get(t.id);
          const isRunning = active?.running ?? false;
          const isPending = busy[t.id];

          return (
            <div
              key={t.id}
              className={cn(
                'group relative flex flex-col gap-1.5 rounded-xl border p-2.5 transition',
                isRunning
                  ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
                  : 'border-white/5 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]'
              )}
            >
              <div className="flex items-center gap-2">
                <button
                  disabled={isPending}
                  onClick={() => toggleTunnel(t)}
                  title={isRunning ? 'Stop Tunnel' : 'Start Tunnel'}
                  className={cn(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 transition',
                    isRunning
                      ? 'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40 hover:bg-emerald-500/30'
                      : 'bg-white/5 text-slate-400 ring-white/10 hover:bg-cyan-500/10 hover:text-cyan-300 hover:ring-cyan-500/30'
                  )}
                >
                  {isRunning ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current ml-0.5" />}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-slate-200">{t.label}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider',
                        t.forwardType === 'dynamic'
                          ? 'bg-fuchsia-500/15 text-fuchsia-300'
                          : t.forwardType === 'remote'
                            ? 'bg-violet-500/15 text-violet-300'
                            : 'bg-cyan-500/15 text-cyan-300'
                      )}
                    >
                      {t.forwardType === 'dynamic' ? 'SOCKS5' : t.forwardType === 'remote' ? 'Remote' : 'Local'}
                    </span>
                    {isRunning && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                        Live
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 truncate font-mono text-[11px] text-slate-400">
                    {t.forwardType === 'remote' ? (
                      <>
                        <span className="text-violet-300/80">{t.remoteHost}:{t.remotePort || '?'}</span>
                        <span className="text-slate-600">→</span>
                        <span>{t.localHost}:{t.localPort}</span>
                        {active?.boundPort && t.remotePort === 0 && (
                          <span className="ml-1 text-[9px] text-amber-300/80">(bound {active.boundPort})</span>
                        )}
                      </>
                    ) : (
                      <>
                        <span>{t.localHost}:{t.localPort}</span>
                        <ArrowLeftRight className="h-2.5 w-2.5 text-slate-600" />
                        <span>{t.forwardType === 'dynamic' ? 'SOCKS5 proxy' : `${t.remoteHost}:${t.remotePort}`}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => setEditing(t)}
                    className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                    title="Edit"
                  >
                    <HardDrive className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(t)}
                    className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-white/[0.04] pt-1 text-[10px] text-slate-500">
                <span className="truncate">via {host?.label ?? 'Unknown host'}</span>
                {isRunning && active && (
                  <span className="font-mono text-emerald-400/90">
                    ↑ {formatBytes(active.bytesUp)} · ↓ {formatBytes(active.bytesDown)}
                  </span>
                )}
                {active?.error && (
                  <span className="text-rose-400 truncate max-w-[140px]" title={active.error}>
                    {active.error}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
