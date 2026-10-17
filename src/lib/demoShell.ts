/**
 * Browser-preview sandbox: a small POSIX-ish shell over a virtual filesystem.
 * Used ONLY when DrexiusTerminal runs outside the Tauri runtime (no raw sockets
 * in a browser). It speaks the same event protocol as the Rust backend —
 * including OSC-7 cwd reporting — so every UI feature is exercised identically.
 */
import type { FileEntry, Host } from './types';

type FNode =
  | { type: 'dir'; children: Record<string, FNode>; mtime: number; mode: number }
  | { type: 'file'; content: string; mtime: number; mode: number };

const now = () => Math.floor(Date.now() / 1000);
const dir = (children: Record<string, FNode> = {}): FNode => ({ type: 'dir', children, mtime: now() - Math.floor(Math.random() * 900000), mode: 0o755 });
const file = (content: string, mode = 0o644): FNode => ({ type: 'file', content, mtime: now() - Math.floor(Math.random() * 900000), mode });

const NGINX_ERR = `2026/01/14 09:12:01 [error] 2214#2214: *881 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.4.17, server: api.example.com, request: "GET /v1/health HTTP/1.1", upstream: "http://127.0.0.1:8080/v1/health"
2026/01/14 09:12:03 [error] 2214#2214: *884 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.4.22, server: api.example.com, request: "POST /v1/orders HTTP/1.1", upstream: "http://127.0.0.1:8080/v1/orders"
2026/01/14 09:12:09 [crit] 2214#2214: *890 SSL_do_handshake() failed (SSL: error:0A00010B:SSL routines::wrong version number) while SSL handshaking
2026/01/14 09:13:44 [warn] 2214#2214: *902 upstream server temporarily disabled while connecting to upstream`;

function buildFs(host: Host): FNode {
  const user = host.username || 'user';
  const home = user === 'root' ? null : user;
  const homeDir = dir({
    '.bashrc': file('# ~/.bashrc\nexport PS1="\\u@\\h:\\w\\$ "\nalias ll="ls -la"\n'),
    '.ssh': dir({ authorized_keys: file('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDrexiusDemoKey drexius@laptop\n', 0o600) }),
    'README.md': file(`# Welcome to ${host.label}\n\nThis is the DrexiusTerminal browser sandbox.\nInstall the desktop build for real SSH connections.\n`),
    projects: dir({
      api: dir({
        'docker-compose.yml': file('services:\n  api:\n    image: ghcr.io/acme/api:1.8.2\n    ports: ["8080:8080"]\n    restart: unless-stopped\n  redis:\n    image: redis:7-alpine\n'),
        'main.go': file('package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })\n\thttp.ListenAndServe(":8080", nil)\n}\n'),
        '.env': file('DATABASE_URL=postgres://api@db:5432/api\nREDIS_URL=redis://redis:6379\n', 0o600),
      }),
      'deploy.sh': file('#!/usr/bin/env bash\nset -euo pipefail\ngit pull --ff-only\ndocker compose up -d --build\n', 0o755),
    }),
    backups: dir({ 'db-2026-01-13.sql.gz': file('\x1f\x8b(binary gzip data)'), 'db-2026-01-12.sql.gz': file('\x1f\x8b(binary gzip data)') }),
  });
  return dir({
    bin: dir(), boot: dir(), dev: dir(), opt: dir(), tmp: dir(), usr: dir({ bin: dir(), local: dir() }),
    etc: dir({
      hostname: file(host.label.toLowerCase().replace(/\s+/g, '-') + '\n'),
      'os-release': file('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n'),
      nginx: dir({ 'nginx.conf': file('user www-data;\nworker_processes auto;\nevents { worker_connections 1024; }\nhttp {\n  include /etc/nginx/sites-enabled/*;\n}\n') }),
    }),
    var: dir({ log: dir({ nginx: dir({ 'error.log': file(NGINX_ERR + '\n'), 'access.log': file('10.0.4.17 - - [14/Jan/2026:09:12:01] "GET /v1/health HTTP/1.1" 502 157\n10.0.4.22 - - [14/Jan/2026:09:12:03] "POST /v1/orders HTTP/1.1" 502 157\n') }), syslog: file('Jan 14 09:11:58 host systemd[1]: api.service: Main process exited, code=exited, status=1/FAILURE\nJan 14 09:11:58 host systemd[1]: api.service: Failed with result \'exit-code\'.\n') }) }),
    root: user === 'root' ? homeDir : dir(),
    home: dir(home ? { [home]: homeDir } : {}),
  });
}

