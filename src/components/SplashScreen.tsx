import { BatteryFull, Check, ShieldCheck, Signal, Wifi } from 'lucide-react';
import type { CSSProperties } from 'react';
import { appearances, type Appearance } from '../lib/artwork';
import { NetworkBackdrop, NetworkMark, Wordmark } from './DrexiusArt';

export function SplashScreen({
  appearance,
  progress,
  session,
  fullscreen = false,
}: {
  appearance: Appearance;
  progress: number;
  session: number;
  fullscreen?: boolean;
}) {
  const theme = appearances[appearance];
  const complete = progress >= 100;
  const status = complete
    ? 'Secure session established'
    : progress < 36
      ? 'Initializing secure session...'
      : progress < 75
        ? 'Securing your connection...'
        : 'Almost connected...';
  const style = {
    '--screen-bg': theme.background,
    '--screen-fg': theme.foreground,
    '--screen-muted': theme.muted,
    '--screen-network': theme.network,
  } as CSSProperties;

  return (
    <div className={`splash-screen appearance-${appearance} ${fullscreen ? 'splash-fullscreen' : ''}`} style={style}>
      <div className="screen-atmosphere" />
      <NetworkBackdrop />
      {!fullscreen && (
        <>
          <div className="android-status" aria-hidden="true">
            <span>9:41</span>
            <div><Signal size={11} fill="currentColor" /><Wifi size={11} strokeWidth={2.4} /><BatteryFull size={15} strokeWidth={1.7} /></div>
          </div>
          <div className="camera-cutout" />
        </>
      )}
      <div className="splash-brand" key={session}>
        <NetworkMark className="splash-symbol" animated />
        <Wordmark className="splash-wordmark" />
        <p className="splash-tagline">Secure connections. Anywhere.</p>
      </div>
      <div className={`splash-loading ${complete ? 'is-complete' : ''}`}>
        <div
          className="loading-track"
          role="progressbar"
          aria-label="Secure connection launch preview"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div className="loading-fill" style={{ width: `${Math.max(3, progress)}%` }} />
        </div>
        <p className="loading-status" aria-live="polite" aria-atomic="true">
          {complete && <Check size={9} />}{status}
        </p>
      </div>
      <div className="privacy-signature"><ShieldCheck /><span>PRIVATE BY DESIGN</span></div>
      {!fullscreen && <div className="gesture-bar" aria-hidden="true" />}
    </div>
  );
}