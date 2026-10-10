import { useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck, Trash2, RotateCw, Fingerprint } from 'lucide-react';
import type { KnownHost } from '../lib/types';
import { bridge } from '../lib/bridge';
import { cn } from '../utils/cn';

interface Props {
  toast: (m: string) => void;
}

export function KnownHostsPanel({ toast }: Props) {
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await bridge.listKnownHosts();
      setHosts(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleDelete = async (kh: KnownHost) => {
    if (
      confirm(
        `Revoke host key for ${kh.host}:${kh.port}?\nNexusTerminal will ask you to verify identity again on next connection.`
      )
    ) {
      try {
        await bridge.deleteKnownHost(kh.host, kh.port);
        await refresh();
        toast(`Revoked pinned host key for ${kh.host}`);
      } catch (e) {
        toast(`Failed to revoke: ${String(e)}`);
      }
    }
  };

  const filtered = useMemo(() => {
    return hosts.filter((h) => `${h.host} ${h.port} ${h.fingerprint}`.toLowerCase().includes(q.toLowerCase()));
  }, [hosts, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Known Hosts</h2>
          <p className="text-[11px] text-slate-500">Pinned SSH server public key fingerprints</p>
        </div>
        <button
          onClick={refresh}
          className="grid h-7 w-7 place-items-center rounded-lg bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
          title="Refresh known hosts"
        >
          <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by host or fingerprint…"
            className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {!filtered.length && (
          <div className="py-12 text-center text-xs text-slate-500">
            <Fingerprint className="mx-auto mb-2 h-8 w-8 opacity-30 text-slate-400" />
            No known host keys found.
            <div className="mt-1 text-[11px] text-slate-600">
              Fingerprints are pinned automatically on your first connection.
            </div>
          </div>
        )}

        {filtered.map((kh) => (
          <div
            key={`${kh.host}:${kh.port}`}
            className="group relative flex flex-col gap-1.5 rounded-xl border border-white/5 bg-white/[0.02] p-2.5 transition hover:border-white/15 hover:bg-white/[0.04]"
          >
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
                <ShieldCheck className="h-3.5 w-3.5" />
              </div>

              <div className="min-w-0 flex-1 font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-slate-200">{kh.host}</span>
                  <span className="rounded bg-white/5 px-1 py-0.5 text-[9px] text-slate-400">:{kh.port}</span>
                </div>
                <div className="truncate text-[10.5px] text-slate-500">{kh.fingerprint}</div>
              </div>

              <button
                onClick={() => handleDelete(kh)}
                title="Revoke pinned key"
                className="rounded p-1 text-slate-500 opacity-0 group-hover:opacity-100 hover:bg-rose-500/20 hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center justify-between border-t border-white/[0.04] pt-1 text-[10px] text-slate-500 font-mono">
              <span className="text-emerald-400/80">Verified & Pinned</span>
              <span>Added {new Date(kh.addedAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
