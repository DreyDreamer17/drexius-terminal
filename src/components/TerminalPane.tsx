import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
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
  Clipboard,
} from 'lucide-react';
import { bridge, isBridgeError, isTauri } from '../lib/bridge';
import { parseOsFromBanner } from '../lib/os';
import { registry } from '../lib/sessions';
import { ClipboardModal } from './ClipboardModal';
import { CommandSearchModal } from './CommandSearchModal';
import type { NexusTheme } from '../lib/themes';
import type { Host, Pane, PaneStatus } from '../lib/types';
import { cn } from '../utils/cn';

const COMMON_SHELL_COMMANDS = [
  'pm2 status',
  'pm2 logs',
  'pm2 restart all',
  'pm2 stop all',
  'pm2 list',
  'pm2 monit',
  'speedtest',
  'git status',
  'git pull',
  'git push',
  'git log --oneline -n 10',
  'git diff',
  'git checkout -b ',
  'git checkout ',
  'git branch -a',
  'git commit -m "',
  'docker ps -a',
  'docker compose up -d',
  'docker compose down',
  'docker compose logs -f --tail=100',
  'docker exec -it ',
  'docker images',
  'systemctl status ',
  'systemctl restart ',
  'journalctl -u ',
  'journalctl -xe',
  'kubectl get pods -A',
  'kubectl logs -f ',
  'kubectl describe pod ',
  'npm run dev',
  'npm run build',
  'npm test',
  'cargo check',
  'cargo build --release',
  'cargo test',
  'cargo run',
  'htop',
  'df -h',
  'free -h',
  'netstat -tulpn',
  'ss -tulpn',
  'tar -czvf ',
  'tar -xzvf ',
  'chmod +x ',
  'find . -name "',
  'grep -rnw . -e "',
  'curl -fsSL ',
];

interface Props {
  pane: Pane;
  host: Host;
  theme: NexusTheme;
  fontSize: number;
  lineHeight?: number;
  active: boolean;
  showHeader: boolean;
  onFocus: () => void;
  onClose: () => void;
  onChange: () => void;
  onData?: (data: string) => void;
  toast?: (msg: string) => void;
}

