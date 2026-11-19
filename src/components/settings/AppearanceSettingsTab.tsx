import { useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  Image as ImageIcon,
  Layers,
  Minus,
  Plus,
  RotateCcw,
  Rows2,
  Search,
  Sparkle,
  Trash2,
  Type,
  Upload,
  X,
} from 'lucide-react';
import { TERMINAL_FONT_MIN } from '../../lib/mobileTerminal';
import {
  FONT_WEIGHT_OPTIONS,
  POPULAR_TERMINAL_FONTS,
  resolveTerminalFontFamily,
  type UiPreferences,
} from '../../lib/settings';
import {
  deleteCustomTheme,
  exportThemeJson,
  getTerminalWallpaperStyles,
  hexToRgba,
  importThemeFromText,
  saveCustomTheme,
  type DrexiusTheme,
} from '../../lib/themes';
import { cn } from '../../utils/cn';
import { BackPriority } from '../../lib/backNavigation';
import { useBackHandler } from '../../hooks/useBackHandler';
import { CustomSelect } from '../CustomSelect';
import { ToggleSwitch } from '../ToggleSwitch';

export interface AppearanceSettingsTabProps {
  mobile: boolean;
  themeId: string;
  onThemeSelect: (themeId: string) => void;
  allThemes: DrexiusTheme[];
  customThemes: DrexiusTheme[];
  activeTheme: DrexiusTheme;
  accentColor: string;
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
  uiPrefs: UiPreferences;
  onUiPrefsChange: (prefs: UiPreferences) => void;
  toast: (msg: string) => void;
}

/**
 * Renders the Live Terminal Preview prompt using the theme's standard ANSI green/blue/foreground
 * colors (matching real Linux bash/zsh prompts and demoShell) rather than the UI accent color.
 */
function PreviewPrompt({ theme }: { theme: DrexiusTheme }) {
  const fg = theme.xterm.foreground || '#d6deeb';
  const userHostColor = theme.xterm.brightGreen || theme.xterm.green || '#4ade80';
  const dirColor = theme.xterm.brightBlue || theme.xterm.blue || '#60a5fa';
  return (
    <span className="font-bold shrink-0" style={{ color: fg }}>
      <span style={{ color: userHostColor }}>nexus@drexius</span>
      <span>:</span>
      <span style={{ color: dirColor }}>~</span>
      <span>$</span>
    </span>
  );
}

