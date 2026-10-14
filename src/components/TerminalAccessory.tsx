import { useEffect, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import {
  scrollableAccessoryKeys,
  keyPaletteGroups,
  type TerminalModifiers,
} from '../lib/mobileTerminal';
import type { NexusTheme } from '../lib/themes';
import { MobileSheet } from './MobileSheet';

export function TerminalAccessory({
  modifiers,
  onModifier,
  onKey,
  theme,
}: {
  modifiers: TerminalModifiers;
  onModifier: (key: keyof TerminalModifiers) => void;
  onKey: (data: string) => void;
  theme?: NexusTheme;
}) {
  const touched = useRef(0);
  const toolbar = useRef<HTMLDivElement>(null);
  const actions = useRef<Record<string, () => void>>({});
  const [showPalette, setShowPalette] = useState(false);

  const accentColor = theme?.accent || '#22d3ee';
  const bgColor = theme?.xterm.background || '#0e131d';

  useEffect(() => {
    const node = toolbar.current;
    const touch = (event: TouchEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
      if (!button) return;
      touched.current = Date.now();
      const key = button.dataset.key;
      if (key && actions.current[key]) {
        event.preventDefault();
        actions.current[key]();
      }
    };
    node?.addEventListener('touchstart', touch, { passive: false });
    return () => node?.removeEventListener('touchstart', touch);
  }, []);

  const button = (
    label: string,
    action: () => void,
    pressed?: boolean,
    opts?: { ariaLabel?: string; interrupt?: boolean }
  ) => {
    actions.current[label] = action;
    const ariaLabel = opts?.ariaLabel || (label === 'esc' ? 'Escape' : label === 'tab' ? 'Tab' : label);
    return (
      <button
        key={label}
        data-key={label}
        type="button"
        aria-label={ariaLabel}
        aria-pressed={pressed}
        style={
          pressed
            ? {
                backgroundColor: `${accentColor}28`,
                borderColor: `${accentColor}90`,
                color: accentColor,
                boxShadow: `0 0 10px ${accentColor}30`,
              }
            : opts?.interrupt
            ? {
                color: '#fb7185',
                borderColor: 'rgba(251, 113, 133, 0.3)',
                backgroundColor: 'rgba(251, 113, 133, 0.08)',
              }
            : undefined
        }
        className={`nx-terminal-key ${pressed ? 'nx-key-latched' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault();
          if (Date.now() - touched.current > 700) action();
        }}
        onClick={(e) => {
          if (e.detail === 0) action();
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <>
      <div
        ref={toolbar}
        className="nx-terminal-accessory md:hidden"
        style={{
          backgroundColor: `${bgColor}fa`,
          borderTopColor: 'rgba(255, 255, 255, 0.08)',
        }}
        role="toolbar"
        aria-label="Terminal keyboard keys"
      >
        {/* Toggle Full Palette Button (Termius style) */}
        <button
          type="button"
          aria-label="Open extended keys palette"
          onClick={() => setShowPalette(true)}
          className="nx-terminal-key shrink-0"
          style={{ borderColor: `${accentColor}40`, color: accentColor }}
        >
          <LayoutGrid size={15} />
        </button>

        {button('esc', () => onKey('\x1b'), false, { ariaLabel: 'Escape' })}
        {button('tab', () => onKey('\t'), false, { ariaLabel: 'Tab' })}
        {button('ctrl', () => onModifier('ctrl'), modifiers.ctrl, { ariaLabel: 'CTRL' })}
        {button('alt', () => onModifier('alt'), modifiers.alt, { ariaLabel: 'ALT' })}

        {scrollableAccessoryKeys.slice(2).map(([label, data]) =>
          button(
            label,
            () => onKey(data),
            false,
            label === '^C' ? { interrupt: true, ariaLabel: 'Ctrl+C' } : undefined
          )
        )}
      </div>

      {showPalette && (
        <MobileSheet title="Extended Keypad" onClose={() => setShowPalette(false)}>
          <div className="space-y-4 pb-6">
            {keyPaletteGroups.map((group) => (
              <div key={group.title}>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  {group.title}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {group.keys.map((k) => (
                    <button
                      key={k.label}
                      type="button"
                      onClick={() => {
                        onKey(k.data);
                      }}
                      className="flex h-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] font-mono text-xs font-medium text-slate-200 active:bg-white/20 active:scale-95 transition"
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </MobileSheet>
      )}
    </>
  );
}
