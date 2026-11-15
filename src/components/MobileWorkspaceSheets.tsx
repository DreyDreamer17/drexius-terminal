import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import {
  Activity,
  Boxes,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  Fingerprint,
  Folder,
  FolderLock,
  Globe2,
  KeyRound,
  Loader2,
  Lock,
  Minus,
  Network,
  Palette,
  Plus,
  QrCode,
  Rows2,
  Share2,
  ShieldCheck,
  Terminal as TerminalIcon,
  Timer,
  Type,
  X,
  Zap,
} from 'lucide-react';
import { bridge, isTauri } from '../lib/bridge';
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from '../lib/mobileTerminal';
import { registry } from '../lib/sessions';
import { POPULAR_TERMINAL_FONTS, type UiPreferences } from '../lib/settings';
import type { DrexiusTheme } from '../lib/themes';
import type { Host, Tab } from '../lib/types';
import {
  AUTO_LOCK_OPTIONS,
  AUTO_LOCK_STORAGE_KEY,
  type MobileSettingsPickerKind,
  type WorkspacePanelKind,
} from '../lib/workspaceState';
import { cn } from '../utils/cn';
import type { MobilePage } from './MobileNavigation';
import { MobileSheet } from './MobileSheet';
import { ThemeSwatch } from './WelcomeScreen';

export interface MobileSettingsSectionProps {
  theme: DrexiusTheme;
  lock: () => Promise<void>;
  setShowPairing: Dispatch<SetStateAction<{ initialTab?: 'share' | 'join' | 'devices' } | null>>;
  setShowTailscale: Dispatch<SetStateAction<boolean>>;
  setShowNetbird: Dispatch<SetStateAction<boolean>>;
  setShowCloudSync: Dispatch<SetStateAction<boolean>>;
  setShowSync: Dispatch<SetStateAction<boolean>>;
  setShowDockerModal: Dispatch<SetStateAction<boolean>>;
  setPanel: Dispatch<SetStateAction<WorkspacePanelKind | null>>;
  autoLockMinutes: number;
  setSettingsPicker: Dispatch<SetStateAction<MobileSettingsPickerKind | null>>;
  deviceLockEnabled: boolean;
  directUnlockEnabled: boolean;
  storageGranted: boolean | null;
  uiPrefs: UiPreferences;
  handleUpdateUiPrefs: (next: UiPreferences) => void;
  fontSize: number;
  setFontSize: Dispatch<SetStateAction<number>>;
  lineHeight: number;
  setLineHeight: Dispatch<SetStateAction<number>>;
  broadcast: boolean;
  setBroadcast: Dispatch<SetStateAction<boolean>>;
}

