import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, FileText, FileArchive, FileCode, ChevronRight, ArrowUp, RefreshCw, FolderPlus, Upload, Download, Trash2, Pencil, X, Link2, HardDrive, Loader2, Home } from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';
import { registry } from '../lib/sessions';
import type { FileEntry } from '../lib/types';
import { cn } from '../utils/cn';

const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtPerm = (m?: number | null) => m == null ? '' : [6, 3, 0].map((s) => ((m >> s) & 4 ? 'r' : '-') + ((m >> s) & 2 ? 'w' : '-') + ((m >> s) & 1 ? 'x' : '-')).join('');
const iconFor = (e: FileEntry) => e.isDir ? Folder : /\.(gz|zip|tar|tgz|xz)$/.test(e.name) ? FileArchive : /\.(sh|go|py|js|ts|rs|yml|yaml|json|conf)$/.test(e.name) ? FileCode : FileText;

export function SftpDrawer({ activePaneId, tick, onClose, toast }: { activePaneId: string | null; tick: number; onClose: () => void; toast: (m: string) => void }) {
  const pane = activePaneId ? registry.get(activePaneId) : undefined;
  const sessionId = pane?.status === 'connected' ? pane.sessionId : null;
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [transfer, setTransfer] = useState<{ name: string; pct: number; dir: 'up' | 'down' } | null>(null);
  const [drag, setDrag] = useState(false);
  const [height, setHeight] = useState(300);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (p: string) => {
    if (!sessionId) return;
    setLoading(true); setErr(null);
    try {
      const list = await bridge.sftpList(sessionId, p);
      setEntries(list);
      if (!p && list[0]) p = list[0].path.slice(0, list[0].path.lastIndexOf('/')) || '/';
      if (!p) p = bridge.homeFor(sessionId) || '/';
      setPath(p);
    } catch (e) { setErr(isBridgeError(e) ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [sessionId]);

  // Follow the terminal's cwd (from OSC-7) — or start at home.
  const cwd = pane?.cwd;
  useEffect(() => {
    if (!sessionId) { setEntries([]); return; }
    const target = follow && cwd && cwd.startsWith('/') ? cwd : path || bridge.homeFor(sessionId) || '';
    if (target !== path || !entries.length) load(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd, follow, tick]);

  const go = (p: string) => { setFollow(false); load(p); };
  const up = () => go(path.replace(/\/[^/]+\/?$/, '') || '/');
  const crumbs = path.split('/').filter(Boolean);

  const upload = async (file: File | null) => {
    if (!sessionId) return;
    setTransfer({ name: file?.name ?? 'file', pct: 0, dir: 'up' });
    try { await bridge.sftpUpload(sessionId, path, file, (pct) => setTransfer((t) => t && { ...t, pct })); toast(`Uploaded ${file?.name ?? ''}`); load(path); }
    catch (e) { toast(isBridgeError(e) ? e.message : String(e)); }
    finally { setTimeout(() => setTransfer(null), 400); }
  };
  const download = async (e: FileEntry) => {
    if (!sessionId) return;
    setTransfer({ name: e.name, pct: 0, dir: 'down' });
    try { await bridge.sftpDownload(sessionId, e, (pct) => setTransfer((t) => t && { ...t, pct })); }
    catch (er) { toast(isBridgeError(er) ? er.message : String(er)); }
    finally { setTimeout(() => setTransfer(null), 400); }
  };
  const mkdir = async () => {
    if (!sessionId) return;
    const base = 'new-folder';
    let name = base; let i = 1;
    while (entries.some((e) => e.name === name)) name = `${base}-${i++}`;
    await bridge.sftpMkdir(sessionId, `${path.replace(/\/$/, '')}/${name}`);
    await load(path);
    setRenaming({ path: `${path.replace(/\/$/, '')}/${name}`, name });
  };
  const remove = async (e: FileEntry) => {
    if (!sessionId || !confirm(`Delete ${e.name}?`)) return;
    try { await bridge.sftpRemove(sessionId, e.path, e.isDir); toast(`Deleted ${e.name}`); load(path); } catch (er) { toast(isBridgeError(er) ? er.message : String(er)); }
  };
  const commitRename = async () => {
    if (!sessionId || !renaming) return;
    const to = renaming.path.replace(/[^/]+$/, renaming.name);
    if (to !== renaming.path) await bridge.sftpRename(sessionId, renaming.path, to).catch((e) => toast(isBridgeError(e) ? e.message : String(e)));
    setRenaming(null); load(path);
  };

  const startResize = (e: React.MouseEvent) => {
    const y0 = e.clientY; const h0 = height;
    const move = (ev: MouseEvent) => setHeight(Math.max(180, Math.min(window.innerHeight * 0.7, h0 - (ev.clientY - y0))));
    const upH = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', upH); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', upH);
  };

  const btn = 'grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30';

  return (
    <div className="relative flex shrink-0 flex-col border-t border-white/5 bg-[#0b0f17]/95 backdrop-blur" style={{ height }}>
      <div onMouseDown={startResize} className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize" />
      <div className="flex items-center gap-1 border-b border-white/5 px-3 py-1.5">
        <HardDrive className="h-4 w-4 text-emerald-300" />
        <span className="mr-2 text-xs font-semibold text-white">SFTP</span>
        <button className={btn} onClick={up} disabled={!sessionId || path === '/'}><ArrowUp className="h-3.5 w-3.5" /></button>
        <button className={btn} onClick={() => sessionId && go(bridge.homeFor(sessionId) || '')} disabled={!sessionId}><Home className="h-3.5 w-3.5" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md border border-white/5 bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-400">
          <button onClick={() => go('/')} className="hover:text-white">/</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3 text-slate-600" />}
              <button onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))} className="whitespace-nowrap hover:text-white">{c}</button>
            </span>
          ))}
        </div>
        <button onClick={() => setFollow((f) => !f)} title="Follow terminal working directory" className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px]', follow ? 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20' : 'text-slate-500 hover:text-white')}><Link2 className="h-3 w-3" />Follow cwd</button>
        <button className={btn} onClick={() => load(path)} disabled={!sessionId}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /></button>
        <button className={btn} onClick={mkdir} disabled={!sessionId}><FolderPlus className="h-3.5 w-3.5" /></button>
        <button className={btn} onClick={() => (isTauri ? upload(null) : fileInput.current?.click())} disabled={!sessionId}><Upload className="h-3.5 w-3.5" /></button>
        <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <button className={btn} onClick={onClose}><X className="h-3.5 w-3.5" /></button>
      </div>

      <div
        className={cn('relative min-h-0 flex-1 overflow-y-auto', drag && 'bg-emerald-400/5 ring-2 ring-inset ring-emerald-400/40')}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
      >
        {!sessionId ? (
          <div className="grid h-full place-items-center text-xs text-slate-600">Connect a session to browse its filesystem.</div>
        ) : err ? (
          <div className="grid h-full place-items-center text-xs text-rose-300">{err}</div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[#0b0f17] text-[10px] uppercase tracking-wider text-slate-500">
              <tr><th className="px-4 py-1.5 font-medium">Name</th><th className="w-24 font-medium">Size</th><th className="w-28 font-medium">Permissions</th><th className="w-40 font-medium">Modified</th><th className="w-28" /></tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const Icon = iconFor(e);
                return (
                  <tr key={e.path} onClick={() => setSelected(e.path)} onDoubleClick={() => (e.isDir ? go(e.path) : download(e))}
                    className={cn('group cursor-default border-t border-white/[0.03]', selected === e.path ? 'bg-cyan-400/10' : 'hover:bg-white/[0.03]')}>
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <Icon className={cn('h-4 w-4 shrink-0', e.isDir ? 'text-sky-300' : 'text-slate-400')} />
                        {renaming?.path === e.path ? (
                          <input autoFocus value={renaming.name} onChange={(ev) => setRenaming({ ...renaming, name: ev.target.value })} onBlur={commitRename} onKeyDown={(ev) => { if (ev.key === 'Enter') commitRename(); if (ev.key === 'Escape') setRenaming(null); }}
                            className="rounded border border-cyan-400/40 bg-black/50 px-1 font-mono text-xs text-white focus:outline-none" />
                        ) : <span className={cn('truncate', e.name.startsWith('.') ? 'text-slate-500' : 'text-slate-200')}>{e.name}</span>}
                      </div>
                    </td>
                    <td className="font-mono text-slate-500">{e.isDir ? '—' : fmtSize(e.size)}</td>
                    <td className="font-mono text-slate-500">{(e.isDir ? 'd' : '-') + fmtPerm(e.permissions)}</td>
                    <td className="text-slate-500">{e.modified ? new Date(e.modified * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</td>
                    <td className="pr-3">
                      <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100">
                        {!e.isDir && <button onClick={() => download(e)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-emerald-300"><Download className="h-3.5 w-3.5" /></button>}
                        <button onClick={() => setRenaming({ path: e.path, name: e.name })} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => remove(e)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!entries.length && !loading && <tr><td colSpan={5} className="py-8 text-center text-slate-600">Empty directory — drop files here to upload</td></tr>}
            </tbody>
          </table>
        )}
        {transfer && (
          <div className="absolute bottom-3 right-3 w-64 rounded-lg border border-white/10 bg-[#121826] p-3 shadow-2xl">
            <div className="flex items-center gap-2 text-[11px] text-slate-300">
              <Loader2 className="h-3 w-3 animate-spin text-emerald-300" />{transfer.dir === 'up' ? 'Uploading' : 'Downloading'} <span className="truncate font-mono">{transfer.name}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-all" style={{ width: `${transfer.pct * 100}%` }} /></div>
          </div>
        )}
      </div>
    </div>
  );
}
