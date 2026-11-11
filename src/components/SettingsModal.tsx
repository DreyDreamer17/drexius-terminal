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
  Search,
  Copy,
  Download,
  Activity,
  ShieldCheck,
  History,
  Timer,
  Ban,
  Upload,
  Trash2,
  Image as ImageIcon,
  Layers,
  Sparkle,
} from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';
import { TERMINAL_FONT_MIN } from '../lib/mobileTerminal';
import {
  THEMES,
  loadCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  exportThemeJson,
  importThemeFromText,
  hexToRgba,
  type DrexiusTheme,
} from '../lib/themes';
import {
  type UiPreferences,
  type ShortcutBinding,
  POPULAR_TERMINAL_FONTS,
  FONT_WEIGHT_OPTIONS,
  resolveTerminalFontFamily,
  DEFAULT_UI_PREFERENCES,
  DEFAULT_SHORTCUTS,
  BUILTIN_SHORTCUTS,
  findShortcutConflict,
  applyShortcutOverride,
  isShortcutUnbound,
} from '../lib/settings';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { CustomSelect } from './CustomSelect';
import { ToggleSwitch } from './ToggleSwitch';
import { cn } from '../utils/cn';

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

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => initialTab ?? (mobile ? 'appearance' : 'general'));

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

  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string>('');
  // Kept while the recorder is open after a clash, so the user can read what is in the way and
  // choose to override (rebindable clash) or dismiss (built-in clash) instead of losing the
  // attempt to a transient toast.
  const [conflict, setConflict] = useState<{ id: string; combo: string; clashLabel: string; builtin: boolean } | null>(null);

  const closeRecorder = () => {
    setEditingShortcutId(null);
    setRecordedKeys('');
    setConflict(null);
  };
  const tabListRef = useRef<HTMLDivElement>(null);

  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [revealRecovery, setRevealRecovery] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [downloadedRecoveryPath, setDownloadedRecoveryPath] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [regeneratingRecovery, setRegeneratingRecovery] = useState(false);

  useEffect(() => {
    if (activeTab === 'security') {
      bridge.vaultGetRecoveryKey().then(setRecoveryKey).catch(() => {});
    }
  }, [activeTab]);

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

  const activeTheme =
    theme || allThemes.find((t) => t.id === themeId) || allThemes[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0f141f';

  const [themeSearch, setThemeSearch] = useState('');
  const [themeFilter, setThemeFilter] = useState<'all' | 'dark' | 'light' | 'vibrant' | 'custom'>('all');

  const filteredThemes = useMemo(() => {
    return allThemes.filter((t) => {
      if (themeFilter === 'custom' && !t.isCustom) return false;
      if (themeFilter === 'light' && !t.isLight) return false;
      if (themeFilter === 'dark' && t.isLight) return false;
      if (themeFilter === 'vibrant' && !['cyberpunk', 'synthwave', 'matrix', 'homebrew', 'aurora', 'retro-amber', 'cobalt2'].includes(t.id)) return false;
      if (themeSearch.trim()) {
        const q = themeSearch.toLowerCase().trim();
        return t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [allThemes, themeSearch, themeFilter]);

  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const [showThemeCreator, setShowThemeCreator] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);

  // Form fields for Custom Theme Creator
  const [creatorName, setCreatorName] = useState('');
  const [creatorAccent, setCreatorAccent] = useState('#22d3ee');
  const [creatorBg, setCreatorBg] = useState('#0a0d14');
  const [creatorFg, setCreatorFg] = useState('#d6deeb');
  const [creatorCursor, setCreatorCursor] = useState('#22d3ee');
  const [creatorSelection, setCreatorSelection] = useState('#22d3ee33');
  const [creatorIsLight, setCreatorIsLight] = useState(false);
  const [creatorAnsi, setCreatorAnsi] = useState({
    black: '#1b2130', red: '#ff5f7e', green: '#4ade80', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d6deeb',
    brightBlack: '#4b5468', brightRed: '#ff8aa1', brightGreen: '#86efac', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  });

  const handleOpenThemeCreator = (existing?: DrexiusTheme) => {
    if (existing) {
      setEditingThemeId(existing.id);
      setCreatorName(existing.name);
      setCreatorAccent(existing.accent || '#22d3ee');
      setCreatorBg(existing.xterm.background || '#0a0d14');
      setCreatorFg(existing.xterm.foreground || '#d6deeb');
      setCreatorCursor(existing.xterm.cursor || existing.accent || '#22d3ee');
      setCreatorSelection(existing.xterm.selectionBackground || `${existing.accent}33`);
      setCreatorIsLight(!!existing.isLight);
      setCreatorAnsi({
        black: existing.xterm.black || '#1b2130',
        red: existing.xterm.red || '#ff5f7e',
        green: existing.xterm.green || '#4ade80',
        yellow: existing.xterm.yellow || '#fbbf24',
        blue: existing.xterm.blue || '#60a5fa',
        magenta: existing.xterm.magenta || '#c084fc',
        cyan: existing.xterm.cyan || '#22d3ee',
        white: existing.xterm.white || '#d6deeb',
        brightBlack: existing.xterm.brightBlack || '#4b5468',
        brightRed: existing.xterm.brightRed || '#ff8aa1',
        brightGreen: existing.xterm.brightGreen || '#86efac',
        brightYellow: existing.xterm.brightYellow || '#fde68a',
        brightBlue: existing.xterm.brightBlue || '#93c5fd',
        brightMagenta: existing.xterm.brightMagenta || '#d8b4fe',
        brightCyan: existing.xterm.brightCyan || '#67e8f9',
        brightWhite: existing.xterm.brightWhite || '#ffffff',
      });
    } else {
      setEditingThemeId(null);
      setCreatorName(`Custom Theme ${customThemes.length + 1}`);
      setCreatorAccent(activeTheme.accent || '#22d3ee');
      setCreatorBg(activeTheme.xterm.background || '#0a0d14');
      setCreatorFg(activeTheme.xterm.foreground || '#d6deeb');
      setCreatorCursor(activeTheme.xterm.cursor || activeTheme.accent || '#22d3ee');
      setCreatorSelection(activeTheme.xterm.selectionBackground || '#22d3ee33');
      setCreatorIsLight(!!activeTheme.isLight);
      setCreatorAnsi({
        black: activeTheme.xterm.black || '#1b2130',
        red: activeTheme.xterm.red || '#ff5f7e',
        green: activeTheme.xterm.green || '#4ade80',
        yellow: activeTheme.xterm.yellow || '#fbbf24',
        blue: activeTheme.xterm.blue || '#60a5fa',
        magenta: activeTheme.xterm.magenta || '#c084fc',
        cyan: activeTheme.xterm.cyan || '#22d3ee',
        white: activeTheme.xterm.white || '#d6deeb',
        brightBlack: activeTheme.xterm.brightBlack || '#4b5468',
        brightRed: activeTheme.xterm.brightRed || '#ff8aa1',
        brightGreen: activeTheme.xterm.brightGreen || '#86efac',
        brightYellow: activeTheme.xterm.brightYellow || '#fde68a',
        brightBlue: activeTheme.xterm.brightBlue || '#93c5fd',
        brightMagenta: activeTheme.xterm.brightMagenta || '#d8b4fe',
        brightCyan: activeTheme.xterm.brightCyan || '#67e8f9',
        brightWhite: activeTheme.xterm.brightWhite || '#ffffff',
      });
    }
    setShowThemeCreator(true);
  };

  const handleSaveTheme = () => {
    if (!creatorName.trim()) {
      toast('Please enter a theme name');
      return;
    }
    const themeIdToSave = editingThemeId || `custom-${creatorName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
    const newTheme: DrexiusTheme = {
      id: themeIdToSave,
      name: creatorName.trim(),
      accent: creatorAccent,
      isLight: creatorIsLight,
      isCustom: true,
      xterm: {
        background: creatorBg,
        foreground: creatorFg,
        cursor: creatorCursor,
        cursorAccent: creatorBg,
        selectionBackground: creatorSelection,
        ...creatorAnsi,
      },
    };
    saveCustomTheme(newTheme);
    onThemeSelect(newTheme.id);
    setShowThemeCreator(false);
    toast(`Saved "${newTheme.name}"`);
  };

  const handleDeleteTheme = (id: string, name: string) => {
    deleteCustomTheme(id);
    if (themeId === id) {
      onThemeSelect('drexius');
    }
    toast(`Deleted "${name}"`);
  };

  const handleExportCurrentTheme = () => {
    const json = exportThemeJson(activeTheme);
    navigator.clipboard?.writeText(json).then(() => {
      toast(`Exported "${activeTheme.name}" to clipboard`);
    }).catch(() => {});

    // Also download file
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeTheme.id || 'theme'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const handleImportTheme = () => {
    if (!importText.trim()) {
      toast('Please paste theme configuration text');
      return;
    }
    const imported = importThemeFromText(importText);
    if (!imported) {
      toast('Could not parse theme format. Check JSON syntax.');
      return;
    }
    saveCustomTheme(imported);
    onThemeSelect(imported.id);
    setShowImportModal(false);
    setImportText('');
    toast(`Imported and applied "${imported.name}"`);
  };

  const handleWallpaperFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('Wallpaper image must be smaller than 8MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      updatePrefs({
        terminalWallpaper: result,
        terminalBlur: uiPrefs.terminalBlur || 8,
        terminalOpacity: (uiPrefs.terminalOpacity ?? 1) >= 1 ? 0.75 : uiPrefs.terminalOpacity,
      });
      toast('Terminal wallpaper applied with frosted liquid glass');
    };
    reader.readAsDataURL(file);
  };

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
        toast('Direct Launch enabled: Drexius will open directly on launch.');
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

  const updatePrefs = (patch: Partial<UiPreferences>) => {
    const next = { ...uiPrefs, ...patch };
    onUiPrefsChange(next);
  };

  const handleShortcutKeyDown = (e: React.KeyboardEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      closeRecorder();
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

    // Two actions on one key would both fire, or one would silently shadow the other.
    // Keep the recorder open and show an inline conflict with an explicit override choice
    // (issue #26) rather than discarding the attempt through a transient toast.
    const clash = findShortcutConflict(shortcuts, id, newKeyCombo);
    if (clash) {
      setConflict({
        id,
        combo: newKeyCombo,
        clashLabel: clash,
        builtin: clash.endsWith('(built-in)'),
      });
      return;
    }

    const next = {
      ...shortcuts,
      [id]: {
        ...shortcuts[id],
        keys: newKeyCombo,
      },
    };
    onShortcutsChange(next);
    closeRecorder();
    toast(`Shortcut updated: ${shortcuts[id]?.label || id} → ${newKeyCombo}`);
  };

  /** Take the combination held in `conflict`: move it onto the edited shortcut and unbind the
   *  clashing one. Built-ins cannot be moved, so for them this just dismisses the notice. */
  const confirmShortcutOverride = () => {
    if (!conflict) return;
    const targetLabel = shortcuts[conflict.id]?.label ?? conflict.id;
    if (conflict.builtin) {
      closeRecorder();
      return;
    }
    const result = applyShortcutOverride(shortcuts, conflict.id, conflict.combo);
    onShortcutsChange(result.shortcuts);
    closeRecorder();
    toast(
      result.displacedLabel
        ? `${targetLabel} now uses ${conflict.combo}; ${result.displacedLabel} was unbound`
        : `Shortcut updated: ${targetLabel} → ${conflict.combo}`
    );
  };

  /** Remove a binding entirely. The row shows "Unbound" and the action never fires. */
  const unbindShortcut = (id: string) => {
    const binding = shortcuts[id];
    if (!binding || isShortcutUnbound(binding)) return;
    onShortcutsChange({ ...shortcuts, [id]: { ...binding, keys: '' } });
    toast(`${binding.label} unbound`);
  };

  /** Restore one shortcut's default combination. */
  const resetShortcut = (id: string) => {
    const binding = shortcuts[id];
    const defaultKeys = DEFAULT_SHORTCUTS[id]?.keys;
    if (!binding || !defaultKeys || binding.keys === defaultKeys) return;
    onShortcutsChange({ ...shortcuts, [id]: { ...binding, keys: defaultKeys } });
    toast(`${binding.label} reset to ${defaultKeys}`);
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

                  {/* Copy on Select */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">
                      Copy on Select
                    </label>
                    <div
                      onClick={() => updatePref('copyOnSelect', !uiPrefs.copyOnSelect)}
                      className={cn(
                        'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                        uiPrefs.copyOnSelect ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
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
                    <label className="text-xs font-medium text-slate-300">
                      Right Click Action
                    </label>
                    <div
                      onClick={() => updatePref('rightClickPaste', !uiPrefs.rightClickPaste)}
                      className={cn(
                        'flex items-center justify-between rounded-lg border px-3 py-2.5 cursor-pointer transition select-none',
                        uiPrefs.rightClickPaste ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.015] opacity-75'
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
                            Display Fish/Zsh-style inline command completions from history and catalog (press → or tap to complete; Tab always uses your shell&apos;s native completion).
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
                        const isUnbound = isShortcutUnbound(item);
                        const isModified = DEFAULT_SHORTCUTS[item.id]?.keys !== item.keys;
                        return (
                          <div key={item.id} className="hover:bg-white/[0.03] transition">
                            <div className="flex items-center justify-between px-4 py-2.5">
                              <div className="min-w-0 pr-4">
                                <div className="text-xs font-medium text-white">{item.label}</div>
                                <div className="text-[11px] text-slate-400 truncate">
                                  {item.description}
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {isEditing ? (
                                  <button
                                    type="button"
                                    ref={(el) => {
                                      if (el) el.focus();
                                    }}
                                    data-shortcut-recorder="true"
                                    onKeyDown={(e) => handleShortcutKeyDown(e, item.id)}
                                    onKeyUp={handleShortcutKeyUp}
                                    onBlur={closeRecorder}
                                    className="group flex items-center gap-2 px-3 py-1 rounded-lg border border-cyan-400 bg-cyan-500/20 text-xs font-mono text-cyan-200 outline-none shadow-[0_0_12px_rgba(34,211,238,0.25)] select-none cursor-pointer"
                                  >
                                    <span className="animate-pulse">
                                      {recordedKeys ? `${recordedKeys} + …` : 'Press shortcut keys…'}
                                    </span>
                                    <span
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        closeRecorder();
                                      }}
                                      className="text-[10px] text-slate-400 hover:text-white underline cursor-pointer ml-1"
                                      title="Cancel shortcut rebinding"
                                    >
                                      (Esc)
                                    </span>
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingShortcutId(item.id);
                                        setRecordedKeys('');
                                        setConflict(null);
                                      }}
                                      title={isUnbound ? 'Click to bind a shortcut' : 'Click to rebind'}
                                      className="group flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10 transition cursor-pointer"
                                    >
                                      {isUnbound ? (
                                        <span className="font-mono text-xs font-semibold text-slate-500 italic group-hover:text-cyan-300 transition">
                                          Unbound
                                        </span>
                                      ) : (
                                        <kbd className="font-mono text-xs font-semibold text-slate-200 group-hover:text-cyan-300 transition">
                                          {item.keys}
                                        </kbd>
                                      )}
                                    </button>
                                    {!isUnbound && (
                                      <button
                                        type="button"
                                        onClick={() => unbindShortcut(item.id)}
                                        title="Unbind this shortcut"
                                        className="p-1 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-400/10 transition cursor-pointer"
                                      >
                                        <Ban className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    {isModified && (
                                      <button
                                        type="button"
                                        onClick={() => resetShortcut(item.id)}
                                        title={`Reset to default (${DEFAULT_SHORTCUTS[item.id]?.keys})`}
                                        className="p-1 rounded-md text-slate-400 hover:text-cyan-300 hover:bg-cyan-400/10 transition cursor-pointer"
                                      >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Persistent inline conflict notice: the recorder stays open so the user can
                                override (rebindable clash) or dismiss (built-in clash). */}
                            {isEditing && conflict && conflict.id === item.id && (
                              <div
                                className="mx-4 mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5"
                                onMouseDown={(e) => e.preventDefault()}
                              >
                                <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-amber-200">
                                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                  <div className="min-w-0">
                                    {conflict.builtin ? (
                                      <>
                                        <span className="font-mono font-semibold">{conflict.combo}</span> is reserved
                                        for the built-in <span className="font-semibold">{conflict.clashLabel}</span>{' '}
                                        action and cannot be reassigned. Choose a different combination.
                                      </>
                                    ) : (
                                      <>
                                        <span className="font-mono font-semibold">{conflict.combo}</span> is already
                                        used by <span className="font-semibold">{conflict.clashLabel}</span>.
                                        Overriding will bind it to <span className="font-semibold">{item.label}</span>{' '}
                                        and unbind {conflict.clashLabel}.
                                      </>
                                    )}
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                  {!conflict.builtin && (
                                    <button
                                      type="button"
                                      onClick={confirmShortcutOverride}
                                      className="rounded-md bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:brightness-110 transition cursor-pointer"
                                    >
                                      Override &amp; unbind {conflict.clashLabel}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={closeRecorder}
                                    className="rounded-md border border-white/15 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/10 transition cursor-pointer"
                                  >
                                    {conflict.builtin ? 'Got it' : 'Cancel'}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/* Fixed shortcuts: handled outside the rebindable list, shown so they can be found. */}
                <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
                  <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-slate-300">
                    <span>Built-in</span>
                    <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">Fixed · cannot be rebound</span>
                  </div>
                  <div className="divide-y divide-white/5">
                    {BUILTIN_SHORTCUTS.map((item) => (
                      <div key={item.label} className="flex items-center justify-between gap-4 px-4 py-2.5">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-white">{item.label}</div>
                          <div className="text-[11px] text-slate-400 truncate">{item.description}</div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          {item.keys.map((k) => (
                            <kbd
                              key={k}
                              className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1 font-mono text-xs font-semibold text-slate-400"
                            >
                              {k}
                            </kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: APPEARANCE & THEMES */}
          {activeTab === 'appearance' && (
            <div className="space-y-6">
              {/* Terminal Typography & Font Settings */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                    >
                      <Type className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">Terminal Typography & Font</h3>
                      <p className="text-xs text-slate-400">
                        Configure font family, font weight, letter spacing, font size and line height
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      updatePrefs({
                        fontFamily: 'JetBrains Mono',
                        customFontFamily: '',
                        fontWeight: '400',
                        letterSpacing: 0,
                      });
                      onFontSizeChange(13);
                      onLineHeightChange(1.0);
                      toast('Font settings reset to defaults');
                    }}
                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset</span>
                  </button>
                </div>

                {/* Font Family Selection */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                    <span>Font Family</span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      {uiPrefs.fontFamily === 'custom'
                        ? uiPrefs.customFontFamily || 'Custom'
                        : uiPrefs.fontFamily}
                    </span>
                  </label>
                  <CustomSelect
                    value={uiPrefs.fontFamily}
                    onChange={(val) => updatePref('fontFamily', String(val))}
                    options={POPULAR_TERMINAL_FONTS.map((f) => ({
                      value: f.id,
                      label: f.label,
                    }))}
                    theme={activeTheme}
                    accentColor={accentColor}
                  />

                  {/* Custom Font Family Input */}
                  {uiPrefs.fontFamily === 'custom' && (
                    <div className="pt-1.5">
                      <input
                        type="text"
                        placeholder="Enter system font name (e.g. Comic Code, Iosevka, Victor Mono)"
                        value={uiPrefs.customFontFamily}
                        onChange={(e) => updatePref('customFontFamily', e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 transition"
                      />
                      <p className="text-[11px] text-slate-400 mt-1">
                        Drexius will use this font if installed on your system, otherwise falling back to JetBrains Mono.
                      </p>
                    </div>
                  )}
                </div>

                {/* Font Weight & Letter Spacing Controls */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  {/* Font Weight */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">
                      Font Weight
                    </label>
                    <div className="grid grid-cols-5 gap-1.5">
                      {FONT_WEIGHT_OPTIONS.map((w) => {
                        const isSelected = uiPrefs.fontWeight === w.id;
                        return (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => updatePref('fontWeight', w.id)}
                            className={cn(
                              'py-1.5 px-1 rounded-lg border text-xs font-medium transition text-center truncate',
                              isSelected
                                ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-300 shadow-sm'
                                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-white hover:bg-white/5'
                            )}
                            title={w.label}
                          >
                            {w.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Letter Spacing */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                      <span>Letter Spacing</span>
                      <span className="font-mono text-xs text-cyan-300">
                        {uiPrefs.letterSpacing === 0 ? '0px (Default)' : `${uiPrefs.letterSpacing > 0 ? '+' : ''}${uiPrefs.letterSpacing}px`}
                      </span>
                    </label>
                    <div className="grid grid-cols-5 gap-1.5">
                      {[-1, 0, 1, 2, 3].map((spacing) => {
                        const isSelected = uiPrefs.letterSpacing === spacing;
                        return (
                          <button
                            key={spacing}
                            type="button"
                            onClick={() => updatePref('letterSpacing', spacing)}
                            className={cn(
                              'py-1.5 px-1 rounded-lg border text-xs font-mono font-medium transition text-center',
                              isSelected
                                ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-300 shadow-sm'
                                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-white hover:bg-white/5'
                            )}
                          >
                            {spacing === 0 ? '0' : `${spacing > 0 ? '+' : ''}${spacing}`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Font Size & Line Height Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      <Type className="h-4 w-4 text-cyan-400" />
                      <span>Font Size</span>
                    </label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={fontSize <= TERMINAL_FONT_MIN}
                        onClick={() => onFontSizeChange(Math.max(TERMINAL_FONT_MIN, fontSize - 1))}
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
              </div>

              {/* Terminal Frame, Acrylic Glass & Custom Wallpaper */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                    >
                      <Layers className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">Terminal Canvas, Frame & Wallpaper</h3>
                      <p className="text-xs text-slate-400">
                        Adjust inner padding, translucent glass opacity, frosted blur, and custom background wallpaper
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      updatePrefs({
                        terminalPadding: 10,
                        terminalOpacity: 1.0,
                        terminalBlur: 0,
                        terminalWallpaper: '',
                        wallpaperOpacity: 0.25,
                      });
                      toast('Canvas styling reset to defaults');
                    }}
                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset</span>
                  </button>
                </div>

                {/* Inner Terminal Padding */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                    <span>Frame Inner Padding</span>
                    <span className="font-mono text-xs text-cyan-300">
                      {uiPrefs.terminalPadding === 0 ? '0px (Edge-to-Edge)' : `${uiPrefs.terminalPadding ?? 10}px`}
                    </span>
                  </label>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                    {[
                      { val: 0, label: '0px (Flush / Edge-to-Edge)' },
                      { val: 4, label: '4px (Compact)' },
                      { val: 8, label: '8px (Slim)' },
                      { val: 12, label: '12px (Balanced)' },
                      { val: 16, label: '16px (Spacious)' },
                      { val: 24, label: '24px (Roomy)' },
                    ].map((p) => {
                      const isSelected = (uiPrefs.terminalPadding ?? 10) === p.val;
                      return (
                        <button
                          key={p.val}
                          type="button"
                          onClick={() => updatePref('terminalPadding', p.val)}
                          className={cn(
                            'py-1.5 px-1 rounded-lg border text-xs font-medium transition text-center truncate',
                            isSelected
                              ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-300 shadow-sm'
                              : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-white hover:bg-white/5'
                          )}
                          title={p.label}
                        >
                          {p.val}px
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Opacity & Frosted Blur Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  {/* Terminal Opacity */}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                      <span>Window / Background Opacity</span>
                      <span className="font-mono text-xs text-cyan-300">
                        {Math.round((uiPrefs.terminalOpacity ?? 1) * 100)}%
                      </span>
                    </label>
                    <input
                      type="range"
                      min="0.5"
                      max="1.0"
                      step="0.05"
                      value={uiPrefs.terminalOpacity ?? 1}
                      onChange={(e) => updatePref('terminalOpacity', parseFloat(e.target.value))}
                      className="w-full nx-range"
                    />
                  </div>

                  {/* Frosted Glass Blur */}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                      <span>Frosted Glass Blur</span>
                      <span className="font-mono text-xs text-cyan-300">
                        {uiPrefs.terminalBlur ? `${uiPrefs.terminalBlur}px` : 'Off'}
                      </span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="24"
                      step="2"
                      value={uiPrefs.terminalBlur ?? 0}
                      onChange={(e) => updatePref('terminalBlur', parseInt(e.target.value, 10))}
                      className="w-full nx-range"
                    />
                  </div>
                </div>

                {/* Custom Wallpaper Section */}
                <div className="space-y-2 pt-1 border-t border-white/5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                      <ImageIcon className="h-3.5 w-3.5 text-cyan-400" />
                      <span>Custom Terminal Wallpaper</span>
                    </label>
                    {uiPrefs.terminalWallpaper && (
                      <button
                        type="button"
                        onClick={() =>
                          updatePrefs({
                            terminalWallpaper: '',
                            terminalOpacity: 1.0,
                            terminalBlur: 0,
                          })
                        }
                        className="text-xs text-rose-400 hover:text-rose-300 transition"
                      >
                        Remove Wallpaper
                      </button>
                    )}
                  </div>

                  <input
                    type="file"
                    ref={wallpaperInputRef}
                    accept="image/*"
                    onChange={handleWallpaperFileChange}
                    className="hidden"
                  />

                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
                    <input
                      type="text"
                      placeholder="Paste image URL or choose a local image file..."
                      value={uiPrefs.terminalWallpaper?.startsWith('data:') ? 'Local Image File Selected' : (uiPrefs.terminalWallpaper || '')}
                      onChange={(e) => updatePref('terminalWallpaper', e.target.value)}
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                    />
                    <button
                      type="button"
                      onClick={() => wallpaperInputRef.current?.click()}
                      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 transition cursor-pointer whitespace-nowrap"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      <span>Choose File</span>
                    </button>
                  </div>

                  {uiPrefs.terminalWallpaper && (
                    <div className="space-y-1.5 pt-2">
                      <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                        <span>Wallpaper Tint / Opacity</span>
                        <span className="font-mono text-xs text-cyan-300">
                          {Math.round((uiPrefs.wallpaperOpacity ?? 0.25) * 100)}%
                        </span>
                      </label>
                      <input
                        type="range"
                        min="0.05"
                        max="0.80"
                        step="0.05"
                        value={uiPrefs.wallpaperOpacity ?? 0.25}
                        onChange={(e) => updatePref('wallpaperOpacity', parseFloat(e.target.value))}
                        className="w-full nx-range"
                      />
                    </div>
                  )}
                </div>

                {/* Cursor Customization */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-white/5">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">
                      Cursor Shape
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['bar', 'block', 'underline'] as const).map((style) => (
                        <button
                          key={style}
                          type="button"
                          onClick={() => updatePref('cursorStyle', style)}
                          className={cn(
                            'py-1.5 px-2 rounded-lg border text-xs font-medium capitalize transition text-center',
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

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">
                      Cursor Animation
                    </label>
                    <div
                      onClick={() => updatePref('cursorBlink', !uiPrefs.cursorBlink)}
                      className={cn(
                        'flex items-center justify-between rounded-lg border px-3 py-1.5 cursor-pointer transition select-none',
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
                </div>
              </div>

              {/* Interactive Live Terminal Preview Box */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Live Terminal Preview</h3>
                  <span className="text-[11px] text-slate-400">
                    Real-time frame metrics, wallpaper & color rendering
                  </span>
                </div>
                <div
                  className="rounded-xl border overflow-hidden shadow-xl transition-all relative"
                  style={{
                    backgroundColor: uiPrefs.terminalWallpaper
                      ? 'transparent'
                      : hexToRgba(activeTheme.xterm.background || '#0a0d14', uiPrefs.terminalOpacity ?? 1),
                    borderColor: `${accentColor}35`,
                  }}
                >
                  {/* Layer 0: Wallpaper layer */}
                  {uiPrefs.terminalWallpaper && (
                    <div
                      className="absolute inset-0 pointer-events-none bg-cover bg-center transition-opacity duration-300"
                      style={{
                        backgroundImage: `url(${uiPrefs.terminalWallpaper})`,
                        opacity: uiPrefs.wallpaperOpacity ?? 0.25,
                        zIndex: 0,
                      }}
                    />
                  )}

                  {/* Layer 1: Frosted acrylic / liquid glass overlay */}
                  {(uiPrefs.terminalWallpaper || (uiPrefs.terminalOpacity ?? 1) < 1 || (uiPrefs.terminalBlur ?? 0) > 0) && (
                    <div
                      className="absolute inset-0 pointer-events-none transition-all duration-200"
                      style={{
                        backgroundColor: hexToRgba(
                          activeTheme.xterm.background || '#0a0d14',
                          uiPrefs.terminalWallpaper
                            ? ((uiPrefs.terminalOpacity ?? 1) < 1 ? uiPrefs.terminalOpacity! : 0.65)
                            : (uiPrefs.terminalOpacity ?? 1)
                        ),
                        backdropFilter: uiPrefs.terminalBlur && uiPrefs.terminalBlur > 0 ? `blur(${uiPrefs.terminalBlur}px) saturate(140%)` : undefined,
                        WebkitBackdropFilter: uiPrefs.terminalBlur && uiPrefs.terminalBlur > 0 ? `blur(${uiPrefs.terminalBlur}px) saturate(140%)` : undefined,
                        zIndex: 1,
                      }}
                    />
                  )}

                  {/* Simulated Terminal Window Header */}
                  <div className="relative z-10 flex items-center justify-between px-3.5 py-2 border-b border-white/10 bg-black/30">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80 inline-block" />
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80 inline-block" />
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80 inline-block" />
                      <span className="ml-2 font-mono text-[11px] text-slate-400 truncate">
                        nexus@terminal ~ 80×24
                      </span>
                    </div>
                    <span
                      className="text-[10px] font-mono px-2 py-0.5 rounded border"
                      style={{
                        backgroundColor: `${accentColor}15`,
                        borderColor: `${accentColor}30`,
                        color: accentColor,
                      }}
                    >
                      {uiPrefs.fontFamily === 'custom'
                        ? uiPrefs.customFontFamily || 'Custom'
                        : uiPrefs.fontFamily}{' '}
                      @{fontSize}px
                    </span>
                  </div>

                  {/* Simulated Terminal Body */}
                  <div
                    className="relative z-10 overflow-x-auto select-none"
                    style={{
                      fontFamily: resolveTerminalFontFamily(uiPrefs.fontFamily, uiPrefs.customFontFamily),
                      fontSize: `${fontSize}px`,
                      fontWeight: uiPrefs.fontWeight,
                      letterSpacing: `${uiPrefs.letterSpacing}px`,
                      lineHeight: lineHeight,
                      padding: `${uiPrefs.terminalPadding ?? 10}px`,
                      color: activeTheme.xterm.foreground || '#d6deeb',
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div style={{ color: accentColor }} className="font-bold shrink-0">
                        nexus@drexius:~$
                      </div>
                      <div className="text-white">neofetch --drexius</div>
                    </div>
                    <div className="mt-1.5 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span style={{ color: activeTheme.xterm.cyan || accentColor }}>OS:</span>
                        <span>Drexius Linux (x86_64 / arm64-v8a)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span style={{ color: activeTheme.xterm.green || '#4ade80' }}>Theme:</span>
                        <span>{activeTheme.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span style={{ color: activeTheme.xterm.yellow || '#fbbf24' }}>Frame:</span>
                        <span>
                          {uiPrefs.terminalPadding ?? 10}px pad • {Math.round((uiPrefs.terminalOpacity ?? 1) * 100)}% opacity •{' '}
                          {uiPrefs.terminalBlur ? `${uiPrefs.terminalBlur}px blur` : 'No blur'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span style={{ color: activeTheme.xterm.magenta || '#c084fc' }}>Security:</span>
                        <span>SQLCipher AES-256 + Argon2id Active</span>
                      </div>
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <span style={{ color: accentColor }} className="font-bold shrink-0">
                        nexus@drexius:~$
                      </span>
                      {uiPrefs.cursorStyle === 'bar' ? (
                        <span
                          className={cn('inline-block w-0.5 h-4', uiPrefs.cursorBlink && 'animate-pulse')}
                          style={{ backgroundColor: activeTheme.xterm.cursor || accentColor }}
                        />
                      ) : uiPrefs.cursorStyle === 'underline' ? (
                        <span
                          className={cn('inline-block w-2.5 h-0.5 self-end mb-0.5', uiPrefs.cursorBlink && 'animate-pulse')}
                          style={{ backgroundColor: activeTheme.xterm.cursor || accentColor }}
                        />
                      ) : (
                        <span
                          className={cn('inline-block w-2 h-4', uiPrefs.cursorBlink && 'animate-pulse')}
                          style={{ backgroundColor: activeTheme.xterm.cursor || accentColor }}
                        />
                      )}
                    </div>

                    {/* 16 ANSI Color Palette Bar */}
                    <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-mono opacity-50 uppercase mr-1">ANSI:</span>
                      {[
                        activeTheme.xterm.black,
                        activeTheme.xterm.red,
                        activeTheme.xterm.green,
                        activeTheme.xterm.yellow,
                        activeTheme.xterm.blue,
                        activeTheme.xterm.magenta,
                        activeTheme.xterm.cyan,
                        activeTheme.xterm.white,
                        activeTheme.xterm.brightBlack,
                        activeTheme.xterm.brightRed,
                        activeTheme.xterm.brightGreen,
                        activeTheme.xterm.brightYellow,
                        activeTheme.xterm.brightBlue,
                        activeTheme.xterm.brightMagenta,
                        activeTheme.xterm.brightCyan,
                        activeTheme.xterm.brightWhite,
                      ].map((c, i) => (
                        <span
                          key={i}
                          className="h-3 w-4 rounded-sm border border-black/40 shrink-0"
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  </div>
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
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      Color Themes ({filteredThemes.length} / {allThemes.length})
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Curated developer color schemes & custom themes with accurate ANSI palettes
                    </p>
                  </div>

                  {/* Action buttons: New Theme, Import, Export */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => handleOpenThemeCreator()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-semibold transition"
                    >
                      <Sparkle className="h-3.5 w-3.5" />
                      <span>New Theme</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowImportModal(true)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-medium transition"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      <span>Import</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportCurrentTheme}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-medium transition"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export</span>
                    </button>
                  </div>
                </div>

                {/* Filter and Search Bar */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search themes by name..."
                      value={themeSearch}
                      onChange={(e) => setThemeSearch(e.target.value)}
                      className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-white/10 bg-white/[0.03] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                    />
                    {themeSearch && (
                      <button
                        type="button"
                        onClick={() => setThemeSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Filter chips */}
                  <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                    {(['all', 'dark', 'light', 'vibrant', 'custom'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setThemeFilter(mode)}
                        className={cn(
                          'px-2.5 py-1 rounded-lg text-xs font-medium capitalize transition border',
                          themeFilter === mode
                            ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-300'
                            : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-white'
                        )}
                      >
                        {mode === 'vibrant'
                          ? 'Neon / Vibrant'
                          : mode === 'custom'
                          ? `Custom (${customThemes.length})`
                          : mode}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                  {filteredThemes.map((t) => {
                    const isSelected = t.id === themeId;
                    return (
                      <div
                        key={t.id}
                        onClick={() => onThemeSelect(t.id)}
                        className={cn(
                          'group flex flex-col text-left rounded-xl border p-2.5 transition relative overflow-hidden cursor-pointer',
                          isSelected
                            ? 'border-cyan-400 bg-white/10 shadow-lg ring-1 ring-cyan-400/30'
                            : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20'
                        )}
                        style={{ backgroundColor: t.xterm.background || '#0e131d' }}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={cn(
                                'text-xs font-semibold truncate',
                                t.isLight ? 'text-slate-900' : 'text-white'
                              )}
                            >
                              {t.name}
                            </span>
                            {t.isCustom && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shrink-0">
                                CUSTOM
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {isSelected && <Check className="h-3.5 w-3.5 text-cyan-400 shrink-0" />}
                            {t.isCustom && (
                              <button
                                type="button"
                                title="Delete custom theme"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteTheme(t.id, t.name);
                                }}
                                className="p-1 rounded text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 transition"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                        {/* Swatch dots */}
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-3 w-3 rounded-full border border-black/40 shrink-0"
                            style={{ backgroundColor: t.accent }}
                            title="Accent"
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40 shrink-0"
                            style={{ backgroundColor: t.xterm.cyan || '#22d3ee' }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40 shrink-0"
                            style={{ backgroundColor: t.xterm.green || '#10b981' }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40 shrink-0"
                            style={{ backgroundColor: t.xterm.yellow || '#f59e0b' }}
                          />
                          <span
                            className="h-3 w-3 rounded-full border border-black/40 shrink-0"
                            style={{ backgroundColor: t.xterm.red || '#ef4444' }}
                          />
                        </div>
                      </div>
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

              {/* Emergency Recovery Kit */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <KeyRound className="h-4 w-4" style={{ color: accentColor }} />
                      <span>Emergency Recovery Kit</span>
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed max-w-xl">
                      If you ever forget your master password, this 128-bit key is the <strong className="text-slate-200">ONLY way to recover your encrypted vault</strong> on the lock screen. Store it safely offline.
                    </p>
                  </div>
                </div>

                {recoveryKey ? (
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-white/10 bg-black/50 font-mono text-xs sm:text-sm">
                      <span className="select-all break-all tracking-wider font-semibold text-white">
                        {revealRecovery ? recoveryKey : '••••••••••••••••••••••••••••••••'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setRevealRecovery(!revealRecovery)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition shrink-0 cursor-pointer"
                        title={revealRecovery ? "Hide Recovery Key" : "Show Recovery Key"}
                      >
                        {revealRecovery ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await bridge.writeClipboard(recoveryKey);
                            setCopiedRecovery(true);
                            setTimeout(() => setCopiedRecovery(false), 2000);
                          } catch (_) {}
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
                      >
                        {copiedRecovery ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        <span>{copiedRecovery ? 'Copied!' : 'Copy Key'}</span>
                      </button>

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
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
                      >
                        {downloadedRecoveryPath ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Download className="h-3.5 w-3.5" />}
                        <span>{downloadedRecoveryPath ? 'Saved to Downloads' : 'Download .txt Kit'}</span>
                      </button>

                      {!showRegenConfirm && (
                        <button
                          type="button"
                          onClick={() => setShowRegenConfirm(true)}
                          className="text-xs text-slate-400 hover:text-amber-400 transition underline underline-offset-4 ml-auto cursor-pointer"
                        >
                          Regenerate Key
                        </button>
                      )}
                    </div>

                    {downloadedRecoveryPath && (
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-200">
                        <span className="font-semibold text-white">Saved: </span>
                        <span className="font-mono text-[11px] select-all break-all text-slate-300">{downloadedRecoveryPath}</span>
                      </div>
                    )}

                    {showRegenConfirm && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs space-y-2.5">
                        <div className="flex items-start gap-2 text-amber-200">
                          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                          <p className="leading-relaxed">
                            Generating a new recovery key will immediately replace the active key and invalidate any previously printed, downloaded, or saved emergency kits.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            disabled={regeneratingRecovery}
                            onClick={async () => {
                              setRegeneratingRecovery(true);
                              try {
                                const newKey = await bridge.vaultRegenerateRecoveryKey();
                                setRecoveryKey(newKey);
                                setRevealRecovery(true);
                                setShowRegenConfirm(false);
                                setDownloadedRecoveryPath(null);
                              } catch (err) {
                                console.error('Failed to regenerate recovery key', err);
                              } finally {
                                setRegeneratingRecovery(false);
                              }
                            }}
                            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 transition cursor-pointer"
                          >
                            {regeneratingRecovery ? 'Regenerating…' : 'Yes, Replace Active Key'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowRegenConfirm(false)}
                            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 transition cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl border border-white/10 bg-black/40 p-4 text-center space-y-3">
                    <p className="text-xs text-slate-300">
                      No active recovery key is currently stored in this vault session.
                    </p>
                    <button
                      type="button"
                      disabled={regeneratingRecovery}
                      onClick={async () => {
                        setRegeneratingRecovery(true);
                        try {
                          const newKey = await bridge.vaultRegenerateRecoveryKey();
                          setRecoveryKey(newKey);
                          setRevealRecovery(true);
                        } catch (err) {
                          console.error('Failed to generate recovery key', err);
                        } finally {
                          setRegeneratingRecovery(false);
                        }
                      }}
                      className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 transition cursor-pointer"
                    >
                      {regeneratingRecovery ? 'Generating…' : 'Generate & Store Recovery Key'}
                    </button>
                  </div>
                )}
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

              {/* Keychain Identities */}
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <KeyRound className="h-4 w-4" style={{ color: accentColor }} />
                      <span>Keychain Identities</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Reusable SSH keypairs, certificates, and passwords stored in your encrypted vault
                    </p>
                  </div>

                  {onOpenKeychain && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenKeychain?.('security');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
                    >
                      <span>Manage Identities →</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Known Hosts */}
              {onOpenKnownHosts && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-emerald-400" />
                        <span>Known Hosts & Fingerprints</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Verified remote server host keys and pinned cryptographic fingerprints
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenKnownHosts?.('security');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
                    >
                      <span>Manage Pinned Keys →</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Audit & Activity Logs */}
              {onOpenLogs && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                        <Activity className="h-4 w-4 text-rose-400" />
                        <span>Audit & Activity Logs</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Connection session audit logs, executed command history, and security events
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenLogs?.('security');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition cursor-pointer"
                    >
                      <span>View Logs →</span>
                    </button>
                  </div>
                </div>
              )}

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
                        onOpenPairing?.('sync');
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
                        onOpenSync?.('sync');
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition cursor-pointer"
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

                  {onOpenTunnels && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenTunnels?.('sync');
                      }}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] text-left transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <Network className="h-5 w-5 text-amber-400" />
                        <div>
                          <div className="text-xs font-semibold text-white">Port Forwarding & Tunnels</div>
                          <div className="text-[11px] text-slate-400">Local, remote, and dynamic SOCKS5 tunnels</div>
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
                        onOpenTailscale?.('sync');
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
                        onOpenNetbird?.('sync');
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
                        onOpenCloudSync?.('sync');
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
                        onOpenDocker?.('sync');
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
                Drexius Terminal v0.4.0
              </span>
            </div>
          )}
        </div>

        {/* Footer (Desktop only) */}
        {!mobile && (
          <div className="border-t border-white/10 px-4 sm:px-6 py-3 bg-white/[0.02] flex items-center justify-between">
            <div className="text-[11px] text-slate-500 font-mono">
              Drexius Terminal v0.4.0
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
                    You are about to enable <strong>Direct Launch</strong>. Drexius will store credentials in this device's secure vault and open directly into your workspace on startup without authorization.
                  </span>
                ) : (
                  <span>
                    Disabling <strong>Direct Launch</strong> will remove stored startup credentials from this device. You will be required to enter your master password to unlock Drexius on startup.
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

        {/* Custom Theme Creator Modal */}
        {showThemeCreator && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
            <div
              className="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-2xl border border-white/15 bg-[#0e131f] shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
                <div className="flex items-center gap-2.5">
                  <Sparkle className="h-5 w-5 text-cyan-400" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      {editingThemeId ? 'Edit Custom Theme' : 'Create Custom Theme'}
                    </h3>
                    <p className="text-xs text-slate-400">
                      Configure terminal background, cursor, and full 16-color ANSI palette
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowThemeCreator(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                {/* Basic Meta: Name, Accent, Mode */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5 sm:col-span-1">
                    <label className="text-xs font-medium text-slate-300">Theme Name</label>
                    <input
                      type="text"
                      value={creatorName}
                      onChange={(e) => setCreatorName(e.target.value)}
                      placeholder="e.g. Neon Cyber"
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">Accent Color</label>
                    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 p-1.5">
                      <input
                        type="color"
                        value={creatorAccent.startsWith('#') && creatorAccent.length === 7 ? creatorAccent : '#22d3ee'}
                        onChange={(e) => setCreatorAccent(e.target.value)}
                        className="h-7 w-7 rounded cursor-pointer border-0 bg-transparent p-0"
                      />
                      <input
                        type="text"
                        value={creatorAccent}
                        onChange={(e) => setCreatorAccent(e.target.value)}
                        className="w-full text-xs font-mono text-white bg-transparent focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">Theme Mode</label>
                    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/40 px-3 py-2">
                      <span className="text-xs text-slate-300">{creatorIsLight ? 'Light Theme' : 'Dark Theme'}</span>
                      <ToggleSwitch
                        checked={creatorIsLight}
                        onChange={setCreatorIsLight}
                        accentColor={creatorAccent}
                      />
                    </div>
                  </div>
                </div>

                {/* Core Terminal Colors */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Canvas & Base Colors</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {[
                      { label: 'Background', val: creatorBg, set: setCreatorBg },
                      { label: 'Foreground', val: creatorFg, set: setCreatorFg },
                      { label: 'Cursor', val: creatorCursor, set: setCreatorCursor },
                      { label: 'Selection', val: creatorSelection, set: setCreatorSelection },
                    ].map((item) => (
                      <div key={item.label} className="rounded-xl border border-white/10 bg-black/30 p-2 space-y-1">
                        <span className="text-[11px] text-slate-400 font-medium block truncate">{item.label}</span>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="color"
                            value={item.val.startsWith('#') && item.val.length === 7 ? item.val : '#22d3ee'}
                            onChange={(e) => item.set(e.target.value)}
                            className="h-6 w-6 rounded cursor-pointer border-0 bg-transparent p-0 shrink-0"
                          />
                          <input
                            type="text"
                            value={item.val}
                            onChange={(e) => item.set(e.target.value)}
                            className="w-full text-xs font-mono text-white bg-transparent focus:outline-none truncate"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ANSI Palette 0-15 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">ANSI Colors (0–15)</h4>
                    <button
                      type="button"
                      onClick={() => {
                        const lighten = (hex: string) => {
                          const clean = hex.replace('#', '');
                          if (clean.length !== 6) return hex;
                          const num = parseInt(clean, 16);
                          const r = Math.min(255, Math.floor(((num >> 16) & 0xff) + (255 - ((num >> 16) & 0xff)) * 0.35));
                          const g = Math.min(255, Math.floor(((num >> 8) & 0xff) + (255 - ((num >> 8) & 0xff)) * 0.35));
                          const b = Math.min(255, Math.floor((num & 0xff) + (255 - (num & 0xff)) * 0.35));
                          return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
                        };
                        setCreatorAnsi((prev) => ({
                          ...prev,
                          brightBlack: lighten(prev.black),
                          brightRed: lighten(prev.red),
                          brightGreen: lighten(prev.green),
                          brightYellow: lighten(prev.yellow),
                          brightBlue: lighten(prev.blue),
                          brightMagenta: lighten(prev.magenta),
                          brightCyan: lighten(prev.cyan),
                          brightWhite: '#ffffff',
                        }));
                      }}
                      className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-medium transition"
                    >
                      <Sparkle className="h-3 w-3" />
                      <span>Auto-generate Bright from Normal</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { key: 'black', label: 'Black (0)' },
                      { key: 'red', label: 'Red (1)' },
                      { key: 'green', label: 'Green (2)' },
                      { key: 'yellow', label: 'Yellow (3)' },
                      { key: 'blue', label: 'Blue (4)' },
                      { key: 'magenta', label: 'Magenta (5)' },
                      { key: 'cyan', label: 'Cyan (6)' },
                      { key: 'white', label: 'White (7)' },
                      { key: 'brightBlack', label: 'Bright Black (8)' },
                      { key: 'brightRed', label: 'Bright Red (9)' },
                      { key: 'brightGreen', label: 'Bright Green (10)' },
                      { key: 'brightYellow', label: 'Bright Yellow (11)' },
                      { key: 'brightBlue', label: 'Bright Blue (12)' },
                      { key: 'brightMagenta', label: 'Bright Magenta (13)' },
                      { key: 'brightCyan', label: 'Bright Cyan (14)' },
                      { key: 'brightWhite', label: 'Bright White (15)' },
                    ].map(({ key, label }) => {
                      const val = creatorAnsi[key as keyof typeof creatorAnsi];
                      return (
                        <div key={key} className="rounded-lg border border-white/5 bg-black/20 p-2 space-y-1">
                          <span className="text-[10px] text-slate-400 font-medium block truncate">{label}</span>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="color"
                              value={val.startsWith('#') && val.length === 7 ? val : '#22d3ee'}
                              onChange={(e) =>
                                setCreatorAnsi((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              className="h-5 w-5 rounded cursor-pointer border-0 bg-transparent p-0 shrink-0"
                            />
                            <input
                              type="text"
                              value={val}
                              onChange={(e) =>
                                setCreatorAnsi((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              className="w-full text-[11px] font-mono text-white bg-transparent focus:outline-none truncate"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Real-Time Live Preview */}
                <div className="space-y-1.5">
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Live Preview</h4>
                  <div
                    className="rounded-xl border p-3.5 font-mono text-xs overflow-hidden select-none shadow-inner"
                    style={{
                      backgroundColor: creatorBg,
                      borderColor: `${creatorAccent}40`,
                      color: creatorFg,
                    }}
                  >
                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 opacity-70 text-[10px]">
                      <span>{creatorName || 'Custom Theme'} Live Sample</span>
                      <span style={{ color: creatorAccent }}>● Drexius Terminal</span>
                    </div>
                    <div className="space-y-1">
                      <div>
                        <span style={{ color: creatorAccent }} className="font-bold">nexus@drexius:~$ </span>
                        <span style={{ color: creatorAnsi.green }}>cargo build --release</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span style={{ color: creatorAnsi.blue }}>Compiling</span>
                        <span style={{ color: creatorAnsi.yellow }}>drexius-core</span>
                        <span style={{ color: creatorFg }}>v2.4.0 (/workspace)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span style={{ color: creatorAnsi.magenta }}>Finished</span>
                        <span style={{ color: creatorAnsi.cyan }}>release [optimized] target(s) in 1.42s</span>
                      </div>
                      <div className="flex items-center gap-1 pt-1">
                        <span style={{ color: creatorAccent }} className="font-bold">nexus@drexius:~$ </span>
                        <span className="inline-block w-2 h-3.5 animate-pulse" style={{ backgroundColor: creatorCursor }} />
                      </div>
                    </div>
                    <div className="mt-3 pt-2 border-t border-white/10 flex items-center gap-1 flex-wrap">
                      {Object.entries(creatorAnsi).map(([k, val]) => (
                        <span
                          key={k}
                          className="h-3 w-3.5 rounded-sm border border-black/40 shrink-0"
                          style={{ backgroundColor: val }}
                          title={`${k}: ${val}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2.5 px-5 py-3.5 border-t border-white/10 shrink-0 bg-black/20">
                <button
                  type="button"
                  onClick={() => setShowThemeCreator(false)}
                  className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveTheme}
                  className="px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold shadow-md transition"
                >
                  Save & Apply Theme
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Custom Theme Import Modal */}
        {showImportModal && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
            <div
              className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#0e131f] p-5 shadow-2xl space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Upload className="h-5 w-5 text-cyan-400" />
                  <h3 className="text-sm font-semibold text-white">Import Custom Theme</h3>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowImportModal(false);
                    setImportText('');
                  }}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Paste theme JSON or Ghostty/xterm configuration text below. We will parse it and add it to your themes gallery.
              </p>
              <textarea
                rows={8}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={`{\n  "name": "My Custom Theme",\n  "accent": "#22d3ee",\n  "xterm": {\n    "background": "#0a0d14",\n    "foreground": "#d6deeb",\n    "cursor": "#22d3ee", ...\n  }\n}`}
                className="w-full rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400 resize-none"
              />
              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowImportModal(false);
                    setImportText('');
                  }}
                  className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportTheme}
                  className="px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold shadow-md transition"
                >
                  Import & Apply
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ResponsiveOverlay>
  );
}
