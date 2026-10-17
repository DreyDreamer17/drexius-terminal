import { useEffect, useMemo, useState, useRef } from 'react';
import {
  Clipboard,
  Search,
  X,
  Pin,
  Trash2,
  Check,
  Copy,
  Clock,
  ArrowRight,
} from 'lucide-react';
import type { ClipboardItem } from '../lib/types';
import { bridge } from '../lib/bridge';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { confirmDialog } from './ConfirmDialog';

interface Props {
  onClose: () => void;
  onPaste: (text: string) => void;
  toast: (msg: string) => void;
  theme?: DrexiusTheme;
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

export function ClipboardModal({ onClose, onPaste, toast, theme }: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0e131d';

  const [clips, setClips] = useState<ClipboardItem[]>([]);
  const [q, setQ] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const data = await bridge.listClipboardHistory(100);
      setClips(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // Also read system clipboard if new text is there
    bridge.readClipboard().then((txt) => {
      if (txt && txt.trim().length > 0) {
        bridge.addClipboardHistory(txt, 'System Clipboard').then(() => refresh()).catch(() => {});
      }
    }).catch(() => {});
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return clips;
    const term = q.toLowerCase();
    return clips.filter((c) => c.content.toLowerCase().includes(term));
  }, [clips, q]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length, q]);

  const handleTogglePin = async (c: ClipboardItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const newPinned = await bridge.togglePinClipboard(c.id);
      setClips((prev) => prev.map((item) => (item.id === c.id ? { ...item, pinned: newPinned } : item)));
      toast(newPinned ? 'Pinned clip' : 'Unpinned clip');
    } catch (err) {
      toast(`Failed to pin: ${String(err)}`);
    }
  };

  const handleDelete = async (c: ClipboardItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await bridge.deleteClipboardHistory(c.id);
      setClips((prev) => prev.filter((item) => item.id !== c.id));
      toast('Deleted clip');
    } catch (err) {
      toast(`Failed to delete: ${String(err)}`);
    }
  };

  const handleClear = async () => {
    if (await confirmDialog({ title: 'Clear clipboard history?', message: 'Pinned clips are kept.', confirmLabel: 'Clear', danger: true })) {
      try {
        await bridge.clearClipboardHistory();
        await refresh();
        toast('Clipboard history cleared');
      } catch (err) {
        toast(`Failed to clear: ${String(err)}`);
      }
    }
  };

  const handleCopyOnly = (c: ClipboardItem, e: React.MouseEvent) => {
    e.stopPropagation();
    bridge.writeClipboard(c.content).catch(() => {});
    setCopiedId(c.id);
    setTimeout(() => setCopiedId(null), 1500);
    toast('Copied to system clipboard');
  };

  const handleSelectClip = (c: ClipboardItem) => {
    onPaste(c.content);
    onClose();
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
        handleSelectClip(filtered[selectedIndex]);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-none"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex flex-col w-full max-w-2xl h-[580px] rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{ backgroundColor: bgColor }}
      >
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
              <Clipboard className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
                  Clipboard History
                </h3>
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  ⌘⇧V / Ctrl+Shift+V
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                {clips.length} {clips.length === 1 ? 'item' : 'items'} · Press Enter or click to paste into active terminal
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleClear}
              title="Clear unpinned clips"
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

        {/* Search filter bar */}
        <div className="relative p-3 border-b border-white/5 bg-black/30">
          <div
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 shadow-inner focus-within:ring-1"
            style={{ outlineColor: accentColor }}
          >
            <Search className="h-4 w-4 text-slate-500 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search copied text, commands, tokens, or scripts..."
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
        </div>

        {/* Clips list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading && (
            <div className="flex items-center justify-center py-16 text-slate-500 text-xs">
              Loading clipboard history...
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
              <Clipboard className="h-8 w-8 text-slate-600 mb-2" />
              <p className="text-xs font-medium text-slate-400">
                {q ? 'No clips match your search' : 'Clipboard history is empty'}
              </p>
              <p className="text-[11px] text-slate-600 mt-1 max-w-xs">
                Copy text or select content inside any terminal pane to automatically capture it here.
              </p>
            </div>
          )}

          {!loading &&
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const isMultiLine = item.lineCount > 1;

              return (
                <div
                  key={item.id}
                  onClick={() => handleSelectClip(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`group relative flex items-start gap-3 rounded-xl border p-2.5 cursor-pointer transition ${
                    isSelected
                      ? 'shadow-sm'
                      : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                  style={isSelected ? {
                    borderColor: `${accentColor}50`,
                    backgroundColor: `${accentColor}15`,
                  } : undefined}
                >
                  {/* Pin indicator */}
                  <button
                    onClick={(e) => handleTogglePin(item, e)}
                    title={item.pinned ? 'Unpin' : 'Pin to top'}
                    className={`shrink-0 mt-0.5 p-1 rounded-md transition ${
                      item.pinned
                        ? 'text-amber-400 hover:bg-amber-400/20'
                        : 'text-slate-600 hover:text-slate-300 hover:bg-white/10 opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <Pin className={`h-3.5 w-3.5 ${item.pinned ? 'fill-amber-400' : ''}`} />
                  </button>

                  {/* Content snippet */}
                  <div className="min-w-0 flex-1">
                    <pre className="font-mono text-xs text-slate-200 whitespace-pre-wrap break-all line-clamp-3 leading-relaxed">
                      {item.content}
                    </pre>

                    {/* Metadata tags */}
                    <div className="flex items-center gap-2 mt-2 text-[10px] text-slate-500">
                      <span className="flex items-center gap-1 font-mono">
                        <Clock className="h-3 w-3" />
                        {timeAgo(item.copiedAt)}
                      </span>
                      <span>·</span>
                      <span>
                        {item.charCount} char{item.charCount === 1 ? '' : 's'}
                      </span>
                      {isMultiLine && (
                        <>
                          <span>·</span>
                          <span className="rounded bg-white/5 px-1 py-0.2 font-mono text-slate-400">
                            {item.lineCount} lines
                          </span>
                        </>
                      )}
                      {item.source && (
                        <>
                          <span>·</span>
                          <span className="truncate text-slate-400 max-w-[150px]">
                            {item.source}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions on hover / selection */}
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={(e) => handleCopyOnly(item, e)}
                      title="Copy to OS clipboard without pasting"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                    >
                      {copiedId === item.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      onClick={(e) => handleDelete(item, e)}
                      title="Delete from history"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 transition"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleSelectClip(item)}
                      title="Paste into terminal"
                      className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition shadow-sm hover:brightness-110"
                      style={{
                        backgroundColor: `${accentColor}20`,
                        borderColor: `${accentColor}40`,
                        color: accentColor,
                      }}
                    >
                      <span>Paste</span>
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
            <span>↑↓ Navigate</span>
            <span>↵ Paste into terminal</span>
            <span>Esc Close</span>
          </div>
          <span className="text-slate-500">
            {filtered.length} of {clips.length} clips
          </span>
        </div>
      </div>
    </div>
  );
}
