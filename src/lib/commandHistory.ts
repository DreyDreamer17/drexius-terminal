import type { CommandHistoryItem } from './types';

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

export const COMMON_SHELL_COMMANDS = [
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

const SENSITIVE_COMMAND_KEYWORDS = [
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'token',
  'secret',
  'api_key',
  'apikey',
  'api-key',
  'private_key',
  'credential',
  'bearer ',
  'authorization:',
  'aws_secret_access_key',
  'ghp_',
  'github_pat_',
  'xoxb-',
  'xoxp-',
];

/**
 * Mirrors Rust `vault::history::looks_sensitive_command` on the frontend so secret-bearing
 * commands never enter in-memory ghost caches or browser fallback history.
 */
export function looksSensitiveCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  if (lower.includes('-----begin') && lower.includes('private key')) {
    return true;
  }
  return SENSITIVE_COMMAND_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Normalizes Unix timestamps stored in either seconds (Rust SQLite) or milliseconds (JS Date.now).
 */
export function normalizeHistoryTimestampMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

/**
 * Normalizes a working directory path for equality comparisons across hosts/sessions.
 */
export function normalizeHistoryCwd(cwd?: string | null): string {
  if (!cwd) return '';
  let out = cwd.trim().replace(/\\/g, '/');
  if (out.length > 1) {
    out = out.replace(/\/+$/, '');
  }
  return out;
}

export interface BracketedPasteExtractResult {
  /** True if this chunk started, continued, or ended a bracketed paste sequence. */
  handled: boolean;
  /** Unwrapped pasted text with `\x1b[200~` and `\x1b[201~` control wrappers removed. */
  text: string;
  /** Updated in-paste state to carry into the next `onData` chunk. */
  inPaste: boolean;
}

/**
 * Unwraps xterm.js Bracketed Paste (`\x1b[200~ ... \x1b[201~`) payloads across single or
 * multi-chunk `term.onData` callbacks so pasted commands are tracked and recorded just like
 * typed commands instead of being discarded by generic `\x1b` escape-sequence handling.
 */
export function extractBracketedPastePayload(
  data: string,
  wasInPaste: boolean,
): BracketedPasteExtractResult {
  if (!wasInPaste && !data.includes(BRACKETED_PASTE_START)) {
    return { handled: false, text: '', inPaste: false };
  }

  let inPaste = wasInPaste;
  let pos = 0;
  let out = '';

  while (pos < data.length) {
    if (!inPaste) {
      const startIdx = data.indexOf(BRACKETED_PASTE_START, pos);
      if (startIdx === -1) {
        // Trailing non-paste bytes after a completed paste (e.g. a trailing Enter)
        out += data.slice(pos);
        break;
      }
      if (startIdx > pos) {
        out += data.slice(pos, startIdx);
      }
      inPaste = true;
      pos = startIdx + BRACKETED_PASTE_START.length;
    } else {
      const endIdx = data.indexOf(BRACKETED_PASTE_END, pos);
      if (endIdx === -1) {
        const chunk = data.slice(pos);
        // Ctrl+C cancels an interrupted paste stream so state cannot wedge
        if (chunk.includes('\x03')) {
          inPaste = false;
        }
        out += chunk;
        break;
      }
      out += data.slice(pos, endIdx);
      inPaste = false;
      pos = endIdx + BRACKETED_PASTE_END.length;
    }
  }

  return { handled: true, text: out, inPaste };
}

/**
 * Strips a recognised shell prompt from the start of a logical terminal line; returns `null`
 * if no known prompt prefix matched.
 */
export function stripShellPrompt(line: string): string | null {
  // 1. user@host:path[$#%>] (standard Linux, macOS, bash, zsh)
  const userHost = line.match(/^(?:(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-]+@[a-zA-Z0-9_.\-]+[^$#%>]*[$#%>]\s+)(.*)$/);
  if (userHost && userHost[1] !== undefined) return userHost[1];

  // 2. Bracketed prompt: [user@host path]$ or (venv) [user@host path]#
  const bracketed = line.match(/^(?:(?:\([^)]+\)\s*)?\[[^\]]+\][$#%>]\s+)(.*)$/);
  if (bracketed && bracketed[1] !== undefined) return bracketed[1];

  // 3. PowerShell prompt: "PS C:\Users\name> " or "PS /home/user> "
  const powershell = line.match(/^PS\s+[^>]+>\s*(.*)$/);
  if (powershell && powershell[1] !== undefined) return powershell[1];

  // 4. Modern prompt glyphs: ❯, ➜, λ, », › (Starship, Pure, Oh-My-Zsh, Fish)
  const glyph = line.match(/^.*?[❯➜λ»›]\s*(.*)$/);
  if (glyph && glyph[1] !== undefined) return glyph[1];

  // 5. Box-drawing multiline prompt endings: "└─$ ", "╰─> ", "└─) ", "┗━# "
  const boxPrompt = line.match(/^[└╰┗├├─━─\s]+[$#%>)»]\s+(.*)$/);
  if (boxPrompt && boxPrompt[1] !== undefined) return boxPrompt[1];

  // 6. Secondary continuation prompt (PS2): "> command"
  const ps2 = line.match(/^>\s+(.*)$/);
  if (ps2 && ps2[1] !== undefined) return ps2[1];

  // 7. Simple prompt: "$ ", "# ", "% " at prompt start (without matching spaces in command body)
  const simple = line.match(/^(?:(?:\([^)]+\)\s*)?[a-zA-Z0-9_.\-~/:*]*?[$#%]\s+)(.*)$/);
  if (simple && simple[1] !== undefined) return simple[1];

  return null;
}

/**
 * Extracts the next word/path segment from a ghost suggestion suffix for word-wise partial
 * accept (`Ctrl+ArrowRight`).
 *
 * Examples:
 * - `" compose up -d"` -> `" compose"`
 * - `"cker compose up"` -> `"cker"`
 * - `"/log/nginx/error.log"` -> `"/log"`
 */
export function extractNextSuggestionWord(suffix: string): string {
  if (!suffix) return '';
  const match = suffix.match(/^\s*(?:\/[^\s/]*|[^\s/]+|\/)/);
  return match ? match[0] : suffix;
}

export interface GhostRankContext {
  hostId?: string | null;
  cwd?: string | null;
  nowMs?: number;
}

export interface GhostSuggestionMatch {
  full: string;
  suffix: string;
  source: 'history' | 'builtin';
}

/**
 * Selects the best inline ghost suggestion for `prefix` using context-aware frecency ranking:
 *   Tier 4 (4000): same host + same normalized CWD
 *   Tier 3 (3000): same host
 *   Tier 2 (2000): starred / bookmarked on another host
 *   Tier 1 (1000): global history across other hosts
 *   Fallback:      built-in `COMMON_SHELL_COMMANDS`
 *
 * Within each tier, candidates are ranked by recency decay + frequency (`runCount`),
 * with a small tie-breaker for exact-case prefix match.
 */
export function rankGhostSuggestion(
  prefix: string,
  entries: readonly CommandHistoryItem[],
  context: GhostRankContext = {},
  fallbackCommands: readonly string[] = COMMON_SHELL_COMMANDS,
): GhostSuggestionMatch | null {
  if (!prefix || prefix.trim().length < 2) return null;

  const prefixLower = prefix.toLowerCase();
  const targetHost = context.hostId ?? null;
  const targetCwd = normalizeHistoryCwd(context.cwd);
  const nowMs = context.nowMs ?? Date.now();

  let bestCmd: string | null = null;
  let bestScore = -1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const cmd = entry.command;
    if (!cmd || cmd.length <= prefix.length) continue;
    if (!cmd.toLowerCase().startsWith(prefixLower)) continue;

    const entryHost = entry.hostId ?? null;
    const sameHost = entryHost === targetHost;
    const entryCwd = normalizeHistoryCwd(entry.cwd);
    const sameCwd = sameHost && targetCwd.length > 0 && entryCwd === targetCwd;

    let tierScore: number;
    if (sameCwd) {
      tierScore = 4000;
    } else if (sameHost) {
      tierScore = 3000;
    } else if (entry.starred) {
      tierScore = 2000;
    } else {
      tierScore = 1000;
    }

    const executedMs = normalizeHistoryTimestampMs(entry.executedAt);
    const ageMs = Math.max(0, nowMs - executedMs);
    const ageHours = ageMs / 3_600_000;
    // 24h half-life recency (0..120) + immediate-session boost (+40 within 10 min)
    const recencyScore = 120 / (1 + ageHours / 24) + (ageMs <= 600_000 ? 40 : 0);
    // Log-scaled frequency boost (0..60)
    const runs = Math.max(1, entry.runCount ?? 1);
    const freqScore = Math.min(60, Math.log2(runs) * 15);
    // Starred boost within same-host tiers
    const starBoost = sameHost && entry.starred ? 40 : 0;
    // Exact-case prefix match tie-breaker
    const caseBoost = cmd.startsWith(prefix) ? 5 : 0;

    const score = tierScore + recencyScore + freqScore + starBoost + caseBoost;
    if (score > bestScore) {
      bestScore = score;
      bestCmd = cmd;
    }
  }

  if (bestCmd) {
    return {
      full: bestCmd,
      suffix: bestCmd.slice(prefix.length),
      source: 'history',
    };
  }

  // Fallback to built-in common commands (prefer exact-case prefix match if available)
  let fallbackCaseFold: string | null = null;
  for (let i = 0; i < fallbackCommands.length; i++) {
    const cmd = fallbackCommands[i];
    if (cmd.length <= prefix.length) continue;
    if (cmd.startsWith(prefix)) {
      return { full: cmd, suffix: cmd.slice(prefix.length), source: 'builtin' };
    }
    if (!fallbackCaseFold && cmd.toLowerCase().startsWith(prefixLower)) {
      fallbackCaseFold = cmd;
    }
  }

  if (fallbackCaseFold) {
    return {
      full: fallbackCaseFold,
      suffix: fallbackCaseFold.slice(prefix.length),
      source: 'builtin',
    };
  }

  return null;
}

const MAX_STORE_UNSTARRED = 1000;

function trimStoreEntries(items: CommandHistoryItem[]): CommandHistoryItem[] {
  let unstarredCount = 0;
  const result: CommandHistoryItem[] = [];
  for (const item of items) {
    if (item.starred) {
      result.push(item);
    } else if (unstarredCount < MAX_STORE_UNSTARRED) {
      unstarredCount++;
      result.push(item);
    }
  }
  return result;
}

export type HistoryStoreListener = () => void;

/**
 * Shared in-memory command history store synced across all open terminal panes,
 * `CommandSearchModal`, and `LogsPanel`.
 */
export class CommandHistoryStore {
  private entries: CommandHistoryItem[] = [];
  private listeners = new Set<HistoryStoreListener>();
  private hydrated = false;
  private inflightHydration: Promise<CommandHistoryItem[]> | null = null;

  getEntries(): readonly CommandHistoryItem[] {
    return this.entries;
  }

  isHydrated(): boolean {
    return this.hydrated;
  }

  subscribe(listener: HistoryStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* listener errors must not break other subscribers */
      }
    }
  }

  async hydrate(
    loader: (limit: number) => Promise<CommandHistoryItem[]>,
    force = false,
  ): Promise<readonly CommandHistoryItem[]> {
    if (this.hydrated && !force) return this.entries;
    if (this.inflightHydration && !force) {
      await this.inflightHydration;
      return this.entries;
    }

    const req = loader(500)
      .then((items) => {
        const deduped: CommandHistoryItem[] = [];
        const seen = new Set<string>();
        for (const raw of items) {
          const cmd = (raw.command || '').trim();
          if (!cmd || looksSensitiveCommand(cmd)) continue;
          const key = `${raw.hostId ?? ''}\0${cmd}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push({
            ...raw,
            command: cmd,
            runCount: Math.max(1, raw.runCount ?? 1),
          });
        }
        this.entries = trimStoreEntries(deduped);
        this.hydrated = true;
        this.emit();
        return this.entries;
      })
      .finally(() => {
        if (this.inflightHydration === req) {
          this.inflightHydration = null;
        }
      });

    this.inflightHydration = req;
    try {
      await req;
    } catch {
      /* ignore hydration errors when vault is locked */
    }
    return this.entries;
  }

  /**
   * Optimistically inserts or bumps a recorded command across all subscribed panes.
   */
  record(input: {
    id?: string;
    hostId?: string | null;
    hostLabel: string;
    command: string;
    cwd?: string | null;
    executedAt?: number;
    starred?: boolean;
    runCount?: number;
  }): CommandHistoryItem | null {
    const trimmed = input.command.trim();
    if (!trimmed || looksSensitiveCommand(trimmed)) return null;

    const hostId = input.hostId ?? null;
    const executedAt = input.executedAt ?? Date.now();
    const idx = this.entries.findIndex(
      (e) => (e.hostId ?? null) === hostId && e.command === trimmed,
    );

    let nextItem: CommandHistoryItem;
    const nextList = [...this.entries];

    if (idx !== -1) {
      const prev = nextList[idx];
      nextList.splice(idx, 1);
      nextItem = {
        ...prev,
        id: input.id ?? prev.id,
        hostLabel: input.hostLabel || prev.hostLabel,
        cwd: input.cwd ?? prev.cwd,
        executedAt,
        starred: input.starred ?? prev.starred,
        runCount: input.runCount ?? Math.max(1, prev.runCount ?? 1) + 1,
      };
    } else {
      nextItem = {
        id: input.id ?? `tmp-${executedAt}-${Math.random().toString(36).slice(2, 8)}`,
        hostId,
        hostLabel: input.hostLabel,
        command: trimmed,
        cwd: input.cwd ?? null,
        executedAt,
        starred: input.starred ?? false,
        runCount: input.runCount ?? 1,
      };
    }

    nextList.unshift(nextItem);
    this.entries = trimStoreEntries(nextList);
    this.emit();
    return nextItem;
  }

  /**
   * Reconciles an optimistic entry with the canonical persisted item returned by the backend.
   */
  reconcile(saved: CommandHistoryItem): void {
    const hostId = saved.hostId ?? null;
    const idx = this.entries.findIndex(
      (e) => e.id === saved.id || ((e.hostId ?? null) === hostId && e.command === saved.command),
    );
    const nextList = [...this.entries];
    if (idx !== -1) {
      nextList[idx] = {
        ...saved,
        runCount: Math.max(1, saved.runCount ?? nextList[idx].runCount ?? 1),
      };
    } else {
      nextList.unshift({ ...saved, runCount: Math.max(1, saved.runCount ?? 1) });
    }
    this.entries = trimStoreEntries(nextList);
    this.emit();
  }

  setStarred(id: string, starred: boolean): void {
    let changed = false;
    const nextList = this.entries.map((item) => {
      if (item.id === id) {
        changed = true;
        return { ...item, starred };
      }
      return item;
    });
    if (changed) {
      this.entries = nextList;
      this.emit();
    }
  }

  remove(id: string): void {
    const nextList = this.entries.filter((item) => item.id !== id);
    if (nextList.length !== this.entries.length) {
      this.entries = nextList;
      this.emit();
    }
  }

  clearUnstarred(): void {
    const nextList = this.entries.filter((item) => item.starred);
    if (nextList.length !== this.entries.length) {
      this.entries = nextList;
      this.emit();
    }
  }

  reset(): void {
    this.entries = [];
    this.hydrated = false;
    this.inflightHydration = null;
    this.emit();
  }
}

export const commandHistoryStore = new CommandHistoryStore();
