import { useMobile } from '../hooks/useMobile';
import { MobileSheet } from './MobileSheet';
import { useMemo, useState } from 'react';
import {
  Search,
  Plus,
  KeyRound,
  Lock,
  Fingerprint,
  Pencil,
  Trash2,
  Columns2,
  Terminal as TerminalIcon,
  Radio,
  ArrowRight,
  Users,
  CheckCircle2,
  ChevronDown,
  FolderInput,
  X,
  HardDrive,
  Server,
  Network,
} from 'lucide-react';
import type { Host, Vault } from '../lib/types';
import { THEMES, type NexusTheme } from '../lib/themes';
import { registry } from '../lib/sessions';
import { OsIcon } from './OsIcon';
import { cn } from '../utils/cn';

interface Props {
  hosts: Host[];
  vaults: Vault[];
  activeVaultId: string | 'all';
  onConnect: (h: Host) => void;
  onOpenSftp?: (h: Host) => void;
  onSplit: (h: Host) => void;
  onEdit: (h: Host | null) => void;
  onDelete: (h: Host) => void;
  /** Phone sheet: open another session even when one is already live (row taps resume instead). */
  onNewSession?: (h: Host) => void;
  onOpenTerminal: () => void;
  onOpenSerial: () => void;
  onOpenShareModal: () => void;
  onOpenSshConfig: () => void;
  onOpenTailscale?: () => void;
  onQuickConnectSsh: (target: { username: string; hostname: string; port: number }) => void;
  onClose?: () => void;
  theme?: NexusTheme;
}

const authIcon = { key: KeyRound, password: Lock, agent: Fingerprint };

function parseSshTarget(input: string): { username: string; hostname: string; port: number } | null {
  let s = input.trim();
  if (s.startsWith('ssh ')) {
    s = s.slice(4).trim();
  }
  let port = 22;
  const pMatch = s.match(/-p\s*(\d+)/i);
  if (pMatch) {
    port = parseInt(pMatch[1], 10) || 22;
    s = s.replace(/-p\s*\d+/i, '').trim();
  }
  if (!s) return null;
  let username = 'root';
  let hostname = s;
  if (s.includes('@')) {
    const parts = s.split('@');
    username = parts[0];
    hostname = parts.slice(1).join('@');
  }
  if (hostname.includes(':')) {
    const parts = hostname.split(':');
    hostname = parts[0];
    port = parseInt(parts[1], 10) || port;
  }
  if (!hostname || hostname.includes(' ')) return null;
  return { username, hostname, port };
}

