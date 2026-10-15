/**
 * bridge.ts — the ONLY place the UI talks to a backend.
 *
 *  • Desktop (Tauri):  invoke() → Rust commands in src-tauri/src/*.rs,
 *                      PTY bytes streamed over tauri::ipc::Channel.
 *  • Browser preview:  sandbox backend (demoShell.ts) with a vault encrypted
 *                      via WebCrypto (PBKDF2-SHA256 310k → AES-256-GCM).
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { readText as tauriReadText, writeText as tauriWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { DemoShell, homeOf, vfs } from './demoShell';
import type {
  ActiveTunnelInfo,
  AiProviderConfig,
  BridgeError,
  ClipboardItem,
  CommandHistoryItem,
  ConnectionLog,
  DetectedLocalKey,
  EncryptedTeamVaultBundle,
  FileEntry,
  GeneratedKeySaved,
  KeygenRequest,
  Host,
  HostSecret,
  KeychainInput,
  KeychainItem,
  KnownHost,
  LocalDeviceInfo,
  LocalDirResponse,
  OpencodeHostStatus,
  PairedDevice,
  PairingHostInfo,
  PairingJoinResult,
  ParsedSshHost,
  SerialOpenOptions,
  SerialPortInfo,
  SessionEvent,
  Snapshot,
  Snippet,
  TunnelConfig,
  Vault,
} from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const uid = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function b64ToBytes(b64: string): Uint8Array {
  if (typeof (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64 === 'function') {
    return (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(b64);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isBridgeError(e: unknown): e is BridgeError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e;
}

// ─────────────────────── Sandbox encrypted vault ───────────────────────
interface DemoState {
  hosts: Host[];
  secrets: Record<string, HostSecret>;
  snippets: Snippet[];
  knownHosts: Record<string, string>;
  knownHostsList: KnownHost[];
  snapshots: Record<string, Snapshot>;
  keychain: KeychainItem[];
  keychainSecrets: Record<string, HostSecret>;
  connectionLogs: ConnectionLog[];
  tunnels: TunnelConfig[];
  vaults: Vault[];
  aiConfigs?: Record<string, AiProviderConfig>;
  activeAiProvider?: string;
}

const SEED: DemoState = {
  hosts: [
    { id: 'h-prod', label: 'prod-api-01', hostname: '10.0.4.10', port: 22, username: 'ubuntu', authMethod: 'key', group: 'Production', tags: ['api', 'eu-west'], color: '#f43f5e', hasSecret: true, os: 'ubuntu' },
    { id: 'h-edge', label: 'edge-gateway', hostname: 'edge.acme.io', port: 2222, username: 'root', authMethod: 'key', group: 'Production', tags: ['nginx'], color: '#f59e0b', hasSecret: true, os: 'debian' },
    { id: 'h-stage', label: 'staging-db', hostname: '10.1.2.30', port: 22, username: 'deploy', authMethod: 'password', group: 'Staging', tags: ['postgres'], color: '#22d3ee', hasSecret: true, os: 'ubuntu' },
    { id: 'h-pi', label: 'homelab-pi', hostname: '192.168.1.42', port: 22, username: 'pi', authMethod: 'agent', group: 'Homelab', tags: ['arm64'], color: '#a78bfa', hasSecret: false, os: 'debian' },
  ],
  secrets: { 'h-prod': { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n(demo ed25519)\n-----END OPENSSH PRIVATE KEY-----' } },
  snippets: [
    { id: 's1', name: 'Disk usage (top 10)', command: 'du -ah . | sort -rh | head -n 10', folder: 'System', tags: ['disk'] },
    { id: 's2', name: 'Tail nginx errors', command: 'tail -n 20 /var/log/nginx/error.log', folder: 'Logs', tags: ['nginx'] },
    { id: 's3', name: 'Docker status', command: 'docker ps', folder: 'Containers', tags: ['docker'] },
    { id: 's4', name: 'Memory & disk', command: 'free -h && df -h', folder: 'System', tags: [] },
    { id: 's5', name: 'Service status', command: 'systemctl status {{service}}', folder: 'System', tags: ['systemd'] },
    { id: 's6', name: 'Deploy branch', command: 'cd ~/projects && git checkout {{branch}} && ./deploy.sh', folder: 'Deploy', tags: ['git'] },
    { id: 's7', name: 'Listening ports', command: 'ss -tulpn | grep LISTEN', folder: 'Network', tags: ['net'] },
  ],
  knownHosts: { '10.0.4.10:22': 'demo' },
  knownHostsList: [
    { host: '10.0.4.10', port: 22, fingerprint: 'SHA256:7uU8g5...prod-api', addedAt: Date.now() - 86400000 * 10 },
    { host: 'edge.acme.io', port: 2222, fingerprint: 'SHA256:9vK1b2...edge-gw', addedAt: Date.now() - 86400000 * 5 },
  ],
  snapshots: {},
  keychain: [
    { id: 'kc-1', label: 'Production Ops Key', username: 'ubuntu', authMethod: 'key', hasSecret: true, updatedAt: Date.now() - 86400000 * 2, vaultId: 'personal' },
    { id: 'kc-2', label: 'DB Root Password', username: 'postgres', authMethod: 'password', hasSecret: true, updatedAt: Date.now() - 86400000 * 7, vaultId: 'personal' },
  ],
  keychainSecrets: {
    'kc-1': { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n(demo keychain)\n-----END OPENSSH PRIVATE KEY-----' },
    'kc-2': { password: 'demo-password' },
  },
  connectionLogs: [
    { id: 'log-1', hostId: 'h-prod', hostLabel: 'prod-api-01', hostname: '10.0.4.10', username: 'ubuntu', status: 'disconnected', startedAt: Date.now() - 1800000, endedAt: Date.now() - 300000, duration: 1500, saved: true },
    { id: 'log-2', hostId: 'h-stage', hostLabel: 'staging-db', hostname: '10.1.2.30', username: 'deploy', status: 'failed', startedAt: Date.now() - 7200000, endedAt: Date.now() - 7195000, duration: 5, saved: false },
  ],
  tunnels: [
    { id: 'tun-1', label: 'Postgres Staging', hostId: 'h-stage', forwardType: 'local', localHost: '127.0.0.1', localPort: 5433, remoteHost: 'localhost', remotePort: 5432, updatedAt: Date.now() - 86400000 },
    { id: 'tun-2', label: 'Internal SOCKS Proxy', hostId: 'h-prod', forwardType: 'dynamic', localHost: '127.0.0.1', localPort: 1080, remoteHost: '127.0.0.1', remotePort: 0, updatedAt: Date.now() - 86400000 * 2 },
  ],
  vaults: [
    { id: 'personal', name: 'Personal Vault', kind: 'personal', color: '#22d3ee', description: 'Your private hosts & credentials', createdAt: Date.now() - 86400000 * 30 },
    { id: 'devops-team', name: 'DevOps Team', kind: 'team', color: '#10b981', description: 'Shared cloud infrastructure & clusters', createdAt: Date.now() - 86400000 * 14 },
  ],
};

let demoKey: CryptoKey | string | null = null;
let demo: DemoState | null = null;

async function deriveDemoKey(password: string, salt: Uint8Array): Promise<CryptoKey | string> {
  if (typeof crypto !== 'undefined' && crypto?.subtle?.importKey) {
    try {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 310_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } catch {
      /* subtle unavailable */
    }
  }
  return `insecure_preview_${password}_${toB64(salt)}`;
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => b64ToBytes(s);

let persistTimer: ReturnType<typeof setTimeout> | null = null;
async function doPersistDemo() {
  if (!demo || !demoKey) return;
  if (typeof crypto !== 'undefined' && crypto?.subtle?.encrypt && typeof demoKey !== 'string') {
    try {
      const iv = (crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(12)) : new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, demoKey, new TextEncoder().encode(JSON.stringify(demo))));
      localStorage.setItem('nx.vault', JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(ct) }));
      return;
    } catch {
      /* fallback below */
    }
  }
  // Insecure HTTP preview context fallback (mobile browser testing over LAN IP)
  const plain = toB64(new TextEncoder().encode(JSON.stringify(demo)));
  localStorage.setItem('nx.vault', JSON.stringify({ v: 1, plain }));
}

