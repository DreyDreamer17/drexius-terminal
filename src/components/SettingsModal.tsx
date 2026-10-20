import { useState, useMemo, useEffect, useRef } from 'react';
import { useMobile } from '../hooks/useMobile';
import {
  Settings,
  Sliders,
  Keyboard,
  Palette,
  Shield,
  RefreshCw,
  X,
  Radio,
  Boxes,
  Sparkles,
  HardDrive,
  Code2,
  Network,
  RotateCcw,
  Check,
  ChevronRight,
  FolderLock,
  Lock,
  QrCode,
  Cloud,
  Globe2,
  Type,
  Rows2,
  Minus,
  Plus,
  PanelBottom,
  Terminal,
  Zap,
  KeyRound,
  Eye,
  EyeOff,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import {
  type UiPreferences,
  type ShortcutBinding,
  DEFAULT_UI_PREFERENCES,
  DEFAULT_SHORTCUTS,
} from '../lib/settings';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { CustomSelect } from './CustomSelect';
import { ToggleSwitch } from './ToggleSwitch';
import { cn } from '../utils/cn';

interface Props {
  onClose: () => void;
  theme?: DrexiusTheme;
  themeId: string;
  onThemeSelect: (themeId: string) => void;
  fontSize: number;
  onFontSizeChange: (fontSize: number) => void;
  lineHeight: number;
  onLineHeightChange: (lh: number) => void;
  zen: boolean;
  onZenChange: (zen: boolean) => void;
  showRail: boolean;
  onShowRailChange: (show: boolean) => void;
  showStatusBar: boolean;
  onShowStatusBarChange: (show: boolean) => void;
  autoLockMinutes: number;
  onAutoLockChange: (mins: number) => void;
  uiPrefs: UiPreferences;
  onUiPrefsChange: (prefs: UiPreferences) => void;
  shortcuts: Record<string, ShortcutBinding>;
  onShortcutsChange: (shortcuts: Record<string, ShortcutBinding>) => void;
  onOpenPairing?: () => void;
  onOpenSync?: () => void;
  onOpenTailscale?: () => void;
  onOpenNetbird?: () => void;
  onOpenCloudSync?: () => void;
  onOpenDocker?: () => void;
  onLockVault?: () => void;
  storageGranted?: boolean | null;
  onRequestStoragePermission?: () => void;
  toast: (msg: string) => void;
}

type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'security' | 'sync' | 'terminal';

export function SettingsModal({
  onClose,
  theme,
  themeId,
  onThemeSelect,
  fontSize,
  onFontSizeChange,
  lineHeight,
  onLineHeightChange,
  zen,
  onZenChange,
  showRail,
  onShowRailChange,
  showStatusBar,
  onShowStatusBarChange,
  autoLockMinutes,
  onAutoLockChange,
  uiPrefs,
  onUiPrefsChange,
  shortcuts,
  onShortcutsChange,
  onOpenPairing,
  onOpenSync,
  onOpenTailscale,
  onOpenNetbird,
  onOpenCloudSync,
  onOpenDocker,
  onLockVault,
  storageGranted,
  onRequestStoragePermission,
  toast,
}: Props) {
  const mobile = useMobile();

  const availableTabs = useMemo(() => {
    if (mobile) {
      return [
        { id: 'appearance' as SettingsTab, label: 'Appearance', icon: Palette },
        { id: 'terminal' as SettingsTab, label: 'Terminal', icon: Terminal },
        { id: 'security' as SettingsTab, label: 'Security', icon: Shield },
        { id: 'sync' as SettingsTab, label: 'Sync & Mesh', icon: RefreshCw },
      ];
    }
    return [
      { id: 'general' as SettingsTab, label: 'Customization', icon: Sliders },
      { id: 'shortcuts' as SettingsTab, label: 'Shortcuts', icon: Keyboard },
      { id: 'appearance' as SettingsTab, label: 'Appearance', icon: Palette },
      { id: 'security' as SettingsTab, label: 'Security', icon: Shield },
      { id: 'sync' as SettingsTab, label: 'Sync & Mesh', icon: RefreshCw },
    ];
  }, [mobile]);

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => (mobile ? 'appearance' : 'general'));

  useEffect(() => {
    if (mobile && (activeTab === 'general' || activeTab === 'shortcuts')) {
      setActiveTab('appearance');
    }
  }, [mobile]);

  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string>('');
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeBtn = tabListRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]');
    activeBtn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  const activeTheme =
    theme || THEMES.find((t) => t.id === themeId) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  // Direct Launch / Auto-Unlock state & handlers
  const [directUnlockEnabled, setDirectUnlockEnabled] = useState(() => bridge.isDirectUnlockEnabled());
  const [showDirectUnlockModal, setShowDirectUnlockModal] = useState(false);
  const [targetDirectUnlockState, setTargetDirectUnlockState] = useState(false);
  const [directUnlockPw, setDirectUnlockPw] = useState('');
  const [showDirectUnlockPw, setShowDirectUnlockPw] = useState(false);
  const [directUnlockBusy, setDirectUnlockBusy] = useState(false);
  const [directUnlockErr, setDirectUnlockErr] = useState<string | null>(null);
  const directPwInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showDirectUnlockModal) {
      const timer = setTimeout(() => directPwInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [showDirectUnlockModal]);

  const handleToggleDirectUnlock = () => {
    const nextState = !directUnlockEnabled;
    setTargetDirectUnlockState(nextState);
    setDirectUnlockPw('');
    setShowDirectUnlockPw(false);
    setDirectUnlockErr(null);
    setShowDirectUnlockModal(true);
  };

  const handleConfirmDirectUnlock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!directUnlockPw) {
      setDirectUnlockErr('Please enter your master password');
      return;
    }
    setDirectUnlockBusy(true);
    setDirectUnlockErr(null);
    try {
      const isValid = await bridge.vaultVerifyPassword(directUnlockPw);
      if (!isValid) {
        setDirectUnlockErr('Incorrect master password. Please verify and try again.');
        setDirectUnlockBusy(false);
        return;
      }

      if (targetDirectUnlockState) {
        if (isTauri) {
          try {
            await bridge.osKeychainStore(directUnlockPw);
          } catch (storeErr) {
            console.warn('Keychain store warning:', storeErr);
          }
        }
        bridge.setDirectUnlockEnabled(true);
        setDirectUnlockEnabled(true);
        toast('Direct Launch enabled: NexusTerminal will open directly on launch.');
      } else {
        bridge.setDirectUnlockEnabled(false);
        if (isTauri) {
          try {
            await bridge.osKeychainDelete();
          } catch (_) {}
        }
        setDirectUnlockEnabled(false);
        toast('Direct Launch disabled: Master password required on launch.');
      }
      setShowDirectUnlockModal(false);
      setDirectUnlockPw('');
    } catch (err: any) {
      setDirectUnlockErr(isBridgeError(err) ? err.message : (err?.message || 'Verification failed'));
    } finally {
      setDirectUnlockBusy(false);
    }
  };

  const updatePref = <K extends keyof UiPreferences>(key: K, val: UiPreferences[K]) => {
    const next = { ...uiPrefs, [key]: val };
    onUiPrefsChange(next);
  };

  const handleShortcutKeyDown = (e: React.KeyboardEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setEditingShortcutId(null);
      setRecordedKeys('');
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    // While only modifier keys (Control, Shift, Alt, Meta) are held down, update visual feedback
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      setRecordedKeys(parts.join('+'));
      return;
    }

    let keyPart = e.key;
    if (keyPart === ' ') {
      keyPart = 'Space';
    } else if (keyPart.startsWith('Arrow')) {
      // Keep ArrowLeft, ArrowRight, ArrowUp, ArrowDown
    } else if (e.code && e.code.startsWith('Key')) {
      keyPart = e.code.slice(3).toUpperCase();
    } else if (e.code && e.code.startsWith('Digit')) {
      keyPart = e.code.slice(5);
    } else if (keyPart.length === 1) {
      keyPart = keyPart.toUpperCase();
    }

    parts.push(keyPart);
    const newKeyCombo = parts.join('+');

    const next = {
      ...shortcuts,
      [id]: {
        ...shortcuts[id],
        keys: newKeyCombo,
      },
    };
    onShortcutsChange(next);
    setEditingShortcutId(null);
    setRecordedKeys('');
    toast(`Shortcut updated: ${shortcuts[id]?.label || id} → ${newKeyCombo}`);
  };

  const handleShortcutKeyUp = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    setRecordedKeys(parts.join('+'));
  };

  const resetShortcutsToDefault = () => {
    onShortcutsChange({ ...DEFAULT_SHORTCUTS });
    toast('Keyboard shortcuts reset to defaults');
  };

  const resetUiPrefsToDefault = () => {
    onUiPrefsChange({ ...DEFAULT_UI_PREFERENCES });
    toast('UI preferences reset to defaults');
  };

  const shortcutCategories = useMemo(() => {
    const groups: Record<string, ShortcutBinding[]> = {};
    for (const item of Object.values(shortcuts)) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    }
    return groups;
  }, [shortcuts]);

  return (
    <ResponsiveOverlay
      portal
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm",
        mobile ? "!p-0 !items-stretch !justify-stretch !inset-0 !top-0 !h-[100dvh]" : "p-4"
      )}
      onClose={onClose}
      label="General Settings"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "relative flex flex-col w-full text-slate-200 overflow-hidden shadow-2xl transition-all",
          mobile
            ? "h-[100dvh] max-h-[100dvh] rounded-none border-none"
            : "nx-sheet max-w-4xl max-h-[85vh] rounded-2xl border"
        )}
        style={
          {
            backgroundColor: bgColor,
            borderColor: `${accentColor}30`,
            '--nx-accent': accentColor,
          } as React.CSSProperties
        }
      >
        {!mobile && <SheetHandle onClose={onClose} />}

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-20"
          style={{
            background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)`,
          }}
        />

        {/* Header */}
        <div className={cn(
          "relative border-b border-white/10 shrink-0 bg-white/[0.02]",
          mobile ? "px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-3" : "px-4 sm:px-6 py-3.5"
        )}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl border shadow-sm shrink-0"
                style={{
                  backgroundColor: `${accentColor}18`,
                  borderColor: `${accentColor}35`,
                  color: accentColor,
                  boxShadow: `0 0 16px ${accentColor}25`,
                }}
              >
                <Settings className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base sm:text-lg font-semibold tracking-wide text-white">
                    Settings
                  </h2>
                  {!mobile && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold border"
                      style={{
                        backgroundColor: `${accentColor}15`,
                        borderColor: `${accentColor}30`,
                        color: accentColor,
                      }}
                    >
                      Customization & Splits
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {mobile
                    ? 'Theme colors, font size, terminal behavior, security and sync'
                    : 'Configure UI visibility, keyboard splits, terminal behavior, and security'}
                </p>
              </div>
            </div>

            {mobile ? (
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-black transition shadow active:scale-95 cursor-pointer"
                style={{ backgroundColor: accentColor }}
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                title="Close Settings"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Navigation Tabs */}
          <div
            ref={tabListRef}
            className="flex items-center gap-1.5 mt-3.5 overflow-x-auto no-scrollbar scroll-smooth px-0.5"
          >
            {availableTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-active={isActive}
                  onClick={(e) => {
                    setActiveTab(tab.id);
                    e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
                  }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition shrink-0 border select-none',
                    isActive
                      ? 'text-white border-transparent'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border-transparent'
                  )}
                  style={
                    isActive
                      ? {
                          backgroundColor: `${accentColor}20`,
                          borderColor: `${accentColor}40`,
                          color: accentColor,
                        }
                      : undefined
                  }
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Content Body */}
        <div className={cn(
          "flex-1 overflow-y-auto",
          mobile ? "p-4 space-y-4 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))]" : "p-4 sm:p-6 space-y-6"
        )}>
          {/* TAB 1: UI CUSTOMIZATION (DESKTOP) & TERMINAL BEHAVIOR (BOTH) */}
          {(activeTab === 'general' || activeTab === 'terminal') && (
            <div className={cn(mobile ? "space-y-4" : "space-y-6")}>
              {/* Feature Visibility Toggles (Desktop only) */}
              {!mobile && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        UI Element Visibility
                      </h3>
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
                    <label className="text-xs font-medium text-slate-300">
                      Cursor Style
                    </label>
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
                    <label className="text-xs font-medium text-slate-300">
                      Cursor Animation
                    </label>
                    <div
                      onClick={() => updatePref('cursorBlink', !uiPrefs.cursorBlink)}
                      className={cn(
                        'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                        uiPrefs.cursorBlink ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
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
                    <label className="text-xs font-medium text-slate-300">
                      Scrollback History Lines
                    </label>
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
                    <label className="text-xs font-medium text-slate-300">
                      Safety Protections
                    </label>
                    <div
                      onClick={() => updatePref('confirmClosePane', !uiPrefs.confirmClosePane)}
                      className={cn(
                        'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                        uiPrefs.confirmClosePane ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
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

                  {/* Inline Ghost Autosuggestions */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="text-xs font-medium text-slate-300">
                      Ghost Text Autosuggestions
                    </label>
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
                            Display Fish/Zsh-style inline command completions from history and catalog (press Tab or → to complete). Turn off for raw shell Tab completion only.
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
              </div>
            </div>
          )}

          {/* TAB 2: SHORTCUTS & SPLIT NAVIGATION (DESKTOP ONLY) */}
          {!mobile && activeTab === 'shortcuts' && (
            <div className="space-y-6">
              {/* Ghostty Split Navigation Banner */}
              <div
                className="rounded-xl border p-4 sm:p-5 relative overflow-hidden"
                style={{
                  backgroundColor: `${accentColor}10`,
                  borderColor: `${accentColor}30`,
                }}
              >
                <div className="flex items-start gap-3.5">
                  <div
                    className="p-2 rounded-lg shrink-0"
                    style={{ backgroundColor: `${accentColor}25`, color: accentColor }}
                  >
                    <Keyboard className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold text-white">
                      Directional Split Navigation
                    </h4>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Move seamlessly between split terminal panes using directional arrow keys without touching your mouse.
                      Press <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">Alt + Left</kbd>, <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">Alt + Right</kbd>, <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">Alt + Up</kbd>, or <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">Alt + Down</kbd> to focus adjacent panes.
                    </p>
                  </div>
                </div>
              </div>

              {/* Shortcuts Table by Category */}
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    Click any shortcut to rebind with your preferred key combination
                  </span>
                  <button
                    type="button"
                    onClick={resetShortcutsToDefault}
                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset all shortcuts</span>
                  </button>
                </div>

                {Object.entries(shortcutCategories).map(([category, items]) => (
                  <div
                    key={category}
                    className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden"
                  >
                    <div className="border-b border-white/5 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-slate-300">
                      {category}
                    </div>
                    <div className="divide-y divide-white/5">
                      {items.map((item) => {
                        const isEditing = editingShortcutId === item.id;
                        return (
                          <div
                            key={item.id}
                            className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.03] transition"
                          >
                            <div className="min-w-0 pr-4">
                              <div className="text-xs font-medium text-white">{item.label}</div>
                              <div className="text-[11px] text-slate-400 truncate">
                                {item.description}
                              </div>
                            </div>

                            <div>
                              {isEditing ? (
                                <button
                                  type="button"
                                  ref={(el) => {
                                    if (el) el.focus();
                                  }}
                                  data-shortcut-recorder="true"
                                  onKeyDown={(e) => handleShortcutKeyDown(e, item.id)}
                                  onKeyUp={handleShortcutKeyUp}
                                  onBlur={() => {
                                    setEditingShortcutId(null);
                                    setRecordedKeys('');
                                  }}
                                  className="group flex items-center gap-2 px-3 py-1 rounded-lg border border-cyan-400 bg-cyan-500/20 text-xs font-mono text-cyan-200 outline-none shadow-[0_0_12px_rgba(34,211,238,0.25)] select-none cursor-pointer"
                                >
                                  <span className="animate-pulse">
                                    {recordedKeys ? `${recordedKeys} + …` : 'Press shortcut keys…'}
                                  </span>
                                  <span
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setEditingShortcutId(null);
                                      setRecordedKeys('');
                                    }}
                                    className="text-[10px] text-slate-400 hover:text-white underline cursor-pointer ml-1"
                                    title="Cancel shortcut rebinding"
                                  >
                                    (Esc)
                                  </span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingShortcutId(item.id);
                                    setRecordedKeys('');
                                  }}
                                  title="Click to rebind"
                                  className="group flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10 transition cursor-pointer"
                                >
                                  <kbd className="font-mono text-xs font-semibold text-slate-200 group-hover:text-cyan-300 transition">
                                    {item.keys}
                                  </kbd>
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: APPEARANCE & THEMES */}
          {activeTab === 'appearance' && (
            <div className="space-y-6">
              {/* Font Size & Line Height */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-300 flex items-center gap-2">
                    <Type className="h-4 w-4 text-cyan-400" />
                    <span>Terminal Font Size</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={fontSize <= 10}
                      onClick={() => onFontSizeChange(Math.max(10, fontSize - 1))}
                      className="p-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white disabled:opacity-40"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="font-mono text-sm font-semibold text-white min-w-[48px] text-center">
                      {fontSize}px
                    </span>
                    <button
                      type="button"
                      disabled={fontSize >= 28}
                      onClick={() => onFontSizeChange(Math.min(28, fontSize + 1))}
                      className="p-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white disabled:opacity-40"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Rows2 className="h-4 w-4 text-fuchsia-400" />
                      <span>Line Height</span>
                    </span>
                    <span className="font-mono text-xs text-fuchsia-300">{lineHeight.toFixed(2)}</span>
                  </label>
                  <input
                    type="range"
                    min="1.0"
                    max="1.6"
                    step="0.05"
                    value={lineHeight}
                    onChange={(e) => onLineHeightChange(parseFloat(e.target.value))}
                    className="w-full nx-range"
                  />
                </div>
              </div>

              {/* Workspace Layout Elements (Desktop only) */}
              {!mobile && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-white">Layout Elements</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div
                      onClick={() => onShowRailChange(!showRail)}
                      className={cn(
                        'flex items-center justify-between rounded-xl border p-3 cursor-pointer transition select-none',
                        showRail ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
                      )}
                    >
                      <span className="text-xs font-medium text-white">Left Icon Rail</span>
                      <ToggleSwitch
                        checked={showRail}
                        onChange={onShowRailChange}
                        accentColor={accentColor}
                      />
                    </div>
                    <div
                      onClick={() => onShowStatusBarChange(!showStatusBar)}
                      className={cn(
                        'flex items-center justify-between rounded-xl border p-3 cursor-pointer transition select-none',
                        showStatusBar ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
                      )}
                    >
                      <span className="text-xs font-medium text-white">Bottom Status Bar</span>
                      <ToggleSwitch
                        checked={showStatusBar}
                        onChange={onShowStatusBarChange}
                        accentColor={accentColor}
                      />
                    </div>
                    <div
                      onClick={() => onZenChange(!zen)}
                      className={cn(
                        'flex items-center justify-between rounded-xl border p-3 cursor-pointer transition select-none',
                        zen ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
                      )}
                    >
                      <span className="text-xs font-medium text-white">Zen Mode (Fullscreen)</span>
                      <ToggleSwitch
                        checked={zen}
                        onChange={onZenChange}
                        accentColor={accentColor}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Themes Gallery */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-white">Color Themes ({THEMES.length})</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                  {THEMES.map((t) => {
                    const isSelected = t.id === themeId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onThemeSelect(t.id)}
                        className={cn(
                          'flex flex-col text-left rounded-xl border p-2.5 transition relative overflow-hidden',
                          isSelected
                            ? 'border-cyan-400 bg-white/10 shadow-lg'
                            : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20'
                        )}
                        style={{ backgroundColor: t.xterm.background || '#0e131d' }}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-white truncate">{t.name}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 text-cyan-400 shrink-0" />}
                        </div>
                        {/* Swatch dots */}
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-3 w-3 rounded-full border border-black/40"
                            style={{ backgroundColor: t.accent }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40"
                            style={{ backgroundColor: t.xterm.cyan || '#22d3ee' }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40"
                            style={{ backgroundColor: t.xterm.green || '#10b981' }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40"
                            style={{ backgroundColor: t.xterm.yellow || '#f59e0b' }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40"
                            style={{ backgroundColor: t.xterm.red || '#ef4444' }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: SECURITY & VAULT */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              {/* Vault Status Header */}
              <div
                className="rounded-xl border p-4 sm:p-5 relative overflow-hidden"
                style={{
                  backgroundColor: `${accentColor}10`,
                  borderColor: `${accentColor}30`,
                }}
              >
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <Shield className="h-6 w-6" style={{ color: accentColor }} />
                    <div>
                      <h4 className="text-sm font-semibold text-white">
                        AES-256 SQLCipher & Argon2id Vault
                      </h4>
                      <p className="text-xs text-slate-400">
                        Zero-knowledge local encrypted database protecting SSH credentials and host keys
                      </p>
                    </div>
                  </div>

                  {onLockVault && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onLockVault();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-400/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-xs font-semibold transition"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      <span>Lock Vault Now</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Direct Launch / Auto-Unlock on Startup */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                        <Zap className="h-4 w-4" style={{ color: accentColor }} />
                        <span>Direct Launch (Bypass Master Password)</span>
                      </h3>
                      {directUnlockEnabled ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          Enabled
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-white/5 text-slate-400 border border-white/10">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed max-w-xl">
                      Automatically unlock your vault and navigate directly into the terminal workspace on application startup without prompting for authorization or your master password.
                    </p>
                    {directUnlockEnabled ? (
                      <div className="flex items-center gap-1.5 pt-1 text-[11px] text-amber-400/90">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Direct launch is active. Anyone with physical access to your device can launch your sessions.</span>
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-500 pt-1">
                        Master password or biometric authorization is required every time the application starts.
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 pt-0.5">
                    <ToggleSwitch
                      checked={directUnlockEnabled}
                      onChange={handleToggleDirectUnlock}
                      accentColor={accentColor}
                      ariaLabel="Toggle Direct Launch on startup"
                    />
                  </div>
                </div>
              </div>

              {/* Security Preferences */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <h3 className="text-sm font-semibold text-white">Auto-Lock Protection</h3>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="text-xs font-medium text-slate-200">Vault Inactivity Timeout</div>
                    <div className="text-[11px] text-slate-400">
                      Automatically lock the vault and purge decrypted private keys from RAM when idle
                    </div>
                  </div>

                  <div className="w-full sm:w-56 shrink-0">
                    <CustomSelect
                      value={autoLockMinutes}
                      onChange={(val) => onAutoLockChange(Number(val))}
                      options={[
                        { value: 0, label: 'Never (Manual Lock Only)' },
                        { value: 5, label: '5 minutes' },
                        { value: 15, label: '15 minutes (Recommended)' },
                        { value: 30, label: '30 minutes' },
                        { value: 60, label: '1 hour' },
                      ]}
                      theme={activeTheme}
                      accentColor={accentColor}
                    />
                  </div>
                </div>
              </div>

              {/* Storage Permissions */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <FolderLock className="h-4 w-4 text-cyan-400" />
                      <span>Shared Storage & Permissions</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Required for SFTP downloads to device storage and file transfers
                    </p>
                  </div>

                  {onRequestStoragePermission && (
                    <button
                      type="button"
                      onClick={onRequestStoragePermission}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition"
                    >
                      <span>
                        {storageGranted === true ? 'Permissions Granted ✔' : 'Manage Permissions'}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: SYNC & INTEGRATIONS */}
          {activeTab === 'sync' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <h3 className="text-sm font-semibold text-white">Synchronization & Mesh Networks</h3>
                <p className="text-xs text-slate-400">
                  Connect Drexius across your phone, tablet, and desktops with zero-knowledge encryption
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  {onOpenPairing && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenPairing();
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
                    >
                      <div className="flex items-center gap-3">
                        <QrCode className="h-5 w-5 text-amber-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">Direct LAN Device Pairing</div>
                          <div className="text-[11px] text-slate-400">Pair via QR code or PIN</div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  )}

                  {onOpenSync && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenSync();
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
                    >
                      <div className="flex items-center gap-3">
                        <Cloud className="h-5 w-5 text-cyan-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">Encrypted Relay Sync</div>
                          <div className="text-[11px] text-slate-400">Self-hosted or hosted relay sync</div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  )}

                  {onOpenTailscale && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenTailscale();
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
                    >
                      <div className="flex items-center gap-3">
                        <Network className="h-5 w-5 text-indigo-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">Tailscale Mesh Discovery</div>
                          <div className="text-[11px] text-slate-400">Auto-discover tailnet nodes</div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  )}

                  {onOpenNetbird && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenNetbird();
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
                    >
                      <div className="flex items-center gap-3">
                        <Globe2 className="h-5 w-5 text-emerald-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">NetBird Mesh Network</div>
                          <div className="text-[11px] text-slate-400">Sync peers from NetBird</div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  )}

                  {onOpenCloudSync && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenCloudSync();
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
                    >
                      <div className="flex items-center gap-3">
                        <Cloud className="h-5 w-5 text-sky-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">Cloud Fleet Sync</div>
                          <div className="text-[11px] text-slate-400">Hetzner, DigitalOcean & Proxmox</div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  )}

                  {onOpenDocker && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenDocker();
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition"
                    >
                      <div className="flex items-center gap-3">
                        <Boxes className="h-5 w-5 text-cyan-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">Docker Containers</div>
                          <div className="text-[11px] text-slate-400">Container management & logs</div>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {mobile && (
            <div className="pt-4 pb-6 text-center select-none">
              <span className="text-[11px] text-slate-500 font-mono tracking-wide">
                Drexius Terminal v0.1.0
              </span>
            </div>
          )}
        </div>

        {/* Footer (Desktop only) */}
        {!mobile && (
          <div className="border-t border-white/10 px-4 sm:px-6 py-3 bg-white/[0.02] flex items-center justify-between">
            <div className="text-[11px] text-slate-500 font-mono">
              Drexius Terminal v0.1.0
            </div>

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold text-black hover:brightness-110 active:scale-95 transition shadow"
              style={{ backgroundColor: accentColor }}
            >
              Done
            </button>
          </div>
        )}

        {/* Master Password Verification Modal for Direct Launch */}
        {showDirectUnlockModal && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            onClick={() => !directUnlockBusy && setShowDirectUnlockModal(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md rounded-2xl border bg-slate-950 p-6 shadow-2xl text-slate-200 space-y-5"
              style={{
                borderColor: `${accentColor}40`,
                boxShadow: `0 20px 50px rgba(0, 0, 0, 0.8), 0 0 30px ${accentColor}15`,
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                    style={{
                      backgroundColor: `${accentColor}15`,
                      borderColor: `${accentColor}30`,
                      color: accentColor,
                    }}
                  >
                    <KeyRound className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">
                      {targetDirectUnlockState ? 'Enable Direct Launch' : 'Disable Direct Launch'}
                    </h3>
                    <p className="text-xs text-slate-400">
                      Master password verification required
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={directUnlockBusy}
                  onClick={() => setShowDirectUnlockModal(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-300 leading-relaxed">
                {targetDirectUnlockState ? (
                  <span>
                    You are about to enable <strong>Direct Launch</strong>. NexusTerminal will store credentials in this device's secure vault and open directly into your workspace on startup without authorization.
                  </span>
                ) : (
                  <span>
                    Disabling <strong>Direct Launch</strong> will remove stored startup credentials from this device. You will be required to enter your master password to unlock NexusTerminal on startup.
                  </span>
                )}
              </div>

              <form onSubmit={handleConfirmDirectUnlock} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">
                    Confirm Master Password
                  </label>
                  <div className="relative">
                    <input
                      ref={directPwInputRef}
                      type={showDirectUnlockPw ? 'text' : 'password'}
                      value={directUnlockPw}
                      onChange={(e) => setDirectUnlockPw(e.target.value)}
                      placeholder="Enter master password"
                      autoFocus
                      disabled={directUnlockBusy}
                      className="w-full rounded-xl border border-white/15 bg-black/60 px-3.5 py-2.5 pr-10 text-xs text-white placeholder:text-slate-500 focus:outline-none transition"
                      style={{
                        borderColor: directUnlockErr ? '#f43f5e' : undefined,
                      }}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowDirectUnlockPw((prev) => !prev)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200 transition"
                    >
                      {showDirectUnlockPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>

                  {directUnlockErr && (
                    <div className="flex items-center gap-1.5 text-xs text-rose-400 pt-1">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>{directUnlockErr}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    disabled={directUnlockBusy}
                    onClick={() => setShowDirectUnlockModal(false)}
                    className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-300 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={directUnlockBusy || !directUnlockPw}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
                    style={{
                      backgroundColor: targetDirectUnlockState ? accentColor : '#f43f5e',
                      color: targetDirectUnlockState ? '#000000' : '#ffffff',
                    }}
                  >
                    {directUnlockBusy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Verifying...</span>
                      </>
                    ) : (
                      <span>{targetDirectUnlockState ? 'Verify & Enable' : 'Verify & Disable'}</span>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </ResponsiveOverlay>
  );
}
