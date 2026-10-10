export type AuthMethod = 'password' | 'key' | 'agent';

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
}

export interface KeychainInput {
  id: string;
  label: string;
  username?: string | null;
  authMethod: AuthMethod;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
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
}

export interface ActiveTunnelInfo {
  id: string;
  running: boolean;
  bytesUp: number;
  bytesDown: number;
  error?: string | null;
}
