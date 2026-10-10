/**
 * bridge.ts — the ONLY place the UI talks to a backend.
 *
 *  • Desktop (Tauri):  invoke() → Rust commands in src-tauri/src/*.rs,
 *                      PTY bytes streamed over tauri::ipc::Channel.
 *  • Browser preview:  sandbox backend (demoShell.ts) with a vault encrypted
 *                      via WebCrypto (PBKDF2-SHA256 310k → AES-256-GCM).
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { DemoShell, homeOf, vfs } from './demoShell';
import type {
  ActiveTunnelInfo,
  BridgeError,
  ConnectionLog,
  DetectedLocalKey,
  FileEntry,
  Host,
  HostSecret,
  KeychainInput,
  KeychainItem,
  KnownHost,
  SessionEvent,
  Snapshot,
  Snippet,
  TunnelConfig,
} from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function b64ToBytes(b64: string): Uint8Array {
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
    { id: 'kc-1', label: 'Production Ops Key', username: 'ubuntu', authMethod: 'key', hasSecret: true, updatedAt: Date.now() - 86400000 * 2 },
    { id: 'kc-2', label: 'DB Root Password', username: 'postgres', authMethod: 'password', hasSecret: true, updatedAt: Date.now() - 86400000 * 7 },
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
};

let demoKey: CryptoKey | null = null;
let demo: DemoState | null = null;

async function deriveDemoKey(password: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 310_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function persistDemo() {
  if (!demo || !demoKey) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, demoKey, new TextEncoder().encode(JSON.stringify(demo))));
  localStorage.setItem('nx.vault', JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(ct) }));
}

function need(): DemoState {
  if (!demo) throw { kind: 'vaultLocked', message: 'vault is locked' };
  return demo;
}

async function fingerprintFor(h: Host) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${h.hostname}:${h.port}`)));
  return toB64(d).replace(/=+$/, '');
}

interface DemoSession { shell: DemoShell; host: Host; emit: (e: SessionEvent) => void; }
const demoSessions = new Map<string, DemoSession>();

// ─────────────────────────────── API ───────────────────────────────────
export const bridge = {
  // ── Vault ──
  async vaultStatus(): Promise<{ initialized: boolean; unlocked: boolean }> {
    if (isTauri) return invoke('vault_status');
    return { initialized: !!localStorage.getItem('nx.vault'), unlocked: !!demo };
  },

  async unlock(masterPassword: string): Promise<void> {
    if (isTauri) return invoke('vault_unlock', { masterPassword });
    let saltB64 = localStorage.getItem('nx.salt');
    if (!saltB64) { saltB64 = toB64(crypto.getRandomValues(new Uint8Array(16))); localStorage.setItem('nx.salt', saltB64); }
    const key = await deriveDemoKey(masterPassword, fromB64(saltB64));
    const stored = localStorage.getItem('nx.vault');
    if (stored) {
      try {
        const { iv, ct } = JSON.parse(stored);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) as BufferSource }, key, fromB64(ct) as BufferSource);
        demo = JSON.parse(new TextDecoder().decode(pt));
      } catch {
        throw { kind: 'badMasterPassword', message: 'Invalid master password' };
      }
    } else {
      demo = structuredClone(SEED);
    }
    demoKey = key;
    await persistDemo();
  },

  async resetDemoVault() {
    localStorage.removeItem('nx.vault');
    localStorage.removeItem('nx.salt');
  },

  async lock(): Promise<void> {
    if (isTauri) return invoke('vault_lock');
    demo = null; demoKey = null;
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
    const next = { ...host, id, hasSecret: !!secret || host.hasSecret };
    const i = s.hosts.findIndex((h) => h.id === id);
    if (i >= 0) s.hosts[i] = next; else s.hosts.push(next);
    if (secret) s.secrets[id] = secret;
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
    if (isTauri) return invoke('ssh_write', { sessionId, data });
    demoSessions.get(sessionId)?.shell.input(data);
  },

  async resize(sessionId: string, cols: number, rows: number) {
    if (isTauri) return invoke('ssh_resize', { sessionId, cols, rows });
  },

  async disconnect(sessionId: string) {
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

  async importLocalSshKey(path: string, label?: string, passphrase?: string): Promise<string> {
    if (isTauri) return invoke('keychain_import_local_key', { path, label: label ?? null, passphrase: passphrase ?? null });
    return '';
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
    if (isTauri) return invoke('local_pty_write', { sessionId, data });
    demoSessions.get(sessionId)?.shell.input(data);
  },

  async resizeLocalPty(sessionId: string, cols: number, rows: number): Promise<void> {
    if (isTauri) return invoke('local_pty_resize', { sessionId, cols, rows });
  },

  async closeLocalPty(sessionId: string): Promise<void> {
    if (isTauri) {
      await invoke('local_pty_close', { sessionId }).catch(() => {});
      return;
    }
    demoSessions.delete(sessionId);
  },
};
