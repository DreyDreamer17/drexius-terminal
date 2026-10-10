import { useEffect, useMemo, useState } from 'react';
import { Search, Star, Trash2, Clock, RotateCw, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import type { ConnectionLog } from '../lib/types';
import { bridge } from '../lib/bridge';
import { cn } from '../utils/cn';

interface Props {
  toast: (m: string) => void;
}

const formatDuration = (seconds?: number | null) => {
  if (seconds === undefined || seconds === null) return 'Active';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
};

export function LogsPanel({ toast }: Props) {
  const [logs, setLogs] = useState<ConnectionLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'saved' | 'failed'>('all');

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await bridge.listLogs(200);
      setLogs(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleToggleSaved = async (id: string) => {
    try {
      const newSaved = await bridge.toggleLogSaved(id);
      setLogs((prev) => prev.map((l) => (l.id === id ? { ...l, saved: newSaved } : l)));
      toast(newSaved ? 'Session bookmarked' : 'Session unbookmarked');
    } catch (e) {
      toast(`Failed to update bookmark: ${String(e)}`);
    }
  };

  const handleClear = async () => {
    if (confirm('Clear all unsaved connection history? Bookmarked entries will be kept.')) {
      try {
        await bridge.clearLogs();
        await refresh();
        toast('History cleared');
      } catch (e) {
        toast(`Failed to clear: ${String(e)}`);
      }
    }
  };

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (filter === 'saved' && !l.saved) return false;
      if (filter === 'failed' && l.status !== 'failed') return false;
      const str = `${l.hostLabel} ${l.username} ${l.hostname} ${l.status}`.toLowerCase();
      return str.includes(q.toLowerCase());
    });
  }, [logs, filter, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Connection History</h2>
          <p className="text-[11px] text-slate-500">Audit log of SSH and local terminal sessions</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            className="grid h-7 w-7 place-items-center rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
            title="Refresh logs"
          >
            <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <button
            onClick={handleClear}
            className="grid h-7 w-7 place-items-center rounded-lg bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/20 hover:bg-rose-500/20"
            title="Clear unsaved logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2 space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search session logs…"
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
          />
        </div>

        <div className="flex gap-1 text-[11px]">
          {(['all', 'saved', 'failed'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={cn(
                'rounded-lg px-2.5 py-1 capitalize transition',
                filter === tab
                  ? 'bg-cyan-400/20 text-cyan-300 font-medium ring-1 ring-cyan-400/30'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              )}
            >
              {tab === 'saved' ? 'Bookmarked' : tab}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {!filtered.length && (
          <div className="py-12 text-center text-xs text-slate-500">
            <Clock className="mx-auto mb-2 h-8 w-8 opacity-30 text-slate-400" />
            No connection records match the filter.
          </div>
        )}

        {filtered.map((l) => {
          const isOk = l.status === 'connected' || l.status === 'disconnected';
          const isErr = l.status === 'failed';

          return (
            <div
              key={l.id}
              className="group relative flex flex-col gap-1.5 rounded-xl border border-white/5 bg-white/[0.02] p-2.5 transition hover:border-white/15 hover:bg-white/[0.04]"
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1',
                    isOk
                      ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                      : isErr
                      ? 'bg-rose-500/10 text-rose-400 ring-rose-500/20'
                      : 'bg-amber-500/10 text-amber-400 ring-amber-500/20'
                  )}
                >
                  {isOk ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : isErr ? (
                    <XCircle className="h-3.5 w-3.5" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-slate-200">{l.hostLabel}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider',
                        l.status === 'connected'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : l.status === 'failed'
                          ? 'bg-rose-500/15 text-rose-300'
                          : 'bg-white/5 text-slate-400'
                      )}
                    >
                      {l.status}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-slate-500">
                    {l.username}@{l.hostname}
                  </div>
                </div>

                <button
                  onClick={() => handleToggleSaved(l.id)}
                  title={l.saved ? 'Remove bookmark' : 'Bookmark log'}
                  className={cn(
                    'rounded p-1 transition',
                    l.saved
                      ? 'text-amber-300 hover:text-amber-200'
                      : 'text-slate-600 opacity-0 group-hover:opacity-100 hover:text-slate-300'
                  )}
                >
                  <Star className={cn('h-3.5 w-3.5', l.saved && 'fill-current')} />
                </button>
              </div>

              <div className="flex items-center justify-between border-t border-white/[0.04] pt-1 text-[10px] text-slate-500 font-mono">
                <span>{new Date(l.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                <span>{formatDuration(l.duration)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
