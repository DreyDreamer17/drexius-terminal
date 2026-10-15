import { useEffect, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

/** What a phone gesture on the terminal resolved to (coordinates are client pixels). */
export type TerminalTouchGesture =
  | { kind: 'touch'; x: number; y: number }   // any finger down — dismisses floating UI
  | { kind: 'select'; x: number; y: number }  // long-press on a word: it is now selected
  | { kind: 'menu'; x: number; y: number }    // long-press on blank space: offer paste / select all
  // two-finger pinch: `scale` is the current finger distance over the distance at 'start'
  | { kind: 'pinch'; phase: 'start' | 'move' | 'end'; scale: number; x: number; y: number };

/** Capture touch scroll before xterm's own handler to avoid double scrolling.
 * Fractional rows accumulate and momentum decays in time, not per device frame.
 * A second finger turns the gesture into a pinch (reported as a continuous scale; the pane
 * previews and commits the font size). Desktop mouse selection and wheel handling remain
 * entirely owned by xterm.
 */
export function useTerminalTouch(element: RefObject<HTMLDivElement | null>, terminal: RefObject<Terminal | null>, enabled: boolean, onGesture: (gesture: TerminalTouchGesture) => void) {
  useEffect(() => {
    const el = element.current, term = terminal.current;
    if (!enabled || !el || !term) return;
    let hold = 0, frame = 0, startX = 0, startY = 0, lastY = 0, lastTime = 0;
    let velocity = 0, remainder = 0, moved = false, held = false;
    // Pinch state: distance between the two fingers at the start, and whether fingers are still
    // settling after a pinch (the last finger to lift must not turn into a scroll or a tap).
    let pinchBase = 0, pinchScale = 1, pinching = false, settling = false;
    const stop = () => { clearTimeout(hold); cancelAnimationFrame(frame); };
    const pinchGeometry = (t: TouchList) => ({
      distance: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
      x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2,
    });
    const beginPinch = (t: TouchList) => {
      stop(); velocity = 0; moved = false; held = false;
      const g = pinchGeometry(t);
      pinchBase = Math.max(1, g.distance); pinchScale = 1; pinching = true; settling = true;
      onGesture({ kind: 'pinch', phase: 'start', scale: 1, x: g.x, y: g.y });
    };
    const rowHeight = () => (el.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? el.clientHeight) / term.rows;
    const scroll = (pixels: number) => {
      remainder += pixels / Math.max(1, rowHeight());
      const lines = Math.trunc(remainder);
      if (!lines) return;
      if (term.buffer.active.type === 'alternate') {
        const isApp = term.modes.applicationCursorKeysMode;
        const key = lines > 0 ? (isApp ? '\x1bOB' : '\x1b[B') : (isApp ? '\x1bOA' : '\x1b[A');
        const count = Math.min(Math.abs(lines), 4);
        for (let i = 0; i < count; i++) {
          term.input(key, true);
        }
        remainder -= lines;
      } else {
        term.scrollLines(lines);
        remainder -= lines;
      }
    };
    const selectWord = (x: number, y: number) => {
      const rect = el.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!rect) return;
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / (rect.width / term.cols))));
      const row = term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / (rect.height / term.rows))));
      const line = term.buffer.active.getLine(row);
      const isWord = (c: number) => !!line?.getCell(c)?.getChars().match(/\S/);
      try { navigator.vibrate?.(8); } catch { /* not available */ }
      if (!isWord(col)) { term.clearSelection(); onGesture({ kind: 'menu', x, y }); return; }
      let left = col, right = col;
      while (left > 0 && isWord(left - 1)) left--;
      while (right < term.cols - 1 && isWord(right + 1)) right++;
      term.select(left, row, right - left + 1);
      onGesture({ kind: 'select', x, y });
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) { beginPinch(e.touches); return; }
      if (e.touches.length > 2) { stop(); return; }
      stop(); velocity = 0; remainder = 0; moved = false; held = false; settling = false;
      startX = e.touches[0].clientX; startY = lastY = e.touches[0].clientY; lastTime = performance.now();
      onGesture({ kind: 'touch', x: startX, y: startY });
      hold = window.setTimeout(() => { held = true; selectWord(startX, startY); }, 500);
    };
    const move = (e: TouchEvent) => {
      if (pinching && e.touches.length >= 2) {
        e.preventDefault(); e.stopImmediatePropagation();
        const g = pinchGeometry(e.touches);
        pinchScale = g.distance / pinchBase;
        onGesture({ kind: 'pinch', phase: 'move', scale: pinchScale, x: g.x, y: g.y });
        return;
      }
      if (e.touches.length !== 1 || settling) { stop(); return; }
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
      if (pinching && e.touches.length < 2) {
        pinching = false;
        e.preventDefault(); e.stopImmediatePropagation();
        onGesture({ kind: 'pinch', phase: 'end', scale: pinchScale, x: 0, y: 0 });
        return;
      }
      if (settling) { if (e.touches.length === 0) settling = false; e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (held || moved) { e.preventDefault(); e.stopImmediatePropagation(); }
      if (!moved || held || performance.now() - lastTime > 100 || term.buffer.active.type === 'alternate') return;
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
    const cancel = () => {
      stop();
      if (pinching) { pinching = false; settling = false; onGesture({ kind: 'pinch', phase: 'end', scale: pinchScale, x: 0, y: 0 }); }
    };
    el.addEventListener('touchcancel', cancel, { capture: true });
    return () => {
      stop();
      el.removeEventListener('touchstart', start, true);
      el.removeEventListener('touchmove', move, true);
      el.removeEventListener('touchend', end, true);
      el.removeEventListener('touchcancel', cancel, true);
    };
  }, [element, terminal, enabled, onGesture]);
}
