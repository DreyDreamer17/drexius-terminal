import { useEffect, useState, useRef } from 'react';
import {
  Radio,
  RefreshCw,
  X,
  Zap,
  SlidersHorizontal,
  ChevronDown,
  Cpu,
  Check,
  CheckCircle2,
  Terminal,
} from 'lucide-react';
import { bridge } from '../lib/bridge';
import type { SerialPortInfo } from '../lib/types';
import type { NexusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

interface Props {
  onClose: () => void;
  onConnect: (opts: {
    portName: string;
    baudRate: number;
    dataBits: number;
    parity: string;
    stopBits: number;
    flowControl: string;
  }) => void;
  theme?: NexusTheme;
}

interface SelectOption<T = string | number> {
  value: T;
  label: string;
  sublabel?: string;
  icon?: any;
}

interface CustomSelectProps<T = string | number> {
  value: T;
  onChange: (val: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  className?: string;
  dropUp?: boolean;
  theme?: NexusTheme;
}

function CustomSelect<T extends string | number>({
  value,
  onChange,
  options,
  placeholder,
  className,
  dropUp = false,
  theme,
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          background: 'rgba(255, 255, 255, 0.03)',
        }}
        className={cn(
          'w-full flex items-center justify-between rounded-xl border border-white/10 px-3.5 py-2.5 text-xs font-mono text-slate-100 transition hover:border-white/20 hover:bg-white/[0.05] focus:outline-none',
          open && 'border-white/25 ring-1 ring-white/10',
          className
        )}
      >
        <div className="flex flex-col text-left truncate mr-2">
          <span className="truncate">{selected ? selected.label : placeholder || String(value)}</span>
          {selected?.sublabel && (
            <span className="text-[10px] text-slate-400/80 truncate">{selected.sublabel}</span>
          )}
        </div>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-slate-400 transition-transform duration-150 shrink-0',
            open && 'rotate-180'
          )}
          style={{ color: open && theme?.accent ? theme.accent : undefined }}
        />
      </button>

      {open && (
        <div
          style={{ background: theme?.xterm?.background ?? '#0a0d14' }}
          className={cn(
            'absolute left-0 right-0 z-50 rounded-xl border border-white/15 p-1.5 shadow-2xl backdrop-blur-2xl ring-1 ring-white/10 max-h-56 overflow-y-auto',
            dropUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
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
                    isSelected && theme?.accent
                      ? {
                          backgroundColor: `${theme.accent}18`,
                          borderColor: `${theme.accent}35`,
                          color: theme.accent,
                        }
                      : undefined
                  }
                  className={cn(
                    'w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-xs font-mono transition text-left my-0.5',
                    isSelected
                      ? 'border font-semibold shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-white/5 border border-transparent'
                  )}
                >
                  <div className="flex flex-col truncate pr-2">
                    <span className="truncate">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="text-[10px] text-slate-400/70 truncate">{opt.sublabel}</span>
                    )}
                  </div>
                  {isSelected && (
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: theme?.accent || '#22d3ee' }}
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

const COMMON_BAUD_OPTIONS: SelectOption<number>[] = [
  { value: 9600, label: '9600 baud', sublabel: 'Cisco / Switches / Serial Console' },
  { value: 19200, label: '19200 baud', sublabel: 'Legacy Instruments' },
  { value: 38400, label: '38400 baud', sublabel: 'POS & Modems' },
  { value: 57600, label: '57600 baud', sublabel: 'Robotics & GPS' },
  { value: 115200, label: '115200 baud', sublabel: 'Arduino / ESP32 / Standard' },
  { value: 230400, label: '230400 baud', sublabel: 'High-speed MCU' },
  { value: 460800, label: '460800 baud', sublabel: 'High-speed Flashing' },
  { value: 921600, label: '921600 baud', sublabel: 'Ultra High-speed Flashing' },
  { value: -1, label: 'Custom baud…', sublabel: 'Enter non-standard speed' },
];

const DATA_BITS_OPTIONS: SelectOption<number>[] = [
  { value: 8, label: '8 bits (Standard)' },
  { value: 7, label: '7 bits' },
  { value: 6, label: '6 bits' },
  { value: 5, label: '5 bits' },
];

const PARITY_OPTIONS: SelectOption<string>[] = [
  { value: 'none', label: 'None (N)' },
  { value: 'odd', label: 'Odd (O)' },
  { value: 'even', label: 'Even (E)' },
];

const STOP_BITS_OPTIONS: SelectOption<number>[] = [
  { value: 1, label: '1 bit (Standard)' },
  { value: 2, label: '2 bits' },
];

const FLOW_OPTIONS: SelectOption<string>[] = [
  { value: 'none', label: 'None (Standard)' },
  { value: 'software', label: 'XON / XOFF (Software Flow)' },
  { value: 'hardware', label: 'RTS / CTS (Hardware Flow)' },
];

export function SerialModal({ onClose, onConnect, theme }: Props) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [port, setPort] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [baud, setBaud] = useState(115200);
  const [dataBits, setDataBits] = useState(8);
  const [parity, setParity] = useState('none');
  const [stopBits, setStopBits] = useState(1);
  const [flowControl, setFlowControl] = useState('none');
  const [customBaud, setCustomBaud] = useState('');
  const [isCustomBaud, setIsCustomBaud] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadPorts = async () => {
    setLoading(true);
    try {
      const list = await bridge.listSerialPorts();
      setPorts(list);
      if (list.length > 0 && !port) {
        setPort(list[0].portName);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPorts();
  }, []);

  const portOptions: SelectOption<string>[] = [
    ...ports.map((p) => ({
      value: p.portName,
      label: p.portName,
      sublabel: p.description || undefined,
    })),
    { value: '__custom__', label: 'Custom Port Path…', sublabel: 'Specify arbitrary device node' },
  ];

  const effectivePort = port === '__custom__' ? customPath.trim() : (port || customPath.trim());

  const applyPreset = (presetBaud: number, presetData: number, presetParity: string, presetStop: number, presetFlow: string) => {
    setIsCustomBaud(false);
    setBaud(presetBaud);
    setDataBits(presetData);
    setParity(presetParity);
    setStopBits(presetStop);
    setFlowControl(presetFlow);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectivePort) return;
    const finalBaud = isCustomBaud && customBaud.trim() ? parseInt(customBaud, 10) : baud;
    if (!finalBaud || finalBaud <= 0) return;

    onConnect({
      portName: effectivePort,
      baudRate: finalBaud,
      dataBits,
      parity,
      stopBits,
      flowControl,
    });
    onClose();
  };

  const parityLabel = parity === 'odd' ? 'O' : parity === 'even' ? 'E' : 'N';
  const finalBaudValue = isCustomBaud && customBaud.trim() ? customBaud : String(baud);
  const accentColor = theme?.accent || '#22d3ee';
  const bgColor = theme?.xterm?.background || '#0a0d14';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 select-none animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        style={{ background: bgColor }}
        className="relative w-full max-w-lg rounded-2xl border border-white/10 shadow-2xl overflow-hidden ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Subtle Ambient Radial Glow matching user theme */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-44 opacity-25"
          style={{
            background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)`,
          }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <div
              className="grid h-10 w-10 place-items-center rounded-2xl border transition shadow-lg"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white tracking-wide">Serial Terminal</h3>
              <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span>UART / RS-232 / USB Hardware Terminal</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Hardware Detection Status Banner */}
          <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-300">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="font-medium">
                {ports.length === 0
                  ? 'No serial ports detected (type path below)'
                  : `${ports.length} Serial Device${ports.length === 1 ? '' : 's'} Available`}
              </span>
            </div>
            <button
              type="button"
              onClick={loadPorts}
              title="Rescan hardware ports"
              className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 transition"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              <span>Rescan</span>
            </button>
          </div>

          {/* Quick Hardware Presets (matches AI Assistant action pills!) */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Quick Hardware Profiles
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => applyPreset(115200, 8, 'none', 1, 'none')}
                className="flex items-center gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/15 px-3 py-2 text-left text-xs text-slate-200 transition group"
              >
                <Cpu className="h-4 w-4 shrink-0" style={{ color: accentColor }} />
                <div className="truncate">
                  <div className="font-semibold text-white group-hover:text-cyan-200 truncate">Arduino / ESP32</div>
                  <div className="text-[10px] text-slate-400 font-mono">115200 8-N-1</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => applyPreset(9600, 8, 'none', 1, 'none')}
                className="flex items-center gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/15 px-3 py-2 text-left text-xs text-slate-200 transition group"
              >
                <Terminal className="h-4 w-4 shrink-0" style={{ color: accentColor }} />
                <div className="truncate">
                  <div className="font-semibold text-white group-hover:text-cyan-200 truncate">Cisco / Switch</div>
                  <div className="text-[10px] text-slate-400 font-mono">9600 8-N-1</div>
                </div>
              </button>
            </div>
          </div>

          {/* Port Selection */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Target Port / Device Node
            </label>
            <CustomSelect
              value={port || (portOptions[0]?.value ?? '')}
              onChange={(val) => setPort(val)}
              options={portOptions}
              placeholder="Select or enter serial port…"
              theme={theme}
            />

            {(port === '__custom__' || ports.length === 0) && (
              <input
                type="text"
                placeholder="e.g. /dev/ttyUSB0, /dev/ttyACM0, COM3..."
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                style={{ background: 'rgba(255, 255, 255, 0.03)' }}
                className="w-full rounded-xl border border-white/10 px-3.5 py-2.5 text-xs font-mono text-slate-100 placeholder:text-slate-500 shadow-inner focus:border-cyan-400/50 focus:outline-none focus:ring-1 focus:ring-cyan-400/20 transition mt-2"
              />
            )}
          </div>

          {/* Baud Rate */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Baud Rate (Speed)
              </label>
              <div className="flex items-center gap-1.5">
                {[9600, 115200, 921600].map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    onClick={() => {
                      setIsCustomBaud(false);
                      setBaud(rate);
                    }}
                    style={
                      !isCustomBaud && baud === rate
                        ? {
                            backgroundColor: `${accentColor}20`,
                            color: accentColor,
                            borderColor: `${accentColor}40`,
                          }
                        : undefined
                    }
                    className={cn(
                      'px-2 py-0.5 rounded-md text-[10px] font-mono border transition',
                      !isCustomBaud && baud === rate
                        ? 'font-bold'
                        : 'border-white/5 bg-white/[0.02] text-slate-400 hover:text-white hover:bg-white/5'
                    )}
                  >
                    {rate}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <CustomSelect
                value={isCustomBaud ? -1 : baud}
                onChange={(val) => {
                  if (val === -1) {
                    setIsCustomBaud(true);
                  } else {
                    setIsCustomBaud(false);
                    setBaud(val);
                  }
                }}
                options={COMMON_BAUD_OPTIONS}
                theme={theme}
              />

              <input
                type="number"
                placeholder="Custom baud..."
                disabled={!isCustomBaud}
                value={customBaud}
                onChange={(e) => {
                  setCustomBaud(e.target.value);
                  setIsCustomBaud(true);
                }}
                style={{
                  background: isCustomBaud ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.01)',
                }}
                className={cn(
                  'w-full rounded-xl border px-3.5 py-2.5 text-xs font-mono shadow-inner transition focus:outline-none',
                  isCustomBaud
                    ? 'border-white/20 text-slate-100 focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/20'
                    : 'border-white/5 text-slate-600 placeholder:text-slate-600 cursor-not-allowed'
                )}
              />
            </div>
          </div>

          {/* Framing Parameters Card */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5 space-y-3">
            <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5 pb-2">
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" style={{ color: accentColor }} />
                <span>Framing Parameters</span>
              </div>
              <span className="font-mono text-slate-500 text-[10px]">Standard: 8-N-1</span>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-[10px] font-medium text-slate-400 mb-1">
                  Data Bits
                </label>
                <CustomSelect
                  value={dataBits}
                  onChange={(val) => setDataBits(val)}
                  options={DATA_BITS_OPTIONS}
                  className="py-2"
                  theme={theme}
                />
              </div>

              <div>
                <label className="block text-[10px] font-medium text-slate-400 mb-1">
                  Parity
                </label>
                <CustomSelect
                  value={parity}
                  onChange={(val) => setParity(val)}
                  options={PARITY_OPTIONS}
                  className="py-2"
                  theme={theme}
                />
              </div>

              <div>
                <label className="block text-[10px] font-medium text-slate-400 mb-1">
                  Stop Bits
                </label>
                <CustomSelect
                  value={stopBits}
                  onChange={(val) => setStopBits(val)}
                  options={STOP_BITS_OPTIONS}
                  className="py-2"
                  theme={theme}
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-medium text-slate-400 mb-1">
                Flow Control
              </label>
              <CustomSelect
                value={flowControl}
                onChange={(val) => setFlowControl(val)}
                options={FLOW_OPTIONS}
                className="py-2"
                dropUp={true}
                theme={theme}
              />
            </div>
          </div>

          {/* Footer Controls */}
          <div className="flex items-center justify-between pt-3 border-t border-white/10">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Config:</span>
              <span
                className="rounded-lg px-2.5 py-1 text-xs font-mono font-medium border"
                style={{
                  backgroundColor: `${accentColor}12`,
                  borderColor: `${accentColor}30`,
                  color: accentColor,
                }}
              >
                {finalBaudValue} {dataBits}-{parityLabel}-{stopBits}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-4 py-2.5 text-xs font-medium text-slate-400 hover:bg-white/5 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!effectivePort}
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 0 20px ${accentColor}35`,
                }}
                className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg"
              >
                <Zap className="h-3.5 w-3.5 fill-current" />
                <span>Connect</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
