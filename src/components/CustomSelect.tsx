import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { DrexiusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

export interface SelectOption<T = string | number> {
  value: T;
  label: string;
  sublabel?: string;
  icon?: ReactNode;
}

export interface CustomSelectProps<T = string | number> {
  value: T;
  onChange: (val: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  className?: string;
  dropUp?: boolean;
  theme?: DrexiusTheme;
  accentColor?: string;
}

export function CustomSelect<T extends string | number>({
  value,
  onChange,
  options,
  placeholder,
  className,
  dropUp = false,
  theme,
  accentColor: customAccent,
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [isDropUp, setIsDropUp] = useState(dropUp);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (dropUp) {
      setIsDropUp(true);
    } else if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setIsDropUp(spaceBelow < 240);
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [open, dropUp]);

  const selected = options.find((o) => o.value === value);
  const accentColor = customAccent || theme?.accent || '#22d3ee';
  const bgColor = theme?.xterm?.background || '#0a0d14';

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          background: 'rgba(255, 255, 255, 0.03)',
        }}
        className={cn(
          'w-full flex items-center justify-between rounded-xl border border-white/10 px-3.5 py-2.5 text-xs font-mono text-slate-100 transition hover:border-white/20 hover:bg-white/[0.05] focus:outline-none select-none',
          open && 'border-white/25 ring-1 ring-white/10',
          className
        )}
      >
        <div className="flex items-center gap-2 truncate mr-2">
          {selected?.icon && <span className="shrink-0">{selected.icon}</span>}
          <div className="flex flex-col text-left truncate">
            <span className="truncate">{selected ? selected.label : placeholder || String(value)}</span>
            {selected?.sublabel && (
              <span className="text-[10px] text-slate-400/80 truncate">{selected.sublabel}</span>
            )}
          </div>
        </div>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-slate-400 transition-transform duration-150 shrink-0',
            open && 'rotate-180'
          )}
          style={{ color: open ? accentColor : undefined }}
        />
      </button>

      {open && (
        <div
          style={{ background: bgColor }}
          className={cn(
            'absolute left-0 right-0 z-50 rounded-xl border border-white/15 p-1.5 shadow-2xl backdrop-blur-2xl ring-1 ring-white/10 max-h-56 overflow-y-auto',
            isDropUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          )}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500 font-mono">No options available</div>
          ) : (
            options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  style={
                    isSelected
                      ? {
                          backgroundColor: `${accentColor}18`,
                          borderColor: `${accentColor}35`,
                          color: accentColor,
                        }
                      : undefined
                  }
                  className={cn(
                    'w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-xs font-mono transition text-left my-0.5 select-none',
                    isSelected
                      ? 'border font-semibold shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-white/5 border border-transparent'
                  )}
                >
                  <div className="flex items-center gap-2 truncate pr-2">
                    {opt.icon && <span className="shrink-0">{opt.icon}</span>}
                    <div className="flex flex-col truncate">
                      <span className="truncate">{opt.label}</span>
                      {opt.sublabel && (
                        <span className="text-[10px] text-slate-400/70 truncate">{opt.sublabel}</span>
                      )}
                    </div>
                  </div>
                  {isSelected && (
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: accentColor }}
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
