import { useEffect, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

/** Capture touch scroll before xterm's own handler to avoid double scrolling.
 * Fractional rows accumulate and momentum decays in time, not per device frame.
 * Desktop mouse selection and wheel handling remain entirely owned by xterm.
 */
export function useTerminalTouch(element: RefObject<HTMLDivElement | null>, terminal: RefObject<Terminal | null>, enabled: boolean, onSelect: () => void) {
  useEffect(() => {
    const el = element.current, term = terminal.current;
    if (!enabled || !el || !term) return;
    let hold = 0, frame = 0, startX = 0, startY = 0, lastY = 0, lastTime = 0;
    let velocity = 0, remainder = 0, moved = false, held = false;
    const stop = () => { clearTimeout(hold); cancelAnimationFrame(frame); };
    const rowHeight = () => (el.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? el.clientHeight) / term.rows;
    const scroll = (pixels: number) => {
      remainder += pixels / Math.max(1, rowHeight());
      const lines = Math.trunc(remainder);
      if (lines) { term.scrollLines(lines); remainder -= lines; }
    };
    const selectWord = (x: number, y: number) => {
      const rect = el.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!rect) return;
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / (rect.width / term.cols))));
      const row = term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / (rect.height / term.rows))));
      const line = term.buffer.active.getLine(row);
      const isWord = (c: number) => !!line?.getCell(c)?.getChars().match(/\S/);
      let left = col, right = col;
      if (isWord(col)) {
        while (left > 0 && isWord(left - 1)) left--;
        while (right < term.cols - 1 && isWord(right + 1)) right++;
      }
      term.select(left, row, right - left + 1);
      onSelect();
    };
    const start = (e: TouchEvent) => {
      stop(); velocity = 0; remainder = 0; moved = false; held = false;
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX; startY = lastY = e.touches[0].clientY; lastTime = performance.now();
      hold = window.setTimeout(() => { held = true; selectWord(startX, startY); }, 500);
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 1) { stop(); return; }
      const y = e.touches[0].clientY;
      if (Math.hypot(y - startY, e.touches[0].clientX - startX) > 8) { clearTimeout(hold); moved = true; }
      if (!moved && !held) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!held) {
        const now = performance.now();
        const delta = lastY - y;
        velocity = delta / Math.max(8, now - lastTime);
        scroll(delta); lastY = y; lastTime = now;
      }
    };
    const end = (e: TouchEvent) => {
      clearTimeout(hold);
      if (held || moved) { e.preventDefault(); e.stopImmediatePropagation(); }
      if (!moved || held || performance.now() - lastTime > 100) return;
      let previous = performance.now();
      const coast = (now: number) => {
        const dt = Math.min(32, now - previous); previous = now;
        velocity *= Math.exp(-dt / 180);
        scroll(velocity * dt);
        if (Math.abs(velocity) > 0.015) frame = requestAnimationFrame(coast);
      };
      frame = requestAnimationFrame(coast);
    };
    el.addEventListener('touchstart', start, { passive: true, capture: true });
    el.addEventListener('touchmove', move, { passive: false, capture: true });
    el.addEventListener('touchend', end, { passive: false, capture: true });
    el.addEventListener('touchcancel', stop, { capture: true });
    return () => {
      stop();
      el.removeEventListener('touchstart', start, true);
      el.removeEventListener('touchmove', move, true);
      el.removeEventListener('touchend', end, true);
      el.removeEventListener('touchcancel', stop, true);
    };
  }, [element, terminal, enabled, onSelect]);
}
