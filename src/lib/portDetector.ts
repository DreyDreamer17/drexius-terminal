/**
 * Streaming terminal output detector for listening ports on remote SSH sessions.
 *
 * Strips ANSI CSI/OSC escape sequences (e.g. Vite's bold port formatting
 * `\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m`), buffers across chunk
 * boundaries, ignores connection errors (`ECONNREFUSED`, `EADDRINUSE`, etc.),
 * and extracts actionable local port-forward candidates.
 */

export interface DetectedPort {
  port: number;
  protocol: 'http' | 'https' | 'tcp';
  sourceText: string;
}

// Matches CSI (\x1b[...X), OSC (\x1b]...BEL/ST), and two-byte ESC sequences.
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

const ERROR_LINE_RE =
  /\b(?:econnrefused|eaddrinuse|connection\s+refused|address\s+already\s+in\s+use|failed\s+to\s+connect|cannot\s+connect|unable\s+to\s+connect|timed?\s*out|permission\s+denied|bind\s+failed|error\s+listen)\b/i;

// 1. Explicit loopback/wildcard URLs: http://localhost:5173/, http://127.0.0.1:8000, http://0.0.0.0:3000, http://[::1]:8080
const LOOPBACK_URL_RE =
  /\b(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(?:\/[^\s"')\],;]*)?/gi;

// 2. Explicit server listening announcements:
//    "Listening on port 3000", "Listening on 0.0.0.0:8080", "Serving HTTP on 0.0.0.0 port 8000",
//    "Server running at :4000", "Accepting connections on :5000"
const LISTEN_ANNOUNCE_RE =
  /\b(?:listening\s+(?:on|at)|running\s+(?:on|at)|serving(?:\s+http\w*)?\s+(?:on|at)|started\s+(?:server\s+)?(?:on|at)|accepting\s+connections\s+(?:on|at)|bound\s+to)\s+(?:(https?):\/\/)?(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\*|\[::1?\])\s*)?(?:port\s+|:\s*)(\d{2,5})\b/gi;

function isLikelyHttpPort(port: number, line: string): boolean {
  if (/\bhttps?\b/i.test(line)) return true;
  if (
    port === 80 ||
    (port >= 3000 && port <= 3999) ||
    (port >= 4000 && port <= 4999) ||
    (port >= 5000 && port <= 5999) ||
    (port >= 7000 && port <= 9999)
  ) {
    return true;
  }
  return false;
}

function isValidCandidatePort(port: number, ignorePorts?: ReadonlySet<number>): boolean {
  if (!Number.isInteger(port) || port < 80 || port > 65535) return false;
  if (port === 8022) return false; // Termux default SSH port
  if (ignorePorts?.has(port)) return false;
  return true;
}

/**
 * Inspects a single line (or chunk) of terminal output and returns any newly
 * announced listening ports.
 */
export function detectPortsInLine(
  rawLine: string,
  ignorePorts?: ReadonlySet<number>
): DetectedPort[] {
  const clean = stripAnsi(rawLine).replace(/\r/g, '').trim();
  if (!clean || clean.length > 600) return [];
  if (ERROR_LINE_RE.test(clean)) return [];

  const found = new Map<number, DetectedPort>();

  LOOPBACK_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOOPBACK_URL_RE.exec(clean)) !== null) {
    const scheme = m[1].toLowerCase() === 'https' ? 'https' : 'http';
    const port = parseInt(m[2], 10);
    if (!isValidCandidatePort(port, ignorePorts)) continue;
    found.set(port, {
      port,
      protocol: scheme,
      sourceText: m[0],
    });
  }

  LISTEN_ANNOUNCE_RE.lastIndex = 0;
  while ((m = LISTEN_ANNOUNCE_RE.exec(clean)) !== null) {
    const schemeHint = m[1]?.toLowerCase();
    const port = parseInt(m[2], 10);
    if (!isValidCandidatePort(port, ignorePorts)) continue;
    if (found.has(port)) continue;
    const protocol: 'http' | 'https' | 'tcp' =
      schemeHint === 'https' || port === 443 || port === 8443
        ? 'https'
        : schemeHint === 'http' || isLikelyHttpPort(port, clean)
        ? 'http'
        : 'tcp';
    found.set(port, {
      port,
      protocol,
      sourceText: m[0].trim(),
    });
  }

  return Array.from(found.values());
}

/**
 * Stateful streaming detector that handles chunks split mid-line or mid-ANSI sequence.
 */
export class PortStreamDetector {
  private tail = '';
  private seenPorts = new Set<number>();
  private ignorePorts: Set<number>;
  private decoder = new TextDecoder('utf-8', { fatal: false });

  constructor(ignorePorts: Iterable<number> = []) {
    this.ignorePorts = new Set(ignorePorts);
  }

  public ignorePort(port: number): void {
    this.ignorePorts.add(port);
  }

  public unignorePort(port: number): void {
    this.ignorePorts.delete(port);
    this.seenPorts.delete(port);
  }

  public reset(): void {
    this.tail = '';
    this.seenPorts.clear();
    this.decoder = new TextDecoder('utf-8', { fatal: false });
  }

  public feed(chunk: string | Uint8Array): DetectedPort[] {
    const text =
      typeof chunk === 'string'
        ? chunk
        : chunk.byteLength > 0
        ? this.decoder.decode(chunk, { stream: true })
        : '';
    if (!text) return [];
    const combined = this.tail + text;
    const lines = combined.split('\n');
    // Keep the last unfinished segment in `tail` (capped to avoid unbounded growth on binary output)
    const last = lines.pop() ?? '';
    this.tail = last.length > 512 ? last.slice(-512) : last;

    const results: DetectedPort[] = [];
    for (const line of lines) {
      const matches = detectPortsInLine(line, this.ignorePorts);
      for (const item of matches) {
        if (!this.seenPorts.has(item.port)) {
          this.seenPorts.add(item.port);
          results.push(item);
        }
      }
    }

    return results;
  }
}
