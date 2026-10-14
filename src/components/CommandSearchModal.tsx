import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { useEffect, useMemo, useState, useRef } from 'react';
import {
  X,
  Star,
  Trash2,
  Terminal,
  Clock,
  Folder,
  ArrowRight,
  Code2,
} from 'lucide-react';
import type { CommandHistoryItem } from '../lib/types';
import { bridge } from '../lib/bridge';
import { CustomSelect } from './CustomSelect';
import { THEMES, type NexusTheme } from '../lib/themes';

interface Props {
  initialHostLabel?: string;
  onClose: () => void;
  onSelect: (command: string, executeImmediately?: boolean) => void;
  onSaveSnippet?: (command: string) => void;
  toast: (msg: string) => void;
  theme?: NexusTheme;
}

const timeAgo = (ts: number): string => {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export function CommandSearchModal({
  initialHostLabel,
  onClose,
  onSelect,
  onSaveSnippet,
  toast,
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0e131d';

  const [history, setHistory] = useState<CommandHistoryItem[]>([]);
  const [q, setQ] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hostFilter, setHostFilter] = useState<string | 'all'>(initialHostLabel ?? 'all');
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const data = await bridge.listCommandHistory(300);
      setHistory(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    inputRef.current?.focus();
  }, []);

  const hosts = useMemo(() => {
    const set = new Set<string>();
    for (const h of history) {
      if (h.hostLabel) set.add(h.hostLabel);
    }
    return Array.from(set);
  }, [history]);

  const filtered = useMemo(() => {
    let list = history;
    if (hostFilter !== 'all') {
      list = list.filter((h) => h.hostLabel === hostFilter);
    }
    if (!q.trim()) return list;
    const term = q.toLowerCase();
    return list.filter(
      (h) =>
        h.command.toLowerCase().includes(term) ||
        h.hostLabel.toLowerCase().includes(term) ||
        (h.cwd && h.cwd.toLowerCase().includes(term))
    );
  }, [history, q, hostFilter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length, q, hostFilter]);

  const handleToggleStar = async (item: CommandHistoryItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const starred = await bridge.toggleStarCommandHistory(item.id);
      setHistory((prev) =>
        prev.map((h) => (h.id === item.id ? { ...h, starred } : h))
      );
      toast(starred ? 'Command bookmarked' : 'Command unbookmarked');
    } catch (err) {
      toast(`Failed to star: ${String(err)}`);
    }
  };

  const handleDelete = async (item: CommandHistoryItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await bridge.deleteCommandHistory(item.id);
      setHistory((prev) => prev.filter((h) => h.id !== item.id));
      toast('Command deleted from history');
    } catch (err) {
      toast(`Failed to delete: ${String(err)}`);
    }
  };

  const handleClear = async () => {
    if (confirm('Clear all unstarred command history?')) {
      try {
        await bridge.clearCommandHistory();
        await refresh();
        toast('Command history cleared');
      } catch (err) {
        toast(`Failed to clear: ${String(err)}`);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => Math.min(filtered.length - 1, idx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => Math.max(0, idx - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex].command, e.shiftKey);
        onClose();
      }
    } else if (e.key === 'r' && e.ctrlKey) {
      // Cycle to next match on Ctrl+R
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1) % Math.max(1, filtered.length));
    }
  };

  return (
    <ResponsiveOverlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-none"
      onClose={onClose} label="Command history"
      onKeyDown={handleKeyDown}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-2xl h-[560px] rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{ backgroundColor: bgColor }}
      >
        <SheetHandle onClose={onClose} />
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-white/10 px-4 py-3 bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-2xl border transition shadow-lg shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <Terminal className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
                  Command History Search
                </h3>
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  Ctrl+Shift+R
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                Reverse-i-search across all previously executed shell commands
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleClear}
              title="Clear unstarred history"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/10 hover:text-rose-300 transition"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Search input & Host filter row */}
        <div className="relative p-3 border-b border-white/5 bg-black/30 flex items-center gap-2">
          <div
            className="flex items-center gap-2 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 shadow-inner focus-within:ring-1"
            style={{ outlineColor: accentColor }}
          >
            <span className="text-[11px] font-mono font-semibold shrink-0" style={{ color: accentColor }}>
              (reverse-i-search)`:
            </span>
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="type to search history..."
              className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none font-mono"
            />
            {q && (
              <button
                onClick={() => setQ('')}
                className="text-slate-500 hover:text-slate-300 text-xs px-1"
              >
                Clear
              </button>
            )}
          </div>

          {/* Host filter dropdown */}
          {hosts.length > 1 && (
            <div className="w-48 shrink-0">
              <CustomSelect
                value={hostFilter}
                options={[
                  { value: 'all', label: `All Hosts (${history.length})` },
                  ...hosts.map((h) => ({ value: h, label: h })),
                ]}
                onChange={(val) => setHostFilter(val)}
                accentColor={accentColor}
              />
            </div>
          )}
        </div>

        {/* History results list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading && (
            <div className="flex items-center justify-center py-16 text-slate-500 text-xs">
              Loading command history...
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
              <Terminal className="h-8 w-8 text-slate-600 mb-2" />
              <p className="text-xs font-medium text-slate-400">
                {q ? 'No matching commands found' : 'Command history is empty'}
              </p>
              <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                Commands run in any local or SSH session are automatically recorded here.
              </p>
            </div>
          )}

          {!loading &&
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;

              return (
                  <div
                    key={item.id}
                    onClick={() => {
                      onSelect(item.command);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`group relative flex items-center justify-between gap-3 rounded-xl border p-2.5 cursor-pointer transition ${
                      isSelected
                        ? 'shadow-sm'
                        : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}
                    style={isSelected ? {
                      borderColor: `${accentColor}50`,
                      backgroundColor: `${accentColor}15`,
                    } : undefined}
                  >
                    {/* Star / Bookmark button */}
                    <button
                      onClick={(e) => handleToggleStar(item, e)}
                      title={item.starred ? 'Unstar' : 'Star command'}
                      className={`shrink-0 p-1 rounded-md transition ${
                        item.starred
                          ? 'text-amber-400 hover:bg-amber-400/20'
                          : 'text-slate-600 hover:text-slate-300 hover:bg-white/10 opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      <Star className={`h-3.5 w-3.5 ${item.starred ? 'fill-amber-400' : ''}`} />
                    </button>

                    {/* Command text & metadata */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-slate-200 truncate font-medium">
                          {item.command}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                        <span className="flex items-center gap-1 font-mono">
                          <Clock className="h-3 w-3" />
                          {timeAgo(item.executedAt)}
                        </span>
                        <span>·</span>
                        <span className="rounded bg-white/5 px-1 py-0.2 font-mono text-slate-400 truncate max-w-[140px]">
                          {item.hostLabel}
                        </span>
                        {item.cwd && (
                          <>
                            <span>·</span>
                            <span className="flex items-center gap-1 font-mono text-slate-500 truncate max-w-[180px]">
                              <Folder className="h-2.5 w-2.5 shrink-0" />
                              <span className="truncate">{item.cwd}</span>
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Actions on hover / selection */}
                    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition">
                      {onSaveSnippet && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSaveSnippet(item.command);
                          }}
                          title="Save command as reusable Snippet"
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                        >
                          <Code2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(item, e)}
                        title="Delete from history"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          onSelect(item.command, false);
                          onClose();
                        }}
                        title="Insert into prompt (Enter)"
                        className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition shadow-sm hover:brightness-110"
                        style={{
                          backgroundColor: `${accentColor}20`,
                          borderColor: `${accentColor}40`,
                          color: accentColor,
                        }}
                      >
                        <span>Insert</span>
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
              );
            })}
        </div>

        {/* Footer shortcuts helper */}
        <div className="flex items-center justify-between border-t border-white/10 bg-black/40 px-4 py-2 text-[11px] text-slate-400 font-mono">
          <div className="flex items-center gap-3">
            <span>↑↓ Select</span>
            <span>↵ Insert</span>
            <span>⇧↵ Run</span>
            <span>Ctrl+R Cycle</span>
            <span>Esc Close</span>
          </div>
          <span className="text-slate-500">
            {filtered.length} of {history.length} commands
          </span>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
