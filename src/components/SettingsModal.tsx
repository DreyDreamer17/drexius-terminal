import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Palette,
  RefreshCw,
  Settings,
  Shield,
  Sliders,
  Terminal,
  X,
} from 'lucide-react';
import { useMobile } from '../hooks/useMobile';
import type { ShortcutBinding, UiPreferences } from '../lib/settings';
import { THEMES, loadCustomThemes, type DrexiusTheme } from '../lib/themes';
import { cn } from '../utils/cn';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { AppearanceSettingsTab } from './settings/AppearanceSettingsTab';
import { GeneralAndTerminalTab } from './settings/GeneralAndTerminalTab';
import { SecuritySettingsTab, SyncSettingsTab } from './settings/SecurityAndSyncTabs';
import { ShortcutsSettingsTab } from './settings/ShortcutsSettingsTab';

interface Props {
  initialTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
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
  onOpenPairing?: (tab?: SettingsTab) => void;
  onOpenSync?: (tab?: SettingsTab) => void;
  onOpenTailscale?: (tab?: SettingsTab) => void;
  onOpenNetbird?: (tab?: SettingsTab) => void;
  onOpenCloudSync?: (tab?: SettingsTab) => void;
  onOpenDocker?: (tab?: SettingsTab) => void;
  onOpenKeychain?: (tab?: SettingsTab) => void;
  onOpenTunnels?: (tab?: SettingsTab) => void;
  onOpenLogs?: (tab?: SettingsTab) => void;
  onOpenKnownHosts?: (tab?: SettingsTab) => void;
  onLockVault?: () => void;
  storageGranted?: boolean | null;
  onRequestStoragePermission?: () => void;
  toast: (msg: string) => void;
}

export type SettingsTab = 'general' | 'shortcuts' | 'appearance' | 'security' | 'sync' | 'terminal';

export function SettingsModal({
  initialTab,
  onTabChange,
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
  onOpenKeychain,
  onOpenTunnels,
  onOpenLogs,
  onOpenKnownHosts,
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

  const [activeTab, setActiveTab] = useState<SettingsTab>(
    () => initialTab ?? (mobile ? 'appearance' : 'general')
  );

  useEffect(() => {
    if (initialTab && initialTab !== activeTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  const handleTabChange = (tab: SettingsTab) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  useEffect(() => {
    if (mobile && (activeTab === 'general' || activeTab === 'shortcuts')) {
      setActiveTab('appearance');
    }
  }, [mobile]);

  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeBtn = tabListRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]');
    activeBtn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  const [customThemes, setCustomThemes] = useState<DrexiusTheme[]>(() => loadCustomThemes());
  useEffect(() => {
    const handler = () => setCustomThemes(loadCustomThemes());
    window.addEventListener('drx:themes-changed', handler);
    return () => window.removeEventListener('drx:themes-changed', handler);
  }, []);

  const allThemes = useMemo(() => [...THEMES, ...customThemes], [customThemes]);

  const activeTheme = theme || allThemes.find((t) => t.id === themeId) || allThemes[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  return (
    <ResponsiveOverlay
      portal
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm',
        mobile ? '!p-0 !items-stretch !justify-stretch !inset-0 !top-0 !h-[100dvh]' : 'p-4'
      )}
      onClose={onClose}
      label="General Settings"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          'relative flex flex-col w-full text-slate-200 overflow-hidden shadow-2xl transition-all',
          mobile
            ? 'h-[100dvh] max-h-[100dvh] rounded-none border-none'
            : 'nx-sheet max-w-4xl max-h-[85vh] rounded-2xl border'
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
        <div
          className={cn(
            'relative border-b border-white/10 shrink-0 bg-white/[0.02]',
            mobile ? 'px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-3' : 'px-4 sm:px-6 py-3.5'
          )}
        >
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
                  <h2 className="text-base sm:text-lg font-semibold tracking-wide text-white">Settings</h2>
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
                    handleTabChange(tab.id);
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
        <div
          className={cn(
            'flex-1 overflow-y-auto',
            mobile
              ? 'p-4 space-y-4 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))]'
              : 'p-4 sm:p-6 space-y-6'
          )}
        >
          {/* TAB 1: UI CUSTOMIZATION (DESKTOP) & TERMINAL BEHAVIOR (BOTH) */}
          {(activeTab === 'general' || activeTab === 'terminal') && (
            <GeneralAndTerminalTab
              mobile={mobile}
              uiPrefs={uiPrefs}
              onUiPrefsChange={onUiPrefsChange}
              activeTheme={activeTheme}
              accentColor={accentColor}
              onClose={onClose}
              onOpenLogs={onOpenLogs}
              toast={toast}
            />
          )}

          {/* TAB 2: SHORTCUTS & SPLIT NAVIGATION (DESKTOP ONLY) */}
          {!mobile && activeTab === 'shortcuts' && (
            <ShortcutsSettingsTab
              shortcuts={shortcuts}
              onShortcutsChange={onShortcutsChange}
              accentColor={accentColor}
              toast={toast}
            />
          )}

          {/* TAB 3: APPEARANCE & THEMES */}
          {activeTab === 'appearance' && (
            <AppearanceSettingsTab
              mobile={mobile}
              themeId={themeId}
              onThemeSelect={onThemeSelect}
              allThemes={allThemes}
              customThemes={customThemes}
              activeTheme={activeTheme}
              accentColor={accentColor}
              fontSize={fontSize}
              onFontSizeChange={onFontSizeChange}
              lineHeight={lineHeight}
              onLineHeightChange={onLineHeightChange}
              zen={zen}
              onZenChange={onZenChange}
              showRail={showRail}
              onShowRailChange={onShowRailChange}
              showStatusBar={showStatusBar}
              onShowStatusBarChange={onShowStatusBarChange}
              uiPrefs={uiPrefs}
              onUiPrefsChange={onUiPrefsChange}
              toast={toast}
            />
          )}

          {/* TAB 4: SECURITY & VAULT */}
          {activeTab === 'security' && (
            <SecuritySettingsTab
              activeTheme={activeTheme}
              accentColor={accentColor}
              autoLockMinutes={autoLockMinutes}
              onAutoLockChange={onAutoLockChange}
              onClose={onClose}
              onLockVault={onLockVault}
              onOpenKeychain={onOpenKeychain}
              onOpenKnownHosts={onOpenKnownHosts}
              onOpenLogs={onOpenLogs}
              storageGranted={storageGranted}
              onRequestStoragePermission={onRequestStoragePermission}
              toast={toast}
            />
          )}

          {/* TAB 5: SYNC & INTEGRATIONS */}
          {activeTab === 'sync' && (
            <SyncSettingsTab
              onClose={onClose}
              onOpenPairing={onOpenPairing}
              onOpenSync={onOpenSync}
              onOpenTunnels={onOpenTunnels}
              onOpenTailscale={onOpenTailscale}
              onOpenNetbird={onOpenNetbird}
              onOpenCloudSync={onOpenCloudSync}
              onOpenDocker={onOpenDocker}
            />
          )}

          {mobile && (
            <div className="pt-4 pb-6 text-center select-none">
              <span className="text-[11px] text-slate-500 font-mono tracking-wide">
                Drexius Terminal v0.4.0
              </span>
            </div>
          )}
        </div>

        {/* Footer (Desktop only) */}
        {!mobile && (
          <div className="border-t border-white/10 px-4 sm:px-6 py-3 bg-white/[0.02] flex items-center justify-between">
            <div className="text-[11px] text-slate-500 font-mono">Drexius Terminal v0.4.0</div>

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
      </div>
    </ResponsiveOverlay>
  );
}