export function MobileSettingsSection({
  theme,
  lock,
  setShowPairing,
  setShowTailscale,
  setShowNetbird,
  setShowCloudSync,
  setShowSync,
  setShowDockerModal,
  setPanel,
  autoLockMinutes,
  setSettingsPicker,
  deviceLockEnabled,
  directUnlockEnabled,
  storageGranted,
  uiPrefs,
  handleUpdateUiPrefs,
  fontSize,
  setFontSize,
  lineHeight,
  setLineHeight,
  broadcast,
  setBroadcast,
}: MobileSettingsSectionProps) {
  return (
    <section
      className="absolute inset-0 overflow-y-auto p-4"
      aria-label="Settings"
      style={{ '--nx-accent': theme.accent } as CSSProperties}
    >
      <div
        className="relative mb-5 overflow-hidden rounded-2xl border p-4"
        style={{ borderColor: `${theme.accent}26`, background: `${theme.accent}0d` }}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-20"
          style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
        />
        <div className="relative flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={18} style={{ color: theme.accent }} /> Your workspace, secured
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          {isTauri ? 'SQLCipher encrypted vault' : 'Browser sandbox vault'} · credentials stay in your vault.
        </p>
        <button className="nx-settings-row mt-3" onClick={lock}>
          <Lock size={18} /> Lock vault now
        </button>
      </div>
      <h2 className="nx-section-label">Connections & security</h2>
      <div className="nx-settings-group">
        <button className="nx-settings-row" onClick={() => setShowPairing({ initialTab: 'share' })}>
          <QrCode size={18} /> LAN device pairing
        </button>
        <button className="nx-settings-row" onClick={() => setShowTailscale(true)}>
          <Network size={18} /> Tailscale sync & discovery
        </button>
        <button className="nx-settings-row" onClick={() => setShowNetbird(true)}>
          <Globe2 size={18} /> NetBird mesh discovery
        </button>
        <button className="nx-settings-row" onClick={() => setShowCloudSync(true)}>
          <Cloud size={18} /> Cloud Fleet Sync (Hetzner / DO / Proxmox)
        </button>
        <button className="nx-settings-row" onClick={() => setShowSync(true)}>
          <Cloud size={18} /> Encrypted relay sync
        </button>
        <button className="nx-settings-row" onClick={() => setShowDockerModal(true)}>
          <Boxes size={18} /> Docker containers
        </button>
        <button className="nx-settings-row" onClick={() => setPanel('keychain')}>
          <KeyRound size={18} /> Keychain
        </button>
        <button className="nx-settings-row" onClick={() => setPanel('tunnels')}>
          <Network size={18} /> Port forwarding & tunnels
        </button>
        <button className="nx-settings-row" onClick={() => setPanel('known_hosts')}>
          <ShieldCheck size={18} /> Known hosts
        </button>
        <button className="nx-settings-row" onClick={() => setPanel('logs')}>
          <Activity size={18} /> Logs
        </button>
        <button
          className="nx-settings-row justify-between"
          aria-haspopup="dialog"
          aria-label={`Auto-lock: ${autoLockMinutes ? `${autoLockMinutes} minutes` : 'Off'}`}
          onClick={() => setSettingsPicker('autolock')}
        >
          <span className="flex items-center gap-3">
            <Timer size={18} /> Auto-lock
          </span>
          <span className="nx-settings-value">
            {autoLockMinutes ? `${autoLockMinutes} min` : 'Off'}
            <ChevronRight size={16} />
          </span>
        </button>
        {isTauri && (
          <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('quickunlock')}>
            <span className="flex items-center gap-3">
              <Fingerprint size={18} /> Device Quick Unlock
            </span>
            <span className="nx-settings-value">
              {deviceLockEnabled ? 'Enabled' : 'Off'}
              <ChevronRight size={16} />
            </span>
          </button>
        )}
        {isTauri && (
          <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('directlaunch')}>
            <span className="flex items-center gap-3">
              <Zap size={18} /> Direct Launch
            </span>
            <span className="nx-settings-value">
              {directUnlockEnabled ? 'Enabled' : 'Off'}
              <ChevronRight size={16} />
            </span>
          </button>
        )}
        <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('recovery_key')}>
          <span className="flex items-center gap-3">
            <KeyRound size={18} /> Emergency Recovery Kit
          </span>
          <span className="nx-settings-value">
            View
            <ChevronRight size={16} />
          </span>
        </button>
        <button className="nx-settings-row justify-between" onClick={() => setSettingsPicker('storage_perms')}>
          <span className="flex items-center gap-3">
            <Folder size={18} /> Storage & Permissions
          </span>
          <span className="nx-settings-value">
            {storageGranted === true ? 'Granted' : storageGranted === false ? 'Action Needed' : 'Check'}
            <ChevronRight size={16} />
          </span>
        </button>
      </div>
      <h2 className="nx-section-label">Appearance</h2>
      <div className="nx-settings-group">
        <button
          className="nx-settings-row justify-between"
          aria-haspopup="dialog"
          aria-label={`Theme: ${theme.name}`}
          onClick={() => setSettingsPicker('theme')}
        >
          <span className="flex items-center gap-3">
            <Palette size={18} /> Theme
          </span>
          <span className="nx-settings-value">
            <ThemeSwatch t={theme} />
            {theme.name}
            <ChevronRight size={16} />
          </span>
        </button>
        <button
          className="nx-settings-row justify-between"
          aria-haspopup="dialog"
          aria-label={`Font: ${uiPrefs.fontFamily}`}
          onClick={() => setSettingsPicker('font')}
        >
          <span className="flex items-center gap-3">
            <Type size={18} /> Font family
          </span>
          <span className="nx-settings-value truncate max-w-[140px]">
            {uiPrefs.fontFamily === 'custom' ? uiPrefs.customFontFamily || 'Custom' : uiPrefs.fontFamily}
            <ChevronRight size={16} />
          </span>
        </button>
        <div className="nx-settings-row justify-between">
          <span className="flex items-center gap-3">
            <Type size={18} /> Font size
          </span>
          <span className="nx-stepper" role="group" aria-label="Terminal font size">
            <button
              type="button"
              aria-label="Smaller font"
              disabled={fontSize <= TERMINAL_FONT_MIN}
              onClick={() => setFontSize((f) => Math.max(TERMINAL_FONT_MIN, f - 1))}
            >
              <Minus size={16} />
            </button>
            <span aria-live="polite">
              {fontSize}
              <small>px</small>
            </span>
            <button
              type="button"
              aria-label="Larger font"
              disabled={fontSize >= TERMINAL_FONT_MAX}
              onClick={() => setFontSize((f) => Math.min(TERMINAL_FONT_MAX, f + 1))}
            >
              <Plus size={16} />
            </button>
          </span>
        </div>
        <div className="nx-settings-row justify-between">
          <span className="flex items-center gap-3">
            <Type size={18} /> Font weight
          </span>
          <div className="flex items-center gap-1">
            {(['300', '400', '500', '600', '700'] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => handleUpdateUiPrefs({ ...uiPrefs, fontWeight: w })}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono transition',
                  uiPrefs.fontWeight === w
                    ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-400/40'
                    : 'text-slate-400 hover:text-white bg-white/5'
                )}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        <div className="nx-settings-row justify-between">
          <span className="flex items-center gap-3">
            <Rows2 size={18} /> Letter spacing
          </span>
          <span className="nx-stepper" role="group" aria-label="Letter spacing">
            <button
              type="button"
              disabled={uiPrefs.letterSpacing <= -1}
              onClick={() => handleUpdateUiPrefs({ ...uiPrefs, letterSpacing: Math.max(-1, uiPrefs.letterSpacing - 1) })}
            >
              <Minus size={16} />
            </button>
            <span aria-live="polite">
              {uiPrefs.letterSpacing === 0
                ? '0'
                : `${uiPrefs.letterSpacing > 0 ? '+' : ''}${uiPrefs.letterSpacing}`}
              <small>px</small>
            </span>
            <button
              type="button"
              disabled={uiPrefs.letterSpacing >= 3}
              onClick={() => handleUpdateUiPrefs({ ...uiPrefs, letterSpacing: Math.min(3, uiPrefs.letterSpacing + 1) })}
            >
              <Plus size={16} />
            </button>
          </span>
        </div>
        <label className="nx-settings-row flex-wrap justify-between gap-y-1">
          <span className="flex items-center gap-3">
            <Rows2 size={18} /> Line height
          </span>
          <span className="nx-settings-value font-mono" style={{ color: theme.accent }}>
            {lineHeight.toFixed(2)}
          </span>
          <input
            aria-label="Terminal line height"
            className="nx-range"
            type="range"
            min="1"
            max="1.5"
            step="0.05"
            value={lineHeight}
            style={{ '--nx-fill': `${((lineHeight - 1) / 0.5) * 100}%` } as CSSProperties}
            onChange={(e) => setLineHeight(Number(e.target.value))}
          />
        </label>
      </div>
      <h2 className="nx-section-label">Terminal input & clipboard</h2>
      <label className="nx-settings-row rounded-xl border border-white/10">
        <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} /> Broadcast to all
        panes in this tab
      </label>
      {broadcast && <p className="mt-2 text-xs text-amber-300">Input also reaches hidden sessions in the same split tab.</p>}
      <label className="nx-settings-row rounded-xl border border-white/10">
        <input
          type="checkbox"
          checked={uiPrefs.copyOnSelect}
          onChange={(e) => handleUpdateUiPrefs({ ...uiPrefs, copyOnSelect: e.target.checked })}
        />
        <span>Copy on select</span>
      </label>
      <label className="nx-settings-row rounded-xl border border-white/10">
        <input
          type="checkbox"
          checked={uiPrefs.rightClickPaste}
          onChange={(e) => handleUpdateUiPrefs({ ...uiPrefs, rightClickPaste: e.target.checked })}
        />
        <span>Right click to paste</span>
      </label>
    </section>
  );
}