const filesystems = new Map<string, FNode>();
export function fsFor(host: Host): FNode {
  if (!filesystems.has(host.id)) filesystems.set(host.id, buildFs(host));
  return filesystems.get(host.id)!;
}

export function homeOf(host: Host) {
  return host.username === 'root' ? '/root' : `/home/${host.username || 'user'}`;
}

export function normalize(path: string, cwd: string, home: string): string {
  let p = path.replace(/^~(?=\/|$)/, home);
  if (!p.startsWith('/')) p = cwd.replace(/\/$/, '') + '/' + p;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

function lookup(root: FNode, path: string): FNode | null {
  let node: FNode = root;
  for (const seg of path.split('/').filter(Boolean)) {
    if (node.type !== 'dir' || !node.children[seg]) return null;
    node = node.children[seg];
  }
  return node;
}

function parentOf(root: FNode, path: string): [Extract<FNode, { type: 'dir' }>, string] | null {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return null;
  const parent = lookup(root, '/' + parts.join('/'));
  return parent && parent.type === 'dir' ? [parent, name] : null;
}

// ─── SFTP-style API over the virtual FS ───────────────────────────────
export const vfs = {
  list(host: Host, path: string): FileEntry[] {
    const p = path || homeOf(host);
    const node = lookup(fsFor(host), p);
    if (!node || node.type !== 'dir') throw { kind: 'io', message: `No such directory: ${p}` };
    return Object.entries(node.children)
      .map(([name, n]) => ({
        name,
        path: (p === '/' ? '' : p) + '/' + name,
        isDir: n.type === 'dir',
        isSymlink: false,
        size: n.type === 'file' ? new Blob([n.content]).size : 4096,
        modified: n.mtime,
        permissions: n.mode,
      }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  },
  mkdir(host: Host, path: string) {
    const r = parentOf(fsFor(host), path);
    if (!r) throw { kind: 'io', message: 'invalid path' };
    r[0].children[r[1]] = dir();
    r[0].children[r[1]].mtime = now();
  },
  remove(host: Host, path: string) {
    const r = parentOf(fsFor(host), path);
    if (r) delete r[0].children[r[1]];
  },
  rename(host: Host, from: string, to: string) {
    const root = fsFor(host);
    const a = parentOf(root, from);
    const b = parentOf(root, to);
    if (!a || !b || !a[0].children[a[1]]) throw { kind: 'io', message: 'rename failed' };
    b[0].children[b[1]] = a[0].children[a[1]];
    delete a[0].children[a[1]];
  },
  write(host: Host, path: string, content: string) {
    const r = parentOf(fsFor(host), path);
    if (!r) throw { kind: 'io', message: 'invalid path' };
    r[0].children[r[1]] = file(content);
    r[0].children[r[1]].mtime = now();
  },
  read(host: Host, path: string): string {
    const n = lookup(fsFor(host), path);
    if (!n || n.type !== 'file') throw { kind: 'io', message: 'not a file' };
    return n.content;
  },
};

// ─── Shell ────────────────────────────────────────────────────────────
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m' };

function fmtMode(n: FNode) {
  const m = n.mode;
  const r = (b: number) => ((m >> b) & 4 ? 'r' : '-') + ((m >> b) & 2 ? 'w' : '-') + ((m >> b) & 1 ? 'x' : '-');
  return (n.type === 'dir' ? 'd' : '-') + r(6) + r(3) + r(0);
}

export class DemoShell {
  cwd: string;
  private line = '';
  private history: string[] = [];
  private hIdx = -1;
  private home: string;
  private hostname: string;
  private startedAt = Date.now();

  constructor(private host: Host, private emit: (s: string) => void, private onCwd: (p: string) => void) {
    this.home = homeOf(host);
    this.cwd = this.home;
    this.hostname = host.label.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  }

  private get root() { return fsFor(this.host); }
  private out(s: string) { this.emit(s.replace(/\r?\n/g, '\r\n')); }

  start(resumeCwd?: string) {
    const lastLogin = new Date(Date.now() - 3600_000 * 7).toUTCString();
    this.out(`${C.bold}Welcome to Ubuntu 24.04.1 LTS${C.reset} (GNU/Linux 6.8.0-49-generic x86_64)\n\n`);
    this.out(`${C.gray} * Sandbox mode — this is the DrexiusTerminal browser preview.\n * Desktop (Tauri) builds open real SSH sessions via libssh2.\n * Try: ${C.cyan}ls -la${C.gray}, ${C.cyan}tail /var/log/nginx/error.log${C.gray}, ${C.cyan}neofetch${C.gray}, ${C.cyan}help${C.reset}\n\n`);
    this.out(`Last login: ${lastLogin} from 10.0.0.12\n`);
    if (resumeCwd) {
      const node = lookup(this.root, resumeCwd);
      if (node && node.type === 'dir') {
        this.cwd = resumeCwd;
        this.out(`${C.magenta}⟲ Session snapshot restored → ${resumeCwd}${C.reset}\n`);
      }
    }
    this.prompt();
  }

  private displayCwd() {
    return this.cwd === this.home ? '~' : this.cwd.startsWith(this.home + '/') ? '~' + this.cwd.slice(this.home.length) : this.cwd;
  }

  private prompt() {
    this.emit(`\x1b]7;file://${this.hostname}${encodeURI(this.cwd)}\x07`);
    const sym = this.host.username === 'root' ? '#' : '$';
    this.emit(`${C.bold}${C.green}${this.host.username}@${this.hostname}${C.reset}:${C.bold}${C.blue}${this.displayCwd()}${C.reset}${sym} `);
  }

  input(data: string) {
    // handle escape sequences (arrows)
    if (data === '\x1b[A' || data === '\x1b[B') {
      if (!this.history.length) return;
      if (data === '\x1b[A') this.hIdx = this.hIdx < 0 ? this.history.length - 1 : Math.max(0, this.hIdx - 1);
      else this.hIdx = this.hIdx < 0 ? -1 : this.hIdx + 1 >= this.history.length ? -1 : this.hIdx + 1;
      const next = this.hIdx < 0 ? '' : this.history[this.hIdx];
      this.emit('\b \b'.repeat(this.line.length));
      this.line = next;
      this.emit(next);
      return;
    }
    if (data.startsWith('\x1b')) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        this.emit('\r\n');
        const cmd = this.line;
        this.line = '';
        this.hIdx = -1;
        if (cmd.trim()) this.history.push(cmd);
        this.run(cmd);
        this.prompt();
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length) { this.line = this.line.slice(0, -1); this.emit('\b \b'); }
      } else if (ch === '\x03') {
        this.emit('^C\r\n'); this.line = ''; this.prompt();
      } else if (ch === '\x0c') {
        this.emit('\x1b[2J\x1b[H'); this.prompt(); this.emit(this.line);
      } else if (ch === '\x15') {
        this.emit('\b \b'.repeat(this.line.length)); this.line = '';
      } else if (ch === '\t') {
        this.complete();
      } else if (ch >= ' ') {
        this.line += ch; this.emit(ch);
      }
    }
  }

  private complete() {
    const parts = this.line.split(/\s+/);
    const last = parts[parts.length - 1] || '';
    const slash = last.lastIndexOf('/');
    const base = slash >= 0 ? last.slice(0, slash + 1) : '';
    const frag = slash >= 0 ? last.slice(slash + 1) : last;
    const d = lookup(this.root, normalize(base || '.', this.cwd, this.home));
    if (!d || d.type !== 'dir') return;
    const matches = Object.keys(d.children).filter((n) => n.startsWith(frag));
    if (matches.length === 1) {
      const m = matches[0];
      const add = m.slice(frag.length) + (d.children[m].type === 'dir' ? '/' : ' ');
      this.line += add; this.emit(add);
    } else if (matches.length > 1) {
      this.out('\n' + matches.join('  ') + '\n'); this.prompt(); this.emit(this.line);
    }
  }

  private run(raw: string) {
    for (const seg of raw.split('&&')) {
      const ok = this.pipeline(seg.trim());
      if (!ok) break;
    }
  }

  private pipeline(cmd: string): boolean {
    if (!cmd) return true;
    let redirect: string | null = null;
    const m = cmd.match(/^(.*?)\s*>\s*(\S+)$/);
    if (m) { cmd = m[1]; redirect = m[2]; }
    let stdin: string | null = null;
    let ok = true;
    for (const stage of cmd.split('|').map((s) => s.trim())) {
      const r = this.exec(stage, stdin);
      stdin = r.out; ok = r.ok;
    }
    if (redirect) {
      try { vfs.write(this.host, normalize(redirect, this.cwd, this.home), (stdin ?? '').replace(/\x1b\[[0-9;]*m/g, '')); } catch { this.out(`bash: ${redirect}: No such file or directory\n`); }
    } else if (stdin) this.out(stdin.endsWith('\n') ? stdin : stdin + '\n');
    return ok;
  }

  private exec(stage: string, stdin: string | null): { out: string; ok: boolean } {
    const args = (stage.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
    const [name, ...rest] = args;
    const flags = rest.filter((a) => a.startsWith('-')).join('');
    const pos = rest.filter((a) => !a.startsWith('-'));
    const p = (x?: string) => normalize(x ?? '.', this.cwd, this.home);
    const err = (msg: string) => ({ out: `${C.red}${msg}${C.reset}`, ok: false });
    const ok = (out = '') => ({ out, ok: true });

    switch (name) {
      case 'help':
        return ok(`${C.bold}Sandbox commands:${C.reset} ls cd pwd cat echo mkdir touch rm mv head tail grep wc sort whoami hostname uname date uptime df free ps top docker systemctl history neofetch clear exit\nPipes (|), && and > redirection are supported.`);
      case 'pwd': return ok(this.cwd);
      case 'whoami': return ok(this.host.username);
      case 'hostname': return ok(this.hostname);
      case 'uname': return ok(flags.includes('a') ? `Linux ${this.hostname} 6.8.0-49-generic #49-Ubuntu SMP x86_64 GNU/Linux` : 'Linux');
      case 'date': return ok(new Date().toString());
      case 'uptime': {
        const mins = Math.floor((Date.now() - this.startedAt) / 60000) + 4127;
        return ok(` ${new Date().toTimeString().slice(0, 8)} up ${Math.floor(mins / 1440)} days, ${Math.floor((mins % 1440) / 60)}:${String(mins % 60).padStart(2, '0')},  1 user,  load average: 0.42, 0.37, 0.31`);
      }
      case 'clear': this.emit('\x1b[2J\x1b[3J\x1b[H'); return ok();
      case 'exit': case 'logout': return ok(`${C.gray}logout (sandbox sessions stay open — close the tab instead)${C.reset}`);
      case 'echo': return ok(rest.join(' ').replace(/\$HOME/g, this.home).replace(/\$USER/g, this.host.username).replace(/\$PWD/g, this.cwd));
      case 'history': return ok(this.history.map((h, i) => `  ${String(i + 1).padStart(3)}  ${h}`).join('\n'));
      case 'cd': {
        const target = p(pos[0] ?? '~');
        const n = lookup(this.root, target);
        if (!n) return err(`bash: cd: ${pos[0]}: No such file or directory`);
        if (n.type !== 'dir') return err(`bash: cd: ${pos[0]}: Not a directory`);
        this.cwd = target; this.onCwd(target);
        return ok();
      }
      case 'ls': case 'll': {
        const long = name === 'll' || flags.includes('l');
        const all = name === 'll' || flags.includes('a');
        const target = p(pos[0]);
        const n = lookup(this.root, target);
        if (!n) return err(`ls: cannot access '${pos[0]}': No such file or directory`);
        if (n.type === 'file') return ok(pos[0]);
        const entries = Object.entries(n.children).filter(([k]) => all || !k.startsWith('.')).sort(([a], [b]) => a.localeCompare(b));
        const color = (k: string, v: FNode) => v.type === 'dir' ? `${C.bold}${C.blue}${k}${C.reset}` : v.mode & 0o100 ? `${C.bold}${C.green}${k}${C.reset}` : k.endsWith('.gz') ? `${C.bold}${C.red}${k}${C.reset}` : k;
        if (!long) return ok(entries.map(([k, v]) => color(k, v)).join('  '));
        const lines = entries.map(([k, v]) => {
          const size = v.type === 'file' ? new Blob([v.content]).size : 4096;
          const d = new Date(v.mtime * 1000);
          const ds = d.toLocaleString('en-US', { month: 'short' }) + ' ' + String(d.getDate()).padStart(2) + ' ' + d.toTimeString().slice(0, 5);
          return `${fmtMode(v)}  1 ${this.host.username.padEnd(6)} ${this.host.username.padEnd(6)} ${String(size).padStart(6)} ${ds} ${color(k, v)}`;
        });
        return ok(`total ${entries.length * 4}\n` + lines.join('\n'));
      }
      case 'cat': {
        if (!pos.length && stdin !== null) return ok(stdin);
        const outs: string[] = [];
        for (const f of pos) {
          const n = lookup(this.root, p(f));
          if (!n) return err(`cat: ${f}: No such file or directory`);
          if (n.type === 'dir') return err(`cat: ${f}: Is a directory`);
          outs.push(n.content.replace(/\n$/, ''));
        }
        return ok(outs.join('\n'));
      }
      case 'head': case 'tail': {
        const nIdx = rest.indexOf('-n');
        const count = nIdx >= 0 ? parseInt(rest[nIdx + 1]) || 10 : 10;
        const fileArg = pos.filter((x) => x !== String(count))[0];
        let text = stdin ?? '';
        if (fileArg) {
          const n = lookup(this.root, p(fileArg));
          if (!n || n.type !== 'file') return err(`${name}: cannot open '${fileArg}' for reading: No such file or directory`);
          text = n.content;
        }
        const lines = text.replace(/\n$/, '').split('\n');
        return ok((name === 'head' ? lines.slice(0, count) : lines.slice(-count)).join('\n'));
      }
      case 'grep': {
        const pat = pos[0];
        if (!pat) return err('usage: grep PATTERN [FILE]');
        let text = stdin ?? '';
        if (pos[1]) {
          const n = lookup(this.root, p(pos[1]));
          if (!n || n.type !== 'file') return err(`grep: ${pos[1]}: No such file or directory`);
          text = n.content;
        }
        const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.includes('i') ? 'i' : '');
        const lines = text.split('\n').filter((l) => (flags.includes('v') ? !re.test(l) : re.test(l)));
        return { out: lines.map((l) => l.replace(new RegExp(re.source, re.flags + 'g'), (m) => `${C.bold}${C.red}${m}${C.reset}`)).join('\n'), ok: lines.length > 0 };
      }
      case 'wc': {
        const text = stdin ?? (pos[0] ? (lookup(this.root, p(pos[0])) as { content?: string })?.content ?? '' : '');
        const l = text.replace(/\n$/, '').split('\n').length;
        return ok(flags.includes('l') ? String(l) : `${l} ${text.split(/\s+/).filter(Boolean).length} ${text.length}`);
      }
      case 'sort': return ok((stdin ?? '').split('\n').sort().join('\n'));
      case 'mkdir': for (const d of pos) { try { vfs.mkdir(this.host, p(d)); } catch { return err(`mkdir: cannot create directory '${d}'`); } } return ok();
      case 'touch': for (const f of pos) { if (!lookup(this.root, p(f))) try { vfs.write(this.host, p(f), ''); } catch { return err(`touch: cannot touch '${f}'`); } } return ok();
      case 'rm': for (const f of pos) { const n = lookup(this.root, p(f)); if (!n) return err(`rm: cannot remove '${f}': No such file or directory`); if (n.type === 'dir' && !flags.includes('r')) return err(`rm: cannot remove '${f}': Is a directory`); vfs.remove(this.host, p(f)); } return ok();
      case 'mv': try { vfs.rename(this.host, p(pos[0]), p(pos[1])); return ok(); } catch { return err(`mv: cannot move '${pos[0]}'`); }
      case 'df': return ok(`Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1   80G   31G   49G  39% /\ntmpfs           3.9G     0  3.9G   0% /dev/shm\n/dev/nvme0n1p15 105M  6.1M   99M   6% /boot/efi`);
      case 'free': return ok(`               total        used        free      shared  buff/cache   available\nMem:           7.7Gi       2.9Gi       1.6Gi        12Mi       3.2Gi       4.5Gi\nSwap:          2.0Gi       128Mi       1.9Gi`);
      case 'ps': case 'top': return ok(`    PID USER      %CPU %MEM COMMAND\n      1 root       0.0  0.1 /sbin/init\n    812 root       0.1  0.4 /usr/sbin/sshd -D\n   2214 www-data   0.3  0.6 nginx: worker process\n   3101 999        1.2  2.4 redis-server *:6379\n   4410 ${this.host.username.padEnd(9)} 0.0  0.1 -bash`);
      case 'docker': return ok(pos[0] === 'ps' ? `CONTAINER ID   IMAGE                     STATUS                     PORTS                    NAMES\n7f3a1c2b9d0e   redis:7-alpine            Up 3 days                  6379/tcp                 api-redis-1\n1b2c3d4e5f60   ghcr.io/acme/api:1.8.2    ${C.red}Restarting (1) 4 secs ago${C.reset}                            api-api-1` : 'Usage: docker [ps]');
      case 'systemctl': return ok(`${C.red}●${C.reset} ${pos[1] ?? 'api'}.service - ACME API\n     Loaded: loaded (/etc/systemd/system/api.service; enabled)\n     Active: ${C.red}${C.bold}failed${C.reset} (Result: exit-code) since ${new Date().toUTCString()}\n    Process: 4021 ExecStart=/opt/api/server (code=exited, status=1/FAILURE)\n\nJan 14 09:11:58 host server[4021]: panic: dial tcp db:5432: connect: connection refused`);
      case 'neofetch': {
        const art = [`${C.red}            .-/+oossssoo+/-.`, `        \`:+ssssssssssssssssss+:\``, `      -+ssssssssssssssssssyyssss+-`, `    .ossssssssssssssssss${C.reset}dMMMNy${C.red}sssso.`, `   /sssssssssss${C.reset}hdmmNNmmyNMMMMh${C.red}ssssss/`, `  +sssssssss${C.reset}hmydMMMMMMMNddddy${C.red}ssssssss+`, ` /ssssssss${C.reset}hNMMMyhhyyyyhmNMMMNh${C.red}ssssssss/`, `.ssssssss${C.reset}dMMMNh${C.red}ssssssssss${C.reset}hNMMMd${C.red}ssssssss.`];
        const info = [`${C.bold}${C.cyan}${this.host.username}@${this.hostname}${C.reset}`, '-----------------', `${C.cyan}OS${C.reset}: Ubuntu 24.04.1 LTS x86_64`, `${C.cyan}Kernel${C.reset}: 6.8.0-49-generic`, `${C.cyan}Shell${C.reset}: bash 5.2.21`, `${C.cyan}Terminal${C.reset}: DrexiusTerminal`, `${C.cyan}CPU${C.reset}: AMD EPYC 7763 (4) @ 2.44GHz`, `${C.cyan}Memory${C.reset}: 2934MiB / 7872MiB`];
        return ok(art.map((a, i) => a + '   ' + (info[i] ?? '')).join('\n') + C.reset);
      }
      case 'sudo': return this.exec(rest.join(' '), stdin);
      case 'ping': return ok(`PING ${pos[0] ?? 'localhost'} 56(84) bytes of data.\n64 bytes from ${pos[0]}: icmp_seq=1 ttl=57 time=11.8 ms\n64 bytes from ${pos[0]}: icmp_seq=2 ttl=57 time=12.1 ms\n64 bytes from ${pos[0]}: icmp_seq=3 ttl=57 time=11.6 ms\n\n--- ${pos[0]} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss`);
      default:
        if (name.startsWith('./') || name.endsWith('.sh')) return ok(`${C.yellow}[sandbox] would execute ${name}${C.reset}`);
        return err(`${name}: command not found`);
    }
  }
}
