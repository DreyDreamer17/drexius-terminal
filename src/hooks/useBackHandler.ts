import { createContext, useContext, useEffect, useRef } from 'react';
import { BackPriority, registerBackHandler, type BackHandler, type BackPriorityLevel } from '../lib/backNavigation';

/** Portaled sheets and workspace back handlers inherit the vault lock state rather than escaping its inert root. */
export const WorkspaceAccessContext = createContext(true);

/**
 * Register a handler on the global back-navigation stack while `enabled` is true.
 *
 * By default, respects `WorkspaceAccessContext`: components inside the locked
 * workspace automatically unregister while the vault is locked so they never
 * intercept Back presses meant for the Lock Screen or ConfirmHost. Components
 * mounted outside the workspace lock provider (e.g. LockScreen, ConfirmHost)
 * inherit the default context value (`true`) and stay active as expected.
 */
export function useBackHandler(
  enabled: boolean,
  handler: BackHandler,
  priority: BackPriorityLevel = BackPriority.MODAL,
  options?: { respectWorkspaceLock?: boolean },
): void {
  const accessible = useContext(WorkspaceAccessContext);
  const active = enabled && (options?.respectWorkspaceLock === false || accessible);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return;
    return registerBackHandler(() => handlerRef.current(), priority);
  }, [active, priority]);
}
