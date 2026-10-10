import { useMemo, useState } from 'react';
import { Search, Plus, KeyRound, Lock, Fingerprint, Pencil, Trash2, Columns2 } from 'lucide-react';
import type { Host } from '../lib/types';
import { registry } from '../lib/sessions';
import { OsIcon } from './OsIcon';

interface Props {
  hosts: Host[];
  onConnect: (h: Host) => void;
  onSplit: (h: Host) => void;
  onEdit: (h: Host | null) => void;
  onDelete: (h: Host) => void;
}

const authIcon = { key: KeyRound, password: Lock, agent: Fingerprint };

export function HostSidebar({ hosts, onConnect, onSplit, onEdit, onDelete }: Props) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const f = hosts.filter((h) => `${h.label} ${h.hostname} ${h.username} ${h.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
    const m = new Map<string, Host[]>();
    for (const h of f) { const g = h.group || 'Ungrouped'; m.set(g, [...(m.get(g) ?? []), h]); }
    return [...m.entries()];
  }, [hosts, q]);
  const live = new Set(registry.all().filter((p) => p.status === 'connected').map((p) => p.hostId));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Hosts</h2>
          <p className="text-[11px] text-slate-500">{hosts.length} profiles · encrypted vault</p>
        </div>
        <button onClick={() => onEdit(null)} className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-400/10 text-cyan-300 ring-1 ring-cyan-400/20 hover:bg-cyan-400/20"><Plus className="h-4 w-4" /></button>
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5 focus-within:border-cyan-400/30">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search hosts, tags…" className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {groups.map(([g, list]) => (
          <div key={g} className="mt-3">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{g}</div>
            {list.map((h) => {
              const Icon = authIcon[h.authMethod];
              return (
                <div key={h.id} onDoubleClick={() => onConnect(h)} className="group relative flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.04]" onClick={() => onConnect(h)}>
                  <div className="relative">
                    <OsIcon os={h.os} color={h.color} size={32} />
                    {live.has(h.id) && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[#0b0f17]" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-slate-200">{h.label}<Icon className="h-3 w-3 text-slate-600" /></div>
                    <div className="truncate font-mono text-[10.5px] text-slate-500">{h.username}@{h.hostname}{h.port !== 22 ? `:${h.port}` : ''}</div>
                  </div>
                  <div className="absolute right-1.5 hidden items-center gap-0.5 rounded-md bg-[#121826] p-0.5 shadow-lg ring-1 ring-white/10 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                    <button title="Open in split pane" onClick={() => onSplit(h)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-cyan-300"><Columns2 className="h-3.5 w-3.5" /></button>
                    <button title="Edit" onClick={() => onEdit(h)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                    <button title="Delete" onClick={() => onDelete(h)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {!groups.length && <p className="mt-8 text-center text-xs text-slate-600">No hosts match.</p>}
      </div>
    </div>
  );
}