export function AppearanceSettingsTab({
  mobile,
  themeId,
  onThemeSelect,
  allThemes,
  customThemes,
  activeTheme,
  accentColor,
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
  uiPrefs,
  onUiPrefsChange,
  toast,
}: AppearanceSettingsTabProps) {
  const updatePref = <K extends keyof UiPreferences>(key: K, val: UiPreferences[K]) => {
    onUiPrefsChange({ ...uiPrefs, [key]: val });
  };

  const updatePrefs = (patch: Partial<UiPreferences>) => {
    onUiPrefsChange({ ...uiPrefs, ...patch });
  };

  const [themeSearch, setThemeSearch] = useState('');
  const [themeFilter, setThemeFilter] = useState<'all' | 'dark' | 'light' | 'vibrant' | 'custom'>('all');

  const filteredThemes = useMemo(() => {
    return allThemes.filter((t) => {
      if (themeFilter === 'custom' && !t.isCustom) return false;
      if (themeFilter === 'light' && !t.isLight) return false;
      if (themeFilter === 'dark' && t.isLight) return false;
      if (
        themeFilter === 'vibrant' &&
        !['cyberpunk', 'synthwave', 'matrix', 'homebrew', 'aurora', 'retro-amber', 'cobalt2'].includes(t.id)
      )
        return false;
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

  useBackHandler(showThemeCreator, () => setShowThemeCreator(false), BackPriority.NESTED_MODAL);
  useBackHandler(
    showImportModal,
    () => {
      setShowImportModal(false);
      setImportText('');
    },
    BackPriority.NESTED_MODAL,
  );

  // Form fields for Custom Theme Creator
  const [creatorName, setCreatorName] = useState('');
  const [creatorAccent, setCreatorAccent] = useState('#22d3ee');
  const [creatorBg, setCreatorBg] = useState('#0a0d14');
  const [creatorFg, setCreatorFg] = useState('#d6deeb');
  const [creatorCursor, setCreatorCursor] = useState('#22d3ee');
  const [creatorSelection, setCreatorSelection] = useState('#22d3ee33');
  const [creatorIsLight, setCreatorIsLight] = useState(false);
  const [creatorAnsi, setCreatorAnsi] = useState({
    black: '#1b2130',
    red: '#ff5f7e',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d6deeb',
    brightBlack: '#4b5468',
    brightRed: '#ff8aa1',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#ffffff',
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
    const themeIdToSave =
      editingThemeId ||
      `custom-${creatorName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
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
    navigator.clipboard
      ?.writeText(json)
      .then(() => {
        toast(`Exported "${activeTheme.name}" to clipboard`);
      })
      .catch(() => {});

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

  return (
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
              {uiPrefs.fontFamily === 'custom' ? uiPrefs.customFontFamily || 'Custom' : uiPrefs.fontFamily}
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
            <label className="text-xs font-medium text-slate-300">Font Weight</label>
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
                {uiPrefs.letterSpacing === 0
                  ? '0px (Default)'
                  : `${uiPrefs.letterSpacing > 0 ? '+' : ''}${uiPrefs.letterSpacing}px`}
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
              value={
                uiPrefs.terminalWallpaper?.startsWith('data:')
                  ? 'Local Image File Selected'
                  : uiPrefs.terminalWallpaper || ''
              }
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
            <label className="text-xs font-medium text-slate-300">Cursor Shape</label>
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
            <label className="text-xs font-medium text-slate-300">Cursor Animation</label>
            <div
              onClick={() => updatePref('cursorBlink', !uiPrefs.cursorBlink)}
              className={cn(
                'flex items-center justify-between rounded-lg border px-3 py-1.5 cursor-pointer transition select-none',
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
          {/* Layer 0 & Layer 1: Wallpaper + frosted glass overlay */}
          {(() => {
            const previewLayers = getTerminalWallpaperStyles({
              terminalWallpaper: uiPrefs.terminalWallpaper,
              wallpaperOpacity: uiPrefs.wallpaperOpacity,
              terminalOpacity: uiPrefs.terminalOpacity,
              terminalBlur: uiPrefs.terminalBlur,
              background: activeTheme.xterm.background,
              overlayZIndex: 1,
            });
            return (
              <>
                {uiPrefs.terminalWallpaper && (
                  <div
                    className="absolute pointer-events-none bg-cover bg-center transition-all duration-300"
                    style={previewLayers.layer0Style}
                  />
                )}
                {previewLayers.showOverlay && (
                  <div
                    className="absolute inset-0 pointer-events-none transition-all duration-200"
                    style={previewLayers.layer1Style}
                  />
                )}
              </>
            );
          })()}

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
              {uiPrefs.fontFamily === 'custom' ? uiPrefs.customFontFamily || 'Custom' : uiPrefs.fontFamily} @
              {fontSize}px
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
              <PreviewPrompt theme={activeTheme} />
              <div>neofetch --drexius</div>
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
                  {uiPrefs.terminalPadding ?? 10}px pad •{' '}
                  {Math.round((uiPrefs.terminalOpacity ?? 1) * 100)}% opacity •{' '}
                  {uiPrefs.terminalBlur ? `${uiPrefs.terminalBlur}px blur` : 'No blur'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span style={{ color: activeTheme.xterm.magenta || '#c084fc' }}>Security:</span>
                <span>SQLCipher AES-256 + Argon2id Active</span>
              </div>
            </div>

            <div className="mt-2.5 flex items-center gap-2">
              <PreviewPrompt theme={activeTheme} />
              {uiPrefs.cursorStyle === 'bar' ? (
                <span
                  className={cn('inline-block w-0.5 h-4', uiPrefs.cursorBlink && 'animate-pulse')}
                  style={{ backgroundColor: activeTheme.xterm.cursor || accentColor }}
                />
              ) : uiPrefs.cursorStyle === 'underline' ? (
                <span
                  className={cn(
                    'inline-block w-2.5 h-0.5 self-end mb-0.5',
                    uiPrefs.cursorBlink && 'animate-pulse'
                  )}
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
                showRail
                  ? 'border-white/15 bg-white/[0.04]'
                  : 'border-white/5 bg-white/[0.015] opacity-75'
              )}
            >
              <span className="text-xs font-medium text-white">Left Icon Rail</span>
              <ToggleSwitch checked={showRail} onChange={onShowRailChange} accentColor={accentColor} />
            </div>
            <div
              onClick={() => onShowStatusBarChange(!showStatusBar)}
              className={cn(
                'flex items-center justify-between rounded-xl border p-3 cursor-pointer transition select-none',
                showStatusBar
                  ? 'border-white/15 bg-white/[0.04]'
                  : 'border-white/5 bg-white/[0.015] opacity-75'
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
              <ToggleSwitch checked={zen} onChange={onZenChange} accentColor={accentColor} />
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
                data-theme-card={t.isLight ? 'light' : 'dark'}
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
                      className="text-xs font-semibold truncate"
                      style={{ color: t.isLight ? '#0f172a' : '#f8fafc' }}
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
                      value={
                        creatorAccent.startsWith('#') && creatorAccent.length === 7
                          ? creatorAccent
                          : '#22d3ee'
                      }
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
                    <span className="text-xs text-slate-300">
                      {creatorIsLight ? 'Light Theme' : 'Dark Theme'}
                    </span>
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
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Canvas & Base Colors
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {[
                    { label: 'Background', val: creatorBg, set: setCreatorBg },
                    { label: 'Foreground', val: creatorFg, set: setCreatorFg },
                    { label: 'Cursor', val: creatorCursor, set: setCreatorCursor },
                    { label: 'Selection', val: creatorSelection, set: setCreatorSelection },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-xl border border-white/10 bg-black/30 p-2 space-y-1"
                    >
                      <span className="text-[11px] text-slate-400 font-medium block truncate">
                        {item.label}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="color"
                          value={
                            item.val.startsWith('#') && item.val.length === 7 ? item.val : '#22d3ee'
                          }
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
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    ANSI Colors (0–15)
                  </h4>
                  <button
                    type="button"
                    onClick={() => {
                      const lighten = (hex: string) => {
                        const clean = hex.replace('#', '');
                        if (clean.length !== 6) return hex;
                        const num = parseInt(clean, 16);
                        const r = Math.min(
                          255,
                          Math.floor(((num >> 16) & 0xff) + (255 - ((num >> 16) & 0xff)) * 0.35)
                        );
                        const g = Math.min(
                          255,
                          Math.floor(((num >> 8) & 0xff) + (255 - ((num >> 8) & 0xff)) * 0.35)
                        );
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
                        <span className="text-[10px] text-slate-400 font-medium block truncate">
                          {label}
                        </span>
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
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Live Preview
                </h4>
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
                      <span style={{ color: creatorAccent }} className="font-bold">
                        nexus@drexius:~${' '}
                      </span>
                      <span style={{ color: creatorAnsi.green }}>cargo build --release</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ color: creatorAnsi.blue }}>Compiling</span>
                      <span style={{ color: creatorAnsi.yellow }}>drexius-core</span>
                      <span style={{ color: creatorFg }}>v2.4.0 (/workspace)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ color: creatorAnsi.magenta }}>Finished</span>
                      <span style={{ color: creatorAnsi.cyan }}>
                        release [optimized] target(s) in 1.42s
                      </span>
                    </div>
                    <div className="flex items-center gap-1 pt-1">
                      <span style={{ color: creatorAccent }} className="font-bold">
                        nexus@drexius:~${' '}
                      </span>
                      <span
                        className="inline-block w-2 h-3.5 animate-pulse"
                        style={{ backgroundColor: creatorCursor }}
                      />
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
              Paste theme JSON or Ghostty/xterm configuration text below. We will parse it and add it to your
              themes gallery.
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
  );
}
