/** Streaming client for any Ollama-compatible endpoint (Ollama, LM Studio, llama.cpp server). */

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; }

export const DEFAULT_ENDPOINT = 'http://localhost:11434';

export async function listModels(endpoint: string): Promise<string[]> {
  const r = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.models ?? []).map((m: { name: string }) => m.name);
}

export async function chatStream(endpoint: string, model: string, messages: ChatMsg[], onToken: (t: string) => void, signal?: AbortSignal) {
  const r = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0.2 } }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.message?.content) onToken(j.message.content);
        if (j.error) throw new Error(j.error);
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
  }
}

export const SYSTEM_PROMPT = `You are Nexus, a senior SRE assistant embedded inside an SSH terminal client.
Rules:
- Be concise. Prefer bullet points.
- When suggesting commands, put each runnable command in its own \`\`\`bash fenced block.
- Never suggest destructive commands without a clear warning line starting with "⚠️".
- Prefer safe, read-only diagnostics first. Quote paths. Use set -euo pipefail for scripts.
- You are given the recent terminal output and the current working directory as context.`;

// ── Risk classifier: commands from the AI are NEVER auto-executed ──
export type Risk = { level: 'safe' | 'caution' | 'danger'; reasons: string[] };
const DANGER: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, 'recursive force delete'],
  [/\bmkfs(\.\w+)?\b/, 'formats a filesystem'],
  [/\bdd\s+.*of=\/dev\//, 'raw write to block device'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bchmod\s+(-R\s+)?777\b/, 'world-writable permissions'],
  [/>\s*\/dev\/sd[a-z]/, 'overwrites a disk'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, 'stops the machine'],
  [/curl[^|]*\|\s*(sudo\s+)?(ba)?sh/, 'pipes remote script to shell'],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, 'drops database objects'],
];
const CAUTION: [RegExp, string][] = [
  [/\bsudo\b/, 'elevated privileges'],
  [/\brm\b/, 'deletes files'],
  [/\b(systemctl|service)\s+(stop|restart|disable)/, 'changes service state'],
  [/\bkill(all)?\b/, 'terminates processes'],
  [/\b(apt|yum|dnf|pacman)\b.*\b(remove|purge|upgrade)\b/, 'modifies packages'],
  [/\bgit\s+(push\s+.*--force|reset\s+--hard)/, 'rewrites git history'],
  [/\bdocker\s+(rm|rmi|system\s+prune)/, 'removes containers/images'],
];
export function classifyRisk(cmd: string): Risk {
  const d = DANGER.filter(([r]) => r.test(cmd)).map(([, s]) => s);
  if (d.length) return { level: 'danger', reasons: d };
  const c = CAUTION.filter(([r]) => r.test(cmd)).map(([, s]) => s);
  if (c.length) return { level: 'caution', reasons: c };
  return { level: 'safe', reasons: [] };
}

// ── Offline fallback so the panel is useful even without a local model ──
const EXPLAIN: Record<string, string> = {
  ls: 'lists directory contents', cd: 'changes the working directory', grep: 'filters lines matching a pattern', tail: 'prints the last lines of a file',
  head: 'prints the first lines of a file', du: 'estimates disk usage', df: 'reports filesystem free space', sort: 'sorts lines', docker: 'manages containers',
  systemctl: 'controls systemd services', free: 'shows memory usage', ps: 'lists processes', ss: 'dumps socket statistics', find: 'searches for files', awk: 'pattern-scanning text processor',
  sed: 'stream editor for transforming text', xargs: 'builds commands from stdin', chmod: 'changes file permissions', chown: 'changes file owner', tar: 'archives files', journalctl: 'queries the systemd journal',
};

export function offlineAnswer(prompt: string, context: string): string {
  const lower = prompt.toLowerCase();
  if (/error|fail|troubleshoot|why|refused/.test(lower) || /refused|failed|error/i.test(context.slice(-1500))) {
    const refused = /connection refused|connect\(\) failed/i.test(context);
    const ssl = /SSL_do_handshake|wrong version number/i.test(context);
    const restarting = /Restarting \(1\)/.test(context);
    const lines = ['**Offline heuristic analysis** (connect a local model for deeper reasoning):', ''];
    if (refused) lines.push('- Upstream on `127.0.0.1:8080` is refusing connections → the app process is down or not listening.');
    if (restarting) lines.push('- The API container is in a restart loop (exit code 1).');
    if (ssl) lines.push('- `wrong version number` usually means plain HTTP is being sent to an HTTPS port (or vice-versa).');
    if (!refused && !ssl && !restarting) lines.push('- No well-known failure signature found in the last output. Try sharing the full error line.');
    lines.push('', 'Safe next steps:', '```bash\ndocker ps\n```', '```bash\nsystemctl status api\n```', '```bash\ntail -n 50 /var/log/nginx/error.log | grep -i error\n```');
    return lines.join('\n');
  }
  const cmd = prompt.replace(/^explain\s*:?\s*/i, '').trim();
  const parts = cmd.split('|').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
  if (parts.length && parts.some((p) => EXPLAIN[p])) {
    return ['**Offline breakdown:**', '', ...parts.map((p, i) => `${i + 1}. \`${p}\` — ${EXPLAIN[p] ?? 'custom command'}`), '', 'Risk: **' + classifyRisk(cmd).level + '**'].join('\n');
  }
  return "I can't reach a local model right now. Start Ollama with:\n```bash\nOLLAMA_ORIGINS=* ollama serve\n```\nthen pull a model, e.g. `ollama pull qwen2.5-coder:7b`, and press the refresh button. Meanwhile I can still give offline explanations of common commands and spot known error signatures.";
}
