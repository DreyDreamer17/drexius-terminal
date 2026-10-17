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
 * Supports:
 * - Native scrollback in normal shell buffers
 * - SGR / DEC mouse wheel events and direct tap-clicks in interactive TUIs (OpenCode, lazygit, htop, etc.)
 * - Cursor key scrolling in non-mouse alternate buffers (less, man, etc.)
 * - Pinch-to-zoom font scaling
 * - Long-press for selection or context menu
 */
export function useTerminalTouch(
  element: RefObject<HTMLDivElement | null>,
  terminal: RefObject<Terminal | null>,
  enabled: boolean,
  onGesture: (gesture: TerminalTouchGesture) => void
) {
  useEffect(() => {
    const el = element.current,
      term = terminal.current;
    if (!enabled || !el || !term) return;

    let hold = 0,
      frame = 0,
      startX = 0,
      startY = 0,
      lastX = 0,
      lastY = 0,
      lastTime = 0;
    let velocity = 0,
      remainder = 0,
      moved = false,
      held = false;

    // Pinch state
    let pinchBase = 0,
      pinchScale = 1,
      pinching = false,
      settling = false;

    const stop = () => {
      clearTimeout(hold);
      cancelAnimationFrame(frame);
    };

    const pinchGeometry = (t: TouchList) => ({
      distance: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    });

    const beginPinch = (t: TouchList) => {
      stop();
      velocity = 0;
      moved = false;
      held = false;
      const g = pinchGeometry(t);
      pinchBase = Math.max(1, g.distance);
      pinchScale = 1;
      pinching = true;
      settling = true;
      onGesture({ kind: 'pinch', phase: 'start', scale: 1, x: g.x, y: g.y });
    };

    const rowHeight = () =>
      (el.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? el.clientHeight) / term.rows;

    const isMouseTracking = (): boolean => {
      if (term.modes.mouseTrackingMode !== 'none') return true;
      const core = (term as any)._core;
      return !!core?.coreMouseService?.areMouseEventsActive;
    };

    const getCoords = (clientX: number, clientY: number) => {
      const screen = el.querySelector('.xterm-screen') as HTMLElement | null;
      const rect = screen ? screen.getBoundingClientRect() : el.getBoundingClientRect();
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((clientX - rect.left) / Math.max(1, rect.width / term.cols))));
      const row = Math.max(0, Math.min(term.rows - 1, Math.floor((clientY - rect.top) / Math.max(1, rect.height / term.rows))));
      return { col, row };
    };

    const sendWheel = (col: number, row: number, up: boolean) => {
      const core = (term as any)._core;
      if (core?.coreMouseService?.triggerMouseEvent) {
        core.coreMouseService.triggerMouseEvent({
          col,
          row,
          x: 0,
          y: 0,
          button: 4,
          action: up ? 0 : 1,
          ctrl: false,
          alt: false,
          shift: false,
        });
      } else {
        const code = up ? 64 : 65;
        term.input(`\x1b[<${code};${col + 1};${row + 1}M`, true);
      }
    };

    const sendClick = (col: number, row: number) => {
      const core = (term as any)._core;
      if (core?.coreMouseService?.triggerMouseEvent) {
        core.coreMouseService.triggerMouseEvent({
          col,
          row,
          x: 0,
          y: 0,
          button: 0,
          action: 1, // down
          ctrl: false,
          alt: false,
          shift: false,
        });
        core.coreMouseService.triggerMouseEvent({
          col,
          row,
          x: 0,
          y: 0,
          button: 0,
          action: 0, // up
          ctrl: false,
          alt: false,
          shift: false,
        });
      } else {
        term.input(`\x1b[<0;${col + 1};${row + 1}M`, true);
        term.input(`\x1b[<0;${col + 1};${row + 1}m`, true);
      }
    };

    const scroll = (pixels: number, clientX: number, clientY: number) => {
      remainder += pixels / Math.max(1, rowHeight());
      const lines = Math.trunc(remainder);
      if (!lines) return;

      if (isMouseTracking()) {
        // TUI mode (OpenCode, lazygit, htop, btop, tmux, etc.)
        const { col, row } = getCoords(clientX, clientY);
        const up = lines < 0; // finger moved down -> scroll up
        const count = Math.min(Math.abs(lines), 5);
        for (let i = 0; i < count; i++) {
          sendWheel(col, row, up);
        }
        remainder -= lines;
      } else if (term.buffer.active.type === 'alternate') {
        // Pagers without mouse reporting (e.g. less, man, more)
        const isApp = term.modes.applicationCursorKeysMode;
        const key = lines > 0 ? (isApp ? '\x1bOB' : '\x1b[B') : (isApp ? '\x1bOA' : '\x1b[A');
        const count = Math.min(Math.abs(lines), 4);
        for (let i = 0; i < count; i++) {
          term.input(key, true);
        }
        remainder -= lines;
      } else {
        // Normal terminal buffer: native scrollback
        term.scrollLines(lines);
        remainder -= lines;
      }
    };

    const selectWord = (x: number, y: number) => {
      const rect = el.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!rect) return;
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / (rect.width / term.cols))));
      const row =
        term.buffer.active.viewportY +
        Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / (rect.height / term.rows))));
      const line = term.buffer.active.getLine(row);
      const isWord = (c: number) => !!line?.getCell(c)?.getChars().match(/\S/);
      try {
        navigator.vibrate?.(8);
      } catch {
        /* not available */
      }
      if (!isWord(col)) {
        term.clearSelection();
        onGesture({ kind: 'menu', x, y });
        return;
      }
      let left = col,
        right = col;
      while (left > 0 && isWord(left - 1)) left--;
      while (right < term.cols - 1 && isWord(right + 1)) right++;
      term.select(left, row, right - left + 1);
      onGesture({ kind: 'select', x, y });
    };

    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        beginPinch(e.touches);
        return;
      }
      if (e.touches.length > 2) {
        stop();
        return;
      }
      stop();
      velocity = 0;
      remainder = 0;
      moved = false;
      held = false;
      settling = false;
      startX = lastX = e.touches[0].clientX;
      startY = lastY = e.touches[0].clientY;
      lastTime = performance.now();
      onGesture({ kind: 'touch', x: startX, y: startY });

      hold = window.setTimeout(() => {
        held = true;
        if (!isMouseTracking()) {
          selectWord(startX, startY);
        } else {
          onGesture({ kind: 'menu', x: startX, y: startY });
        }
      }, 500);
    };

    const move = (e: TouchEvent) => {
      if (pinching && e.touches.length >= 2) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const g = pinchGeometry(e.touches);
        pinchScale = g.distance / pinchBase;
        onGesture({ kind: 'pinch', phase: 'move', scale: pinchScale, x: g.x, y: g.y });
        return;
      }
      if (e.touches.length !== 1 || settling) {
        stop();
        return;
      }
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      if (Math.hypot(y - startY, x - startX) > 8) {
        clearTimeout(hold);
        moved = true;
      }
      if (!moved && !held) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!held) {
        const now = performance.now();
        const delta = lastY - y;
        velocity = delta / Math.max(8, now - lastTime);
        scroll(delta, x, y);
        lastX = x;
        lastY = y;
        lastTime = now;
      }
    };

    const end = (e: TouchEvent) => {
      clearTimeout(hold);
      if (pinching && e.touches.length < 2) {
        pinching = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        onGesture({ kind: 'pinch', phase: 'end', scale: pinchScale, x: 0, y: 0 });
        return;
      }
      if (settling) {
        if (e.touches.length === 0) settling = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      // Tap on TUI element (finger up without moving or holding)
      if (!moved && !held) {
        if (isMouseTracking()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const { col, row } = getCoords(startX, startY);
          sendClick(col, row);
          try {
            navigator.vibrate?.(10);
          } catch {
            /* not available */
          }
          return;
        }
      }

      if (held || moved) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      const isAltWithoutMouse = term.buffer.active.type === 'alternate' && !isMouseTracking();
      if (!moved || held || performance.now() - lastTime > 100 || isAltWithoutMouse) return;

      let previous = performance.now();
      const coast = (now: number) => {
        const dt = Math.min(32, now - previous);
        previous = now;
        velocity *= Math.exp(-dt / 180);
        scroll(velocity * dt, lastX, lastY);
        if (Math.abs(velocity) > 0.015) frame = requestAnimationFrame(coast);
      };
      frame = requestAnimationFrame(coast);
    };

    el.addEventListener('touchstart', start, { passive: true, capture: true });
    el.addEventListener('touchmove', move, { passive: false, capture: true });
    el.addEventListener('touchend', end, { passive: false, capture: true });
    const cancel = () => {
      stop();
      if (pinching) {
        pinching = false;
        settling = false;
        onGesture({ kind: 'pinch', phase: 'end', scale: pinchScale, x: 0, y: 0 });
      }
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
