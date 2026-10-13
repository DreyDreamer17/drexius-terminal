import { useEffect, useRef, useState } from 'react';
import {
  Laptop,
  Smartphone,
  QrCode,
  ShieldCheck,
  Copy,
  Check,
  X,
  RefreshCw,
  ArrowRight,
  Trash2,
  CheckCircle2,
  Share2,
  Lock,
} from 'lucide-react';
import QRCode from 'qrcode';
import { listen } from '@tauri-apps/api/event';
import type { LocalDeviceInfo, PairedDevice, PairingHostInfo, PairingJoinResult } from '../lib/types';
import { bridge, isTauri } from '../lib/bridge';
import { cn } from '../utils/cn';

interface ParsedPairingLink {
  host: string;
  port: number;
  pin: string;
  serverPublicKey: string;
}

/** Parses an nxpair:// link: host, port, 6-digit PIN, and the host's pinned X25519 public key (hex). */
function parsePairingLink(link: string): ParsedPairingLink {
  const m = link.trim().match(/^nxpair:\/\/([^:/?#\s]+):(\d{1,5})\?(\S+)$/);
  if (!m) throw new Error('That is not a valid pairing link. Copy it from the host device.');
  const params = new URLSearchParams(m[3]);
  const pin = (params.get('pin') || '').replace(/\D/g, '');
  const pk = (params.get('pk') || '').trim();
  if (pin.length !== 6) throw new Error('The pairing link does not contain a valid 6-digit code.');
  if (!/^[0-9a-fA-F]{64}$/.test(pk)) throw new Error('The pairing link does not contain a valid host key.');
  return { host: m[1], port: parseInt(m[2], 10), pin, serverPublicKey: pk.toLowerCase() };
}
import { THEMES, type NexusTheme } from '../lib/themes';

interface Props {
  onClose: () => void;
  onRefresh: () => Promise<void>;
  toast: (msg: string) => void;
  initialTab?: 'share' | 'join' | 'devices';
  theme?: NexusTheme;
}

export function DevicePairingModal({
  onClose,
  onRefresh,
  toast,
  initialTab = 'share',
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('nx.theme') ?? 'nexus')) || THEMES[0];
  const accentColor = activeTheme.accent;
  const bgColor = activeTheme.xterm.background || '#0e131d';

  const [tab, setTab] = useState<'share' | 'join' | 'devices'>(initialTab);

  // Host (Share) state
  const [hostInfo, setHostInfo] = useState<PairingHostInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [hostingError, setHostingError] = useState<string | null>(null);
  const [pairedSuccessPeer, setPairedSuccessPeer] = useState<{ deviceName: string; ip: string } | null>(null);
  const [copiedPin, setCopiedPin] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Join (Client) state
  const [joinLink, setJoinLink] = useState('');
  const [myDeviceName, setMyDeviceName] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinResult, setJoinResult] = useState<PairingJoinResult | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Devices list state
  const [localInfo, setLocalInfo] = useState<LocalDeviceInfo | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  const hostInfoRef = useRef<PairingHostInfo | null>(null);
  hostInfoRef.current = hostInfo;

  // ── Start Host pairing listener when in 'share' tab ──
  // NOTE: listener lifecycle depends only on `tab` so changing theme/accent
  // does not invalidate the active PIN/QR link. QR recoloring is handled
  // by a separate effect below. A generation counter guards rapid
  // Share -> Join -> Share switches so a stale stop cannot kill the newest
  // listener and a stale start response cannot overwrite it.
  const pairingSeq = useRef(0);
  useEffect(() => {
    let disposed = false;

    if (tab === 'share') {
      const seq = ++pairingSeq.current;
      setHostInfo(null);
      setQrDataUrl('');
      setHostingError(null);
      bridge.pairingStartHost()
        .then((info) => {
          if (disposed || pairingSeq.current !== seq) {
            void bridge.pairingStopHost(info.pin).catch(() => {});
            return;
          }
          setHostInfo(info);
        })
        .catch((err) => {
          if (!disposed && pairingSeq.current === seq) setHostingError(String(err?.message || err));
        });
      return () => {
        disposed = true;
        // Only stop if no newer Share session superseded this one; otherwise
        // the stop would land after the new start and kill the live listener.
        if (pairingSeq.current === seq) {
          const pin = hostInfoRef.current?.pin;
          void bridge.pairingStopHost(pin).catch(() => {});
        }
      };
    }

    return () => {
      disposed = true;
    };
  }, [tab]);

  // ── Render QR for current payload; re-runs on theme change without restarting listener ──
  useEffect(() => {
    let cancelled = false;
    const payload = hostInfo?.qrPayload;
    if (tab !== 'share' || !payload) return;
    QRCode.toDataURL(payload, {
      width: 220,
      margin: 1.5,
      color: {
        dark: '#030712',
        light: accentColor,
      },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => {
        console.error('Failed to generate QR code', err);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, hostInfo?.qrPayload, accentColor]);

  // ── Listen for pairing success event from Tauri backend ──
  useEffect(() => {
    let disposed = false;
    let unlistenFn: (() => void) | null = null;
    if (isTauri) {
      listen<{ deviceName: string; ip: string }>('pairing-success', (event) => {
        setPairedSuccessPeer(event.payload);
        toast(`Successfully paired with ${event.payload.deviceName}!`);
        onRefresh();
      }).then((u) => {
        if (disposed) u();
        else unlistenFn = u;
      }).catch(() => {});
    }
    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, [onRefresh, toast]);

  // ── Load local device info & paired devices ──
  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      const [loc, devs] = await Promise.all([
        bridge.pairingGetLocalInfo(),
        bridge.pairingListDevices(),
      ]);
      setLocalInfo(loc);
      setDevices(devs);
      if (!myDeviceName && loc.deviceName) {
        setMyDeviceName(loc.deviceName);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  // Clean up host on modal close (unmount effect triggers session-scoped stop)
  const handleClose = () => {
    onClose();
  };

  const handleCopyPin = () => {
    if (!hostInfo) return;
    navigator.clipboard.writeText(hostInfo.pin);
    setCopiedPin(true);
    setTimeout(() => setCopiedPin(false), 2000);
  };

  const handleCopyUrl = () => {
    if (!hostInfo) return;
    // The link carries the host's public key, which the joiner pins. Copying only the IP would not be enough.
    navigator.clipboard.writeText(hostInfo.qrPayload);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsed: ParsedPairingLink;
    try {
      parsed = parsePairingLink(joinLink);
    } catch (err: any) {
      setJoinError(err?.message || 'Invalid pairing link');
      return;
    }
    setJoining(true);
    setJoinError(null);
    setJoinResult(null);

    try {
      const res = await bridge.pairingJoinClient(
        parsed.host,
        parsed.port,
        parsed.pin,
        parsed.serverPublicKey,
        myDeviceName.trim() || undefined
      );
      setJoinResult(res);
      await onRefresh();
      toast(`Successfully linked with ${res.serverDeviceName}!`);
    } catch (err: any) {
      setJoinError(err?.message || String(err) || 'Failed to connect to host');
    } finally {
      setJoining(false);
    }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!confirm(`Revoke pairing authorization for "${name}"?`)) return;
    try {
      await bridge.pairingRevokeDevice(id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      toast(`Revoked ${name}`);
    } catch (err: any) {
      toast(`Revocation failed: ${err?.message || err}`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={handleClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: bgColor }}
      >
        {/* Top ambient radial glow */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25"
          style={{ background: `radial-gradient(ellipse at top, ${accentColor} 0%, transparent 70%)` }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-white/10 px-5 py-4">
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
              <QrCode className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Direct Device Pairing</h3>
              <p className="flex items-center gap-1 text-[11px] text-slate-400">
                <ShieldCheck className="h-3 w-3 text-emerald-400" />
                X25519 Authenticated Key Exchange · Direct LAN Sync
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="relative grid grid-cols-3 border-b border-white/10 bg-black/30 p-1 text-xs">
          <button
            type="button"
            onClick={() => setTab('share')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg py-2 transition font-medium',
              tab !== 'share' && 'text-slate-400 hover:text-white'
            )}
            style={tab === 'share' ? {
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}40`,
              color: accentColor,
              borderWidth: 1,
            } : undefined}
          >
            <Share2 className="h-3.5 w-3.5" />
            <span>Share Vault</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('join')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg py-2 transition font-medium',
              tab !== 'join' && 'text-slate-400 hover:text-white'
            )}
            style={tab === 'join' ? {
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}40`,
              color: accentColor,
              borderWidth: 1,
            } : undefined}
          >
            <Laptop className="h-3.5 w-3.5" />
            <span>Link to Device</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('devices');
              loadDevices();
            }}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg py-2 transition font-medium',
              tab !== 'devices' && 'text-slate-400 hover:text-white'
            )}
            style={tab === 'devices' ? {
              backgroundColor: `${accentColor}18`,
              borderColor: `${accentColor}40`,
              color: accentColor,
              borderWidth: 1,
            } : undefined}
          >
            <Smartphone className="h-3.5 w-3.5" />
            <span>Devices ({devices.length})</span>
          </button>
        </div>

        {/* Tab 1: Share Vault (Host Mode) */}
        {tab === 'share' && (
          <div className="p-5 space-y-4">
            {pairedSuccessPeer ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-center space-y-2">
                <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400 animate-bounce" />
                <h4 className="text-sm font-semibold text-emerald-200">Device Linked Successfully!</h4>
                <p className="text-xs text-slate-300">
                  Transferred encrypted vault to <strong className="text-white">{pairedSuccessPeer.deviceName}</strong> ({pairedSuccessPeer.ip}).
                </p>
                <div className="pt-2">
                  <button
                    onClick={() => setPairedSuccessPeer(null)}
                    className="rounded-lg bg-emerald-500/20 border border-emerald-400/40 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30 transition"
                  >
                    Pair another device
                  </button>
                </div>
              </div>
            ) : hostingError ? (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-4 text-xs text-rose-300">
                <p className="font-semibold">Failed to start pairing server:</p>
                <p className="mt-1 font-mono text-[11px]">{hostingError}</p>
              </div>
            ) : hostInfo ? (
              <div className="space-y-4">
                {/* Listening Status Banner */}
                <div className="flex items-center justify-between rounded-xl border border-cyan-500/20 bg-cyan-950/20 px-3.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
                    </span>
                    <span className="text-xs font-medium text-cyan-200">
                      Listening on LAN: <span className="font-mono text-white">{hostInfo.ip}:{hostInfo.port}</span>
                    </span>
                  </div>
                  <button
                    onClick={handleCopyUrl}
                    className="flex items-center gap-1 text-[10px] text-cyan-300 hover:underline"
                  >
                    {copiedUrl ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedUrl ? 'Copied' : 'Copy link'}</span>
                  </button>
                </div>

                {/* QR Code and PIN display */}
                <div className="flex flex-col sm:flex-row items-center gap-5 justify-center py-1">
                  {/* QR Image */}
                  <div className="relative rounded-2xl border border-white/10 bg-white p-2.5 shadow-lg shrink-0">
                    {qrDataUrl ? (
                      <img src={qrDataUrl} alt="Pairing QR Code" className="h-44 w-44 rounded-lg object-contain" />
                    ) : (
                      <div className="grid h-44 w-44 place-items-center bg-slate-900 text-slate-500 text-xs">
                        Generating QR…
                      </div>
                    )}
                    <span className="absolute -bottom-2 -right-2 rounded bg-cyan-400 text-black px-1.5 py-0.5 text-[9px] font-bold shadow">
                      SCAN ME
                    </span>
                  </div>

                  {/* 6-Digit PIN Code Box */}
                  <div className="flex flex-col items-center sm:items-start space-y-2 text-center sm:text-left">
                    <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                      Pairing PIN Code
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-2xl font-bold tracking-widest text-cyan-300 bg-black/50 border border-cyan-400/30 rounded-xl px-4 py-2.5 shadow-inner">
                      <span>{hostInfo.pin.slice(0, 3)}</span>
                      <span className="text-slate-600">-</span>
                      <span>{hostInfo.pin.slice(3)}</span>
                    </div>
                    <button
                      onClick={handleCopyPin}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition"
                    >
                      {copiedPin ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedPin ? 'PIN Copied' : 'Copy 6-digit PIN'}</span>
                    </button>
                    <p className="text-[11px] text-slate-500 max-w-[210px]">
                      On your new device, choose <strong className="text-slate-300">Link to Device</strong> and enter this PIN.
                    </p>
                  </div>
                </div>

                <div className="rounded-lg bg-black/40 border border-white/5 p-2.5 text-[11px] text-slate-400 flex items-start gap-2">
                  <Lock className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    Direct device-to-device connection. Keys are negotiated via ephemeral X25519 Diffie-Hellman and sealed with XChaCha20-Poly1305.
                  </span>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
                <RefreshCw className="h-5 w-5 animate-spin text-cyan-400" />
                <span>Initializing local pairing listener…</span>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Link to Device (Client Mode) */}
        {tab === 'join' && (
          <form onSubmit={handleJoin} className="p-5 space-y-4">
            <div>
              <p className="text-xs text-slate-400">
                Enter the host IP and 6-digit PIN shown on your existing device to clone your vaults and profiles in 2 seconds.
              </p>
            </div>

            {joinError && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-300">
                {joinError}
              </div>
            )}

            {joinResult && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3.5 text-xs text-emerald-200 space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Vault cloned successfully from {joinResult.serverDeviceName}!</span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px] text-slate-300">
                  <div>• {joinResult.vaultsCount} Vaults</div>
                  <div>• {joinResult.hostsCount} Hosts & Keys</div>
                  <div>• {joinResult.snippetsCount} Snippets</div>
                  <div>• {joinResult.keysCount} Keychain Items</div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-[11px] font-medium text-slate-300 mb-1">
                Pairing Link (copy it from the host device)
              </label>
              <input
                required
                value={joinLink}
                onChange={(e) => setJoinLink(e.target.value)}
                placeholder="nxpair://192.168.1.105:48291?pin=…&pk=…"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-slate-500">
                The link includes the host's key, so the connection is checked against that key, not just the PIN.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-300 mb-1">
                This Device Name (for peer registry)
              </label>
              <input
                value={myDeviceName}
                onChange={(e) => setMyDeviceName(e.target.value)}
                placeholder="e.g. MacBook Pro M3"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
              />
            </div>

            <div className="pt-2 flex justify-end gap-2 border-t border-white/5">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg px-4 py-2 text-xs text-slate-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={joining || !joinLink.trim()}
                className="flex items-center gap-2 rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95 disabled:opacity-50 shadow-lg"
                style={{
                  backgroundColor: accentColor,
                  color: '#000000',
                  boxShadow: `0 0 20px ${accentColor}35`,
                }}
              >
                {joining ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Cloning Vault…</span>
                  </>
                ) : (
                  <>
                    <span>Connect & Clone Vault</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </form>
        )}

        {/* Tab 3: Paired Devices List */}
        {tab === 'devices' && (
          <div className="p-5 space-y-4">
            {localInfo && (
              <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-500/20 text-cyan-300">
                    <Laptop className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-white">{localInfo.deviceName}</span>
                      <span className="rounded bg-emerald-500/20 text-emerald-300 px-1 text-[9px] font-bold border border-emerald-500/30">
                        THIS DEVICE
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {localInfo.ip} · OS: {localInfo.os}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between pb-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                <span>Authorized Peer Devices</span>
                <button onClick={loadDevices} className="text-cyan-400 hover:underline flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" /> Refresh
                </button>
              </div>

              {loadingDevices ? (
                <div className="py-8 text-center text-xs text-slate-500">Loading devices…</div>
              ) : devices.length === 0 ? (
                <div className="rounded-xl border border-white/5 bg-black/20 p-6 text-center text-xs text-slate-500">
                  No other devices paired yet. Click <strong className="text-cyan-300">Share Vault</strong> to link your laptop or desktop.
                </div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {devices.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between rounded-xl border border-white/5 bg-black/30 p-3 hover:border-white/15 transition"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="grid h-7 w-7 place-items-center rounded-lg bg-white/5 text-slate-300">
                          {d.deviceType.toLowerCase().includes('phone') || d.deviceType.toLowerCase().includes('mobile') ? (
                            <Smartphone className="h-4 w-4" />
                          ) : (
                            <Laptop className="h-4 w-4" />
                          )}
                        </div>
                        <div>
                          <div className="text-xs font-medium text-slate-200">{d.deviceName}</div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {d.ipAddress || 'LAN Peer'} · Paired {new Date(d.pairedAt * 1000).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRevoke(d.id, d.deviceName)}
                        title="Revoke device access"
                        className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
