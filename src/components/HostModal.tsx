import { useEffect, useState } from 'react';
import { X, KeyRound, Lock, Fingerprint, Upload, ShieldCheck, Key } from 'lucide-react';
import type { AuthMethod, Host, HostSecret, KeychainItem, Vault } from '../lib/types';
import { bridge } from '../lib/bridge';
import { OS_OPTIONS } from '../lib/os';
import { cn } from '../utils/cn';

const COLORS = ['#22d3ee', '#a78bfa', '#f43f5e', '#f59e0b', '#4ade80', '#60a5fa', '#f472b6', '#94a3b8'];

function detectKeyType(k: string): string | null {
  if (!k.trim()) return null;
  if (k.includes('BEGIN RSA PRIVATE KEY')) return 'RSA (PEM)';
  if (k.includes('BEGIN EC PRIVATE KEY')) return 'ECDSA (PEM)';
  if (k.includes('BEGIN OPENSSH PRIVATE KEY')) {
    try {
      const body = atob(k.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
      if (body.includes('ssh-ed25519')) return 'ED25519 (OpenSSH)';
      if (body.includes('ssh-rsa')) return 'RSA (OpenSSH)';
      if (body.includes('ecdsa')) return 'ECDSA (OpenSSH)';
    } catch { /* not base64 */ }
    return 'OpenSSH key';
  }
  if (k.includes('PRIVATE KEY')) return 'PKCS#8';
  return 'Unrecognized format';
}

export function HostModal({
  host,
  vaults,
  defaultVaultId,
  onClose,
  onSave,
}: {
  host: Host | null;
  vaults?: Vault[];
  defaultVaultId?: string;
  onClose: () => void;
  onSave: (h: Host, s?: HostSecret) => void;
}) {
  const [h, setH] = useState<Host>(
    host ?? {
      id: '',
      label: '',
      hostname: '',
      port: 22,
      username: 'root',
      authMethod: 'key',
      keychainId: null,
      jumpHostId: null,
      group: '',
      tags: [],
      color: COLORS[0],
      hasSecret: false,
      vaultId: defaultVaultId && defaultVaultId !== 'all' ? defaultVaultId : 'personal',
    }
  );
  const [keychain, setKeychain] = useState<KeychainItem[]>([]);
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saveToKeychain, setSaveToKeychain] = useState(false);
  const [tags, setTags] = useState(h.tags.join(', '));
  const keyType = detectKeyType(privateKey);

  useEffect(() => {
    bridge.listKeychain().then(setKeychain).catch(() => {});
    bridge.listHosts().then(setAllHosts).catch(() => {});
  }, []);

  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const valid = h.hostname.trim() && h.username.trim() && h.port > 0;

  const submit = async () => {
    if (!valid) return;
    const finalLabel = h.label.trim() || h.hostname;
    const finalHost = { ...h, label: finalLabel, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) };
    const secretChanged = !h.keychainId && ((h.authMethod === 'password' && password) || (h.authMethod === 'key' && privateKey));
    const secret: HostSecret | undefined = secretChanged ? { password: password || null, privateKey: privateKey || null, passphrase: passphrase || null } : undefined;

    if (saveToKeychain && secretChanged) {
      try {
        const kid = await bridge.saveKeychain({
          id: '',
          label: `${finalLabel} (${finalHost.username})`,
          username: finalHost.username,
          authMethod: finalHost.authMethod,
          password: password || null,
          privateKey: privateKey || null,
          passphrase: passphrase || null,
        });
        finalHost.keychainId = kid;
      } catch (err) {
        console.error('Failed to auto-save to keychain', err);
      }
    }

    onSave(finalHost, secret);
  };

  const methods: { id: AuthMethod; label: string; icon: typeof Lock }[] = [
    { id: 'key', label: 'Key', icon: KeyRound }, { id: 'password', label: 'Password', icon: Lock }, { id: 'agent', label: 'SSH Agent', icon: Fingerprint },
  ];

  const input = 'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10';
  const label = 'mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0e131d] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-white">{host ? 'Edit host' : 'New host'}</h3>
            <p className="flex items-center gap-1 text-[11px] text-slate-500"><ShieldCheck className="h-3 w-3 text-emerald-400" />Credentials are sealed in the AES-256 vault</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div><label className={label}>Label</label><input className={input} value={h.label} onChange={(e) => set('label', e.target.value)} placeholder="prod-web-01" /></div>
            <div><label className={label}>Color</label>
              <div className="flex h-[38px] items-center gap-1">{COLORS.map((c) => <button key={c} onClick={() => set('color', c)} className={cn('h-5 w-5 rounded-full transition', h.color === c && 'ring-2 ring-white ring-offset-2 ring-offset-[#0e131d]')} style={{ background: c }} />)}</div>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_90px] gap-3">
            <div><label className={label}>Hostname / IP</label><input className={cn(input, 'font-mono')} value={h.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="203.0.113.10" /></div>
            <div><label className={label}>Port</label><input type="number" className={cn(input, 'font-mono')} value={h.port} onChange={(e) => set('port', parseInt(e.target.value) || 22)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Username</label><input className={cn(input, 'font-mono')} value={h.username} onChange={(e) => set('username', e.target.value)} /></div>
            <div><label className={label}>Group</label><input className={input} value={h.group ?? ''} onChange={(e) => set('group', e.target.value)} placeholder="Production" /></div>
          </div>
          <div>
            <label className={label}>OS (icon)</label>
            <select className={input} value={h.os ?? ''} onChange={(e) => set('os', (e.target.value || null) as Host['os'])}>
              {OS_OPTIONS.map((o) => <option key={o.label} value={o.id}>{o.label}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-slate-600">Auto-detect fills this in after first successful SSH connection (banner + /etc/os-release).</p>
          </div>
          <div>
            <label className={label}>Jump Host (ProxyJump / Bastion)</label>
            <select
              className={input}
              value={h.jumpHostId ?? ''}
              onChange={(e) => set('jumpHostId', e.target.value || null)}
            >
              <option value="">Direct connection (No jump host)</option>
              {allHosts
                .filter((x) => x.id !== h.id && x.id !== '__local__' && !x.id.startsWith('local'))
                .map((jh) => (
                  <option key={jh.id} value={jh.id}>
                    {jh.label} ({jh.username}@{jh.hostname}:{jh.port})
                  </option>
                ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">Route and encrypt this SSH connection through an intermediate bastion server.</p>
          </div>
          {vaults && vaults.length > 0 && (
            <div>
              <label className={label}>Target Vault</label>
              <select
                className={input}
                value={h.vaultId || 'personal'}
                onChange={(e) => set('vaultId', e.target.value)}
              >
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.kind === 'personal' ? 'Personal' : 'Team Vault'})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">The vault where this host profile and credentials reside.</p>
            </div>
          )}
          <div>
            <label className={label}>Credential Source</label>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/30 p-1 mb-2">
              <button
                type="button"
                onClick={() => set('keychainId', null)}
                className={cn(
                  'rounded-md py-1.5 text-xs transition',
                  !h.keychainId
                    ? 'bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-400/30'
                    : 'text-slate-400 hover:text-white'
                )}
              >
                Host-specific credentials
              </button>
              <button
                type="button"
                onClick={() => {
                  if (keychain.length > 0 && !h.keychainId) {
                    const first = keychain[0];
                    set('keychainId', first.id);
                    set('authMethod', first.authMethod);
                    if (first.username && (!h.username || h.username === 'root')) set('username', first.username);
                  }
                }}
                className={cn(
                  'rounded-md py-1.5 text-xs transition',
                  h.keychainId
                    ? 'bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/30'
                    : 'text-slate-400 hover:text-white'
                )}
              >
                Keychain Identity {keychain.length > 0 ? `(${keychain.length})` : ''}
              </button>
            </div>

            {h.keychainId ? (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.04] p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                  <Key className="h-3.5 w-3.5" />
                  <span>Linked Keychain Identity</span>
                </div>
                {keychain.length > 0 ? (
                  <select
                    value={h.keychainId}
                    onChange={(e) => {
                      const kid = e.target.value;
                      set('keychainId', kid);
                      const k = keychain.find((x) => x.id === kid);
                      if (k) {
                        set('authMethod', k.authMethod);
                        if (k.username && (!h.username || h.username === 'root')) set('username', k.username);
                      }
                    }}
                    className={input}
                  >
                    {keychain.map((k) => (
                      <option key={k.id} value={k.id} className="bg-[#0e131d]">
                        {k.label} ({k.authMethod}{k.username ? ` · ${k.username}` : ''})
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-amber-200/80">No identities in Keychain yet. Create one from the Keychain panel on the sidebar.</p>
                )}
                <p className="text-[11px] text-slate-400">
                  Credentials for this host will be retrieved automatically from the encrypted Keychain identity.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/30 p-1 mb-3">
                  {methods.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => set('authMethod', m.id)}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition',
                        h.authMethod === m.id
                          ? 'bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-400/30'
                          : 'text-slate-400 hover:text-white'
                      )}
                    >
                      <m.icon className="h-3.5 w-3.5" />
                      {m.label}
                    </button>
                  ))}
                </div>

                {h.authMethod === 'password' && (
                  <div>
                    <label className={label}>Password</label>
                    <input
                      type="password"
                      className={input}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={h.hasSecret ? '•••••••• (unchanged)' : ''}
                    />
                  </div>
                )}
                {h.authMethod === 'key' && (
                  <>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className={cn(label, 'mb-0')}>Private key (RSA / ED25519 / ECDSA)</label>
                        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                          <Upload className="h-3 w-3" />Import file
                          <input
                            type="file"
                            className="hidden"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) setPrivateKey(await f.text());
                            }}
                          />
                        </label>
                      </div>
                      <textarea
                        rows={5}
                        className={cn(input, 'resize-none font-mono text-[11px]')}
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder={
                          h.hasSecret
                            ? '(stored key unchanged — paste to replace)'
                            : '-----BEGIN OPENSSH PRIVATE KEY-----\n…'
                        }
                      />
                      {keyType && (
                        <p className={cn('mt-1 text-[11px]', keyType.startsWith('Unrec') ? 'text-amber-400' : 'text-emerald-400')}>
                          Detected: {keyType}
                        </p>
                      )}
                    </div>
                    <div>
                      <label className={label}>Passphrase (optional)</label>
                      <input
                        type="password"
                        className={input}
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                      />
                    </div>
                  </>
                )}
                {h.authMethod === 'agent' && (
                  <p className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-slate-400">
                    Uses keys loaded in your local ssh-agent / Pageant / 1Password agent. Nothing secret is stored.
                  </p>
                )}

                {!h.keychainId && (h.authMethod === 'key' || h.authMethod === 'password') && (
                  <label className="mt-2.5 flex cursor-pointer items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={saveToKeychain}
                      onChange={(e) => setSaveToKeychain(e.target.checked)}
                      className="rounded border-white/20 bg-black/40 text-amber-400 focus:ring-0"
                    />
                    <span className="flex items-center gap-1.5 text-amber-200 font-medium">
                      <Key className="h-3.5 w-3.5 text-amber-400" />
                      Save as reusable Keychain Identity
                    </span>
                  </label>
                )}
              </>
            )}
          </div>
          <div><label className={label}>Tags</label><input className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="api, eu-west" /></div>
        </div>
        <div className="flex justify-end gap-2 border-t border-white/5 bg-black/20 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-xs text-slate-300 hover:bg-white/5">Cancel</button>
          <button disabled={!valid} onClick={submit} className="rounded-lg bg-gradient-to-r from-cyan-400 to-violet-400 px-4 py-2 text-xs font-semibold text-black disabled:opacity-40">Save host</button>
        </div>
      </div>
    </div>
  );
}
