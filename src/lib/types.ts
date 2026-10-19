export type AuthMethod = 'password' | 'key' | 'agent';

export interface Vault {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  color?: string | null;
  description?: string | null;
  createdAt: number;
}

export interface SerialPortInfo {
  portName: string;
  description?: string | null;
}

export interface SerialOpenOptions {
  portName: string;
  baudRate: number;
  dataBits?: number;
  parity?: 'none' | 'odd' | 'even' | 'mark' | 'space';
  stopBits?: 1 | 2;
  flowControl?: 'none' | 'software' | 'hardware';
}

export interface PairedDevice {
  id: string;
  deviceName: string;
  deviceType: string;
  ipAddress?: string | null;
  publicKey?: string | null;
  pairedAt: number;
  lastSync: number;
  deviceId?: string;
  revokedAt?: number | null;
}

export interface PairingHostInfo {
  pin: string;
  ip: string;
  port: number;
  deviceName: string;
  qrPayload: string;
}

export interface PairingJoinResult {
  success: boolean;
  serverDeviceName: string;
  vaultsCount: number;
  hostsCount: number;
  keysCount: number;
  snippetsCount: number;
  syncReady: boolean;
}

export interface LocalDeviceInfo {
  deviceName: string;
  os: string;
  ip: string;
}

export interface EncryptedTeamVaultBundle {
  version: number;
  format: string;
  vaultName: string;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keychainId?: string | null;
  group?: string | null;
  tags: string[];
  color?: string | null;
  hasSecret: boolean;
  os?: string | null;
  jumpHostId?: string | null;
  vaultId?: string | null;
  startupCommand?: string | null;
}

export interface ParsedSshHost {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  identityFile?: string | null;
  proxyJump?: string | null;
  group?: string | null;
}

export interface TailscaleDevice {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  ipv6?: string | null;
  os?: string | null;
  online: boolean;
  lastSeen?: string | null;
  tags: string[];
  tailscaleSsh: boolean;
  isSelf?: boolean;
}

export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
  command: string;
}

/** Input for generating a key pair. There is deliberately no private-key
 *  field: `keychain_generate_and_save` generates *and* stores the key in Rust,
 *  so raw key material never crosses the IPC boundary. */
export interface KeygenRequest {
  label: string;
  username?: string | null;
  algorithm: 'ed25519' | 'rsa' | 'ecdsa';
  bits?: number | null;
  comment?: string | null;
  passphrase?: string | null;
  vaultId?: string | null;
}

/** What a generated key looks like from the UI side: metadata and the public
 *  half only. Use `readSecret` when the private key is genuinely needed. */
export interface GeneratedKeySaved {
  item: KeychainItem;
  publicKey: string;
  fingerprint: string;
  algorithm: string;
}

export interface HostSecret {
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  folder?: string | null;
  tags: string[];
  vaultId?: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified?: number | null;
  permissions?: number | null;
}

export interface Snapshot {
  hostId: string;
  sessionId?: string | null;
  cwd: string;
  lastCommand?: string | null;
  updatedAt: number;
}

export type SessionEvent =
  | { type: 'connected'; sessionId: string; fingerprint: string; banner?: string | null; os?: string | null }
  | { type: 'output'; data: Uint8Array | string }
  | { type: 'cwd'; path: string }
  | { type: 'disconnected'; reason: string; resumable: boolean };

export interface BridgeError {
  kind: string;
  message: string;
  fingerprint?: string | null;
}

export type PaneStatus = 'connecting' | 'connected' | 'disconnected' | 'hostkey' | 'error';

export type PaneKind = 'ssh' | 'local' | 'serial';

export interface Pane {
  id: string;
  hostId: string;
  /** Session kind. Defaults to 'local' when isLocal is true and no kind is set;
   *  'serial' connects through the native serial-port backend, not a PTY. */
  kind?: PaneKind;
  isLocal?: boolean;
  resume?: boolean;
  customShell?: string;
  /** Serial connection parameters — only valid when kind === 'serial'. */
  serialOptions?: SerialOpenOptions;
  /** Live backend session ID for reattaching across WebView/component remounts. */
  sessionId?: string | null;
  /** Startup command executed right after connection initializes. */
  startupCommand?: string;
}

