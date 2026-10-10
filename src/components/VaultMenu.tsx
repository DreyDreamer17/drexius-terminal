import { useState } from 'react';
import {
  FolderKanban,
  Users,
  User,
  Plus,
  ChevronDown,
  Check,
  Share2,
  Download,
  Trash2,
} from 'lucide-react';
import type { Vault } from '../lib/types';
import { cn } from '../utils/cn';

interface Props {
  vaults: Vault[];
  activeVaultId: string | 'all';
  onSelectVault: (id: string | 'all') => void;
  onCreateVault: (v: Vault) => Promise<void>;
  onDeleteVault: (id: string) => Promise<void>;
  onOpenShareModal: () => void;
  onOpenImportModal: () => void;
}

export function VaultMenu({
  vaults,
  activeVaultId,
  onSelectVault,
  onCreateVault,
  onDeleteVault,
  onOpenShareModal,
  onOpenImportModal,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [newVaultColor, setNewVaultColor] = useState('#10b981');
  const [newVaultDesc, setNewVaultDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const activeVault =
    activeVaultId === 'all'
      ? { id: 'all', name: 'All Vaults', kind: 'team' as const, color: '#38bdf8' }
      : vaults.find((v) => v.id === activeVaultId) ?? vaults[0] ?? {
          id: 'personal',
          name: 'Personal Vault',
          kind: 'personal' as const,
          color: '#22d3ee',
        };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVaultName.trim()) return;
    setSaving(true);
    try {
      const v: Vault = {
        id: crypto.randomUUID(),
        name: newVaultName.trim(),
        kind: 'team',
        color: newVaultColor,
        description: newVaultDesc.trim() || undefined,
        createdAt: Date.now(),
      };
      await onCreateVault(v);
      onSelectVault(v.id);
      setShowCreateModal(false);
      setNewVaultName('');
      setNewVaultDesc('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          title="Switch Vault / Team Sharing"
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition border shadow-sm',
            open
              ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40 ring-1 ring-cyan-400/20'
              : 'bg-white/[0.05] border-white/10 text-slate-300 hover:bg-white/[0.1] hover:text-white hover:border-white/20'
          )}
        >
          {activeVault.kind === 'personal' ? (
            <User className="h-3.5 w-3.5 text-cyan-400" />
          ) : (
            <Users className="h-3.5 w-3.5 text-emerald-400" />
          )}
          <span className="font-medium max-w-[120px] truncate">{activeVault.name}</span>
          <ChevronDown className={cn('h-3 w-3 text-slate-400 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-9 z-40 w-64 rounded-xl border border-white/10 bg-[#0e131d]/95 p-1.5 shadow-2xl backdrop-blur-xl">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5 flex items-center justify-between">
                <span>Vaults & Sharing</span>
                <span className="text-[9px] text-cyan-400">Zero-Knowledge</span>
              </div>

              <div className="py-1 space-y-0.5">
                <button
                  onClick={() => {
                    onSelectVault('all');
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-left transition',
                    activeVaultId === 'all'
                      ? 'bg-cyan-500/20 text-cyan-200 font-medium'
                      : 'text-slate-300 hover:bg-white/5 hover:text-white'
                  )}
                >
                  <FolderKanban className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  <span className="flex-1 truncate">All Vaults (Consolidated)</span>
                  {activeVaultId === 'all' && <Check className="h-3 w-3 text-cyan-400 shrink-0" />}
                </button>

                {vaults.map((v) => {
                  const isSelected = v.id === activeVaultId;
                  const isPersonal = v.kind === 'personal';
                  return (
                    <div key={v.id} className="group flex items-center gap-1 rounded-lg hover:bg-white/5 pr-1">
                      <button
                        onClick={() => {
                          onSelectVault(v.id);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-left transition',
                          isSelected
                            ? 'bg-cyan-500/20 text-cyan-200 font-medium'
                            : 'text-slate-300 hover:text-white'
                        )}
                      >
                        {isPersonal ? (
                          <User className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                        ) : (
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ background: v.color || '#10b981' }}
                          />
                        )}
                        <span className="flex-1 truncate">{v.name}</span>
                        {isPersonal && (
                          <span className="rounded bg-white/10 px-1 text-[9px] text-slate-400">Default</span>
                        )}
                        {isSelected && <Check className="h-3 w-3 text-cyan-400 shrink-0" />}
                      </button>
                      {!isPersonal && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (confirm(`Delete team vault "${v.name}"? Hosts will return to Personal Vault.`)) {
                              await onDeleteVault(v.id);
                            }
                          }}
                          title="Delete vault"
                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 transition"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Action shortcuts */}
              <div className="mt-1 border-t border-white/5 pt-1 space-y-0.5">
                <button
                  onClick={() => {
                    setOpen(false);
                    setShowCreateModal(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5 hover:text-white transition"
                >
                  <Plus className="h-3.5 w-3.5 text-emerald-400" />
                  <span>New Team Vault…</span>
                </button>

                <button
                  onClick={() => {
                    setOpen(false);
                    onOpenShareModal();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5 hover:text-white transition"
                >
                  <Share2 className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Share / Invite Members…</span>
                </button>

                <button
                  onClick={() => {
                    setOpen(false);
                    onOpenImportModal();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5 hover:text-white transition"
                >
                  <Download className="h-3.5 w-3.5 text-fuchsia-400" />
                  <span>Import Shared Vault (.nxvault)…</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create Team Vault Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0e131d] p-5 shadow-2xl">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Users className="h-4 w-4 text-emerald-400" />
              Create Team Vault
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Set up an isolated vault for shared team credentials, hosts, and scripts.
            </p>

            <form onSubmit={handleCreate} className="mt-4 space-y-3">
              <div>
                <label className="text-[11px] font-medium text-slate-300">Vault Name</label>
                <input
                  autoFocus
                  required
                  placeholder="e.g. DevOps Core, Production, Staging"
                  value={newVaultName}
                  onChange={(e) => setNewVaultName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-300">Badge Color</label>
                <div className="mt-1.5 flex items-center gap-2">
                  {['#10b981', '#38bdf8', '#f59e0b', '#ec4899', '#8b5cf6', '#f43f5e'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewVaultColor(c)}
                      className={cn(
                        'h-6 w-6 rounded-full transition-transform',
                        newVaultColor === c && 'ring-2 ring-white ring-offset-2 ring-offset-[#0e131d] scale-110'
                      )}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-300">Description (Optional)</label>
                <input
                  placeholder="e.g. Cloud servers & staging clusters"
                  value={newVaultDesc}
                  onChange={(e) => setNewVaultDesc(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !newVaultName.trim()}
                  className="rounded-lg bg-emerald-500/20 border border-emerald-400/40 px-3.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30 transition shadow-sm disabled:opacity-50"
                >
                  {saving ? 'Creating…' : 'Create Team Vault'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
