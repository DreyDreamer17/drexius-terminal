import { useEffect, useState } from 'react';
import { isTauri } from '../lib/bridge';
import { isAndroidPlatform } from '../lib/os';

/** Check if current window was popped out into a standalone window. */
export function isPopoutContext(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  return new URLSearchParams(window.location.search).get('popout') === '1';
}

/** Check if the app is running as a native desktop Tauri app (Linux, macOS, Windows). */
export function isDesktopApp(): boolean {
  return isTauri && !isAndroidPlatform();
}

/**
 * Single source of truth for the phone layout.
 *
 * A phone is a touch-first device (pointer: coarse) whose screen's shorter edge fits in a hand
 * (≤ 480 CSS px) — in *either* orientation, so rotating to landscape never drops
 * the user into the desktop chrome mid-session. Narrow touch-screen viewports (< 768px)
 * use the phone layout too. Desktop apps and desktop browsers with a mouse (pointer: fine)
 * never switch into phone layout regardless of window width.
 *
 * The Tailwind `md` / `max-md` variants and the mobile CSS blocks in index.css are
 * compiled from this same expression (see the `@custom-variant` declarations there).
 * Keep them in sync.
 */
export const mobileQuery =
  '((pointer: coarse) and (width < 768px)) or ((pointer: coarse) and ((max-device-width: 480px) or (max-device-height: 480px)))';

/** Same test in Media Queries Level 3 syntax for engines without MQ4 boolean logic. */
const legacyMobileQuery =
  '(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-device-width: 480px), (pointer: coarse) and (max-device-height: 480px)';

export function mobileMedia(): MediaQueryList {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList;
  }
  const modern = window.matchMedia(mobileQuery);
  // An unparseable query yields `media: "not all"` rather than throwing.
  return modern.media === 'not all' ? window.matchMedia(legacyMobileQuery) : modern;
}

export function useMobile() {
  const isDesktopOrPopout = typeof window !== 'undefined' && (isPopoutContext() || isDesktopApp());
  const [mobile, setMobile] = useState(() => (isDesktopOrPopout ? false : mobileMedia().matches));
  useEffect(() => {
    if (isDesktopOrPopout) {
      setMobile(false);
      return;
    }
    const query = mobileMedia();
    const update = () => setMobile(query.matches);
    query.addEventListener?.('change', update);
    update();
    return () => query.removeEventListener?.('change', update);
  }, [isDesktopOrPopout]);
  return mobile;
}

/** Resize the shell, not just a fixed toolbar: xterm gets the actual remaining space.
 * offsetTop also handles Safari panning the visual viewport to a focused input.
 */
export function useMobileViewport() {
  useEffect(() => {
    if (typeof window === 'undefined' || isPopoutContext() || isDesktopApp()) return;
    const viewport = window.visualViewport;
    let frame = 0;
    let baseline = window.innerHeight;
    let width = window.innerWidth;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.documentElement;
        const height = viewport?.height ?? window.innerHeight;
        if (window.innerWidth !== width) { width = window.innerWidth; baseline = window.innerHeight; }
        baseline = Math.max(baseline, window.innerHeight, height);
        root.style.setProperty('--nx-viewport-height', `${height}px`);
        root.style.setProperty('--nx-viewport-top', `${viewport?.offsetTop ?? 0}px`);
        const focused = document.activeElement as HTMLElement | null;
        const editing = focused?.matches('input, textarea, [contenteditable="true"]') ?? false;
        const keyboard = editing && (viewport?.scale ?? 1) === 1 && Math.max(baseline, window.innerHeight) - height > 120;
        root.dataset.keyboard = String(keyboard);
      });
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('focusin', update);
    window.addEventListener('focusout', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('focusin', update);
      window.removeEventListener('focusout', update);
      document.documentElement.style.removeProperty('--nx-viewport-height');
      document.documentElement.style.removeProperty('--nx-viewport-top');
      delete document.documentElement.dataset.keyboard;
    };
  }, []);
}
