/**
 * backNavigation.ts — Centralized, priority-ordered back-navigation stack
 * and pure mobile route history helpers.
 *
 * Bridges Android's system Back gesture / hardware Back button (via
 * `MainActivity.kt`'s `OnBackPressedCallback`) to the React workspace so
 * swiping back dismisses the top-most dialog, modal, sheet, dropdown,
 * drawer, panel, sub-view, or previous tab before letting Android
 * background the app.
 *
 * Also syncs `canGoBack` back to Android via `window.DrexiusAndroidBack`
 * so Android 13+ Predictive Back-to-Home previews work natively at the root
 * screen while in-app back navigation intercepts everywhere else.
 */

export const BackPriority = {
  /** Top-level mobile tab history and full-screen terminal → Hosts return. */
  NAVIGATION: 10,
  /** In-page sub-views such as SFTP directory back history. */
  SUBVIEW: 20,
  /** Slide-over workspace panels (Keychain, Tunnels, Logs, Known Hosts) and mobile terminal drawers. */
  PANEL_OR_DRAWER: 30,
  /** Forms or sub-views inside a panel/drawer (Keychain/Tunnel/Snippet forms, AI settings/history). */
  PANEL_SUBVIEW: 35,
  /** Inline popovers, search bars, touch selection bubbles, and context menus. */
  POPOVER: 40,
  /** Full modals, bottom sheets, and full-screen overlays (`ResponsiveOverlay`, `MobileSheet`, editors). */
  MODAL: 50,
  /** Secondary modals rendered above an open modal or screen (Theme creator, QR scanner, SFTP dialogs, Docker logs). */
  NESTED_MODAL: 60,
  /** Floating select dropdowns that may open inside any panel or modal (`CustomSelect`). */
  DROPDOWN: 70,
  /** Top-most confirmation alerts (`ConfirmHost`, z-[1100], above even the Lock Screen). */
  CONFIRM: 100,
} as const;

export type BackPriorityLevel = (typeof BackPriority)[keyof typeof BackPriority] | number;

/**
 * Return `true` (or `void`/`undefined`) to indicate the back gesture was consumed.
 * Return `false` to pass through to the next lower-priority handler.
 */
export type BackHandler = () => boolean | void;

interface BackEntry {
  id: number;
  priority: number;
  seq: number;
  handler: BackHandler;
}

export class BackNavigationManager {
  private entries = new Map<number, BackEntry>();
  private nextId = 1;
  private nextSeq = 1;
  private listeners = new Set<(canGoBack: boolean) => void>();
  private lastNotifiedCanGoBack: boolean | null = null;

  register(handler: BackHandler, priority: BackPriorityLevel = BackPriority.MODAL): () => void {
    const id = this.nextId++;
    const seq = this.nextSeq++;
    this.entries.set(id, { id, priority, seq, handler });
    this.notifyIfChanged();
    return () => {
      if (this.entries.delete(id)) {
        this.notifyIfChanged();
      }
    };
  }

