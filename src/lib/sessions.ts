/** Imperative registry of live terminal panes (used by Snippets / AI / SFTP). */
import type { Terminal } from '@xterm/xterm';
import type { PaneStatus } from './types';

export interface LivePane {
  paneId: string;
  hostId: string;
  sessionId: string | null;
  status: PaneStatus;
  cwd: string;
  lastCommand: string | null;
  term: Terminal | null;
  send: (data: string) => void;
}

const panes = new Map<string, LivePane>();
type RegistryListener = (paneId: string, pane: LivePane) => void;
const listeners = new Set<RegistryListener>();

export const registry = {
  set(p: LivePane) {
    panes.set(p.paneId, p);
    listeners.forEach((l) => {
      try { l(p.paneId, p); } catch {}
    });
  },
  patch(id: string, patch: Partial<LivePane>) {
    const p = panes.get(id);
    if (p) {
      Object.assign(p, patch);
      listeners.forEach((l) => {
        try { l(id, p); } catch {}
      });
    }
  },
  get(id: string) { return panes.get(id); },
  delete(id: string) { panes.delete(id); },
  all() { return [...panes.values()]; },
  subscribe(listener: RegistryListener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** Last N lines of terminal buffer as plain text (AI context). */
  context(id: string, n = 60): string {
    const t = panes.get(id)?.term;
    if (!t) return '';
    const buf = t.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const lines: string[] = [];
    for (let i = Math.max(0, end - n); i <= end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  },
};