export interface MobileSettingsPickersProps {
  mobile: boolean;
  settingsPicker: MobileSettingsPickerKind | null;
  setSettingsPicker: Dispatch<SetStateAction<MobileSettingsPickerKind | null>>;
  theme: DrexiusTheme;
  allThemes: DrexiusTheme[];
  themeId: string;
  setThemeId: Dispatch<SetStateAction<string>>;
  autoLockMinutes: number;
  setAutoLockMinutes: Dispatch<SetStateAction<number>>;
  uiPrefs: UiPreferences;
  handleUpdateUiPrefs: (next: UiPreferences) => void;
  deviceLockEnabled: boolean;
  setDeviceLockEnabled: Dispatch<SetStateAction<boolean>>;
  quickUnlockPw: string;
  setQuickUnlockPw: Dispatch<SetStateAction<string>>;
  quickUnlockBusy: boolean;
  setQuickUnlockBusy: Dispatch<SetStateAction<boolean>>;
  quickUnlockErr: string | null;
  setQuickUnlockErr: Dispatch<SetStateAction<string | null>>;
  directUnlockEnabled: boolean;
  setDirectUnlockEnabled: Dispatch<SetStateAction<boolean>>;
  directLaunchPw: string;
  setDirectLaunchPw: Dispatch<SetStateAction<string>>;
  directLaunchBusy: boolean;
  setDirectLaunchBusy: Dispatch<SetStateAction<boolean>>;
  directLaunchErr: string | null;
  setDirectLaunchErr: Dispatch<SetStateAction<string | null>>;
  recoveryKey: string | null;
  setRecoveryKey: Dispatch<SetStateAction<string | null>>;
  copiedRecovery: boolean;
  setCopiedRecovery: Dispatch<SetStateAction<boolean>>;
  downloadedRecoveryPath: string | null;
  setDownloadedRecoveryPath: Dispatch<SetStateAction<string | null>>;
  regeneratingRecovery: boolean;
  setRegeneratingRecovery: Dispatch<SetStateAction<boolean>>;
  showRegenConfirm: boolean;
  setShowRegenConfirm: Dispatch<SetStateAction<boolean>>;
  storageGranted: boolean | null;
  setStorageGranted: Dispatch<SetStateAction<boolean | null>>;
  requestingPerm: boolean;
  setRequestingPerm: Dispatch<SetStateAction<boolean>>;
  toast: (msg: string) => void;
}

