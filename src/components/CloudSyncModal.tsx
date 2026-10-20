import { useEffect, useMemo, useState } from 'react';
import {
  Cloud,
  X,
  RefreshCw,
  Key,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Server,
  Loader2,
  CheckSquare,
  Square,
  ArrowRight,
  Search,
  Cpu,
  MapPin,
} from 'lucide-react';
import type { CloudCredentials, CloudInstance, CloudProviderId, Host, Vault } from '../lib/types';
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
  onSuccess: (liveInstances?: CloudInstance[]) => void;
  onDirectConnect?: (h: Partial<Host>) => void;
  toast: (msg: string) => void;
  theme?: DrexiusTheme;
}

const PROVIDERS: Array<{
  id: CloudProviderId;
  label: string;
  shortLabel: string;
  color: string;
  groupName: string;
  subtitle: string;
  tokenHelpUrl: string;
  tokenPlaceholder: string;
}> = [
  {
    id: 'hetzner',
    label: 'Hetzner Cloud',
    shortLabel: 'Hetzner',
    color: '#ef4444',
    groupName: 'Hetzner Cloud',
    subtitle: 'Sync Cloud Servers, IPs, OS flavors & live power states via Read-Only API token',
    tokenHelpUrl: 'https://console.hetzner.cloud/',
    tokenPlaceholder: 'Hetzner Read-Only API Token…',
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    shortLabel: 'DigitalOcean',
    color: '#0080ff',
    groupName: 'DigitalOcean',
    subtitle: 'Sync Droplets, regions, sizes & live power states via Personal Access Token',
    tokenHelpUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    tokenPlaceholder: 'dop_v1_… (Read-Only Personal Access Token)',
  },
  {
    id: 'proxmox',
    label: 'Proxmox VE',
    shortLabel: 'Proxmox VE',
    color: '#f97316',
    groupName: 'Proxmox VE',
    subtitle: 'Sync QEMU VMs & LXC containers across cluster nodes via PVE API Token',
    tokenHelpUrl: 'https://pve.proxmox.com/wiki/Proxmox_VE_API#API_Tokens',
    tokenPlaceholder: 'root@pam!drexius=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
];

export function CloudSyncModal({
  vaults,
  defaultVaultId,
  onClose,
  onSuccess,
  onDirectConnect,
  toast,
  theme,
}: Props) {
  const activeTheme =
    theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const [provider, setProvider] = useState<CloudProviderId>('hetzner');
  const [creds, setCreds] = useState<CloudCredentials>({
    hetznerToken: '',
    digitaloceanToken: '',
    proxmoxUrl: '',
    proxmoxToken: '',
    proxmoxInsecure: false,
  });

  const [instancesByProvider, setInstancesByProvider] = useState<Record<CloudProviderId, CloudInstance[]>>({
    hetzner: [],
    digitalocean: [],
    proxmox: [],
  });
  const [ipOverrides, setIpOverrides] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [defaultUser, setDefaultUser] = useState('root');
  const [defaultPort, setDefaultPort] = useState(22);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const initialVault =
    !defaultVaultId || defaultVaultId === 'all' ? vaults[0]?.id ?? 'personal' : defaultVaultId;
  const [targetVaultId, setTargetVaultId] = useState(initialVault);

  const activeProviderMeta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const instances = instancesByProvider[provider] ?? [];

  useEffect(() => {
    let cancelled = false;
    async function loadCreds() {
      try {
        const saved = await bridge.getCloudCredentials();
        if (cancelled) return;
        setCreds({
          hetznerToken: saved.hetznerToken || '',
          digitaloceanToken: saved.digitaloceanToken || '',
          proxmoxUrl: saved.proxmoxUrl || '',
          proxmoxToken: saved.proxmoxToken || '',
          proxmoxInsecure: saved.proxmoxInsecure ?? false,
        });

        // Auto-select first configured provider and fetch its live fleet
        const firstConfigured: CloudProviderId = saved.hetznerToken
          ? 'hetzner'
          : saved.digitaloceanToken
          ? 'digitalocean'
          : saved.proxmoxToken && saved.proxmoxUrl
          ? 'proxmox'
          : 'hetzner';
        setProvider(firstConfigured);

        const tok =
          firstConfigured === 'hetzner'
            ? saved.hetznerToken
            : firstConfigured === 'digitalocean'
            ? saved.digitaloceanToken
            : saved.proxmoxToken;

        if (tok) {
          setLoading(true);
          const list = await bridge.fetchCloudInstances(
            firstConfigured,
            tok,
            firstConfigured === 'proxmox' ? saved.proxmoxUrl : null,
            firstConfigured === 'proxmox' ? (saved.proxmoxInsecure ?? false) : false
          );
          if (cancelled) return;
          setInstancesByProvider((prev) => ({ ...prev, [firstConfigured]: list }));
          setSelectedIds(new Set(list.map((i) => `${i.provider}:${i.id}`)));
          onSuccess(list);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadCreds();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentToken =
    provider === 'hetzner'
      ? creds.hetznerToken || ''
      : provider === 'digitalocean'
      ? creds.digitaloceanToken || ''
      : creds.proxmoxToken || '';

  const setCurrentToken = (val: string) => {
    setCreds((prev) => ({
      ...prev,
      ...(provider === 'hetzner'
        ? { hetznerToken: val }
        : provider === 'digitalocean'
        ? { digitaloceanToken: val }
        : { proxmoxToken: val }),
    }));
  };

  const fetchFleet = async () => {
    if (!currentToken.trim()) {
      setError(`Please enter your ${activeProviderMeta.label} API token.`);
      return;
    }
    if (provider === 'proxmox' && !(creds.proxmoxUrl || '').trim()) {
      setError('Please enter your Proxmox VE URL (e.g. https://192.168.1.100:8006).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await bridge.saveCloudCredentials(creds);
      const list = await bridge.fetchCloudInstances(
        provider,
        currentToken.trim(),
        provider === 'proxmox' ? creds.proxmoxUrl?.trim() : null,
        provider === 'proxmox' ? (creds.proxmoxInsecure ?? false) : false
      );
      setInstancesByProvider((prev) => ({ ...prev, [provider]: list }));
      setSelectedIds(new Set(list.map((i) => `${i.provider}:${i.id}`)));
      onSuccess(list);
      toast(`Synced ${list.length} ${activeProviderMeta.shortLabel} instances`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const filteredInstances = useMemo(() => {
    if (!search.trim()) return instances;
    const q = search.toLowerCase();
    return instances.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.ip.toLowerCase().includes(q) ||
        (i.region && i.region.toLowerCase().includes(q)) ||
        (i.instanceType && i.instanceType.toLowerCase().includes(q)) ||
        i.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [instances, search]);

  const toggleSelect = (key: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    const keys = filteredInstances.map((i) => `${i.provider}:${i.id}`);
    const allSelected = keys.length > 0 && keys.every((k) => selectedIds.has(k));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(keys));
    }
  };

  const selectOnlyRunning = () => {
    setSelectedIds(
      new Set(
        filteredInstances
          .filter((i) => i.online)
          .map((i) => `${i.provider}:${i.id}`)
      )
    );
  };

  const handleImport = async () => {
    const toImport = instances.filter((i) => selectedIds.has(`${i.provider}:${i.id}`));
    if (toImport.length === 0) {
      toast('Select at least one instance to import');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const payload = toImport.map((i) => {
        const key = `${i.provider}:${i.id}`;
        const ip = (ipOverrides[key] ?? i.ip).trim() || i.name;
        return {
          id: i.id,
          provider: i.provider,
          name: i.name,
          ip,
          username: defaultUser.trim() || 'root',
          port: defaultPort || 22,
          os: i.os || 'linux',
          region: i.region || null,
          tags: i.tags,
          vaultId: targetVaultId,
        };
      });

      const count = await bridge.importCloudInstances(payload);
      toast(`Synced ${count} ${activeProviderMeta.label} hosts to vault!`);
      onSuccess(instances);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ResponsiveOverlay
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
      onClose={onClose}
      label="Cloud fleet sync"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-2xl max-h-[90vh] max-md:max-h-[92dvh] rounded-2xl border shadow-2xl overflow-hidden overflow-x-hidden text-slate-200"
        style={{
          backgroundColor: bgColor,
          borderColor: `${activeProviderMeta.color}38`,
          '--nx-accent': activeProviderMeta.color,
        } as React.CSSProperties}
      >
        <SheetHandle onClose={onClose} />

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25 transition-colors duration-300"
          style={{
            background: `radial-gradient(ellipse at top, ${activeProviderMeta.color} 0%, transparent 70%)`,
          }}
        />

        {/* Modal Header */}
        <div className="relative flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
            <div
              className="grid h-9 w-9 sm:h-10 sm:w-10 shrink-0 place-items-center rounded-xl border shadow-inner transition-colors"
              style={{
                backgroundColor: `${activeProviderMeta.color}18`,
                borderColor: `${activeProviderMeta.color}40`,
                color: activeProviderMeta.color,
              }}
            >
              <Cloud className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight truncate">
                  Cloud Fleet Sync
                </h2>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border shrink-0"
                  style={{
                    backgroundColor: `${activeProviderMeta.color}18`,
                    borderColor: `${activeProviderMeta.color}38`,
                    color: activeProviderMeta.color,
                  }}
                >
                  {activeProviderMeta.shortLabel}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-slate-400 truncate">
                {activeProviderMeta.subtitle}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="max-md:hidden rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Provider Selector Tabs */}
        <div className="grid grid-cols-3 gap-1.5 px-4 sm:px-5 pt-3 shrink-0">
          {PROVIDERS.map((p) => {
            const active = p.id === provider;
            const count = instancesByProvider[p.id]?.length ?? 0;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setProvider(p.id);
                  setError(null);
                  const list = instancesByProvider[p.id] ?? [];
                  setSelectedIds(new Set(list.map((i) => `${i.provider}:${i.id}`)));
                }}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition cursor-pointer',
                  active
                    ? 'text-white shadow-sm'
                    : 'border-white/10 bg-white/[0.02] text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                )}
                style={
                  active
                    ? {
                        backgroundColor: `${p.color}20`,
                        borderColor: `${p.color}55`,
                        color: '#ffffff',
                      }
                    : undefined
                }
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: p.color }}
                />
                <span className="truncate">{p.label}</span>
                {count > 0 && (
                  <span className="rounded-full bg-white/10 px-1.5 py-0.2 font-mono text-[10px] text-slate-200">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5 space-y-4">
          {/* API Credentials Card */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5 space-y-3">
            {provider === 'proxmox' && (
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                    Proxmox VE Server URL
                  </label>
                  <input
                    type="text"
                    value={creds.proxmoxUrl || ''}
                    onChange={(e) => setCreds((prev) => ({ ...prev, proxmoxUrl: e.target.value }))}
                    placeholder="https://192.168.1.100:8006"
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-white/30 focus:outline-none font-mono"
                  />
                </div>
                <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={creds.proxmoxInsecure ?? false}
                    onChange={(e) =>
                      setCreds((prev) => ({ ...prev, proxmoxInsecure: e.target.checked }))
                    }
                  />
                  <span>Allow self-signed TLS</span>
                </label>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Key className="h-3 w-3" />
                  <span>{activeProviderMeta.label} API Token</span>
                </label>
                <a
                  href={activeProviderMeta.tokenHelpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:underline"
                >
                  <span>Create token</span>
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="password"
                  value={currentToken}
                  onChange={(e) => setCurrentToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') fetchFleet();
                  }}
                  placeholder={activeProviderMeta.tokenPlaceholder}
                  className="flex-1 rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-white/30 focus:outline-none font-mono"
                />
                <button
                  type="button"
                  onClick={fetchFleet}
                  disabled={loading}
                  className="flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white transition shadow-md disabled:opacity-50 shrink-0 cursor-pointer"
                  style={{ backgroundColor: activeProviderMeta.color }}
                >
                  {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <span>Fetch Fleet</span>
                </button>
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-slate-500">
                <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
                <span>
                  Encrypted at rest in your local SQLCipher vault. Read-only permissions are sufficient.
                </span>
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 break-words">{error}</div>
            </div>
          )}

          {/* Discovered Instances List */}
          {instances.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-200">
                    Live Fleet ({filteredInstances.length})
                  </span>
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                    {instances.filter((i) => i.online).length} Running
                  </span>
                  {instances.some((i) => !i.online) && (
                    <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300">
                      {instances.filter((i) => !i.online).length} Stopped
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-slate-400 hover:text-white transition cursor-pointer"
                  >
                    {filteredInstances.length > 0 &&
                    filteredInstances.every((i) => selectedIds.has(`${i.provider}:${i.id}`))
                      ? 'Deselect all'
                      : 'Select all'}
                  </button>
                  <span className="text-slate-600">·</span>
                  <button
                    type="button"
                    onClick={selectOnlyRunning}
                    className="text-emerald-400 hover:text-emerald-300 transition cursor-pointer"
                  >
                    Running only
                  </button>
                </div>
              </div>

              {/* Search Filter */}
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5">
                <Search className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by name, IP, region, or tag…"
                  className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none font-mono"
                />
              </div>

              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                {filteredInstances.map((inst) => {
                  const key = `${inst.provider}:${inst.id}`;
                  const checked = selectedIds.has(key);
                  const currentIp = ipOverrides[key] ?? inst.ip;
                  return (
                    <div
                      key={key}
                      onClick={() => toggleSelect(key)}
                      className={cn(
                        'flex items-center justify-between gap-2.5 rounded-xl border p-2.5 transition cursor-pointer',
                        checked
                          ? 'border-white/20 bg-white/[0.06]'
                          : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelect(key);
                          }}
                          className="text-slate-400 hover:text-white shrink-0"
                        >
                          {checked ? (
                            <CheckSquare
                              className="h-4 w-4"
                              style={{ color: activeProviderMeta.color }}
                            />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>

                        <div className="relative shrink-0">
                          <OsIcon os={inst.os} color={activeProviderMeta.color} size={32} />
                          <span
                            title={inst.online ? 'Running' : `Stopped (${inst.status})`}
                            className={cn(
                              'absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[#0b0f17]',
                              inst.online ? 'bg-emerald-400' : 'bg-rose-500'
                            )}
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-white truncate">
                              {inst.name}
                            </span>
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-1.5 py-0.2 text-[9.5px] font-semibold uppercase tracking-wide border',
                                inst.online
                                  ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                                  : 'border-rose-500/30 bg-rose-500/15 text-rose-300'
                              )}
                            >
                              <span
                                className={cn(
                                  'h-1.5 w-1.5 rounded-full',
                                  inst.online ? 'bg-emerald-400' : 'bg-rose-400'
                                )}
                              />
                              {inst.online ? 'Running' : inst.status}
                            </span>
                            {inst.instanceType && (
                              <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.2 font-mono text-[10px] text-slate-400">
                                <Cpu className="h-2.5 w-2.5" />
                                {inst.instanceType}
                              </span>
                            )}
                            {inst.region && (
                              <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.2 font-mono text-[10px] text-slate-400">
                                <MapPin className="h-2.5 w-2.5" />
                                {inst.region}
                              </span>
                            )}
                          </div>

                          <div className="mt-1 flex items-center gap-2">
                            {provider === 'proxmox' ? (
                              <input
                                type="text"
                                value={currentIp}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) =>
                                  setIpOverrides((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                placeholder="IP or hostname…"
                                title="Edit guest IP or hostname if QEMU Guest Agent is not active"
                                className="w-40 rounded border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-[11px] text-slate-200 focus:border-amber-400/50 focus:outline-none"
                              />
                            ) : (
                              <span className="font-mono text-[11px] text-slate-400 truncate">
                                {currentIp}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {onDirectConnect && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDirectConnect({
                              label: inst.name,
                              hostname: currentIp,
                              port: defaultPort || 22,
                              username: defaultUser.trim() || 'root',
                              authMethod: 'key',
                              group: activeProviderMeta.groupName,
                              color: activeProviderMeta.color,
                              tags: inst.tags,
                              os: inst.os || 'linux',
                            });
                            onClose();
                          }}
                          className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-white/10 hover:text-white transition shrink-0 cursor-pointer"
                        >
                          <span>Connect</span>
                          <ArrowRight className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Import Configuration Row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-white/10">
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Default SSH User
                  </label>
                  <input
                    type="text"
                    value={defaultUser}
                    onChange={(e) => setDefaultUser(e.target.value)}
                    placeholder="root"
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:border-white/30 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Default SSH Port
                  </label>
                  <input
                    type="number"
                    value={defaultPort}
                    onChange={(e) => setDefaultPort(parseInt(e.target.value, 10) || 22)}
                    placeholder="22"
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:border-white/30 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    Target Vault
                  </label>
                  <CustomSelect
                    value={targetVaultId}
                    onChange={setTargetVaultId}
                    options={vaults.map((v) => ({ value: v.id, label: v.name }))}
                  />
                </div>
              </div>
            </div>
          )}

          {!loading && instances.length === 0 && !error && (
            <div className="rounded-xl border border-dashed border-white/10 py-8 px-4 text-center">
              <Server className="mx-auto h-7 w-7 text-slate-500 mb-2" />
              <div className="text-xs font-medium text-slate-300">
                Enter your {activeProviderMeta.label} API token and click Fetch Fleet
              </div>
              <p className="mt-1 text-[11px] text-slate-500 max-w-md mx-auto">
                Your servers will be grouped under <b>{activeProviderMeta.groupName}</b> with live{' '}
                <span className="text-emerald-400">Running 🟢</span> /{' '}
                <span className="text-rose-400">Stopped 🔴</span> power badges.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3 border-t border-white/10 bg-black/30 shrink-0">
          <div className="text-xs text-slate-400">
            {selectedIds.size} {selectedIds.size === 1 ? 'instance' : 'instances'} selected
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white transition cursor-pointer"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || selectedIds.size === 0}
              className="flex items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs font-bold text-white transition shadow-lg disabled:opacity-40 cursor-pointer"
              style={{ backgroundColor: activeProviderMeta.color }}
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Cloud className="h-3.5 w-3.5" />
              )}
              <span>Sync {selectedIds.size > 0 ? `(${selectedIds.size})` : ''} to Vault</span>
            </button>
          </div>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
