import { useMobile } from '../hooks/useMobile';
import { useTerminalTouch, type TerminalTouchGesture } from '../hooks/useTerminalTouch';
import { TerminalSelection } from './TerminalSelection';
import { isTerminalModifierKey, modifiedTerminalInput, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, SmartTerminalWriter, type TerminalModifiers } from '../lib/mobileTerminal';
import { TerminalAccessory } from './TerminalAccessory';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
  ShieldAlert,
  ShieldCheck,
  KeyRound,
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
  Keyboard,
  KeyboardOff,
  ChevronLeft,
  Plus,
  HardDrive,
  Server,
  Boxes,
  Radio,
} from 'lucide-react';
import { bridge, isBridgeError, isTauri } from '../lib/bridge';
import { parseOsFromBanner } from '../lib/os';
import { registry } from '../lib/sessions';
import { ClipboardModal } from './ClipboardModal';
import { CommandSearchModal } from './CommandSearchModal';
import type { DrexiusTheme } from '../lib/themes';
import type { Host, Pane, PaneStatus, SessionEvent } from '../lib/types';
import { cn } from '../utils/cn';
import { safeUid } from '../utils/uuid';

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
const COMMON_SHELL_COMMANDS_LOWER = COMMON_SHELL_COMMANDS.map((c) => c.toLowerCase());

/** How many times an interrupted *auto-resume* is retried with backoff before the
 *  failure is surfaced as an error dialog. Chosen for phone reality: after an
 *  unlock the radio can need a few attempts before DNS/TCP works again. */
const MAX_RESUME_ATTEMPTS = 6;

interface Props {
  pane: Pane;
  host: Host;
  theme: DrexiusTheme;
  fontSize: number;
  /** Phone pinch-to-zoom commits the new size here (the app owns and persists the setting). */
  onFontSizeChange?: (size: number) => void;
  lineHeight?: number;
  active: boolean;
  showHeader: boolean;
  isSplit?: boolean;
  mobileHidden?: boolean;
  broadcast?: boolean;
  onOpenDocker?: () => void;
  onFocus: () => void;
  onClose: () => void;
  onChange: () => void;
  onData?: (data: string) => void;
  toast?: (msg: string) => void;
  /** Mobile only: wiring for the session bar that sits under the terminal (back, switcher, new connection). */
  mobileBar?: MobileSessionBarActions;
  /** Mobile only: fraction of the pane height covered by a half-open drawer; the terminal gives up that space. */
  drawerInset?: number;
}

/** What the phone session bar can do; the pane itself owns close + keyboard. */
export interface MobileSessionBarActions {
  sessionCount: number;
  onBack: () => void;
  onOpenSessions: () => void;
  onConnectHost: () => void;
  onLocalTerminal: () => void;
  onSftp: () => void;
  onDocker?: () => void;
  onSerial: () => void;
  onAssistant: () => void;
  onSnippets: () => void;
  onKeypad: () => void;
  onHistory: () => void;
}

