import { useEffect, useRef, type CSSProperties } from 'react';
import { LayoutGrid, Search, History, Sparkles, Code2, type LucideIcon } from 'lucide-react';
import {
  scrollableAccessoryKeys,
  type TerminalModifiers,
} from '../lib/mobileTerminal';
import type { NexusTheme } from '../lib/themes';

export function TerminalAccessory({
  modifiers,
  onModifier,
  onKey,
  theme,
  tools,
}: {
  modifiers: TerminalModifiers;
  onModifier: (key: keyof TerminalModifiers) => void;
  onKey: (data: string) => void;
  theme?: NexusTheme;
  /** Pane tools that used to live in the (removed) top bar; the drawers (keypad, AI, snippets, history) are owned by the app. */
  tools?: { onKeypad: () => void; onSearch: () => void; onHistory: () => void; onAssistant?: () => void; onSnippets?: () => void };
}) {
  const touched = useRef(0);
  const toolbar = useRef<HTMLDivElement>(null);
  const actions = useRef<Record<string, () => void>>({});

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
  );
}
