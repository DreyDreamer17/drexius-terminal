import { createContext, useContext, useEffect, useRef, type CSSProperties, type ReactNode, type KeyboardEventHandler } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';
import type { DrexiusTheme } from '../lib/themes';

// Portaled sheets must inherit the workspace lock, not escape its inert root.
export const WorkspaceAccessContext = createContext(true);

/** Desktop styling stays with the caller. On phones the same dialog becomes a sheet. */
export function ResponsiveOverlay({ children, onClose, className = '', label, onKeyDown, portal = false }: {
  children: ReactNode; onClose: () => void; className?: string; label: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>; portal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); closeRef.current();
      }
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === node)) { e.preventDefault(); first.focus(); }
    };
    node.addEventListener('keydown', key);
    return () => {
      node.removeEventListener('keydown', key);
      // Only hand focus back if nothing else claimed it: when one overlay is replaced by
      // another in the same commit (host actions -> confirm), the new one keeps its focus.
      const active = document.activeElement;
      const orphaned = !active || active === document.body || node.contains(active);
      if (orphaned && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const overlay = (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      className={`nx-responsive-overlay ${className}`}
      onKeyDown={onKeyDown}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </div>);
  return portal ? createPortal(overlay, document.body) : overlay;
}

/** Only the handle owns the swipe; scrolling a form must never dismiss it. */
export function SheetHandle({ onClose }: { onClose: () => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  return <button type="button" aria-label="Dismiss sheet" className="nx-sheet-handle md:hidden"
    onClick={() => { if (!suppressClick.current) onClose(); }}
    onPointerDown={e => { suppressClick.current = false; start.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerCancel={() => { start.current = null; }}
    onPointerUp={e => {
      const from = start.current; start.current = null;
      suppressClick.current = !!from && Math.hypot(e.clientY - from.y, e.clientX - from.x) > 8;
      if (from && e.clientY - from.y > 60 && Math.abs(e.clientX - from.x) < 70) onClose();
    }}><span /></button>;
}

/** Phone bottom sheet in the app's modal language: theme background, ambient accent glow, icon
 * badge + accent kicker + title header, close button. `kicker` is the small uppercase label
 * (FILE, HOST, SESSIONS); `title` keeps its own case because it is usually a name. */
export function MobileSheet({ title, kicker, subtitle, icon: Icon, theme, children, onClose }: {
  title: string; kicker?: string; subtitle?: string; icon?: LucideIcon; theme?: DrexiusTheme; children: ReactNode; onClose: () => void;
}) {
  const accessible = useContext(WorkspaceAccessContext);
  if (!accessible) return null;
  const accent = theme?.accent || '#22d3ee';
  const background = theme?.xterm.background || '#0e131d';
  return <ResponsiveOverlay portal label={title} onClose={onClose} className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm">
    <section className="nx-sheet relative flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border text-slate-200 shadow-2xl"
      style={{ background, borderColor: `${accent}30`, '--nx-accent': accent } as CSSProperties}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-25" style={{ background: `radial-gradient(ellipse at top, ${accent} 0%, transparent 70%)` }} />
      <SheetHandle onClose={onClose} />
      <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-4 pb-3 pt-1">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border shadow-lg"
              style={{ backgroundColor: `${accent}18`, borderColor: `${accent}35`, color: accent, boxShadow: `0 0 20px ${accent}25` }}>
              <Icon className="h-4 w-4" />
            </div>
          )}
          <div className="min-w-0">
            {kicker && <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: accent }}>{kicker}</p>}
            <h2 className="truncate text-sm font-semibold text-slate-100">{title}</h2>
            {subtitle && <p className="truncate text-[11px] text-slate-500">{subtitle}</p>}
          </div>
        </div>
        <button className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 transition active:bg-white/10" aria-label="Close sheet" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="relative min-h-0 overflow-y-auto p-4">{children}</div>
    </section>
  </ResponsiveOverlay>;
}
