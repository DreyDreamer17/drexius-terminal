import { useEffect, useState, useMemo } from 'react';
import {
  Globe2,
  X,
  RefreshCw,
  Key,
  Terminal,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Server,
  Loader2,
  CheckSquare,
  Square,
  ArrowRight,
  Zap,
  Radio,
} from 'lucide-react';
import type { NetbirdDevice, Vault, Host } from '../lib/types';
import { bridge } from '../lib/bridge';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { OsIcon } from './OsIcon';
import { CustomSelect } from './CustomSelect';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

interface Props {
  vaults: Vault[];
  defaultVaultId?: string | 'all';
  onClose: () => void;
  onSuccess: () => void;
  onDirectConnect?: (h: Partial<Host>) => void;
  toast: (msg: string) => void;
  theme?: DrexiusTheme;
}

const NETBIRD_ACCENT = '#f97316'; // NetBird brand orange

export function NetbirdModal({
  vaults,
  defaultVaultId,
  onClose,
  onSuccess,
  onDirectConnect,
  toast,
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const [mode, setMode] = useState<'cli' | 'api'>('cli');
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [managementUrl, setManagementUrl] = useState('https://api.netbird.io');
  const [devices, setDevices] = useState<NetbirdDevice[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [defaultUser, setDefaultUser] = useState('root');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const initialVault =
    !defaultVaultId || defaultVaultId === 'all'
      ? vaults[0]?.id ?? 'personal'
      : defaultVaultId;
  const [targetVaultId, setTargetVaultId] = useState(initialVault);

  // Load saved credentials and try local CLI first on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      setError(null);
      try {
        // 1. Try local CLI first
        const cliDevices = await bridge.detectNetbirdCli().catch(() => null);
        if (cancelled) return;

        if (cliDevices && cliDevices.length > 0) {
          setCliAvailable(true);
          setMode('cli');
          setDevices(cliDevices);
          const peerIds = cliDevices.filter((d) => !d.isSelf).map((d) => d.id);
          setSelectedIds(new Set(peerIds.length > 0 ? peerIds : cliDevices.map((d) => d.id)));
          setLoading(false);
          return;
        } else {
          setCliAvailable(false);
        }

        // 2. If CLI not detected, check for saved API credentials
        const creds = await bridge.getNetbirdCredentials().catch(() => ({ token: null, managementUrl: null }));
        if (cancelled) return;
        if (creds.token) {
          setApiToken(creds.token);
          if (creds.managementUrl) setManagementUrl(creds.managementUrl);
          setMode('api');
          const apiDevices = await bridge.fetchNetbirdApi(creds.token, creds.managementUrl);
          if (cancelled) return;
          setDevices(apiDevices);
          setSelectedIds(new Set(apiDevices.map((d) => d.id)));
        } else {
          setMode(cliDevices !== null ? 'cli' : 'api');
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCli = async () => {
    setLoading(true);
    setError(null);
    try {
      const cliDevices = await bridge.detectNetbirdCli();
      if (!cliDevices || cliDevices.length === 0) {
        setError('NetBird CLI is not running or no peers were found. Ensure `netbird status` works.');
        setDevices([]);
        setCliAvailable(false);
      } else {
        setCliAvailable(true);
        setDevices(cliDevices);
        const peerIds = cliDevices.filter((d) => !d.isSelf).map((d) => d.id);
        setSelectedIds(new Set(peerIds.length > 0 ? peerIds : cliDevices.map((d) => d.id)));
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchFromApi = async () => {
    if (!apiToken.trim()) {
      setError('Please enter a NetBird Personal Access Token.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const effectiveUrl = managementUrl.trim() || 'https://api.netbird.io';
      await bridge.saveNetbirdCredentials(apiToken.trim(), effectiveUrl);
      const apiDevices = await bridge.fetchNetbirdApi(apiToken.trim(), effectiveUrl);
      setDevices(apiDevices);
      setSelectedIds(new Set(apiDevices.map((d) => d.id)));
      toast(`Found ${apiDevices.length} NetBird peers`);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filteredDevices.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredDevices.map((d) => d.id)));
    }
  };

  const selectOnlyOnline = () => {
    setSelectedIds(new Set(filteredDevices.filter((d) => d.online).map((d) => d.id)));
  };

  const filteredDevices = useMemo(() => {
    if (!search.trim()) return devices;
    const q = search.toLowerCase();
    return devices.filter(
      (d) =>
        d.hostname.toLowerCase().includes(q) ||
        d.name.toLowerCase().includes(q) ||
        d.ip.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [devices, search]);

  const handleImport = async () => {
    const toImport = devices.filter((d) => selectedIds.has(d.id));
    if (toImport.length === 0) {
      toast('No peers selected for import');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const payload = toImport.map((d) => ({
        hostname: d.hostname || d.name,
        ip: d.ip,
        username: defaultUser.trim() || 'root',
        os: d.os || null,
        vaultId: targetVaultId,
      }));

      const count = await bridge.importNetbirdDevices(payload);
      toast(`Successfully imported ${count} NetBird peers!`);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ResponsiveOverlay
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
      onClose={onClose}
      label="NetBird sync"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-2xl max-h-[90vh] max-md:max-h-[92dvh] rounded-2xl border shadow-2xl overflow-hidden overflow-x-hidden text-slate-200"
        style={{
          backgroundColor: bgColor,
          borderColor: `${NETBIRD_ACCENT}35`,
          '--nx-accent': NETBIRD_ACCENT,
        } as React.CSSProperties}
      >
        <SheetHandle onClose={onClose} />

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${NETBIRD_ACCENT} 0%, transparent 70%)` }}
        />

        {/* Modal Header */}
        <div className="relative flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
            <div
              className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl border shadow-sm shrink-0"
              style={{
                backgroundColor: `${NETBIRD_ACCENT}18`,
                borderColor: `${NETBIRD_ACCENT}35`,
                color: NETBIRD_ACCENT,
                boxShadow: `0 0 16px ${NETBIRD_ACCENT}20`,
              }}
            >
              <Globe2 className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold tracking-wide text-white truncate">NetBird Mesh Sync & Discovery</h2>
                <span
                  className="hidden xs:inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold border shrink-0"
                  style={{
                    backgroundColor: `${NETBIRD_ACCENT}18`,
                    borderColor: `${NETBIRD_ACCENT}35`,
                    color: NETBIRD_ACCENT,
                  }}
                >
                  WireGuard Mesh
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 truncate sm:whitespace-normal">
                Discover peer machines, cloud nodes, and WireGuard tunnels from your NetBird network
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid h-8 w-8 sm:h-9 sm:w-9 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:bg-white/[0.08] hover:text-white transition shrink-0 ml-2"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Connection Source Tabs */}
        <div className="grid grid-cols-2 gap-2 px-4 sm:px-5 pt-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setMode('cli');
              if (cliAvailable) refreshCli();
            }}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl px-2.5 sm:px-3 py-2 text-xs font-medium border transition',
              mode === 'cli'
                ? ''
                : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
            )}
            style={
              mode === 'cli'
                ? {
                    backgroundColor: `${NETBIRD_ACCENT}20`,
                    borderColor: `${NETBIRD_ACCENT}40`,
                    color: NETBIRD_ACCENT,
                  }
                : undefined
            }
          >
            <Terminal className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Local NetBird CLI</span>
            {cliAvailable === true && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" title="Local daemon detected" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setMode('api')}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl px-2.5 sm:px-3 py-2 text-xs font-medium border transition',
              mode === 'api'
                ? ''
                : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
            )}
            style={
              mode === 'api'
                ? {
                    backgroundColor: `${NETBIRD_ACCENT}20`,
                    borderColor: `${NETBIRD_ACCENT}40`,
                    color: NETBIRD_ACCENT,
                  }
                : undefined
            }
          >
            <Key className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Management API Token</span>
          </button>
        </div>

        {/* Source Configuration Controls */}
        <div className="px-4 sm:px-5 pt-3 pb-2 shrink-0">
          {mode === 'cli' ? (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-slate-300 min-w-0">
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                <span className="truncate">
                  {cliAvailable
                    ? 'Connected to local NetBird daemon (`netbird status --json`)'
                    : 'Searching for local NetBird daemon...'}
                </span>
              </div>
              <button
                type="button"
                onClick={refreshCli}
                disabled={loading}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
                <span>Rescan</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-white/10 bg-black/40 p-3 overflow-hidden">
              <div className="flex flex-col sm:flex-row gap-2 w-full min-w-0">
                <input
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder="NetBird Personal Access Token…"
                  className="w-full sm:flex-1 min-w-0 rounded-lg border border-white/10 bg-black/50 px-3 py-2 sm:py-1.5 text-xs font-mono text-slate-200 placeholder:text-slate-500 focus:border-white/30 focus:outline-none"
                />
                <div className="flex items-center gap-2 w-full sm:w-auto min-w-0">
                  <input
                    type="text"
                    value={managementUrl}
                    onChange={(e) => setManagementUrl(e.target.value)}
                    placeholder="https://api.netbird.io"
                    className="flex-1 min-w-0 w-0 sm:w-44 sm:flex-initial rounded-lg border border-white/10 bg-black/50 px-3 py-2 sm:py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-white/30 focus:outline-none"
                    title="NetBird Management API URL (supports self-hosted instances)"
                  />
                  <button
                    type="button"
                    onClick={fetchFromApi}
                    disabled={loading || !apiToken.trim()}
                    className="flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 sm:py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-50 shrink-0"
                    style={{
                      backgroundColor: NETBIRD_ACCENT,
                      color: '#000000',
                    }}
                  >
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    <span>Fetch</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] text-slate-400">
                <span>Stored encrypted in your SQLCipher vault. Supports self-hosted NetBird.</span>
                <a
                  href="https://app.netbird.io/access-control/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:underline truncate"
                  style={{ color: NETBIRD_ACCENT }}
                >
                  <span className="truncate">Generate token in NetBird Dashboard</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Error message banner */}
        {error && (
          <div className="mx-4 sm:mx-5 my-1 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 shrink-0">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {/* Search & Bulk selection bar */}
        {devices.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 sm:px-5 py-2 border-b border-white/5 shrink-0 text-xs">
            <div className="flex items-center justify-between sm:justify-start gap-3">
              <button
                type="button"
                onClick={selectAll}
                className="flex items-center gap-1.5 text-slate-400 hover:text-white transition"
              >
                {selectedIds.size === filteredDevices.length && filteredDevices.length > 0 ? (
                  <CheckSquare className="h-3.5 w-3.5" style={{ color: NETBIRD_ACCENT }} />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
                <span>Select all ({filteredDevices.length})</span>
              </button>
              <button
                type="button"
                onClick={selectOnlyOnline}
                className="text-slate-400 hover:text-emerald-400 transition"
              >
                Online only
              </button>
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter peers…"
              className="w-full sm:w-40 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 sm:py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-white/30"
            />
          </div>
        )}

        {/* Devices List */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-2 space-y-1.5 min-h-[160px]">
          {loading && devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: NETBIRD_ACCENT }} />
              <p className="text-xs">Scanning NetBird peers…</p>
            </div>
          ) : filteredDevices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500 gap-2">
              <Server className="h-8 w-8 text-slate-600" />
              <p className="text-xs">No NetBird peers discovered.</p>
              <p className="text-[11px] text-slate-600 max-w-sm">
                Ensure NetBird is running locally (`netbird up`), or enter an API Access Token from your NetBird Management Console.
              </p>
            </div>
          ) : (
            filteredDevices.map((dev) => {
              const selected = selectedIds.has(dev.id);
              return (
                <div
                  key={dev.id}
                  onClick={() => toggleSelect(dev.id)}
                  className={cn(
                    'group flex items-center justify-between rounded-xl border px-3 py-2.5 transition cursor-pointer',
                    selected
                      ? ''
                      : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/10'
                  )}
                  style={
                    selected
                      ? {
                          borderColor: `${NETBIRD_ACCENT}50`,
                          backgroundColor: `${NETBIRD_ACCENT}12`,
                        }
                      : undefined
                  }
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(dev.id);
                      }}
                      className="text-slate-400 hover:text-white shrink-0"
                    >
                      {selected ? (
                        <CheckSquare className="h-4 w-4" style={{ color: NETBIRD_ACCENT }} />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </button>

                    <div className="shrink-0">
                      <OsIcon os={dev.os || 'linux'} size={28} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full shrink-0',
                            dev.online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-slate-600'
                          )}
                          title={dev.online ? 'Online' : 'Offline'}
                        />
                        <span className="font-medium text-xs text-white truncate max-w-[130px] sm:max-w-none">{dev.hostname || dev.name}</span>
                        {dev.isSelf && (
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium text-slate-300">
                            This Device
                          </span>
                        )}
                        {dev.direct ? (
                          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">
                            <Zap className="h-2.5 w-2.5" />
                            P2P Direct
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                            <Radio className="h-2.5 w-2.5" />
                            Relayed
                          </span>
                        )}
                        {dev.latency && (
                          <span className="text-[10px] font-mono text-slate-400">
                            {dev.latency}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 font-mono">
                        <span className="text-emerald-400/90">{dev.ip}</span>
                        {dev.name && dev.name !== dev.hostname && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span className="truncate text-slate-400">{dev.name}</span>
                          </>
                        )}
                        {dev.tags.length > 0 && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span className="text-[10px] text-slate-500">[{dev.tags.join(', ')}]</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {onDirectConnect && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDirectConnect({
                            label: dev.hostname || dev.name,
                            hostname: dev.ip,
                            port: 22,
                            username: defaultUser.trim() || 'root',
                            authMethod: 'key',
                            group: 'NetBird',
                            os: (dev.os as any) || null,
                          });
                          onClose();
                        }}
                        className="sm:opacity-0 sm:group-hover:opacity-100 flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] sm:text-[10px] text-slate-300 hover:bg-white/[0.1] hover:text-white transition"
                        title="Connect immediately without saving"
                      >
                        <span>Connect</span>
                        <ArrowRight className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Import Settings Footer */}
        <div className="flex flex-col gap-3 px-4 sm:px-5 py-3 sm:py-4 border-t border-white/10 bg-black/40 shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-3 w-full sm:w-auto">
              <label className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 text-slate-400">
                <span className="text-[11px] sm:text-xs">Default user:</span>
                <input
                  type="text"
                  value={defaultUser}
                  onChange={(e) => setDefaultUser(e.target.value)}
                  placeholder="root"
                  className="w-full sm:w-24 rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 sm:py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-white/30"
                />
              </label>

              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 text-slate-400">
                <span className="text-[11px] sm:text-xs">Target vault:</span>
                <div className="w-full sm:w-36">
                  <CustomSelect
                    value={targetVaultId}
                    onChange={(val) => setTargetVaultId(val)}
                    options={vaults.map((v) => ({ value: v.id, label: v.name }))}
                    theme={activeTheme}
                    accentColor={NETBIRD_ACCENT}
                    dropUp
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2 w-full sm:w-auto">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center rounded-xl border border-white/10 px-3.5 py-2 sm:py-1.5 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={importing || selectedIds.size === 0}
                className="flex items-center justify-center gap-2 rounded-xl px-4 sm:px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-50 cursor-pointer shadow-lg truncate"
                style={{
                  backgroundColor: NETBIRD_ACCENT,
                  color: '#000000',
                  boxShadow: `0 0 20px ${NETBIRD_ACCENT}35`,
                }}
              >
                {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">Import {selectedIds.size} {selectedIds.size === 1 ? 'Peer' : 'Peers'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
