import { useState, useMemo } from 'react';
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
} from 'lucide-react';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import {
  type UiPreferences,
  type ShortcutBinding,
  DEFAULT_UI_PREFERENCES,
  DEFAULT_SHORTCUTS,
} from '../lib/settings';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { CustomSelect } from './CustomSelect';
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

type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'security' | 'sync';

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
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);

  const activeTheme =
    theme || THEMES.find((t) => t.id === themeId) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const updatePref = <K extends keyof UiPreferences>(key: K, val: UiPreferences[K]) => {
    const next = { ...uiPrefs, [key]: val };
    onUiPrefsChange(next);
  };

  const handleShortcutKeyDown = (e: React.KeyboardEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();

    // Ignore solitary modifier presses
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    if (e.key === 'Escape') {
      setEditingShortcutId(null);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let keyPart = e.key;
    if (keyPart === ' ') keyPart = 'Space';
    else if (keyPart.length === 1) keyPart = keyPart.toUpperCase();

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
    toast(`Shortcut updated: ${shortcuts[id]?.label} → ${newKeyCombo}`);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 max-md:p-0 max-md:items-end backdrop-blur-sm"
      onClose={onClose}
      label="General Settings"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-3xl max-h-[85vh] max-md:max-h-[92dvh] rounded-2xl border shadow-2xl overflow-hidden text-slate-200"
        style={
          {
            backgroundColor: bgColor,
            borderColor: `${accentColor}30`,
            '--nx-accent': accentColor,
          } as React.CSSProperties
        }
      >
        <SheetHandle onClose={onClose} />

        {/* Ambient Top Glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-20"
          style={{
            background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)`,
          }}
        />

        {/* Header */}
        <div className="relative border-b border-white/10 px-4 sm:px-6 py-3.5 shrink-0 bg-white/[0.02]">
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
                    General Settings
                  </h2>
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
                </div>
                <p className="text-xs text-slate-400">
                  Configure UI visibility, keyboard splits, terminal behavior, and security
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition"
              title="Close Settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-1.5 mt-3.5 overflow-x-auto no-scrollbar">
            {[
              { id: 'general', label: 'UI Customization', icon: Sliders },
              { id: 'shortcuts', label: 'Shortcuts & Splits', icon: Keyboard },
              { id: 'appearance', label: 'Appearance & Themes', icon: Palette },
              { id: 'security', label: 'Security & Vault', icon: Shield },
              { id: 'sync', label: 'Sync & Integrations', icon: RefreshCw },
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as SettingsTab)}
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
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* TAB 1: UI CUSTOMIZATION & GENERAL */}
          {activeTab === 'general' && (
            <div className="space-y-6">
              {/* Feature Visibility Toggles */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      UI Element Visibility
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Hide features you do not use for a clean, minimal terminal workspace (like Ghostty)
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
                  <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer transition">
                    <input
                      type="checkbox"
                      checked={uiPrefs.showSerial}
                      onChange={(e) => updatePref('showSerial', e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Radio className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-xs font-semibold text-white">Hardware Serial Terminal</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        UART & RS-232 connection button in toolbar and hosts sidebar
                      </p>
                    </div>
                  </label>

                  {/* Docker Toggle */}
                  <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer transition">
                    <input
                      type="checkbox"
                      checked={uiPrefs.showDocker}
                      onChange={(e) => updatePref('showDocker', e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Boxes className="h-3.5 w-3.5 text-cyan-400" />
                        <span className="text-xs font-semibold text-white">Docker Containers</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Container explorer and logs monitor in top bar and rail
                      </p>
                    </div>
                  </label>

                  {/* AI Assistant Toggle */}
                  <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer transition">
                    <input
                      type="checkbox"
                      checked={uiPrefs.showAi}
                      onChange={(e) => updatePref('showAi', e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />
                        <span className="text-xs font-semibold text-white">AI Copilot Assistant</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Multi-provider AI relay workspace side drawer
                      </p>
                    </div>
                  </label>

                  {/* SFTP Toggle */}
                  <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer transition">
                    <input
                      type="checkbox"
                      checked={uiPrefs.showSftp}
                      onChange={(e) => updatePref('showSftp', e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-xs font-semibold text-white">SFTP File Browser</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Dual-pane graphical SFTP browser button in title bar
                      </p>
                    </div>
                  </label>

                  {/* Snippets Toggle */}
                  <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer transition">
                    <input
                      type="checkbox"
                      checked={uiPrefs.showSnippets}
                      onChange={(e) => updatePref('showSnippets', e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Code2 className="h-3.5 w-3.5 text-indigo-400" />
                        <span className="text-xs font-semibold text-white">Snippets & Scripts</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Quick script snippets manager in sidebar rail
                      </p>
                    </div>
                  </label>

                  {/* Tunnels Toggle */}
                  <label className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 hover:bg-white/[0.04] cursor-pointer transition">
                    <input
                      type="checkbox"
                      checked={uiPrefs.showTunnels}
                      onChange={(e) => updatePref('showTunnels', e.target.checked)}
                      className="mt-0.5 rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Network className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-xs font-semibold text-white">Port Forwarding & Tunnels</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Local, remote, and dynamic SOCKS5 tunnel manager
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Terminal Behavior */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <h3 className="text-sm font-semibold text-white">
                  Terminal Behavior & Emulation
                </h3>

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
                    <label className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 cursor-pointer">
                      <span className="text-xs text-slate-300">Blinking Cursor</span>
                      <input
                        type="checkbox"
                        checked={uiPrefs.cursorBlink}
                        onChange={(e) => updatePref('cursorBlink', e.target.checked)}
                        className="rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                      />
                    </label>
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
                    <label className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 cursor-pointer">
                      <span className="text-xs text-slate-300">Confirm before closing active panes</span>
                      <input
                        type="checkbox"
                        checked={uiPrefs.confirmClosePane}
                        onChange={(e) => updatePref('confirmClosePane', e.target.checked)}
                        className="rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: SHORTCUTS & SPLIT NAVIGATION */}
          {activeTab === 'shortcuts' && (
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
                      Directional Split Navigation (Ghostty / tmux style)
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
                                <div
                                  tabIndex={0}
                                  autoFocus
                                  onKeyDown={(e) => handleShortcutKeyDown(e, item.id)}
                                  onBlur={() => setEditingShortcutId(null)}
                                  className="px-3 py-1 rounded-lg border border-cyan-400 bg-cyan-500/20 text-xs font-mono text-cyan-200 animate-pulse outline-none cursor-pointer"
                                >
                                  Press new shortcut keys… (Esc to cancel)
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setEditingShortcutId(item.id)}
                                  title="Click to rebind"
                                  className="group flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10 transition"
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

              {/* Workspace Layout Elements */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <h3 className="text-sm font-semibold text-white">Layout Elements</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] p-3 cursor-pointer">
                    <span className="text-xs text-slate-300">Left Icon Rail</span>
                    <input
                      type="checkbox"
                      checked={showRail}
                      onChange={(e) => onShowRailChange(e.target.checked)}
                      className="rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] p-3 cursor-pointer">
                    <span className="text-xs text-slate-300">Bottom Status Bar</span>
                    <input
                      type="checkbox"
                      checked={showStatusBar}
                      onChange={(e) => onShowStatusBarChange(e.target.checked)}
                      className="rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] p-3 cursor-pointer">
                    <span className="text-xs text-slate-300">Zen Mode (Fullscreen)</span>
                    <input
                      type="checkbox"
                      checked={zen}
                      onChange={(e) => onZenChange(e.target.checked)}
                      className="rounded border-white/20 text-cyan-500 focus:ring-0 cursor-pointer"
                    />
                  </label>
                </div>
              </div>

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
                      dropUp={true}
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
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 px-4 sm:px-6 py-3 bg-white/[0.02] flex items-center justify-between">
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            <span>Drexius Terminal v0.1.0</span>
            <span>·</span>
            <span>Tauri 2 + React 19 + xterm.js 6</span>
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
      </div>
    </ResponsiveOverlay>
  );
}
