import {
  Activity,
  Boxes,
  Cloud,
  Code2,
  HardDrive,
  History,
  KeyRound,
  Lock,
  Network,
  Palette,
  PanelBottom,
  QrCode,
  Radio,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
} from 'lucide-react';
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from '../../lib/settings';
import type { DrexiusTheme } from '../../lib/themes';
import { cn } from '../../utils/cn';
import { CustomSelect } from '../CustomSelect';
import type { SettingsTab } from '../SettingsModal';
import { ToggleSwitch } from '../ToggleSwitch';

export interface GeneralAndTerminalTabProps {
  mobile: boolean;
  uiPrefs: UiPreferences;
  onUiPrefsChange: (prefs: UiPreferences) => void;
  activeTheme: DrexiusTheme;
  accentColor: string;
  onClose: () => void;
  onOpenLogs?: (tab?: SettingsTab) => void;
  toast: (msg: string) => void;
}

export function GeneralAndTerminalTab({
  mobile,
  uiPrefs,
  onUiPrefsChange,
  activeTheme,
  accentColor,
  onClose,
  onOpenLogs,
  toast,
}: GeneralAndTerminalTabProps) {
  const updatePref = <K extends keyof UiPreferences>(key: K, val: UiPreferences[K]) => {
    onUiPrefsChange({ ...uiPrefs, [key]: val });
  };

  const resetUiPrefsToDefault = () => {
    onUiPrefsChange({ ...DEFAULT_UI_PREFERENCES });
    toast('UI preferences reset to defaults');
  };

  return (
    <div className={cn(mobile ? 'space-y-4' : 'space-y-6')}>
      {/* Feature Visibility Toggles (Desktop only) */}
      {!mobile && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">UI Element Visibility</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Hide features you do not use for a clean, minimal terminal workspace
              </p>
            </div>
            <button
              type="button"
              onClick={resetUiPrefsToDefault}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reset</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            {/* Serial Toggle */}
            <div
              onClick={() => updatePref('showSerial', !uiPrefs.showSerial)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showSerial
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showSerial ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Radio className="h-4 w-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Hardware Serial Terminal</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    UART & RS-232 connection button in toolbar and hosts sidebar
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showSerial}
                onChange={(val) => updatePref('showSerial', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Docker Toggle */}
            <div
              onClick={() => updatePref('showDocker', !uiPrefs.showDocker)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showDocker
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showDocker ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Boxes className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Docker Containers</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Container explorer and logs monitor in top bar and rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showDocker}
                onChange={(val) => updatePref('showDocker', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Application Deployment Toggle */}
            <div
              onClick={() => updatePref('showDeploy', !uiPrefs.showDeploy)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showDeploy
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showDeploy ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Rocket className="h-4 w-4 text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Application Deployment</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    1-Click zero-downtime Git release &amp; rollback runner in top bar and rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showDeploy}
                onChange={(val) => updatePref('showDeploy', val)}
                accentColor={accentColor}
              />
            </div>

            {/* AI Assistant Toggle */}
            <div
              onClick={() => updatePref('showAi', !uiPrefs.showAi)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showAi
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showAi ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Sparkles className="h-4 w-4 text-fuchsia-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">AI Copilot Assistant</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Multi-provider AI relay workspace side drawer and top bar button
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showAi}
                onChange={(val) => updatePref('showAi', val)}
                accentColor={accentColor}
              />
            </div>

            {/* SFTP Toggle */}
            <div
              onClick={() => updatePref('showSftp', !uiPrefs.showSftp)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showSftp
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showSftp ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <HardDrive className="h-4 w-4 text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">SFTP File Browser</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Dual-pane graphical SFTP browser button in title bar
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showSftp}
                onChange={(val) => updatePref('showSftp', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Snippets Toggle */}
            <div
              onClick={() => updatePref('showSnippets', !uiPrefs.showSnippets)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showSnippets
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showSnippets ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Code2 className="h-4 w-4 text-indigo-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Snippets & Scripts</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Quick script snippets manager in sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showSnippets}
                onChange={(val) => updatePref('showSnippets', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Tunnels Toggle */}
            <div
              onClick={() => updatePref('showTunnels', !uiPrefs.showTunnels)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showTunnels
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showTunnels ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Network className="h-4 w-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Port Forwarding & Tunnels</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Local, remote, and dynamic SOCKS5 tunnel manager
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showTunnels}
                onChange={(val) => updatePref('showTunnels', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Local Shell Toggle */}
            <div
              onClick={() => updatePref('showLocalTerminal', !uiPrefs.showLocalTerminal)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showLocalTerminal
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showLocalTerminal ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Terminal className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Local Shell (Top Bar)</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Quick local terminal launcher button in the top header
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showLocalTerminal}
                onChange={(val) => updatePref('showLocalTerminal', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Theme Switcher Toggle */}
            <div
              onClick={() => updatePref('showThemeButton', !uiPrefs.showThemeButton)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showThemeButton
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showThemeButton ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Palette className="h-4 w-4 text-purple-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Theme Switcher (Top Bar)</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Palette icon button for quick theme/font adjustments in the top header
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showThemeButton}
                onChange={(val) => updatePref('showThemeButton', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Status Bar Toggle Button */}
            <div
              onClick={() => updatePref('showStatusBarToggle', !uiPrefs.showStatusBarToggle)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showStatusBarToggle
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showStatusBarToggle ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <PanelBottom className="h-4 w-4 text-blue-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Status Bar Quick Toggle (Top Bar)</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Header button to quickly show or hide the bottom status bar
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showStatusBarToggle}
                onChange={(val) => updatePref('showStatusBarToggle', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Keychain Toggle */}
            <div
              onClick={() => updatePref('showKeychain', !uiPrefs.showKeychain)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showKeychain
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showKeychain ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <KeyRound className="h-4 w-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Keychain (Identities)</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    SSH private keys, identities, and cert manager in sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showKeychain}
                onChange={(val) => updatePref('showKeychain', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Session History & Audit Toggle */}
            <div
              onClick={() => updatePref('showHistory', !uiPrefs.showHistory)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showHistory
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showHistory ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <History className="h-4 w-4 text-sky-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Session History & Audit</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Terminal audit logs, command history, and session records in sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showHistory}
                onChange={(val) => updatePref('showHistory', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Known Hosts Toggle */}
            <div
              onClick={() => updatePref('showKnownHosts', !uiPrefs.showKnownHosts)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showKnownHosts
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showKnownHosts ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Known Hosts</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Host key verification fingerprints and trust database in sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showKnownHosts}
                onChange={(val) => updatePref('showKnownHosts', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Direct Device Pairing Toggle */}
            <div
              onClick={() => updatePref('showPairing', !uiPrefs.showPairing)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showPairing
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showPairing ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <QrCode className="h-4 w-4 text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Direct Device Pairing</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Encrypted QR code and LAN peer-to-peer sync button at bottom of sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showPairing}
                onChange={(val) => updatePref('showPairing', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Zero-Knowledge Sync Toggle */}
            <div
              onClick={() => updatePref('showSync', !uiPrefs.showSync)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showSync
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showSync ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Cloud className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Zero-Knowledge Cloud Sync (Relay)</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Encrypted relay sync and cloud backup status button at bottom of sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showSync}
                onChange={(val) => updatePref('showSync', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Auto-Lock Timeout Toggle */}
            <div
              onClick={() => updatePref('showAutoLock', !uiPrefs.showAutoLock)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showAutoLock
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showAutoLock ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Timer className="h-4 w-4 text-violet-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Auto-Lock Timeout</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Inactivity auto-lock timer popover menu button at bottom of sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showAutoLock}
                onChange={(val) => updatePref('showAutoLock', val)}
                accentColor={accentColor}
              />
            </div>

            {/* Lock Vault Toggle */}
            <div
              onClick={() => updatePref('showLockVault', !uiPrefs.showLockVault)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.showLockVault
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.showLockVault ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Lock className="h-4 w-4 text-rose-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Lock Vault</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    One-click immediate vault security lock button at bottom of sidebar rail
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.showLockVault}
                onChange={(val) => updatePref('showLockVault', val)}
                accentColor={accentColor}
              />
            </div>
          </div>
        </div>
      )}

      {/* Terminal Behavior */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-white">
            {mobile ? 'Terminal & Shell Behavior' : 'Terminal Behavior & Emulation'}
          </h3>
          {mobile && (
            <p className="text-xs text-slate-400 mt-0.5">
              Configure command suggestions, cursor animation, and scrollback history
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Cursor Style */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Cursor Style</label>
            <div className="grid grid-cols-3 gap-2">
              {(['block', 'bar', 'underline'] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => updatePref('cursorStyle', style)}
                  className={cn(
                    'py-2 px-3 rounded-lg border text-xs font-medium capitalize transition',
                    uiPrefs.cursorStyle === style
                      ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-300'
                      : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-white'
                  )}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>

          {/* Cursor Blink */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Cursor Animation</label>
            <div
              onClick={() => updatePref('cursorBlink', !uiPrefs.cursorBlink)}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                uiPrefs.cursorBlink
                  ? 'border-white/15 bg-white/[0.04]'
                  : 'border-white/5 bg-white/[0.015] opacity-75'
              )}
            >
              <span className="text-xs font-medium text-white">Blinking Cursor</span>
              <ToggleSwitch
                checked={uiPrefs.cursorBlink}
                onChange={(val) => updatePref('cursorBlink', val)}
                accentColor={accentColor}
              />
            </div>
          </div>

          {/* Scrollback Buffer */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Scrollback History Lines</label>
            <CustomSelect
              value={uiPrefs.scrollback}
              onChange={(val) => updatePref('scrollback', Number(val))}
              dropUp={true}
              options={[
                { value: 5000, label: '5,000 lines' },
                { value: 10000, label: '10,000 lines (Default)' },
                { value: 25000, label: '25,000 lines' },
                { value: 50000, label: '50,000 lines' },
              ]}
              theme={activeTheme}
              accentColor={accentColor}
            />
          </div>

          {/* Confirm Close */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Safety Protections</label>
            <div
              onClick={() => updatePref('confirmClosePane', !uiPrefs.confirmClosePane)}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                uiPrefs.confirmClosePane
                  ? 'border-white/15 bg-white/[0.04]'
                  : 'border-white/5 bg-white/[0.015] opacity-75'
              )}
            >
              <span className="text-xs font-medium text-white">Confirm before closing active panes</span>
              <ToggleSwitch
                checked={uiPrefs.confirmClosePane}
                onChange={(val) => updatePref('confirmClosePane', val)}
                accentColor={accentColor}
              />
            </div>
          </div>

          {/* Copy on Select */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Copy on Select</label>
            <div
              onClick={() => updatePref('copyOnSelect', !uiPrefs.copyOnSelect)}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                uiPrefs.copyOnSelect
                  ? 'border-white/15 bg-white/[0.04]'
                  : 'border-white/5 bg-white/[0.015] opacity-75'
              )}
            >
              <div className="flex flex-col min-w-0 pr-2">
                <span className="text-xs font-medium text-white">Copy on select</span>
                <span className="text-[10px] text-slate-400">Auto-copy highlighted text to clipboard</span>
              </div>
              <ToggleSwitch
                checked={uiPrefs.copyOnSelect}
                onChange={(val) => updatePref('copyOnSelect', val)}
                accentColor={accentColor}
              />
            </div>
          </div>

          {/* Right Click to Paste */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Right Click Action</label>
            <div
              onClick={() => updatePref('rightClickPaste', !uiPrefs.rightClickPaste)}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                uiPrefs.rightClickPaste
                  ? 'border-white/15 bg-white/[0.04]'
                  : 'border-white/5 bg-white/[0.015] opacity-75'
              )}
            >
              <div className="flex flex-col min-w-0 pr-2">
                <span className="text-xs font-medium text-white">Right click to paste</span>
                <span className="text-[10px] text-slate-400">Paste clipboard instead of context menu</span>
              </div>
              <ToggleSwitch
                checked={uiPrefs.rightClickPaste}
                onChange={(val) => updatePref('rightClickPaste', val)}
                accentColor={accentColor}
              />
            </div>
          </div>

          {/* Inline Ghost Autosuggestions */}
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-medium text-slate-300">Ghost Text Autosuggestions</label>
            <div
              onClick={() => updatePref('ghostSuggestions', !uiPrefs.ghostSuggestions)}
              className={cn(
                'flex items-center justify-between gap-3.5 rounded-xl border p-3.5 cursor-pointer transition select-none',
                uiPrefs.ghostSuggestions
                  ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06] hover:border-white/20'
                  : 'border-white/5 bg-white/[0.015] hover:bg-white/[0.03] opacity-65 hover:opacity-85'
              )}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5 transition"
                  style={{
                    backgroundColor: uiPrefs.ghostSuggestions ? `${accentColor}18` : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Sparkles className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white">Real-time Inline Ghost Suggestions</div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                    Display Fish/Zsh-style inline command completions from history and catalog (press → or tap to
                    complete; Tab always uses your shell&apos;s native completion).
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={uiPrefs.ghostSuggestions}
                onChange={(val) => updatePref('ghostSuggestions', val)}
                accentColor={accentColor}
              />
            </div>
          </div>
        </div>

        {/* Command History & Audit Logs Link */}
        {onOpenLogs && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Activity className="h-4 w-4 text-rose-400" />
                  <span>Command History & Audit Logs</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  View executed terminal commands and connection audit logs
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenLogs?.('terminal');
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
              >
                <span>Open History & Logs →</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
