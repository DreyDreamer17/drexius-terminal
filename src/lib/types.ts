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

export interface PairedDevice {
  id: string;
  deviceName: string;
  deviceType: string;
  ipAddress?: string | null;
  publicKey?: string | null;
  pairedAt: number;
  lastSync: number;
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

export interface GeneratedKeyPair {
  algorithm: string;
  privateKey: string;
  publicKey: string;
  fingerprint: string;
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

export interface Pane {
  id: string;
  hostId: string;
  isLocal?: boolean;
  resume?: boolean;
  customShell?: string;
}

export type Layout = 'single' | 'vertical' | 'horizontal' | 'grid';

export interface Tab {
  id: string;
  title: string;
  color?: string | null;
  panes: Pane[];
  layout: Layout;
  activePaneId: string;
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