async function persistDemo() {
  if (!demo || !demoKey) return;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await doPersistDemo();
  }, 100);
}

if (typeof window !== 'undefined') {
  const flushPersist = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
      void doPersistDemo();
    }
  };
  window.addEventListener('beforeunload', flushPersist);
  window.addEventListener('pagehide', flushPersist);
}

function need(): DemoState {
  if (!demo) throw { kind: 'vaultLocked', message: 'vault is locked' };
  return demo;
}

async function fingerprintFor(h: Host) {
  const enc = new TextEncoder().encode(`${h.hostname}:${h.port}`);
  if (typeof crypto !== 'undefined' && crypto?.subtle?.digest) {
    try {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc));
      return toB64(d).replace(/=+$/, '');
    } catch {
      /* fallback below */
    }
  }
  return toB64(enc).replace(/=+$/, '');
}

interface DemoSession { shell: DemoShell; host: Host; emit: (e: SessionEvent) => void; }
const demoSessions = new Map<string, DemoSession>();

const sessionWriteQueues = new Map<string, Promise<any>>();

function enqueueSessionWrite<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionWriteQueues.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  sessionWriteQueues.set(sessionId, next);
  return next;
}

// ─────────────────────────────── API ───────────────────────────────────
/** Shape of `sync_status` / `sync_now`. `skippedBlobs` counts records the relay
 * served that this device could not decrypt (another sync group, or a corrupt
 * blob). They are skipped rather than failing the sync, so a non-zero value is a
 * diagnostic — not a lost update. */
export interface SyncStatusInfo {
  enabled: boolean;
  relayUrl: string | null;
  deviceId: string;
  lastSync: number | null;
  cursor: number;
  lastError: string | null;
  hasToken?: boolean;
  skippedBlobs?: number;
}

export type AiAuthKind = 'none' | 'bearer' | 'anthropic' | 'gemini';

export interface AiProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Explicit proxy override (local SSH SOCKS tunnel). Pooled proxies are chosen by the backend. */
  proxyUrl?: string;
  /** Provider whose vault-held keys/proxies the backend should use. */
  providerId?: string;
  /** How the backend injects the pooled key. */
  auth?: AiAuthKind;
}

export interface AiStreamEvents {
  onMeta?: (keyMask: string | null, proxyMask: string | null) => void;
  onFailover?: (reason: string, next: string) => void;
}

type AiStreamMsg =
  | { type: 'data'; text: string }
  | { type: 'meta'; keyMask: string | null; proxyMask: string | null }
  | { type: 'failover'; reason: string; next: string };

async function demoEditAiList(
  config: AiProviderConfig,
  field: 'apiKeys' | 'proxyUrls',
  fn: (list: string[]) => string[]
): Promise<AiProviderConfig> {
  const s = need();
  if (!s.aiConfigs) s.aiConfigs = {};
  const cur = s.aiConfigs[config.providerId] ?? { ...config, apiKeys: [], proxyUrls: [] };
  const next = { ...cur, [field]: fn([...(cur[field] ?? [])]) } as AiProviderConfig;
  s.aiConfigs[config.providerId] = next;
  await persistDemo();
  return next;
}

