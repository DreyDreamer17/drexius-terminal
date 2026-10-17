import { useEffect, useState } from 'react';
import {
  FileText,
  X,
  KeyRound,
  Network,
  CheckSquare,
  Square,
  Loader2,
  Server,
  FolderInput,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import type { ParsedSshHost, Vault } from '../lib/types';
import { bridge } from '../lib/bridge';
import { CustomSelect } from './CustomSelect';
import { THEMES, type DrexiusTheme } from '../lib/themes';

interface Props {
  vaults: Vault[];
  defaultVaultId?: string | 'all';
  onClose: () => void;
  onSuccess: () => void;
  toast: (msg: string) => void;
  theme?: DrexiusTheme;
}

export function SshConfigModal({
  vaults,
  defaultVaultId,
  onClose,
  onSuccess,
  toast,
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const [configPath, setConfigPath] = useState<string | null>(null);
  const [hosts, setHosts] = useState<ParsedSshHost[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialVault =
    !defaultVaultId || defaultVaultId === 'all'
      ? vaults[0]?.id ?? 'personal'
      : defaultVaultId;
  const [targetVaultId, setTargetVaultId] = useState(initialVault);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const detected = await bridge.detectSshConfig();
        if (cancelled) return;
        setConfigPath(detected);

        const parsed = await bridge.previewSshConfig();
        if (cancelled) return;
        setHosts(parsed);
        // By default select all valid hosts
        setSelectedIndices(new Set(parsed.map((_, i) => i)));
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSelect = (idx: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIndices.size === hosts.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(hosts.map((_, i) => i)));
    }
  };

  const handleImport = async () => {
    const toImport = hosts.filter((_, i) => selectedIndices.has(i));
    if (toImport.length === 0) return;

    setImporting(true);
    try {
      const imported = await bridge.importSshConfig(toImport, targetVaultId);
      toast(imported === 0
        ? 'No new hosts to import — existing profiles were left unchanged'
        : `Imported ${imported} host${imported === 1 ? '' : 's'} from SSH config${imported < toImport.length ? ' (existing profiles skipped)' : ''}`);
      onSuccess();
      onClose();
    } catch (err) {
      setError(`Import failed: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        className="relative flex flex-col w-full max-w-2xl max-h-[85vh] rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{ backgroundColor: bgColor }}
      >
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4 shrink-0 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-2xl border transition shadow-lg shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <FolderInput className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                Import from SSH Config
                {configPath && (
                  <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 border border-emerald-500/25">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Detected
                  </span>
                )}
              </h3>
              <p className="text-[11px] font-mono text-slate-400 truncate max-w-md">
                {configPath ?? '~/.ssh/config'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Target Vault & Quick Controls */}
        <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-black/20 px-5 py-2.5 shrink-0 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-[11px]">Save into vault:</span>
            <div className="w-52">
              <CustomSelect
                value={targetVaultId}
                options={vaults.map((v) => ({
                  value: v.id,
                  label: `${v.name} (${v.kind})`,
                }))}
                onChange={(val) => setTargetVaultId(val)}
                accentColor={accentColor}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleSelectAll}
              disabled={loading || hosts.length === 0}
              className="flex items-center gap-1.5 text-[11px] font-medium transition disabled:opacity-50"
              style={{ color: accentColor }}
            >
              {selectedIndices.size === hosts.length ? (
                <>
                  <Square className="h-3.5 w-3.5" />
                  Deselect all
                </>
              ) : (
                <>
                  <CheckSquare className="h-3.5 w-3.5" />
                  Select all ({hosts.length})
                </>
              )}
            </button>
            <span className="text-[11px] text-slate-500">
              {selectedIndices.size} selected
            </span>
          </div>
        </div>

        {/* Content Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-2">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-7 w-7 animate-spin text-cyan-400 mb-2" />
              <p className="text-xs">Scanning and parsing ~/.ssh/config...</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-200 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
              <div className="min-w-0 flex-1">{error}</div>
            </div>
          )}

          {!loading && !error && hosts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400">
              <FileText className="h-8 w-8 text-slate-600 mb-2" />
              <p className="text-sm font-medium text-slate-300">No host configurations found</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Your <code className="text-slate-400">~/.ssh/config</code> does not contain any valid host declarations or is empty.
              </p>
            </div>
          )}

          {!loading &&
            hosts.map((host, idx) => {
              const isSelected = selectedIndices.has(idx);
              return (
                  <div
                    key={`${host.label}-${idx}`}
                    onClick={() => toggleSelect(idx)}
                    className={`group flex items-center gap-3.5 rounded-xl border p-3 cursor-pointer transition ${
                      isSelected
                        ? 'hover:brightness-105'
                        : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04] opacity-60 hover:opacity-80'
                    }`}
                    style={isSelected ? {
                      borderColor: `${accentColor}50`,
                      backgroundColor: `${accentColor}12`,
                    } : undefined}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(idx);
                      }}
                      className="shrink-0"
                    >
                      {isSelected ? (
                        <CheckSquare className="h-4 w-4" style={{ color: accentColor }} />
                      ) : (
                        <Square className="h-4 w-4 text-slate-600" />
                      )}
                    </button>

                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/40 border border-white/10 shrink-0 text-slate-300">
                      <Server className="h-4 w-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-200 truncate">
                          {host.label}
                        </span>
                        {host.port && host.port !== 22 && (
                          <span className="rounded bg-white/5 px-1 py-0.2 text-[10px] font-mono text-slate-400">
                            :{host.port}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400 truncate mt-0.5">
                        <span>{host.username}@{host.hostname}</span>
                      </div>

                      {/* Metadata tags */}
                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        {host.identityFile && (
                          <span className="flex items-center gap-1 rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-mono text-amber-300/90 truncate max-w-xs">
                            <KeyRound className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">{host.identityFile}</span>
                          </span>
                        )}
                        {host.proxyJump && (
                          <span className="flex items-center gap-1 rounded bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono text-indigo-300/90 truncate max-w-xs">
                            <Network className="h-2.5 w-2.5 shrink-0" />
                            <span>Jump via {host.proxyJump}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
        </div>

        {/* Tip Banner */}
        <div
          className="border-t border-white/5 px-5 py-2.5 flex items-center gap-2 text-[11px]"
          style={{ backgroundColor: `${accentColor}0a`, color: `${accentColor}ee` }}
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
          <span>
            Referenced private keys (<code className="font-mono" style={{ color: accentColor }}>IdentityFile</code>) will automatically be registered in your encrypted Keychain.
          </span>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-white/10 bg-black/40 px-5 py-3.5 shrink-0">
          <span className="text-xs text-slate-400">
            {selectedIndices.size} of {hosts.length} selected
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white transition"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleImport}
              disabled={selectedIndices.size === 0 || importing}
              className="flex items-center gap-2 rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:pointer-events-none shadow-lg"
              style={{
                backgroundColor: accentColor,
                color: '#000000',
                boxShadow: `0 0 20px ${accentColor}35`,
              }}
            >
              {importing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <FolderInput className="h-3.5 w-3.5" />
                  Import {selectedIndices.size} {selectedIndices.size === 1 ? 'Host' : 'Hosts'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
