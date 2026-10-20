import { useEffect, useState, useRef } from 'react';
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
  Upload,
  ClipboardList,
  ArrowLeft,
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

function extractErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error occurred';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if ('message' in err && typeof (err as any).message === 'string') {
      return (err as any).message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
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

  const [mode, setMode] = useState<'preview' | 'paste'>('preview');
  const [pasteContent, setPasteContent] = useState('');
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [hosts, setHosts] = useState<ParsedSshHost[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

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

        if (detected) {
          const parsed = await bridge.previewSshConfig(detected);
          if (cancelled) return;
          setHosts(parsed);
          setSelectedIndices(new Set(parsed.map((_, i) => i)));
        } else {
          // No auto-detected file at default path (standard on Android)
          setHosts([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(extractErrorMessage(err));
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const content = await file.text();
      setConfigPath(file.name);
      const parsed = await bridge.previewSshConfig(undefined, content);
      setHosts(parsed);
      setSelectedIndices(new Set(parsed.map((_, i) => i)));
      setMode('preview');
      if (parsed.length === 0) {
        setError(`Parsed "${file.name}", but found 0 valid host declarations. Make sure it uses "Host <name>" syntax.`);
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleParsePasted = async () => {
    if (!pasteContent.trim()) {
      setError('Please paste SSH configuration text first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsed = await bridge.previewSshConfig(undefined, pasteContent);
      setHosts(parsed);
      setSelectedIndices(new Set(parsed.map((_, i) => i)));
      setConfigPath('Pasted Config');
      setMode('preview');
      if (parsed.length === 0) {
        setError('No valid "Host <name>" blocks found in the pasted text.');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

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
      setError(`Import failed: ${extractErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      {/* Hidden file input for mobile / desktop file selection */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".conf,.config,.txt,*"
        className="hidden"
        onChange={handleFileChange}
      />

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
                    {configPath.startsWith('/') ? 'Detected' : 'Loaded'}
                  </span>
                )}
              </h3>
              <p className="text-[11px] font-mono text-slate-400 truncate max-w-xs sm:max-w-md">
                {configPath ?? '~/.ssh/config'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/10 transition cursor-pointer"
              title="Pick an SSH config file from your device"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Choose File</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === 'paste' ? 'preview' : 'paste');
              }}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:border-white/20 hover:bg-white/10 transition cursor-pointer"
              title="Paste SSH config text directly"
            >
              <ClipboardList className="h-3.5 w-3.5" />
              <span>{mode === 'paste' ? 'Show Hosts' : 'Paste Text'}</span>
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer ml-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
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

          {mode === 'preview' && hosts.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={toggleSelectAll}
                disabled={loading || hosts.length === 0}
                className="flex items-center gap-1.5 text-[11px] font-medium transition disabled:opacity-50 cursor-pointer"
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
          )}
        </div>

        {/* Content Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-3">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-7 w-7 animate-spin mb-2" style={{ color: accentColor }} />
              <p className="text-xs">Scanning and parsing SSH configuration...</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-200 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
              <div className="min-w-0 flex-1 font-mono text-[11px] break-words">{error}</div>
            </div>
          )}

          {/* Mode: Paste Text */}
          {!loading && mode === 'paste' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">
                  Paste SSH Config Content
                </span>
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className="text-xs text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                >
                  <ArrowLeft className="h-3 w-3" /> Back
                </button>
              </div>
              <textarea
                rows={10}
                value={pasteContent}
                onChange={(e) => setPasteContent(e.target.value)}
                placeholder={`Host prod-web\n  HostName 198.51.100.1\n  User deploy\n  Port 22\n\nHost staging-db\n  HostName 10.0.0.50\n  User admin\n  IdentityFile ~/.ssh/id_ed25519`}
                className="w-full rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-400/50 resize-y"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleParsePasted}
                  disabled={!pasteContent.trim()}
                  className="rounded-lg px-4 py-1.5 text-xs font-semibold text-black transition hover:brightness-110 disabled:opacity-50 cursor-pointer"
                  style={{ backgroundColor: accentColor }}
                >
                  Preview &amp; Parse Hosts
                </button>
              </div>
            </div>
          )}

          {/* Mode: Preview empty state */}
          {!loading && mode === 'preview' && hosts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center px-4">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-2xl border mb-3 shadow-md"
                style={{
                  backgroundColor: `${accentColor}12`,
                  borderColor: `${accentColor}30`,
                  color: accentColor,
                }}
              >
                <FileText className="h-6 w-6" />
              </div>
              <h4 className="text-sm font-semibold text-slate-200">
                No SSH config found at default path
              </h4>
              <p className="text-xs text-slate-400 mt-1 max-w-md leading-relaxed">
                On Android and fresh systems, standard <code className="text-slate-300 font-mono">~/.ssh/config</code> does not exist by default. You can choose a config file from your storage (Downloads, Termux, Drive) or paste its text.
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold text-black transition hover:brightness-110 active:scale-95 shadow-md cursor-pointer"
                  style={{ backgroundColor: accentColor }}
                >
                  <Upload className="h-4 w-4" />
                  Select Config File
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode('paste');
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/10 hover:border-white/25 transition active:scale-95 cursor-pointer"
                >
                  <ClipboardList className="h-4 w-4" />
                  Paste Config Text
                </button>
              </div>
            </div>
          )}

          {/* Mode: Preview host cards */}
          {!loading &&
            mode === 'preview' &&
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
              className="rounded-xl px-4 py-2 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleImport}
              disabled={selectedIndices.size === 0 || importing}
              className="flex items-center gap-2 rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:pointer-events-none shadow-lg cursor-pointer"
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
