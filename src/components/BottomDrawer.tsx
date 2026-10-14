import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

/** Resting heights as a fraction of the host area: half exposes the terminal above, full covers it. */
export type DrawerDetent = 0.5 | 1;

const CLOSE_MS = 220;
const MIN_PX = 96;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Mouse counterpart of the pointerdown guard: a real mouse still fires mousedown (and would focus the grip). */
const preventFocusSteal = (e: { preventDefault: () => void }) => e.preventDefault();

/**
 * Physics for a phone drawer that slides up over the terminal (AI assistant, snippets).
 *
 * The grip drags the sheet height live — written straight to the element, no React render per
 * frame — and release snaps to half / full, or dismisses on a downward fling or when pulled under
 * ~30% of the host. A tap on the grip toggles half ↔ full; keyboard users get arrows and Escape.
 * `detent` is exposed so the terminal can give up exactly the covered space when half open.
 */
export function useBottomDrawer({ open, onClose, defaultDetent = 1 }: {
  /** Truthy = open. Pass the drawer's kind so switching content while open re-arms height and close timer. */
  open: boolean | string | null | undefined;
  onClose: () => void;
  defaultDetent?: DrawerDetent;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [detent, setDetent] = useState<DrawerDetent>(defaultDetent);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startH: number; lastY: number; lastT: number; v: number } | null>(null);
  const closeTimer = useRef(0);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Every opening starts from the caller's default height.
  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    setClosing(false);
    setDetent(defaultDetent);
    // Explicit write: a previous drag-to-dismiss may have left a pixel height that React's
    // unchanged style prop would not overwrite.
    if (ref.current) ref.current.style.height = `${defaultDetent * 100}%`;
    return () => window.clearTimeout(closeTimer.current);
  }, [open, defaultDetent]);

  const hostHeight = () => ref.current?.parentElement?.clientHeight || window.innerHeight;
  const settle = useCallback((d: DrawerDetent) => {
    if (ref.current) ref.current.style.height = `${d * 100}%`;
    setDetent(d);
  }, []);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), CLOSE_MS);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Don't move focus to the grip: resizing while the AI composer is focused must keep the keyboard up.
    e.preventDefault();
    // Touch pointers are captured implicitly; explicit capture is only needed for a mouse.
    if (e.pointerType === 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startH: ref.current?.getBoundingClientRect().height ?? 0, lastY: e.clientY, lastT: performance.now(), v: 0 };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !ref.current) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.v = d.v * 0.6 + ((e.clientY - d.lastY) / dt) * 0.4; // px/ms, positive = downwards
    d.lastY = e.clientY; d.lastT = now;
    ref.current.style.height = `${clamp(d.startH + (d.startY - e.clientY), MIN_PX, hostHeight())}px`;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    const total = hostHeight();
    const height = clamp(d.startH + (d.startY - e.clientY), 0, total);
    // A finger that paused before lifting is not a fling, whatever speed it had earlier.
    const v = performance.now() - d.lastT > 80 ? 0 : d.v;
    if (Math.abs(e.clientY - d.startY) <= 6) { settle(detent === 1 ? 0.5 : 1); return; } // tap toggles
    if (v > 0.7 || height < total * 0.3) { requestClose(); return; }
    if (v < -0.7) { settle(1); return; }
    settle(height / total > 0.75 ? 1 : 0.5);
  };
  const onPointerCancel = () => { drag.current = null; setDragging(false); settle(detent); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); settle(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (detent === 1) settle(0.5); else requestClose(); }
    else if (e.key === 'Escape') { e.preventDefault(); requestClose(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settle(detent === 1 ? 0.5 : 1); }
  };

  return {
    ref,
    detent,
    closing,
    requestClose,
    settle,
    className: ['nx-drawer', dragging && 'nx-drawer-dragging', closing && 'nx-drawer-closing'].filter(Boolean).join(' '),
    style: { height: `${detent * 100}%` },
    gripProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown, onMouseDown: preventFocusSteal },
  };
}

export type DrawerGripProps = ReturnType<typeof useBottomDrawer>['gripProps'] & { label: string; detent: DrawerDetent };

/**
 * Consume the raw touch moves on a dragged element (non-passive, which React cannot do): otherwise
 * Chrome's gesture detector turns a fast drag into a fling and swallows the next tap anywhere as "stop fling".
 */
export function useConsumeTouchMove(ref: React.RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const eat = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchmove', eat, { passive: false });
    return () => el.removeEventListener('touchmove', eat);
  }, [ref, enabled]);
}

/** The pull bar at the top of a drawer; the whole strip is the touch target. */
export function DrawerGrip({ label, detent, ...handlers }: DrawerGripProps) {
  const ref = useRef<HTMLDivElement>(null);
  useConsumeTouchMove(ref);
  return (
    <div
      ref={ref}
      className="nx-drawer-grip"
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={detent === 1 ? 'Full height' : 'Half height'}
      {...handlers}
    >
      <span />
    </div>
  );
}

export interface DrawerShellProps {
  drawer: ReturnType<typeof useBottomDrawer>;
  /** Accessible name of the drawer and label of its grip. */
  label: string;
  /** Sheet surface — the terminal background of the active theme, like every modal. */
  background: string;
  /** Colour of the ambient glow and the icon badge (theme accent or the tool's identity tint). */
  accent: string;
  /** Optional header in the modal design language: icon badge + title + subtitle + actions + close. */
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Phone drawer chrome shared by every tool that slides up over the terminal: the grip, the
 * top ambient radial glow and the header that the app's modals use, on the theme background.
 */
export function DrawerShell({ drawer, label, background, accent, title, subtitle, icon: Icon, actions, children }: DrawerShellProps) {
  return (
    <section
      ref={drawer.ref as React.RefObject<HTMLElement>}
      className={`md:hidden text-slate-200 ${drawer.className}`}
      style={{ ...drawer.style, background, '--nx-accent': accent } as CSSProperties}
      aria-label={label}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25" style={{ background: `radial-gradient(ellipse at top, ${accent} 0%, transparent 70%)` }} />
      <DrawerGrip label={`Drag to resize or dismiss ${label.toLowerCase()}`} detent={drawer.detent} {...drawer.gripProps} />
      {title && (
        <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-4 pb-3 pt-1">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && (
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border shadow-lg"
                style={{ backgroundColor: `${accent}18`, borderColor: `${accent}35`, color: accent, boxShadow: `0 0 20px ${accent}25` }}
              >
                <Icon className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-slate-200">{title}</h3>
              {subtitle && <p className="truncate text-[11px] text-slate-500">{subtitle}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <button
              type="button"
              aria-label={`Close ${label.toLowerCase()}`}
              onClick={drawer.requestClose}
              className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-white/10 hover:text-white active:bg-white/10"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>
        </header>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
