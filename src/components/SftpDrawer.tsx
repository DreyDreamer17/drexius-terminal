import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FileText, FileArchive, FileCode, ChevronRight, ArrowUp, RefreshCw, FolderPlus, Upload, Download, Trash2, Pencil, X, Link2, HardDrive, Loader2, Home, Save, AlertCircle } from 'lucide-react';
import { bridge, isTauri, isBridgeError } from '../lib/bridge';
import { registry } from '../lib/sessions';
import type { FileEntry } from '../lib/types';
import { cn } from '../utils/cn';
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { confirmDialog } from './ConfirmDialog';

const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtPerm = (m?: number | null) => m == null ? '' : [6, 3, 0].map((s) => ((m >> s) & 4 ? 'r' : '-') + ((m >> s) & 2 ? 'w' : '-') + ((m >> s) & 1 ? 'x' : '-')).join('');
const iconFor = (e: FileEntry) => e.isDir ? Folder : /\.(gz|zip|tar|tgz|xz)$/.test(e.name) ? FileArchive : /\.(sh|go|py|js|ts|rs|yml|yaml|json|conf)$/.test(e.name) ? FileCode : FileText;

export function SftpDrawer({
  activePaneId,
  tick,
  onClose,
  toast,
  theme,
}: {
  activePaneId: string | null;
  tick: number;
  onClose: () => void;
  toast: (m: string) => void;
  theme?: DrexiusTheme;
}) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0b0f17';

  const pane = activePaneId ? registry.get(activePaneId) : undefined;
  const sessionId = pane?.status === 'connected' ? pane.sessionId : null;
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [editingFile, setEditingFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [transfer, setTransfer] = useState<{ name: string; pct: number; dir: 'up' | 'down' } | null>(null);
  const [drag, setDrag] = useState(false);
  const [height, setHeight] = useState(300);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (p: string) => {
    if (!sessionId) return;
    const generation = ++loadGeneration.current;
    setLoading(true); setErr(null);
    try {
      const list = await bridge.sftpList(sessionId, p);
      if (generation !== loadGeneration.current) return;
      setEntries(list);
      if (!p && list[0]) p = list[0].path.slice(0, list[0].path.lastIndexOf('/')) || '/';
      if (!p) p = bridge.homeFor(sessionId) || '/';
      setPath(p);
    } catch (e) {
      if (generation === loadGeneration.current) {
        setErr(isBridgeError(e) ? e.message : String(e));
      }
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
      }
    }
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
    if (!sessionId || !(await confirmDialog({ title: `Delete ${e.name}?`, confirmLabel: 'Delete', danger: true }))) return;
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
    <div
      className="relative flex shrink-0 flex-col border-t border-white/5 backdrop-blur"
      style={{ height, backgroundColor: `${bgColor}fa` }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-16 opacity-15"
        style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
      />
      <div onMouseDown={startResize} className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-10" />
      <div className="relative flex items-center gap-1 border-b border-white/5 px-3 py-1.5">
        <HardDrive className="h-4 w-4" style={{ color: accentColor }} />
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
        <button
          onClick={() => setFollow((f) => !f)}
          title="Follow terminal working directory"
          className={cn(
            'flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] border transition',
            !follow && 'border-transparent text-slate-500 hover:text-white'
          )}
          style={follow ? {
            backgroundColor: `${accentColor}18`,
            borderColor: `${accentColor}35`,
            color: accentColor,
          } : undefined}
        >
          <Link2 className="h-3 w-3" />
          Follow cwd
        </button>
        <button className={btn} onClick={() => load(path)} disabled={!sessionId}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /></button>
        <button className={btn} onClick={mkdir} disabled={!sessionId}><FolderPlus className="h-3.5 w-3.5" /></button>
        <button className={btn} onClick={() => (isTauri ? upload(null) : fileInput.current?.click())} disabled={!sessionId}><Upload className="h-3.5 w-3.5" /></button>
        <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        <button className={btn} onClick={onClose}><X className="h-3.5 w-3.5" /></button>
      </div>

      <div
        className={cn('relative min-h-0 flex-1 overflow-y-auto', drag && 'bg-white/5 ring-2 ring-inset')}
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
            <thead className="sticky top-0 text-[10px] uppercase tracking-wider text-slate-500" style={{ backgroundColor: bgColor }}>
              <tr><th className="px-4 py-1.5 font-medium">Name</th><th className="w-24 font-medium">Size</th><th className="w-28 font-medium">Permissions</th><th className="w-40 font-medium">Modified</th><th className="w-28" /></tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const Icon = iconFor(e);
                return (
                  <tr
                    key={e.path}
                    onClick={() => setSelected(e.path)}
                    onDoubleClick={() => {
                      if (e.isDir) {
                        go(e.path);
                      } else if (/\.(gz|zip|tar|tgz|xz|png|jpg|jpeg|gif|ico|pdf|bin|exe|so|dylib)$/i.test(e.name) || e.size > 2 * 1024 * 1024) {
                        download(e);
                      } else {
                        setEditingFile({ path: e.path, name: e.name, size: e.size });
                      }
                    }}
                    className={cn('group cursor-default border-t border-white/[0.03]', selected === e.path ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')}
                    style={selected === e.path ? { borderLeft: `2px solid ${accentColor}` } : undefined}
                  >
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 shrink-0" style={e.isDir ? { color: accentColor } : { color: '#94a3b8' }} />
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
                        {!e.isDir && (
                          <>
                            <button title="Edit remote file" onClick={() => setEditingFile({ path: e.path, name: e.name, size: e.size })} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white">
                              <FileCode className="h-3.5 w-3.5" />
                            </button>
                            <button title="Download" onClick={() => download(e)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white">
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        <button title="Rename" onClick={() => setRenaming({ path: e.path, name: e.name })} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                        <button title="Delete" onClick={() => remove(e)} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
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
          <div className="absolute bottom-3 right-3 w-64 rounded-xl border border-white/10 bg-[#121826] p-3 shadow-2xl">
            <div className="flex items-center gap-2 text-[11px] text-slate-300">
              <Loader2 className="h-3 w-3 animate-spin" style={{ color: accentColor }} />{transfer.dir === 'up' ? 'Uploading' : 'Downloading'} <span className="truncate font-mono">{transfer.name}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full transition-all" style={{ width: `${transfer.pct * 100}%`, backgroundColor: accentColor }} /></div>
          </div>
        )}
      </div>

      {editingFile && sessionId && (
        <RemoteFileEditorModal
          sessionId={sessionId}
          file={editingFile}
          onClose={() => setEditingFile(null)}
          toast={toast}
          onSaved={() => load(path)}
          theme={activeTheme}
        />
      )}
    </div>
  );
}

function RemoteFileEditorModal({
  sessionId,
  file,
  onClose,
  toast,
  onSaved,
  theme,
}: {
  sessionId: string;
  file: { path: string; name: string; size: number };
  onClose: () => void;
  toast: (m: string) => void;
  onSaved?: () => void;
  theme?: DrexiusTheme;
}) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0d121c';

  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    bridge.sftpReadText(sessionId, file.path)
      .then((txt) => {
        if (!active) return;
        setContent(txt);
        setOriginalContent(txt);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(isBridgeError(err) ? err.message : String(err));
        setLoading(false);
      });
    return () => { active = false; };
  }, [sessionId, file.path]);

  const isDirty = content !== originalContent;

  const save = async () => {
    if (saving || loading) return;
    setSaving(true);
    try {
      await bridge.sftpWriteText(sessionId, file.path, content);
      setOriginalContent(content);
      toast(`Saved ${file.name} to remote server`);
      onSaved?.();
    } catch (err) {
      toast(isBridgeError(err) ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const next = val.substring(0, start) + '  ' + val.substring(end);
      setContent(next);
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      }, 0);
    }
  };

  const tryClose = async () => {
    if (isDirty) {
      if (await confirmDialog({ title: `Discard changes to ${file.name}?`, message: 'You have unsaved changes.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true })) {
        onClose();
      }
    } else {
      onClose();
    }
  };

  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) count++;
    }
    return count;
  }, [content]);

  const lineGutterText = useMemo(() => {
    const cap = Math.min(lineCount, 5000);
    let s = '';
    for (let i = 1; i <= cap; i++) {
      s += i + '\n';
    }
    return s;
  }, [lineCount]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={tryClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl ring-1 ring-white/10"
        style={{ backgroundColor: bgColor }}
      >
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-20"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Header */}
        <div className="relative flex h-14 shrink-0 items-center justify-between border-b border-white/5 px-4 bg-black/30">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="grid h-8 w-8 place-items-center rounded-xl border transition shadow-lg shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 15px ${accentColor}25`,
              }}
            >
              <FileCode className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-100 truncate">{file.name}</span>
                {isDirty ? (
                  <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-[9.5px] font-medium text-amber-300">
                    Unsaved
                  </span>
                ) : (
                  <span className="rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.2 text-[9.5px] font-medium text-emerald-400">
                    Clean
                  </span>
                )}
              </div>
              <p className="truncate font-mono text-[10px] text-slate-500">{file.path}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || loading || !isDirty}
              className={cn(
                'flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition shadow-lg',
                isDirty
                  ? 'hover:brightness-110 active:scale-95'
                  : 'bg-white/5 text-slate-500 border border-white/5 disabled:opacity-40'
              )}
              style={isDirty ? {
                backgroundColor: accentColor,
                color: '#000000',
                boxShadow: `0 0 20px ${accentColor}35`,
              } : undefined}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              <span>{saving ? 'Saving…' : 'Save (⌘S)'}</span>
            </button>
            <button
              onClick={tryClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Editor Body */}
        <div className="relative min-h-0 flex-1 flex bg-[#080b11]">
          {loading ? (
            <div className="grid h-full w-full place-items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
              <span>Loading remote file…</span>
            </div>
          ) : error ? (
            <div className="grid h-full w-full place-items-center p-6 text-center text-xs text-rose-300">
              <div className="max-w-md space-y-2">
                <AlertCircle className="mx-auto h-8 w-8 text-rose-400 opacity-80" />
                <p className="font-semibold">Unable to open file in editor</p>
                <p className="text-slate-400 text-[11px]">{error}</p>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full min-h-0 min-w-0">
              {/* Line numbers gutter */}
              <pre className="w-12 shrink-0 select-none overflow-hidden bg-black/40 py-3 text-right font-mono text-[11px] leading-5 text-slate-600 pr-3 border-r border-white/5 m-0 font-normal">
                {lineGutterText}
              </pre>
              {/* Textarea code editor */}
              <textarea
                ref={textareaRef}
                autoFocus
                spellCheck={false}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-full w-full resize-none border-0 bg-transparent py-3 px-3 font-mono text-[11px] leading-5 text-slate-200 placeholder:text-slate-700 focus:outline-none [tab-size:2]"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex h-7 shrink-0 items-center justify-between border-t border-white/5 bg-black/30 px-3 text-[10.5px] text-slate-500">
          <div className="flex items-center gap-3">
            <span>{lineCount} lines</span>
            <span>{content.length} characters</span>
            <span className="font-mono">UTF-8</span>
          </div>
          <div className="flex items-center gap-2">
            <span>⌘S / Ctrl+S to save</span>
            <span>·</span>
            <span>Esc to close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
