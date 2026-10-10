import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import {
  ShieldAlert,
  RotateCw,
  X,
  WifiOff,
  Loader2,
  Unplug,
  FolderOpen,
  History,
  Search,
  ChevronUp,
  ChevronDown,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { bridge, isBridgeError, isTauri } from '../lib/bridge';
import { parseOsFromBanner } from '../lib/os';
import { registry } from '../lib/sessions';
import type { NexusTheme } from '../lib/themes';
import type { Host, Pane, PaneStatus } from '../lib/types';
import { cn } from '../utils/cn';

interface Props {
  pane: Pane;
  host: Host;
  theme: NexusTheme;
  fontSize: number;
  active: boolean;
  showHeader: boolean;
  onFocus: () => void;
  onClose: () => void;
  onChange: () => void;
  onData?: (data: string) => void;
}

export function TerminalPane({
  pane,
  host,
  theme,
  fontSize,
  active,
  showHeader,
  onFocus,
  onClose,
  onChange,
  onData,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(null);
  const lineRef = useRef('');
  const retryRef = useRef(0);
  const genRef = useRef(0);

  const [status, setStatus] = useState<PaneStatus>('connecting');
  const [cwd, setCwd] = useState('~');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [matchRegex, setMatchRegex] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);

  const isLocal = pane.isLocal || host.id === '__local__' || host.id.startsWith('local');

  const update = useCallback(
    (patch: Parameters<typeof registry.patch>[1]) => {
      registry.patch(pane.id, patch);
      onChange();
    },
    [pane.id, onChange]
  );

  const performSearch = useCallback(
    (query: string, reverse = false) => {
      if (!searchRef.current || !query) return;
      const opts = {
        regex: matchRegex,
        wholeWord: matchWholeWord,
        caseSensitive: matchCase,
        incremental: true,
      };
      if (reverse) {
        searchRef.current.findPrevious(query, opts);
      } else {
        searchRef.current.findNext(query, opts);
      }
    },
    [matchRegex, matchWholeWord, matchCase]
  );

  const connect = useCallback(
    async (resume: boolean) => {
      const term = termRef.current;
      if (!term) return;
      const gen = genRef.current;
      const dead = () => genRef.current !== gen;
      setStatus('connecting');
      setError(null);
      setCountdown(null);
      update({ status: 'connecting' });

      // Local PTY shell connection
      if (isLocal) {
        term.write(`\r\n\x1b[90m→ Spawning local PTY shell…\x1b[0m\r\n`);
        try {
          const sid = await bridge.spawnLocalPty(term.cols, term.rows, undefined, undefined, (ev) => {
            if (dead()) return;
            switch (ev.type) {
              case 'output':
                term.write(ev.data);
                break;
              case 'cwd':
                setCwd(ev.path);
                update({ cwd: ev.path });
                break;
              case 'connected':
                term.write(`\x1b[32m✔ Local shell session started\x1b[0m\r\n`);
                break;
              case 'disconnected':
                sessionRef.current = null;
                term.write(`\r\n\x1b[90m[Process completed: ${ev.reason}]\x1b[0m\r\n`);
                setStatus('disconnected');
                update({ status: 'disconnected', sessionId: null });
                break;
            }
          });
          if (dead()) {
            bridge.closeLocalPty(sid);
            return;
          }
          sessionRef.current = sid;
          retryRef.current = 0;
          setStatus('connected');
          update({ status: 'connected', sessionId: sid });
        } catch (e) {
          if (dead()) return;
          const msg = isBridgeError(e) ? e.message : String(e);
          setError(msg);
          setStatus('error');
          update({ status: 'error' });
          term.write(`\x1b[31m✖ Local PTY error: ${msg}\x1b[0m\r\n`);
        }
        return;
      }

      // Remote SSH connection
      term.write(
        `\r\n\x1b[90m${resume ? '⟲ Resuming' : '→ Connecting to'} \x1b[36m${host.username}@${host.hostname}:${
          host.port
        }\x1b[90m via ${host.keychainId ? 'keychain identity' : host.authMethod === 'key' ? 'public key' : host.authMethod}…\x1b[0m\r\n`
      );
      try {
        const sid = await bridge.connect(host.id, term.cols, term.rows, resume, (ev) => {
          if (dead()) return;
          switch (ev.type) {
            case 'output':
              term.write(ev.data);
              break;
            case 'cwd':
              setCwd(ev.path);
              update({ cwd: ev.path });
              if (sessionRef.current) bridge.recordSnapshot(host.id, sessionRef.current, { cwd: ev.path });
              break;
            case 'connected': {
              term.write(
                `\x1b[32m✔ Authenticated\x1b[90m · host key SHA256:${ev.fingerprint.slice(0, 22)}… · AES-256-GCM / chacha20-poly1305\x1b[0m\r\n`
              );
              const detected = ev.os ?? parseOsFromBanner(ev.banner);
              if (detected && detected !== host.os) {
                bridge.saveHost({ ...host, os: detected }).then(() => onChange()).catch(() => {});
              }
              break;
            }
            case 'disconnected':
              sessionRef.current = null;
              term.write(`\r\n\x1b[31m✖ ${ev.reason}\x1b[0m\r\n`);
              setStatus('disconnected');
              update({ status: 'disconnected', sessionId: null });
              if (ev.resumable) {
                retryRef.current += 1;
                setCountdown(Math.min(30, 3 * 2 ** (retryRef.current - 1)));
              }
              break;
          }
        });
        if (dead()) {
          bridge.disconnect(sid);
          return;
        }
        sessionRef.current = sid;
        retryRef.current = 0;
        setStatus('connected');
        update({ status: 'connected', sessionId: sid });
      } catch (e) {
        if (dead()) return;
        if (isBridgeError(e) && e.kind === 'unknownHostKey') {
          setFingerprint(e.fingerprint ?? '');
          setStatus('hostkey');
          update({ status: 'hostkey' });
          term.write(`\x1b[33m⚠ Unknown host key — awaiting your verification.\x1b[0m\r\n`);
        } else {
          const msg = isBridgeError(e) ? e.message : String(e);
          setError(msg);
          setStatus('error');
          update({ status: 'error' });
          term.write(`\x1b[31m✖ ${msg}\x1b[0m\r\n`);
        }
      }
    },
    [host, isLocal, update, onChange]
  );

  // Mount xterm once
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      theme: theme.xterm,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(elRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });

    // OSC 7 — working directory reporting
    term.parser.registerOscHandler(7, (data) => {
      const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
      if (m) {
        const p = decodeURI(m[1]);
        setCwd(p);
        update({ cwd: p });
      }
      return true;
    });

    term.onData((data) => {
      const sid = sessionRef.current;
      if (!sid) return;
      if (isLocal) {
        bridge.writeLocalPty(sid, data);
      } else {
        bridge.write(sid, data);
        // Track submitted lines for snapshot "last command"
        for (const ch of data) {
          if (ch === '\r') {
            const cmd = lineRef.current.trim();
            if (cmd) {
              update({ lastCommand: cmd });
              bridge.recordSnapshot(host.id, sid, { lastCommand: cmd });
            }
            lineRef.current = '';
          } else if (ch === '\x7f') lineRef.current = lineRef.current.slice(0, -1);
          else if (ch === '\x03') lineRef.current = '';
          else if (ch >= ' ' && !data.startsWith('\x1b')) lineRef.current += ch;
        }
      }
      onData?.(data);
    });

    // Copy on selection (Termius convenience)
    term.onSelectionChange(() => {
      if (term.hasSelection()) {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          navigator.clipboard.writeText(sel).catch(() => {});
        }
      }
    });

    registry.set({
      paneId: pane.id,
      hostId: host.id,
      sessionId: null,
      status: 'connecting',
      cwd: '~',
      lastCommand: null,
      term,
      send: (d) => {
        if (sessionRef.current) {
          if (isLocal) bridge.writeLocalPty(sessionRef.current, d);
          else bridge.write(sessionRef.current, d);
          term.focus();
        }
      },
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (sessionRef.current) {
          if (isLocal) bridge.resizeLocalPty(sessionRef.current, term.cols, term.rows);
          else bridge.resize(sessionRef.current, term.cols, term.rows);
        }
      } catch {
        /* not visible */
      }
    });
    ro.observe(elRef.current!);

    connect(!!pane.resume);

    return () => {
      genRef.current += 1;
      ro.disconnect();
      if (sessionRef.current) {
        if (isLocal) bridge.closeLocalPty(sessionRef.current);
        else bridge.disconnect(sessionRef.current);
      }
      sessionRef.current = null;
      registry.delete(pane.id);
      term.dispose();
      onChange();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme.xterm;
    }
  }, [theme]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* */
    }
  }, [fontSize]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  // Handle Ctrl+F / Cmd+F for search inside active terminal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch((v) => {
          if (!v) setTimeout(() => searchInputRef.current?.select(), 50);
          return true;
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  // Auto-reconnect countdown with exponential backoff
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      connect(true);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, connect]);

  const statusColor = {
    connecting: 'bg-amber-400',
    connected: 'bg-emerald-400',
    disconnected: 'bg-rose-500',
    hostkey: 'bg-amber-400',
    error: 'bg-rose-500',
  }[status];

  return (
    <div
      onMouseDown={onFocus}
      onMouseMove={(e) => {
        const near = e.clientX > e.currentTarget.getBoundingClientRect().right - 30;
        e.currentTarget.classList.toggle('nx-scroll-near', near);
      }}
      onMouseLeave={(e) => e.currentTarget.classList.remove('nx-scroll-near')}
      onContextMenu={async (e) => {
        if (termRef.current?.hasSelection()) return;
        e.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            const sid = sessionRef.current;
            if (sid) {
              if (isLocal) bridge.writeLocalPty(sid, text);
              else bridge.write(sid, text);
              onData?.(text);
            }
          }
        } catch {
          // clipboard permission not granted
        }
      }}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden transition-colors',
        showHeader
          ? cn(
              'rounded-xl border',
              active
                ? 'border-white/15 shadow-[0_0_0_1px_rgba(34,211,238,0.15),0_10px_40px_-10px_rgba(34,211,238,0.25)]'
                : 'border-white/5'
            )
          : 'rounded-none border-0'
      )}
      style={{ background: theme.xterm.background }}
    >
      {showHeader && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/5 bg-black/20 px-3 text-[11px]">
          <span className={cn('h-1.5 w-1.5 rounded-full', statusColor, status === 'connecting' && 'animate-pulse')} />
          {isLocal ? (
            <span className="flex items-center gap-1 font-medium text-cyan-300">
              <TerminalIcon className="h-3.5 w-3.5" />
              <span>Local Terminal</span>
            </span>
          ) : (
            <span className="font-medium text-slate-200" style={{ color: host.color ?? undefined }}>
              {host.label}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1 truncate font-mono text-slate-500">
            <FolderOpen className="h-3 w-3 shrink-0" />
            {cwd}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              title="Search buffer (⌘F / Ctrl+F)"
              onClick={() => {
                setShowSearch((v) => !v);
                if (!showSearch) setTimeout(() => searchInputRef.current?.select(), 50);
              }}
              className={cn(
                'rounded p-1 transition',
                showSearch ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:bg-white/5 hover:text-white'
              )}
            >
              <Search className="h-3 w-3" />
            </button>
            {!isTauri && status === 'connected' && !isLocal && (
              <button
                title="Simulate network drop (tests snapshot resume)"
                onClick={() => sessionRef.current && bridge.simulateDrop(sessionRef.current)}
                className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-amber-300"
              >
                <Unplug className="h-3 w-3" />
              </button>
            )}
            <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-rose-300">
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {/* Floating In-Terminal Search Widget */}
      {showSearch && (
        <div
          className={cn(
            'absolute right-3 z-30 flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#0e131d]/95 p-1.5 shadow-2xl backdrop-blur',
            showHeader ? 'top-10' : 'top-2'
          )}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              performSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                performSearch(searchQuery, e.shiftKey);
              } else if (e.key === 'Escape') {
                setShowSearch(false);
                termRef.current?.focus();
              }
            }}
            placeholder="Find in terminal…"
            className="w-44 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
          />
          <button
            onClick={() => performSearch(searchQuery, true)}
            title="Previous match (Shift+Enter)"
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => performSearch(searchQuery, false)}
            title="Next match (Enter)"
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <div className="h-3.5 w-[1px] bg-white/10" />
          <button
            onClick={() => setMatchCase(!matchCase)}
            title="Match Case"
            className={cn(
              'rounded px-1 py-0.5 text-[10px] font-mono font-bold transition',
              matchCase ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            Aa
          </button>
          <button
            onClick={() => setMatchWholeWord(!matchWholeWord)}
            title="Match Whole Word"
            className={cn(
              'rounded px-1 py-0.5 text-[10px] font-mono font-bold transition',
              matchWholeWord ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            \b
          </button>
          <button
            onClick={() => setMatchRegex(!matchRegex)}
            title="Use Regular Expression"
            className={cn(
              'rounded px-1 py-0.5 text-[10px] font-mono font-bold transition',
              matchRegex ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            .*
          </button>
          <button
            onClick={() => {
              setShowSearch(false);
              termRef.current?.focus();
            }}
            className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className={cn('relative min-h-0 flex-1', showHeader ? 'px-2 pt-2' : 'px-3 py-1.5')}>
        <div ref={elRef} className="h-full w-full" />
      </div>

      {status === 'connecting' && (
        <div
          className={cn(
            'pointer-events-none absolute right-3 flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-1 text-[11px] text-slate-300 backdrop-blur',
            showHeader ? 'top-10' : 'top-3'
          )}
        >
          <Loader2 className="h-3 w-3 animate-spin text-cyan-300" />
          {isLocal ? 'Initializing shell…' : 'Handshaking…'}
        </div>
      )}

      {status === 'hostkey' && (
        <Overlay>
          <ShieldAlert className="h-8 w-8 text-amber-300" />
          <h3 className="mt-3 text-sm font-semibold text-white">Verify host identity</h3>
          <p className="mt-1 max-w-sm text-center text-xs text-slate-400">
            First connection to <span className="text-slate-200">{host.hostname}:{host.port}</span>. Compare this
            fingerprint with the server's before trusting it.
          </p>
          <code className="mt-3 block max-w-sm break-all rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-center font-mono text-[11px] text-amber-200">
            SHA256:{fingerprint}
          </code>
          <div className="mt-4 flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5">
              Cancel
            </button>
            <button
              onClick={async () => {
                await bridge.trustHostKey(host, fingerprint ?? '');
                connect(false);
              }}
              className="rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-300"
            >
              Trust & connect
            </button>
          </div>
        </Overlay>
      )}

      {status === 'error' && (
        <Overlay>
          <WifiOff className="h-8 w-8 text-rose-400" />
          <h3 className="mt-3 text-sm font-semibold text-white">Connection failed</h3>
          <p className="mt-1 max-w-sm text-center font-mono text-xs text-rose-300/80">{error}</p>
          <button
            onClick={() => connect(false)}
            className="mt-4 flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15"
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </button>
        </Overlay>
      )}

      {status === 'disconnected' && !isLocal && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-xl border border-rose-400/20 bg-[#1a0d14]/90 px-4 py-3 shadow-2xl backdrop-blur">
          <History className="h-5 w-5 shrink-0 text-fuchsia-300" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-white">Link dropped — session snapshot saved</div>
            <div className="truncate font-mono text-[11px] text-slate-400">
              cwd {cwd}
              {registry.get(pane.id)?.lastCommand ? ` · last: ${registry.get(pane.id)?.lastCommand}` : ''}
            </div>
          </div>
          {countdown !== null && <span className="text-[11px] text-slate-400">auto-resume in {countdown}s</span>}
          <button
            onClick={() => connect(true)}
            className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-400 to-fuchsia-400 px-3 py-1.5 text-xs font-semibold text-black"
          >
            <RotateCw className="h-3 w-3" />
            Resume
          </button>
          {countdown !== null && (
            <button onClick={() => setCountdown(null)} className="text-[11px] text-slate-500 hover:text-slate-300">
              cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      {children}
    </div>
  );
}
