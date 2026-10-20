import { cn } from '../utils/cn';

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
  accentColor?: string;
  ariaLabel?: string;
  className?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  accentColor = '#22d3ee',
  ariaLabel,
  className,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-all duration-200 ease-in-out focus:outline-none border select-none disabled:opacity-40 disabled:cursor-not-allowed',
        checked ? 'border-transparent shadow-sm' : 'border-white/10 bg-white/10 hover:bg-white/15',
        className
      )}
      style={{
        backgroundColor: checked ? accentColor : undefined,
        boxShadow: checked ? `0 0 12px ${accentColor}50` : undefined,
      }}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out',
          checked ? 'translate-x-4.5' : 'translate-x-0.5 opacity-80'
        )}
      />
    </button>
  );
}
