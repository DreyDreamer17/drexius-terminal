import { useEffect, useState } from 'react';

export const mobileQuery = '(max-width: 767px)';
export function useMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(mobileQuery);
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
