import { useEffect, useState, useMemo } from 'react';
import {
  Network,
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
} from 'lucide-react';
import type { TailscaleDevice, Vault, Host } from '../lib/types';
import { bridge } from '../lib/bridge';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { OsIcon } from './OsIcon';
import { CustomSelect } from './CustomSelect';
import { THEMES, type NexusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

interface Props {
  vaults: Vault[];
  defaultVaultId?: string | 'all';
  onClose: () => void;
  onSuccess: () => void;
  onDirectConnect?: (h: Partial<Host>) => void;
  toast: (msg: string) => void;
  theme?: NexusTheme;
}

export function TailscaleModal({
  vaults,
  defaultVaultId,
  onClose,
  onSuccess,
  onDirectConnect,
  toast,
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const [mode, setMode] = useState<'cli' | 'api'>('cli');
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [tailnet, setTailnet] = useState('');
  const [devices, setDevices] = useState<TailscaleDevice[]>([]);
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
        const cliDevices = await bridge.detectTailscaleCli().catch(() => null);
        if (cancelled) return;

        if (cliDevices && cliDevices.length > 0) {
          setCliAvailable(true);
          setMode('cli');
          setDevices(cliDevices);
          // By default, select peers (not self)
          const peerIds = cliDevices.filter((d) => !d.isSelf).map((d) => d.id);
          setSelectedIds(new Set(peerIds.length > 0 ? peerIds : cliDevices.map((d) => d.id)));
          setLoading(false);
          return;
        } else {
          setCliAvailable(false);
        }

        // 2. If CLI not detected, check for saved API credentials
        const creds = await bridge.getTailscaleCredentials().catch(() => ({ apiKey: null, tailnet: null }));
        if (cancelled) return;
        if (creds.apiKey) {
          setApiKey(creds.apiKey);
          if (creds.tailnet) setTailnet(creds.tailnet);
          setMode('api');
          const apiDevices = await bridge.fetchTailscaleApi(creds.apiKey, creds.tailnet);
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
      const cliDevices = await bridge.detectTailscaleCli();
      if (!cliDevices || cliDevices.length === 0) {
        setError('Tailscale CLI is not running or no devices were found. Ensure tailscaled is active.');
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
    if (!apiKey.trim()) {
      setError('Please enter a Tailscale API Access Token.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await bridge.saveTailscaleCredentials(apiKey.trim(), tailnet.trim() || null);
      const apiDevices = await bridge.fetchTailscaleApi(apiKey.trim(), tailnet.trim() || null);
      setDevices(apiDevices);
      setSelectedIds(new Set(apiDevices.map((d) => d.id)));
      toast(`Found ${apiDevices.length} Tailscale devices`);
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
      toast('No devices selected for import');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const payload = toImport.map((d) => ({
        hostname: d.hostname,
        ip: d.ip,
        username: defaultUser.trim() || 'root',
        os: d.os || null,
        tailscaleSsh: d.tailscaleSsh,
        vaultId: targetVaultId,
      }));

      const count = await bridge.importTailscaleDevices(payload);
      toast(`Successfully imported ${count} Tailscale hosts!`);
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
      label="Tailscale sync"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-2xl max-h-[90vh] max-md:max-h-[92dvh] rounded-2xl border shadow-2xl overflow-hidden overflow-x-hidden text-slate-200"
        style={{
          backgroundColor: bgColor,
          borderColor: `${accentColor}30`,
          '--nx-accent': accentColor,
        } as React.CSSProperties}
      >
        <SheetHandle onClose={onClose} />

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Modal Header */}
        <div className="relative flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
            <div
              className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl border shadow-sm shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 16px ${accentColor}20`,
              }}
            >
              <Network className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold tracking-wide text-white truncate">Tailscale Sync & Auto-Discovery</h2>
                <span
                  className="hidden xs:inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold border shrink-0"
                  style={{
                    backgroundColor: `${accentColor}18`,
                    borderColor: `${accentColor}35`,
                    color: accentColor,
                  }}
                >
                  Mesh VPN
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 truncate sm:whitespace-normal">
                Import servers, cloud instances, and Tailscale SSH nodes into your vault
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
                    backgroundColor: `${accentColor}20`,
                    borderColor: `${accentColor}40`,
                    color: accentColor,
                  }
                : undefined
            }
          >
            <Terminal className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Local Daemon (CLI)</span>
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
                    backgroundColor: `${accentColor}20`,
                    borderColor: `${accentColor}40`,
                    color: accentColor,
                  }
                : undefined
            }
          >
            <Key className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Tailscale API Token</span>
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
                    ? 'Connected to local Tailscale daemon (`tailscale status`)'
                    : 'Searching for local Tailscale daemon...'}
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
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Tailscale API Token (tskey-api-k...)"
                  className="w-full sm:flex-1 min-w-0 rounded-lg border border-white/10 bg-black/50 px-3 py-2 sm:py-1.5 text-xs font-mono text-slate-200 placeholder:text-slate-500 focus:border-white/30 focus:outline-none"
                />
                <div className="flex items-center gap-2 w-full sm:w-auto min-w-0">
                  <input
                    type="text"
                    value={tailnet}
                    onChange={(e) => setTailnet(e.target.value)}
                    placeholder="Tailnet (optional)"
                    className="flex-1 min-w-0 w-0 sm:w-36 sm:flex-initial rounded-lg border border-white/10 bg-black/50 px-3 py-2 sm:py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-white/30 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={fetchFromApi}
                    disabled={loading || !apiKey.trim()}
                    className="flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 sm:py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-50 shrink-0"
                    style={{
                      backgroundColor: accentColor,
                      color: '#000000',
                    }}
                  >
                    {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    <span>Fetch</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] text-slate-400">
                <span>Stored encrypted in your SQLCipher vault.</span>
                <a
                  href="https://login.tailscale.com/admin/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:underline truncate"
                  style={{ color: accentColor }}
                >
                  <span className="truncate">Generate token in Tailscale Admin</span>
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
                  <CheckSquare className="h-3.5 w-3.5" style={{ color: accentColor }} />
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
              placeholder="Filter nodes…"
              className="w-full sm:w-40 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 sm:py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-white/30"
            />
          </div>
        )}

        {/* Devices List */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-2 space-y-1.5 min-h-[160px]">
          {loading && devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: accentColor }} />
              <p className="text-xs">Scanning Tailnet devices…</p>
            </div>
          ) : filteredDevices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500 gap-2">
              <Server className="h-8 w-8 text-slate-600" />
              <p className="text-xs">No Tailscale devices discovered.</p>
              <p className="text-[11px] text-slate-600 max-w-sm">
                Ensure Tailscale is connected on this machine, or provide an API access token to query your Tailnet.
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
                          borderColor: `${accentColor}50`,
                          backgroundColor: `${accentColor}12`,
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
                        <CheckSquare className="h-4 w-4" style={{ color: accentColor }} />
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
                        <span className="font-medium text-xs text-white truncate max-w-[130px] sm:max-w-none">{dev.hostname}</span>
                        {dev.isSelf && (
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium text-slate-300">
                            This Device
                          </span>
                        )}
                        {dev.tailscaleSsh && (
                          <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                            Tailscale SSH
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 font-mono">
                        <span>{dev.ip}</span>
                        <span className="text-slate-600">·</span>
                        <span className="truncate text-slate-500">{dev.name}</span>
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
                            label: dev.hostname,
                            hostname: dev.ip,
                            port: 22,
                            username: defaultUser.trim() || 'root',
                            authMethod: dev.tailscaleSsh ? 'agent' : 'key',
                            group: 'Tailscale',
                            os: dev.os || null,
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
                    accentColor={accentColor}
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
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 0 20px ${accentColor}35`,
                }}
              >
                {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">Import {selectedIds.size} {selectedIds.size === 1 ? 'Node' : 'Nodes'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
