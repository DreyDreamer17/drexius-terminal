import type { Dispatch, SetStateAction } from 'react';
import {
  Bookmark,
  Columns2,
  Columns3,
  Grid2x2,
  Layers,
  PanelLeft,
  PanelTop,
  Rows2,
  Terminal as TerminalIcon,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  BUILTIN_LAYOUT_PRESETS,
  getLayoutDescription,
  type LayoutPreset,
  type LayoutPresetPane,
} from '../lib/layoutPresets';
import type { SplitDirection } from '../lib/splitTree';
import type { DrexiusTheme } from '../lib/themes';
import type { Host, Layout, Pane, PopoutPaneEntry, Tab } from '../lib/types';
import { LOCAL_HOST, type SplitMenuState } from '../lib/workspaceState';
import { cn } from '../utils/cn';
import { OsIcon } from './OsIcon';

export interface SplitMenuPopoverProps {
  splitMenu: SplitMenuState;
  setSplitMenu: Dispatch<SetStateAction<SplitMenuState | null>>;
  theme: DrexiusTheme;
  activeTab: Tab | null;
  activePane: Pane | undefined;
  hosts: Host[];
  hostMap: Map<string, Host>;
  userPresets: LayoutPreset[];
  poppedOutPanes: PopoutPaneEntry[];
  onSplitPaneInDirection: (direction: SplitDirection, targetHost?: Host, fromPaneId?: string) => void;
  onChangeActiveTabLayout: (layout: Layout) => void;
  onEqualizeActiveTab: () => void;
  onOpenSavePresetModal: (defaultName: string) => void;
  onApplyLayoutPreset: (preset: LayoutPreset) => void;
  onDeletePreset: (id: string, name: string) => void;
}

