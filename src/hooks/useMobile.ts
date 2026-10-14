import { useEffect, useState } from 'react';

/**
 * Single source of truth for the phone layout.
 *
 * A phone is any touch-first device whose screen's shorter edge fits in a hand
 * (≤ 480 CSS px) — in *either* orientation, so rotating to landscape never drops
 * the user into the desktop chrome mid-session. Narrow windows (< 768px) on any
 * device use the phone layout too. `device-width/height` are screen-based, so the
 * virtual keyboard shrinking the viewport can't flip the layout while typing.
 *
 * The Tailwind `md` / `max-md` variants and the mobile CSS blocks in index.css are
 * compiled from this same expression (see the `@custom-variant` declarations there).
 * Keep them in sync.
 */
export const mobileQuery =
  '(width < 768px) or ((pointer: coarse) and ((max-device-width: 480px) or (max-device-height: 480px)))';

/** Same test in Media Queries Level 3 syntax for engines without MQ4 boolean logic. */
const legacyMobileQuery =
  '(max-width: 767px), (pointer: coarse) and (max-device-width: 480px), (pointer: coarse) and (max-device-height: 480px)';

export function mobileMedia(): MediaQueryList {
  const modern = window.matchMedia(mobileQuery);
  // An unparseable query yields `media: "not all"` rather than throwing.
  return modern.media === 'not all' ? window.matchMedia(legacyMobileQuery) : modern;
}

export function useMobile() {
  const [mobile, setMobile] = useState(() => mobileMedia().matches);
  useEffect(() => {
    const query = mobileMedia();
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

/** Resize the shell, not just a fixed toolbar: xterm gets the actual remaining space.
 * offsetTop also handles Safari panning the visual viewport to a focused input.
 */
export function useMobileViewport() {
  useEffect(() => {
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
