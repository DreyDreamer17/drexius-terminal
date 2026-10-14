import { useSyncExternalStore, type ReactNode } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { ResponsiveOverlay, SheetHandle } from './MobileSheet';
import type { NexusTheme } from '../lib/themes';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Destructive action: red confirm button, and Cancel takes initial focus so Enter is safe. */
  danger?: boolean;
}

interface PendingConfirm {
  id: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

let pending: PendingConfirm | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => pending;

/**
 * Drop-in replacement for `window.confirm()` that renders as a bottom sheet on phones
 * and a small centred dialog on desktop, matching the rest of the workspace instead of
 * the WebView's native alert box. Resolves `true` when the user confirms.
 *
 * Requires a single `<ConfirmHost />` mounted at the app root.
 */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts: ConfirmOptions = typeof options === 'string' ? { title: options } : options;
  // Modal semantics: a new request supersedes (cancels) one that is still open.
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { id: nextId++, options: opts, resolve };
    emit();
  });
}

/** True while a confirm sheet is open; global shortcut handlers should stand down (the sheet owns Escape). */
export const hasPendingConfirm = () => pending !== null;

/** Resolve any open confirm as cancelled (e.g. when the vault auto-locks underneath it). */
export function cancelPendingConfirm() {
  if (!pending) return;
  const p = pending;
  pending = null;
  emit();
  p.resolve(false);
}

function settle(p: PendingConfirm, ok: boolean) {
  if (pending?.id !== p.id) return;
  pending = null;
  emit();
  p.resolve(ok);
}

export function ConfirmHost({ theme }: { theme?: NexusTheme }) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!current) return null;
  return <ConfirmSheet key={current.id} request={current} theme={theme} />;
}

function ConfirmSheet({ request, theme }: { request: PendingConfirm; theme?: NexusTheme }) {
  const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = request.options;
  const accent = danger ? '#fb7185' : theme?.accent ?? '#22d3ee';
  const background = theme?.xterm?.background ?? '#0e131d';
  const cancel = () => settle(request, false);
  const confirm = () => settle(request, true);
  const Icon = danger ? AlertTriangle : HelpCircle;
  return (
    // Portaled to <body> so it escapes any `inert` subtree, and layered above the lock
    // screen (z-1000) because the lock screen itself asks for confirmation.
    <ResponsiveOverlay portal label={title} onClose={cancel} className="fixed inset-0 z-[1100] grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-describedby={message ? `confirm-${request.id}-message` : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        className="nx-sheet nx-confirm relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 p-5 text-slate-200 shadow-2xl"
        style={{ backgroundColor: background }}
      >
        <SheetHandle onClose={cancel} />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 opacity-20" style={{ background: `radial-gradient(ellipse at top, ${accent} 0%, transparent 70%)` }} />
        <div className="relative flex items-start gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border"
            style={{ backgroundColor: `${accent}18`, borderColor: `${accent}35`, color: accent }}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            {message && (
              <div id={`confirm-${request.id}-message`} className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-slate-400">
                {message}
              </div>
            )}
          </div>
        </div>
        <div className="nx-confirm-actions relative mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus={danger}
            onClick={cancel}
            className="rounded-xl border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/5"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus={!danger}
            onClick={confirm}
            className="rounded-xl px-5 py-2 text-xs font-bold transition hover:brightness-110 active:scale-95"
            style={danger
              ? { backgroundColor: 'rgba(244, 63, 94, 0.9)', color: '#fff', boxShadow: '0 0 20px rgba(244, 63, 94, 0.3)' }
              : { backgroundColor: accent, color: '#000', boxShadow: `0 0 20px ${accent}35` }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ResponsiveOverlay>
  );
}