export function MobileSettingsPickers({
  mobile,
  settingsPicker,
  setSettingsPicker,
  theme,
  allThemes,
  themeId,
  setThemeId,
  autoLockMinutes,
  setAutoLockMinutes,
  uiPrefs,
  handleUpdateUiPrefs,
  deviceLockEnabled,
  setDeviceLockEnabled,
  quickUnlockPw,
  setQuickUnlockPw,
  quickUnlockBusy,
  setQuickUnlockBusy,
  quickUnlockErr,
  setQuickUnlockErr,
  directUnlockEnabled,
  setDirectUnlockEnabled,
  directLaunchPw,
  setDirectLaunchPw,
  directLaunchBusy,
  setDirectLaunchBusy,
  directLaunchErr,
  setDirectLaunchErr,
  recoveryKey,
  setRecoveryKey,
  copiedRecovery,
  setCopiedRecovery,
  downloadedRecoveryPath,
  setDownloadedRecoveryPath,
  regeneratingRecovery,
  setRegeneratingRecovery,
  showRegenConfirm,
  setShowRegenConfirm,
  storageGranted,
  setStorageGranted,
  requestingPerm,
  setRequestingPerm,
  toast,
}: MobileSettingsPickersProps) {
  if (!mobile || !settingsPicker) return null;

  return (
    <>
      {settingsPicker === 'autolock' && (
        <MobileSheet
          title="Auto-lock"
          kicker="Security"
          subtitle="Lock the vault after a period of inactivity"
          icon={Timer}
          theme={theme}
          onClose={() => setSettingsPicker(null)}
        >
          <div className="nx-settings-group" role="radiogroup" aria-label="Auto-lock timeout">
            {AUTO_LOCK_OPTIONS.map((n) => {
              const on = autoLockMinutes === n;
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="nx-settings-row nx-option-row justify-between"
                  onClick={() => {
                    setAutoLockMinutes(n);
                    localStorage.setItem(AUTO_LOCK_STORAGE_KEY, String(n));
                    setSettingsPicker(null);
                  }}
                >
                  <span>{n ? `${n} minutes` : 'Off'}</span>
                  {on && <Check size={18} style={{ color: theme.accent }} />}
                </button>
              );
            })}
          </div>
        </MobileSheet>
      )}
      {settingsPicker === 'theme' && (
        <MobileSheet
          title="Theme"
          kicker="Appearance"
          subtitle="Applies everywhere, instantly"
          icon={Palette}
          theme={theme}
          onClose={() => setSettingsPicker(null)}
        >
          <div className="nx-settings-group" role="radiogroup" aria-label="Terminal theme">
            {allThemes.map((t) => {
              const on = t.id === themeId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="nx-settings-row nx-option-row justify-between"
                  onClick={() => setThemeId(t.id)}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <ThemeSwatch t={t} large />
                    <span className="truncate">{t.name}</span>
                  </span>
                  {on && <Check size={18} style={{ color: t.accent }} />}
                </button>
              );
            })}
          </div>
        </MobileSheet>
      )}
      {settingsPicker === 'font' && (
        <MobileSheet
          title="Font Family"
          kicker="Appearance"
          subtitle="Select standard coding font or custom system font"
          icon={Type}
          theme={theme}
          onClose={() => setSettingsPicker(null)}
        >
          <div className="nx-settings-group" role="radiogroup" aria-label="Terminal font family">
            {POPULAR_TERMINAL_FONTS.map((f) => {
              const on = uiPrefs.fontFamily === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="nx-settings-row nx-option-row justify-between"
                  onClick={() => {
                    handleUpdateUiPrefs({ ...uiPrefs, fontFamily: f.id });
                    if (f.id !== 'custom') setSettingsPicker(null);
                  }}
                >
                  <div className="flex flex-col text-left py-0.5">
                    <span className="font-semibold text-white text-sm">{f.label}</span>
                    <span className="text-[11px] text-slate-400">{f.description}</span>
                  </div>
                  {on && <Check size={18} style={{ color: theme.accent }} />}
                </button>
              );
            })}
            {uiPrefs.fontFamily === 'custom' && (
              <div className="p-3 border-t border-white/10 bg-white/[0.02]">
                <label className="text-xs text-slate-300 font-medium block mb-1.5">Custom Font Name</label>
                <input
                  type="text"
                  placeholder="e.g. Comic Code, Iosevka, Victor Mono"
                  value={uiPrefs.customFontFamily}
                  onChange={(e) => handleUpdateUiPrefs({ ...uiPrefs, customFontFamily: e.target.value })}
                  className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>
            )}
          </div>
        </MobileSheet>
      )}
      {settingsPicker === 'quickunlock' && (
        <MobileSheet
          title="Device Quick Unlock"
          kicker="Security"
          subtitle="Unlock your vault with biometrics or screen lock"
          icon={Fingerprint}
          theme={theme}
          onClose={() => {
            setSettingsPicker(null);
            setQuickUnlockErr(null);
            setQuickUnlockPw('');
          }}
        >
          <div className="space-y-4 p-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs space-y-2">
              <div className="flex items-center gap-2 font-medium text-white">
                <Fingerprint size={18} style={{ color: theme.accent }} />
                <span>Biometrics & Screen Lock</span>
              </div>
              <p className="text-slate-400 leading-relaxed">
                Status:{' '}
                <strong className={deviceLockEnabled ? 'text-emerald-400' : 'text-slate-300'}>
                  {deviceLockEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </p>
              <p className="text-slate-400 leading-relaxed">
                When enabled, you can quickly unlock your master vault on this device using your fingerprint, face
                recognition, or lock pattern/PIN without typing your master password every time.
              </p>
            </div>

            {deviceLockEnabled ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await bridge.osKeychainDelete();
                    setDeviceLockEnabled(false);
                    setSettingsPicker(null);
                  } catch (e) {
                    console.error('Failed to disable quick unlock', e);
                  }
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/15 py-3 text-xs font-semibold text-rose-300 hover:bg-rose-500/25 transition cursor-pointer"
              >
                Disable Device Quick Unlock
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-300">Enter your master password to enable Quick Unlock on this device:</p>
                <input
                  type="password"
                  placeholder="Master password"
                  value={quickUnlockPw}
                  onChange={(e) => setQuickUnlockPw(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                  style={{ outlineColor: theme.accent }}
                />
                {quickUnlockErr && <p className="text-xs text-rose-400">{quickUnlockErr}</p>}
                <button
                  type="button"
                  disabled={quickUnlockBusy || quickUnlockPw.length < 4}
                  onClick={async () => {
                    setQuickUnlockBusy(true);
                    setQuickUnlockErr(null);
                    try {
                      if (mobile) {
                        try {
                          const { authenticate } = await import('@tauri-apps/plugin-biometric');
                          await authenticate('Verify Biometric / Screen Lock to Enable', {
                            allowDeviceCredential: true,
                            title: 'Drexius Vault',
                            subtitle: 'Confirm fingerprint, face or device screen lock to enable quick unlock',
                          });
                        } catch (bioErr: any) {
                          const msg = bioErr?.message || String(bioErr);
                          if (/cancel|dismiss|fail|negative/i.test(msg)) {
                            setQuickUnlockErr('Biometric confirmation was cancelled.');
                            return;
                          }
                          console.warn('Biometric opt-in prompt note:', bioErr);
                        }
                      }
                      const success = await bridge.osKeychainStore(quickUnlockPw);
                      if (success) {
                        setDeviceLockEnabled(true);
                        setSettingsPicker(null);
                        setQuickUnlockPw('');
                      } else {
                        setQuickUnlockErr('Failed to enable quick unlock.');
                      }
                    } catch (e: any) {
                      setQuickUnlockErr(e?.message || String(e));
                    } finally {
                      setQuickUnlockBusy(false);
                    }
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold text-black hover:brightness-110 active:scale-[0.99] disabled:opacity-50 transition cursor-pointer"
                  style={{ backgroundColor: theme.accent }}
                >
                  {quickUnlockBusy ? 'Saving…' : 'Enable Device Quick Unlock'}
                </button>
              </div>
            )}
          </div>
        </MobileSheet>
      )}
      {settingsPicker === 'directlaunch' && (
        <MobileSheet
          title="Direct Launch"
          kicker="Security"
          subtitle="Open the app directly without authorization or password"
          icon={Zap}
          theme={theme}
          onClose={() => {
            setSettingsPicker(null);
            setDirectLaunchErr(null);
            setDirectLaunchPw('');
          }}
        >
          <div className="space-y-4 p-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs space-y-2">
              <div className="flex items-center gap-2 font-medium text-white">
                <Zap size={18} style={{ color: theme.accent }} />
                <span>Direct App Launch</span>
              </div>
              <p className="text-slate-400 leading-relaxed">
                Status:{' '}
                <strong className={directUnlockEnabled ? 'text-emerald-400' : 'text-slate-300'}>
                  {directUnlockEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </p>
              <p className="text-slate-400 leading-relaxed">
                When enabled, the app automatically unlocks your vault and opens your terminal directly on startup
                without prompting for authorization or your master password.
              </p>
              {directUnlockEnabled && (
                <p className="text-amber-400/90 text-[11px] leading-relaxed">
                  Notice: Master credentials will be stored locally on this device. Anyone who has physical access to
                  this device can open your terminal.
                </p>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-xs text-slate-300">
                {directUnlockEnabled
                  ? 'Enter your master password to disable Direct Launch:'
                  : 'Enter your master password to enable Direct Launch:'}
              </p>
              <input
                type="password"
                placeholder="Master password"
                value={directLaunchPw}
                onChange={(e) => setDirectLaunchPw(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                style={{ outlineColor: theme.accent }}
              />
              {directLaunchErr && <p className="text-xs text-rose-400">{directLaunchErr}</p>}
              <button
                type="button"
                disabled={directLaunchBusy || !directLaunchPw}
                onClick={async () => {
                  setDirectLaunchBusy(true);
                  setDirectLaunchErr(null);
                  try {
                    const isValid = await bridge.vaultVerifyPassword(directLaunchPw);
                    if (!isValid) {
                      setDirectLaunchErr('Incorrect master password. Please verify and try again.');
                      setDirectLaunchBusy(false);
                      return;
                    }

                    if (!directUnlockEnabled) {
                      if (isTauri) {
                        try {
                          await bridge.osKeychainStore(directLaunchPw);
                        } catch (e) {
                          console.warn('Keychain store warning:', e);
                        }
                      }
                      bridge.setDirectUnlockEnabled(true);
                      setDirectUnlockEnabled(true);
                      toast('Direct Launch enabled');
                    } else {
                      bridge.setDirectUnlockEnabled(false);
                      if (isTauri) {
                        try {
                          await bridge.osKeychainDelete();
                        } catch {}
                      }
                      setDirectUnlockEnabled(false);
                      toast('Direct Launch disabled');
                    }
                    setSettingsPicker(null);
                    setDirectLaunchPw('');
                  } catch (err: any) {
                    setDirectLaunchErr(err?.message || 'Verification failed');
                  } finally {
                    setDirectLaunchBusy(false);
                  }
                }}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold transition cursor-pointer disabled:opacity-50',
                  directUnlockEnabled
                    ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                    : 'text-black hover:brightness-110 active:scale-[0.99]'
                )}
                style={{
                  backgroundColor: directUnlockEnabled ? undefined : theme.accent,
                }}
              >
                {directLaunchBusy ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <span>{directUnlockEnabled ? 'Disable Direct Launch' : 'Enable Direct Launch'}</span>
                )}
              </button>
            </div>
          </div>
        </MobileSheet>
      )}
      {settingsPicker === 'recovery_key' && (
        <MobileSheet
          title="Emergency Recovery Kit"
          kicker="Vault Security"
          subtitle="Zero-knowledge recovery key for your vault"
          icon={KeyRound}
          theme={theme}
          onClose={() => {
            setSettingsPicker(null);
            setDownloadedRecoveryPath(null);
            setShowRegenConfirm(false);
          }}
        >
          <div className="space-y-4 p-2">
            <p className="text-xs text-slate-400 leading-relaxed">
              If you ever forget your master password, this 128-bit key is the{' '}
              <strong className="text-slate-200">ONLY way to recover your encrypted vault</strong>. Store it in a safe
              place.
            </p>
            {recoveryKey ? (
              <>
                <div
                  className="rounded-xl border border-white/10 bg-black/60 p-3.5 text-center font-mono text-xs sm:text-sm font-bold tracking-wider select-all break-all"
                  style={{ color: theme.accent }}
                >
                  {recoveryKey}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await bridge.writeClipboard(recoveryKey);
                        setCopiedRecovery(true);
                        setTimeout(() => setCopiedRecovery(false), 2000);
                      } catch {}
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
                  >
                    {copiedRecovery ? <Check size={14} style={{ color: theme.accent }} /> : <Copy size={14} />}
                    {copiedRecovery ? 'Copied' : 'Copy Key'}
                  </button>

                  {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.share({
                            title: 'Drexius Recovery Kit',
                            text: `DREXIUS EMERGENCY RECOVERY KEY:\n${recoveryKey}\n\nKeep this secret and offline.`,
                          });
                        } catch (e: any) {
                          if (e?.name !== 'AbortError') console.warn(e);
                        }
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
                    >
                      <Share2 size={14} />
                      <span>Share / Save</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const text = `=====================================================\nDREXIUS EMERGENCY RECOVERY KIT\n=====================================================\n\nEmergency Recovery Key:\n${recoveryKey}\n\nGenerated: ${new Date().toISOString()}\n=====================================================`;
                        const path = await bridge.vaultSaveEmergencyKit(text);
                        setDownloadedRecoveryPath(path);
                      } catch (e) {
                        console.error('Download failed', e);
                      }
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
                  >
                    {downloadedRecoveryPath ? <Check size={14} className="text-emerald-400" /> : <Download size={14} />}
                    {downloadedRecoveryPath ? 'Saved' : 'Download .txt'}
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-white/10 bg-black/40 p-4 text-center space-y-3">
                <p className="text-xs text-slate-300">No active recovery key is currently cached in this vault session.</p>
                <button
                  type="button"
                  disabled={regeneratingRecovery}
                  onClick={async () => {
                    setRegeneratingRecovery(true);
                    try {
                      const newKey = await bridge.vaultRegenerateRecoveryKey();
                      setRecoveryKey(newKey);
                    } catch (err) {
                      console.error('Failed to generate recovery key', err);
                    } finally {
                      setRegeneratingRecovery(false);
                    }
                  }}
                  className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 transition"
                >
                  {regeneratingRecovery ? 'Generating…' : 'Generate & Store Recovery Key'}
                </button>
              </div>
            )}

            {downloadedRecoveryPath && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                <p className="font-semibold text-white">Saved to Downloads:</p>
                <p className="mt-1 font-mono text-[10.5px] select-all break-all text-slate-300">
                  {downloadedRecoveryPath}
                </p>
              </div>
            )}

            {recoveryKey && (
              <div className="pt-2 border-t border-white/10">
                {!showRegenConfirm ? (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => setShowRegenConfirm(true)}
                      className="text-[11px] text-slate-400 hover:text-amber-400 transition underline underline-offset-2"
                    >
                      Regenerate Emergency Recovery Key
                    </button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-2">
                    <p className="text-amber-200 font-medium leading-relaxed">
                      Warning: Regenerating will immediately invalidate any previously saved, printed, or downloaded
                      emergency recovery kits.
                    </p>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={regeneratingRecovery}
                        onClick={async () => {
                          setRegeneratingRecovery(true);
                          try {
                            const newKey = await bridge.vaultRegenerateRecoveryKey();
                            setRecoveryKey(newKey);
                            setShowRegenConfirm(false);
                            setDownloadedRecoveryPath(null);
                          } catch (err) {
                            console.error('Failed to regenerate recovery key', err);
                          } finally {
                            setRegeneratingRecovery(false);
                          }
                        }}
                        className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 transition"
                      >
                        {regeneratingRecovery ? 'Regenerating…' : 'Yes, Replace Active Key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRegenConfirm(false)}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 transition"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </MobileSheet>
      )}
      {settingsPicker === 'storage_perms' && (
        <MobileSheet
          title="Storage & Permissions"
          kicker="System"
          subtitle="File access for SFTP, Downloads & terminal sessions"
          icon={Folder}
          theme={theme}
          onClose={() => setSettingsPicker(null)}
        >
          <div className="space-y-4 p-2 text-xs">
            {/* Status & 1-Click Action */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium text-white">
                  <ShieldCheck size={18} style={{ color: theme.accent }} />
                  <span>Storage Permission Status</span>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide border',
                    storageGranted === true
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : storageGranted === false
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                        : 'border-white/10 bg-white/5 text-slate-400'
                  )}
                >
                  {storageGranted === true ? 'Granted' : storageGranted === false ? 'Action Needed' : 'Checking…'}
                </span>
              </div>
              <p className="text-slate-400 leading-relaxed text-[11.5px]">
                {storageGranted === true
                  ? 'Drexius has storage access. You can browse internal storage, save recovery keys to Downloads, and transfer files via Local SFTP.'
                  : 'Storage permission is required to browse shared storage, save your Emergency Recovery Key to Downloads, and transfer files in SFTP.'}
              </p>

              {storageGranted !== true && (
                <button
                  type="button"
                  disabled={requestingPerm}
                  onClick={async () => {
                    setRequestingPerm(true);
                    try {
                      await bridge.requestStoragePermission();
                      setTimeout(async () => {
                        const ok = await bridge.checkStoragePermission();
                        setStorageGranted(ok);
                        setRequestingPerm(false);
                      }, 1200);
                    } catch {
                      setRequestingPerm(false);
                    }
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-semibold text-black hover:brightness-110 active:scale-[0.99] disabled:opacity-50 transition shadow-lg cursor-pointer"
                  style={{ backgroundColor: theme.accent }}
                >
                  <FolderLock size={16} />
                  <span>{requestingPerm ? 'Opening System Dialog…' : 'Grant Storage Permission'}</span>
                </button>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
              <div className="flex items-center gap-2 font-medium text-white">
                <Folder size={18} style={{ color: theme.accent }} />
                <span>Accessible Storage Directories</span>
              </div>
              <p className="text-slate-400 leading-relaxed text-[11.5px]">
                Drexius uses these shared storage paths for file operations:
              </p>
              <div className="font-mono text-[11px] text-cyan-300 bg-black/40 rounded-lg p-2.5 border border-white/5 space-y-1">
                <div>• /storage/emulated/0/Download</div>
                <div>• /storage/emulated/0/Documents</div>
                <div>• /storage/emulated/0</div>
              </div>
            </div>
          </div>
        </MobileSheet>
      )}
    </>
  );
}

export interface MobileSessionsSheetProps {
  terminalSessionCount: number;
  theme: DrexiusTheme;
  tabs: Tab[];
  activeTabId: string | null;
  hostMap: Map<string, Host>;
  isAndroid: boolean;
  onClose: () => void;
  navigateMobile: (page: MobilePage) => void;
  setActiveTabId: Dispatch<SetStateAction<string | null>>;
  focusPane: (tabId: string, paneId: string) => void;
  closePane: (tabId: string, paneId: string) => void;
  openLocalTerminal: () => void;
  openTermuxPreset: () => Promise<void> | void;
}

export function MobileSessionsSheet({
  terminalSessionCount,
  theme,
  tabs,
  activeTabId,
  hostMap,
  isAndroid,
  onClose,
  navigateMobile,
  setActiveTabId,
  focusPane,
  closePane,
  openLocalTerminal,
  openTermuxPreset,
}: MobileSessionsSheetProps) {
  return (
    <MobileSheet
      title="Terminal sessions"
      kicker={`${terminalSessionCount} open`}
      icon={TerminalIcon}
      theme={theme}
      onClose={onClose}
    >
      <p className="mb-3 text-xs text-slate-400">Switch sessions without disconnecting. Desktop splits remain intact.</p>
      <div className="space-y-2">
        {tabs
          .filter((t) => t.kind !== 'sftp')
          .flatMap((t) =>
            t.panes.map((p) => {
              const current = t.id === activeTabId && t.activePaneId === p.id;
              return (
                <div
                  key={p.id}
                  className={cn(
                    'flex items-center rounded-xl border p-1',
                    !current && 'border-white/10 bg-white/[0.03]'
                  )}
                  style={current ? { borderColor: `${theme.accent}66`, background: `${theme.accent}1a` } : undefined}
                >
                  <button
                    className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left"
                    onClick={() => {
                      navigateMobile('terminals');
                      setActiveTabId(t.id);
                      focusPane(t.id, p.id);
                    }}
                  >
                    <TerminalIcon size={19} className="shrink-0" style={{ color: theme.accent }} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {hostMap.get(p.hostId)?.label ?? t.title}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {registry.get(p.id)?.status ?? 'connecting'} · {hostMap.get(p.hostId)?.hostname}
                      </span>
                    </span>
                  </button>
                  <button
                    className="nx-touch-button text-slate-400"
                    aria-label={`Close ${hostMap.get(p.hostId)?.label ?? 'session'}`}
                    onClick={() => closePane(t.id, p.id)}
                  >
                    <X size={18} />
                  </button>
                </div>
              );
            })
          )}
        {!tabs.some((t) => t.panes.length) && (
          <p className="py-6 text-center text-sm text-slate-400">
            No sessions yet. Connect to a saved host to get started.
          </p>
        )}
      </div>
      <button
        className="nx-settings-row mt-4 rounded-xl"
        style={{ background: `${theme.accent}1a`, color: theme.accent }}
        onClick={() => navigateMobile('hosts')}
      >
        <Plus size={18} /> Connect to a host
      </button>
      <button
        className="nx-settings-row"
        onClick={() => {
          openLocalTerminal();
          onClose();
        }}
      >
        <TerminalIcon size={18} /> Open local terminal
      </button>
      {isAndroid && (
        <button
          className="nx-settings-row"
          onClick={() => {
            onClose();
            void openTermuxPreset();
          }}
        >
          <TerminalIcon size={18} className="text-emerald-400" /> Termux (Local :8022)
        </button>
      )}
    </MobileSheet>
  );
}
