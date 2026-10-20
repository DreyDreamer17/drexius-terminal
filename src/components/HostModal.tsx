import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { useEffect, useState, useMemo } from 'react';
import { X, KeyRound, Lock, Fingerprint, Upload, ShieldCheck, Key, Server, Terminal, Copy, Check } from 'lucide-react';
import type { AuthMethod, Host, HostSecret, KeychainItem, Vault } from '../lib/types';
import { bridge } from '../lib/bridge';
import { OS_OPTIONS, isAndroidPlatform } from '../lib/os';
import { cn } from '../utils/cn';
import { safeUid } from '../utils/uuid';
import { CustomSelect } from './CustomSelect';
import { THEMES, type DrexiusTheme } from '../lib/themes';

const COLORS = ['#22d3ee', '#a78bfa', '#f43f5e', '#f59e0b', '#4ade80', '#60a5fa', '#f472b6', '#94a3b8'];

const CLOUDFLARE_SSH_PRESET = 'cloudflared access ssh --hostname %h';
const AWS_SSM_PRESET = 'aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p';

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
  theme,
}: {
  host: Host | null;
  vaults?: Vault[];
  defaultVaultId?: string;
  onClose: () => void;
  onSave: (h: Host, s?: HostSecret, alreadySaved?: boolean) => void | Promise<void>;
  theme?: DrexiusTheme;
}) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0e131d';
  const isAndroid = useMemo(() => isAndroidPlatform(), []);

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
      startupCommand: '',
      proxyCommand: null,
    }
  );
  const [keychain, setKeychain] = useState<KeychainItem[]>([]);
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saveToKeychain, setSaveToKeychain] = useState(false);
  const [tags, setTags] = useState(h.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedSetup, setCopiedSetup] = useState(false);
  const keyType = detectKeyType(privateKey);

  const currentProxyCmd = (h.proxyCommand || '').trim();
  const proxyMode = !currentProxyCmd
    ? 'direct'
    : currentProxyCmd === CLOUDFLARE_SSH_PRESET
    ? 'cloudflare'
    : currentProxyCmd === AWS_SSM_PRESET
    ? 'aws_ssm'
    : 'custom';

  const isTermuxLocal =
    h.port === 8022 &&
    (h.hostname.trim() === '127.0.0.1' || h.hostname.trim().toLowerCase() === 'localhost');

  const applyTermuxPreset = () => {
    setH((prev) => ({
      ...prev,
      label: prev.label.trim() || 'Termux (Local)',
      hostname: '127.0.0.1',
      port: 8022,
      username: prev.username && prev.username !== 'root' ? prev.username : 'termux',
      authMethod: 'password',
      group: prev.group || 'Local',
      os: 'android',
      color: '#4ade80',
    }));
    setTags((prev) => (prev.trim() ? prev : 'termux, local'));
  };

  useEffect(() => {
    bridge.listKeychain().then(setKeychain).catch(() => {});
    bridge.listHosts().then(setAllHosts).catch(() => {});
  }, []);

  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));
  const valid = h.hostname.trim() && h.username.trim() && h.port > 0;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    const finalLabel = h.label.trim() || h.hostname;
    const finalHost = {
      ...h,
      label: finalLabel,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      startupCommand: h.startupCommand?.trim() || null,
      proxyCommand: h.proxyCommand?.trim() || null,
    };
    const secretChanged = !h.keychainId && ((h.authMethod === 'password' && password) || (h.authMethod === 'key' && privateKey));
    let secret: HostSecret | undefined = secretChanged ? { password: password || null, privateKey: privateKey || null, passphrase: passphrase || null } : undefined;

    let alreadySaved = false;

    // Atomic path: single Rust transaction creates the Keychain identity,
    // links the host, and drops any host-level secret. Pre-generate both IDs
    // so the follow-up onSave (close/refresh) reuses the same rows.
    if (saveToKeychain && secretChanged) {
      const hostId = finalHost.id || safeUid();
      const kid = safeUid();
      finalHost.id = hostId;
      try {
        await bridge.saveHostWithNewKeychain(
          { ...finalHost, keychainId: null },
          {
            id: kid,
            label: `${finalLabel} (${finalHost.username})`,
            username: finalHost.username,
            authMethod: finalHost.authMethod,
            password: password || null,
            privateKey: privateKey || null,
            passphrase: passphrase || null,
            vaultId: finalHost.vaultId && finalHost.vaultId !== 'all' ? finalHost.vaultId : 'personal',
          }
        );
        finalHost.keychainId = kid;
        secret = undefined;
        alreadySaved = true;
      } catch (err) {
        console.error('Failed to save host with new keychain identity', err);
        setSaveError(`Could not save host with Keychain identity: ${String((err as any)?.message || err)}`);
        setSaving(false);
        return;
      }
    }

    if (finalHost.keychainId) {
      secret = undefined;
    }

    try {
      await onSave(finalHost, secret, alreadySaved);
    } catch (err) {
      console.error('Failed to save host', err);
      setSaveError(`Could not save host: ${String((err as any)?.message || err)}`);
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  const methods: { id: AuthMethod; label: string; icon: typeof Lock }[] = [
    { id: 'key', label: 'Key', icon: KeyRound }, { id: 'password', label: 'Password', icon: Lock }, { id: 'agent', label: 'SSH Agent', icon: Fingerprint },
  ];

  const input = 'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-white/30 focus:outline-none transition';
  const label = 'mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500';

  return (
    <ResponsiveOverlay className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClose={onClose} label="Host profile">
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: bgColor }}
      >
        <SheetHandle onClose={onClose} />
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        <div className="relative flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div className="flex items-center gap-3">
            <div
              className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border transition shadow-lg"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <Server className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{host ? 'Edit host' : 'New host'}</h3>
              <p className="flex items-center gap-1 text-[11px] text-slate-500">
                <ShieldCheck className="h-3 w-3 text-emerald-400" />
                Credentials are sealed in the AES-256 vault
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          {!host && !isTermuxLocal && isAndroid && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
                  <Terminal className="h-3.5 w-3.5 shrink-0" />
                  <span>Using Termux on this device?</span>
                </div>
                <p className="truncate text-[10.5px] text-slate-400">
                  100% local loopback workstation (127.0.0.1:8022 · works offline)
                </p>
              </div>
              <button
                type="button"
                onClick={applyTermuxPreset}
                className="shrink-0 rounded-lg border border-emerald-400/35 bg-emerald-400/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-400/25 transition"
              >
                Fill Termux Preset
              </button>
            </div>
          )}
          {isTermuxLocal && (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/25 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                  <Terminal className="h-3.5 w-3.5" />
                  Termux Local Bridge · 100% On-Device (Loopback)
                </span>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 font-mono text-[9.5px] text-emerald-300">
                  127.0.0.1:8022
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-300">
                Run this once inside Termux to enable its local SSH daemon (works completely offline, even in Airplane Mode):
              </p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[11px] text-emerald-200">
                <code className="truncate">pkg install openssh &amp;&amp; passwd &amp;&amp; sshd</code>
                <button
                  type="button"
                  onClick={() => {
                    bridge.writeClipboard('pkg install openssh && passwd && sshd').catch(() => {});
                    setCopiedSetup(true);
                    setTimeout(() => setCopiedSetup(false), 1800);
                  }}
                  className="flex shrink-0 items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 font-sans text-[10px] text-slate-300 hover:bg-white/10 hover:text-white transition"
                >
                  {copiedSetup ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedSetup ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
            <div><label className={label}>Label</label><input className={input} value={h.label} onChange={(e) => set('label', e.target.value)} placeholder="prod-web-01" /></div>
            <div><label className={label}>Color</label>
              <div className="nx-color-picker flex h-[38px] items-center gap-1">{COLORS.map((c) => <button key={c} aria-label={`Host color ${c}`} aria-pressed={h.color === c} onClick={() => set('color', c)} className="grid h-5 w-5 shrink-0 place-items-center rounded-full transition"><span className={cn('h-5 w-5 rounded-full', h.color === c && 'ring-2 ring-white ring-offset-2 ring-offset-black')} style={{ background: c }} /></button>)}</div>
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
            <CustomSelect
              value={h.os ?? ''}
              options={OS_OPTIONS.map((o) => ({ value: o.id ?? '', label: o.label }))}
              onChange={(val) => set('os', (val || null) as Host['os'])}
              placeholder="Select OS"
              accentColor={accentColor}
            />
            <p className="mt-1 text-[11px] text-slate-600">Auto-detect fills this in after first successful SSH connection (banner + /etc/os-release).</p>
          </div>
          <div>
            <label className={label}>Jump Host (ProxyJump / Bastion)</label>
            <CustomSelect
              value={h.jumpHostId ?? ''}
              options={[
                { value: '', label: 'Direct connection (No jump host)' },
                ...allHosts
                  .filter((x) => x.id !== h.id && x.id !== '__local__' && !x.id.startsWith('local'))
                  .map((jh) => ({
                    value: jh.id,
                    label: `${jh.label} (${jh.username}@${jh.hostname}:${jh.port})`,
                  })),
              ]}
              onChange={(val) => set('jumpHostId', val || null)}
              placeholder="Direct connection (No jump host)"
              accentColor={accentColor}
            />
            <p className="mt-1 text-[11px] text-slate-500">Route and encrypt this SSH connection through an intermediate bastion server.</p>
          </div>
          {/* Zero-Trust & Proxy Gateway */}
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center justify-between">
              <label className={cn(label, 'mb-0 flex items-center gap-1.5 text-slate-300')}>
                <ShieldCheck className="h-3.5 w-3.5 text-sky-400" />
                Zero-Trust & Proxy Gateway (ProxyCommand)
              </label>
              {currentProxyCmd && (
                <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[9.5px] font-semibold text-sky-300">
                  Proxy Active
                </span>
              )}
            </div>

            {/* Presets Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              <button
                type="button"
                onClick={() => set('proxyCommand', null)}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-xs font-medium border text-center transition',
                  proxyMode === 'direct'
                    ? 'border-white/20 bg-white/10 text-white'
                    : 'border-white/5 bg-black/20 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                )}
              >
                Direct
              </button>
              <button
                type="button"
                onClick={() => set('proxyCommand', CLOUDFLARE_SSH_PRESET)}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-xs font-medium border text-center transition truncate',
                  proxyMode === 'cloudflare'
                    ? 'border-amber-400/40 bg-amber-400/15 text-amber-200'
                    : 'border-white/5 bg-black/20 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                )}
                title="Cloudflare Access SSH (cloudflared)"
              >
                Cloudflare Access
              </button>
              <button
                type="button"
                onClick={() => set('proxyCommand', AWS_SSM_PRESET)}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-xs font-medium border text-center transition truncate',
                  proxyMode === 'aws_ssm'
                    ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200'
                    : 'border-white/5 bg-black/20 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                )}
                title="AWS Systems Manager Session (aws ssm)"
              >
                AWS SSM
              </button>
              <button
                type="button"
                onClick={() => {
                  if (proxyMode === 'direct') {
                    set('proxyCommand', 'nc -X 5 -x 127.0.0.1:1080 %h %p');
                  }
                }}
                className={cn(
                  'rounded-lg px-2 py-1.5 text-xs font-medium border text-center transition truncate',
                  proxyMode === 'custom'
                    ? 'border-sky-400/40 bg-sky-400/15 text-sky-200'
                    : 'border-white/5 bg-black/20 text-slate-400 hover:bg-white/5 hover:text-slate-200'
                )}
              >
                Custom Proxy
              </button>
            </div>

            {proxyMode !== 'direct' && (
              <div className="space-y-2 pt-1 animate-in fade-in duration-100">
                <input
                  className={cn(input, 'font-mono text-xs')}
                  value={h.proxyCommand ?? ''}
                  onChange={(e) => set('proxyCommand', e.target.value)}
                  placeholder="cloudflared access ssh --hostname %h"
                />

                {/* Token expansion preview */}
                <div className="rounded-lg border border-white/5 bg-black/50 p-2 font-mono text-[11px] text-slate-400 space-y-1">
                  <div className="text-[10px] text-slate-500 font-sans flex items-center justify-between">
                    <span>Spawned command:</span>
                    <span className="text-slate-400">Tokens: %h (host) · %p (port) · %r (user)</span>
                  </div>
                  <div className="text-sky-300 break-all">
                    $ {(h.proxyCommand || '')
                      .replace(/%h/g, h.hostname || '<host>')
                      .replace(/%p/g, String(h.port || 22))
                      .replace(/%r/g, h.username || 'root')
                      .replace(/%%/g, '%')}
                  </div>
                </div>

                <p className="text-[11px] text-slate-500">
                  {proxyMode === 'cloudflare' && (
                    <>Tunnels connection through Cloudflare Zero-Trust edge. Requires <code className="text-slate-400">cloudflared</code> installed locally.</>
                  )}
                  {proxyMode === 'aws_ssm' && (
                    <>Connects to EC2 instances without open inbound ports. Hostname can be instance ID (e.g. <code className="text-slate-400">i-0123456789abcdef0</code>). Requires AWS CLI + SSM plugin.</>
                  )}
                  {proxyMode === 'custom' && (
                    <>Local process stdin/stdout is bridged directly into libssh2 transport (same as OpenSSH <code className="text-slate-400">ProxyCommand</code>).</>
                  )}
                </p>
              </div>
            )}
          </div>
          {vaults && vaults.length > 0 && (
            <div>
              <label className={label}>Target Vault</label>
              <CustomSelect
                value={h.vaultId || 'personal'}
                options={vaults.map((v) => ({
                  value: v.id,
                  label: `${v.name} (${v.kind === 'personal' ? 'Personal' : 'Team Vault'})`,
                }))}
                onChange={(val) => set('vaultId', val)}
                accentColor={accentColor}
              />
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
                  'rounded-md py-1.5 text-xs transition border font-medium',
                  !h.keychainId
                    ? ''
                    : 'border-transparent text-slate-400 hover:text-white'
                )}
                style={!h.keychainId ? { backgroundColor: `${accentColor}20`, borderColor: `${accentColor}40`, color: accentColor } : undefined}
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
                  <CustomSelect
                    value={h.keychainId}
                    options={keychain.map((k) => ({
                      value: k.id,
                      label: `${k.label} (${k.authMethod}${k.username ? ` · ${k.username}` : ''})`,
                    }))}
                    onChange={(kid) => {
                      set('keychainId', kid);
                      const k = keychain.find((x) => x.id === kid);
                      if (k) {
                        set('authMethod', k.authMethod);
                        if (k.username && (!h.username || h.username === 'root')) set('username', k.username);
                      }
                    }}
                    accentColor={accentColor}
                  />
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
                        'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition border font-medium',
                        h.authMethod === m.id
                          ? ''
                          : 'border-transparent text-slate-400 hover:text-white'
                      )}
                      style={
                        h.authMethod === m.id
                          ? {
                              backgroundColor: `${accentColor}20`,
                              borderColor: `${accentColor}40`,
                              color: accentColor,
                            }
                          : undefined
                      }
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
                        <label className="flex cursor-pointer items-center gap-1 text-[11px] hover:underline" style={{ color: accentColor }}>
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
          <div>
            <label className={label}>Startup Command (Executed on connect)</label>
            <input
              className={cn(input, 'font-mono text-xs')}
              value={h.startupCommand ?? ''}
              onChange={(e) => set('startupCommand', e.target.value)}
              placeholder="tmux attach || tmux new, cd /var/www, etc."
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Shell command sent automatically to the terminal immediately after connecting.
            </p>
          </div>
          <div><label className={label}>Tags</label><input className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="api, eu-west" /></div>
          {saveError && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{saveError}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-white/5 bg-black/20 px-5 py-3">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-xs text-slate-300 hover:bg-white/5">Cancel</button>
          <button
            disabled={!valid || saving}
            onClick={submit}
            className="flex items-center gap-2 rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-40 shadow-lg"
            style={{
              backgroundColor: accentColor,
              color: '#000000',
              boxShadow: `0 0 20px ${accentColor}35`,
            }}
          >
            {saving ? 'Saving…' : 'Save host'}
          </button>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
