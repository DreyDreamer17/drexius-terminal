import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MAX_RATIO, MIN_RATIO, type Rect, type SplitGeometry } from '../lib/splitTree';
import { cn } from '../utils/cn';

/** Space between panes and around the whole layout, in px. */
export const SPLIT_GAP = 4;
const HIT = 8;
const KEY_STEP = 0.02;

/** `unit` (0..1 along the layout) as a CSS length, plus a pixel offset. */
function unitCalc(unit: number, offset = 0): string {
  return `calc((100% - ${SPLIT_GAP}px) * ${unit}${offset ? ` + ${offset}px` : ''})`;
}

/**
 * Absolute placement of a pane inside the tab's layer. Panes are inset so there is a
 * SPLIT_GAP margin around the layout and SPLIT_GAP between neighbours, which is where the
 * dividers sit. Pure CSS `calc()`, so resizing the window needs no JavaScript.
 */
export function paneRectStyle(rect: Rect): CSSProperties {
  return {
    left: unitCalc(rect.x, SPLIT_GAP),
    top: unitCalc(rect.y, SPLIT_GAP),
    width: `calc((100% - ${SPLIT_GAP}px) * ${rect.w} - ${SPLIT_GAP}px)`,
    height: `calc((100% - ${SPLIT_GAP}px) * ${rect.h} - ${SPLIT_GAP}px)`,
  };
}

interface Props {
  tabId: string;
  split: SplitGeometry;
  accent: string;
  onRatio: (tabId: string, splitId: string, ratio: number) => void;
  onReset: (tabId: string, splitId: string) => void;
}

/**
 * A draggable divider between two panes. It lives inside the tab's pane layer (its parent),
 * which is also what pointer positions are measured against. Pointer capture keeps the drag
 * alive over the terminal canvases, and updates are coalesced to one per animation frame.
 */
export const SplitDivider = memo(
  function SplitDivider({ tabId, split, accent, onRatio, onReset }: Props) {
    const { id, axis, ratio, rect } = split;
    const horizontal = axis === 'row';
    const [hover, setHover] = useState(false);
    const [dragging, setDragging] = useState(false);
    const pending = useRef<number | null>(null);
    const frame = useRef(0);
    const latest = useRef({ tabId, id, onRatio });
    latest.current = { tabId, id, onRatio };

    useEffect(
      () => () => {
        if (frame.current) cancelAnimationFrame(frame.current);
      },
      []
    );

    const flush = () => {
      frame.current = 0;
      if (pending.current === null) return;
      const next = pending.current;
      pending.current = null;
      latest.current.onRatio(latest.current.tabId, latest.current.id, next);
    };

    const ratioFromPointer = (e: ReactPointerEvent<HTMLDivElement>): number | null => {
      const host = e.currentTarget.parentElement;
      if (!host) return null;
      const box = host.getBoundingClientRect();
      const extent = (horizontal ? box.width : box.height) - SPLIT_GAP;
      if (extent <= 0) return null;
      // The centre of the gap between two panes sits half a gap past their shared unit-space edge.
      const pos = (horizontal ? e.clientX - box.left : e.clientY - box.top) - SPLIT_GAP / 2;
      const unit = pos / extent;
      return (unit - (horizontal ? rect.x : rect.y)) / (horizontal ? rect.w : rect.h);
    };

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const next = ratioFromPointer(e);
      if (next === null) return;
      pending.current = Math.min(MAX_RATIO, Math.max(MIN_RATIO, next));
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    };

    const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (frame.current) cancelAnimationFrame(frame.current);
      flush();
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const grow = horizontal ? 'ArrowRight' : 'ArrowDown';
      const shrink = horizontal ? 'ArrowLeft' : 'ArrowUp';
      if (e.key === grow || e.key === shrink) {
        e.preventDefault();
        e.stopPropagation();
        onRatio(tabId, id, ratio + (e.key === grow ? KEY_STEP : -KEY_STEP));
      } else if (e.key === 'Home' || e.key === 'Enter') {
        e.preventDefault();
        onReset(tabId, id);
      }
    };

    const edge = horizontal ? rect.x + rect.w * ratio : rect.y + rect.h * ratio;
    const style: CSSProperties = horizontal
      ? {
          left: unitCalc(edge, SPLIT_GAP / 2 - HIT / 2),
          top: unitCalc(rect.y, SPLIT_GAP),
          width: HIT,
          height: `calc((100% - ${SPLIT_GAP}px) * ${rect.h} - ${SPLIT_GAP}px)`,
        }
      : {
          top: unitCalc(edge, SPLIT_GAP / 2 - HIT / 2),
          left: unitCalc(rect.x, SPLIT_GAP),
          height: HIT,
          width: `calc((100% - ${SPLIT_GAP}px) * ${rect.w} - ${SPLIT_GAP}px)`,
        };
    const active = hover || dragging;

    return (
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label="Resize split"
        aria-valuemin={Math.round(MIN_RATIO * 100)}
        aria-valuemax={Math.round(MAX_RATIO * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        title="Drag to resize · double-click to split evenly"
        className={cn(
          'absolute z-30 touch-none select-none outline-none max-md:hidden',
          horizontal ? 'cursor-col-resize' : 'cursor-row-resize'
        )}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onReset(tabId, id)}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onKeyDown={onKeyDown}
      >
        <div
          className={cn(
            'pointer-events-none absolute rounded-full transition-opacity duration-100',
            horizontal ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2'
          )}
          style={{ backgroundColor: accent, opacity: dragging ? 0.95 : active ? 0.6 : 0 }}
        />
      </div>
    );
  },
  // `split` is rebuilt on every layout pass; compare by value so idle dividers do not re-render.
  (a, b) =>
    a.tabId === b.tabId &&
    a.accent === b.accent &&
    a.onRatio === b.onRatio &&
    a.onReset === b.onReset &&
    a.split.id === b.split.id &&
    a.split.axis === b.split.axis &&
    a.split.ratio === b.split.ratio &&
    a.split.rect.x === b.split.rect.x &&
    a.split.rect.y === b.split.rect.y &&
    a.split.rect.w === b.split.rect.w &&
    a.split.rect.h === b.split.rect.h
);
