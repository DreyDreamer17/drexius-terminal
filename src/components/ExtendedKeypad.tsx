import { keyPaletteGroups } from '../lib/mobileTerminal';

/**
 * Grid of the less common keys (tmux prefixes, navigation, F-keys, symbols) for the phone drawer.
 * Keys never take focus — the terminal keeps the keyboard it has — and go through the pane's
 * accessory-key pipeline so application cursor mode and modifier latches behave as in the key row.
 */
export function ExtendedKeypad({ onKey }: { onKey: (data: string) => void }) {
  return (
    <div className="nx-keypad min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
      {keyPaletteGroups.map((group) => (
        <section key={group.title} className="mb-4 last:mb-0">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group.title}</h4>
          <div className="grid grid-cols-4 gap-2">
            {group.keys.map((k) => (
              <button
                key={k.label}
                type="button"
                className="nx-keypad-key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onKey(k.data)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
