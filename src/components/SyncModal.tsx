import { useEffect, useState } from 'react';
import {
  Cloud,
  X,
  Copy,
  Check,
  Server,
  QrCode,
  Sparkles,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
} from 'lucide-react';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { bridge, isTauri } from '../lib/bridge';
import type { DrexiusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

interface Props {
  onClose: () => void;
  onOpenPairing: () => void;
  toast: (m: string) => void;
  theme?: DrexiusTheme;
}

const RELAY_PY_SOURCE = `#!/usr/bin/env python3
"""Minimal single-group Drexius sync relay. Stores opaque ciphertext only.

Bind loopback by default; deploy behind an HTTPS reverse proxy for remote use.
Every request needs the same high-entropy bearer token. One instance/token per
sync group. Never put the bearer token in a URL or commit it to the repository.
"""

import argparse
import hmac
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ID = re.compile(r"v2-[0-9a-f]{64}\\Z")
MAX_BLOB = 8 * 1024 * 1024
MAX_CHANGES = 10_000


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=30) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS changes_cursor ON changes(cursor)")


def make_handler(path: Path, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DrexiusRelay/1"

        def send_body(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def authenticated(self) -> bool:
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied, "Bearer " + token):
                self.send_body(401, b'{"error":"unauthorized"}')
                return False
            return True

        def blob_id(self):
            parts = urlsplit(self.path)
            if parts.query or not parts.path.startswith("/blobs/"):
                return None
            blob_id = parts.path[len("/blobs/"):]
            return blob_id if ID.fullmatch(blob_id) else None

        def do_PUT(self):
            if not self.authenticated():
                return
            blob_id = self.blob_id()
            if blob_id is None:
                self.send_body(404, b'{"error":"not found"}')
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                length = -1
            if length < 1 or length > MAX_BLOB:
                self.send_body(413, b'{"error":"invalid blob length"}')
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self.send_body(400, b'{"error":"incomplete blob"}')
                return
            with sqlite3.connect(path, timeout=30) as db:
                db.execute("INSERT INTO blobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (blob_id, body))
                db.execute("INSERT INTO changes(id) VALUES(?)", (blob_id,))
            self.send_body(200, b'{}')

        def do_GET(self):
            if not self.authenticated():
                return
            blob_id = self.blob_id()
            if blob_id is not None:
                with sqlite3.connect(path, timeout=30) as db:
                    row = db.execute("SELECT data FROM blobs WHERE id=?", (blob_id,)).fetchone()
                if row is None:
                    self.send_body(404, b'{"error":"not found"}')
                else:
                    self.send_body(200, row[0], "application/octet-stream")
                return
            parsed = urlsplit(self.path)
            if parsed.path != "/changes":
                self.send_body(404, b'{"error":"not found"}')
                return
            params = parse_qs(parsed.query)
            values = params.get("since", ["0"])
            limits = params.get("limit", [str(MAX_CHANGES)])
            if len(values) != 1 or not values[0].isdigit() or len(limits) != 1 or not limits[0].isdigit():
                self.send_body(400, b'{"error":"invalid cursor or limit"}')
                return
            since = int(values[0])
            limit = int(limits[0])
            if since > 2**63 - 1 or not 1 <= limit <= MAX_CHANGES:
                self.send_body(400, b'{"error":"invalid cursor or limit"}')
                return
            with sqlite3.connect(path, timeout=30) as db:
                rows = db.execute("SELECT cursor,id FROM changes WHERE cursor>? ORDER BY cursor LIMIT ?", (since, limit)).fetchall()
            body = json.dumps({"changes": [{"cursor": n, "id": i} for n, i in rows]}).encode()
            self.send_body(200, body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: loopback)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", type=Path, default=Path(__file__).with_name("relay.sqlite3"))
    args = parser.parse_args()
    token = os.environ.get("DREXIUS_RELAY_TOKEN", "")
    if len(token) < 32:
        parser.error("set DREXIUS_RELAY_TOKEN to a random secret of at least 32 characters")
    init_db(args.db)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(args.db, token))
    print(f"Drexius relay listening on {args.host}:{server.server_port}; use HTTPS reverse proxy for remote clients", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
`;

function generateRandomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function SyncModal({
  onClose,
  onOpenPairing,
  toast,
  theme,
}: Props) {
  const accentColor = theme?.accent ?? '#22d3ee';
  const bgColor = theme?.xterm?.background ?? '#0e131d';
  const [url, setUrl] = useState(() => localStorage.getItem('drx.sync.relay') ?? '');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<{
    lastSync: number | null;
    lastError: string | null;
    deviceId: string;
    hasToken?: boolean;
    relayUrl?: string | null;
    skippedBlobs?: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // Deploy helper state
  const [showDeployGuide, setShowDeployGuide] = useState(false);
  const [deployTab, setDeployTab] = useState<'python' | 'docker' | 'code'>('python');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);

  useEffect(() => {
    try {
      localStorage.removeItem('drx.sync.token');
    } catch {}
    if (isTauri) {
      bridge
        .syncStatus()
        .then((st) => {
          setStatus(st);
          if (st.relayUrl) setUrl(st.relayUrl);
        })
        .catch(() => {});
    }
  }, []);

  const handleGenerateToken = () => {
    const newToken = generateRandomToken();
    setToken(newToken);
    bridge.writeClipboard(newToken).catch(() => {});
    toast('Generated secure 48-char token and copied to clipboard');
  };

  const handleCopyScript = async () => {
    try {
      await bridge.writeClipboard(RELAY_PY_SOURCE);
      setCopiedCode(true);
      toast('Copied relay.py script to clipboard');
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      toast('Failed to copy to clipboard');
    }
  };

  const effectiveToken = token.trim() || (status?.hasToken ? '<your-saved-token>' : 'replace-with-your-token');

  const pythonRunCmd = `export DREXIUS_RELAY_TOKEN="${effectiveToken}"\npython3 relay.py --host 0.0.0.0 --port 8787`;
  const dockerRunCmd = `docker run -d --name drexius-relay \\\n  -p 8787:8787 \\\n  -e DREXIUS_RELAY_TOKEN="${effectiveToken}" \\\n  -v ./relay-data:/data \\\n  python:3.11-slim python -c "$(${pythonRunCmd.replace(/\n/g, '; ')})"`;

  const handleCopyCommand = async (cmd: string) => {
    try {
      await bridge.writeClipboard(cmd);
      setCopiedCommand(true);
      toast('Command copied to clipboard');
      setTimeout(() => setCopiedCommand(false), 2000);
    } catch {
      toast('Failed to copy command');
    }
  };

  const formatErr = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object' && 'message' in e && typeof (e as any).message === 'string') {
      return (e as any).message;
    }
    return String(e);
  };

  const save = async () => {
    try {
      if (isTauri) {
        const tokenArg = token ? token : status?.hasToken ? undefined : '';
        await bridge.syncConfigure(url || null, tokenArg);
        setStatus(await bridge.syncStatus());
      }
      try {
        localStorage.removeItem('drx.sync.token');
        if (url) localStorage.setItem('drx.sync.relay', url);
        else localStorage.removeItem('drx.sync.relay');
      } catch {}
      toast(url ? 'Relay settings saved — pair your other devices via LAN to share its sync key' : 'Relay sync disabled');
      onClose();
    } catch (e) {
      const msg = formatErr(e);
      setStatus((s) => ({ ...(s ?? { lastSync: null, deviceId: '?' }), lastError: msg }));
      toast(`Could not save relay settings: ${msg}`);
    }
  };

  const doSync = async () => {
    setBusy(true);
    try {
      if (isTauri) {
        const tokenArg = token ? token : undefined;
        await bridge.syncConfigure(url || null, tokenArg);
      }
      const out = await bridge.syncNow();
      setStatus({
        lastSync: out.lastSync,
        lastError: out.lastError,
        deviceId: out.deviceId,
        hasToken: out.hasToken,
        skippedBlobs: out.skippedBlobs,
      });
      toast('Encrypted sync completed');
    } catch (e: unknown) {
      const msg = formatErr(e);
      setStatus((s) => ({ ...(s ?? { lastSync: null, deviceId: '?' }), lastError: msg }));
      toast(`Sync failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    ['Seed', 'Random group key · shared by encrypted pairing'],
    ['K_sync', 'HKDF-SHA256(seed, "drexius/sync/v2")'],
    ['Seal', 'XChaCha20-Poly1305 · 256-byte padded CBOR'],
    ['Blind', 'blob id = HMAC(K_index, table:id)'],
    ['Merge', 'Hybrid logical clocks · last-writer-wins'],
  ];

  const lastSyncStr = status?.lastSync ? new Date(status.lastSync * 1000).toLocaleString() : 'never';

  return (
    <ResponsiveOverlay label="Encrypted relay sync" onClose={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 p-5 sm:p-6 shadow-2xl"
        style={{ backgroundColor: bgColor }}
      >
        <SheetHandle onClose={onClose} />
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="grid h-10 w-10 place-items-center rounded-2xl border transition shadow-lg shrink-0"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
                boxShadow: `0 0 20px ${accentColor}25`,
              }}
            >
              <Cloud className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Encrypted Relay Sync</h3>
              <p className="text-[11px] text-slate-400">Zero-knowledge asynchronous cloud sync across your devices</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* LAN Pairing Banner for Users Who Don't Need a Server */}
        <div
          className="relative mt-4 rounded-xl border p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
          style={{
            backgroundColor: `${accentColor}0e`,
            borderColor: `${accentColor}25`,
          }}
        >
          <div className="min-w-0">
            <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: accentColor }}>
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>No relay needed? Link directly over Wi-Fi</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              If you just want to copy servers to your phone, scan the LAN QR code. Zero servers or setup required.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenPairing();
            }}
            className="flex items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition shrink-0 shadow-sm"
            style={{
              backgroundColor: `${accentColor}20`,
              borderColor: `${accentColor}40`,
              color: accentColor,
            }}
          >
            <QrCode className="h-3.5 w-3.5" />
            <span>Pair Over Wi-Fi</span>
          </button>
        </div>

        {/* Server Configuration Fields */}
        <div className="relative mt-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-slate-400">Relay Server URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://sync.yourdomain.com (or http://localhost:8787)"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-white/30"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                Relay Bearer Token
                {status?.hasToken && !token && (
                  <span className="ml-2 font-normal text-emerald-400 lowercase">
                    (saved in encrypted vault)
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={handleGenerateToken}
                className="flex items-center gap-1 text-[11px] hover:underline"
                style={{ color: accentColor }}
                title="Generate a cryptographically random 48-character token"
              >
                <Sparkles className="h-3 w-3" />
                <span>Generate Token</span>
              </button>
            </div>
            <div className="relative mt-1">
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder={status?.hasToken ? '•••••••• (leave blank to keep existing)' : 'Paste or generate 32+ char secret'}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-white/30"
              />
            </div>
          </div>

          {/* Collapsible Deploy Helper Drawer */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <button
              type="button"
              onClick={() => setShowDeployGuide(!showDeployGuide)}
              className="flex w-full items-center justify-between p-3 text-xs font-medium text-slate-300 hover:bg-white/[0.04] transition"
            >
              <div className="flex items-center gap-2">
                <Server className="h-3.5 w-3.5" style={{ color: accentColor }} />
                <span>How to host the relay server (30-second setup)</span>
              </div>
              {showDeployGuide ? <ChevronUp className="h-3.5 w-3.5 text-slate-500" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-500" />}
            </button>

            {showDeployGuide && (
              <div className="p-3 pt-0 space-y-2.5 border-t border-white/5 animate-in fade-in duration-100 text-xs">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  The Drexius relay is a lightweight, zero-dependency Python script (~130 lines) that stores encrypted blobs. It cannot read your keys, passwords, or servers.
                </p>

                {/* Deploy Tabs */}
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
                  <button
                    type="button"
                    onClick={() => setDeployTab('python')}
                    className={cn(
                      'flex-1 rounded-md py-1 text-[11px] font-medium transition',
                      deployTab === 'python' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    Python Script
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeployTab('docker')}
                    className={cn(
                      'flex-1 rounded-md py-1 text-[11px] font-medium transition',
                      deployTab === 'docker' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    Docker
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeployTab('code')}
                    className={cn(
                      'flex-1 rounded-md py-1 text-[11px] font-medium transition',
                      deployTab === 'code' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    View Source
                  </button>
                </div>

                {deployTab === 'python' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Run on your VPS or home server:</span>
                      <button
                        type="button"
                        onClick={handleCopyScript}
                        className="flex items-center gap-1 text-[11px] hover:underline"
                        style={{ color: accentColor }}
                      >
                        {copiedCode ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        <span>Copy relay.py</span>
                      </button>
                    </div>
                    <div className="relative rounded-lg border border-white/10 bg-black/60 p-2.5 font-mono text-[11px] text-emerald-300">
                      <pre className="whitespace-pre-wrap break-all">{pythonRunCmd}</pre>
                      <button
                        type="button"
                        onClick={() => handleCopyCommand(pythonRunCmd)}
                        className="absolute right-2 top-2 rounded bg-white/10 p-1 text-slate-300 hover:text-white transition"
                        title="Copy command"
                      >
                        {copiedCommand ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  </div>
                )}

                {deployTab === 'docker' && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-slate-400">Quick Docker container run:</p>
                    <div className="relative rounded-lg border border-white/10 bg-black/60 p-2.5 font-mono text-[11px] text-emerald-300">
                      <pre className="whitespace-pre-wrap break-all">{dockerRunCmd}</pre>
                      <button
                        type="button"
                        onClick={() => handleCopyCommand(dockerRunCmd)}
                        className="absolute right-2 top-2 rounded bg-white/10 p-1 text-slate-300 hover:text-white transition"
                        title="Copy command"
                      >
                        {copiedCommand ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  </div>
                )}

                {deployTab === 'code' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Full standalone Python relay (134 lines):</span>
                      <button
                        type="button"
                        onClick={handleCopyScript}
                        className="flex items-center gap-1 text-[11px] hover:underline"
                        style={{ color: accentColor }}
                      >
                        {copiedCode ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        <span>Copy Script</span>
                      </button>
                    </div>
                    <textarea
                      readOnly
                      rows={8}
                      value={RELAY_PY_SOURCE}
                      className="w-full resize-none rounded-lg border border-white/10 bg-black/60 p-2.5 font-mono text-[10px] text-slate-300 focus:outline-none"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Cryptography Explainer Steps */}
          <ol className="relative pt-1 space-y-1.5">
            {steps.map(([k, v], i) => (
              <li key={k} className="flex items-center gap-2.5 text-xs">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-white/5 text-[9px] text-slate-400 ring-1 ring-white/10">{i + 1}</span>
                <span className="w-12 font-semibold text-[11px]" style={{ color: accentColor }}>{k}</span>
                <span className="font-mono text-[10.5px] text-slate-400 truncate">{v}</span>
              </li>
            ))}
          </ol>

          {status && (
            <div className="rounded-lg border border-white/5 bg-black/30 p-2.5 font-mono text-[10.5px] text-slate-400">
              device <span style={{ color: accentColor }}>{status.deviceId}</span> · last sync <span className="text-emerald-300">{lastSyncStr}</span>
              {status.lastError && <div className="mt-1 text-rose-300">error: {status.lastError}</div>}
              {!!status.skippedBlobs && (
                <div className="mt-1 text-amber-300">
                  skipped {status.skippedBlobs} unreadable blob{status.skippedBlobs === 1 ? '' : 's'} — another
                  sync group on this relay, or a record the relay no longer serves.
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-between gap-2 pt-2 border-t border-white/5">
            <button
              onClick={doSync}
              disabled={!url || busy}
              className="rounded-xl border px-4 py-2 text-xs font-semibold transition disabled:opacity-40"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
              }}
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="rounded-xl px-4 py-2 text-xs text-slate-300 hover:bg-white/5">Close</button>
              <button
                onClick={save}
                className="rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 shadow-lg"
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 0 20px ${accentColor}35`,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
