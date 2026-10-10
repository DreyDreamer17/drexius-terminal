import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Plus,
  Trash2,
  KeyRound,
  Key,
  Shield,
  Check,
  X,
  Eye,
  EyeOff,
  User,
  FolderKey,
  Download,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { bridge } from '../lib/bridge';
import type { AuthMethod, DetectedLocalKey, KeychainInput, KeychainItem } from '../lib/types';
import { cn } from '../utils/cn';

interface Props {
  keychain: KeychainItem[];
  onSave: (k: KeychainInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  toast: (m: string) => void;
}

export function KeychainPanel({ keychain, onSave, onDelete, onRefresh, toast }: Props) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<KeychainInput | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  // Local SSH Key Detection & Host Sync states
  const [detectedLocal, setDetectedLocal] = useState<DetectedLocalKey[]>([]);
  const [importingLocal, setImportingLocal] = useState<string | null>(null);
  const [syncingHosts, setSyncingHosts] = useState(false);

  // Scan local ~/.ssh and auto-import unlinked host keys on mount
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const locals = await bridge.detectLocalSshKeys();
        if (active) setDetectedLocal(locals);
      } catch {
        // ignore
      }

      try {
        const count = await bridge.importKeychainFromHosts();
        if (count > 0 && active && onRefresh) {
          await onRefresh();
          toast(`Auto-imported ${count} host credential(s) into Keychain`);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleImportLocal = async (localKey: DetectedLocalKey) => {
    setImportingLocal(localKey.filename);
    try {
      await bridge.importLocalSshKey(localKey.path, localKey.filename);
      if (onRefresh) await onRefresh();
      toast(`Imported "${localKey.filename}" to Keychain`);
    } catch (e) {
      toast(`Failed to import key: ${String(e)}`);
    } finally {
      setImportingLocal(null);
    }
  };

  const handleImportAllLocal = async () => {
    if (!detectedLocal.length) return;
    setImportingLocal('all');
    try {
      let count = 0;
      for (const k of detectedLocal) {
        await bridge.importLocalSshKey(k.path, k.filename);
        count++;
      }
      if (onRefresh) await onRefresh();
      toast(`Imported ${count} local key(s) to Keychain`);
    } catch (e) {
      toast(`Failed to import local keys: ${String(e)}`);
    } finally {
      setImportingLocal(null);
    }
  };

  const handleSyncHosts = async () => {
    setSyncingHosts(true);
    try {
      const count = await bridge.importKeychainFromHosts();
      if (onRefresh) await onRefresh();
      if (count > 0) {
        toast(`Imported ${count} credential(s) from hosts into Keychain`);
      } else {
        toast('All host credentials are already in Keychain');
      }
    } catch (e) {
      toast(`Sync failed: ${String(e)}`);
    } finally {
      setSyncingHosts(false);
    }
  };

  const filtered = useMemo(() => {
    return keychain.filter((k) =>
      `${k.label} ${k.username ?? ''} ${k.authMethod}`.toLowerCase().includes(q.toLowerCase())
    );
  }, [keychain, q]);

  const handleSave = async () => {
    if (!editing || !editing.label.trim()) {
      toast('Please provide an identity label');
      return;
    }
    setSaving(true);
    try {
      await onSave(editing);
      toast(`Identity "${editing.label}" saved`);
      setEditing(null);
    } catch (e) {
      toast(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: KeychainItem) => {
    if (confirm(`Delete identity "${item.label}"? Hosts referencing this identity may lose authentication.`)) {
      try {
        await onDelete(item.id);
        toast(`Identity "${item.label}" removed`);
      } catch (e) {
        toast(`Failed to delete: ${String(e)}`);
      }
    }
  };

  const inputClass =
    'w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-amber-400/40 focus:outline-none';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Keychain Identities</h2>
          <p className="text-[11px] text-slate-500">Reusable credentials for multiple SSH hosts</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleSyncHosts}
            disabled={syncingHosts}
            className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 text-slate-400 hover:border-amber-400/30 hover:bg-amber-400/10 hover:text-amber-300 disabled:opacity-40"
            title="Import keys from existing hosts"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncingHosts && 'animate-spin text-amber-400')} />
          </button>
          <button
            onClick={() =>
              setEditing({
                id: '',
                label: '',
                username: '',
                authMethod: 'key',
                password: '',
                privateKey: '',
                passphrase: '',
              })
            }
            className="grid h-7 w-7 place-items-center rounded-lg bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/20 hover:bg-amber-400/20"
            title="New Identity"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search identities…"
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
          />
        </div>
      </div>

      {editing && (
        <div className="mx-3 mb-2 space-y-2.5 rounded-xl border border-amber-400/30 bg-amber-400/[0.04] p-3 shadow-lg">
          <div className="flex items-center justify-between text-xs font-semibold text-amber-300">
            <span>{editing.id ? 'Edit Identity' : 'New Identity'}</span>
            <button onClick={() => setEditing(null)} className="text-slate-500 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Label *</label>
            <input
              className={inputClass}
              placeholder="e.g. AWS Production Ops"
              value={editing.label}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Default Username</label>
            <input
              className={inputClass}
              placeholder="e.g. ubuntu, ec2-user, root"
              value={editing.username ?? ''}
              onChange={(e) => setEditing({ ...editing, username: e.target.value })}
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Auth Method</label>
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              {(['key', 'password', 'agent'] as AuthMethod[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setEditing({ ...editing, authMethod: m })}
                  className={cn(
                    'rounded border py-1 capitalize transition',
                    editing.authMethod === m
                      ? 'border-amber-400/50 bg-amber-400/20 font-medium text-amber-200'
                      : 'border-white/5 bg-white/[0.02] text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  )}
                >
                  {m === 'key' ? 'SSH Key' : m === 'password' ? 'Password' : 'SSH Agent'}
                </button>
              ))}
            </div>
          </div>

          {editing.authMethod === 'password' && (
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className={inputClass}
                  placeholder="Secret password"
                  value={editing.password ?? ''}
                  onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-2 text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}

          {editing.authMethod === 'key' && (
            <>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-[10px] uppercase tracking-wider text-slate-400">
                    Private Key (OpenSSH PEM)
                  </label>
                  <label className="flex cursor-pointer items-center gap-1 text-[11px] text-amber-300 hover:text-amber-200">
                    <Upload className="h-3 w-3" />Import file
                    <input
                      type="file"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          const txt = await f.text();
                          setEditing((prev) => (prev ? { ...prev, privateKey: txt, label: prev.label || f.name } : null));
                        }
                      }}
                    />
                  </label>
                </div>
                <textarea
                  className={cn(inputClass, 'h-20 font-mono text-[11px] resize-none')}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                  value={editing.privateKey ?? ''}
                  onChange={(e) => setEditing({ ...editing, privateKey: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Key Passphrase (optional)</label>
                <input
                  type="password"
                  className={inputClass}
                  placeholder="Passphrase if encrypted"
                  value={editing.passphrase ?? ''}
                  onChange={(e) => setEditing({ ...editing, passphrase: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-1.5 pt-1">
            <button
              onClick={() => setEditing(null)}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-400 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              disabled={saving}
              onClick={handleSave}
              className="flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1 text-xs font-semibold text-black hover:bg-amber-300 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {/* Detected Local SSH Keys banner */}
        {detectedLocal.length > 0 && (
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.03] p-2.5">
            <div className="flex items-center justify-between pb-1.5 border-b border-amber-400/10">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                <FolderKey className="h-3.5 w-3.5 text-amber-400" />
                <span>Detected in ~/.ssh ({detectedLocal.length})</span>
              </div>
              <button
                onClick={handleImportAllLocal}
                disabled={importingLocal !== null}
                className="text-[11px] font-medium text-amber-400 hover:text-amber-300 disabled:opacity-50"
              >
                {importingLocal === 'all' ? 'Importing…' : 'Import All'}
              </button>
            </div>
            <div className="mt-2 space-y-1.5">
              {detectedLocal.map((k) => (
                <div
                  key={k.path}
                  className="flex items-center justify-between gap-2 rounded-lg bg-black/30 px-2.5 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-medium text-slate-200 truncate">{k.filename}</span>
                      <span className="rounded bg-white/5 px-1.5 py-0.2 text-[9px] uppercase tracking-wider text-slate-400">
                        {k.keyType}
                      </span>
                    </div>
                    {k.comment && (
                      <div className="text-[10px] text-slate-500 truncate font-mono">{k.comment}</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleImportLocal(k)}
                    disabled={importingLocal === k.filename}
                    className="flex shrink-0 items-center gap-1 rounded bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-400/25 disabled:opacity-50"
                  >
                    <Download className="h-3 w-3" />
                    {importingLocal === k.filename ? 'Importing…' : 'Import'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!filtered.length && (
          <div className="py-8 text-center text-xs text-slate-500">
            <KeyRound className="mx-auto mb-2 h-8 w-8 opacity-30 text-amber-300" />
            <p className="text-slate-300 font-medium">No identities stored in Keychain yet</p>
            <p className="mt-1 text-[11px] text-slate-500 max-w-[240px] mx-auto">
              Import detected keys from your ~/.ssh folder or sync keys already saved in your hosts.
            </p>
            <div className="mt-4 flex flex-col gap-2 items-center">
              <button
                onClick={handleSyncHosts}
                disabled={syncingHosts}
                className="flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-400/20 disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', syncingHosts && 'animate-spin text-amber-400')} />
                {syncingHosts ? 'Importing…' : 'Import from existing hosts'}
              </button>
            </div>
          </div>
        )}

        {filtered.map((k) => (
          <div
            key={k.id}
            className="group relative flex flex-col gap-1.5 rounded-xl border border-white/5 bg-white/[0.02] p-2.5 transition hover:border-white/15 hover:bg-white/[0.04]"
          >
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/20">
                {k.authMethod === 'key' ? (
                  <Key className="h-3.5 w-3.5" />
                ) : k.authMethod === 'password' ? (
                  <Shield className="h-3.5 w-3.5" />
                ) : (
                  <User className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-slate-200">{k.label}</span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-300/80">
                    {k.authMethod}
                  </span>
                </div>
                {k.username && (
                  <div className="truncate text-[11px] text-slate-500 font-mono">user: {k.username}</div>
                )}
              </div>
              <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={() =>
                    setEditing({
                      id: k.id,
                      label: k.label,
                      username: k.username,
                      authMethod: k.authMethod,
                      password: '',
                      privateKey: '',
                      passphrase: '',
                    })
                  }
                  className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
                  title="Edit identity"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(k)}
                  className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                  title="Delete identity"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-white/[0.04] pt-1 text-[10px] text-slate-500">
              <span className="flex items-center gap-1">
                <span className={cn('h-1.5 w-1.5 rounded-full', k.hasSecret ? 'bg-emerald-400' : 'bg-amber-400')} />
                {k.hasSecret ? 'Encrypted in SQLCipher' : 'No secret stored'}
              </span>
              <span>Updated {new Date(k.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
