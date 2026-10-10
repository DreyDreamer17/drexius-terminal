import { useState } from 'react';
import {
  Users,
  Server,
  Share2,
  Download,
  Copy,
  Check,
  X,
  Lock,
  ShieldCheck,
  FileCheck,
} from 'lucide-react';
import type { EncryptedTeamVaultBundle, Host, Vault } from '../lib/types';
import { bridge } from '../lib/bridge';
import { cn } from '../utils/cn';

interface Props {
  vaults: Vault[];
  hosts: Host[];
  activeVaultId: string | 'all';
  initialTab?: 'share' | 'import';
  onClose: () => void;
  onRefresh: () => Promise<void>;
  toast: (msg: string) => void;
}

export function TeamShareModal({
  vaults,
  hosts,
  activeVaultId,
  initialTab = 'share',
  onClose,
  onRefresh,
  toast,
}: Props) {
  const [tab, setTab] = useState<'share' | 'import'>(initialTab);
  const teamVaults = vaults.filter((v) => v.kind === 'team');
  const defaultVault =
    teamVaults.find((v) => v.id === activeVaultId) ?? teamVaults[0] ?? vaults[0];

  const [selectedVaultId, setSelectedVaultId] = useState(defaultVault?.id ?? 'personal');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [exportBundle, setExportBundle] = useState<EncryptedTeamVaultBundle | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  // Import state
  const [importJson, setImportJson] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importing, setImporting] = useState(false);

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
      const bundle = await bridge.exportTeamVault(selectedVaultId, passphrase.trim());
      setExportBundle(bundle);
      toast('Encrypted Team Vault bundle generated!');
    } catch (err: unknown) {
      toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
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
    a.download = `${exportBundle.vaultName.toLowerCase().replace(/\s+/g, '-')}.nxvault`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Downloaded .nxvault file');
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
      toast(`Successfully imported "${vaultName}" and its credentials!`);
      onClose();
    } catch (err: unknown) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#0e131d] shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5 bg-black/20">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Team Vault Sharing & Access</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-white/5 bg-white/[0.02] px-5 pt-2">
          <button
            onClick={() => setTab('share')}
            className={cn(
              'flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition',
              tab === 'share'
                ? 'border-emerald-400 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            )}
          >
            <Share2 className="h-3.5 w-3.5" />
            <span>Share & Invite (Export)</span>
          </button>
          <button
            onClick={() => setTab('import')}
            className={cn(
              'flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition',
              tab === 'import'
                ? 'border-fuchsia-400 text-fuchsia-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            )}
          >
            <Download className="h-3.5 w-3.5" />
            <span>Import Shared Vault (.nxvault)</span>
          </button>
        </div>

        {/* Content body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === 'share' && (
            <>
              {/* Select Vault */}
              <div>
                <label className="text-[11px] font-medium text-slate-300">Select Team Vault</label>
                <select
                  value={selectedVaultId}
                  onChange={(e) => {
                    setSelectedVaultId(e.target.value);
                    setAssignedHostIds(
                      new Set(hosts.filter((h) => h.vaultId === e.target.value).map((h) => h.id))
                    );
                    setExportBundle(null);
                  }}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white focus:border-cyan-400 focus:outline-none"
                >
                  {vaults.map((v) => (
                    <option key={v.id} value={v.id} className="bg-[#0e131d] text-white">
                      {v.name} ({v.kind === 'personal' ? 'Personal' : 'Team Vault'})
                    </option>
                  ))}
                </select>
              </div>

              {/* Step 2: Assign Hosts */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-medium text-slate-300">
                    Shared Hosts ({assignedHostIds.size} selected)
                  </label>
                  <span className="text-[10px] text-slate-500">Toggle hosts into this vault</span>
                </div>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-white/5 bg-white/[0.02] p-1.5 space-y-1">
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

              {/* Step 3: Set Team Passphrase & Encrypt */}
              {!exportBundle ? (
                <form onSubmit={handleExport} className="space-y-3 pt-2 border-t border-white/5">
                  <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 p-2.5 text-xs text-cyan-200 flex items-start gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-cyan-400 mt-0.5" />
                    <span>
                      End-to-End Encryption: The bundle is encrypted with Argon2id + ChaCha20-Poly1305. Only teammates with this passphrase can decrypt the shared hosts.
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
                    className="w-full rounded-lg bg-emerald-500/20 border border-emerald-400/40 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30 transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
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
                      className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 transition"
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copied ? 'Copied Bundle!' : 'Copy Bundle JSON'}</span>
                    </button>
                    <button
                      onClick={handleDownloadBundle}
                      className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/20 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30 transition"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download .nxvault File</span>
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
              <div className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/10 p-2.5 text-xs text-fuchsia-200 flex items-start gap-2">
                <Download className="h-4 w-4 shrink-0 text-fuchsia-400 mt-0.5" />
                <span>
                  Import a shared `.nxvault` file or paste the encrypted JSON payload provided by your team lead.
                </span>
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-300">Encrypted Bundle JSON</label>
                <textarea
                  rows={4}
                  required
                  placeholder='Paste {"version": 1, "format": "nexus-team-vault", ...}'
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-fuchsia-400 focus:outline-none"
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
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-fuchsia-400 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={importing || !importJson || !importPassphrase}
                className="w-full rounded-lg bg-fuchsia-500/20 border border-fuchsia-400/40 py-2 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/30 transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{importing ? 'Decrypting & Importing…' : 'Decrypt & Merge Team Vault'}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