export const bridge = {
  // ── Vault ──
  async vaultStatus(): Promise<{ initialized: boolean; unlocked: boolean }> {
    if (isTauri) return invoke('vault_status');
    return { initialized: !!localStorage.getItem('nx.vault'), unlocked: !!demo };
  },

  async unlock(masterPassword: string): Promise<string | null> {
    if (isTauri) return invoke('vault_unlock', { masterPassword });
    let saltB64 = localStorage.getItem('nx.salt');
    if (!saltB64) {
      const salt = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(16)) : new Uint8Array(16);
      saltB64 = toB64(salt);
      localStorage.setItem('nx.salt', saltB64);
    }
    const key = await deriveDemoKey(masterPassword, fromB64(saltB64));
    const stored = localStorage.getItem('nx.vault');
    let isNew = false;
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.plain) {
          demo = JSON.parse(new TextDecoder().decode(fromB64(parsed.plain)));
        } else if (parsed.iv && parsed.ct) {
          if (typeof crypto !== 'undefined' && crypto?.subtle?.decrypt && typeof key !== 'string') {
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parsed.iv) as BufferSource }, key, fromB64(parsed.ct) as BufferSource);
            demo = JSON.parse(new TextDecoder().decode(pt));
          } else {
            demo = structuredClone(SEED);
          }
        } else {
          demo = structuredClone(SEED);
        }
        // Migrate already-persisted demo vaults: scope vault-less keychain
        // rows so preview matches desktop partitioning.
        for (const k of demo?.keychain ?? []) {
          if (!k.vaultId) k.vaultId = 'personal';
        }
      } catch {
        throw { kind: 'badMasterPassword', message: 'Invalid master password' };
      }
    } else {
      demo = structuredClone(SEED);
      isNew = true;
    }
    demoKey = key;
    await persistDemo();
    return isNew ? 'NX-DEMO-RECO-VERY-KEY1-2345-6789-ABCD' : null;
  },

  async vaultRecover(recoveryCode: string, newPassword: string): Promise<string> {
    if (isTauri) return invoke('vault_recover', { recoveryCode, newPassword });
    await this.resetDemoVault();
    await this.unlock(newPassword);
    return 'NX-DEMO-RECO-VERY-KEY1-2345-6789-ABCD';
  },

  async vaultReset(): Promise<void> {
    if (isTauri) {
      await invoke('vault_reset');
    }
    await this.resetDemoVault();
    localStorage.removeItem('nx.os_keychain');
  },

  async vaultGetRecoveryKey(): Promise<string> {
    if (isTauri) return invoke('vault_get_recovery_key');
    return 'NX-DEMO-RECO-VERY-KEY1-2345-6789-ABCD';
  },

  async vaultSaveEmergencyKit(content: string, filename?: string): Promise<string> {
    if (isTauri) {
      return invoke<string>('vault_save_emergency_kit', { content, filename });
    }
    const fname = filename ?? `nexus-emergency-kit-${Date.now()}.txt`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    return `Downloads/${fname}`;
  },

  async resetDemoVault() {
    localStorage.removeItem('nx.vault');
    localStorage.removeItem('nx.salt');
    demo = null;
    demoKey = null;
  },

  async lock(): Promise<void> {
    if (isTauri) return invoke('vault_lock');
    demo = null; demoKey = null;
  },

  // ── OS Keychain (biometric unlock) ──
  //
  // We do NOT probe the OS keychain on startup — on macOS that would pop a
  // Touch ID dialog before the user has clicked anything. Instead, the
  // frontend persists an opt-in flag in localStorage after a successful
  // store and clears it after delete; the biometric button only appears
  // when that flag is true. If the OS-side entry was deleted out-of-band
  // (e.g. via Keychain Access), osKeychainUnlock will return NoEntry and
  // we surface the error + fall back to password entry.
  //
  // `osKeychainStatus()` keeps the same promise: by default it only reports
  // whether a *device-bound* credential file exists. Pass `probeKeyring: true`
  // only from a view the user opened on purpose (Quick Unlock settings), which
  // is also where an unexpected prompt is explainable.
  osKeychainEnabled(): boolean {
    if (!isTauri) return false;
    try { return localStorage.getItem('nx.os_keychain') === '1'; } catch { return false; }
  },

  async osKeychainStatus(probeKeyring = false): Promise<boolean> {
    if (!isTauri) return false;
    try {
      return await invoke<boolean>('os_keychain_status', { probeKeyring });
    } catch {
      return false;
    }
  },

  async osKeychainUnlock(): Promise<string | null> {
    if (!isTauri) throw new Error('Device quick unlock is only available in the installed app');
    return invoke('os_keychain_unlock');
  },

  async osKeychainStore(masterPassword: string): Promise<boolean> {
    if (!isTauri) return false;
    try {
      await invoke('os_keychain_store', { masterPassword });
      try { localStorage.setItem('nx.os_keychain', '1'); } catch {}
      return true;
    } catch (e) {
      console.warn('osKeychainStore failed:', e);
      throw e;
    }
  },

  async osKeychainDelete(): Promise<void> {
    if (!isTauri) return;
    try { await invoke('os_keychain_delete'); } catch { /* non-fatal */ }
    try { localStorage.removeItem('nx.os_keychain'); } catch {}
  },

  async checkStoragePermission(): Promise<boolean> {
    if (!isTauri) return true;
    try {
      return await invoke<boolean>('check_storage_permission');
    } catch {
      return true;
    }
  },

  async requestStoragePermission(): Promise<boolean> {
    if (!isTauri) return true;
    try {
      return await invoke<boolean>('request_storage_permission');
    } catch {
      return false;
    }
  },

  // ── Hosts ──
  async listHosts(): Promise<Host[]> {
    if (isTauri) return invoke('hosts_list');
    const s = need();
    return s.hosts.map((h) => ({ ...h, hasSecret: !!s.secrets[h.id] || h.hasSecret }));
  },

  async saveHost(host: Host, secret?: HostSecret): Promise<string> {
    if (isTauri) return invoke('host_save', { input: { ...host, secret: secret ?? null } });
    const s = need();
    const id = host.id || uid();
    const next = { ...host, id, hasSecret: !!secret || (!!host.keychainId ? false : host.hasSecret) };
    const i = s.hosts.findIndex((h) => h.id === id);
    if (i >= 0) s.hosts[i] = next; else s.hosts.push(next);
    if (host.keychainId) delete s.secrets[id];
    else if (secret) s.secrets[id] = secret;
    await persistDemo();
    return id;
  },

  async saveHostWithNewKeychain(host: Host, keychain: KeychainInput): Promise<string> {
    if (isTauri) return invoke('host_save_with_new_keychain', { profile: host, keychain });
    const s = need();
    const kid = keychain.id || uid();
    const hostVault = (host as any).vaultId && (host as any).vaultId !== 'all' ? (host as any).vaultId : 'personal';
    const itemId = kid;
    const hasSecret = !!(keychain.password || keychain.privateKey);
    const item: KeychainItem = {
      id: itemId,
      label: keychain.label,
      username: keychain.username,
      authMethod: keychain.authMethod,
      hasSecret,
      updatedAt: Date.now(),
      vaultId: keychain.vaultId ?? hostVault,
    } as KeychainItem;
    const ki = s.keychain.findIndex((k) => k.id === itemId);
    if (ki >= 0) s.keychain[ki] = item; else s.keychain.push(item);
    s.keychainSecrets[itemId] = {
      password: keychain.password,
      privateKey: keychain.privateKey,
      passphrase: keychain.passphrase,
    };
    const id = host.id || uid();
    const next = { ...host, id, keychainId: itemId, hasSecret: false };
    const i = s.hosts.findIndex((h) => h.id === id);
    if (i >= 0) s.hosts[i] = next; else s.hosts.push(next);
    delete s.secrets[id];
    await persistDemo();
    return id;
  },

  async deleteHost(id: string) {
    if (isTauri) return invoke('host_delete', { id });
    const s = need();
    s.hosts = s.hosts.filter((h) => h.id !== id);
    delete s.secrets[id];
    await persistDemo();
  },

  async trustHostKey(host: Host, fingerprint: string) {
    if (isTauri) return invoke('host_trust_key', { host: host.hostname, port: host.port, fingerprint });
    need().knownHosts[`${host.hostname}:${host.port}`] = fingerprint;
    await persistDemo();
  },

  // ── SSH Config Importer ──
  async detectSshConfig(): Promise<string | null> {
    if (isTauri) return invoke('ssh_config_detect');
    return '~/.ssh/config (demo)';
  },

  async previewSshConfig(path?: string, content?: string): Promise<ParsedSshHost[]> {
    if (isTauri) return invoke('ssh_config_preview', { path: path || null, content: content || null });
    return [
      { id: 'h-demo-1', label: 'prod-api-01', hostname: '10.0.4.10', port: 22, username: 'ubuntu', identityFile: '~/.ssh/id_rsa', group: 'SSH Config' },
      { id: 'h-demo-2', label: 'staging-db', hostname: '10.1.2.30', port: 22, username: 'deploy', identityFile: '~/.ssh/id_ed25519', group: 'SSH Config' },
      { id: 'h-demo-3', label: 'edge-gateway', hostname: 'edge.acme.io', port: 2222, username: 'root', group: 'SSH Config' },
    ];
  },

  async importSshConfig(hosts: ParsedSshHost[], vaultId: string): Promise<number> {
    if (isTauri) return invoke('ssh_config_import', { hosts, vaultId });
    const s = need();
    for (const h of hosts) {
      s.hosts.push({
        id: h.id || uid(),
        label: h.label,
        hostname: h.hostname,
        port: h.port,
        username: h.username,
        authMethod: h.identityFile ? 'key' : 'agent',
        tags: ['ssh-config'],
        hasSecret: false,
        vaultId: vaultId || 'personal',
      });
    }
    await persistDemo();
    return hosts.length;
  },

  // ── Snippets ──
  async listSnippets(): Promise<Snippet[]> {
    if (isTauri) return invoke('snippets_list');
    return [...need().snippets];
  },
  async saveSnippet(snippet: Snippet): Promise<string> {
    if (isTauri) return invoke('snippet_save', { snippet });
    const s = need();
    const id = snippet.id || uid();
    const i = s.snippets.findIndex((x) => x.id === id);
    if (i >= 0) s.snippets[i] = { ...snippet, id }; else s.snippets.push({ ...snippet, id });
    await persistDemo();
    return id;
  },
  async deleteSnippet(id: string) {
    if (isTauri) return invoke('snippet_delete', { id });
    const s = need();
    s.snippets = s.snippets.filter((x) => x.id !== id);
    await persistDemo();
  },

  // ── Snapshots ──
  async getSnapshot(hostId: string): Promise<Snapshot | null> {
    if (isTauri) return invoke('snapshot_get', { hostId });
    return need().snapshots[hostId] ?? null;
  },
  /** Rust records snapshots itself from the PTY stream; the sandbox records from the UI. */
  async recordSnapshot(hostId: string, sessionId: string, patch: Partial<Snapshot>) {
    if (isTauri || !demo) return;
    const prev = demo.snapshots[hostId] ?? { hostId, sessionId, cwd: '~', lastCommand: null, updatedAt: 0 };
    demo.snapshots[hostId] = { ...prev, ...patch, sessionId, updatedAt: Math.floor(Date.now() / 1000) };
    await persistDemo();
  },

  // ── SSH ──
  async connect(hostId: string, cols: number, rows: number, resume: boolean, onEvent: (e: SessionEvent) => void): Promise<string> {
    if (isTauri) {
      const channel = new Channel<{ event: string; data: Record<string, unknown> }>();
      channel.onmessage = (msg) => {
        const d = msg.data as Record<string, string & boolean>;
        switch (msg.event) {
          case 'output': onEvent({ type: 'output', data: b64ToBytes(d.b64) }); break;
          case 'cwd': onEvent({ type: 'cwd', path: d.path }); break;
          case 'connected': onEvent({ type: 'connected', sessionId: d.sessionId, fingerprint: d.fingerprint, banner: d.banner, os: (d as Record<string, unknown>).os as string | null ?? null }); break;
          case 'disconnected': onEvent({ type: 'disconnected', reason: d.reason, resumable: d.resumable }); break;
        }
      };
      return invoke<string>('ssh_connect', { req: { hostId, cols, rows, resume }, onEvent: channel });
    }

    // Sandbox
    const s = need();
    const host = s.hosts.find((h) => h.id === hostId);
    if (!host) throw { kind: 'hostNotFound', message: `host not found: ${hostId}` };
    await sleep(500 + Math.random() * 500);
    const fp = await fingerprintFor(host);
    const pinned = s.knownHosts[`${host.hostname}:${host.port}`];
    if (!pinned) throw { kind: 'unknownHostKey', message: 'unknown host key', fingerprint: fp };
    const sessionId = uid();
    const shell = new DemoShell(
      host,
      (str) => onEvent({ type: 'output', data: str }),
      (path) => onEvent({ type: 'cwd', path }),
    );
    demoSessions.set(sessionId, { shell, host, emit: onEvent });
    onEvent({ type: 'connected', sessionId, fingerprint: fp, banner: null, os: host.os ?? null });
    const snap = resume ? s.snapshots[hostId] : undefined;
    setTimeout(() => shell.start(snap?.cwd), 30);
    return sessionId;
  },

  async write(sessionId: string, data: string) {
    if (isTauri) {
      return enqueueSessionWrite(sessionId, async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            return await invoke('ssh_write', { sessionId, data });
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (msg.includes('queue is full') && attempt < 4) {
              await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
      });
    }
    demoSessions.get(sessionId)?.shell.input(data);
  },

  async resize(sessionId: string, cols: number, rows: number) {
    if (isTauri) return invoke('ssh_resize', { sessionId, cols, rows });
  },

  async disconnect(sessionId: string) {
    sessionWriteQueues.delete(sessionId);
    if (isTauri) return invoke('ssh_disconnect', { sessionId }).catch(() => {});
    demoSessions.delete(sessionId);
  },

  /** Sandbox-only: simulate a dropped link to exercise snapshot/resume. */
  simulateDrop(sessionId: string) {
    const s = demoSessions.get(sessionId);
    if (!s) return;
    demoSessions.delete(sessionId);
    s.emit({ type: 'disconnected', reason: 'connection lost: Broken pipe (os error 32)', resumable: true });
  },

  // ── SFTP ──
  homeFor(sessionId: string): string {
    const s = demoSessions.get(sessionId);
    return s ? homeOf(s.host) : '';
  },

  async sftpList(sessionId: string, path: string): Promise<FileEntry[]> {
    if (isTauri) return invoke('sftp_list', { sessionId, path });
    const s = demoSessions.get(sessionId);
    if (!s) throw { kind: 'sessionNotFound', message: 'session closed' };
    await sleep(120);
    return vfs.list(s.host, path);
  },

  async sftpMkdir(sessionId: string, path: string) {
    if (isTauri) return invoke('sftp_mkdir', { sessionId, path });
    const s = demoSessions.get(sessionId); if (s) vfs.mkdir(s.host, path);
  },

  async sftpRemove(sessionId: string, path: string, isDir: boolean) {
    if (isTauri) return invoke('sftp_remove', { sessionId, path, isDir });
    const s = demoSessions.get(sessionId); if (s) vfs.remove(s.host, path);
  },

  async sftpRename(sessionId: string, from: string, to: string) {
    if (isTauri) return invoke('sftp_rename', { sessionId, from, to });
    const s = demoSessions.get(sessionId); if (s) vfs.rename(s.host, from, to);
  },

  async sftpUpload(sessionId: string, remoteDir: string, file: File | null, onProgress: (pct: number) => void) {
    if (isTauri) {
      const local = await invoke<string | null>('plugin:dialog|open', { options: { multiple: false, directory: false } });
      if (!local) return;
      const name = local.split(/[\\/]/).pop()!;
      const ch = new Channel<{ transferred: number; total: number }>();
      ch.onmessage = (p) => onProgress(p.total ? p.transferred / p.total : 1);
      return invoke('sftp_upload', { sessionId, local, remote: `${remoteDir.replace(/\/$/, '')}/${name}`, onProgress: ch });
    }
    const s = demoSessions.get(sessionId);
    if (!s || !file) return;
    for (let i = 1; i <= 10; i++) { await sleep(60); onProgress(i / 10); }
    vfs.write(s.host, `${remoteDir.replace(/\/$/, '')}/${file.name}`, await file.text());
  },

  async sftpDownload(sessionId: string, entry: FileEntry, onProgress: (pct: number) => void) {
    if (isTauri) {
      const local = await invoke<string | null>('plugin:dialog|save', { options: { defaultPath: entry.name } });
      if (!local) return;
      const ch = new Channel<{ transferred: number; total: number }>();
      ch.onmessage = (p) => onProgress(p.total ? p.transferred / p.total : 1);
      return invoke('sftp_download', { sessionId, remote: entry.path, local, onProgress: ch });
    }
    const s = demoSessions.get(sessionId);
    if (!s) return;
    for (let i = 1; i <= 10; i++) { await sleep(40); onProgress(i / 10); }
    const blob = new Blob([vfs.read(s.host, entry.path)]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = entry.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  async sftpReadText(sessionId: string, path: string): Promise<string> {
    if (isTauri) {
      return invoke('sftp_read_text', { sessionId, path });
    }
    const s = demoSessions.get(sessionId);
    if (!s) throw new Error('Session not found');
    return vfs.read(s.host, path) || '';
  },

  async sftpWriteText(sessionId: string, path: string, content: string): Promise<void> {
    if (isTauri) {
      return invoke('sftp_write_text', { sessionId, path, content });
    }
    const s = demoSessions.get(sessionId);
    if (!s) throw new Error('Session not found');
    vfs.write(s.host, path, content);
  },

  async sftpConnect(hostId: string): Promise<string> {
    if (isTauri) return invoke('sftp_connect', { hostId });
    const sid = 'sftp_demo_' + Math.random().toString(36).slice(2, 8);
    const h = need().hosts.find((x) => x.id === hostId);
    if (h) {
      const shell = new DemoShell(h, () => {}, () => {});
      demoSessions.set(sid, { host: h, shell, emit: () => {} });
    }
    return sid;
  },

  async sftpUploadDirect(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (pct: number) => void
  ): Promise<void> {
    if (isTauri) {
      const ch = new Channel<{ transferred: number; total: number }>();
      if (onProgress) {
        ch.onmessage = (p) => onProgress(p.total ? p.transferred / p.total : 1);
      }
      return invoke('sftp_upload', { sessionId, local: localPath, remote: remotePath, onProgress: ch });
    }
    if (onProgress) {
      for (let i = 1; i <= 10; i++) {
        await sleep(30);
        onProgress(i / 10);
      }
    }
  },

  async sftpDownloadDirect(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (pct: number) => void
  ): Promise<void> {
    if (isTauri) {
      const ch = new Channel<{ transferred: number; total: number }>();
      if (onProgress) {
        ch.onmessage = (p) => onProgress(p.total ? p.transferred / p.total : 1);
      }
      return invoke('sftp_download', { sessionId, remote: remotePath, local: localPath, onProgress: ch });
    }
    if (onProgress) {
      for (let i = 1; i <= 10; i++) {
        await sleep(30);
        onProgress(i / 10);
      }
    }
  },

  async sftpClose(sessionId: string): Promise<void> {
    if (isTauri) {
      await invoke('sftp_close', { sessionId }).catch(() => {});
    }
  },

  // ── Local Filesystem ──
  async localFsHome(): Promise<string> {
    if (isTauri) return invoke('local_fs_home');
    return '/home/dreycore';
  },

  async localFsList(path?: string): Promise<LocalDirResponse> {
    if (isTauri) return invoke('local_fs_list', { path: path || null });
    const current = path || '/home/dreycore';
    return {
      currentPath: current,
      parentPath: current === '/' ? null : current.replace(/\/[^/]+\/?$/, '') || '/',
      entries: [
        { name: 'Desktop', path: `${current}/Desktop`, isDir: true, isSymlink: false, size: 0, modified: Math.floor(Date.now() / 1000), permissions: 0o755 },
        { name: 'Documents', path: `${current}/Documents`, isDir: true, isSymlink: false, size: 0, modified: Math.floor(Date.now() / 1000), permissions: 0o755 },
        { name: 'Downloads', path: `${current}/Downloads`, isDir: true, isSymlink: false, size: 0, modified: Math.floor(Date.now() / 1000), permissions: 0o755 },
        { name: 'Projects', path: `${current}/Projects`, isDir: true, isSymlink: false, size: 0, modified: Math.floor(Date.now() / 1000), permissions: 0o755 },
        { name: 'config.json', path: `${current}/config.json`, isDir: false, isSymlink: false, size: 512, modified: Math.floor(Date.now() / 1000), permissions: 0o644 },
      ],
    };
  },

  async localFsMkdir(path: string): Promise<void> {
    if (isTauri) return invoke('local_fs_mkdir', { path });
  },

  async localFsRemove(path: string, isDir: boolean): Promise<void> {
    if (isTauri) return invoke('local_fs_remove', { path, isDir });
  },

  async localFsRename(from: string, to: string): Promise<void> {
    if (isTauri) return invoke('local_fs_rename', { from, to });
  },

  async localFsReadText(path: string): Promise<string> {
    if (isTauri) return invoke('local_fs_read_text', { path });
    return '# Demo local file\nprint("Hello, NexusTerminal!")\n';
  },

  async localFsWriteText(path: string, content: string): Promise<void> {
    if (isTauri) return invoke('local_fs_write_text', { path, content });
  },

  // ── Keychain (Reusable Identities) ──
  async listKeychain(): Promise<KeychainItem[]> {
    if (isTauri) return invoke('keychain_list');
    return [...need().keychain];
  },

  async saveKeychain(input: KeychainInput): Promise<string> {
    if (isTauri) return invoke('keychain_save', { input });
    const s = need();
    const itemId = input.id || uid();
    const hasSecret = !!(input.password || input.privateKey);
    const existingIdx = s.keychain.findIndex((k) => k.id === itemId);
    const item: KeychainItem = {
      id: itemId,
      label: input.label,
      username: input.username,
      authMethod: input.authMethod,
      hasSecret,
      updatedAt: Date.now(),
      vaultId: input.vaultId ?? s.keychain[existingIdx]?.vaultId ?? 'personal',
    };
    if (existingIdx >= 0) s.keychain[existingIdx] = item; else s.keychain.push(item);
    s.keychainSecrets[itemId] = {
      password: input.password,
      privateKey: input.privateKey,
      passphrase: input.passphrase,
    };
    await persistDemo();
    return itemId;
  },

  async deleteKeychain(id: string): Promise<void> {
    if (isTauri) return invoke('keychain_delete', { id });
    const s = need();
    s.keychain = s.keychain.filter((k) => k.id !== id);
    delete s.keychainSecrets[id];
    await persistDemo();
  },

  async importKeychainFromHosts(): Promise<number> {
    if (isTauri) return invoke('keychain_import_from_hosts');
    return 0;
  },

  async detectLocalSshKeys(): Promise<DetectedLocalKey[]> {
    if (isTauri) return invoke('keychain_detect_local_keys');
    return [];
  },

  async importLocalSshKey(path: string, label?: string, passphrase?: string, vaultId?: string): Promise<string> {
    if (isTauri) return invoke('keychain_import_local_key', { path, label: label ?? null, passphrase: passphrase ?? null, vaultId: vaultId ?? null });
    return '';
  },

  /**
   * Generate a key pair and save it to the vault. The private key is created
   * and stored inside Rust and never returned, so this replaces the older
   * `generateSshKey` + `saveKeychain` pair (which round-tripped the secret
   * through the WebView for no reason — the UI only ever shows the public key).
   */
  async generateAndSaveSshKey(req: KeygenRequest): Promise<GeneratedKeySaved> {
    if (isTauri) return invoke<GeneratedKeySaved>('keychain_generate_and_save', { req });
    const s = need();
    const tag = uid().slice(0, 8);
    const algorithm = req.algorithm.toUpperCase();
    const label = req.label.trim() || `Generated ${algorithm} Key`;
    const item: KeychainItem = {
      id: uid(),
      label,
      username: req.username || null,
      authMethod: 'key',
      hasSecret: true,
      updatedAt: Date.now(),
      vaultId: req.vaultId ?? 'personal',
    };
    s.keychain.push(item);
    // Demo vault only: there is no native keychain to store this in, so the
    // placeholder goes where `saveKeychain` would have put it.
    s.keychainSecrets[item.id] = {
      password: null,
      privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n(demo generated ${req.algorithm} private key)\n-----END OPENSSH PRIVATE KEY-----`,
      passphrase: req.passphrase || null,
    };
    await persistDemo();
    return {
      item,
      publicKey: `ssh-${req.algorithm} AAAAC3NzaC1lZDI1NTE5AAAAI${tag} ${req.comment || 'demo@nexus'}`,
      fingerprint: `SHA256:${tag.repeat(4)}`,
      algorithm,
    };
  },

  // ── Connection Logs (Audit & History) ──
  async listLogs(limit?: number): Promise<ConnectionLog[]> {
    if (isTauri) return invoke('logs_list', { limit: limit ?? 100 });
    return [...need().connectionLogs];
  },

  async toggleLogSaved(id: string): Promise<boolean> {
    if (isTauri) return invoke('log_toggle_saved', { id });
    const s = need();
    const log = s.connectionLogs.find((l) => l.id === id);
    if (log) {
      log.saved = !log.saved;
      await persistDemo();
      return log.saved;
    }
    return false;
  },

  async clearLogs(): Promise<void> {
    if (isTauri) return invoke('logs_clear');
    const s = need();
    s.connectionLogs = s.connectionLogs.filter((l) => l.saved);
    await persistDemo();
  },

  // ── Known Hosts ──
  async listKnownHosts(): Promise<KnownHost[]> {
    if (isTauri) return invoke('known_hosts_list');
    return [...need().knownHostsList];
  },

  async deleteKnownHost(host: string, port: number): Promise<void> {
    if (isTauri) return invoke('known_host_delete', { host, port });
    const s = need();
    s.knownHostsList = s.knownHostsList.filter((k) => !(k.host === host && k.port === port));
    delete s.knownHosts[`${host}:${port}`];
    await persistDemo();
  },

  // ── Port Forwarding (Tunnels) ──
  async listTunnels(): Promise<TunnelConfig[]> {
    if (isTauri) return invoke('tunnels_list');
    return [...need().tunnels];
  },

  async saveTunnel(tunnel: TunnelConfig): Promise<string> {
    if (isTauri) return invoke('tunnel_save', { tunnel });
    const s = need();
    const id = tunnel.id || uid();
    const item = { ...tunnel, id, updatedAt: Date.now() };
    const idx = s.tunnels.findIndex((t) => t.id === id);
    if (idx >= 0) s.tunnels[idx] = item; else s.tunnels.push(item);
    await persistDemo();
    return id;
  },

  async deleteTunnel(id: string): Promise<void> {
    if (isTauri) return invoke('tunnel_delete', { id });
    const s = need();
    s.tunnels = s.tunnels.filter((t) => t.id !== id);
    await persistDemo();
  },

  async startTunnel(id: string): Promise<ActiveTunnelInfo> {
    if (isTauri) return invoke('tunnel_start', { id });
    return { id, running: true, bytesUp: 0, bytesDown: 0, error: null };
  },

  async stopTunnel(id: string): Promise<ActiveTunnelInfo> {
    if (isTauri) return invoke('tunnel_stop', { id });
    return { id, running: false, bytesUp: 0, bytesDown: 0, error: null };
  },

  async activeTunnels(): Promise<ActiveTunnelInfo[]> {
    if (isTauri) return invoke('tunnel_status_all');
    return [];
  },

  // ── Local Terminal PTY ──
  async spawnLocalPty(
    cols: number,
    rows: number,
    shell?: string,
    cwd?: string,
    onEvent?: (e: SessionEvent) => void,
  ): Promise<string> {
    if (isTauri) {
      const channel = new Channel<{ event: string; data: Record<string, unknown> }>();
      channel.onmessage = (msg) => {
        if (!onEvent) return;
        const d = msg.data as Record<string, string & boolean>;
        switch (msg.event) {
          case 'output': onEvent({ type: 'output', data: b64ToBytes(d.b64) }); break;
          case 'cwd': onEvent({ type: 'cwd', path: d.path }); break;
          case 'connected': onEvent({ type: 'connected', sessionId: d.sessionId, fingerprint: d.fingerprint, banner: d.banner, os: (d as Record<string, unknown>).os as string | null ?? null }); break;
          case 'disconnected': onEvent({ type: 'disconnected', reason: d.reason, resumable: d.resumable }); break;
        }
      };
      return invoke<string>('local_pty_spawn', { req: { cols, rows, shell, cwd }, onEvent: channel });
    }

    // Sandbox local shell fallback
    const sessionId = uid();
    const fakeHost: Host = {
      id: '__local__',
      label: 'Local Terminal',
      hostname: 'localhost',
      port: 0,
      username: 'user',
      authMethod: 'agent',
      tags: ['local'],
      hasSecret: true,
      os: 'linux',
    };
    const shellInstance = new DemoShell(
      fakeHost,
      (str) => onEvent?.({ type: 'output', data: str }),
      (p) => onEvent?.({ type: 'cwd', path: p }),
    );
    demoSessions.set(sessionId, { shell: shellInstance, host: fakeHost, emit: onEvent ?? (() => {}) });
    onEvent?.({ type: 'connected', sessionId, fingerprint: 'local', banner: 'Sandbox Local Shell', os: 'linux' });
    setTimeout(() => shellInstance.start(cwd ?? '~'), 30);
    return sessionId;
  },

  async writeLocalPty(sessionId: string, data: string): Promise<void> {
    if (isTauri) {
      return enqueueSessionWrite(sessionId, async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            return await invoke('local_pty_write', { sessionId, data });
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (msg.includes('queue is full') && attempt < 4) {
              await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
      });
    }
    demoSessions.get(sessionId)?.shell.input(data);
  },

  async resizeLocalPty(sessionId: string, cols: number, rows: number): Promise<void> {
    if (isTauri) return invoke('local_pty_resize', { sessionId, cols, rows });
  },

  async closeLocalPty(sessionId: string): Promise<void> {
    sessionWriteQueues.delete(sessionId);
    if (isTauri) {
      await invoke('local_pty_close', { sessionId }).catch(() => {});
      return;
    }
    demoSessions.delete(sessionId);
  },

  // ── Multi-Vault Management ──
  async listVaults(): Promise<Vault[]> {
    if (isTauri) return invoke('vault_list');
    const st = need();
    if (!st.vaults || st.vaults.length === 0) {
      st.vaults = [
        { id: 'personal', name: 'Personal Vault', kind: 'personal', color: '#22d3ee', description: 'Your private hosts & secrets', createdAt: Date.now() },
      ];
    }
    return [...st.vaults];
  },

  async saveVault(record: Vault): Promise<string> {
    if (isTauri) return invoke('vault_save', { record });
    const st = need();
    if (!st.vaults) st.vaults = [];
    const idx = st.vaults.findIndex((v: Vault) => v.id === record.id);
    const id = record.id || uid();
    const updated = { ...record, id };
    if (idx >= 0) st.vaults[idx] = updated;
    else st.vaults.push(updated);
    await persistDemo();
    return id;
  },

  async deleteVault(id: string): Promise<void> {
    if (id === 'personal') throw new Error('Cannot delete the default Personal Vault');
    if (isTauri) return invoke('vault_delete', { id });
    const st = need();
    st.vaults = (st.vaults ?? []).filter((v: Vault) => v.id !== id);
    st.hosts.forEach((h: Host) => { if (h.vaultId === id) h.vaultId = 'personal'; });
    await persistDemo();
  },

  // ── Serial Ports ──
  async listSerialPorts(): Promise<SerialPortInfo[]> {
    if (isTauri) return invoke('serial_list_ports');
    return [
      { portName: '/dev/ttyUSB0', description: 'FTDI USB Serial Interface (UART)' },
      { portName: '/dev/ttyACM0', description: 'Arduino / Embedded Serial Device' },
    ];
  },

  async openSerial(
    opts: SerialOpenOptions,
    onEvent: (e: SessionEvent) => void,
  ): Promise<string> {
    if (isTauri) {
      const channel = new Channel<{ event: string; data: Record<string, unknown> }>();
      channel.onmessage = (msg) => {
        const d = msg.data as Record<string, string & boolean>;
        switch (msg.event) {
          case 'output': onEvent({ type: 'output', data: b64ToBytes(d.b64) }); break;
          case 'cwd': onEvent({ type: 'cwd', path: d.path }); break;
          case 'connected': onEvent({ type: 'connected', sessionId: d.sessionId, fingerprint: d.fingerprint, banner: d.banner, os: null }); break;
          case 'disconnected': onEvent({ type: 'disconnected', reason: d.reason, resumable: d.resumable }); break;
        }
      };
      return invoke<string>('serial_open', { req: opts, onEvent: channel });
    }
    // No sandbox serial — fall through to an error.
    throw new Error('Native serial ports are only available in the desktop app');
  },

  async writeSerial(sessionId: string, data: string): Promise<void> {
    if (isTauri) {
      return enqueueSessionWrite(sessionId, async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            return await invoke('serial_write', { sessionId, data });
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (msg.includes('queue is full') && attempt < 4) {
              await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
      });
    }
  },

  async closeSerial(sessionId: string): Promise<void> {
    sessionWriteQueues.delete(sessionId);
    if (isTauri) {
      await invoke('serial_close', { sessionId }).catch(() => {});
      return;
    }
  },

  // ── Zero-knowledge Sync ──
  async syncStatus(): Promise<SyncStatusInfo> {
    if (isTauri) return invoke('sync_status');
    return { enabled: false, relayUrl: null, deviceId: 'demo', lastSync: null, cursor: 0, lastError: null, hasToken: false, skippedBlobs: 0 };
  },
  async syncConfigure(relayUrl: string | null, deviceToken?: string): Promise<void> {
    if (isTauri) return invoke('sync_configure', { relayUrl, deviceToken: deviceToken ?? null });
  },
  async syncNow(): Promise<SyncStatusInfo> {
    if (isTauri) return invoke('sync_now');
    throw new Error('Sync is only available in the desktop app');
  },

  // ── Zero-Knowledge Team Sharing ──
  async exportTeamVault(vaultId: string, passphrase: string): Promise<EncryptedTeamVaultBundle> {
    if (isTauri) return invoke('team_vault_export', { vaultId, passphrase });
    const st = need();
    const v = (st.vaults ?? []).find((x: Vault) => x.id === vaultId) ?? { id: vaultId, name: 'Team Vault', kind: 'team', createdAt: Date.now() };
    return {
      version: 1,
      format: 'nexus-team-vault',
      vaultName: v.name,
      salt: '00112233445566778899aabbccddeeff',
      nonce: '00112233445566778899aabbccddeeff0011223344556677',
      ciphertext: btoa(JSON.stringify({ vault: v, hosts: st.hosts.filter((h: Host) => h.vaultId === vaultId) })),
    };
  },

  async importTeamVault(bundle: EncryptedTeamVaultBundle, passphrase: string): Promise<string> {
    if (isTauri) return invoke('team_vault_import', { bundle, passphrase });
    return bundle.vaultName;
  },

  // ── Direct Device Pairing & LAN Sync ──
  async pairingStartHost(): Promise<PairingHostInfo> {
    if (isTauri) return invoke('pairing_start_host');
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    return {
      pin,
      ip: '192.168.1.100',
      port: 48291,
      deviceName: 'Nexus Web Sandbox',
      qrPayload: `nxpair://192.168.1.100:48291?pin=${pin}&pk=demo&name=Nexus%20Sandbox`,
    };
  },

  async pairingStopHost(expectedPin?: string): Promise<void> {
    if (isTauri) return invoke('pairing_stop_host', { expectedPin: expectedPin ?? null });
  },

  async pairingJoinClient(
    targetHost: string,
    port: number,
    pin: string,
    serverPublicKey: string,
    deviceName?: string
  ): Promise<PairingJoinResult> {
    if (isTauri) return invoke('pairing_join_client', { targetHost, port, pin, serverPublicKey, deviceName: deviceName ?? null });
    return {
      success: true,
      serverDeviceName: 'Simulated Desktop',
      vaultsCount: 1,
      hostsCount: 4,
      keysCount: 2,
      snippetsCount: 6,
      syncReady: false,
    };
  },

  async pairingListDevices(): Promise<PairedDevice[]> {
    if (isTauri) return invoke('pairing_list_devices');
    const stored = localStorage.getItem('nx.paired.devices');
    return stored ? JSON.parse(stored) : [
      { id: 'dev-1', deviceName: 'MacBook Pro 16"', deviceType: 'laptop', ipAddress: '192.168.1.45', pairedAt: Date.now() - 86400000 * 3, lastSync: Date.now() - 3600000, deviceId: 'dev-1', revokedAt: null },
    ];
  },

  async pairingRevokeDevice(id: string): Promise<void> {
    if (isTauri) return invoke('pairing_revoke_device', { id });
    const list = await this.pairingListDevices();
    localStorage.setItem('nx.paired.devices', JSON.stringify(list.map((d) => (d.id === id ? { ...d, revokedAt: Math.floor(Date.now() / 1000) } : d))));
  },

  async pairingAllowDevice(id: string): Promise<void> {
    if (isTauri) return invoke('pairing_allow_device', { id });
    const list = await this.pairingListDevices();
    localStorage.setItem('nx.paired.devices', JSON.stringify(list.map((d) => (d.id === id ? { ...d, revokedAt: null } : d))));
  },

  async pairingGetLocalInfo(): Promise<LocalDeviceInfo> {
    if (isTauri) return invoke('pairing_get_local_info');
    return {
      deviceName: 'Local Workstation',
      os: 'linux',
      ip: '192.168.1.105',
    };
  },

  // ── AI Provider Configuration & Key Pooling ──
  async listAiConfigs(): Promise<AiProviderConfig[]> {
    if (isTauri) return invoke('ai_configs_list');
    const s = need();
    return Object.values(s.aiConfigs || {});
  },

  async saveAiConfig(config: AiProviderConfig): Promise<void> {
    if (isTauri) return invoke('ai_config_save', { config });
    const s = need();
    if (!s.aiConfigs) s.aiConfigs = {};
    s.aiConfigs[config.providerId] = { ...config, updatedAt: Math.floor(Date.now() / 1000) };
    await persistDemo();
  },

  async getActiveAiProvider(): Promise<string | null> {
    if (isTauri) return invoke('ai_active_provider_get');
    return need().activeAiProvider ?? 'ollama';
  },

  async setActiveAiProvider(providerId: string): Promise<void> {
    if (isTauri) return invoke('ai_active_provider_set', { providerId });
    const s = need();
    s.activeAiProvider = providerId;
    await persistDemo();
  },

  // ── Secret-safe AI key / proxy list editing ──
  // In Tauri the vault owns the real values and the UI only ever holds masked copies, so lists
  // are edited through dedicated backend commands. (Demo mode keeps plain values in its sandbox.)
  async addAiKeys(config: AiProviderConfig, keys: string[]): Promise<AiProviderConfig> {
    if (isTauri) return invoke('ai_keys_add', { config, keys });
    return demoEditAiList(config, 'apiKeys', (l) => Array.from(new Set([...l, ...keys.map((k) => k.trim()).filter(Boolean)])));
  },
  async removeAiKey(providerId: string, index: number): Promise<AiProviderConfig> {
    if (isTauri) return invoke('ai_key_remove', { providerId, index });
    return demoEditAiList({ providerId } as AiProviderConfig, 'apiKeys', (l) => l.filter((_, i) => i !== index));
  },
  async clearAiKeys(providerId: string): Promise<AiProviderConfig> {
    if (isTauri) return invoke('ai_keys_clear', { providerId });
    return demoEditAiList({ providerId } as AiProviderConfig, 'apiKeys', () => []);
  },
  async addAiProxies(config: AiProviderConfig, proxies: string[]): Promise<AiProviderConfig> {
    if (isTauri) return invoke('ai_proxies_add', { config, proxies });
    return demoEditAiList(config, 'proxyUrls', (l) => Array.from(new Set([...l, ...proxies.map((p) => p.trim()).filter(Boolean)])));
  },
  async removeAiProxy(providerId: string, index: number): Promise<AiProviderConfig> {
    if (isTauri) return invoke('ai_proxy_remove', { providerId, index });
    return demoEditAiList({ providerId } as AiProviderConfig, 'proxyUrls', (l) => l.filter((_, i) => i !== index));
  },
  async clearAiProxies(providerId: string): Promise<AiProviderConfig> {
    if (isTauri) return invoke('ai_proxies_clear', { providerId });
    return demoEditAiList({ providerId } as AiProviderConfig, 'proxyUrls', () => []);
  },

  // ── AI Proxy & Streaming Bridge ──
  async streamAiProxy(
    request: AiProxyRequest,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    events?: AiStreamEvents
  ): Promise<void> {
    if (isTauri) {
      if (signal?.aborted) return;
      const streamId = uid();
      const channel = new Channel<AiStreamMsg>();
      channel.onmessage = (msg) => {
        if (msg.type === 'data') onChunk(msg.text);
        else if (msg.type === 'meta') events?.onMeta?.(msg.keyMask, msg.proxyMask);
        else if (msg.type === 'failover') events?.onFailover?.(msg.reason, msg.next);
      };
      // Stop button => actually cancel the Rust-side HTTP stream (not just ignore its chunks).
      const onAbort = () => {
        invoke('ai_stream_cancel', { streamId }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await invoke('ai_stream_proxy', { request: { ...request, streamId }, channel });
        return;
      } catch (err: unknown) {
        throw new Error(typeof err === 'string' ? err : (err as Error)?.message || String(err));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    const r = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    });
    if (!r.ok || !r.body) {
      const err = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${err}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk(dec.decode(value, { stream: true }));
    }
  },

  async fetchAiProxy(request: AiProxyRequest): Promise<{ status: number; body: string }> {
    if (isTauri) {
      try {
        return await invoke('ai_fetch_proxy', { request });
      } catch (err: unknown) {
        throw new Error(typeof err === 'string' ? err : (err as Error)?.message || String(err));
      }
    }
    const r = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return {
      status: r.status,
      body: await r.text().catch(() => ''),
    };
  },

  async startAiSshTunnel(hostId: string): Promise<number> {
    if (isTauri) {
      try {
        return await invoke<number>('ai_tunnel_start', { hostId });
      } catch (err: unknown) {
        throw new Error(typeof err === 'string' ? err : (err as Error)?.message || String(err));
      }
    }
    return 10885;
  },

  async stopAiSshTunnel(hostId: string): Promise<boolean> {
    if (isTauri) {
      try {
        return await invoke<boolean>('ai_tunnel_stop', { hostId });
      } catch (err: unknown) {
        throw new Error(typeof err === 'string' ? err : (err as Error)?.message || String(err));
      }
    }
    return true;
  },

  async detectOpencode(): Promise<{ installed: boolean; binaryPath?: string; models: string[] }> {
    if (isTauri) {
      try {
        return await invoke<{ installed: boolean; binaryPath?: string; models: string[] }>('opencode_detect');
      } catch (err: unknown) {
        console.warn('detectOpencode error:', err);
        return { installed: false, models: [] };
      }
    }
    return { installed: false, models: [] };
  },

  async detectOpencodeSession(
    sessionId?: string | null,
    hostId?: string | null,
    force = false
  ): Promise<OpencodeHostStatus> {
    if (isTauri) {
      try {
        return await invoke<OpencodeHostStatus>('opencode_detect_session', {
          sessionId: sessionId ?? null,
          hostId: hostId ?? null,
          force,
        });
      } catch (err: unknown) {
        console.warn('detectOpencodeSession error:', err);
        return {
          isRemote: false,
          installed: false,
        };
      }
    }
    return {
      isRemote: false,
      installed: true,
      binaryPath: '/usr/local/bin/opencode',
    };
  },

  async streamOpencode(
    options: {
      prompt: string;
      model: string;
      cwd?: string;
      streamId?: string;
      /** Opt-in `--auto` (auto-approve anything not explicitly denied). Default false. */
      autonomous?: boolean;
      sessionId?: string | null;
      hostId?: string | null;
    },
    onToken: (text: string) => void,
    signal?: AbortSignal,
    events?: AiStreamEvents
  ): Promise<void> {
    if (isTauri) {
      if (signal?.aborted) return;
      const streamId = options.streamId || uid();
      const channel = new Channel<AiStreamMsg>();
      channel.onmessage = (msg) => {
        if (msg.type === 'data') onToken(msg.text);
        else if (msg.type === 'meta') events?.onMeta?.(msg.keyMask, msg.proxyMask);
        else if (msg.type === 'failover') events?.onFailover?.(msg.reason, msg.next);
      };
      const onAbort = () => {
        invoke('opencode_stream_cancel', { streamId }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await invoke('opencode_stream', {
          prompt: options.prompt,
          model: options.model,
          cwd: options.cwd ?? null,
          streamId,
          autonomous: options.autonomous === true,
          sessionId: options.sessionId ?? null,
          hostId: options.hostId ?? null,
          channel,
        });
        return;
      } catch (err: unknown) {
        throw new Error(typeof err === 'string' ? err : (err as Error)?.message || String(err));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw new Error('OpenCode streaming is only supported in the desktop app.');
  },

  // ── Command History ──
  async addCommandHistory(item: { hostId?: string | null; hostLabel: string; command: string; cwd?: string | null }): Promise<CommandHistoryItem> {
    if (isTauri) {
      return invoke('command_history_add', {
        hostId: item.hostId ?? null,
        hostLabel: item.hostLabel,
        command: item.command,
        cwd: item.cwd ?? null,
      });
    }
    const memItem: CommandHistoryItem = {
      id: uid(),
      hostId: item.hostId,
      hostLabel: item.hostLabel,
      command: item.command,
      cwd: item.cwd,
      executedAt: Date.now(),
      starred: false,
    };
    try {
      const list = JSON.parse(localStorage.getItem('nx.cmd_history') || '[]');
      list.unshift(memItem);
      localStorage.setItem('nx.cmd_history', JSON.stringify(list.slice(0, 300)));
    } catch {}
    return memItem;
  },

  async listCommandHistory(limit = 200, search?: string): Promise<CommandHistoryItem[]> {
    if (isTauri) {
      return invoke('command_history_list', { limit, search: search ?? null });
    }
    try {
      let list: CommandHistoryItem[] = JSON.parse(localStorage.getItem('nx.cmd_history') || '[]');
      if (search) {
        const q = search.toLowerCase();
        list = list.filter((i) => i.command.toLowerCase().includes(q) || i.hostLabel.toLowerCase().includes(q));
      }
      return list.slice(0, limit);
    } catch {
      return [];
    }
  },

  async toggleStarCommandHistory(id: string): Promise<boolean> {
    if (isTauri) return invoke('command_history_toggle_star', { id });
    try {
      const list: CommandHistoryItem[] = JSON.parse(localStorage.getItem('nx.cmd_history') || '[]');
      const item = list.find((i) => i.id === id);
      if (item) {
        item.starred = !item.starred;
        localStorage.setItem('nx.cmd_history', JSON.stringify(list));
        return item.starred;
      }
    } catch {}
    return false;
  },

  async deleteCommandHistory(id: string): Promise<void> {
    if (isTauri) return invoke('command_history_delete', { id });
    try {
      let list: CommandHistoryItem[] = JSON.parse(localStorage.getItem('nx.cmd_history') || '[]');
      list = list.filter((i) => i.id !== id);
      localStorage.setItem('nx.cmd_history', JSON.stringify(list));
    } catch {}
  },

  async clearCommandHistory(): Promise<void> {
    if (isTauri) return invoke('command_history_clear');
    try {
      let list: CommandHistoryItem[] = JSON.parse(localStorage.getItem('nx.cmd_history') || '[]');
      list = list.filter((i) => i.starred);
      localStorage.setItem('nx.cmd_history', JSON.stringify(list));
    } catch {}
  },

  // ── Clipboard History ──
  async addClipboardHistory(content: string, source?: string): Promise<ClipboardItem> {
    if (isTauri) {
      return invoke('clipboard_history_add', { content, source: source ?? null });
    }
    const memItem: ClipboardItem = {
      id: uid(),
      content,
      charCount: content.length,
      lineCount: content.split('\n').length,
      source: source ?? null,
      copiedAt: Date.now(),
      pinned: false,
    };
    try {
      let list: ClipboardItem[] = JSON.parse(localStorage.getItem('nx.clip_history') || '[]');
      list = list.filter((c) => c.content !== content);
      list.unshift(memItem);
      localStorage.setItem('nx.clip_history', JSON.stringify(list.slice(0, 100)));
    } catch {}
    return memItem;
  },

  async listClipboardHistory(limit = 100, search?: string): Promise<ClipboardItem[]> {
    if (isTauri) {
      return invoke('clipboard_history_list', { limit, search: search ?? null });
    }
    try {
      let list: ClipboardItem[] = JSON.parse(localStorage.getItem('nx.clip_history') || '[]');
      if (search) {
        const q = search.toLowerCase();
        list = list.filter((c) => c.content.toLowerCase().includes(q));
      }
      return list.slice(0, limit);
    } catch {
      return [];
    }
  },

  async togglePinClipboard(id: string): Promise<boolean> {
    if (isTauri) return invoke('clipboard_history_toggle_pin', { id });
    try {
      const list: ClipboardItem[] = JSON.parse(localStorage.getItem('nx.clip_history') || '[]');
      const item = list.find((i) => i.id === id);
      if (item) {
        item.pinned = !item.pinned;
        localStorage.setItem('nx.clip_history', JSON.stringify(list));
        return item.pinned;
      }
    } catch {}
    return false;
  },

  async deleteClipboardHistory(id: string): Promise<void> {
    if (isTauri) return invoke('clipboard_history_delete', { id });
    try {
      let list: ClipboardItem[] = JSON.parse(localStorage.getItem('nx.clip_history') || '[]');
      list = list.filter((i) => i.id !== id);
      localStorage.setItem('nx.clip_history', JSON.stringify(list));
    } catch {}
  },

  async clearClipboardHistory(): Promise<void> {
    if (isTauri) return invoke('clipboard_history_clear');
    try {
      let list: ClipboardItem[] = JSON.parse(localStorage.getItem('nx.clip_history') || '[]');
      list = list.filter((i) => i.pinned);
      localStorage.setItem('nx.clip_history', JSON.stringify(list));
    } catch {}
  },

  // ── Native & Browser System Clipboard Read/Write ──
  async readClipboard(): Promise<string> {
    if (isTauri) {
      try {
        const text = await tauriReadText();
        if (typeof text === 'string') return text;
      } catch (err) {
        console.warn('Native clipboard read failed, falling back:', err);
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        return await navigator.clipboard.readText();
      } catch {
        /* fallback failed */
      }
    }
    return '';
  },

  async writeClipboard(content: string): Promise<void> {
    if (isTauri) {
      try {
        await tauriWriteText(content);
        return;
      } catch (err) {
        console.warn('Native clipboard write failed, falling back:', err);
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        /* fallback failed */
      }
    }
  },
};
