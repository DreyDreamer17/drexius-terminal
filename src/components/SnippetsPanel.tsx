import { useMemo, useState } from 'react';
import { Search, Plus, Play, Radio, Pencil, Trash2, Code2, Check, X } from 'lucide-react';
import type { Snippet } from '../lib/types';
import { registry } from '../lib/sessions';
import { classifyRisk } from '../lib/ollama';
import { cn } from '../utils/cn';

interface Props {
  snippets: Snippet[];
  activePaneId: string | null;
  onSave: (s: Snippet) => void;
  onDelete: (id: string) => void;
  toast: (m: string) => void;
  /** Phone drawer: the header is drawn in the modal language (badge, uppercase title, close). */
  drawer?: { accent: string; onClose: () => void };
}

const placeholders = (cmd: string) => [...new Set([...cmd.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];

export function SnippetsPanel({ snippets, activePaneId, onSave, onDelete, toast, drawer }: Props) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [running, setRunning] = useState<{ s: Snippet; vars: Record<string, string>; broadcast: boolean } | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, Snippet[]>();
    snippets.filter((s) => `${s.name} ${s.command} ${s.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
      .forEach((s) => { const f = s.folder || 'General'; m.set(f, [...(m.get(f) ?? []), s]); });
    return [...m.entries()];
  }, [snippets, q]);

  const exec = (cmd: string, broadcast: boolean) => {
    const targets = broadcast ? registry.all().filter((p) => p.status === 'connected') : [registry.get(activePaneId ?? '')].filter(Boolean);
    if (!targets.length) { toast('No connected session to run on'); return; }
    targets.forEach((p) => p!.send(cmd + '\r'));
    toast(broadcast ? `Broadcast to ${targets.length} session(s)` : 'Snippet executed');
  };

  const start = (s: Snippet, broadcast: boolean) => {
    const ph = placeholders(s.command);
    if (ph.length) setRunning({ s, broadcast, vars: Object.fromEntries(ph.map((p) => [p, ''])) });
    else exec(s.command, broadcast);
  };

  const input = 'w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none';

  return (
    <div className="flex h-full flex-col">
      {drawer ? (
        <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-4 pb-3 pt-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border shadow-lg"
              style={{ backgroundColor: `${drawer.accent}18`, borderColor: `${drawer.accent}35`, color: drawer.accent, boxShadow: `0 0 20px ${drawer.accent}25` }}
            >
              <Code2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">Snippets</h3>
              <p className="truncate text-[11px] text-slate-500">Tap to run · {'{{vars}}'} supported</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="New snippet"
              onClick={() => setEditing({ id: '', name: '', command: '', folder: '', tags: [] })}
              className="grid h-11 w-11 place-items-center rounded-xl border transition active:brightness-125"
              style={{ backgroundColor: `${drawer.accent}20`, borderColor: `${drawer.accent}40`, color: drawer.accent }}
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              aria-label="Close snippets drawer"
              onClick={drawer.onClose}
              className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-white/10 hover:text-white active:bg-white/10"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>
        </header>
      ) : (
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div><h2 className="text-sm font-semibold text-white">Snippets</h2><p className="text-[11px] text-slate-500">Reusable commands · {'{{vars}}'} supported</p></div>
        <button onClick={() => setEditing({ id: '', name: '', command: '', folder: '', tags: [] })} className="grid h-7 w-7 place-items-center rounded-lg bg-violet-400/10 text-violet-300 ring-1 ring-violet-400/20 hover:bg-violet-400/20"><Plus className="h-4 w-4" /></button>
      </div>
      )}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search snippets…" className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none" />
        </div>
      </div>

      {editing && (
        <div className="mx-3 mb-2 space-y-2 rounded-xl border border-violet-400/20 bg-violet-400/[0.04] p-3">
          <input className={input} placeholder="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <textarea rows={3} className={cn(input, 'resize-none font-mono')} placeholder="command --flag {{var}}" value={editing.command} onChange={(e) => setEditing({ ...editing, command: e.target.value })} />
          <input className={input} placeholder="Folder" value={editing.folder ?? ''} onChange={(e) => setEditing({ ...editing, folder: e.target.value })} />
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setEditing(null)} className="rounded-md px-2.5 py-1 text-[11px] text-slate-400 hover:bg-white/5">Cancel</button>
            <button disabled={!editing.name || !editing.command} onClick={() => { onSave(editing); setEditing(null); }} className="rounded-md bg-violet-400 px-2.5 py-1 text-[11px] font-semibold text-black disabled:opacity-40">Save</button>
          </div>
        </div>
      )}

      {running && (
        <div className="mx-3 mb-2 space-y-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
          <div className="text-[11px] font-medium text-cyan-200">Fill variables for “{running.s.name}”</div>
          {Object.keys(running.vars).map((k) => (
            <input key={k} autoFocus className={input} placeholder={k} value={running.vars[k]} onChange={(e) => setRunning({ ...running, vars: { ...running.vars, [k]: e.target.value } })} />
          ))}
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setRunning(null)} className="rounded-md p-1 text-slate-400 hover:bg-white/5"><X className="h-3.5 w-3.5" /></button>
            <button onClick={() => { exec(running.s.command.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => running.vars[k] ?? ''), running.broadcast); setRunning(null); }} className="flex items-center gap-1 rounded-md bg-cyan-400 px-2.5 py-1 text-[11px] font-semibold text-black"><Check className="h-3 w-3" />Run</button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {groups.map(([folder, list]) => (
          <div key={folder} className="mt-3">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{folder}</div>
            {list.map((s) => {
              const risk = classifyRisk(s.command);
              return (
                <div key={s.id} className="group mb-1 rounded-lg border border-transparent px-2 py-2 hover:border-white/5 hover:bg-white/[0.03]">
                  <div className="flex items-center gap-2">
                    <Code2 className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                    <span className="truncate text-[13px] text-slate-200">{s.name}</span>
                    {risk.level !== 'safe' && <span className={cn('rounded px-1 text-[9px] font-semibold uppercase', risk.level === 'danger' ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-400/15 text-amber-300')}>{risk.level}</span>}
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button title="Run in active pane" onClick={() => start(s, false)} className="rounded p-1 text-emerald-300 hover:bg-emerald-400/10"><Play className="h-3.5 w-3.5" /></button>
                      <button title="Broadcast to all sessions" onClick={() => start(s, true)} className="rounded p-1 text-cyan-300 hover:bg-cyan-400/10"><Radio className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditing(s)} className="rounded p-1 text-slate-400 hover:bg-white/10"><Pencil className="h-3.5 w-3.5" /></button>
                      <button onClick={() => onDelete(s.id)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                  <code className="mt-1 block truncate pl-5 font-mono text-[10.5px] text-slate-500">{s.command}</code>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
