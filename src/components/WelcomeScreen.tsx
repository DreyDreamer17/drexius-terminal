import { useMemo } from 'react';
import { FolderInput, History, Plus, Terminal as TerminalIcon } from 'lucide-react';
import drexiusLogo from '../assets/drexius-logo.png';
import type { DrexiusTheme } from '../lib/themes';
import type { Host } from '../lib/types';
import { cn } from '../utils/cn';
import { OsIcon } from './OsIcon';

/** Tiny theme preview: terminal background with its red/green/blue/magenta strip (same as the desktop theme popover). */
export function ThemeSwatch({ t, large = false }: { t: DrexiusTheme; large?: boolean }) {
  return (
    <span
      className={cn('nx-theme-swatch', large && 'nx-theme-swatch-lg')}
      style={{ background: t.xterm.background, boxShadow: `0 0 0 1px ${t.accent}55` }}
      aria-hidden="true"
    >
      {[t.xterm.red, t.xterm.green, t.xterm.blue, t.xterm.magenta].map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

export function Welcome({
  hosts,
  recentHostIds,
  theme,
  onOpen,
  onLocal,
  onTermux,
  onNew,
  onSshConfig,
  onViewAll,
}: {
  hosts: Host[];
  recentHostIds: string[];
  theme: DrexiusTheme;
  onOpen: (h: Host) => void;
  onLocal: () => void;
  onTermux?: () => void;
  onNew: () => void;
  onSshConfig: () => void;
  onViewAll?: () => void;
}) {
  const displayHosts = useMemo(() => {
    const hostMap = new Map(hosts.map((h) => [h.id, h]));
    const seen = new Set<string>();
    const list: (Host & { isRecent?: boolean })[] = [];

    // Prioritize recently used hosts
    for (const id of recentHostIds) {
      const h = hostMap.get(id);
      if (h && !seen.has(id)) {
        seen.add(id);
        list.push({ ...h, isRecent: true });
      }
    }

    // Then fill with any other saved hosts
    for (const h of hosts) {
      if (!seen.has(h.id)) {
        seen.add(h.id);
        list.push({ ...h, isRecent: false });
      }
    }

    return list.slice(0, 6);
  }, [hosts, recentHostIds]);

  const hasRecent = recentHostIds.some((id) => hosts.some((h) => h.id === id));

  return (
    <div className="relative grid h-full place-items-center overflow-y-auto overflow-x-hidden no-scrollbar">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.08),transparent_60%)]" />
        <div className="nx-blob pointer-events-none absolute left-1/4 top-1/3 h-72 w-72 rounded-full bg-cyan-500/10 blur-[100px]" />
        <div className="nx-blob-2 pointer-events-none absolute right-1/4 bottom-1/4 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      </div>
      <div className="relative w-full max-w-2xl px-6 py-6 text-center">
        <img
          src={drexiusLogo}
          alt="Drexius"
          className="nx-float mx-auto h-20 w-20 rounded-2xl shadow-[0_0_60px_-10px_rgba(34,211,238,0.5)]"
        />
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-white">Where to today?</h1>
        <p className="mt-2 text-sm text-slate-500">
          Pick a host to open an encrypted session. Select a host to get started; your sessions stay connected while you switch.
        </p>

        {displayHosts.length > 0 && (
          <div className="mt-8 text-left">
            <div className="flex items-center justify-between px-1 mb-2.5">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" style={{ color: theme.accent }} />
                <span>{hasRecent ? 'Recent & Saved Hosts' : 'Saved Hosts'}</span>
              </span>
              {hosts.length > displayHosts.length && onViewAll && (
                <button
                  type="button"
                  onClick={onViewAll}
                  className="text-xs font-medium hover:underline transition cursor-pointer"
                  style={{ color: theme.accent }}
                >
                  View all ({hosts.length}) →
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {displayHosts.map((h) => (
                <button
                  key={h.id}
                  onClick={() => onOpen(h)}
                  className="group relative flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.05] cursor-pointer"
                >
                  <OsIcon os={h.os} color={h.color} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-200 truncate">{h.label}</span>
                      {h.isRecent && (
                        <span
                          className="text-[9px] font-mono px-1.5 py-0 rounded border shrink-0"
                          style={{
                            backgroundColor: `${theme.accent}15`,
                            borderColor: `${theme.accent}30`,
                            color: theme.accent,
                          }}
                        >
                          Recent
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-slate-500">
                      {h.username}@{h.hostname}
                    </div>
                  </div>
                  <span
                    className="ml-auto text-xs opacity-0 transition group-hover:opacity-100 shrink-0"
                    style={{ color: theme.accent }}
                  >
                    Connect →
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onLocal}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/20 transition cursor-pointer"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            Open Local Terminal
          </button>
          {onTermux && (
            <button
              onClick={onTermux}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-400/20 transition cursor-pointer"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              Termux (Local :8022)
            </button>
          )}
          <button
            onClick={onNew}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-4 py-2 text-xs text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200 transition cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a new host
          </button>
          <button
            onClick={onSshConfig}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-amber-400/25 bg-amber-400/[0.03] px-4 py-2 text-xs text-amber-300/80 hover:border-amber-400/50 hover:text-amber-200 transition cursor-pointer"
          >
            <FolderInput className="h-3.5 w-3.5 text-amber-400" />
            Import ~/.ssh/config
          </button>
        </div>
      </div>
    </div>
  );
}
