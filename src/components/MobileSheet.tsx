import { createContext, useContext, useEffect, useRef, type ReactNode, type KeyboardEventHandler } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

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
    return () => { node.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
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

export function MobileSheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const accessible = useContext(WorkspaceAccessContext);
  if (!accessible) return null;
  return <ResponsiveOverlay portal label={title} onClose={onClose} className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm">
    <section className="nx-sheet flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0e131d] text-slate-200 shadow-2xl">
      <SheetHandle onClose={onClose} />
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
        <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
        <button className="nx-touch-button" aria-label="Close sheet" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="min-h-0 overflow-y-auto p-4">{children}</div>
    </section>
  </ResponsiveOverlay>;
}
