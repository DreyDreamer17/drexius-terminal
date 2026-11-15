import { useMemo, useState } from 'react';
import { AlertTriangle, Ban, Keyboard, RotateCcw } from 'lucide-react';
import {
  BUILTIN_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  applyShortcutOverride,
  findShortcutConflict,
  isShortcutUnbound,
  type ShortcutBinding,
} from '../../lib/settings';

export interface ShortcutsSettingsTabProps {
  shortcuts: Record<string, ShortcutBinding>;
  onShortcutsChange: (shortcuts: Record<string, ShortcutBinding>) => void;
  accentColor: string;
  toast: (msg: string) => void;
}

export function ShortcutsSettingsTab({
  shortcuts,
  onShortcutsChange,
  accentColor,
  toast,
}: ShortcutsSettingsTabProps) {
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string>('');
  // Kept while the recorder is open after a clash, so the user can read what is in the way and
  // choose to override (rebindable clash) or dismiss (built-in clash) instead of losing the
  // attempt to a transient toast.
  const [conflict, setConflict] = useState<{
    id: string;
    combo: string;
    clashLabel: string;
    builtin: boolean;
  } | null>(null);

  const closeRecorder = () => {
    setEditingShortcutId(null);
    setRecordedKeys('');
    setConflict(null);
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

  const shortcutCategories = useMemo(() => {
    const groups: Record<string, ShortcutBinding[]> = {};
    for (const item of Object.values(shortcuts)) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    }
    return groups;
  }, [shortcuts]);

  return (
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
            <h4 className="text-sm font-semibold text-white">Directional Split Navigation</h4>
            <p className="text-xs text-slate-300 leading-relaxed">
              Move seamlessly between split terminal panes using directional arrow keys without touching your mouse.
              Press{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">
                Alt + Left
              </kbd>
              ,{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">
                Alt + Right
              </kbd>
              ,{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">
                Alt + Up
              </kbd>
              , or{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20 font-mono text-[11px] text-white">
                Alt + Down
              </kbd>{' '}
              to focus adjacent panes.
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
          <div key={category} className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
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
                        <div className="text-[11px] text-slate-400 truncate">{item.description}</div>
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
                                <span className="font-mono font-semibold">{conflict.combo}</span> is reserved for the
                                built-in <span className="font-semibold">{conflict.clashLabel}</span> action and cannot
                                be reassigned. Choose a different combination.
                              </>
                            ) : (
                              <>
                                <span className="font-mono font-semibold">{conflict.combo}</span> is already used by{' '}
                                <span className="font-semibold">{conflict.clashLabel}</span>. Overriding will bind it
                                to <span className="font-semibold">{item.label}</span> and unbind {conflict.clashLabel}.
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
            <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
              Fixed · cannot be rebound
            </span>
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
  );
}