export function SplitMenuPopover({
  splitMenu,
  setSplitMenu,
  theme,
  activeTab,
  activePane,
  hosts,
  hostMap,
  userPresets,
  poppedOutPanes,
  onSplitPaneInDirection,
  onChangeActiveTabLayout,
  onEqualizeActiveTab,
  onOpenSavePresetModal,
  onApplyLayoutPreset,
  onDeletePreset,
}: SplitMenuPopoverProps) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setSplitMenu(null)} />
      <div
        className="fixed z-50 w-80 overflow-hidden rounded-xl border p-2.5 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 text-slate-200"
        style={{
          top: splitMenu.top,
          left: Math.min(splitMenu.left, window.innerWidth - 340),
          backgroundColor: theme.xterm.background || '#0e131d',
          borderColor: `${theme.accent}30`,
          boxShadow: `0 16px 36px rgba(0,0,0,0.6), 0 0 20px ${theme.accent}15`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-20 opacity-20"
          style={{ background: `radial-gradient(ellipse at top, ${theme.accent} 0%, transparent 70%)` }}
        />

        {/* Top Navigation Tabs */}
        <div className="relative z-10 flex items-center gap-1 p-0.5 mb-2.5 rounded-lg bg-white/[0.04] border border-white/5 text-xs">
          <button
            type="button"
            onClick={() => setSplitMenu((prev) => (prev ? { ...prev, tab: 'split' } : null))}
            className={cn(
              'flex-1 py-1 rounded-md text-[11px] font-medium transition text-center flex items-center justify-center gap-1.5',
              splitMenu.tab === 'split' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            )}
            style={splitMenu.tab === 'split' ? { color: theme.accent } : undefined}
          >
            <Columns2 className="h-3 w-3" />
            Split
          </button>
          <button
            type="button"
            onClick={() => setSplitMenu((prev) => (prev ? { ...prev, tab: 'layout' } : null))}
            className={cn(
              'flex-1 py-1 rounded-md text-[11px] font-medium transition text-center flex items-center justify-center gap-1.5',
              splitMenu.tab === 'layout' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            )}
            style={splitMenu.tab === 'layout' ? { color: theme.accent } : undefined}
          >
            <Layers className="h-3 w-3" />
            Layout
          </button>
          <button
            type="button"
            onClick={() => setSplitMenu((prev) => (prev ? { ...prev, tab: 'presets' } : null))}
            className={cn(
              'flex-1 py-1 rounded-md text-[11px] font-medium transition text-center flex items-center justify-center gap-1.5',
              splitMenu.tab === 'presets' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            )}
            style={splitMenu.tab === 'presets' ? { color: theme.accent } : undefined}
          >
            <Bookmark className="h-3 w-3" />
            Presets
          </button>
        </div>

        {/* Tab 1: Directional Split */}
        {splitMenu.tab === 'split' && (
          <div className="relative z-10 py-1 space-y-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-1 flex items-center justify-between">
                <span>Split Direction</span>
                <span className="text-[9px] font-mono text-slate-500">From active pane</span>
              </div>
              <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-black/30 border border-white/5">
                {(['left', 'right', 'up', 'down'] as const).map((dir) => {
                  const isSelected = splitMenu.direction === dir;
                  const label = dir === 'left' ? '← Left' : dir === 'right' ? 'Right →' : dir === 'up' ? '↑ Up' : '↓ Down';
                  return (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => setSplitMenu((prev) => (prev ? { ...prev, direction: dir } : null))}
                      className={cn(
                        'py-1 rounded text-[10px] font-semibold tracking-wide transition border',
                        isSelected
                          ? 'text-white'
                          : 'text-slate-400 hover:text-white border-transparent hover:bg-white/5'
                      )}
                      style={
                        isSelected
                          ? {
                              backgroundColor: `${theme.accent}25`,
                              borderColor: `${theme.accent}60`,
                              color: theme.accent,
                            }
                          : undefined
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 pt-1 border-t border-white/5">
              Split with Host
            </div>

            <div className="space-y-0.5 max-h-56 overflow-y-auto pr-0.5">
              {/* Option 1: Current host (Duplicate) */}
              {activePane && hostMap.get(activePane.hostId) && (
                <button
                  type="button"
                  onClick={() => {
                    const h = hostMap.get(activePane.hostId);
                    if (h) onSplitPaneInDirection(splitMenu.direction, h);
                    setSplitMenu(null);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10 hover:text-white transition group"
                >
                  <Zap className="h-4 w-4 shrink-0" style={{ color: theme.accent }} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-white flex items-center gap-1.5">
                      <span className="truncate">{hostMap.get(activePane.hostId)?.label}</span>
                      <span
                        className="text-[9px] rounded border px-1 py-0 font-mono shrink-0"
                        style={{
                          backgroundColor: `${theme.accent}18`,
                          borderColor: `${theme.accent}35`,
                          color: theme.accent,
                        }}
                      >
                        Current
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">Duplicate session on this host</div>
                  </div>
                </button>
              )}

              {/* Option 2: Local Terminal */}
              {(!activePane || !activePane.isLocal) && (
                <button
                  type="button"
                  onClick={() => {
                    onSplitPaneInDirection(splitMenu.direction, LOCAL_HOST);
                    setSplitMenu(null);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10 hover:text-white transition group"
                >
                  <TerminalIcon className="h-4 w-4 text-emerald-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-white">Local Terminal</div>
                    <div className="text-[10px] text-slate-400">Open local shell split</div>
                  </div>
                </button>
              )}

              {/* Other saved hosts */}
              {hosts
                .filter((h) => h.id !== activePane?.hostId)
                .map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => {
                      onSplitPaneInDirection(splitMenu.direction, h);
                      setSplitMenu(null);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10 hover:text-white transition group"
                  >
                    <OsIcon os={h.os} color={h.color} size={16} />
                    <div className="min-w-0 flex-1 truncate">
                      <div className="font-medium text-white truncate">{h.label}</div>
                      <div className="text-[10px] text-slate-400 font-mono truncate">
                        {h.username}@{h.hostname}
                      </div>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Tab 2: Layout Switcher */}
        {splitMenu.tab === 'layout' && (
          <div className="relative z-10 py-1 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1">
              Active Tab Layout ({activeTab?.panes.length ?? 0} panes)
            </div>
            {!activeTab || activeTab.panes.length < 2 ? (
              <div className="p-3 text-center text-xs text-slate-400 bg-white/[0.02] rounded-lg border border-white/5">
                Split the current tab into 2+ panes to switch between multi-pane geometries.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-0.5">
                  {(() => {
                    const n = activeTab.panes.length;
                    const items: Array<{ layout: Layout; label: string; desc: string; icon: typeof Columns3 }> = [
                      { layout: 'columns', label: 'Columns', desc: `${n} side by side`, icon: Columns3 },
                      { layout: 'rows', label: 'Rows', desc: `${n} stacked`, icon: Rows2 },
                      ...(n >= 3
                        ? [
                            { layout: 'grid' as Layout, label: 'Grid', desc: 'As square as possible', icon: Grid2x2 },
                            { layout: 'main-left' as Layout, label: 'Main Left', desc: 'Large left, rest stacked', icon: PanelLeft },
                            { layout: 'main-right' as Layout, label: 'Main Right', desc: 'Rest stacked, large right', icon: PanelLeft },
                            { layout: 'main-top' as Layout, label: 'Main Top', desc: 'Wide top, rest below', icon: PanelTop },
                            { layout: 'main-bottom' as Layout, label: 'Main Bottom', desc: 'Rest above, wide bottom', icon: PanelTop },
                          ]
                        : []),
                    ];
                    return items.map((item) => {
                      const isCurrent = activeTab.layout === item.layout;
                      const IconComponent = item.icon;
                      return (
                        <button
                          key={item.layout}
                          type="button"
                          onClick={() => {
                            onChangeActiveTabLayout(item.layout);
                            setSplitMenu(null);
                          }}
                          className={cn(
                            'flex flex-col items-start p-2 rounded-lg border text-left transition',
                            isCurrent
                              ? 'bg-white/10 text-white'
                              : 'bg-white/[0.03] text-slate-300 hover:bg-white/[0.07] border-white/5'
                          )}
                          style={
                            isCurrent
                              ? {
                                  backgroundColor: `${theme.accent}20`,
                                  borderColor: `${theme.accent}60`,
                                  boxShadow: `0 0 10px ${theme.accent}20`,
                                }
                              : undefined
                          }
                        >
                          <div className="flex items-center gap-1.5 w-full">
                            <IconComponent className="h-3.5 w-3.5" style={{ color: isCurrent ? theme.accent : undefined }} />
                            <span className="text-xs font-semibold">{item.label}</span>
                          </div>
                          <span className="text-[10px] text-slate-400 mt-0.5">{item.desc}</span>
                        </button>
                      );
                    });
                  })()}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onEqualizeActiveTab();
                    setSplitMenu(null);
                  }}
                  className="flex w-full items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5 text-left text-xs text-slate-200 transition hover:bg-white/[0.07]"
                >
                  <span className="font-semibold">Equalize splits</span>
                  <span className="font-mono text-[10px] text-slate-500">Ctrl+Shift+N</span>
                </button>
                <div className="px-1 text-[10px] leading-snug text-slate-500">
                  Drag the dividers between panes to resize; double-click one to split evenly.
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 3: Presets & Templates */}
        {splitMenu.tab === 'presets' && (
          <div className="relative z-10 py-1 space-y-2">
            <button
              type="button"
              disabled={!activeTab || (activeTab.panes.length < 2 && poppedOutPanes.length === 0)}
              onClick={() => {
                onOpenSavePresetModal(activeTab?.title || `Workspace ${userPresets.length + 1}`);
                setSplitMenu(null);
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium border transition disabled:opacity-40"
              style={{
                backgroundColor: `${theme.accent}20`,
                borderColor: `${theme.accent}50`,
                color: theme.accent,
              }}
            >
              <Bookmark className="h-3.5 w-3.5" />
              <span>Save Current Tab Layout Preset</span>
            </button>

            {/* User Presets */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-1">
                My Saved Presets ({userPresets.length})
              </div>
              {userPresets.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-slate-400 italic">No custom presets saved yet.</div>
              ) : (
                <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
                  {userPresets.map((p) => (
                    <div
                      key={p.id}
                      className="group flex items-center justify-between rounded-lg px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onApplyLayoutPreset(p);
                          setSplitMenu(null);
                        }}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="text-xs font-medium text-white truncate flex items-center gap-1.5">
                          <span>{p.name}</span>
                          <span className="text-[9px] px-1 py-0 rounded bg-white/10 text-slate-300 font-mono">
                            {p.layout}
                          </span>
                          {p.popoutPanes && p.popoutPanes.length > 0 && (
                            <span className="text-[9px] px-1 py-0 rounded bg-cyan-500/20 text-cyan-300 font-mono">
                              +{p.popoutPanes.length} pop-out
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {p.panes.length} panes:{' '}
                          {p.panes
                            .map((pp: LayoutPresetPane) => pp.hostLabel || pp.label || (pp.isLocal ? 'Local' : 'Host'))
                            .join(', ')}
                        </div>
                      </button>
                      <button
                        type="button"
                        title="Delete preset"
                        onClick={() => onDeletePreset(p.id, p.name)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-400 transition"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Builtin Templates */}
            <div className="pt-1 border-t border-white/5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-1">
                Built-in Templates
              </div>
              <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
                {BUILTIN_LAYOUT_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onApplyLayoutPreset(p);
                      setSplitMenu(null);
                    }}
                    className="w-full flex items-center justify-between rounded-lg px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 transition text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-white truncate flex items-center gap-1.5">
                        <span>{p.name}</span>
                        <span className="text-[9px] px-1 py-0 rounded bg-white/10 text-slate-300 font-mono">
                          {p.layout}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">{p.description}</div>
                    </div>
                    <span className="text-[10px] font-mono shrink-0 ml-1" style={{ color: theme.accent }}>
                      Launch →
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export interface SaveLayoutPresetModalProps {
  activeTab: Tab;
  theme: DrexiusTheme;
  presetNameInput: string;
  setPresetNameInput: (v: string) => void;
  hostMap: Map<string, Host>;
  poppedOutPanes: PopoutPaneEntry[];
  onClose: () => void;
  onSave: () => void;
}

export function SaveLayoutPresetModal({
  activeTab,
  theme,
  presetNameInput,
  setPresetNameInput,
  hostMap,
  poppedOutPanes,
  onClose,
  onSave,
}: SaveLayoutPresetModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-md rounded-2xl border p-5 shadow-2xl backdrop-blur-xl ring-1 ring-white/10 text-slate-200"
        style={{
          backgroundColor: theme.xterm.background || '#0e131d',
          borderColor: `${theme.accent}30`,
          boxShadow: `0 20px 50px rgba(0,0,0,0.8), 0 0 30px ${theme.accent}20`,
        }}
      >
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Bookmark className="h-4 w-4" style={{ color: theme.accent }} />
            <h3 className="font-semibold text-white text-sm">Save Layout Preset</h3>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Preset Name</label>
            <input
              type="text"
              autoFocus
              value={presetNameInput}
              onChange={(e) => setPresetNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSave();
                if (e.key === 'Escape') onClose();
              }}
              placeholder="e.g. Full Stack Dev, Cloud Operations"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1"
              style={{ borderColor: `${theme.accent}60` }}
            />
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-white/5 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">Layout Geometry:</span>
              <span className="font-mono font-semibold" style={{ color: theme.accent }}>
                {getLayoutDescription(activeTab.layout ?? 'custom')}
              </span>
            </div>
            <div className="flex items-start justify-between text-slate-300">
              <span className="text-slate-400 shrink-0">Panes ({activeTab.panes.length}):</span>
              <span className="text-right truncate ml-2 text-slate-300">
                {activeTab.panes
                  .map((p) => hostMap.get(p.hostId)?.label || (p.isLocal ? 'Local Terminal' : 'Host'))
                  .join(' • ')}
              </span>
            </div>
            {poppedOutPanes.length > 0 && (
              <div className="flex items-start justify-between text-slate-300 pt-1 border-t border-white/5">
                <span className="text-cyan-300 shrink-0">Popped Out ({poppedOutPanes.length}):</span>
                <span className="text-right truncate ml-2 text-cyan-200">
                  {poppedOutPanes.map((e) => e.title).join(' • ')}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg text-white transition shadow-sm"
            style={{
              backgroundColor: theme.accent,
              color: 'var(--nx-accent-fg, #050810)',
            }}
          >
            Save Preset
          </button>
        </div>
      </div>
    </div>
  );
}
