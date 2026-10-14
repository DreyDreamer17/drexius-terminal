import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ClipboardList } from 'lucide-react';
import { useConsumeTouchMove } from './BottomDrawer';

/** A buffer cell: column + absolute buffer row (scrollback included). */
interface Cell { x: number; y: number }

interface Props {
  term: Terminal | null;
  /** Positioning root — the pane's terminal container (position: relative). */
  host: HTMLElement | null;
  accent: string;
  background: string;
  /** Long-press on blank space: client coordinates to anchor a paste menu to (no selection). */
  menuAt: { x: number; y: number } | null;
  onCopy: (text: string) => void;
  onPaste: () => void;
  onClips: () => void;
}

const HANDLE_FINGER_OFFSET = 26; // the knob hangs under the line, so the finger reads a line higher
const EDGE = 14;                 // autoscroll band at the top/bottom of the screen, px

/**
 * Native-feeling text selection for the phone terminal: a long-press selects a word (see
 * useTerminalTouch); this overlay draws the two drag handles at the selection edges and the
 * floating Copy · Paste · Select All bubble, and keeps them glued to the cells through
 * scrolling, resizing and handle drags. Everything is positioned from xterm's buffer
 * coordinates, so it is correct for wrapped lines and scrollback.
 */
export function TerminalSelection({ term, host, accent, background, menuAt, onCopy, onPaste, onClips }: Props) {
  const [, bump] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 });
  const bubbleRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useConsumeTouchMove(startRef);
  useConsumeTouchMove(endRef);
  const drag = useRef<{ anchor: Cell; pointerId: number; lastX: number; lastY: number; timer: number } | null>(null);

  // Re-layout whenever the selection, viewport or geometry changes.
  useEffect(() => {
    if (!term) return;
    const tick = () => bump((n) => n + 1);
    const subs = [term.onSelectionChange(tick), term.onScroll(tick), term.onResize(tick), term.onRender(tick)];
    window.addEventListener('resize', tick);
    return () => { subs.forEach((d) => d.dispose()); window.removeEventListener('resize', tick); };
  }, [term]);

  const metrics = useCallback(() => {
    const screen = host?.querySelector('.xterm-screen');
    if (!term || !host || !screen) return null;
    const s = screen.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    if (!s.width || !s.height || !term.cols || !term.rows) return null;
    return {
      screen: s, host: h,
      left: s.left - h.left, top: s.top - h.top,
      cellW: s.width / term.cols, cellH: s.height / term.rows,
      cols: term.cols, rows: term.rows, viewportY: term.buffer.active.viewportY,
    };
  }, [term, host]);

  /** Current selection as inclusive cells, or null when nothing is selected. */
  const selection = (): { start: Cell; end: Cell } | null => {
    const m = metrics();
    const pos = term?.getSelectionPosition();
    if (!m || !pos || !term?.hasSelection()) return null;
    // xterm's end column is exclusive; fold "column 0 of the next row" back onto the previous row.
    const end: Cell = pos.end.x === 0 && pos.end.y > pos.start.y ? { x: m.cols - 1, y: pos.end.y - 1 } : { x: Math.max(0, pos.end.x - 1), y: pos.end.y };
    return { start: { x: pos.start.x, y: pos.start.y }, end };
  };

  const cellAt = (clientX: number, clientY: number): Cell | null => {
    const m = metrics();
    if (!m) return null;
    const col = Math.max(0, Math.min(m.cols - 1, Math.floor((clientX - m.screen.left) / m.cellW)));
    const vrow = Math.max(0, Math.min(m.rows - 1, Math.floor((clientY - m.screen.top) / m.cellH)));
    return { x: col, y: m.viewportY + vrow };
  };

  const applyRange = (a: Cell, b: Cell) => {
    const m = metrics();
    if (!m || !term) return;
    const before = b.y < a.y || (b.y === a.y && b.x < a.x);
    const start = before ? b : a, end = before ? a : b;
    term.select(start.x, start.y, (end.y - start.y) * m.cols + (end.x - start.x) + 1);
  };

  const stopAutoscroll = () => { if (drag.current?.timer) { window.clearInterval(drag.current.timer); drag.current.timer = 0; } };

  const onHandleDown = (which: 'start' | 'end') => (e: ReactPointerEvent<HTMLDivElement>) => {
    const sel = selection();
    if (!sel) return;
    e.preventDefault(); // keep focus (and the keyboard) where it is
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { anchor: which === 'start' ? sel.end : sel.start, pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, timer: 0 };
    setDragging(true);
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const m = metrics();
    if (!d || !m || !term) return;
    d.lastX = e.clientX; d.lastY = e.clientY - HANDLE_FINGER_OFFSET;
    const cell = cellAt(d.lastX, d.lastY);
    if (cell) applyRange(d.anchor, cell);
    // Dragging past the screen edge scrolls the buffer and keeps extending the selection.
    const direction = d.lastY < m.screen.top + EDGE ? -1 : d.lastY > m.screen.bottom - EDGE ? 1 : 0;
    if (!direction) { stopAutoscroll(); return; }
    if (d.timer) return;
    d.timer = window.setInterval(() => {
      const cur = drag.current;
      if (!cur || !term) return;
      term.scrollLines(direction);
      const c = cellAt(cur.lastX, cur.lastY);
      if (c) applyRange(cur.anchor, c);
    }, 70);
  };
  const onHandleUp = () => { stopAutoscroll(); drag.current = null; setDragging(false); };
  useEffect(() => () => stopAutoscroll(), []);

  const m = metrics();
  const sel = m ? selection() : null;
  const hasMenu = !!menuAt && !sel;
  const hostStyle = (x: number, y: number): CSSProperties => ({ left: x, top: y });

  // Handles: drawn only while their row is inside the viewport.
  let startHandle: { x: number; y: number } | null = null;
  let endHandle: { x: number; y: number } | null = null;
  if (m && sel) {
    const vs = sel.start.y - m.viewportY, ve = sel.end.y - m.viewportY;
    if (vs >= 0 && vs < m.rows) startHandle = { x: m.left + sel.start.x * m.cellW, y: m.top + (vs + 1) * m.cellH };
    if (ve >= 0 && ve < m.rows) endHandle = { x: m.left + (sel.end.x + 1) * m.cellW, y: m.top + (ve + 1) * m.cellH };
  }

  // Bubble: above the selection (or the finger), falling back to below when there is no room.
  let bubble: { x: number; y: number } | null = null;
  if (m && !dragging && (sel || hasMenu)) {
    const pad = 6;
    let anchorX: number, above: number, below: number;
    if (sel) {
      const vs = Math.max(0, Math.min(m.rows - 1, sel.start.y - m.viewportY));
      const ve = Math.max(0, Math.min(m.rows - 1, sel.end.y - m.viewportY));
      const left = startHandle?.x ?? m.left, right = endHandle?.x ?? m.left + m.cols * m.cellW;
      anchorX = sel.start.y === sel.end.y ? (left + right) / 2 : m.left + (m.cols * m.cellW) / 2;
      above = m.top + vs * m.cellH - bubbleSize.h - 12;
      below = m.top + (ve + 1) * m.cellH + 34;
    } else {
      anchorX = menuAt!.x - m.host.left;
      above = menuAt!.y - m.host.top - bubbleSize.h - 22;
      below = menuAt!.y - m.host.top + 28;
    }
    const y = above >= pad ? above : Math.min(below, m.host.height - bubbleSize.h - pad);
    const x = Math.max(pad, Math.min(m.host.width - bubbleSize.w - pad, anchorX - bubbleSize.w / 2));
    bubble = { x, y: Math.max(pad, y) };
  }

  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w !== bubbleSize.w || h !== bubbleSize.h) setBubbleSize({ w, h });
  });

  if (!m || (!sel && !hasMenu)) return null;

  const item = (label: string, action: () => void, extra?: string) => (
    <button
      type="button"
      className={`nx-sel-item ${extra ?? ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); action(); }}
    >
      {label}
    </button>
  );

  return (
    <div className="nx-sel-layer" style={{ '--nx-accent': accent } as CSSProperties} aria-hidden={false}>
      {startHandle && (
        <div ref={startRef} className="nx-sel-handle nx-sel-handle-start" style={hostStyle(startHandle.x, startHandle.y)}
          role="slider" aria-label="Selection start" aria-valuetext={`column ${sel!.start.x + 1}`}
          onPointerDown={onHandleDown('start')} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
          <span />
        </div>
      )}
      {endHandle && (
        <div ref={endRef} className="nx-sel-handle nx-sel-handle-end" style={hostStyle(endHandle.x, endHandle.y)}
          role="slider" aria-label="Selection end" aria-valuetext={`column ${sel!.end.x + 1}`}
          onPointerDown={onHandleDown('end')} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
          <span />
        </div>
      )}
      {bubble && (
        <div ref={bubbleRef} className="nx-sel-bubble" role="toolbar" aria-label="Selection actions"
          style={{ ...hostStyle(bubble.x, bubble.y), background, visibility: bubbleSize.w ? 'visible' : 'hidden' }}>
          {sel && item('Copy', () => { const text = term?.getSelection() ?? ''; if (text) onCopy(text); term?.clearSelection(); })}
          {item('Paste', onPaste)}
          {item('Select all', () => term?.selectAll())}
          <button type="button" className="nx-sel-item nx-sel-item-icon" aria-label="Clipboard history" title="Clipboard history"
            onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onClips(); }}>
            <ClipboardList size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