export function TerminalPane({
  pane,
  host,
  theme,
  fontSize,
  lineHeight = 1.0,
  active,
  showHeader,
  onFocus,
  onClose,
  onChange,
  onData,
  toast = () => {},
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number; cellHeight: number } | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(null);
  const lineRef = useRef('');
  const retryRef = useRef(0);
  const genRef = useRef(0);

  // Command & Clipboard history + Autosuggestion states
  const historyCacheRef = useRef<string[]>([]);
  const [showCmdSearch, setShowCmdSearch] = useState(false);
  const [showClipboard, setShowClipboard] = useState(false);
  const [suggestion, setSuggestion] = useState<{ full: string; suffix: string } | null>(null);
  const suggestionRef = useRef<{ full: string; suffix: string } | null>(null);
  suggestionRef.current = suggestion;

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

  const isSerial = pane.kind === 'serial';
  const isLocal = (!isSerial) && (pane.isLocal || host.id === '__local__' || host.id.startsWith('local'));

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

  const getCurrentCommandLine = useCallback((): string => {
    const term = termRef.current;
    if (!term) return lineRef.current;

    try {
      const buffer = term.buffer.active;
      if (buffer.type === 'alternate') return '';

      const lineIndex = buffer.cursorY + buffer.baseY;
      const lineObj = buffer.getLine(lineIndex);
      if (!lineObj) return lineRef.current;

      const upToCursor = lineObj.translateToString(false, 0, buffer.cursorX);

      // 1. user@host:path[$#%>] (standard Linux, macOS, bash, zsh)
      const userHost = upToCursor.match(/^(?:(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+[^\$#%>]*[\$#%>]\s*)(.*)$/);
      if (userHost && userHost[1] !== undefined) {
        return userHost[1];
      }

      // 2. Bracketed prompt: [user@host path]$ or (venv) [user@host path]#
      const bracketed = upToCursor.match(/^(?:(?:\([^)]+\)\s*)?\[[^\]]+\][\$#%>]\s*)(.*)$/);
      if (bracketed && bracketed[1] !== undefined) {
        return bracketed[1];
      }

      // 3. Modern prompt glyphs: ❯, ➜, λ, » (Starship, Pure, Oh-My-Zsh)
      const glyph = upToCursor.match(/^.*?[❯➜λ»]\s*(.*)$/);
      if (glyph && glyph[1] !== undefined) {
        return glyph[1];
      }

      // 4. Simple prompt: "$ ", "# ", "> ", "% " at prompt start
      const simple = upToCursor.match(/^(?:(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-~/: ]*?[\$#%>]\s+)(.*)$/);
      if (simple && simple[1] !== undefined) {
        return simple[1];
      }
    } catch {
      /* fallback */
    }

    return lineRef.current;
  }, []);

  // Set when the line was changed by something we can't see in keystrokes
  // (Tab completion, history navigation, paste, cursor movement...).
  const dirtyRef = useRef(false);
  const resyncTimerRef = useRef<number | null>(null);

  const updateSuggestion = useCallback((overrideText?: string) => {
    // The keystroke-tracked line is the source of truth. The screen buffer lags
    // behind keystrokes (server echo), so it must never overwrite it while typing.
    const prefix = (overrideText !== undefined ? overrideText : lineRef.current) || '';

    if (prefix.trim().length < 2) {
      setSuggestion(null);
      setGhostPos(null);
      return;
    }
    const prefixLower = prefix.toLowerCase();

    // 1. Gather all candidate commands from history and common shell commands
    const historyMatches = historyCacheRef.current.filter(
      (cmd) => cmd.toLowerCase().startsWith(prefixLower) && cmd.length > prefix.length
    );
    const commonMatches = COMMON_SHELL_COMMANDS.filter(
      (cmd) => cmd.toLowerCase().startsWith(prefixLower) && cmd.length > prefix.length
    );

    const candidates = [...historyMatches, ...commonMatches];
    if (candidates.length === 0) {
      setSuggestion(null);
      setGhostPos(null);
      return;
    }

    // 2. Most recent history match wins, then built-in common commands.
    const bestMatch = candidates[0];

    setSuggestion({
      full: bestMatch,
      suffix: bestMatch.slice(prefix.length),
    });
  }, []);

  // After Tab / history navigation / paste / cursor movement, the real line only
  // exists on screen. Wait for the server echo to land, then re-read it once.
  const scheduleResync = useCallback(() => {
    dirtyRef.current = true;
    setSuggestion(null);
    setGhostPos(null);
    if (resyncTimerRef.current !== null) window.clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = window.setTimeout(() => {
      resyncTimerRef.current = null;
      lineRef.current = getCurrentCommandLine();
      dirtyRef.current = false;
      updateSuggestion(lineRef.current);
    }, 120);
  }, [getCurrentCommandLine, updateSuggestion]);

  const acceptSuggestion = useCallback(() => {
    const s = suggestionRef.current;
    const sid = sessionRef.current;
    if (!s || !s.suffix || !sid) return;

    if (isSerial) {
      bridge.writeSerial(sid, s.suffix);
    } else if (isLocal) {
      bridge.writeLocalPty(sid, s.suffix);
    } else {
      bridge.write(sid, s.suffix);
    }
    lineRef.current += s.suffix;
    setSuggestion(null);
    setGhostPos(null);
    termRef.current?.focus();
  }, [isSerial, isLocal]);

  const updateGhostPos = useCallback(() => {
    const term = termRef.current;
    const container = containerRef.current;
    const el = elRef.current;
    if (!term || !container || !el) {
      setGhostPos(null);
      return;
    }

    // Don't show in alternate screen buffer (e.g. vim, htop, nano)
    if (term.buffer.active.type === 'alternate') {
      setGhostPos(null);
      return;
    }

    // Don't show if user scrolled up into history
    if (term.buffer.active.viewportY !== term.buffer.active.baseY) {
      setGhostPos(null);
      return;
    }

    const screen = el.querySelector('.xterm-screen') as HTMLElement | null;
    const core = (term as any)._core;
    const dims = core?._renderService?.dimensions;

    const cellWidth =
      dims?.css?.cell?.width ||
      dims?.actualCellWidth ||
      (screen && term.cols ? screen.clientWidth / term.cols : 9);
    const cellHeight =
      dims?.css?.cell?.height ||
      dims?.actualCellHeight ||
      (screen && term.rows ? screen.clientHeight / term.rows : 17);

    const containerRect = container.getBoundingClientRect();
    const screenRect = screen ? screen.getBoundingClientRect() : containerRect;

    const cursorX = term.buffer.active.cursorX;
    const cursorY = term.buffer.active.cursorY;

    if (cursorY < 0 || cursorY >= term.rows || cursorX >= term.cols) {
      setGhostPos(null);
      return;
    }

    const x = Math.round(screenRect.left - containerRect.left + cursorX * cellWidth);
    const y = Math.round(screenRect.top - containerRect.top + cursorY * cellHeight);

    setGhostPos({
      x,
      y,
      cellHeight,
    });
  }, []);

  useEffect(() => {
    if (suggestion) {
      updateGhostPos();
      const raf = requestAnimationFrame(updateGhostPos);
      return () => cancelAnimationFrame(raf);
    } else {
      setGhostPos(null);
    }
  }, [suggestion, updateGhostPos]);


  const handlePasteClipboard = useCallback(
    (text: string) => {
      const sid = sessionRef.current;
      if (sid && text) {
        if (isSerial) bridge.writeSerial(sid, text);
        else if (isLocal) bridge.writeLocalPty(sid, text);
        else bridge.write(sid, text);
        termRef.current?.focus();
        scheduleResync();
      }
    },
    [isSerial, isLocal, scheduleResync]
  );

  const handleSelectCommand = useCallback(
    (cmd: string, executeImmediately = false) => {
      const sid = sessionRef.current;
      if (sid && cmd) {
        const payload = executeImmediately ? cmd + '\n' : cmd;
        if (isSerial) bridge.writeSerial(sid, payload);
        else if (isLocal) bridge.writeLocalPty(sid, payload);
        else bridge.write(sid, payload);
        termRef.current?.focus();
        if (executeImmediately) {
          lineRef.current = '';
          setSuggestion(null);
          setGhostPos(null);
        } else {
          scheduleResync();
        }
      }
    },
    [isSerial, isLocal, scheduleResync]
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

      // Native Serial Port connection
      if (isSerial) {
        const opts = pane.serialOptions!;
        const summary = `${opts.dataBits}/${(opts.parity ?? 'N')[0].toUpperCase()}/${opts.stopBits}`;
        term.write(`
[90m→ Opening ${opts.portName} @ ${opts.baudRate} baud ${summary} (${opts.flowControl})…[0m
`);
        try {
          const sid = await bridge.openSerial(opts, (ev) => {
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
                term.write(`[32m✔ Serial port ${opts.portName} open[0m
`);
                break;
              case 'disconnected':
                sessionRef.current = null;
                term.write(`
[90m[Serial port closed: ${ev.reason}][0m
`);
                setStatus('disconnected');
                update({ status: 'disconnected', sessionId: null });
                break;
            }
          });
          if (dead()) {
            bridge.closeSerial(sid);
            return;
          }
          sessionRef.current = sid;
          retryRef.current = 0;
          setStatus('connected');
          update({ status: 'connected', sessionId: sid });
          // Serial ports have no terminal resize — skip resize()
        } catch (e) {
          if (dead()) return;
          const msg = isBridgeError(e) ? e.message : String(e);
          setError(msg);
          setStatus('error');
          update({ status: 'error' });
          term.write(`[31m✖ Serial error: ${msg}[0m
`);
        }
        return;
      }

      // Local PTY shell connection
      if (isLocal) {
        term.write(`\r\n\x1b[90m→ Spawning ${pane.customShell ? 'custom session' : 'local PTY shell'}…\x1b[0m\r\n`);
        try {
          const sid = await bridge.spawnLocalPty(term.cols, term.rows, pane.customShell, undefined, (ev) => {
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
          if (term.cols && term.rows) {
            bridge.resizeLocalPty(sid, term.cols, term.rows);
          }
          if (host.startupCommand && host.startupCommand.trim()) {
            const startup = host.startupCommand.trim() + '\n';
            setTimeout(() => {
              if (sessionRef.current === sid) {
                bridge.writeLocalPty(sid, startup);
              }
            }, 350);
          }
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
        if (term.cols && term.rows) {
          bridge.resize(sid, term.cols, term.rows);
        }
        if (host.startupCommand && host.startupCommand.trim()) {
          const startup = host.startupCommand.trim() + '\n';
          setTimeout(() => {
            if (sessionRef.current === sid) {
              bridge.write(sid, startup);
            }
          }, 450);
        }
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
      fontFamily:
        '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
      fontSize,
      lineHeight,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      theme: theme.xterm,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());

    // Enable Unicode 11 character widths for modern emojis and TUI glyphs
    try {
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = '11';
    } catch (e) {
      console.warn('Unicode11 addon failed to load:', e);
    }

    term.open(elRef.current!);

    // Load hardware-accelerated WebGL or 2D Canvas renderer for seamless, gapless box/block drawing
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        try {
          const canvas = new CanvasAddon();
          term.loadAddon(canvas);
        } catch {}
      });
      term.loadAddon(webgl);
    } catch {
      try {
        const canvas = new CanvasAddon();
        term.loadAddon(canvas);
      } catch (err) {
        console.warn('WebGL/Canvas renderers unavailable, using DOM renderer:', err);
      }
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Synchronous immediate fit so cols/rows are initialized before connect()
    try {
      fit.fit();
    } catch {
      /* hidden */
    }

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
    }

    // Keep PTY dimensions in sync on any terminal resize event
    term.onResize(({ cols, rows }) => {
      const sid = sessionRef.current;
      if (sid && !isSerial) {
        if (isLocal) bridge.resizeLocalPty(sid, cols, rows);
        else bridge.resize(sid, cols, rows);
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

    // Preload recent command history for instant autosuggestions
    bridge.listCommandHistory(200).then((items) => {
      const raw = items.map((i) => i.command.trim()).filter(Boolean);
      // Deduplicate and filter out incomplete mid-word truncated prefixes
      const cleaned: string[] = [];
      for (const cmd of raw) {
        const hasFuller =
          raw.some((other) => other.length > cmd.length && other.startsWith(cmd) && !other.slice(cmd.length).startsWith(' ')) ||
          COMMON_SHELL_COMMANDS.some((other) => other.length > cmd.length && other.startsWith(cmd) && !other.slice(cmd.length).startsWith(' '));
        if (!hasFuller && !cleaned.includes(cmd)) {
          cleaned.push(cmd);
        }
      }
      historyCacheRef.current = cleaned;
    }).catch(() => {});

    // Track cursor and viewport changes to update ghost text alignment
    const dCursor = term.onCursorMove(updateGhostPos);
    const dRender = term.onRender(updateGhostPos);
    const dScroll = term.onScroll(updateGhostPos);

    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+R -> Command History Reverse Search
      if (e.ctrlKey && e.key.toLowerCase() === 'r' && e.type === 'keydown') {
        setShowCmdSearch(true);
        return false;
      }

      // Ctrl+Shift+V or Cmd+Shift+V -> Clipboard History
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v' && e.type === 'keydown') {
        setShowClipboard(true);
        return false;
      }


      // ArrowRight or Tab -> Accept autosuggestion
      if (suggestionRef.current && (e.key === 'ArrowRight' || e.key === 'Tab') && e.type === 'keydown') {
        acceptSuggestion();
        return false;
      }

      // Escape -> Dismiss suggestion
      if (e.key === 'Escape' && suggestionRef.current && e.type === 'keydown') {
        setSuggestion(null);
        setGhostPos(null);
        return false;
      }

      // Arrow navigation -> Dismiss suggestion so shell history navigation is clean
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft') && suggestionRef.current && e.type === 'keydown') {
        setSuggestion(null);
        setGhostPos(null);
        return true;
      }

      return true;
    });

    term.onData((data) => {
      const sid = sessionRef.current;
      if (!sid) return;
      if (isSerial) {
        bridge.writeSerial(sid, data);
      } else if (isLocal) {
        bridge.writeLocalPty(sid, data);
      } else {
        bridge.write(sid, data);
      }

      // Escape sequences (arrows, Home/End, Delete, bracketed paste...) change the
      // line in ways we can't track from keystrokes -> re-read it from the screen.
      if (data.startsWith('\x1b')) {
        scheduleResync();
        onData?.(data);
        return;
      }

      // Track submitted lines for snapshot, command history, and autosuggestion
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          // Keystrokes are the truth. Only fall back to the screen if the line was
          // modified by Tab / history navigation and hasn't been re-synced yet.
          const cmd = (dirtyRef.current ? getCurrentCommandLine() || lineRef.current : lineRef.current).trim();
          if (resyncTimerRef.current !== null) {
            window.clearTimeout(resyncTimerRef.current);
            resyncTimerRef.current = null;
          }
          dirtyRef.current = false;
          if (cmd) {
            update({ lastCommand: cmd });
            if (!isLocal) {
              bridge.recordSnapshot(host.id, sid, { lastCommand: cmd });
            }
            bridge.addCommandHistory({
              hostId: isLocal ? null : host.id,
              hostLabel: isLocal ? 'Local Terminal' : host.label,
              command: cmd,
              cwd: cwd || '~',
            }).catch(() => {});

            const idx = historyCacheRef.current.indexOf(cmd);
            if (idx !== -1) historyCacheRef.current.splice(idx, 1);
            historyCacheRef.current.unshift(cmd);
          }
          lineRef.current = '';
          setSuggestion(null);
          setGhostPos(null);
        } else if (ch === '\t') {
          scheduleResync();
        } else if (ch === '\x7f' || ch === '\x08') {
          lineRef.current = lineRef.current.slice(0, -1);
          updateSuggestion(lineRef.current);
        } else if (ch === '\x03' || ch === '\x15' || ch === '\x0c') {
          lineRef.current = '';
          dirtyRef.current = false;
          setSuggestion(null);
          setGhostPos(null);
        } else if (ch === '\x17') {
          const parts = lineRef.current.trimEnd().split(/\s+/);
          parts.pop();
          lineRef.current = parts.join(' ');
          updateSuggestion(lineRef.current);
        } else if (ch >= ' ') {
          lineRef.current += ch;
          updateSuggestion(lineRef.current);
        }
      }
      onData?.(data);
    });

    // Copy on selection (Termius convenience & Clipboard history)
    term.onSelectionChange(() => {
      if (term.hasSelection()) {
        const sel = term.getSelection();
        if (sel && sel.trim().length > 0) {
          navigator.clipboard.writeText(sel).catch(() => {});
          bridge.addClipboardHistory(sel, `Terminal (${isLocal ? 'Local' : host.label})`).catch(() => {});
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
          if (isSerial) bridge.writeSerial(sessionRef.current, d);
          else if (isLocal) bridge.writeLocalPty(sessionRef.current, d);
          else bridge.write(sessionRef.current, d);
          term.focus();
        }
      },
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        updateGhostPos();
        if (sessionRef.current && !isSerial) {
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
      dCursor.dispose();
      dRender.dispose();
      dScroll.dispose();
      if (sessionRef.current) {
        if (isSerial) bridge.closeSerial(sessionRef.current);
        else if (isLocal) bridge.closeLocalPty(sessionRef.current);
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
    if (!termRef.current) return;
    termRef.current.options.lineHeight = lineHeight;
    try {
      fitRef.current?.fit();
    } catch {
      /* */
    }
  }, [lineHeight]);

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
              if (isSerial) bridge.writeSerial(sid, text);
              else if (isLocal) bridge.writeLocalPty(sid, text);
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
          {isSerial ? (
            <span className="flex items-center gap-1 font-medium text-amber-300">
              <Unplug className="h-3.5 w-3.5" />
              <span>{host.label}</span>
            </span>
          ) : isLocal ? (
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
            {isSerial ? cwd : cwd}
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
            <button
              title="Command History & Reverse Search (Ctrl+R)"
              onClick={() => setShowCmdSearch(true)}
              className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-emerald-300 transition"
            >
              <History className="h-3 w-3" />
            </button>
            <button
              title="Clipboard History (⌘⇧V / Ctrl+Shift+V)"
              onClick={() => setShowClipboard(true)}
              className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-cyan-300 transition"
            >
              <Clipboard className="h-3 w-3" />
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

      <div ref={containerRef} className={cn('relative min-h-0 flex-1', showHeader ? 'px-2 pt-2' : 'px-3 py-1.5')}>
        <div ref={elRef} className="h-full w-full" />

        {/* Real-time Inline Ghost Text Autosuggestion (Fish / Zsh / Copilot style) */}
        {suggestion && ghostPos && (
          <div
            style={{
              position: 'absolute',
              left: `${ghostPos.x}px`,
              top: `${ghostPos.y}px`,
              height: `${ghostPos.cellHeight}px`,
              lineHeight: `${ghostPos.cellHeight}px`,
              fontFamily:
                '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
              fontSize: `${fontSize}px`,
              pointerEvents: 'none',
              zIndex: 20,
              whiteSpace: 'pre',
            }}
            className="select-none text-slate-400/50"
          >
            {suggestion.suffix.replace(/ /g, '\u00A0')}
          </div>
        )}
      </div>

      {status === 'connecting' && (
        <div
          className={cn(
            'pointer-events-none absolute right-3 flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-1 text-[11px] text-slate-300 backdrop-blur',
            showHeader ? 'top-10' : 'top-3'
          )}
        >
          <Loader2 className="h-3 w-3 animate-spin text-cyan-300" />
          {isSerial ? 'Opening serial port…' : isLocal ? 'Initializing shell…' : 'Handshaking…'}
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


      {/* Ctrl+R Command Search Modal */}
      {showCmdSearch && (
        <CommandSearchModal
          initialHostLabel={isLocal ? 'Local Terminal' : host.label}
          onClose={() => {
            setShowCmdSearch(false);
            termRef.current?.focus();
          }}
          onSelect={handleSelectCommand}
          onSaveSnippet={(cmd) => {
            bridge.saveSnippet({
              id: crypto.randomUUID(),
              name: cmd.slice(0, 32),
              command: cmd,
              tags: [isLocal ? 'local' : host.label],
            }).then(() => toast('Saved to snippets')).catch(() => {});
          }}
          toast={toast}
        />
      )}

      {/* ⌘⇧V / Ctrl+Shift+V Clipboard History Modal */}
      {showClipboard && (
        <ClipboardModal
          onClose={() => {
            setShowClipboard(false);
            termRef.current?.focus();
          }}
          onPaste={handlePasteClipboard}
          toast={toast}
        />
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
