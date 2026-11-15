import type { Dispatch, SetStateAction } from 'react';
import { bridge } from '../lib/bridge';
import type { ShortcutBinding, UiPreferences } from '../lib/settings';
import type { DrexiusTheme } from '../lib/themes';
import type { CloudInstance, Host, HostSecret, Tab, Vault } from '../lib/types';
import { AUTO_LOCK_STORAGE_KEY, type WorkspacePanelKind } from '../lib/workspaceState';
import { safeUid } from '../utils/uuid';
import { CloudSyncModal } from './CloudSyncModal';
import { DevicePairingModal } from './DevicePairingModal';
import { DockerModal } from './DockerModal';
import { HostModal } from './HostModal';
import { NetbirdModal } from './NetbirdModal';
import { SerialModal } from './SerialModal';
import { SettingsModal, type SettingsTab } from './SettingsModal';
import { SshConfigModal } from './SshConfigModal';
import { SyncModal } from './SyncModal';
import { TailscaleModal } from './TailscaleModal';
import { TeamShareModal } from './TeamShareModal';

const uid = safeUid;

export interface WorkspaceModalsProps {
  modal: { host: Host | null } | null;
  setModal: Dispatch<SetStateAction<{ host: Host | null } | null>>;
  vaults: Vault[];
  hosts: Host[];
  activeVaultId: string | 'all';
  theme: DrexiusTheme;
  themeId: string;
  setThemeId: Dispatch<SetStateAction<string>>;
  fontSize: number;
  handleGlobalFontSizeChange: (nextOrUpdater: number | ((prev: number) => number)) => void;
  lineHeight: number;
  setLineHeight: Dispatch<SetStateAction<number>>;
  zen: boolean;
  setZen: Dispatch<SetStateAction<boolean>>;
  showRail: boolean;
  setShowRail: Dispatch<SetStateAction<boolean>>;
  showStatusBar: boolean;
  setShowStatusBar: Dispatch<SetStateAction<boolean>>;
  autoLockMinutes: number;
  setAutoLockMinutes: Dispatch<SetStateAction<number>>;
  uiPrefs: UiPreferences;
  handleUpdateUiPrefs: (next: UiPreferences) => void;
  shortcuts: Record<string, ShortcutBinding>;
  handleUpdateShortcuts: (next: Record<string, ShortcutBinding>) => void;
  showSshConfig: boolean;
  setShowSshConfig: Dispatch<SetStateAction<boolean>>;
  showTailscale: boolean;
  setShowTailscale: Dispatch<SetStateAction<boolean>>;
  showNetbird: boolean;
  setShowNetbird: Dispatch<SetStateAction<boolean>>;
  showCloudSync: boolean;
  setShowCloudSync: Dispatch<SetStateAction<boolean>>;
  showDockerModal: boolean;
  setShowDockerModal: Dispatch<SetStateAction<boolean>>;
  dockerHostId: string | null;
  terminalContext: Tab | undefined | null;
  activePaneId: string | null;
  shareModal: { initialTab?: 'share' | 'import' } | null;
  setShareModal: Dispatch<SetStateAction<{ initialTab?: 'share' | 'import' } | null>>;
  showSerial: boolean;
  setShowSerial: Dispatch<SetStateAction<boolean>>;
  showPairing: { initialTab?: 'share' | 'join' | 'devices' } | null;
  setShowPairing: Dispatch<SetStateAction<{ initialTab?: 'share' | 'join' | 'devices' } | null>>;
  showSync: boolean;
  setShowSync: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  settingsTab: SettingsTab;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab>>;
  setReturnToSettingsTab: Dispatch<SetStateAction<SettingsTab | null>>;
  setPanel: Dispatch<SetStateAction<WorkspacePanelKind | null>>;
  storageGranted: boolean | null;
  setStorageGranted: Dispatch<SetStateAction<boolean | null>>;
  isAndroid: boolean;
  saveHost: (h: Host, s?: HostSecret, alreadySaved?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  openHost: (h: Host) => Promise<void> | void;
  openTerminalWithCommand: (targetHost: Host, command: string, title?: string) => void;
  handleConnectSerial: (opts: { portName: string; baudRate: number; dataBits: number; stopBits: number; parity: string; flowControl: string }) => void;
  mergeCloudStatuses: (instances: CloudInstance[]) => void;
  openFromSettings: (action: () => void, tab: SettingsTab) => void;
  handleReturnToSettings: () => void;
  lock: () => Promise<void>;
  toast: (msg: string) => void;
}

export function WorkspaceModals({
  modal,
  setModal,
  vaults,
  hosts,
  activeVaultId,
  theme,
  themeId,
  setThemeId,
  fontSize,
  handleGlobalFontSizeChange,
  lineHeight,
  setLineHeight,
  zen,
  setZen,
  showRail,
  setShowRail,
  showStatusBar,
  setShowStatusBar,
  autoLockMinutes,
  setAutoLockMinutes,
  uiPrefs,
  handleUpdateUiPrefs,
  shortcuts,
  handleUpdateShortcuts,
  showSshConfig,
  setShowSshConfig,
  showTailscale,
  setShowTailscale,
  showNetbird,
  setShowNetbird,
  showCloudSync,
  setShowCloudSync,
  showDockerModal,
  setShowDockerModal,
  dockerHostId,
  terminalContext,
  activePaneId,
  shareModal,
  setShareModal,
  showSerial,
  setShowSerial,
  showPairing,
  setShowPairing,
  showSync,
  setShowSync,
  showSettings,
  setShowSettings,
  settingsTab,
  setSettingsTab,
  setReturnToSettingsTab,
  setPanel,
  storageGranted,
  setStorageGranted,
  isAndroid,
  saveHost,
  refresh,
  openHost,
  openTerminalWithCommand,
  handleConnectSerial,
  mergeCloudStatuses,
  openFromSettings,
  handleReturnToSettings,
  lock,
  toast,
}: WorkspaceModalsProps) {
  return (
    <>
      {modal && (
        <HostModal
          host={modal.host}
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => setModal(null)}
          onSave={saveHost}
          theme={theme}
        />
      )}
      {showSshConfig && (
        <SshConfigModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => setShowSshConfig(false)}
          onSuccess={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showTailscale && (
        <TailscaleModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => {
            setShowTailscale(false);
            handleReturnToSettings();
          }}
          onSuccess={refresh}
          onDirectConnect={(h) => {
            setReturnToSettingsTab(null);
            const tempHost: Host = {
              id: uid(),
              label: h.label || 'Tailscale Host',
              hostname: h.hostname || '',
              port: h.port || 22,
              username: h.username || 'root',
              authMethod: h.authMethod || 'key',
              group: 'Tailscale',
              tags: ['tailscale'],
              hasSecret: false,
              os: h.os || null,
            };
            void openHost(tempHost);
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showNetbird && (
        <NetbirdModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => {
            setShowNetbird(false);
            handleReturnToSettings();
          }}
          onSuccess={refresh}
          onDirectConnect={(h) => {
            setReturnToSettingsTab(null);
            const tempHost: Host = {
              id: uid(),
              label: h.label || 'NetBird Peer',
              hostname: h.hostname || '',
              port: h.port || 22,
              username: h.username || 'root',
              authMethod: h.authMethod || 'key',
              group: 'NetBird',
              tags: h.tags || ['netbird'],
              hasSecret: false,
              os: h.os || null,
            };
            void openHost(tempHost);
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showCloudSync && (
        <CloudSyncModal
          vaults={vaults}
          defaultVaultId={activeVaultId}
          onClose={() => {
            setShowCloudSync(false);
            handleReturnToSettings();
          }}
          onSuccess={(liveInstances) => {
            if (liveInstances?.length) mergeCloudStatuses(liveInstances);
            refresh();
          }}
          onDirectConnect={(h) => {
            setReturnToSettingsTab(null);
            const tempHost: Host = {
              id: uid(),
              label: h.label || 'Cloud Instance',
              hostname: h.hostname || '',
              port: h.port || 22,
              username: h.username || 'root',
              authMethod: h.authMethod || 'key',
              group: h.group || 'Cloud',
              tags: h.tags || ['cloud'],
              hasSecret: false,
              os: h.os || null,
            };
            void openHost(tempHost);
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showDockerModal && (
        <DockerModal
          hosts={hosts}
          activeHostId={
            dockerHostId ||
            (terminalContext?.panes.find((p) => p.id === activePaneId)?.isLocal
              ? '__local__'
              : terminalContext?.panes.find((p) => p.id === activePaneId)?.hostId)
          }
          onOpenTerminalWithCommand={(cmd, hostId) => {
            setReturnToSettingsTab(null);
            openTerminalWithCommand(cmd, hostId);
          }}
          onClose={() => {
            setShowDockerModal(false);
            handleReturnToSettings();
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {shareModal && (
        <TeamShareModal
          vaults={vaults}
          hosts={hosts}
          activeVaultId={activeVaultId}
          initialTab={shareModal.initialTab}
          onClose={() => setShareModal(null)}
          onRefresh={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showSerial && (
        <SerialModal theme={theme} onClose={() => setShowSerial(false)} onConnect={handleConnectSerial} />
      )}
      {showPairing && (
        <DevicePairingModal
          initialTab={showPairing.initialTab}
          onClose={() => {
            setShowPairing(null);
            handleReturnToSettings();
          }}
          onRefresh={refresh}
          toast={toast}
          theme={theme}
        />
      )}
      {showSync && (
        <SyncModal
          onClose={() => {
            setShowSync(false);
            handleReturnToSettings();
          }}
          onOpenPairing={() => {
            setShowSync(false);
            setShowPairing({ initialTab: isAndroid ? 'join' : 'share' });
          }}
          toast={toast}
          theme={theme}
        />
      )}
      {showSettings && (
        <SettingsModal
          initialTab={settingsTab}
          onTabChange={setSettingsTab}
          onClose={() => {
            setShowSettings(false);
            setReturnToSettingsTab(null);
          }}
          theme={theme}
          themeId={themeId}
          onThemeSelect={setThemeId}
          fontSize={fontSize}
          onFontSizeChange={handleGlobalFontSizeChange}
          lineHeight={lineHeight}
          onLineHeightChange={setLineHeight}
          zen={zen}
          onZenChange={setZen}
          showRail={showRail}
          onShowRailChange={setShowRail}
          showStatusBar={showStatusBar}
          onShowStatusBarChange={setShowStatusBar}
          autoLockMinutes={autoLockMinutes}
          onAutoLockChange={(m) => {
            setAutoLockMinutes(m);
            try {
              localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(m));
            } catch {}
          }}
          uiPrefs={uiPrefs}
          onUiPrefsChange={handleUpdateUiPrefs}
          shortcuts={shortcuts}
          onShortcutsChange={handleUpdateShortcuts}
          onOpenPairing={(fromTab) => openFromSettings(() => setShowPairing({ initialTab: 'share' }), fromTab ?? 'sync')}
          onOpenSync={(fromTab) => openFromSettings(() => setShowSync(true), fromTab ?? 'sync')}
          onOpenTailscale={(fromTab) => openFromSettings(() => setShowTailscale(true), fromTab ?? 'sync')}
          onOpenNetbird={(fromTab) => openFromSettings(() => setShowNetbird(true), fromTab ?? 'sync')}
          onOpenCloudSync={(fromTab) => openFromSettings(() => setShowCloudSync(true), fromTab ?? 'sync')}
          onOpenDocker={(fromTab) => openFromSettings(() => setShowDockerModal(true), fromTab ?? 'sync')}
          onOpenKeychain={(fromTab) => openFromSettings(() => setPanel('keychain'), fromTab ?? 'security')}
          onOpenTunnels={(fromTab) => openFromSettings(() => setPanel('tunnels'), fromTab ?? 'sync')}
          onOpenLogs={(fromTab) =>
            openFromSettings(() => setPanel('logs'), fromTab ?? (settingsTab === 'terminal' ? 'terminal' : 'security'))
          }
          onOpenKnownHosts={(fromTab) => openFromSettings(() => setPanel('known_hosts'), fromTab ?? 'security')}
          onLockVault={lock}
          storageGranted={storageGranted}
          onRequestStoragePermission={async () => {
            try {
              await bridge.requestStoragePermission();
              const ok = await bridge.checkStoragePermission();
              setStorageGranted(ok);
            } catch {}
          }}
          toast={toast}
        />
      )}
    </>
  );
}
