import { FolderInput, Plus, Terminal as TerminalIcon, Zap } from 'lucide-react';
import type { DrexiusTheme } from '../lib/themes';
import type { Host } from '../lib/types';
import { BackPriority } from '../lib/backNavigation';
import { useBackHandler } from '../hooks/useBackHandler';
import { safeUid } from '../utils/uuid';

const uid = safeUid;

export interface QuickConnectPaletteProps {
  quickPos: { top: number; left: number };
  quickFilter: string;
  setQuickFilter: (v: string) => void;
  filteredHosts: Host[];
  isAndroid: boolean;
  theme: DrexiusTheme;
  onClose: () => void;
  onOpenHost: (h: Host) => void;
  onOpenLocalTerminal: () => void;
  onOpenTermuxPreset: () => void;
  onOpenHostModal: (host: Host | null) => void;
  onOpenSshConfig: () => void;
}

export function QuickConnectPalette({
  quickPos,
  quickFilter,
  setQuickFilter,
  filteredHosts,
  isAndroid,
  theme,
  onClose,
  onOpenHost,
  onOpenLocalTerminal,
  onOpenTermuxPreset,
  onOpenHostModal,
  onOpenSshConfig,
}: QuickConnectPaletteProps) {
  useBackHandler(true, onClose, BackPriority.MODAL);
  return (
    <div className="fixed inset-0 z-50 select-none" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          top: `${quickPos.top}px`,
          left: `${quickPos.left}px`,
          backgroundColor: theme.xterm.background || '#0e131d',
          borderColor: `${theme.accent}30`,
          boxShadow: `0 16px 40px rgba(0,0,0,0.65), 0 0 24px ${theme.accent}15`,
        }}
        className="absolute w-80 overflow-hidden rounded-xl border p-2 shadow-2xl backdrop-blur-xl ring-1 ring-white/10"
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-20"
          style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
        />
        <div className="relative z-10 flex items-center justify-between px-2 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5">
          <span className="flex items-center gap-1.5" style={{ color: theme.accent }}>
            <Zap className="h-3 w-3" />
            Quick Connect
          </span>
          <span className="font-mono text-[9px] text-slate-500">Esc to close</span>
        </div>

        {/* Filter / Connect Input */}
        <div className="relative z-10 px-1 pt-2 pb-1.5">
          <input
            autoFocus
            type="text"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (filteredHosts.length > 0) {
                  onOpenHost(filteredHosts[0]);
                  onClose();
                } else if (quickFilter.includes('@')) {
                  const [user, rest] = quickFilter.split('@');
                  const [hostStr, portStr] = (rest || '').split(':');
                  const port = parseInt(portStr) || 22;
                  onClose();
                  onOpenHostModal({
                    id: uid(),
                    label: quickFilter,
                    hostname: hostStr || '',
                    port,
                    username: user || 'root',
                    authMethod: 'key',
                    tags: [],
                    hasSecret: false,
                  });
                } else if (!quickFilter || 'local terminal'.includes(quickFilter.toLowerCase())) {
                  onOpenLocalTerminal();
                  onClose();
                }
              }
            }}
            placeholder="Search hosts or user@host…"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors"
            style={{
              borderColor: quickFilter ? `${theme.accent}60` : undefined,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = `${theme.accent}70`;
              e.currentTarget.style.boxShadow = `0 0 0 2px ${theme.accent}20`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = quickFilter ? `${theme.accent}60` : '';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
        </div>

        <div className="relative z-10 max-h-72 overflow-y-auto space-y-0.5 px-0.5">
          {/* Local Terminal Option */}
          {(!quickFilter || 'local terminal'.includes(quickFilter.toLowerCase())) && (
            <button
              onClick={() => {
                onOpenLocalTerminal();
                onClose();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
            >
              <div
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition"
                style={{
                  backgroundColor: `${theme.accent}20`,
                  color: theme.accent,
                }}
              >
                <TerminalIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-slate-200 group-hover:text-white">Local Terminal</div>
                <div className="text-[10px] text-slate-500">{isAndroid ? 'Android /system/bin/sh' : 'bash / zsh shell'}</div>
              </div>
            </button>
          )}

          {/* Termux Local Bridge Option (Android only) */}
          {isAndroid && (!quickFilter || 'termux local 8022'.includes(quickFilter.toLowerCase())) && (
            <button
              onClick={() => {
                onOpenTermuxPreset();
                onClose();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
            >
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400 transition">
                <TerminalIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-slate-200 group-hover:text-white">Termux (Local :8022)</div>
                <div className="text-[10px] text-slate-500">127.0.0.1:8022 · full userland</div>
              </div>
            </button>
          )}

          {/* Saved Hosts */}
          {filteredHosts.map((h) => (
            <button
              key={h.id}
              onClick={() => {
                onOpenHost(h);
                onClose();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/10 group transition"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: h.color ?? '#64748b' }} />
              <div className="min-w-0 flex-1 truncate">
                <div className="text-xs font-medium text-slate-200 group-hover:text-white">{h.label}</div>
                <div className="truncate font-mono text-[10px] text-slate-500">
                  {h.username}@{h.hostname}:{h.port}
                </div>
              </div>
            </button>
          ))}

          {/* Quick connect to new user@host */}
          {quickFilter.includes('@') && (
            <button
              onClick={() => {
                const [user, rest] = quickFilter.split('@');
                const [hostStr, portStr] = (rest || '').split(':');
                const port = parseInt(portStr) || 22;
                onClose();
                onOpenHostModal({
                  id: uid(),
                  label: quickFilter,
                  hostname: hostStr || '',
                  port,
                  username: user || 'root',
                  authMethod: 'key',
                  tags: [],
                  hasSecret: false,
                });
              }}
              className="flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition"
              style={{
                backgroundColor: `${theme.accent}15`,
                borderColor: `${theme.accent}40`,
                color: theme.accent,
              }}
            >
              <Zap className="h-4 w-4 shrink-0" style={{ color: theme.accent }} />
              <div className="min-w-0 flex-1 truncate text-xs">
                Quick setup & connect to <span className="font-semibold text-white">{quickFilter}</span>
              </div>
            </button>
          )}
        </div>

        <div className="relative z-10 mt-1.5 border-t border-white/5 pt-1.5 flex items-center justify-between">
          <button
            onClick={() => {
              onClose();
              onOpenHostModal(null);
            }}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-white/5 transition"
            style={{ color: theme.accent }}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New host…</span>
          </button>
          <button
            onClick={() => {
              onClose();
              onOpenSshConfig();
            }}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:text-amber-300 hover:bg-white/5 transition"
          >
            <FolderInput className="h-3 w-3" />
            <span>Import ~/.ssh/config</span>
          </button>
        </div>
      </div>
    </div>
  );
}
