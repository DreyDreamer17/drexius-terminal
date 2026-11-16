export interface TerminalCoreLike {
  _store?: { _isDisposed?: boolean };
  _charSizeService?: { measure?: () => void };
  _renderService?: {
    handleResize?: (cols: number, rows: number) => void;
    clear?: () => void;
  };
}

export interface TerminalLike {
  cols: number;
  rows: number;
  clearTextureAtlas?: () => void;
  refresh?: (start: number, end: number) => void;
  _core?: TerminalCoreLike;
}

export interface FitAddonLike {
  fit: () => void;
}

export interface ForceTerminalRenderSyncOptions {
  term: TerminalLike | null | undefined;
  fit: FitAddonLike | null | undefined;
  el: HTMLElement | null | undefined;
  hidden?: boolean;
  documentHidden?: boolean;
  /**
   * Clear xterm's cached texture atlas pages (`clearTextureAtlas()`).
   * Defaults to `false` because `@xterm/addon-webgl`'s `CharAtlasCache` shares
   * `TextureAtlas` instances across split panes: clearing the shared atlas from
   * one pane leaves sibling panes with stale UVs, whereas
   * `_renderService.handleResize()` safely forces GPU texture re-upload and
   * vertex/model rebuild for this terminal alone.
   */
  clearAtlas?: boolean;
  /** Force `_renderService.handleResize` even when `cols` and `rows` did not change. */
  forceResize?: boolean;
  /** Whether a WebGL renderer addon is currently attached to the terminal. */
  isWebglActive?: boolean;
  /** Called if an attached `.xterm-screen` WebGL2 canvas reports a lost context. */
  onWebglContextLost?: () => void;
}

export interface TerminalRenderSyncResult {
  synced: boolean;
  webglContextLost: boolean;
  resized: boolean;
}

/**
 * Probes any WebGL2 canvas inside `.xterm-screen` for a lost context without
 * synthesizing a WebGL2 context on non-WebGL renderers.
 */
function hasLostWebglContext(el: HTMLElement): boolean {
  if (typeof el.querySelectorAll !== 'function') return false;
  const canvases = el.querySelectorAll('.xterm-screen canvas');
  for (const canvas of canvases) {
    try {
      const getCtx = (canvas as { getContext?: (id: string) => unknown }).getContext;
      if (typeof getCtx !== 'function') continue;
      const gl = getCtx.call(canvas, 'webgl2') as { isContextLost?: () => boolean } | null;
      if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
        return true;
      }
    } catch {
      // Ignore inaccessible or non-WebGL canvas elements.
    }
  }
  return false;
}

/**
 * Forces a full xterm fit, WebGL/DOM renderer dimension sync, optional glyph
 * texture atlas reset, and full viewport row refresh even when `cols`/`rows`
 * remain unchanged (e.g. after reconnect, reopen, splash unlock, or surface restore).
 */
export function forceTerminalRenderSync({
  term,
  fit,
  el,
  hidden = false,
  documentHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden',
  clearAtlas = false,
  forceResize = true,
  isWebglActive = false,
  onWebglContextLost,
}: ForceTerminalRenderSyncOptions): TerminalRenderSyncResult {
  if (!term || term._core?._store?._isDisposed) {
    return { synced: false, webglContextLost: false, resized: false };
  }
  if (hidden || documentHidden || !el || !el.offsetParent || el.clientWidth < 40 || el.clientHeight < 40) {
    return { synced: false, webglContextLost: false, resized: false };
  }

  let webglContextLost = false;
  if (isWebglActive && hasLostWebglContext(el)) {
    webglContextLost = true;
    try {
      onWebglContextLost?.();
    } catch {}
  }

  const prevCols = term.cols || 0;
  const prevRows = term.rows || 0;

  try {
    term._core?._charSizeService?.measure?.();
  } catch {}

  try {
    fit?.fit();
  } catch {}

  const nextCols = term.cols || 0;
  const nextRows = term.rows || 0;
  const resized = nextCols !== prevCols || nextRows !== prevRows;

  // `FitAddon.fit()` and `Terminal.resize()` skip `_renderService.handleResize()`
  // whenever `cols` and `rows` are unchanged. Running it explicitly here forces
  // `WebglRenderer` to resync canvas dimensions, `gl.viewport` / `u_resolution`,
  // and glyph atlas textures just like a pane split resize does.
  if (clearAtlas) {
    try {
      term.clearTextureAtlas?.();
    } catch {}
  }

  if (forceResize && nextCols > 0 && nextRows > 0 && (!resized || clearAtlas)) {
    try {
      term._core?._renderService?.handleResize?.(nextCols, nextRows);
    } catch {}
  }

  if (nextRows > 0) {
    try {
      term.refresh?.(0, Math.max(0, nextRows - 1));
    } catch {}
  }

  return { synced: true, webglContextLost, resized };
}

export interface FocusElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * Returns true when auto-focusing the active terminal will not interrupt typing
 * inside search inputs, editors, or an open dialog/menu.
 */
export function canAutoFocusTerminal(
  activeElement: FocusElementLike | null | undefined,
  termTextarea: FocusElementLike | null | undefined,
): boolean {
  if (!activeElement || activeElement === termTextarea) return true;
  const tag = (activeElement.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeElement.isContentEditable) {
    return false;
  }
  if (typeof activeElement.closest === 'function' && activeElement.closest('[role="dialog"], [role="menu"]')) {
    return false;
  }
  return true;
}