export const TerminalPane = memo(function TerminalPane({
  pane,
  host,
  theme,
  fontSize,
  onFontSizeChange,
  lineHeight = 1.0,
  active,
  showHeader,
  isSplit = false,
  broadcast = false,
  onOpenDocker,
  mobileHidden = false,
  onFocus,
  onClose,
  onChange,
  onData,
  toast = () => {},
  mobileBar,
  drawerInset = 0,
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
  const onDataRef = useRef(onData);
  const updateRef = useRef<(patch: Parameters<typeof registry.patch>[1]) => void>(() => {});
  const onChangeRef = useRef(onChange);
  const pendingSize = useRef<{ cols: number; rows: number } | null>(null);
  const lastSentSize = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const resizeScheduled = useRef(false);

  // Command & Clipboard history + Autosuggestion states
  const historyCacheRef = useRef<string[]>([]);
  const historyLowerRef = useRef<string[]>([]);
  const [showCmdSearch, setShowCmdSearch] = useState(false);
  const [showClipboard, setShowClipboard] = useState(false);
  const pasteLockRef = useRef(false);
  const smartWriterRef = useRef<SmartTerminalWriter | null>(null);
  const [suggestion, setSuggestion] = useState<{ full: string; suffix: string } | null>(null);
  const suggestionRef = useRef<{ full: string; suffix: string } | null>(null);
  suggestionRef.current = suggestion;
  const multilineBufferRef = useRef<string[]>([]);

  const [status, setStatus] = useState<PaneStatus>('connecting');
  const [cwd, setCwd] = useState('~');
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
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

  useEffect(() => {
    onDataRef.current = onData;
    updateRef.current = update;
    onChangeRef.current = onChange;
  }, [onData, update, onChange]);

  const scheduleResize = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    pendingSize.current = { cols, rows };
    if (resizeScheduled.current) return;

    resizeScheduled.current = true;
    requestAnimationFrame(() => {
      resizeScheduled.current = false;
      const size = pendingSize.current;
      const sid = sessionRef.current;
      if (size && sid && !isSerial) {
        if (
          size.cols === lastSentSize.current.cols &&
          size.rows === lastSentSize.current.rows
        ) {
          return;
        }
        lastSentSize.current = { cols: size.cols, rows: size.rows };
        if (isLocal) {
          void bridge.resizeLocalPty(sid, size.cols, size.rows).catch(() => {});
        } else {
          void bridge.resize(sid, size.cols, size.rows).catch(() => {});
        }
      }
    });
  }, [isSerial, isLocal]);

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

  /**
   * True when the cursor sits after a password-style prompt ("Password:", "[sudo] password for x:", "Enter passphrase:").
   * Keystrokes typed there are secrets, so they must never reach history or snapshots.
   * Checked at Enter, before the shell's echo arrives, so the prompt is still on the cursor line.
   */
  const isPasswordPromptActive = useCallback((): boolean => {
    const term = termRef.current;
    if (!term) return false;
    try {
      const buffer = term.buffer.active;
      if (buffer.type === 'alternate') return false;
      const lineObj = buffer.getLine(buffer.cursorY + buffer.baseY);
      if (!lineObj) return false;
      const upToCursor = lineObj.translateToString(false, 0, buffer.cursorX);
      return /(pass(word|phrase|code)?|passcode|otp|token|secret|pin)\b[^:：\n]{0,80}[:：]\s*$/i.test(upToCursor);
    } catch {
      return false;
    }
  }, []);

  const getCurrentCommandLine = useCallback((): string => {
    const term = termRef.current;
    if (!term) return lineRef.current;

    try {
      const buffer = term.buffer.active;
      if (buffer.type === 'alternate') return '';

      const lineIndex = buffer.cursorY + buffer.baseY;
      const lineObj = buffer.getLine(lineIndex);
      if (!lineObj) return lineRef.current;

      // Find the first line of the logical command (walk backwards while lines are marked wrapped)
      let startY = lineIndex;
      while (startY > 0 && buffer.getLine(startY)?.isWrapped) {
        startY--;
      }

      // Reconstruct the full logical line from startY through lineIndex up to cursorX
      let upToCursor = '';
      for (let y = startY; y < lineIndex; y++) {
        const row = buffer.getLine(y);
        if (row) {
          upToCursor += row.translateToString(true);
        }
      }
      const currentRow = buffer.getLine(lineIndex);
      if (currentRow) {
        upToCursor += currentRow.translateToString(false, 0, buffer.cursorX);
      }

      // 1. user@host:path[$#%>] (standard Linux, macOS, bash, zsh)
      const userHost = upToCursor.match(/^(?:(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+[^\$#%>]*[\$#%>]\s+)(.*)$/);
      if (userHost && userHost[1] !== undefined) {
        return userHost[1];
      }

      // 2. Bracketed prompt: [user@host path]$ or (venv) [user@host path]#
      const bracketed = upToCursor.match(/^(?:(?:\([^)]+\)\s*)?\[[^\]]+\][\$#%>]\s+)(.*)$/);
      if (bracketed && bracketed[1] !== undefined) {
        return bracketed[1];
      }

      // 3. Modern prompt glyphs: ❯, ➜, λ, » (Starship, Pure, Oh-My-Zsh)
      const glyph = upToCursor.match(/^.*?[❯➜λ»]\s*(.*)$/);
      if (glyph && glyph[1] !== undefined) {
        return glyph[1];
      }

      // 4. Secondary continuation prompt (PS2): "> command"
      const ps2 = upToCursor.match(/^>\s+(.*)$/);
      if (ps2 && ps2[1] !== undefined) {
        return ps2[1];
      }

      // 5. Simple prompt: "$ ", "# ", "% " at prompt start (WITHOUT matching spaces in command body)
      const simple = upToCursor.match(/^(?:(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-~/:*]*?[\$#%]\s+)(.*)$/);
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

    // 1. Check history first using precomputed lowercase array (O(1) allocation per check)
    const historyOrig = historyCacheRef.current;
    const historyLow = historyLowerRef.current;
    let bestMatch: string | null = null;

    for (let i = 0; i < historyLow.length; i++) {
      if (historyLow[i].startsWith(prefixLower) && historyOrig[i].length > prefix.length) {
        bestMatch = historyOrig[i];
        break;
      }
    }

    // 2. Fall back to common commands if no history match
    if (!bestMatch) {
      for (let i = 0; i < COMMON_SHELL_COMMANDS_LOWER.length; i++) {
        if (COMMON_SHELL_COMMANDS_LOWER[i].startsWith(prefixLower) && COMMON_SHELL_COMMANDS[i].length > prefix.length) {
          bestMatch = COMMON_SHELL_COMMANDS[i];
          break;
        }
      }
    }

    if (!bestMatch) {
      setSuggestion(null);
      setGhostPos(null);
      return;
    }

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
    // If no suggestion is active, skip measuring and avoid re-renders (fixes H4 render storm)
    if (!suggestionRef.current) {
      setGhostPos((prev) => (prev !== null ? null : prev));
      return;
    }

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

    // Only set new state if coordinates or cellHeight actually changed
    setGhostPos((prev) => {
      if (prev && prev.x === x && prev.y === y && prev.cellHeight === cellHeight) {
        return prev;
      }
      return { x, y, cellHeight };
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
      const attempt = ++genRef.current;
      const dead = () => genRef.current !== attempt;
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
                smartWriterRef.current ? smartWriterRef.current.write(ev.data) : term.write(ev.data);
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
        const initCols = term.cols || 80;
        const initRows = term.rows || 24;
        let suppressLocalBanner = false;
        const onLocalEvent = (ev: SessionEvent) => {
          if (dead()) return;
          switch (ev.type) {
            case 'output':
              smartWriterRef.current ? smartWriterRef.current.write(ev.data) : term.write(ev.data);
              break;
            case 'cwd':
              setCwd(ev.path);
              update({ cwd: ev.path });
              break;
            case 'connected':
              if (!suppressLocalBanner) {
                term.write(`\x1b[32m✔ Local shell session started\x1b[0m\r\n`);
              }
              break;
            case 'disconnected':
              sessionRef.current = null;
              try { localStorage.removeItem('drx.pane.sid.' + pane.id); } catch {}
              term.write(`\r\n\x1b[90m[Process completed: ${ev.reason}]\x1b[0m\r\n`);
              setStatus('disconnected');
              update({ status: 'disconnected', sessionId: null });
              break;
          }
        };

        const existingLocalSid =
          sessionRef.current ||
          pane.sessionId ||
          (() => {
            try { return localStorage.getItem('drx.pane.sid.' + pane.id); } catch { return null; }
          })();
        if (existingLocalSid) {
          suppressLocalBanner = true;
          const attached = await bridge.attachLocalPty(existingLocalSid, initCols, initRows, onLocalEvent);
          suppressLocalBanner = false;
          if (attached) {
            if (dead()) return;
            sessionRef.current = existingLocalSid;
            try { localStorage.setItem('drx.pane.sid.' + pane.id, existingLocalSid); } catch {}
            retryRef.current = 0;
            setStatus('connected');
            update({ status: 'connected', sessionId: existingLocalSid });
            return;
          }
          try { localStorage.removeItem('drx.pane.sid.' + pane.id); } catch {}
        }

        term.write(`\r\n\x1b[90m→ Spawning ${pane.customShell ? 'custom session' : 'local PTY shell'}…\x1b[0m\r\n`);
        try {
          const sid = await bridge.spawnLocalPty(initCols, initRows, pane.customShell, undefined, onLocalEvent);
          if (dead()) {
            bridge.closeLocalPty(sid);
            return;
          }
          sessionRef.current = sid;
          try { localStorage.setItem('drx.pane.sid.' + pane.id, sid); } catch {}
          retryRef.current = 0;
          setStatus('connected');
          update({ status: 'connected', sessionId: sid });
          if (term.cols && term.rows) {
            bridge.resizeLocalPty(sid, term.cols, term.rows);
          }
          const startupCmd = pane.startupCommand || host.startupCommand;
          if (startupCmd && startupCmd.trim()) {
            const startup = startupCmd.trim() + '\n';
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
      try {
        const initCols = term.cols || 80;
        const initRows = term.rows || 24;
        let suppressConnectBanner = false;
        const onSshEvent = (ev: SessionEvent) => {
          if (dead()) return;
          switch (ev.type) {
            case 'output':
              smartWriterRef.current ? smartWriterRef.current.write(ev.data) : term.write(ev.data);
              break;
            case 'cwd':
              setCwd(ev.path);
              update({ cwd: ev.path });
              if (sessionRef.current) bridge.recordSnapshot(host.id, sessionRef.current, { cwd: ev.path });
              break;
            case 'connected': {
              if (!suppressConnectBanner) {
                term.write(
                  `\x1b[32m✔ Authenticated\x1b[90m · host key SHA256:${ev.fingerprint.slice(0, 22)}…\x1b[0m\r\n`
                );
              }
              const detected = ev.os ?? parseOsFromBanner(ev.banner);
              if (detected && detected !== host.os) {
                bridge.saveHost({ ...host, os: detected }).then(() => onChange()).catch(() => {});
              }
              break;
            }
            case 'disconnected':
              sessionRef.current = null;
              try { localStorage.removeItem('drx.pane.sid.' + pane.id); } catch {}
              lastSentSize.current = { cols: 0, rows: 0 };
              term.write(`\r\n\x1b[31m✖ ${ev.reason}\x1b[0m\r\n`);
              setStatus('disconnected');
              update({ status: 'disconnected', sessionId: null });
              if (ev.resumable) {
                retryRef.current += 1;
                setCountdown(Math.min(30, 3 * 2 ** (retryRef.current - 1)));
              }
              break;
          }
        };

        const existingSshSid =
          sessionRef.current ||
          pane.sessionId ||
          (() => {
            try { return localStorage.getItem('drx.pane.sid.' + pane.id); } catch { return null; }
          })();
        if (existingSshSid) {
          suppressConnectBanner = true;
          const attached = await bridge.attach(existingSshSid, initCols, initRows, onSshEvent);
          suppressConnectBanner = false;
          if (attached) {
            if (dead()) return;
            sessionRef.current = existingSshSid;
            try { localStorage.setItem('drx.pane.sid.' + pane.id, existingSshSid); } catch {}
            lastSentSize.current = { cols: initCols, rows: initRows };
            retryRef.current = 0;
            setStatus('connected');
            update({ status: 'connected', sessionId: existingSshSid });
            return;
          }
          try { localStorage.removeItem('drx.pane.sid.' + pane.id); } catch {}
        }

        term.write(
          `\r\n\x1b[90m${resume ? '⟲ Resuming' : '→ Connecting to'} \x1b[36m${host.username}@${host.hostname}:${
            host.port
          }\x1b[90m via ${host.keychainId ? 'keychain identity' : host.authMethod === 'key' ? 'public key' : host.authMethod}…\x1b[0m\r\n`
        );
        const sid = await bridge.connect(host.id, initCols, initRows, resume, onSshEvent);
        if (dead()) {
          bridge.disconnect(sid);
          return;
        }
        sessionRef.current = sid;
        try { localStorage.setItem('drx.pane.sid.' + pane.id, sid); } catch {}
        lastSentSize.current = { cols: initCols, rows: initRows };
        retryRef.current = 0;
        setStatus('connected');
        update({ status: 'connected', sessionId: sid });
        if (term.cols && term.rows && (term.cols !== initCols || term.rows !== initRows)) {
          lastSentSize.current = { cols: term.cols, rows: term.rows };
          bridge.resize(sid, term.cols, term.rows);
        }
        const startupCmd = pane.startupCommand || host.startupCommand;
        if (startupCmd && startupCmd.trim()) {
          const startup = startupCmd.trim() + '\n';
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
          if (resume && retryRef.current < MAX_RESUME_ATTEMPTS) {
            retryRef.current += 1;
            const wait = Math.min(30, 3 * 2 ** (retryRef.current - 1));
            setStatus('disconnected');
            update({ status: 'disconnected' });
            setCountdown(wait);
            term.write(
              `\x1b[90m↻ ${msg} — retry ${retryRef.current}/${MAX_RESUME_ATTEMPTS} in ${wait}s\x1b[0m\r\n`
            );
          } else {
            setStatus('error');
            update({ status: 'error' });
            term.write(`\x1b[31m✖ ${msg}\x1b[0m\r\n`);
          }
        }
      }
    },
    [host, isLocal, pane.id, pane.sessionId, pane.customShell, update, onChange]
  );

  const mobile = useMobile();
  const [modifiers, setModifiers] = useState<TerminalModifiers>({ ctrl: false, alt: false });
  const modifiersRef = useRef(modifiers);
  const swallowRef = useRef<{ char: string; until: number } | null>(null);
  const handledInputRef = useRef(false);
  const lastEnterRef = useRef(0);
  const lastBackspaceRef = useRef(0);
  const lastInsertedRef = useRef<{ text: string; time: number }>({ text: '', time: 0 });

  /** Key-row / keypad input: honours application cursor mode and the one-shot CTRL/ALT latches. */
  const sendAccessoryKey = useCallback((data: string) => {
    // If an autosuggestion is active and Tab or Right Arrow is pressed -> accept suggestion!
    if (suggestionRef.current && (data === '\t' || data === '\x1b[C' || data === '\x1bOC')) {
      acceptSuggestion();
      return;
    }

    // Dismiss suggestion on navigation arrows or Escape
    if (suggestionRef.current && (data === '\x1b' || /^\x1b(\[|O)[ABD]$/.test(data))) {
      setSuggestion(null);
      setGhostPos(null);
    }

    const term = termRef.current;
    if (term?.modes.applicationCursorKeysMode && /^\x1b\[[ABCD]$/.test(data)) data = data.replace('[', 'O');
    if (data === '\x03') {
      modifiersRef.current = { ctrl: false, alt: false };
      setModifiers(modifiersRef.current);
      swallowRef.current = { char: 'c', until: Date.now() + 1200 };
      if (term?.textarea) {
        term.textarea.value = mobile ? ' ' : '';
        if (mobile) {
          try { term.textarea.setSelectionRange(1, 1); } catch {}
        }
      }
    } else if (modifiersRef.current.ctrl || modifiersRef.current.alt) {
      modifiersRef.current = { ctrl: false, alt: false };
      setModifiers(modifiersRef.current);
    }
    term?.input(data, true);
    term?.focus();
  }, [mobile, acceptSuggestion]);

  // Latest callbacks for the registry entry (created once in the mount effect) — the phone's
  // keypad and history drawers live in App and reach the pane through these.
  const accessoryKeyRef = useRef(sendAccessoryKey); accessoryKeyRef.current = sendAccessoryKey;
  const insertRef = useRef(handleSelectCommand); insertRef.current = handleSelectCommand;
  const toggleSearchRef = useRef(() => setShowSearch((v) => !v));
  toggleSearchRef.current = () => {
    setShowSearch((v) => {
      const next = !v;
      if (next) setTimeout(() => searchInputRef.current?.select(), 50);
      return next;
    });
  };
  const openHistoryRef = useRef(() => setShowCmdSearch(true));
  openHistoryRef.current = () => setShowCmdSearch(true);
  const openClipboardRef = useRef(() => setShowClipboard(true));
  openClipboardRef.current = () => setShowClipboard(true);

  // Phone selection UI: the long-press paste menu (no selection) and the live terminal for the overlay.
  const [touchMenu, setTouchMenu] = useState<{ x: number; y: number } | null>(null);
  const [termInstance, setTermInstance] = useState<Terminal | null>(null);
  const [connectMenu, setConnectMenu] = useState(false);
  // Pinch-to-zoom. While the fingers move the terminal is only *transformed* (a composited CSS
  // scale anchored bottom-left, so the prompt stays put and nothing reflows mid-gesture); on
  // release the preview eases onto the nearest whole font size, which is then committed and the
  // transform dropped in the same frame xterm repaints at the real size.
  const [zoomHud, setZoomHud] = useState<{ size: number; leaving: boolean } | null>(null);
  const pinch = useRef<{ base: number; preview: number; timer: number; hud: number }>({ base: fontSize, preview: 1, timer: 0, hud: 0 });
  const fontSizeRef = useRef(fontSize); fontSizeRef.current = fontSize;
  const onFontSizeChangeRef = useRef(onFontSizeChange); onFontSizeChangeRef.current = onFontSizeChange;
  const pinchAwaitingCommit = useRef(false);
  const onPinch = useCallback((phase: 'start' | 'move' | 'end', scale: number) => {
    const el = elRef.current, box = containerRef.current, p = pinch.current;
    if (!el) return;
    const clampScale = (s: number) => Math.max(TERMINAL_FONT_MIN / p.base, Math.min(TERMINAL_FONT_MAX / p.base, s));
    if (phase === 'start') {
      window.clearTimeout(p.timer); window.clearTimeout(p.hud);
      p.base = fontSizeRef.current; p.preview = 1; pinchAwaitingCommit.current = false;
      el.style.transition = 'none'; el.style.transformOrigin = '0 100%'; el.style.willChange = 'transform';
      if (box) box.style.overflow = 'hidden';
      setZoomHud({ size: p.base, leaving: false });
      return;
    }
    if (phase === 'move') {
      p.preview = clampScale(scale);
      el.style.transform = `scale(${p.preview})`;
      const size = Math.round(p.base * p.preview);
      setZoomHud((h) => (h && h.size === size && !h.leaving ? h : { size, leaving: false }));
      return;
    }
    const next = Math.max(TERMINAL_FONT_MIN, Math.min(TERMINAL_FONT_MAX, Math.round(p.base * clampScale(scale))));
    const settle = () => {
      el.style.transition = ''; el.style.transform = ''; el.style.transformOrigin = ''; el.style.willChange = '';
      if (box) box.style.overflow = '';
      pinchAwaitingCommit.current = false;
      setZoomHud((h) => (h ? { ...h, leaving: true } : h));
      p.hud = window.setTimeout(() => setZoomHud(null), 260);
    };
    // Ease the live preview onto the exact scale of the chosen size, then swap the real font in.
    el.style.transition = 'transform 110ms cubic-bezier(.2,.8,.2,1)';
    el.style.transform = `scale(${next / p.base})`;
    setZoomHud({ size: next, leaving: false });
    p.timer = window.setTimeout(() => {
      if (next === fontSizeRef.current || !onFontSizeChangeRef.current) { settle(); return; }
      pinchAwaitingCommit.current = true;
      pinchSettleRef.current = settle;
      onFontSizeChangeRef.current(next);
    }, 130);
  }, []);
  const pinchSettleRef = useRef<(() => void) | null>(null);
  const onTouchGesture = useCallback((g: TerminalTouchGesture) => {
    if (g.kind === 'pinch') { onPinch(g.phase, g.scale); return; }
    setTouchMenu(g.kind === 'menu' ? { x: g.x, y: g.y } : null);
  }, [onPinch]);
  // On phones the virtual keyboard is opened only by the explicit keyboard button:
  // xterm focuses its textarea on every tap, so the textarea carries inputmode="none"
  // (focusable, hardware keys work, no on-screen keyboard) until that button flips it.
  const showKeyboard = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.textarea) { term.textarea.inputMode = 'text'; term.textarea.blur(); }
    term.focus();
  }, []);
  const hideKeyboard = useCallback(() => {
    const term = termRef.current;
    if (term?.textarea) {
      term.textarea.inputMode = 'none';
      if (mobile) term.textarea.value = '';
    }
    term?.blur();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [mobile]);
  const toggleModifier = (key: keyof TerminalModifiers) => {
    const next = { ...modifiersRef.current, [key]: !modifiersRef.current[key] };
    modifiersRef.current = next; setModifiers(next);
  };
  useEffect(() => {
    if (!active || !mobile) {
      modifiersRef.current = { ctrl: false, alt: false };
      setModifiers(modifiersRef.current); setTouchMenu(null); setConnectMenu(false);
    }
  }, [active, mobile]);

  // Mount xterm once
  useEffect(() => {
    const term = new Terminal({
      fontFamily:
        '"JetBrainsMono Nerd Font", "JetBrains Mono Variable", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
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

    // Prefer the hardware-accelerated WebGL renderer for gapless box/block drawing.
    // If WebGL2 is unavailable, or the context is lost later (common on phones when
    // the app is backgrounded or under memory pressure), xterm 6 falls back to its
    // built-in DOM renderer: disposing the addon restores it automatically.
    // Note: @xterm/addon-canvas only supports xterm 5 and crashes on dispose under
    // xterm 6, so it must not be used as a fallback here.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        console.warn('WebGL context lost; terminal switched to the DOM renderer');
        try { webgl.dispose(); } catch { /* already disposed */ }
      });
      term.loadAddon(webgl);
    } catch (err) {
      console.warn('WebGL renderer unavailable, using DOM renderer:', err);
    }

    const helperTextarea = term.textarea;

    const resetHelperValue = () => {
      if (!mobile || !helperTextarea) return;
      helperTextarea.value = ' ';
      try {
        helperTextarea.setSelectionRange(1, 1);
      } catch {
        /* ignore */
      }
    };

    const handleBeforeInput = (e: InputEvent) => {
      if (!mobile) {
        if (!modifiersRef.current.ctrl && !modifiersRef.current.alt) return;
        const char = e.data;
        if (char && char.length === 1) {
          e.preventDefault();
          e.stopPropagation();
          const activeMod = { ...modifiersRef.current };
          modifiersRef.current = { ctrl: false, alt: false };
          setModifiers(modifiersRef.current);
          const lower = char.toLowerCase();
          swallowRef.current = { char: lower, until: Date.now() + 1200 };
          if (helperTextarea) {
            helperTextarea.value = '';
          }
          const modified = modifiedTerminalInput(char, activeMod);
          term.input(modified, true);
        }
        return;
      }

      // Mobile soft keyboard handling:
      const inputType = e.inputType;
      const data = e.data;

      // Handle Ctrl/Alt one-shot latch from the mobile accessory bar
      if (modifiersRef.current.ctrl || modifiersRef.current.alt) {
        if (data && data.length === 1) {
          e.preventDefault();
          e.stopPropagation();
          const activeMod = { ...modifiersRef.current };
          modifiersRef.current = { ctrl: false, alt: false };
          setModifiers(modifiersRef.current);
          const modified = modifiedTerminalInput(data, activeMod);
          term.input(modified, true);
          resetHelperValue();
          handledInputRef.current = true;
          return;
        }
      }

      if (
        inputType === 'insertText' ||
        inputType === 'insertCompositionText' ||
        inputType === 'insertReplacementText' ||
        inputType === 'insertFromPaste'
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (data) {
          if (data === lastInsertedRef.current.text && Date.now() - lastInsertedRef.current.time < 60) {
            resetHelperValue();
            handledInputRef.current = true;
            return;
          }
          lastInsertedRef.current = { text: data, time: Date.now() };
          term.input(data, true);
        }
        resetHelperValue();
        handledInputRef.current = true;
        return;
      }

      if (inputType === 'deleteContentBackward') {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() - lastBackspaceRef.current > 120) {
          lastBackspaceRef.current = Date.now();
          term.input('\x7f', true);
        }
        resetHelperValue();
        handledInputRef.current = true;
        return;
      }

      if (inputType === 'deleteContentForward') {
        e.preventDefault();
        e.stopPropagation();
        term.input('\x1b[3~', true);
        resetHelperValue();
        handledInputRef.current = true;
        return;
      }

      if (inputType === 'deleteWordBackward') {
        e.preventDefault();
        e.stopPropagation();
        term.input('\x17', true); // ^W in readline
        resetHelperValue();
        handledInputRef.current = true;
        return;
      }

      if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() - lastEnterRef.current > 200) {
          lastEnterRef.current = Date.now();
          term.input('\r', true);
        }
        resetHelperValue();
        handledInputRef.current = true;
        return;
      }
    };

    const handleCompositionStart = (e: CompositionEvent) => {
      if (!mobile) return;
      e.stopImmediatePropagation();
    };

    const handleCompositionUpdate = (e: CompositionEvent) => {
      if (!mobile) return;
      e.stopImmediatePropagation();
    };

    const handleCompositionEnd = (e: CompositionEvent) => {
      if (!mobile) {
        const sw = swallowRef.current;
        if (sw && Date.now() < sw.until) {
          const text = (e.data || helperTextarea?.value || '').toLowerCase();
          if (text === sw.char || text.includes(sw.char)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (helperTextarea) helperTextarea.value = '';
            return;
          }
        }
        return;
      }

      e.stopImmediatePropagation();
      resetHelperValue();
    };

    const handleInput = (e: Event) => {
      if (!mobile) {
        const sw = swallowRef.current;
        if (sw && Date.now() < sw.until) {
          const val = (helperTextarea?.value || '').toLowerCase();
          if (val === sw.char || val.includes(sw.char)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (helperTextarea) helperTextarea.value = '';
            return;
          }
        }
        return;
      }

      e.stopPropagation();

      if (handledInputRef.current) {
        handledInputRef.current = false;
        if (helperTextarea && helperTextarea.value !== ' ') {
          resetHelperValue();
        }
        return;
      }

      // Fallback if beforeinput didn't handle the keystroke
      if (helperTextarea) {
        const val = helperTextarea.value;
        if (val === '') {
          if (Date.now() - lastBackspaceRef.current > 120) {
            lastBackspaceRef.current = Date.now();
            term.input('\x7f', true);
          }
        } else if (val !== ' ') {
          let text = val;
          if (text.startsWith(' ')) text = text.slice(1);
          else if (text.endsWith(' ')) text = text.slice(0, -1);
          if (text) {
            if (!(text === lastInsertedRef.current.text && Date.now() - lastInsertedRef.current.time < 60)) {
              lastInsertedRef.current = { text, time: Date.now() };
              term.input(text, true);
            }
          }
        }
        resetHelperValue();
      }
    };

    const handleFocus = () => {
      if (mobile) resetHelperValue();
    };

    const handleBlur = () => {
      if (mobile && helperTextarea) helperTextarea.value = '';
    };

    const handleHelperPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        bridge.addClipboardHistory(text, 'System Clipboard').catch(() => {});
      }
    };

    if (helperTextarea) {
      helperTextarea.setAttribute('autocapitalize', 'none');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
      helperTextarea.setAttribute('spellcheck', 'false');
      if (mobile) {
        helperTextarea.setAttribute('enterkeyhint', 'send');
        resetHelperValue();
      }
      helperTextarea.addEventListener('beforeinput', handleBeforeInput as EventListener, true);
      helperTextarea.addEventListener('compositionstart', handleCompositionStart as EventListener, true);
      helperTextarea.addEventListener('compositionupdate', handleCompositionUpdate as EventListener, true);
      helperTextarea.addEventListener('compositionend', handleCompositionEnd as EventListener, true);
      helperTextarea.addEventListener('input', handleInput as EventListener, true);
      helperTextarea.addEventListener('paste', handleHelperPaste as EventListener);
      helperTextarea.addEventListener('focus', handleFocus);
      helperTextarea.addEventListener('blur', handleBlur);
    }

    termRef.current = term;
    smartWriterRef.current = new SmartTerminalWriter(term);
    fitRef.current = fit;
    searchRef.current = search;
    setTermInstance(term);

    // Synchronous immediate fit so cols/rows are initialized before connect()
    try {
      if (elRef.current?.clientWidth && elRef.current.clientHeight) fit.fit();
    } catch {
      /* hidden */
    }

    requestAnimationFrame(() => {
      try {
        if (elRef.current?.clientWidth && elRef.current.clientHeight) fit.fit();
      } catch {
        /* hidden */
      }
    });

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        try {
          if (elRef.current?.clientWidth && elRef.current.clientHeight) fit.fit();
        } catch {
          /* hidden */
        }
      });
    }

    // Keep PTY dimensions in sync on any terminal resize event (coalesced)
    term.onResize(({ cols, rows }) => {
      scheduleResize(cols, rows);
    });

    // OSC 7 — working directory reporting
    term.parser.registerOscHandler(7, (data) => {
      const match = data.match(/^file:\/\/[^/]*(\/.{0,4096})$/);
      if (match) {
        try {
          const p = decodeURI(match[1]);
          if (!p.includes('\0') && !/[\r\n]/.test(p)) {
            setCwd(p);
            updateRef.current({ cwd: p });
          }
        } catch {
          // Ignore malformed terminal-controlled OSC-7 escapes
        }
      }
      return true;
    });

    // Preload recent command history for instant autosuggestions
    bridge.listCommandHistory(200).then((items) => {
      const raw = items.map((i) => i.command.trim()).filter((c) => c.length >= 2);
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const cmd of raw) {
        if (!seen.has(cmd)) {
          seen.add(cmd);
          cleaned.push(cmd);
        }
      }
      historyCacheRef.current = cleaned;
      historyLowerRef.current = cleaned.map((cmd) => cmd.toLowerCase());
    }).catch(() => {});

    // Track cursor and viewport changes to update ghost text alignment
    const dCursor = term.onCursorMove(updateGhostPos);
    const dRender = term.onRender(updateGhostPos);
    const dScroll = term.onScroll(updateGhostPos);

    term.attachCustomKeyEventHandler((e) => {
      if (mobile) {
        if (e.keyCode === 13 || e.key === 'Enter') {
          lastEnterRef.current = Date.now();
        } else if (e.keyCode === 8 || e.key === 'Backspace') {
          lastBackspaceRef.current = Date.now();
        } else if (e.keyCode === 229) {
          // On mobile Android, keyCode 229 triggers xterm's broken CompositionHelper._handleAnyTextareaChanges()
          // which diffs the textarea value and causes exponential text duplication/echo lag.
          // Returning false silences xterm's internal diffing; we handle mobile typing cleanly in handleBeforeInput/handleInput.
          return false;
        }
      }

      // Terminal Find is handled by the scoped window keydown listener below;
      // do not also send ^F to the remote shell.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        return false;
      }
      // NOTE: ^T / ^K / ^R belong to the shell (readline transpose & kill-line,
      // nano/history-search) — never swallow plain Ctrl combos here. App-level
      // bindings use the Ctrl/Cmd+Shift+* family.

      // Ctrl/Cmd+Shift+R -> Command History Search overlay
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r' && e.type === 'keydown') {
        setShowCmdSearch(true);
        return false;
      }

      // Prevent xterm from sending control sequences on workspace shift shortcuts
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'd', 'e', 'a', 'f', 'z', 'b', 'k', '/'].includes(e.key.toLowerCase()) && e.type === 'keydown') {
        return false;
      }

      // Ctrl+Shift+C (Linux/Win) or Cmd+C (macOS) -> Copy selection to clipboard
      if (e.type === 'keydown' && (((e.ctrlKey && e.shiftKey) || (e.metaKey && !e.shiftKey)) && e.key.toLowerCase() === 'c')) {
        e.preventDefault();
        e.stopPropagation();
        if (term.hasSelection()) {
          const sel = term.getSelection();
          if (sel) {
            bridge.writeClipboard(sel).catch(() => {});
            bridge.addClipboardHistory(sel, `Terminal (${isLocal ? 'Local' : host.label})`).catch(() => {});
          }
        }
        return false;
      }

      // Ctrl+Shift+V (Linux/Win) or Cmd+V (macOS) -> Paste directly from system clipboard into terminal
      if (e.type === 'keydown' && (((e.ctrlKey && e.shiftKey) || (e.metaKey && !e.shiftKey)) && e.key.toLowerCase() === 'v')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || pasteLockRef.current) return false;
        pasteLockRef.current = true;
        bridge.readClipboard().then((txt) => {
          if (txt) {
            term.paste(txt);
            bridge.addClipboardHistory(txt, 'System Clipboard').catch(() => {});
          }
        }).catch((err) => {
          console.warn('Terminal paste failed:', err);
        }).finally(() => {
          setTimeout(() => {
            pasteLockRef.current = false;
          }, 150);
        });
        return false;
      }

      // Ctrl+Shift+H / Cmd+Shift+H or Ctrl+Alt+V / Cmd+Option+V -> Clipboard History modal
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key.toLowerCase() === 'h') || (e.altKey && e.key.toLowerCase() === 'v'))) {
        e.preventDefault();
        e.stopPropagation();
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
      // If a software keyboard / IME emits duplicate character right after modifier sequence, swallow it
      const sw = swallowRef.current;
      if (sw && Date.now() < sw.until) {
        if (data.toLowerCase() === sw.char) {
          swallowRef.current = null;
          return;
        }
        if (data.toLowerCase().startsWith(sw.char)) {
          data = data.slice(sw.char.length);
          swallowRef.current = null;
          if (!data) return;
        }
      }

      // onData also receives software-keyboard input/IME, unlike keydown.
      if ((modifiersRef.current.ctrl || modifiersRef.current.alt) && isTerminalModifierKey(data)) {
        data = modifiedTerminalInput(data, modifiersRef.current);
        modifiersRef.current = { ctrl: false, alt: false };
        setModifiers(modifiersRef.current);
      }
      const sid = sessionRef.current;
      if (!sid) return;
      if (isSerial) {
        bridge.writeSerial(sid, data).catch((err) => console.error('Serial write failed:', err));
      } else if (isLocal) {
        bridge.writeLocalPty(sid, data).catch((err) => console.error('Local PTY write failed:', err));
      } else {
        bridge.write(sid, data).catch((err) => console.error('SSH write failed:', err));
      }

      // Escape sequences (arrows, Home/End, Delete, bracketed paste...) change the
      // line in ways we can't track from keystrokes -> re-read it from the screen.
      if (data.startsWith('\x1b')) {
        scheduleResync();
        onDataRef.current?.(data);
        return;
      }

      // Track submitted lines for snapshot, command history, and autosuggestion
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          // Keystrokes are the truth. Only fall back to the screen if the line was
          // modified by Tab / history navigation and hasn't been re-synced yet.
          const screenCmd = dirtyRef.current ? getCurrentCommandLine() : '';
          const lineCmd = (screenCmd.trim() || lineRef.current).trim();
          if (resyncTimerRef.current !== null) {
            window.clearTimeout(resyncTimerRef.current);
            resyncTimerRef.current = null;
          }
          dirtyRef.current = false;

          // Check if this line ends with a backslash continuation (\)
          const isContinuation = /(^|[^\\])\\$/.test(lineCmd);
          if (isContinuation) {
            multilineBufferRef.current.push(lineCmd.slice(0, -1).trimEnd());
            lineRef.current = '';
            setSuggestion(null);
            setGhostPos(null);
            continue;
          }

          const cmd = multilineBufferRef.current.length > 0
            ? [...multilineBufferRef.current, lineCmd].join(' ')
            : lineCmd;
          multilineBufferRef.current = [];

          // Lines typed at a password prompt are secrets: skip them everywhere, including in-memory history.
          const typedSecret = !!cmd && isPasswordPromptActive();
          if (cmd && !typedSecret) {
            update({ lastCommand: cmd });
            if (!isLocal) {
              bridge.recordSnapshot(host.id, sid, { lastCommand: cmd });
            }
            bridge.addCommandHistory({
              hostId: isLocal ? null : host.id,
              hostLabel: isLocal ? 'Local Terminal' : host.label,
              command: cmd,
              cwd: cwdRef.current || '~',
            }).catch(() => {});

            const idx = historyCacheRef.current.indexOf(cmd);
            if (idx !== -1) {
              historyCacheRef.current.splice(idx, 1);
              historyLowerRef.current.splice(idx, 1);
            }
            historyCacheRef.current.unshift(cmd);
            historyLowerRef.current.unshift(cmd.toLowerCase());
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
          multilineBufferRef.current = [];
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
      onDataRef.current?.(data);
    });

    // Copy on selection mouseup (Termius convenience & Clipboard history)
    // Copies once on mouse release to prevent thrashing clipboard & flooding DB on every drag event (fixes H8)
    const handleMouseUpCopy = () => {
      if (term.hasSelection()) {
        const sel = term.getSelection();
        if (sel && sel.trim().length > 0) {
          bridge.writeClipboard(sel).catch(() => {});
          bridge.addClipboardHistory(sel, `Terminal (${isLocal ? 'Local' : host.label})`).catch(() => {});
        }
      }
    };
    const elContainer = elRef.current;
    elContainer?.addEventListener('mouseup', handleMouseUpCopy);

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
      key: (d) => accessoryKeyRef.current(d),
      insert: (c, execute) => insertRef.current(c, execute),
      toggleSearch: () => toggleSearchRef.current(),
      openHistory: () => openHistoryRef.current(),
      openClipboard: () => openClipboardRef.current(),
    });

    const fitAndScheduleResize = () => {
      if (document.visibilityState === 'hidden') return;
      if (!elRef.current?.clientWidth || !elRef.current.clientHeight) return;
      try {
        fit.fit();
        updateGhostPos();
        if (term.cols && term.rows) {
          scheduleResize(term.cols, term.rows);
        }
      } catch {
        /* not visible */
      }
    };

    const ro = new ResizeObserver(fitAndScheduleResize);
    ro.observe(elRef.current!);
    const handleVisibilityFit = () => {
      if (document.visibilityState === 'visible') {
        fitAndScheduleResize();
        if (!isLocal && !isSerial && sessionRef.current) {
          const currentSid = sessionRef.current;
          bridge.listSshSessions().then((sessions) => {
            if (sessionRef.current === currentSid && !sessions.some((s) => s.sessionId === currentSid)) {
              sessionRef.current = null;
              try { localStorage.removeItem('drx.pane.sid.' + pane.id); } catch {}
              lastSentSize.current = { cols: 0, rows: 0 };
              setStatus('disconnected');
              update({ status: 'disconnected', sessionId: null });
              connect(true);
            }
          }).catch(() => {});
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityFit);

    connect(!!pane.resume);

    return () => {
      genRef.current += 1;
      document.removeEventListener('visibilitychange', handleVisibilityFit);
      elContainer?.removeEventListener('mouseup', handleMouseUpCopy);
      helperTextarea?.removeEventListener('beforeinput', handleBeforeInput as EventListener, true);
      helperTextarea?.removeEventListener('compositionstart', handleCompositionStart as EventListener, true);
      helperTextarea?.removeEventListener('compositionupdate', handleCompositionUpdate as EventListener, true);
      helperTextarea?.removeEventListener('compositionend', handleCompositionEnd as EventListener, true);
      helperTextarea?.removeEventListener('input', handleInput as EventListener, true);
      helperTextarea?.removeEventListener('paste', handleHelperPaste as EventListener);
      helperTextarea?.removeEventListener('focus', handleFocus);
      helperTextarea?.removeEventListener('blur', handleBlur);
      ro.disconnect();
      dCursor.dispose();
      dRender.dispose();
      dScroll.dispose();
      // Only close serial ports on component unmount; SSH and local PTY sessions
      // stay alive in the Rust backend across WebView/layout remounts and are
      // explicitly closed when the user closes the pane/tab or locks the vault.
      if (isSerial && sessionRef.current) {
        bridge.closeSerial(sessionRef.current);
      }
      sessionRef.current = null;
      registry.delete(pane.id);
      smartWriterRef.current?.dispose();
      smartWriterRef.current = null;
      term.dispose();
      setTermInstance(null);
      onChangeRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useTerminalTouch(elRef, termRef, mobile && active, onTouchGesture);

  // Fit once the keyboard animation/viewport resize has settled; ResizeObserver
  // handles intermediate frames. Hidden sessions keep their last valid dimensions.
  useEffect(() => {
    if (!mobile || !active) return;
    let timer = 0;
    const fit = () => {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'hidden') return;
        try {
          if (elRef.current?.clientWidth && elRef.current.clientHeight) fitRef.current?.fit();
        } catch {
          /* hidden */
        }
      }, 100);
    };
    fit();
    window.visualViewport?.addEventListener('resize', fit);
    window.addEventListener('resize', fit);
    return () => { clearTimeout(timer); window.visualViewport?.removeEventListener('resize', fit); window.removeEventListener('resize', fit); };
  }, [mobile, active]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme.xterm;
    }
  }, [theme]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    try {
      if (elRef.current?.clientWidth && elRef.current.clientHeight) fitRef.current?.fit();
    } catch {
      /* */
    }
    if (pinchAwaitingCommit.current) {
      // xterm repaints at the new size in the animation frame it queued just now; our callback is
      // queued after it, so the preview transform disappears in the very same painted frame.
      const settle = pinchSettleRef.current;
      requestAnimationFrame(() => settle?.());
    }
  }, [fontSize]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.lineHeight = lineHeight;
    try {
      if (elRef.current?.clientWidth && elRef.current.clientHeight) fitRef.current?.fit();
    } catch {
      /* */
    }
  }, [lineHeight]);

  useEffect(() => {
    if (active && !mobile) termRef.current?.focus();
    if (active) { try { if (elRef.current?.clientWidth && elRef.current.clientHeight) fitRef.current?.fit(); } catch { /* hidden */ } }
  }, [active, mobile]);

  // Handle Ctrl+F / Cmd+F for search inside active terminal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
      // Only take the shortcut while focus is actually in this terminal.
      // Ctrl/Cmd+Shift+F belongs to the workspace's SFTP shortcut; inputs
      // elsewhere (including the SFTP editor) keep their own Find behavior.
      const target = e.target;
      if (!(target instanceof Node) || !elRef.current?.contains(target)) return;
      e.preventDefault();
      setShowSearch(true);
      setTimeout(() => searchInputRef.current?.select(), 0);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, mobile]);

  // Phones freeze JS timers along with the app, so the countdown above stalls
  // while backgrounded and only resumes after a return. When the tab becomes
  // visible again with a dropped, resumable link, retry now: re-arm to 1s and
  // let the existing countdown effect perform the connect, so a reconnect that
  // is already in flight (status 'connecting') can never be doubled up.
  // Deliberately scoped to 'disconnected' — never 'error' — so a wrong password
  // or an auth refusal can't be re-attempted (and hammer the server) every time
  // the user glances at the app. Local/serial panes report resumable: false and
  // are excluded for the same reason they have no retry path.
  useEffect(() => {
    if (isLocal || isSerial || status !== 'disconnected') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (sessionRef.current) return;
      setCountdown(1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [status, isLocal, isSerial]);

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

  // Keep the textarea's inputmode in step with the phone layout and with the keyboard
  // actually being up: once the system dismisses it, a later tap must not bring it back.
  useEffect(() => {
    const ta = termRef.current?.textarea;
    if (!ta) return;
    if (!mobile) { ta.inputMode = ''; return; }
    ta.inputMode = 'none';
    const root = document.documentElement;
    const observer = new MutationObserver((records) => {
      // Only a real open -> closed transition counts; the flag is rewritten on every viewport event.
      if (records.some((r) => r.oldValue === 'true') && root.dataset.keyboard !== 'true') ta.inputMode = 'none';
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-keyboard'], attributeOldValue: true });
    return () => observer.disconnect();
  }, [mobile]);

  // Phones: the Search key both shows the bar and raises the keyboard. Layout effect = still inside the
  // tap (iOS only opens the keyboard for focus() during a user gesture); keyed on the toggle, not on
  // mount, so the bar re-appearing after a drawer closes does not pop the keyboard again.
  useLayoutEffect(() => {
    if (mobile && showSearch) searchInputRef.current?.focus();
  }, [mobile, showSearch]);

  const searchAccent = theme.accent || '#22d3ee';
  const searchToggle = (on: boolean) => (on
    ? { backgroundColor: `${searchAccent}26`, color: searchAccent, borderColor: `${searchAccent}60` }
    : undefined);
  const searchControls = (
    <>
      <div className="nx-terminal-search-field flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5 shrink-0" style={{ color: searchAccent }} aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
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
          aria-label="Find in terminal"
          className="w-44 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors"
          style={{
            borderColor: searchQuery ? `${searchAccent}50` : undefined,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = `${searchAccent}70`;
            e.currentTarget.style.boxShadow = `0 0 0 2px ${searchAccent}20`;
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = searchQuery ? `${searchAccent}50` : 'rgba(255,255,255,0.1)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        />
      </div>
      <button
        type="button"
        onClick={() => performSearch(searchQuery, true)}
        onMouseDown={(e) => e.preventDefault()}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        className="nx-terminal-search-btn rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => performSearch(searchQuery, false)}
        onMouseDown={(e) => e.preventDefault()}
        title="Next match (Enter)"
        aria-label="Next match"
        className="nx-terminal-search-btn rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <div className="nx-terminal-search-sep h-3.5 w-[1px] bg-white/10" />
      <button
        type="button"
        onClick={() => setMatchCase(!matchCase)}
        onMouseDown={(e) => e.preventDefault()}
        title="Match Case"
        aria-label="Match case"
        aria-pressed={matchCase}
        style={searchToggle(matchCase)}
        className={cn(
          'nx-terminal-search-toggle rounded px-1.5 py-0.5 text-[10px] font-mono font-bold transition border border-transparent',
          matchCase ? '' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        )}
      >
        Aa
      </button>
      <button
        type="button"
        onClick={() => setMatchWholeWord(!matchWholeWord)}
        onMouseDown={(e) => e.preventDefault()}
        title="Match Whole Word"
        aria-label="Match whole word"
        aria-pressed={matchWholeWord}
        style={searchToggle(matchWholeWord)}
        className={cn(
          'nx-terminal-search-toggle rounded px-1.5 py-0.5 text-[10px] font-mono font-bold transition border border-transparent',
          matchWholeWord ? '' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        )}
      >
        \b
      </button>
      <button
        type="button"
        onClick={() => setMatchRegex(!matchRegex)}
        onMouseDown={(e) => e.preventDefault()}
        title="Use Regular Expression"
        aria-label="Use regular expression"
        aria-pressed={matchRegex}
        style={searchToggle(matchRegex)}
        className={cn(
          'nx-terminal-search-toggle rounded px-1.5 py-0.5 text-[10px] font-mono font-bold transition border border-transparent',
          matchRegex ? '' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        )}
      >
        .*
      </button>
      <button
        type="button"
        onClick={() => {
          setShowSearch(false);
          termRef.current?.focus();
        }}
        onMouseDown={(e) => e.preventDefault()}
        className="nx-terminal-search-btn nx-terminal-search-close rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
        title="Close (Esc)"
        aria-label="Close search"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </>
  );

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
        if (mobile) { e.preventDefault(); return; }
        if (termRef.current?.hasSelection()) return;
        e.preventDefault();
        try {
          const text = await bridge.readClipboard();
          if (text) {
            if (termRef.current) {
              termRef.current.paste(text);
            } else {
              const sid = sessionRef.current;
              if (sid) {
                if (isSerial) bridge.writeSerial(sid, text);
                else if (isLocal) bridge.writeLocalPty(sid, text);
                else bridge.write(sid, text);
                onData?.(text);
              }
            }
            bridge.addClipboardHistory(text, 'System Clipboard').catch(() => {});
          }
        } catch {
          // clipboard permission not granted
        }
      }}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden transition-all',
        mobileHidden && 'max-md:hidden',
        isSplit
          ? cn(
              'rounded-xl border',
              broadcast
                ? 'border-rose-500/50 shadow-[0_0_16px_rgba(244,63,94,0.3)]'
                : active
                ? 'border-white/15 shadow-[0_0_0_1px_rgba(34,211,238,0.15),0_10px_40px_-10px_rgba(34,211,238,0.25)]'
                : 'border-white/5'
            )
          : 'rounded-none border-0'
      )}
      style={{ background: theme.xterm.background }}
    >
      {showHeader && !mobile && (
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
          {broadcast && (
            <span className="flex items-center gap-1 rounded bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.2 text-[9px] font-bold text-rose-300 animate-pulse shrink-0">
              <Radio className="h-2.5 w-2.5" />
              BROADCAST
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1 truncate font-mono text-slate-500">
            <FolderOpen className="h-3 w-3 shrink-0" />
            {isSerial ? (pane.serialOptions?.portName ?? 'Serial') : cwd}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {!isSerial && onOpenDocker && (
              <button
                title="Inspect Docker containers on this host"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDocker();
                }}
                className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-white transition"
              >
                <Boxes className="h-3 w-3" />
              </button>
            )}
            <button
              title="Search buffer (⌘F / Ctrl+F)"
              onClick={() => {
                setShowSearch((v) => !v);
                if (!showSearch) setTimeout(() => searchInputRef.current?.select(), 50);
              }}
              className={cn(
                'rounded p-1 transition border border-transparent',
                showSearch ? '' : 'text-slate-500 hover:bg-white/5 hover:text-white'
              )}
              style={
                showSearch
                  ? {
                      backgroundColor: `${searchAccent}26`,
                      color: searchAccent,
                      borderColor: `${searchAccent}50`,
                    }
                  : undefined
              }
            >
              <Search className="h-3 w-3" />
            </button>
            <button
              title="Command History & Reverse Search (Ctrl+Shift+R)"
              onClick={() => setShowCmdSearch(true)}
              className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-emerald-300 transition"
            >
              <History className="h-3 w-3" />
            </button>
            <button
              title="Clipboard History (Ctrl+Shift+H / ⌘⇧H / ⌃⌥V)"
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
            {isSplit && (
              <button onClick={onClose} title="Close split pane" className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-rose-300">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Desktop: floating in-terminal search widget (top-right). Phones get the docked bar under the terminal. */}
      {showSearch && !mobile && (
        <div
          className={cn(
            'nx-terminal-search absolute right-3 z-30 flex items-center gap-1.5 rounded-xl border p-1.5 shadow-2xl backdrop-blur-xl overflow-hidden',
            showHeader ? 'top-10' : 'top-2'
          )}
          style={{
            backgroundColor: theme.xterm.background || '#0e131d',
            borderColor: `${searchAccent}35`,
            boxShadow: `0 12px 32px rgba(0,0,0,0.5), 0 0 16px ${searchAccent}15`,
            '--nx-accent': searchAccent,
          } as React.CSSProperties}
        >
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-10 opacity-20"
            style={{ background: `radial-gradient(ellipse at top, ${searchAccent} 0%, transparent 70%)` }}
          />
          {searchControls}
        </div>
      )}

      <div ref={containerRef} className={cn('relative min-h-0 flex-1 isolate z-0', showHeader ? 'px-2 pt-2' : 'max-md:px-1 max-md:py-1 px-3 py-1.5')}
        // A half-open drawer takes the bottom of the pane; the rows refit to what is left so the prompt stays in view.
        // Mirrors the drawer's settled min-height (min(320px, 70%)) so the terminal never runs under it.
        style={mobile && active && drawerInset > 0 ? { flex: `0 0 ${(1 - drawerInset) * 100}%`, maxHeight: 'max(calc(100% - 320px), 30%)' } : undefined}>
        <div ref={elRef} className="h-full w-full" />
        {mobile && active && (
          <TerminalSelection
            term={termInstance}
            host={containerRef.current}
            accent={theme.accent || '#22d3ee'}
            background={theme.xterm.background || '#0e131d'}
            menuAt={touchMenu}
            onCopy={async (text) => {
              try { await bridge.writeClipboard(text); toast('Copied'); }
              catch { toast('Clipboard access denied'); }
              bridge.addClipboardHistory(text, `Terminal (${isLocal ? 'Local' : host.label})`).catch(() => {});
            }}
            onPaste={async () => {
              setTouchMenu(null);
              try { const text = await bridge.readClipboard(); if (text) handlePasteClipboard(text); else toast('Clipboard is empty'); }
              catch { toast('Clipboard access denied — use your keyboard’s Paste action'); }
            }}
            onClips={() => { setTouchMenu(null); setShowClipboard(true); }}
          />
        )}
        {mobile && zoomHud && (
          <div className={cn('nx-zoom-hud', zoomHud.leaving && 'nx-zoom-hud-out')} role="status" aria-live="polite"
            style={{ background: theme.xterm.background || '#0e131d', '--nx-accent': theme.accent || '#22d3ee' } as React.CSSProperties}>
            <span className="nx-zoom-hud-glyph">Aa</span>
            <span className="nx-zoom-hud-size">{zoomHud.size}</span>
            <span className="nx-zoom-hud-unit">px</span>
          </div>
        )}

        {/* Real-time Inline Ghost Text Autosuggestion (Fish / Zsh / Copilot style) */}
        {suggestion && ghostPos && (
          <div
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              acceptSuggestion();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              e.stopPropagation();
              acceptSuggestion();
            }}
            style={{
              position: 'absolute',
              left: `${ghostPos.x}px`,
              top: `${ghostPos.y}px`,
              height: `${ghostPos.cellHeight}px`,
              lineHeight: `${ghostPos.cellHeight}px`,
              maxWidth: `calc(100% - ${ghostPos.x}px)`,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontFamily:
                '"JetBrainsMono Nerd Font", "JetBrains Mono Variable", "JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
              fontSize: `${fontSize}px`,
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: 20,
              whiteSpace: 'pre',
            }}
            className="select-none text-slate-400/50 hover:text-cyan-400/90 active:text-cyan-300 transition-colors"
            title="Tap to complete (or press Tab / →)"
          >
            {suggestion.suffix.replace(/ /g, '\u00A0')}
          </div>
        )}
      </div>
      {showSearch && mobile && active && drawerInset <= 0 && (
        <div
          className="nx-terminal-search nx-terminal-search-docked md:hidden"
          role="search"
          aria-label="Find in terminal"
          style={{ background: theme.xterm.background, '--nx-accent': theme.accent || '#22d3ee' } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 opacity-20" style={{ background: `radial-gradient(ellipse at top, ${theme.accent || '#22d3ee'} 0%, transparent 70%)` }} />
          {searchControls}
        </div>
      )}
      {mobile && active && drawerInset <= 0 && (() => {
        const accent = theme.accent || '#22d3ee';
        const sessionName = isSerial ? host.label : isLocal ? 'Local Terminal' : `${host.username}@${host.hostname}${host.port && host.port !== 22 ? `:${host.port}` : ''}`;
        const count = mobileBar?.sessionCount ?? 1;
        const pick = (fn?: () => void) => () => { setConnectMenu(false); fn?.(); };
        return (
          // Clicks must not bubble to the workspace, whose click handler closes the side panel
          // (that would undo the "back to hosts" navigation this bar triggers).
          <div className="nx-session-bar md:hidden" role="toolbar" aria-label="Session" onClick={e => e.stopPropagation()}>
            <button type="button" className="nx-bar-button" aria-label="Back to hosts" onClick={mobileBar?.onBack}><ChevronLeft size={22} /></button>
            <div className="nx-session-pill" style={{ borderColor: `${accent}45`, background: `${accent}12`, color: accent }}>
              <button type="button" className="nx-session-pill-main" aria-label={`Sessions · ${count} open`} onClick={mobileBar?.onOpenSessions}>
                <span className={cn('h-2 w-2 shrink-0 rounded-full', statusColor, status === 'connecting' && 'animate-pulse')} />
                <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">{sessionName}</span>
                {count > 1 && <span className="nx-session-count" style={{ background: `${accent}22`, color: accent }}>{count}</span>}
              </button>
              <button type="button" className="nx-session-pill-close" aria-label="Close session" onClick={onClose}><X size={17} /></button>
            </div>
            <div className="relative shrink-0">
              <button type="button" className="nx-bar-button" aria-label="New connection" aria-haspopup="menu" aria-expanded={connectMenu} onClick={() => setConnectMenu(v => !v)}><Plus size={22} /></button>
              {connectMenu && (
                <>
                  <div className="fixed inset-0 z-50" onClick={() => setConnectMenu(false)} />
                  <div role="menu" aria-label="New connection" className="nx-connect-menu" onKeyDown={e => { if (e.key === 'Escape') setConnectMenu(false); }}>
                    <button type="button" role="menuitem" onClick={pick(mobileBar?.onConnectHost)}><Server size={18} style={{ color: accent }} /> Connect to host</button>
                    <button type="button" role="menuitem" onClick={pick(mobileBar?.onLocalTerminal)}><TerminalIcon size={18} style={{ color: accent }} /> Local terminal</button>
                    <button type="button" role="menuitem" onClick={pick(mobileBar?.onSftp)}><HardDrive size={18} style={{ color: accent }} /> Connect via SFTP</button>
                    <button type="button" role="menuitem" onClick={pick(mobileBar?.onSerial)}><Unplug size={18} style={{ color: accent }} /> Connect via Serial</button>
                  </div>
                </>
              )}
            </div>
            {/* Both rendered; CSS picks one from the keyboard state so no extra listeners are needed. */}
            <button type="button" className="nx-bar-button nx-kbd-show" aria-label="Show terminal keyboard" onClick={showKeyboard}><Keyboard size={20} /></button>
            <button type="button" className="nx-bar-button nx-kbd-hide" aria-label="Hide terminal keyboard" onMouseDown={e => e.preventDefault()} onClick={hideKeyboard}><KeyboardOff size={20} /></button>
          </div>
        );
      })()}
      {mobile && active && drawerInset <= 0 && mobileBar && <TerminalAccessory modifiers={modifiers} onModifier={toggleModifier} theme={theme}
        hasSuggestion={!!suggestion}
        tools={{ onKeypad: mobileBar.onKeypad, onSearch: () => setShowSearch(v => !v), onHistory: mobileBar.onHistory, onAssistant: mobileBar.onAssistant, onSnippets: mobileBar.onSnippets }}
        onKey={sendAccessoryKey} />}


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
          <div
            className="relative w-full max-w-md rounded-2xl border border-white/10 p-6 shadow-2xl backdrop-blur-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
            style={{
              background: theme.xterm.background || '#0e131d',
              boxShadow: '0 0 40px rgba(245, 158, 11, 0.2), 0 20px 50px rgba(0, 0, 0, 0.8)',
            }}
          >
            {/* Top ambient radial glow */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-30"
              style={{ background: 'radial-gradient(ellipse at top, #f59e0b 0%, transparent 70%)' }}
            />
            {/* Glowing top line */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-80"
              style={{ background: 'linear-gradient(90deg, transparent, #f59e0b, transparent)' }}
            />

            <div className="relative flex flex-col items-center text-center">
              <div
                className="grid h-12 w-12 place-items-center rounded-2xl border shadow-lg"
                style={{
                  backgroundColor: 'rgba(245, 158, 11, 0.15)',
                  borderColor: 'rgba(245, 158, 11, 0.4)',
                  color: '#f59e0b',
                  boxShadow: '0 0 24px rgba(245, 158, 11, 0.3)',
                }}
              >
                <ShieldAlert className="h-6 w-6" />
              </div>

              <h3 className="mt-4 text-base font-bold text-white tracking-tight">Verify Host Identity</h3>
              <p className="mt-1 text-xs text-slate-400 max-w-sm">
                First connection to <span className="font-semibold text-slate-200 font-mono">{host.hostname}:{host.port}</span>.
                Compare this cryptographic fingerprint before trusting the host key.
              </p>

              <div className="mt-4 w-full rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-3 text-left">
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400/90 mb-1 flex items-center gap-1.5">
                  <KeyRound className="h-3 w-3" />
                  <span>SHA-256 Fingerprint (Trust On First Use)</span>
                </div>
                <code className="block break-all font-mono text-xs font-semibold text-amber-200 select-all bg-black/40 p-2 rounded-lg border border-amber-400/20">
                  SHA256:{fingerprint}
                </code>
              </div>

              <div className="mt-6 flex w-full items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await bridge.trustHostKey(host, fingerprint ?? '');
                    connect(false);
                  }}
                  className="flex items-center gap-1.5 rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg cursor-pointer"
                  style={{
                    backgroundColor: '#f59e0b',
                    color: '#000000',
                    boxShadow: '0 0 20px rgba(245, 158, 11, 0.35)',
                  }}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Trust & connect
                </button>
              </div>
            </div>
          </div>
        </Overlay>
      )}

      {status === 'error' && (
        <Overlay>
          <div
            className="relative w-full max-w-sm rounded-2xl border border-rose-500/20 p-6 shadow-2xl backdrop-blur-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
            style={{
              background: theme.xterm.background || '#0e131d',
              boxShadow: '0 0 40px rgba(244, 63, 94, 0.2), 0 20px 50px rgba(0, 0, 0, 0.8)',
            }}
          >
            {/* Top ambient radial glow */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-36 opacity-30"
              style={{ background: 'radial-gradient(ellipse at top, #f43f5e 0%, transparent 70%)' }}
            />
            {/* Glowing top line */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px] opacity-80"
              style={{ background: 'linear-gradient(90deg, transparent, #f43f5e, transparent)' }}
            />

            <div className="relative flex flex-col items-center text-center">
              <div
                className="grid h-12 w-12 place-items-center rounded-2xl border shadow-lg"
                style={{
                  backgroundColor: 'rgba(244, 63, 94, 0.15)',
                  borderColor: 'rgba(244, 63, 94, 0.4)',
                  color: '#f43f5e',
                  boxShadow: '0 0 24px rgba(244, 63, 94, 0.3)',
                }}
              >
                <WifiOff className="h-6 w-6" />
              </div>

              <h3 className="mt-4 text-base font-bold text-white tracking-tight">Connection Failed</h3>
              <p className="mt-2 w-full break-all rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 font-mono text-xs text-rose-300">
                {error}
              </p>

              <div className="mt-6 flex w-full items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white transition cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => connect(false)}
                  className="flex items-center gap-1.5 rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg cursor-pointer bg-white/10 text-white hover:bg-white/15"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Retry
                </button>
              </div>
            </div>
          </div>
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


      {/* Ctrl+Shift+R Command Search Modal */}
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
              id: safeUid(),
              name: cmd.slice(0, 32),
              command: cmd,
              tags: [isLocal ? 'local' : host.label],
            }).then(() => toast('Saved to snippets')).catch(() => {});
          }}
          toast={toast}
          theme={theme}
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
          theme={theme}
        />
      )}
    </div>
  );
});

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6 backdrop-blur-md cursor-default select-none pointer-events-auto"
    >
      {children}
    </div>
  );
}
