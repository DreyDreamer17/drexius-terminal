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
  QrCode,
} from 'lucide-react';
import type { Vault } from '../lib/types';
import type { NexusTheme } from '../lib/themes';
import { safeUid } from '../utils/uuid';
import { cn } from '../utils/cn';
import { confirmDialog } from './ConfirmDialog';

interface Props {
  vaults: Vault[];
  activeVaultId: string | 'all';
  onSelectVault: (id: string | 'all') => void;
  onCreateVault: (v: Vault) => Promise<void>;
  onDeleteVault: (id: string) => Promise<void>;
  onOpenShareModal: () => void;
  onOpenImportModal: () => void;
  onOpenPairingModal?: () => void;
  theme?: NexusTheme;
}

export function VaultMenu({
  vaults,
  activeVaultId,
  onSelectVault,
  onCreateVault,
  onDeleteVault,
  onOpenShareModal,
  onOpenImportModal,
  onOpenPairingModal,
  theme,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [newVaultColor, setNewVaultColor] = useState('#10b981');
  const [newVaultDesc, setNewVaultDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const accentColor = theme?.accent || '#22d3ee';
  const bgColor = theme?.xterm?.background || '#0e131d';

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
        id: safeUid(),
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
            'flex h-7 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-all duration-150 border shadow-sm select-none',
            open
              ? 'text-white'
              : 'bg-white/[0.05] border-white/10 text-slate-300 hover:bg-white/[0.1] hover:text-white hover:border-white/20'
          )}
          style={
            open
              ? {
                  backgroundColor: `${accentColor}18`,
                  borderColor: `${accentColor}45`,
                  boxShadow: `0 0 16px ${accentColor}25`,
                }
              : undefined
          }
        >
          {activeVault.kind === 'personal' ? (
            <User className="h-3.5 w-3.5 transition-colors" style={{ color: open ? accentColor : (theme?.accent || '#22d3ee') }} />
          ) : (
            <Users className="h-3.5 w-3.5" style={{ color: activeVault.color || '#10b981' }} />
          )}
          <span className="font-semibold max-w-[130px] truncate">{activeVault.name}</span>
          <ChevronDown
            className="h-3 w-3 transition-transform duration-200"
            style={{
              transform: open ? 'rotate(180deg)' : 'none',
              color: open ? accentColor : '#94a3b8',
            }}
          />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div
              className="absolute left-0 top-9 z-40 w-72 rounded-2xl border border-white/10 p-1.5 shadow-2xl backdrop-blur-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
              style={{
                background: bgColor,
                boxShadow: `0 0 30px ${accentColor}18, 0 20px 45px rgba(0, 0, 0, 0.75)`,
              }}
            >
              {/* Top ambient radial glow */}
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25"
                style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
              />
              {/* Subtle glowing top line */}
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-75"
                style={{ background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)` }}
              />

              <div className="relative px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/5 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <FolderKanban className="h-3.5 w-3.5" style={{ color: accentColor }} />
                  <span>Vaults & Sharing</span>
                </span>
                <span
                  className="text-[9px] px-2 py-0.5 rounded-full border font-mono tracking-normal shadow-sm font-semibold"
                  style={{
                    color: accentColor,
                    backgroundColor: `${accentColor}15`,
                    borderColor: `${accentColor}30`,
                    boxShadow: `0 0 10px ${accentColor}15`,
                  }}
                >
                  Zero-Knowledge
                </span>
              </div>

              <div className="relative py-1 space-y-1">
                <button
                  onClick={() => {
                    onSelectVault('all');
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs text-left transition-all',
                    activeVaultId === 'all'
                      ? 'text-white font-medium border'
                      : 'text-slate-300 hover:bg-white/[0.06] hover:text-white border border-transparent'
                  )}
                  style={
                    activeVaultId === 'all'
                      ? {
                          backgroundColor: `${accentColor}18`,
                          borderColor: `${accentColor}35`,
                          boxShadow: `0 0 14px ${accentColor}18`,
                        }
                      : undefined
                  }
                >
                  <div
                    className="grid h-6 w-6 place-items-center rounded-lg border border-white/10 shrink-0"
                    style={{ backgroundColor: activeVaultId === 'all' ? `${accentColor}25` : 'rgba(255,255,255,0.04)' }}
                  >
                    <FolderKanban className="h-3.5 w-3.5" style={{ color: activeVaultId === 'all' ? accentColor : '#38bdf8' }} />
                  </div>
                  <span className="flex-1 truncate">All Vaults (Consolidated)</span>
                  {activeVaultId === 'all' && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />}
                </button>

                {vaults.map((v) => {
                  const isSelected = v.id === activeVaultId;
                  const isPersonal = v.kind === 'personal';
                  return (
                    <div key={v.id} className="group relative flex items-center gap-1 rounded-xl">
                      <button
                        onClick={() => {
                          onSelectVault(v.id);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs text-left transition-all',
                          isSelected
                            ? 'text-white font-medium border'
                            : 'text-slate-300 hover:bg-white/[0.06] hover:text-white border border-transparent'
                        )}
                        style={
                          isSelected
                            ? {
                                backgroundColor: `${accentColor}18`,
                                borderColor: `${accentColor}35`,
                                boxShadow: `0 0 14px ${accentColor}18`,
                              }
                            : undefined
                        }
                      >
                        <div
                          className="grid h-6 w-6 place-items-center rounded-lg border border-white/10 shrink-0"
                          style={{
                            backgroundColor: isSelected
                              ? `${accentColor}25`
                              : isPersonal
                              ? 'rgba(255,255,255,0.04)'
                              : `${v.color || '#10b981'}20`,
                          }}
                        >
                          {isPersonal ? (
                            <User className="h-3.5 w-3.5" style={{ color: isSelected ? accentColor : (theme?.accent || '#22d3ee') }} />
                          ) : (
                            <span
                              className="h-2 w-2 rounded-full shadow-sm"
                              style={{ background: v.color || '#10b981', boxShadow: `0 0 6px ${v.color || '#10b981'}` }}
                            />
                          )}
                        </div>
                        <span className="flex-1 truncate">{v.name}</span>
                        {isPersonal && (
                          <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-medium text-slate-400">
                            Default
                          </span>
                        )}
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />}
                      </button>
                      {!isPersonal && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (await confirmDialog({ title: `Delete team vault "${v.name}"?`, message: 'Its hosts will move back to your Personal Vault.', confirmLabel: 'Delete vault', danger: true })) {
                              await onDeleteVault(v.id);
                            }
                          }}
                          title="Delete vault"
                          className="opacity-0 group-hover:opacity-100 rounded-lg p-1.5 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 transition shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Action shortcuts */}
              <div className="relative mt-1 border-t border-white/5 pt-1.5 space-y-1">
                <button
                  onClick={() => {
                    setOpen(false);
                    setShowCreateModal(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs text-slate-300 hover:bg-white/[0.06] hover:text-white transition group"
                >
                  <div className="grid h-6 w-6 place-items-center rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-emerald-400 shrink-0 group-hover:scale-105 transition-transform">
                    <Plus className="h-3.5 w-3.5" />
                  </div>
                  <span className="font-medium">New Team Vault…</span>
                </button>

                <button
                  onClick={() => {
                    setOpen(false);
                    onOpenShareModal();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs text-slate-300 hover:bg-white/[0.06] hover:text-white transition group"
                >
                  <div
                    className="grid h-6 w-6 place-items-center rounded-lg border shrink-0 group-hover:scale-105 transition-transform"
                    style={{
                      borderColor: `${accentColor}35`,
                      backgroundColor: `${accentColor}18`,
                      color: accentColor,
                    }}
                  >
                    <Share2 className="h-3.5 w-3.5" />
                  </div>
                  <span className="font-medium">Share / Invite Members…</span>
                </button>

                <button
                  onClick={() => {
                    setOpen(false);
                    onOpenImportModal();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs text-slate-300 hover:bg-white/[0.06] hover:text-white transition group"
                >
                  <div className="grid h-6 w-6 place-items-center rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-400 shrink-0 group-hover:scale-105 transition-transform">
                    <Download className="h-3.5 w-3.5" />
                  </div>
                  <span className="font-medium">Import Shared Vault (.nxvault)…</span>
                </button>

                {onOpenPairingModal && (
                  <button
                    onClick={() => {
                      setOpen(false);
                      onOpenPairingModal();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs text-amber-300 hover:bg-white/[0.06] transition group"
                  >
                    <div className="grid h-6 w-6 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/15 text-amber-400 shrink-0 group-hover:scale-105 transition-transform">
                      <QrCode className="h-3.5 w-3.5" />
                    </div>
                    <span className="font-medium">Link Device (QR & PIN)…</span>
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create Team Vault Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div
            className="relative w-full max-w-sm rounded-2xl border border-white/10 p-5 shadow-2xl overflow-hidden"
            style={{ background: bgColor }}
          >
            {/* Top ambient radial glow */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-36 opacity-25"
              style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
            />

            <div className="relative flex items-center gap-3">
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
                <h3 className="text-sm font-semibold text-white">Create Team Vault</h3>
                <p className="text-xs text-slate-400">
                  Set up an isolated vault for shared team credentials and hosts.
                </p>
              </div>
            </div>

            <form onSubmit={handleCreate} className="relative mt-4 space-y-3">
              <div>
                <label className="text-[11px] font-medium text-slate-300">Vault Name</label>
                <input
                  autoFocus
                  required
                  placeholder="e.g. DevOps Core, Production, Staging"
                  value={newVaultName}
                  onChange={(e) => setNewVaultName(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none transition"
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = accentColor;
                    e.currentTarget.style.boxShadow = `0 0 0 1px ${accentColor}40`;
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = '';
                    e.currentTarget.style.boxShadow = '';
                  }}
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
                  className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none transition"
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = accentColor;
                    e.currentTarget.style.boxShadow = `0 0 0 1px ${accentColor}40`;
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = '';
                    e.currentTarget.style.boxShadow = '';
                  }}
                />
              </div>

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-xl px-3.5 py-2 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !newVaultName.trim()}
                  className="rounded-xl px-4 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg disabled:opacity-50"
                  style={{
                    backgroundColor: accentColor,
                    color: '#000000',
                    boxShadow: `0 0 16px ${accentColor}35`,
                  }}
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
