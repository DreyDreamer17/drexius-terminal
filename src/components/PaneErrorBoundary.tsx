import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { cn } from '../utils/cn';

interface Props {
  children: ReactNode;
  /** Shown in the fallback, e.g. the host label. */
  label: string;
  onClose: () => void;
  className?: string;
  background?: string;
}

interface State {
  error: Error | null;
  /** Bumped on "Reopen" so the subtree remounts from scratch. */
  attempt: number;
}

/**
 * Keeps a crashing pane (renderer failure, addon error, bad escape sequence…)
 * from unmounting the whole workspace. Without a boundary React 19 tears down
 * the entire root and the app goes blank; with one, only the affected pane
 * shows a recovery card while every other session keeps running.
 */
export class PaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Pane "${this.props.label}" crashed:`, error, info.componentStack);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error) {
      // Changing the key remounts the children, so "Reopen" starts a clean session.
      return <PaneSlot key={attempt}>{this.props.children}</PaneSlot>;
    }
    return (
      <div
        role="alert"
        className={cn('flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center gap-3 p-6 text-center text-slate-200', this.props.className)}
        style={{ background: this.props.background }}
      >
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-rose-400/30 bg-rose-500/10 text-rose-300">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div>
          <div className="text-sm font-semibold">This pane stopped responding</div>
          <div className="mt-1 max-w-xs text-xs text-slate-400">
            {this.props.label} hit an unexpected error. Other sessions were not affected.
          </div>
          <div className="mt-2 max-w-xs truncate font-mono text-[11px] text-rose-300/80" title={error.message}>{error.message}</div>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null, attempt: attempt + 1 })}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 text-xs font-medium text-cyan-200 hover:bg-cyan-400/20"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reopen
          </button>
          <button
            type="button"
            onClick={this.props.onClose}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-white/10 px-4 text-xs text-slate-300 hover:bg-white/5"
          >
            <X className="h-3.5 w-3.5" /> Close
          </button>
        </div>
      </div>
    );
  }
}

function PaneSlot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
