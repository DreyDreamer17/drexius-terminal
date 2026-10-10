import { useMemo, useState } from 'react';
import { Search, Plus, Trash2, KeyRound, Key, Shield, Check, X, Eye, EyeOff, User } from 'lucide-react';
import type { AuthMethod, KeychainInput, KeychainItem } from '../lib/types';
import { cn } from '../utils/cn';

interface Props {
  keychain: KeychainItem[];
  onSave: (k: KeychainInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  toast: (m: string) => void;
}

export function KeychainPanel({ keychain, onSave, onDelete, toast }: Props) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<KeychainInput | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

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
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">Private Key (OpenSSH PEM)</label>
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

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {!filtered.length && (
          <div className="py-12 text-center text-xs text-slate-500">
            <KeyRound className="mx-auto mb-2 h-8 w-8 opacity-30 text-amber-300" />
            No keychain identities yet.
            <div className="mt-1 text-[11px] text-slate-600">Create one to share credentials across hosts.</div>
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