export interface ActiveSshSession {
  sessionId: string;
  hostId: string;
  startedAt: number;
}

export type Layout = 'single' | 'vertical' | 'horizontal' | 'grid';

export type TabKind = 'terminal' | 'sftp';

export interface Tab {
  id: string;
  title: string;
  color?: string | null;
  kind?: TabKind;
  sftpHostId?: string | null;
  sftpSessionId?: string | null;
  panes: Pane[];
  layout: Layout;
  activePaneId: string;
}

export interface LocalDirResponse {
  currentPath: string;
  parentPath?: string | null;
  entries: FileEntry[];
}

export interface KeychainItem {
  id: string;
  label: string;
  username?: string | null;
  authMethod: AuthMethod;
  hasSecret: boolean;
  updatedAt: number;
  vaultId?: string | null;
}

export interface KeychainInput {
  id: string;
  label: string;
  username?: string | null;
  authMethod: AuthMethod;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  vaultId?: string | null;
}

export interface DetectedLocalKey {
  path: string;
  filename: string;
  keyType: string;
  hasPublic: boolean;
  comment?: string | null;
}

export interface ConnectionLog {
  id: string;
  hostId?: string | null;
  hostLabel: string;
  username: string;
  hostname: string;
  startedAt: number;
  endedAt?: number | null;
  duration?: number | null;
  status: string;
  saved: boolean;
}

export interface KnownHost {
  host: string;
  port: number;
  fingerprint: string;
  addedAt: number;
}

export type TunnelType = 'local' | 'remote' | 'dynamic';

export interface TunnelConfig {
  id: string;
  label: string;
  hostId: string;
  forwardType: TunnelType;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  updatedAt?: number;
  vaultId?: string | null;
}

export interface ActiveTunnelInfo {
  id: string;
  running: boolean;
  bytesUp: number;
  bytesDown: number;
  error?: string | null;
  /** For remote forwards, the port the SSH server actually bound (may differ from the
   *  configured port when the server allocates an ephemeral port, e.g. requested port 0). */
  boundPort?: number;
}

export type AiBalanceStrategy = 'round_robin' | 'p2c' | 'random';

export interface AiProviderConfig {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKeys: string[];
  selectedModel: string;
  modelsCache: string[];
  balanceStrategy: AiBalanceStrategy;
  enabled: boolean;
  updatedAt: number;
  useProxies?: boolean;
  proxyUrls?: string[];
  proxyStrategy?: AiBalanceStrategy;
  autoSshProxy?: boolean;
  autoSshHostId?: string;
}

export interface CommandHistoryItem {
  id: string;
  hostId?: string | null;
  hostLabel: string;
  command: string;
  cwd?: string | null;
  executedAt: number;
  starred: boolean;
}

export interface ClipboardItem {
  id: string;
  content: string;
  charCount: number;
  lineCount: number;
  source?: string | null;
  copiedAt: number;
  pinned: boolean;
}

export interface OpencodeHostStatus {
  isRemote: boolean;
  hostId?: string | null;
  hostLabel?: string | null;
  installed: boolean;
  binaryPath?: string | null;
}

export type CloudProviderId = 'hetzner' | 'digitalocean' | 'proxmox';

export interface CloudInstance {
  id: string;
  provider: CloudProviderId;
  name: string;
  ip: string;
  ipv6?: string | null;
  status: string;
  online: boolean;
  region?: string | null;
  instanceType?: string | null;
  os?: string | null;
  tags: string[];
}

export interface CloudCredentials {
  hetznerToken?: string | null;
  digitaloceanToken?: string | null;
  proxmoxUrl?: string | null;
  proxmoxToken?: string | null;
  proxmoxInsecure?: boolean;
}

