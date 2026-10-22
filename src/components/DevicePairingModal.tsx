import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import { useEffect, useRef, useState } from 'react';
import {
  Laptop,
  Smartphone,
  QrCode,
  Camera,
  ShieldCheck,
  Copy,
  Check,
  X,
  RefreshCw,
  ArrowRight,
  Trash2,
  Ban,
  CheckCircle2,
  Share2,
  Lock,
  Wifi,
} from 'lucide-react';
import QRCode from 'qrcode';
import { listen } from '@tauri-apps/api/event';
import type { DiscoveredPairingHost, LocalDeviceInfo, PairedDevice, PairingHostInfo, PairingJoinResult } from '../lib/types';
import { bridge, isTauri } from '../lib/bridge';
import { cn } from '../utils/cn';

interface ParsedPairingLink {
  host: string;
  port: number;
  pin: string;
  serverPublicKey: string;
}

/** Parses a drxpair:// (or legacy nxpair://) link: host, port, 6-digit PIN, and the host's pinned X25519 public key (hex). */
function parsePairingLink(link: string): ParsedPairingLink {
  const m = link.trim().match(/^(?:drxpair|nxpair):\/\/([^:/?#\s]+):(\d{1,5})\?(\S+)$/);
  if (!m) throw new Error('That is not a valid pairing link. Copy it from the host device.');
  const params = new URLSearchParams(m[3]);
  const pin = (params.get('pin') || '').replace(/\D/g, '');
  const pk = (params.get('pk') || '').trim();
  if (pin.length !== 6) throw new Error('The pairing link does not contain a valid 6-digit code.');
  if (!/^[0-9a-fA-F]{64}$/.test(pk)) throw new Error('The pairing link does not contain a valid host key.');
  return { host: m[1], port: parseInt(m[2], 10), pin, serverPublicKey: pk.toLowerCase() };
}
import { THEMES, type DrexiusTheme } from '../lib/themes';
import { confirmDialog } from './ConfirmDialog';
import { QrScannerModal } from './QrScannerModal';

interface Props {
  onClose: () => void;
  onRefresh: () => Promise<void>;
  toast: (msg: string) => void;
  initialTab?: 'share' | 'join' | 'devices';
  theme?: DrexiusTheme;
}

export function DevicePairingModal({
  onClose,
  onRefresh,
  toast,
  initialTab = 'share',
  theme,
}: Props) {
  const activeTheme = theme || THEMES.find((t) => t.id === (localStorage.getItem('drx.theme') ?? 'drexius')) || THEMES[0];
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
  const [joinPin, setJoinPin] = useState('');
  const [selectedPk, setSelectedPk] = useState('');
  const [discoveredHosts, setDiscoveredHosts] = useState<DiscoveredPairingHost[]>([]);
  const [discoveringLan, setDiscoveringLan] = useState(false);
  const pinInputRef = useRef<HTMLInputElement | null>(null);
  const [myDeviceName, setMyDeviceName] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinResult, setJoinResult] = useState<PairingJoinResult | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);

  // Devices list state
  const [localInfo, setLocalInfo] = useState<LocalDeviceInfo | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  // PIN owned by the currently-live Share effect, if any. Only the owner may
  // stop the backend listener. A stale start (StrictMode remount, rapid tab
  // switch) must never stop: backend `install` reuses the live session (same
  // PIN) for concurrent starts, so a stale `stop` would kill the session the
  // current effect is displaying while the banner keeps showing its QR.
  const pairingOwnerPin = useRef<string | null>(null);

  // ── Start Host pairing listener when in 'share' tab ──
  // NOTE: listener lifecycle depends only on `tab` so changing theme/accent
  // does not invalidate the active PIN/QR link. QR recoloring is handled
  // by a separate effect below. A generation counter guards rapid
  // Share -> Join -> Share switches so a stale stop cannot kill the newest
  // listener and a stale start response cannot overwrite it.
  const pairingSeq = useRef(0);
  useEffect(() => {
    let disposed = false;
    let ownedPin: string | null = null;

    if (tab === 'share') {
      const seq = ++pairingSeq.current;
      setHostInfo(null);
      setQrDataUrl('');
      setHostingError(null);
      bridge.pairingStartHost()
        .then((info) => {
          if (disposed || pairingSeq.current !== seq) return;
          ownedPin = info.pin;
          pairingOwnerPin.current = info.pin;
          setHostInfo(info);
        })
        .catch((err) => {
          if (!disposed && pairingSeq.current === seq) setHostingError(String(err?.message || err));
        });
      return () => {
        disposed = true;
        // Only the owning effect stops, using its own PIN — never a shared
        // ref that may already point at a newer session's PIN.
        if (pairingSeq.current === seq && ownedPin) {
          pairingOwnerPin.current = null;
          void bridge.pairingStopHost(ownedPin).catch(() => {});
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
        toast(`Two-way LAN sync completed with ${event.payload.deviceName}!`);
        onRefresh();
        void loadDevices();
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

  const discoverLanHosts = async () => {
    setDiscoveringLan(true);
    try {
      const found = await bridge.pairingDiscoverLan();
      setDiscoveredHosts(found);
      if (found.length === 1 && !joinLink.trim()) {
        setJoinLink(`${found[0].ip}:${found[0].port}`);
        setSelectedPk(found[0].serverPublicKey);
      }
    } catch {
      // Ignore discovery errors
    } finally {
      setDiscoveringLan(false);
    }
  };

  useEffect(() => {
    if (tab === 'join') {
      discoverLanHosts();
    }
  }, [tab]);

  const handleHostInputChange = (val: string) => {
    const trimmed = val.trim();
    if (trimmed.startsWith('drxpair://') || trimmed.startsWith('nxpair://')) {
      try {
        const parsed = parsePairingLink(trimmed);
        setJoinLink(`${parsed.host}:${parsed.port}`);
        setJoinPin(parsed.pin);
        setSelectedPk(parsed.serverPublicKey);
        return;
      } catch {
        // Fall through and store raw value if still typing/incomplete
      }
    }
    setJoinLink(val);
    setSelectedPk('');
  };

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

  const executeJoin = async (directLink?: string) => {
    let host = '';
    let port = 0;
    let pin = '';
    let pk = selectedPk;

    const candidate = (directLink ?? joinLink).trim();
    if (candidate.startsWith('drxpair://') || candidate.startsWith('nxpair://')) {
      try {
        const parsed = parsePairingLink(candidate);
        host = parsed.host;
        port = parsed.port;
        pin = parsed.pin;
        pk = parsed.serverPublicKey;
      } catch (err: any) {
        setJoinError(err?.message || 'Invalid pairing link');
        return;
      }
    } else {
      const cleanedHost = candidate.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
      const colonIdx = cleanedHost.lastIndexOf(':');
      if (colonIdx <= 0) {
        setJoinError('Enter the host address as IP:Port (e.g. 192.168.1.105:48291) or select a nearby device above.');
        return;
      }
      host = cleanedHost.slice(0, colonIdx).trim();
      port = parseInt(cleanedHost.slice(colonIdx + 1).trim(), 10);
      if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
        setJoinError('Invalid host IP or port number.');
        return;
      }
      pin = joinPin.replace(/\D/g, '');
      if (pin.length !== 6) {
        setJoinError('Enter the 6-digit PIN code shown on the host device.');
        return;
      }
    }

    setJoining(true);
    setJoinError(null);
    setJoinResult(null);

    try {
      const res = await bridge.pairingJoinClient(
        host,
        port,
        pin,
        pk,
        myDeviceName.trim() || undefined
      );
      setJoinResult(res);
      await onRefresh();
      void loadDevices();
      if (res.syncReady) {
        try {
          await bridge.syncNow();
          await onRefresh();
          toast(`Two-way LAN sync + relay sync completed with ${res.serverDeviceName}`);
        } catch (syncError) {
          toast(`Two-way LAN sync completed; relay sync needs attention: ${String(syncError)}`);
        }
      } else {
        toast(`Two-way LAN sync completed with ${res.serverDeviceName}`);
      }
    } catch (err: any) {
      setJoinError(err?.message || String(err) || 'Failed to connect to host');
    } finally {
      setJoining(false);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeJoin();
  };

  const handleRemove = async (id: string, name: string) => {
    try {
      await bridge.pairingRemoveDevice(id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      toast(`Removed ${name} from list`);
    } catch (err: any) {
      toast(`Failed to remove: ${err?.message || err}`);
    }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!(await confirmDialog({
      title: `Revoke pairing for "${name}"?`,
      message: 'It will be blocked from pairing again.\n\nNote: it keeps the data it already received — rotate host credentials to fully cut its access.',
      confirmLabel: 'Revoke',
      danger: true,
    }))) return;
    try {
      await bridge.pairingRevokeDevice(id);
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, revokedAt: Math.floor(Date.now() / 1000) } : d)));
      toast(`Revoked ${name}`);
    } catch (err: any) {
      toast(`Revocation failed: ${err?.message || err}`);
    }
  };

  const handleAllow = async (id: string, name: string) => {
    try {
      await bridge.pairingAllowDevice(id);
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, revokedAt: null } : d)));
      toast(`${name} can pair again`);
    } catch (err: any) {
      toast(`Failed: ${err?.message || err}`);
    }
  };

  return (
    <ResponsiveOverlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClose={handleClose} label="Device pairing"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: bgColor }}
      >
        <SheetHandle onClose={handleClose} />
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
                X25519 Authenticated Key Exchange · LAN Enrollment
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
                <h4 className="text-sm font-semibold text-emerald-200">Two-Way LAN Sync Complete!</h4>
                <p className="text-xs text-slate-300">
                  Synchronized vaults in both directions with <strong className="text-white">{pairedSuccessPeer.deviceName}</strong> ({pairedSuccessPeer.ip}).
                </p>
                <div className="pt-2">
                  <button
                    onClick={() => setPairedSuccessPeer(null)}
                    className="rounded-lg bg-emerald-500/20 border border-emerald-400/40 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30 transition"
                  >
                    Sync or pair another device
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
                Performs a <strong className="text-slate-200">two-way LAN sync</strong> (additions, newest edits, and deletions in both directions). Select a nearby device on Wi-Fi or enter its <span className="font-mono text-slate-300">IP:Port</span> and 6-digit PIN.
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
                  <span>Two-way LAN sync completed with {joinResult.serverDeviceName}!</span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px] text-slate-300">
                  <div>• {joinResult.vaultsCount} Vaults</div>
                  <div>• {joinResult.hostsCount} Hosts & Keys</div>
                  <div>• {joinResult.snippetsCount} Snippets</div>
                  <div>• {joinResult.keysCount} Keychain Items</div>
                </div>
                <p className="mt-2 text-[11px] text-slate-300">
                  {joinResult.syncReady
                    ? 'Both devices merged each other’s changes, and shared relay settings are installed.'
                    : 'Both devices merged each other’s changes over LAN (newest edit wins, deletions synced). Re-link anytime to sync without a relay.'}
                </p>
              </div>
            )}

            {/* Nearby Devices on LAN (Auto-Discovery) */}
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                  <Wifi className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Nearby Devices Sharing on Wi-Fi</span>
                </div>
                <button
                  type="button"
                  onClick={discoverLanHosts}
                  disabled={discoveringLan}
                  className="flex items-center gap-1 text-[10px] text-cyan-400 hover:underline disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${discoveringLan ? 'animate-spin' : ''}`} />
                  <span>{discoveringLan ? 'Scanning…' : 'Scan LAN'}</span>
                </button>
              </div>

              {discoveredHosts.length === 0 ? (
                <div className="text-[11px] text-slate-500 py-1">
                  {discoveringLan
                    ? 'Searching local network for devices in "Share Vault" mode…'
                    : 'No nearby host detected automatically. Make sure the other device has "Share Vault" open, or enter its IP:Port below.'}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {discoveredHosts.map((h) => {
                    const addr = `${h.ip}:${h.port}`;
                    const isSelected = joinLink.trim() === addr;
                    return (
                      <button
                        key={addr}
                        type="button"
                        onClick={() => {
                          setJoinLink(addr);
                          setSelectedPk(h.serverPublicKey);
                          pinInputRef.current?.focus();
                        }}
                        className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                          isSelected
                            ? 'border-cyan-400/50 bg-cyan-500/15 text-white'
                            : 'border-white/10 bg-black/40 text-slate-300 hover:border-white/25'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <Laptop className="h-4 w-4 text-cyan-400 shrink-0" />
                          <div>
                            <div className="text-xs font-semibold">{h.deviceName}</div>
                            <div className="text-[10px] font-mono text-slate-400">
                              {addr} · {h.os}
                            </div>
                          </div>
                        </div>
                        <span className="rounded bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                          {isSelected ? 'Selected' : 'Select'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Host IP:Port + 6-Digit PIN Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Host Address (<span className="font-mono">IP:Port</span> or Pairing Link)
                </label>
                <input
                  required
                  value={joinLink}
                  onChange={(e) => handleHostInputChange(e.target.value)}
                  placeholder="192.168.1.105:48291 or drxpair://…"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  6-Digit PIN Code
                </label>
                <input
                  ref={pinInputRef}
                  value={joinPin}
                  onChange={(e) => setJoinPin(e.target.value.replace(/[^\d-]/g, '').slice(0, 7))}
                  placeholder="123-456"
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-full rounded-lg border border-cyan-400/30 bg-black/50 px-3 py-2 font-mono text-sm font-bold tracking-widest text-cyan-300 text-center placeholder:text-slate-600 placeholder:font-normal focus:border-cyan-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span className="text-[10px] text-slate-500">
                Have a camera? Scan the QR code instead of typing:
              </span>
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10 transition shrink-0"
              >
                <Camera className="h-3.5 w-3.5 text-cyan-400" />
                <span>Scan QR Code</span>
              </button>
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
                          {['phone', 'mobile', 'android', 'ios'].some((k) => d.deviceType.toLowerCase().includes(k)) ? (
                            <Smartphone className="h-4 w-4" />
                          ) : (
                            <Laptop className="h-4 w-4" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-slate-200">{d.deviceName}</span>
                            {d.revokedAt != null && (
                              <span className="rounded bg-rose-500/20 px-1 py-0.5 text-[9px] font-semibold text-rose-300">
                                REVOKED
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {d.ipAddress || 'LAN Peer'} · Paired {new Date(d.pairedAt * 1000).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {d.revokedAt == null && d.ipAddress && (
                          <button
                            onClick={() => {
                              setJoinLink(`${d.ipAddress}:48291`);
                              setSelectedPk('');
                              setJoinPin('');
                              setTab('join');
                              setTimeout(() => pinInputRef.current?.focus(), 80);
                            }}
                            title="Two-way sync with this device over LAN (open Share Vault on the other device)"
                            className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/20 transition mr-1"
                          >
                            <RefreshCw className="h-3 w-3" />
                            <span>Sync LAN</span>
                          </button>
                        )}
                        {d.revokedAt != null ? (
                          <button
                            onClick={() => handleAllow(d.id, d.deviceName)}
                            title="Allow this device to pair again (still requires a fresh PIN)"
                            className="rounded p-1.5 text-slate-500 hover:bg-emerald-500/20 hover:text-emerald-300 transition"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRevoke(d.id, d.deviceName)}
                            title="Block this device from pairing again"
                            className="rounded p-1.5 text-slate-500 hover:bg-amber-500/20 hover:text-amber-300 transition"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => handleRemove(d.id, d.deviceName)}
                          title="Remove from device list"
                          className="rounded p-1.5 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300 transition"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {showScanner && (
        <QrScannerModal
          theme={activeTheme}
          title="Scan Pairing QR Code"
          onScan={(scanned) => {
            setShowScanner(false);
            handleHostInputChange(scanned);
            toast('QR code scanned! Connecting…');
            executeJoin(scanned);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </ResponsiveOverlay>
  );
}
