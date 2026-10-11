import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Star,
  Trash2,
  Clock,
  RotateCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Terminal,
  Copy,
  Code2,
  Check,
  Folder,
} from 'lucide-react';
import type { ConnectionLog, CommandHistoryItem } from '../lib/types';
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

const timeAgo = (ts: number): string => {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export function LogsPanel({ toast }: Props) {
  const [tab, setTab] = useState<'sessions' | 'commands'>('sessions');
  const [logs, setLogs] = useState<ConnectionLog[]>([]);
  const [commands, setCommands] = useState<CommandHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'saved' | 'failed'>('all');
  const [cmdFilter, setCmdFilter] = useState<'all' | 'starred'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refreshSessions = async () => {
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

  const refreshCommands = async () => {
    setLoading(true);
    try {
      const data = await bridge.listCommandHistory(300);
      setCommands(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'sessions') {
      refreshSessions();
    } else {
      refreshCommands();
    }
  }, [tab]);

  // Session actions
  const handleToggleSaved = async (id: string) => {
    try {
      const newSaved = await bridge.toggleLogSaved(id);
      setLogs((prev) => prev.map((l) => (l.id === id ? { ...l, saved: newSaved } : l)));
      toast(newSaved ? 'Session bookmarked' : 'Session unbookmarked');
    } catch (e) {
      toast(`Failed to update bookmark: ${String(e)}`);
    }
  };

  const handleClearSessions = async () => {
    if (confirm('Clear all unsaved connection history? Bookmarked entries will be kept.')) {
      try {
        await bridge.clearLogs();
        await refreshSessions();
        toast('History cleared');
      } catch (e) {
        toast(`Failed to clear: ${String(e)}`);
      }
    }
  };

  // Command actions
  const handleToggleStarCommand = async (id: string) => {
    try {
      const starred = await bridge.toggleStarCommandHistory(id);
      setCommands((prev) =>
        prev.map((c) => (c.id === id ? { ...c, starred } : c))
      );
      toast(starred ? 'Command bookmarked' : 'Command unbookmarked');
    } catch (e) {
      toast(`Failed to bookmark: ${String(e)}`);
    }
  };

  const handleDeleteCommand = async (id: string) => {
    try {
      await bridge.deleteCommandHistory(id);
      setCommands((prev) => prev.filter((c) => c.id !== id));
      toast('Command deleted from history');
    } catch (e) {
      toast(`Failed to delete: ${String(e)}`);
    }
  };

  const handleClearCommands = async () => {
    if (confirm('Clear all unstarred command history?')) {
      try {
        await bridge.clearCommandHistory();
        await refreshCommands();
        toast('Command history cleared');
      } catch (e) {
        toast(`Failed to clear: ${String(e)}`);
      }
    }
  };

  const handleCopyCommand = (item: CommandHistoryItem) => {
    navigator.clipboard.writeText(item.command).catch(() => {});
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
    toast('Command copied to clipboard');
  };

  const handleSaveAsSnippet = async (item: CommandHistoryItem) => {
    try {
      const name = item.command.slice(0, 32);
      await bridge.saveSnippet({
        id: crypto.randomUUID(),
        name,
        command: item.command,
        tags: [item.hostLabel],
      });
      toast(`Saved as snippet: "${name}"`);
    } catch (e) {
      toast(`Failed to save snippet: ${String(e)}`);
    }
  };

  const filteredSessions = useMemo(() => {
    return logs.filter((l) => {
      if (filter === 'saved' && !l.saved) return false;
      if (filter === 'failed' && l.status !== 'failed') return false;
      const str = `${l.hostLabel} ${l.username} ${l.hostname} ${l.status}`.toLowerCase();
      return str.includes(q.toLowerCase());
    });
  }, [logs, filter, q]);

  const filteredCommands = useMemo(() => {
    return commands.filter((c) => {
      if (cmdFilter === 'starred' && !c.starred) return false;
      const str = `${c.command} ${c.hostLabel} ${c.cwd || ''}`.toLowerCase();
      return str.includes(q.toLowerCase());
    });
  }, [commands, cmdFilter, q]);

  return (
    <div className="flex h-full flex-col">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-white">History & Audit</h2>
          <p className="text-[11px] text-slate-500">
            {tab === 'sessions' ? 'Connection audit logs' : 'Executed command history'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={tab === 'sessions' ? refreshSessions : refreshCommands}
            className="grid h-7 w-7 place-items-center rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition"
            title="Refresh history"
          >
            <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <button
            onClick={tab === 'sessions' ? handleClearSessions : handleClearCommands}
            className="grid h-7 w-7 place-items-center rounded-lg bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/20 hover:bg-rose-500/20 transition"
            title={tab === 'sessions' ? 'Clear unsaved session logs' : 'Clear unstarred command history'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Tab Switcher: Sessions vs Commands */}
      <div className="px-3 pb-2">
        <div className="grid grid-cols-2 rounded-xl border border-white/10 bg-black/40 p-1 text-xs">
          <button
            onClick={() => {
              setTab('sessions');
              setQ('');
            }}
            className={cn(
              'rounded-lg py-1 text-center font-medium transition',
              tab === 'sessions'
                ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/30 shadow-sm'
                : 'text-slate-400 hover:text-white'
            )}
          >
            Sessions ({logs.length})
          </button>
          <button
            onClick={() => {
              setTab('commands');
              setQ('');
            }}
            className={cn(
              'rounded-lg py-1 text-center font-medium transition',
              tab === 'commands'
                ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30 shadow-sm'
                : 'text-slate-400 hover:text-white'
            )}
          >
            Commands ({commands.length})
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="px-3 pb-2 space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5 focus-within:border-cyan-500/40">
          <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              tab === 'sessions' ? 'Search session logs…' : 'Search executed commands…'
            }
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none font-mono"
          />
        </div>

        {tab === 'sessions' ? (
          <div className="flex gap-1 text-[11px]">
            {(['all', 'saved', 'failed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded px-2 py-0.5 capitalize transition',
                  filter === f
                    ? 'bg-white/10 text-white'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                {f}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-1 text-[11px]">
            {(['all', 'starred'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setCmdFilter(f)}
                className={cn(
                  'rounded px-2 py-0.5 capitalize transition',
                  cmdFilter === f
                    ? 'bg-white/10 text-white'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 space-y-1">
        {tab === 'sessions' ? (
          <>
            {filteredSessions.map((l) => (
              <div
                key={l.id}
                className="group relative flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-2 hover:bg-white/[0.05] transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {l.status === 'success' && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    )}
                    {l.status === 'failed' && (
                      <XCircle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                    )}
                    {l.status === 'active' && (
                      <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                    )}
                    <span className="truncate text-xs font-medium text-slate-200">
                      {l.hostLabel}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-slate-500">
                    {l.username}@{l.hostname}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {timeAgo(l.startedAt * 1000)}
                    </span>
                    <span>·</span>
                    <span>{formatDuration(l.duration)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleToggleSaved(l.id)}
                    className={cn(
                      'rounded p-1 transition',
                      l.saved
                        ? 'text-amber-400 hover:bg-amber-400/10'
                        : 'text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100'
                    )}
                    title={l.saved ? 'Unbookmark' : 'Bookmark session'}
                  >
                    <Star className={cn('h-3.5 w-3.5', l.saved && 'fill-amber-400')} />
                  </button>
                </div>
              </div>
            ))}
            {!filteredSessions.length && !loading && (
              <div className="py-12 text-center text-xs text-slate-500">
                No session logs match your filter
              </div>
            )}
          </>
        ) : (
          <>
            {filteredCommands.map((cmd) => (
              <div
                key={cmd.id}
                className="group relative flex items-start justify-between gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2 hover:bg-white/[0.05] transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs text-slate-200 truncate font-medium">
                    {cmd.command}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {timeAgo(cmd.executedAt)}
                    </span>
                    <span>·</span>
                    <span className="rounded bg-white/5 px-1 font-mono text-slate-400 truncate max-w-[120px]">
                      {cmd.hostLabel}
                    </span>
                    {cmd.cwd && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1 font-mono text-slate-500 truncate max-w-[120px]">
                          <Folder className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{cmd.cwd}</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition">
                  <button
                    onClick={() => handleCopyCommand(cmd)}
                    title="Copy command"
                    className="rounded p-1 text-slate-400 hover:text-white hover:bg-white/10 transition"
                  >
                    {copiedId === cmd.id ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => handleSaveAsSnippet(cmd)}
                    title="Save as reusable Snippet"
                    className="rounded p-1 text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleToggleStarCommand(cmd.id)}
                    title={cmd.starred ? 'Unstar' : 'Star command'}
                    className={cn(
                      'rounded p-1 transition',
                      cmd.starred
                        ? 'text-amber-400'
                        : 'text-slate-500 hover:text-amber-300 hover:bg-white/10'
                    )}
                  >
                    <Star className={cn('h-3.5 w-3.5', cmd.starred && 'fill-amber-400')} />
                  </button>
                  <button
                    onClick={() => handleDeleteCommand(cmd.id)}
                    title="Delete command"
                    className="rounded p-1 text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {!filteredCommands.length && !loading && (
              <div className="py-12 text-center text-xs text-slate-500">
                No commands match your filter
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
