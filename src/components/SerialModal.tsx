import { useEffect, useState } from 'react';
import { Radio, RefreshCw, X, Zap } from 'lucide-react';
import type { SerialPortInfo } from '../lib/types';
import { bridge } from '../lib/bridge';

interface Props {
  onClose: () => void;
  onConnect: (port: string, baud: number) => void;
}

export function SerialModal({ onClose, onConnect }: Props) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('/dev/ttyUSB0');
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [loading, setLoading] = useState(false);

  const loadPorts = async () => {
    setLoading(true);
    try {
      const p = await bridge.listSerialPorts();
      setPorts(p);
      if (p.length > 0 && !p.some((x) => x.portName === selectedPort)) {
        setSelectedPort(p[0].portName);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPorts();
  }, []);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPort) return;
    onConnect(selectedPort, baudRate);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0e131d] p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Serial Terminal (UART / RS-232)</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleConnect} className="mt-4 space-y-3">
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-slate-300">Serial Port / Device</label>
              <button
                type="button"
                onClick={loadPorts}
                title="Rescan serial ports"
                className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300"
              >
                <RefreshCw className={loading ? 'h-2.5 w-2.5 animate-spin' : 'h-2.5 w-2.5'} />
                <span>Rescan</span>
              </button>
            </div>
            <select
              value={selectedPort}
              onChange={(e) => setSelectedPort(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white focus:border-cyan-400 focus:outline-none"
            >
              {ports.map((p) => (
                <option key={p.portName} value={p.portName} className="bg-[#0e131d] text-white">
                  {p.portName} {p.description ? `(${p.description})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-slate-300">Custom Port Path</label>
            <input
              placeholder="/dev/ttyUSB0, COM3, etc."
              value={selectedPort}
              onChange={(e) => setSelectedPort(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-medium text-slate-300">Baud Rate (Speed)</label>
            <select
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white focus:border-cyan-400 focus:outline-none"
            >
              {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => (
                <option key={b} value={b} className="bg-[#0e131d] text-white">
                  {b} baud {b === 115200 ? '(Standard / Recommended)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-[10px] text-slate-400 bg-white/[0.02] p-2 rounded-lg border border-white/5">
            <div>
              <span className="text-slate-500 block">Data Bits</span>
              <span className="font-mono text-slate-200">8</span>
            </div>
            <div>
              <span className="text-slate-500 block">Parity</span>
              <span className="font-mono text-slate-200">None</span>
            </div>
            <div>
              <span className="text-slate-500 block">Stop Bits</span>
              <span className="font-mono text-slate-200">1</span>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2 pt-2 border-t border-white/5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-amber-500/20 border border-amber-400/40 px-3.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/30 transition shadow-sm flex items-center gap-1.5"
            >
              <Zap className="h-3.5 w-3.5" />
              <span>Connect Serial</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
