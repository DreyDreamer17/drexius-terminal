import { useEffect, useRef, type CSSProperties } from 'react';
import { LayoutGrid, Search, History, Sparkles, Code2, type LucideIcon } from 'lucide-react';
import {
  scrollableAccessoryKeys,
  type TerminalModifiers,
} from '../lib/mobileTerminal';
import type { DrexiusTheme } from '../lib/themes';

export function TerminalAccessory({
  modifiers,
  onModifier,
  onKey,
  theme,
  tools,
  hasSuggestion,
}: {
  modifiers: TerminalModifiers;
  onModifier: (key: keyof TerminalModifiers) => void;
  onKey: (data: string) => void;
  theme?: DrexiusTheme;
  /** Pane tools that used to live in the (removed) top bar; the drawers (keypad, AI, snippets, history) are owned by the app. */
  tools?: { onKeypad: () => void; onSearch: () => void; onHistory: () => void; onAssistant?: () => void; onSnippets?: () => void };
  hasSuggestion?: boolean;
}) {
  const touched = useRef(0);
  const toolbar = useRef<HTMLDivElement>(null);
  const actions = useRef<Record<string, () => void>>({});
  // Pending-tap tracking for tap-vs-scroll disambiguation. Firing on
  // touchstart meant every horizontal scroll began by typing the key under
  // the finger (and preventDefault fought the scroll itself). Instead we
  // record the touchdown passively and only fire on a near-stationary,
  // short touchend; real swipes glide without typing anything.
  const tap = useRef<{ key: string; x: number; y: number; t: number } | null>(null);
  const TAP_SLOP_PX = 12;
  const TAP_MAX_MS = 500;

  const accentColor = theme?.accent || '#22d3ee';
  const bgColor = theme?.xterm.background || '#0e131d';

  useEffect(() => {
    const node = toolbar.current;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
      tap.current = button?.dataset.key
        ? { key: button.dataset.key, x: touch.clientX, y: touch.clientY, t: Date.now() }
        : null;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const pending = tap.current;
      tap.current = null;
      if (!pending) return;
      const touch = event.changedTouches[0];
      const moved = Math.hypot(touch.clientX - pending.x, touch.clientY - pending.y);
      if (moved <= TAP_SLOP_PX && Date.now() - pending.t <= TAP_MAX_MS && actions.current[pending.key]) {
        // Stamp so the synthesized mousedown (~300ms later) is ignored by the guard below.
        touched.current = Date.now();
        actions.current[pending.key]();
      }
    };
    const onTouchCancel = () => {
      tap.current = null;
    };
    // Passive: never block the scroll gesture itself.
    node?.addEventListener('touchstart', onTouchStart, { passive: true });
    node?.addEventListener('touchend', onTouchEnd, { passive: true });
    node?.addEventListener('touchcancel', onTouchCancel);
    return () => {
      node?.removeEventListener('touchstart', onTouchStart);
      node?.removeEventListener('touchend', onTouchEnd);
      node?.removeEventListener('touchcancel', onTouchCancel);
    };
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
        className={`nx-terminal-key ${pressed ? 'nx-key-latched' : ''} ${opts?.interrupt ? 'nx-key-interrupt' : ''}`}
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

  const tool = (label: string, Icon: LucideIcon, tint: string, action: () => void) => (
    <button type="button" aria-label={label} className="nx-terminal-key nx-terminal-tool" style={{ '--nx-tool': tint } as CSSProperties}
      onMouseDown={(e) => e.preventDefault()} onClick={action}>
      <Icon size={16} strokeWidth={1.9} />
    </button>
  );

  return (
      <div
        ref={toolbar}
        className="nx-terminal-accessory md:hidden"
        style={{ backgroundColor: `${bgColor}fa`, '--nx-accent': accentColor } as CSSProperties}
        role="toolbar"
        aria-label="Terminal keyboard keys"
      >
        {/* Pane tools: borderless tinted glyphs, separated from the keys by a hairline. */}
        {tools && (
          <>
            {tool('Open extended keys palette', LayoutGrid, accentColor, tools.onKeypad)}
            {tools.onAssistant && tool('AI Assistant', Sparkles, '#f0abfc', tools.onAssistant)}
            {tools.onSnippets && tool('Snippets', Code2, '#c4b5fd', tools.onSnippets)}
            {tool('Search terminal', Search, '#94a3b8', tools.onSearch)}
            {tool('Command history', History, '#94a3b8', tools.onHistory)}
            <span className="nx-terminal-divider" aria-hidden="true" />
          </>
        )}

        {button('esc', () => onKey('\x1b'), false, { ariaLabel: 'Escape' })}
        {button('tab', () => onKey('\t'), hasSuggestion, { ariaLabel: hasSuggestion ? 'Accept suggestion (Tab)' : 'Tab' })}
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
  );
}
