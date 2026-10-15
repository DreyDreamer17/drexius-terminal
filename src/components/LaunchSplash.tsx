import { useEffect, useState } from 'react';
import { SplashScreen } from './SplashScreen';

export function LaunchSplash({ onFinished }: { onFinished: () => void }) {
  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (prefersReducedMotion) {
      setProgress(100);
      setFading(true);
      const timer = setTimeout(onFinished, 100);
      return () => clearTimeout(timer);
    }

    let start: number | null = null;
    let frame: number;
    const duration = 2000; // 2 seconds initial launch sequence
    const update = (now: number) => {
      if (start === null) start = now;
      const elapsed = now - start;
      const fraction = Math.min(elapsed / duration, 1);
      // Gentle start, faster middle, gentle settle
      const eased = fraction < 0.15
        ? fraction * 0.65
        : 0.0975 + (1 - Math.pow(1 - (fraction - 0.15) / 0.85, 1.5)) * 0.9025;
      setProgress(eased * 100);
      if (fraction < 1) {
        frame = requestAnimationFrame(update);
      } else {
        setFading(true);
        setTimeout(onFinished, 350);
      }
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [onFinished]);

  const handleSkip = () => {
    setFading(true);
    setTimeout(onFinished, 150);
  };

  return (
    <div
      onClick={handleSkip}
      role="presentation"
      className={`fixed inset-0 z-[2000] cursor-pointer transition-opacity duration-300 ${
        fading ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <SplashScreen
        appearance="signature"
        progress={progress}
        session={0}
        fullscreen={true}
      />
    </div>
  );
}
