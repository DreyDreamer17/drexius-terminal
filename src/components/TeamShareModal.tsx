import { useRef, useState } from 'react';
import {
  Users,
  Server,
  Share2,
  Download,
  Upload,
  Copy,
  Check,
  X,
  Lock,
  ShieldCheck,
  FileCheck,
  KeyRound,
  RefreshCw,
  Radio,
} from 'lucide-react';
import type { EncryptedTeamVaultBundle, Host, Vault } from '../lib/types';
import { bridge } from '../lib/bridge';
import { cn } from '../utils/cn';
import { CustomSelect } from './CustomSelect';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';

interface Props {
  vaults: Vault[];
  hosts: Host[];
  activeVaultId: string | 'all';
  initialTab?: 'share' | 'import';
  onClose: () => void;
  onRefresh: () => Promise<void>;
  toast: (msg: string) => void;
  theme?: DrexiusTheme;
}

export function TeamShareModal({
  vaults,
  hosts,
  activeVaultId,
  initialTab = 'share',
  onClose,
  onRefresh,
  toast,
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0e131d';

  const [tab, setTab] = useState<'share' | 'import'>(initialTab);
  const teamVaults = vaults.filter((v) => v.kind === 'team');
  const defaultVault =
    teamVaults.find((v) => v.id === activeVaultId) ?? teamVaults[0] ?? vaults[0];

  const [selectedVaultId, setSelectedVaultId] = useState(defaultVault?.id ?? 'personal');
  const selectedVault = vaults.find((v) => v.id === selectedVaultId) ?? defaultVault;
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [memberRole, setMemberRole] = useState<'editor' | 'readonly'>('editor');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [exportBundle, setExportBundle] = useState<EncryptedTeamVaultBundle | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  // Live Team Relay state
  const [showRelayConfig, setShowRelayConfig] = useState(false);
  const [relayUrl, setRelayUrl] = useState(selectedVault?.relayUrl ?? '');
  const [relayToken, setRelayToken] = useState('');
  const [savingRelay, setSavingRelay] = useState(false);
  const [syncingRelay, setSyncingRelay] = useState(false);

  // Import state
  const [importJson, setImportJson] = useState('');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setImportJson(text.trim());
      setImportFileName(file.name);
      toast(`Loaded ${file.name}`);
    } catch (err: unknown) {
      toast(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  // Host selection for Vault assignment
  const [assignedHostIds, setAssignedHostIds] = useState<Set<string>>(() => {
    return new Set(hosts.filter((h) => h.vaultId === selectedVaultId).map((h) => h.id));
  });

  const toggleHostAssignment = async (hostId: string) => {
    const next = new Set(assignedHostIds);
    const host = hosts.find((h) => h.id === hostId);
    if (!host) return;

    if (next.has(hostId)) {
      next.delete(hostId);
      await bridge.saveHost({ ...host, vaultId: 'personal' });
    } else {
      next.add(hostId);
      await bridge.saveHost({ ...host, vaultId: selectedVaultId });
    }
    setAssignedHostIds(next);
    await onRefresh();
    toast(`Updated vault assignment for ${host.label}`);
  };

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) {
      toast('Please enter a team encryption passphrase');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      toast('Passphrases do not match');
      return;
    }
    setLoading(true);
    try {
      const bundle = await bridge.exportTeamVault(
        selectedVaultId,
        passphrase.trim(),
        includeSecrets,
        memberRole
      );
      setExportBundle(bundle);
      toast('Encrypted Team Vault bundle generated!');
    } catch (err: unknown) {
      toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRelay = async () => {
    setSavingRelay(true);
    try {
      let targetVaultId = selectedVaultId;
      if (targetVaultId === 'personal') {
        targetVaultId = 'shared-personal-vault';
        await bridge.saveVault({
          id: targetVaultId,
          name: 'Shared Team Vault',
          kind: 'team',
          color: '#10b981',
          description: 'Shared Team Vault with Live Relay Sync',
          createdAt: Math.floor(Date.now() / 1000),
          role: 'owner',
        });
        for (const hid of assignedHostIds) {
          const h = hosts.find((x) => x.id === hid);
          if (h) {
            await bridge.saveHost({ ...h, vaultId: targetVaultId });
          }
        }
        setSelectedVaultId(targetVaultId);
      }
      await bridge.configureTeamVaultRelay(
        targetVaultId,
        relayUrl.trim() || null,
        relayToken.trim() || undefined
      );
      await onRefresh();
      setRelayToken('');
      setShowRelayConfig(false);
      toast(relayUrl.trim() ? 'Team Vault Live Relay configured!' : 'Team Vault Live Relay removed.');
    } catch (err: unknown) {
      toast(`Relay config failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingRelay(false);
    }
  };

  const handleSyncRelayNow = async () => {
    if (selectedVaultId === 'personal') return;
    setSyncingRelay(true);
    try {
      const res = await bridge.syncTeamVaultNow(selectedVaultId);
      await onRefresh();
      toast(`Team Vault synced (pushed ${res.pushed}, pulled ${res.pulled})`);
    } catch (err: unknown) {
      toast(`Team sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingRelay(false);
    }
  };

  const handleCopyBundle = () => {
    if (!exportBundle) return;
    navigator.clipboard.writeText(JSON.stringify(exportBundle, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast('Encrypted vault bundle copied to clipboard');
  };

  const handleDownloadBundle = () => {
    if (!exportBundle) return;
    const blob = new Blob([JSON.stringify(exportBundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportBundle.vaultName.toLowerCase().replace(/\s+/g, '-')}.drxvault`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Downloaded .drxvault file');
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importJson.trim()) {
      toast('Please paste the encrypted vault bundle');
      return;
    }
    if (!importPassphrase.trim()) {
      toast('Please enter the team passphrase');
      return;
    }
    setImporting(true);
    try {
      const bundle = JSON.parse(importJson.trim()) as EncryptedTeamVaultBundle;
      const vaultName = await bridge.importTeamVault(bundle, importPassphrase.trim());
      await onRefresh();
      toast(`Successfully imported "${vaultName}" and configurations!`);
      onClose();
    } catch (err: unknown) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <ResponsiveOverlay
      portal
      label="Team vault sharing"
      onClose={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl flex flex-col max-h-[85vh]"
        style={{ backgroundColor: bgColor }}
      >
        <SheetHandle onClose={onClose} />
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4 bg-black/20">
          <div className="flex items-center gap-3">
            <div
              className="grid h-10 w-10 place-items-center rounded-2xl border transition shadow-lg shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <Users className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Team Vault Sharing & Access</h3>
              <p className="flex items-center gap-1 text-[11px] text-slate-400">
                <ShieldCheck className="h-3 w-3 text-emerald-400" />
                Argon2id + ChaCha20-Poly1305 encrypted host configurations & snippets
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="relative flex border-b border-white/5 bg-white/[0.02] px-5 pt-2">
          <button
            onClick={() => setTab('share')}
            className={cn(
              'flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition',
              tab !== 'share' && 'border-transparent text-slate-400 hover:text-slate-200'
            )}
            style={tab === 'share' ? {
              borderColor: accentColor,
              color: accentColor,
            } : undefined}
          >
            <Share2 className="h-3.5 w-3.5" />
            <span>Share & Invite (Export)</span>
          </button>
          <button
            onClick={() => setTab('import')}
            className={cn(
              'flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition',
              tab !== 'import' && 'border-transparent text-slate-400 hover:text-slate-200'
            )}
            style={tab === 'import' ? {
              borderColor: accentColor,
              color: accentColor,
            } : undefined}
          >
            <Download className="h-3.5 w-3.5" />
            <span>Import Shared Vault (.drxvault)</span>
          </button>
        </div>

        {/* Content body */}
        <div className="relative flex-1 overflow-y-auto p-5 space-y-4">
          {tab === 'share' && (
            <>
              {/* Select Vault */}
              <div>
                <label className="text-[11px] font-medium text-slate-300 mb-1 block">Select Team Vault</label>
                <CustomSelect
                  value={selectedVaultId}
                  options={vaults.map((v) => ({
                    value: v.id,
                    label: `${v.name} (${v.kind === 'personal' ? 'Personal' : v.role === 'readonly' ? 'Team · Read-Only' : 'Team Vault'})`,
                  }))}
                  onChange={(val) => {
                    setSelectedVaultId(val);
                    const nextV = vaults.find((v) => v.id === val);
                    setRelayUrl(nextV?.relayUrl ?? '');
                    setAssignedHostIds(
                      new Set(hosts.filter((h) => h.vaultId === val).map((h) => h.id))
                    );
                    setExportBundle(null);
                  }}
                  accentColor={accentColor}
                />
              </div>

              {/* Live Team Relay Sync (Termius-style auto-sync for Team Vaults) */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Radio className={cn('h-4 w-4 shrink-0', selectedVault?.relayUrl ? 'text-emerald-400' : 'text-slate-400')} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-slate-200">Live Team Relay Sync</span>
                        {selectedVault?.relayUrl && (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[9px] font-semibold text-emerald-300">
                            Active
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-slate-400 truncate">
                        {selectedVault?.relayUrl
                          ? `Connected to ${selectedVault.relayUrl}`
                          : 'Optional: link a relay.py server so changes sync live across teammates'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {selectedVault?.relayUrl && (
                      <button
                        type="button"
                        disabled={syncingRelay}
                        onClick={handleSyncRelayNow}
                        className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 transition disabled:opacity-50"
                      >
                        <RefreshCw className={cn('h-3 w-3', syncingRelay && 'animate-spin')} />
                        <span>{syncingRelay ? 'Syncing…' : 'Sync Now'}</span>
                      </button>
                    )}
                    {selectedVault?.role !== 'readonly' && (
                      <button
                        type="button"
                        onClick={() => setShowRelayConfig((s) => !s)}
                        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 transition"
                      >
                        {showRelayConfig ? 'Close' : selectedVault?.relayUrl ? 'Edit Relay' : 'Link relay.py'}
                      </button>
                    )}
                  </div>
                </div>

                {showRelayConfig && selectedVault?.role !== 'readonly' && (
                  <div className="space-y-2 pt-2 border-t border-white/5">
                    <div>
                      <label className="text-[10px] font-medium text-slate-400">Team Relay URL (https:// or LAN http://)</label>
                      <input
                        type="url"
                        placeholder="https://relay.team.example.com or http://192.168.1.50:8787"
                        value={relayUrl}
                        onChange={(e) => setRelayUrl(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-slate-400">Relay Bearer Token (32+ chars)</label>
                      <input
                        type="password"
                        placeholder={selectedVault?.relayUrl ? 'Leave blank to keep existing token' : 'DREXIUS_RELAY_TOKEN value'}
                        value={relayToken}
                        onChange={(e) => setRelayToken(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none"
                      />
                    </div>
                    <p className="text-[10px] text-slate-500">
                      When configured, any `.drxvault` invite you export below automatically includes this Team Relay so teammates stay in live sync after importing.
                    </p>
                    <button
                      type="button"
                      disabled={savingRelay}
                      onClick={handleSaveRelay}
                      className="w-full rounded-lg border border-white/15 bg-white/10 py-1.5 text-xs font-semibold text-white hover:bg-white/15 transition disabled:opacity-50"
                    >
                      {savingRelay ? 'Saving…' : 'Save Team Relay Settings'}
                    </button>
                  </div>
                )}
              </div>

              {/* Step 2: Assign Hosts */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-medium text-slate-300">
                    Shared Hosts ({assignedHostIds.size} selected)
                  </label>
                  <span className="text-[10px] text-slate-500">Toggle hosts into this vault</span>
                </div>
                <div className="max-h-36 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1.5 space-y-1">
                  {hosts.length === 0 ? (
                    <div className="p-3 text-center text-xs text-slate-500">No saved hosts yet.</div>
                  ) : (
                    hosts.map((h) => {
                      const checked = assignedHostIds.has(h.id);
                      return (
                        <label
                          key={h.id}
                          className="flex items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-white/5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={selectedVault?.role === 'readonly'}
                            onChange={() => toggleHostAssignment(h.id)}
                            className="rounded border-white/20 bg-white/10 text-emerald-500 focus:ring-0"
                          />
                          <Server className="h-3.5 w-3.5 text-slate-400" />
                          <span className="font-medium text-slate-200 truncate">{h.label}</span>
                          <span className="font-mono text-[10px] text-slate-500 ml-auto">
                            {h.username}@{h.hostname}:{h.port}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Step 3: Credentials & Role Options (Termius-style) */}
              {!exportBundle ? (
                <form onSubmit={handleExport} className="space-y-3 pt-2 border-t border-white/5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-2.5 cursor-pointer hover:bg-white/[0.05] transition">
                      <input
                        type="checkbox"
                        checked={includeSecrets}
                        onChange={(e) => setIncludeSecrets(e.target.checked)}
                        className="mt-0.5 rounded border-white/20 bg-white/10 text-emerald-500 focus:ring-0"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                          <KeyRound className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                          <span>Include SSH Keys & Passwords</span>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          {includeSecrets
                            ? 'Teammates can one-click connect immediately using shared SSH keys & passwords.'
                            : 'Configs only: teammates must enter their own SSH key or password.'}
                        </p>
                      </div>
                    </label>

                    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                      <label className="text-[11px] font-semibold text-slate-200 block mb-1.5">
                        Teammate Access Role
                      </label>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setMemberRole('editor')}
                          className={cn(
                            'rounded-lg border px-2 py-1 text-[11px] font-medium transition',
                            memberRole === 'editor'
                              ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                              : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                          )}
                        >
                          Editor (R/W)
                        </button>
                        <button
                          type="button"
                          onClick={() => setMemberRole('readonly')}
                          className={cn(
                            'rounded-lg border px-2 py-1 text-[11px] font-medium transition',
                            memberRole === 'readonly'
                              ? 'border-amber-400/50 bg-amber-500/15 text-amber-200'
                              : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-200'
                          )}
                        >
                          Read-Only
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {memberRole === 'editor'
                          ? 'Can connect and add/edit shared hosts & snippets.'
                          : 'Can connect to hosts & run snippets, cannot edit.'}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 p-2.5 text-xs text-cyan-200 flex items-start gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-cyan-400 mt-0.5" />
                    <span>
                      End-to-End Encryption: Sealed with Argon2id + XChaCha20-Poly1305. Only teammates with this passphrase can decrypt the {includeSecrets ? 'hosts, SSH keys, passwords, tunnels & snippets' : 'host configurations, tunnels & snippets'}.
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] font-medium text-slate-300">Team Passphrase</label>
                      <input
                        type="password"
                        required
                        placeholder="••••••••••••"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-slate-300">Confirm Passphrase</label>
                      <input
                        type="password"
                        required
                        placeholder="••••••••••••"
                        value={confirmPassphrase}
                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !passphrase}
                    className="w-full rounded-xl py-2.5 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg"
                    style={{
                      backgroundColor: accentColor,
                      color: '#000000',
                      boxShadow: `0 0 20px ${accentColor}35`,
                    }}
                  >
                    <Lock className="h-3.5 w-3.5" />
                    <span>{loading ? 'Encrypting Vault…' : 'Generate Encrypted Share Bundle'}</span>
                  </button>
                </form>
              ) : (
                /* Generated Bundle Output */
                <div className="space-y-3 pt-2 border-t border-white/5">
                  <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs text-emerald-200 flex items-center gap-2">
                    <FileCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span>Encrypted bundle ready for "{exportBundle.vaultName}". Share this file/text with your teammates along with the passphrase.</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopyBundle}
                      className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 transition"
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copied ? 'Copied Bundle!' : 'Copy Bundle JSON'}</span>
                    </button>
                    <button
                      onClick={handleDownloadBundle}
                      className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg"
                      style={{
                        backgroundColor: accentColor,
                        color: '#000000',
                        borderColor: `${accentColor}50`,
                        boxShadow: `0 0 20px ${accentColor}35`,
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download .drxvault File</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setExportBundle(null)}
                    className="w-full text-center text-[11px] text-slate-500 hover:text-slate-300 py-1"
                  >
                    Generate another bundle or change passphrase
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'import' && (
            <form onSubmit={handleImport} className="space-y-3">
              <div
                className="rounded-lg border p-2.5 text-xs flex items-start gap-2"
                style={{
                  backgroundColor: `${accentColor}12`,
                  borderColor: `${accentColor}30`,
                  color: accentColor,
                }}
              >
                <Download className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Import a shared `.drxvault` file or paste the encrypted JSON payload provided by your team lead.
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-slate-300">
                    Encrypted Bundle JSON {importFileName && <span className="text-emerald-400">({importFileName})</span>}
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".drxvault,.json,application/json,text/plain"
                    onChange={handleLoadFile}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 transition"
                  >
                    <Upload className="h-3 w-3" style={{ color: accentColor }} />
                    <span>Load .drxvault File</span>
                  </button>
                </div>
                <textarea
                  rows={4}
                  required
                  placeholder='Load a .drxvault file above, or paste {"version": 1, "format": "drexius-team-vault", ...}'
                  value={importJson}
                  onChange={(e) => {
                    setImportJson(e.target.value);
                    setImportFileName(null);
                  }}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-300">Team Passphrase</label>
                <input
                  type="password"
                  required
                  placeholder="Enter the passphrase set during export"
                  value={importPassphrase}
                  onChange={(e) => setImportPassphrase(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={importing || !importJson || !importPassphrase}
                className="w-full rounded-xl py-2.5 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 0 20px ${accentColor}35`,
                }}
              >
                <Download className="h-3.5 w-3.5" />
                <span>{importing ? 'Decrypting & Importing…' : 'Decrypt & Merge Team Vault'}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