export function HostSidebar({
  hosts,
  vaults,
  activeVaultId,
  onConnect,
  onOpenSftp,
  onSplit,
  onEdit,
  onDelete,
  onNewSession,
  onOpenTerminal,
  onOpenSerial,
  onOpenShareModal,
  onOpenSshConfig,
  onOpenTailscale,
  onQuickConnectSsh,
  onClose,
  theme,
}: Props) {
  const mobile = useMobile();
  const [actionHost, setActionHost] = useState<Host | null>(null);
  const [q, setQ] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  // Filter hosts by active vault first
  const vaultFilteredHosts = useMemo(() => {
    if (activeVaultId === 'all') return hosts;
    return hosts.filter((h) => (h.vaultId || 'personal') === activeVaultId);
  }, [hosts, activeVaultId]);

  // Then filter by search query
  const groups = useMemo(() => {
    const f = vaultFilteredHosts.filter((h) =>
      `${h.label} ${h.hostname} ${h.username} ${h.tags.join(' ')}`
        .toLowerCase()
        .includes(q.toLowerCase())
    );
    const m = new Map<string, Host[]>();
    for (const h of f) {
      const g = h.group || 'Ungrouped';
      m.set(g, [...(m.get(g) ?? []), h]);
    }
    return [...m.entries()];
  }, [vaultFilteredHosts, q]);

  const live = new Set(
    registry
      .all()
      .filter((p) => p.status === 'connected')
      .map((p) => p.hostId)
  );

  const activeVault =
    activeVaultId === 'all'
      ? { id: 'all', name: 'All Vaults', kind: 'team' as const, color: '#38bdf8' }
      : vaults.find((v) => v.id === activeVaultId) ?? vaults[0];

  const isTeamVault = activeVault && activeVault.kind === 'team';

  // Team steps calculation
  const hasTeamHosts = vaultFilteredHosts.length > 0;
  const isExported = localStorage.getItem(`nx.vault.exported.${activeVault?.id}`) === '1';
  const teamStepsDone = 1 + (hasTeamHosts ? 1 : 0) + (isExported ? 1 : 0);

  const handleUniversalConnect = () => {
    if (!q.trim()) return;
    const directMatch = vaultFilteredHosts.find(
      (h) =>
        h.label.toLowerCase() === q.toLowerCase() ||
        h.hostname.toLowerCase() === q.toLowerCase()
    );
    if (directMatch) {
      onConnect(directMatch);
      setQ('');
      return;
    }
    const parsed = parseSshTarget(q);
    if (parsed) {
      onQuickConnectSsh(parsed);
      setQ('');
      return;
    }
    // If only 1 host matches search
    const allMatches = vaultFilteredHosts.filter((h) =>
      `${h.label} ${h.hostname}`.toLowerCase().includes(q.toLowerCase())
    );
    if (allMatches.length === 1) {
      onConnect(allMatches[0]);
      setQ('');
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top Header — desktop only: on phones the app header and vault row above already carry this. */}
      <div className="max-md:hidden flex items-center justify-between px-3.5 pb-2.5 pt-3.5 border-b border-white/5">
        <div>
          <div className="flex items-center gap-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              {activeVault?.name ?? 'Hosts'}
            </h2>
            {isTeamVault && (
              <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300 border border-emerald-500/20">
                <Users className="h-2.5 w-2.5" /> Team
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            {vaultFilteredHosts.length} {vaultFilteredHosts.length === 1 ? 'profile' : 'profiles'} · encrypted vault
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            title="Close panel"
            className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Universal Search & Direct Connect Bar */}
      <div className="px-3 pt-3 pb-2">
        <div
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 shadow-inner transition focus-within:border-white/30"
          style={{ '--nx-accent': accentColor } as React.CSSProperties}
        >
          <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleUniversalConnect();
            }}
            placeholder="Find a host or ssh user@hostname..."
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none font-mono"
          />
          {q.trim() && (
            <button
              onClick={handleUniversalConnect}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition shrink-0 border shadow-sm"
              style={{
                backgroundColor: `${accentColor}20`,
                borderColor: `${accentColor}40`,
                color: accentColor,
              }}
            >
              Connect <ArrowRight className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      </div>

      {/* Termius-style Quick Action Buttons Row */}
      <div className="flex items-center gap-1.5 px-3 pb-2.5">
        <div className="relative">
          <button
            onClick={() => onEdit(null)}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition shadow-sm border"
            style={{
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}40`,
              color: accentColor,
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New host</span>
            <ChevronDown
              className="h-3 w-3 opacity-60 hover:opacity-100 cursor-pointer"
              style={{ color: accentColor }}
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu((m) => !m);
              }}
            />
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowMenu(false)} />
              <div
                className="absolute left-0 top-8 z-40 w-48 rounded-xl border p-1 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
                style={{
                  backgroundColor: bgColor,
                  borderColor: `${accentColor}35`,
                }}
              >
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onEdit(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-left text-slate-300 hover:bg-white/10 hover:text-white transition"
                >
                  <Plus className="h-3.5 w-3.5" style={{ color: accentColor }} />
                  <span>New Host profile</span>
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onOpenShareModal();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-left text-slate-300 hover:bg-white/10 hover:text-white transition"
                >
                  <Users className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Import Vault bundle…</span>
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onOpenSshConfig();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-left text-slate-300 hover:bg-white/10 hover:text-white transition"
                >
                  <FolderInput className="h-3.5 w-3.5 text-amber-400" />
                  <span>Import ~/.ssh/config</span>
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onOpenTailscale?.();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-left text-slate-300 hover:bg-white/10 hover:text-white transition"
                >
                  <Network className="h-3.5 w-3.5" style={{ color: accentColor }} />
                  <span>Tailscale Sync…</span>
                </button>
              </div>
            </>
          )}
        </div>

        <button
          onClick={onOpenTerminal}
          title="Open local shell terminal"
          className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
        >
          <TerminalIcon className="h-3.5 w-3.5 text-slate-400" />
          <span>Terminal</span>
        </button>

        <button
          onClick={onOpenSerial}
          title="Connect via Hardware Serial Port (UART / RS-232)"
          className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-xs text-slate-300 hover:bg-amber-400/10 hover:border-amber-400/30 hover:text-amber-200 transition"
        >
          <Radio className="h-3.5 w-3.5 text-amber-400" />
          <span>Serial</span>
        </button>
      </div>

      {/* Termius-style Team Steps Banner */}
      {isTeamVault && (
        <div className="mx-3 mb-2 rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-2.5 shadow-sm">
          <div className="flex items-center justify-between pb-1.5 border-b border-emerald-500/10">
            <div className="flex items-center gap-1.5">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500/20 text-emerald-300 text-[10px]">
                {teamStepsDone}
              </span>
              <span className="text-[11px] font-medium text-emerald-200">
                Team steps · {teamStepsDone} of 3 done
              </span>
            </div>
            <button
              onClick={onOpenShareModal}
              className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              Share & Invite →
            </button>
          </div>

          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[10.5px] text-emerald-300/90">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span>Enable team vault</span>
            </div>
            <div
              onClick={onOpenShareModal}
              className={cn(
                'flex items-center gap-1.5 text-[10.5px] cursor-pointer hover:underline',
                hasTeamHosts ? 'text-emerald-300/90' : 'text-slate-400'
              )}
            >
              <span
                className={cn(
                  'h-3.5 w-3.5 rounded-full border grid place-items-center text-[8px] shrink-0',
                  hasTeamHosts
                    ? 'border-emerald-400 bg-emerald-500/30 text-emerald-300'
                    : 'border-slate-500 text-slate-500'
                )}
              >
                {hasTeamHosts ? '✓' : '2'}
              </span>
              <span>Share data ({vaultFilteredHosts.length} hosts in vault)</span>
            </div>
            <div
              onClick={onOpenShareModal}
              className={cn(
                'flex items-center gap-1.5 text-[10.5px] cursor-pointer hover:underline',
                isExported ? 'text-emerald-300/90' : 'text-slate-400'
              )}
            >
              <span
                className={cn(
                  'h-3.5 w-3.5 rounded-full border grid place-items-center text-[8px] shrink-0',
                  isExported
                    ? 'border-emerald-400 bg-emerald-500/30 text-emerald-300'
                    : 'border-slate-500 text-slate-500'
                )}
              >
                {isExported ? '✓' : '3'}
              </span>
              <span>Invite members (zero-knowledge bundle)</span>
            </div>
          </div>
        </div>
      )}

      {mobile && actionHost && <MobileSheet title={actionHost.label} kicker={live.has(actionHost.id) ? 'Host · Active' : 'Host'} icon={Server} theme={theme} onClose={() => setActionHost(null)}>
        <p className="mb-3 break-all font-mono text-[11px] leading-relaxed text-slate-500">{actionHost.username}@{actionHost.hostname}:{actionHost.port}</p>
        <div className="nx-settings-group">
          {live.has(actionHost.id)
            ? <>
                <button className="nx-settings-row" onClick={() => { onConnect(actionHost); setActionHost(null); }}><TerminalIcon size={18} /> Return to session</button>
                <button className="nx-settings-row" onClick={() => { (onNewSession ?? onConnect)(actionHost); setActionHost(null); }}><Plus size={18} /> New session</button>
              </>
            : <button className="nx-settings-row" onClick={() => { onConnect(actionHost); setActionHost(null); }}><TerminalIcon size={18} /> Connect</button>}
          {onOpenSftp && <button className="nx-settings-row" onClick={() => { onOpenSftp(actionHost); setActionHost(null); }}><HardDrive size={18} /> Browse files</button>}
          <button className="nx-settings-row" onClick={() => { onSplit(actionHost); setActionHost(null); }}><Plus size={18} /> Add session to current tab</button>
          <button className="nx-settings-row" onClick={() => { onEdit(actionHost); setActionHost(null); }}><Pencil size={18} /> Edit host</button>
          <button className="nx-settings-row text-rose-300" onClick={() => { onDelete(actionHost); setActionHost(null); }}><Trash2 size={18} /> Delete host…</button>
        </div>
      </MobileSheet>}
      {/* Host List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 max-md:pb-24">
        {groups.map(([g, list]) => (
          <div key={g} className="mt-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {g}
            </div>
            {list.map((h) => {
              const Icon = authIcon[h.authMethod];
              return (
                <div
                  key={h.id}
                  onDoubleClick={() => { if (!mobile) onConnect(h); }}
                  onClick={() => onConnect(h)}
                  className="group relative flex max-md:min-h-16 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.04] transition"
                >
                  <div className="relative shrink-0">
                    <OsIcon os={h.os} color={h.color} size={30} />
                    {live.has(h.id) && (
                      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[#0b0f17]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-slate-200">
                      <span className="truncate">{h.label}</span>
                      <Icon className="h-3 w-3 text-slate-500 shrink-0" />
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-slate-500">
                      {h.username}@{h.hostname}
                      {h.port !== 22 ? `:${h.port}` : ''}
                    </div>
                  </div>
                  {live.has(h.id) && <span className="md:hidden shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Active</span>}
                  <button type="button" aria-label={`Actions for ${h.label}`} className="nx-touch-button md:hidden" onClick={e => { e.stopPropagation(); setActionHost(h); }}>•••</button>
                  <div
                    className="max-md:!hidden absolute right-1.5 hidden items-center gap-0.5 rounded-md p-0.5 shadow-lg ring-1 ring-white/10 group-hover:flex"
                    style={{ backgroundColor: bgColor }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {onOpenSftp && (
                      <button
                        title="Open SFTP File Browser"
                        onClick={() => onOpenSftp(h)}
                        className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-emerald-300"
                      >
                        <HardDrive className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      title="Open in split pane"
                      onClick={() => onSplit(h)}
                      className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                    >
                      <Columns2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      title="Edit"
                      onClick={() => onEdit(h)}
                      className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      title="Delete"
                      onClick={() => onDelete(h)}
                      className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {!groups.length && (
          <div className="mt-8 text-center px-4">
            <p className="text-xs text-slate-500">
              {q ? 'No hosts match your search.' : 'No hosts in this vault.'}
            </p>
            <button
              onClick={() => onEdit(null)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs hover:underline"
              style={{ color: accentColor }}
            >
              <Plus className="h-3 w-3" /> Add a host to {activeVault?.name ?? 'vault'}
            </button>
            <div className="mt-2">
              <button
                onClick={onOpenSshConfig}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-amber-300 transition"
              >
                <FolderInput className="h-3 w-3" /> Import from ~/.ssh/config
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