  canGoBack(): boolean {
    return this.entries.size > 0;
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Dispatch a single system Back event from highest priority to lowest,
   * using LIFO (most recently registered first) order within the same priority.
   */
  dispatch(): boolean {
    if (this.entries.size === 0) return false;
    const ordered = Array.from(this.entries.values()).sort(
      (a, b) => b.priority - a.priority || b.seq - a.seq,
    );
    for (const entry of ordered) {
      // Skip entries unregistered while an earlier handler was running.
      if (!this.entries.has(entry.id)) continue;
      try {
        const result = entry.handler();
        if (result !== false) {
          return true;
        }
      } catch (err) {
        console.error('[backNavigation] back handler threw:', err);
      }
    }
    return false;
  }

  subscribe(listener: (canGoBack: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.notifyIfChanged();
  }

  private notifyIfChanged(): void {
    const canGoBack = this.canGoBack();
    if (this.lastNotifiedCanGoBack === canGoBack) return;
    this.lastNotifiedCanGoBack = canGoBack;
    for (const listener of this.listeners) {
      try {
        listener(canGoBack);
      } catch (err) {
        console.error('[backNavigation] state listener threw:', err);
      }
    }
  }
}

export const backNav = new BackNavigationManager();

export function registerBackHandler(
  handler: BackHandler,
  priority: BackPriorityLevel = BackPriority.MODAL,
): () => void {
  return backNav.register(handler, priority);
}

export function dispatchBack(): boolean {
  return backNav.dispatch();
}

export function canHandleBack(): boolean {
  return backNav.canGoBack();
}

// ── Mobile bottom-nav route history (pure, loop-free) ──────────────────────

export type MobileRoute = 'terminals' | 'hosts' | 'sftp' | 'assistant' | 'settings';

/**
 * Push a forward mobile page transition onto the back history stack.
 * Deduplicates both `from` and `to` so switching tabs repeatedly or
 * opening a terminal from Hosts and swiping back can never produce loops.
 */
export function pushMobileRouteHistory(
  history: readonly MobileRoute[],
  from: MobileRoute,
  to: MobileRoute,
  maxLength = 12,
): MobileRoute[] {
  if (from === to) return [...history];
  const filtered = history.filter((page) => page !== to && page !== from);
  filtered.push(from);
  return filtered.length > maxLength ? filtered.slice(filtered.length - maxLength) : filtered;
}

/**
 * Pop the most recent route from the mobile back history stack.
 */
export function popMobileRouteHistory(
  history: readonly MobileRoute[],
): { target: MobileRoute | null; nextHistory: MobileRoute[] } {
  if (history.length === 0) {
    return { target: null, nextHistory: [] };
  }
  return {
    target: history[history.length - 1],
    nextHistory: history.slice(0, -1),
  };
}

/**
 * Resolve what top-level mobile navigation Back should do given the current
 * page, route history, and whether the full-screen terminal chrome (which hides
 * the bottom navigation bar) is currently showing.
 */
export function resolveMobileBackTarget(params: {
  currentPage: MobileRoute;
  history: readonly MobileRoute[];
  terminalScreen: boolean;
}): { target: MobileRoute | null; nextHistory: MobileRoute[] } {
  const { currentPage, history, terminalScreen } = params;
  const popped = popMobileRouteHistory(history);
  if (popped.target && popped.target !== currentPage) {
    return popped;
  }
  // On the full-screen terminal view, the bottom nav is hidden and the bar
  // exposes a "Back to hosts" control — swiping back mirrors it even when the
  // session was restored directly on launch with an empty tab history.
  if (terminalScreen && currentPage === 'terminals') {
    return { target: 'hosts', nextHistory: [] };
  }
  if (currentPage === 'settings') {
    return { target: 'hosts', nextHistory: [] };
  }
  return { target: null, nextHistory: [] };
}

// ── Global WebView ⇄ Android bridge ────────────────────────────────────────

export interface AndroidBackNativeBridge {
  setCanGoBack: (canGoBack: boolean) => void;
}

export interface BackBridgeWindow {
  __drexiusHandleBack?: () => boolean;
  __drexiusCanGoBack?: () => boolean;
  DrexiusAndroidBack?: AndroidBackNativeBridge;
}

let bridgeUninstall: (() => void) | null = null;

/**
 * Attach `window.__drexiusHandleBack` and `window.__drexiusCanGoBack`, and
 * keep Android's `DrexiusAndroidBack.setCanGoBack` synchronized with the active
 * back-handler stack. Safe to call multiple times (idempotent).
 */
export function installGlobalBackBridge(
  win: BackBridgeWindow | undefined = typeof window !== 'undefined' ? (window as unknown as BackBridgeWindow) : undefined,
  manager: BackNavigationManager = backNav,
): () => void {
  if (!win) return () => {};
  if (bridgeUninstall && win === (typeof window !== 'undefined' ? (window as unknown as BackBridgeWindow) : undefined) && manager === backNav) {
    return bridgeUninstall;
  }

  let lastSent: boolean | null = null;
  const syncNative = (canGoBack: boolean) => {
    if (lastSent === canGoBack) return;
    lastSent = canGoBack;
    try {
      win.DrexiusAndroidBack?.setCanGoBack(canGoBack);
    } catch {
      // Ignore bridge errors if WebView is tearing down
    }
  };

  win.__drexiusHandleBack = () => {
    const handled = manager.dispatch();
    // Re-sync after dispatch in case state settled synchronously.
    syncNative(manager.canGoBack());
    return handled;
  };
  win.__drexiusCanGoBack = () => manager.canGoBack();

  const unsubscribe = manager.subscribe(syncNative);
  syncNative(manager.canGoBack());

  const cleanup = () => {
    unsubscribe();
    if (win.__drexiusHandleBack) delete win.__drexiusHandleBack;
    if (win.__drexiusCanGoBack) delete win.__drexiusCanGoBack;
    if (bridgeUninstall === cleanup) bridgeUninstall = null;
  };

  if (win === (typeof window !== 'undefined' ? (window as unknown as BackBridgeWindow) : undefined) && manager === backNav) {
    bridgeUninstall = cleanup;
  }
  return cleanup;
}
