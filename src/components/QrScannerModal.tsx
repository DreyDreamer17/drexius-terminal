import { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, X, RefreshCw, AlertCircle, Zap, ZapOff, CheckCircle2 } from 'lucide-react';
import jsQR from 'jsqr';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import type { DrexiusTheme } from '../lib/themes';
import { cn } from '../utils/cn';

interface Props {
  onScan: (data: string) => void;
  onClose: () => void;
  title?: string;
  theme?: DrexiusTheme;
}

export function QrScannerModal({
  onScan,
  onClose,
  title = 'Scan Pairing QR Code',
  theme,
}: Props) {
  const accentColor = theme?.accent ?? '#22d3ee';
  const bgColor = theme?.xterm?.background ?? '#0e131d';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Stop camera tracks cleanly
  const stopTracks = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const handleDetected = useCallback((data: string) => {
    if (scanned) return;
    setScanned(true);
    stopTracks();
    // Short success feedback then return scanned code
    setTimeout(() => {
      onScan(data);
    }, 300);
  }, [onScan, scanned, stopTracks]);

  // Frame processing loop
  const scanLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      animFrameRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      animFrameRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    ctx.drawImage(video, 0, 0, width, height);

    // 1. Try native BarcodeDetector API if available (hardware-accelerated in Chromium / Android)
    if ('BarcodeDetector' in window) {
      try {
        const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
        detector.detect(video).then((barcodes: any[]) => {
          if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
            handleDetected(barcodes[0].rawValue);
            return;
          }
        }).catch(() => {});
      } catch {}
    }

    // 2. Pure JS fallback with jsQR
    try {
      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });
      if (code && code.data) {
        handleDetected(code.data);
        return;
      }
    } catch {}

    animFrameRef.current = requestAnimationFrame(scanLoop);
  }, [handleDetected]);

  // Start camera stream
  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      setLoading(true);
      setError(null);
      stopTracks();

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera access is not supported on this platform/browser.');
        }

        // Try environment camera first, fallback to user camera if not available
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: facingMode },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        // Check if torch/flashlight is supported
        const track = stream.getVideoTracks()[0];
        if (track && 'getCapabilities' in track) {
          const caps = (track as any).getCapabilities?.() || {};
          setHasTorch(Boolean(caps.torch));
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        setLoading(false);
        animFrameRef.current = requestAnimationFrame(scanLoop);
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
            ? 'Camera permission was denied. Please allow camera permissions in app settings.'
            : err?.message || 'Could not start camera.';
          setError(msg);
          setLoading(false);
        }
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      stopTracks();
    };
  }, [facingMode, scanLoop, stopTracks]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (track && hasTorch) {
      try {
        const nextState = !torchOn;
        await (track as any).applyConstraints({
          advanced: [{ torch: nextState }],
        });
        setTorchOn(nextState);
      } catch {}
    }
  };

  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  return (
    <ResponsiveOverlay
      label="QR Code Scanner"
      onClose={() => {
        stopTracks();
        onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet relative flex flex-col w-full max-w-sm rounded-2xl border shadow-2xl overflow-hidden text-slate-200"
        style={{
          backgroundColor: bgColor,
          borderColor: `${accentColor}35`,
          '--nx-accent': accentColor,
        } as React.CSSProperties}
      >
        <SheetHandle
          onClose={() => {
            stopTracks();
            onClose();
          }}
        />

        {/* Modal Header */}
        <div className="relative flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div
              className="grid h-8 w-8 place-items-center rounded-xl border shadow-sm"
              style={{
                backgroundColor: `${accentColor}18`,
                borderColor: `${accentColor}35`,
                color: accentColor,
              }}
            >
              <Camera className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-white tracking-wide">{title}</h3>
              <p className="text-[10px] text-slate-400">Point your camera at the QR code</p>
            </div>
          </div>
          <button
            onClick={() => {
              stopTracks();
              onClose();
            }}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Viewfinder Container */}
        <div className="relative w-full aspect-square bg-black overflow-hidden flex items-center justify-center">
          {/* Video Stream */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />

          {/* Offscreen Canvas for analysis */}
          <canvas ref={canvasRef} className="hidden" />

          {/* Camera Scanning Frame Overlay */}
          {!error && !loading && (
            <div className="relative z-10 w-3/4 h-3/4 flex items-center justify-center">
              {/* Corner brackets */}
              <div
                className="absolute inset-0 rounded-2xl border-2 pointer-events-none transition"
                style={{
                  borderColor: scanned ? '#34d399' : `${accentColor}80`,
                  boxShadow: scanned ? '0 0 24px rgba(52, 211, 153, 0.6)' : `0 0 16px ${accentColor}30`,
                }}
              />

              {/* Animated scanline */}
              {!scanned && (
                <div
                  className="absolute inset-x-2 h-0.5 rounded-full animate-pulse shadow-lg pointer-events-none"
                  style={{
                    backgroundColor: accentColor,
                    boxShadow: `0 0 12px ${accentColor}, 0 0 4px #ffffff`,
                    top: '50%',
                    animation: 'scanline 2s ease-in-out infinite',
                  }}
                />
              )}

              {/* Scanned success checkmark */}
              {scanned && (
                <div className="grid h-16 w-16 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-400/40 animate-in zoom-in-75 duration-200">
                  <CheckCircle2 className="h-10 w-10" />
                </div>
              )}
            </div>
          )}

          {/* Loading spinner */}
          {loading && !error && (
            <div className="relative z-10 flex flex-col items-center gap-2 text-slate-400 text-xs">
              <RefreshCw className="h-6 w-6 animate-spin" style={{ color: accentColor }} />
              <span>Starting camera…</span>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="relative z-10 m-4 flex flex-col items-center text-center p-4 rounded-xl border border-rose-500/30 bg-rose-950/80 text-rose-200 text-xs space-y-2">
              <AlertCircle className="h-8 w-8 text-rose-400" />
              <p className="font-semibold text-rose-100">Camera Unavailable</p>
              <p className="text-[11px] text-rose-300/90 leading-relaxed">{error}</p>
            </div>
          )}
        </div>

        {/* Viewfinder Controls Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-white/10 bg-black/40 text-xs">
          <div className="flex items-center gap-2">
            {hasTorch && (
              <button
                type="button"
                onClick={toggleTorch}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 transition',
                  torchOn ? 'border-amber-400/50 bg-amber-400/20 text-amber-200' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                )}
                title="Toggle Flashlight"
              >
                {torchOn ? <Zap className="h-3.5 w-3.5 text-amber-400" /> : <ZapOff className="h-3.5 w-3.5" />}
                <span className="text-[11px]">Flash</span>
              </button>
            )}

            <button
              type="button"
              onClick={toggleFacingMode}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300 hover:bg-white/10 transition text-[11px]"
              title="Flip camera"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Flip</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              stopTracks();
              onClose();
            }}
            className="rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
