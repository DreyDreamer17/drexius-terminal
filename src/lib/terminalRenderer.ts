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

export interface WebglBlendContextLike {
  SRC_ALPHA: number;
  ONE_MINUS_SRC_ALPHA: number;
  ONE: number;
  blendFunc: (sfactor: number, dfactor: number) => void;
  blendFuncSeparate?: (
    srcRGB: number,
    dstRGB: number,
    srcAlpha: number,
    dstAlpha: number,
  ) => void;
}

export interface Canvas2DSourceLike {
  width: number;
  height: number;
  getContext: (contextId: string) => {
    getImageData?: (sx: number, sy: number, sw: number, sh: number) => {
      data: Uint8ClampedArray;
    };
  } | null;
}

export interface WebglTexImage2DContextLike {
  RGBA: number;
  UNSIGNED_BYTE: number;
  texImage2D?: (...args: unknown[]) => void;
}

export interface CanvasGetContextHost {
  getContext?: (contextId: string, ...args: unknown[]) => unknown;
}

const patchedWebglContexts = new WeakSet<object>();
const patchedTexImageContexts = new WeakSet<object>();
const patchedRectangleTargets = new WeakSet<object>();

/**
 * Returns true on Linux WebKitGTK (Tauri desktop on Linux), excluding Chromium,
 * Android WebView, and macOS Safari.
 */
export function isLinuxWebKitGtk(
  userAgent: string | undefined = typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
): boolean {
  if (!userAgent) return false;
  return (
    /Linux/i.test(userAgent) &&
    /AppleWebKit/i.test(userAgent) &&
    !/Chrome|Chromium|Android|Edg/i.test(userAgent)
  );
}

function isCanvas2DSource(value: unknown): value is Canvas2DSourceLike {
  if (!value || typeof value !== 'object') return false;
  if (typeof HTMLCanvasElement !== 'undefined' && !(value instanceof HTMLCanvasElement)) {
    return false;
  }
  const candidate = value as Partial<Canvas2DSourceLike>;
  return (
    typeof candidate.getContext === 'function' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    candidate.width > 0 &&
    candidate.height > 0
  );
}

/**
 * On Linux WebKitGTK (2.50–2.54+ Skia GPU + DMA-BUF), passing an off-DOM 2D
 * `<canvas>` (like `@xterm/addon-webgl`'s 512x512 glyph texture atlas) directly
 * to `gl.texImage2D(...)` can silently upload a transparent/empty DMA-BUF texture
 * while untextured geometry (like the cursor) still renders normally.
 *
 * Reading straight RGBA pixels via `getImageData` and passing a zero-copy
 * `Uint8Array` view to the 9-argument `texImage2D` overload bypasses WebKitGTK's
 * broken GPU Canvas2D-to-WebGL2 DMA-BUF import while keeping full hardware
 * acceleration enabled (and only runs when a newly rasterized glyph bumps an
 * atlas page version — zero per-frame cost).
 */
export function wrapWebglContextCanvasTexImage2D<T extends WebglTexImage2DContextLike>(
  gl: T | null | undefined,
): T | null | undefined {
  if (!gl || typeof gl.texImage2D !== 'function') {
    return gl;
  }
  if (patchedTexImageContexts.has(gl)) {
    return gl;
  }
  const origTexImage2D = gl.texImage2D.bind(gl);
  const { RGBA, UNSIGNED_BYTE } = gl;

  gl.texImage2D = ((...args: unknown[]) => {
    try {
      // 6-arg overload: texImage2D(target, level, internalformat, format, type, HTMLCanvasElement)
      if (args.length === 6 && args[3] === RGBA && args[4] === UNSIGNED_BYTE && isCanvas2DSource(args[5])) {
        const canvas = args[5];
        const ctx2d = canvas.getContext('2d');
        const imgData = ctx2d?.getImageData?.(0, 0, canvas.width, canvas.height);
        if (imgData?.data) {
          const pixels = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
          origTexImage2D(args[0], args[1], args[2], canvas.width, canvas.height, 0, args[3], args[4], pixels);
          return;
        }
      }
      // 9-arg overload: texImage2D(target, level, internalformat, width, height, border, format, type, HTMLCanvasElement)
      if (args.length === 9 && args[6] === RGBA && args[7] === UNSIGNED_BYTE && isCanvas2DSource(args[8])) {
        const canvas = args[8];
        const w = typeof args[3] === 'number' && args[3] > 0 ? args[3] : canvas.width;
        const h = typeof args[4] === 'number' && args[4] > 0 ? args[4] : canvas.height;
        const ctx2d = canvas.getContext('2d');
        const imgData = ctx2d?.getImageData?.(0, 0, w, h);
        if (imgData?.data) {
          const pixels = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
          origTexImage2D(args[0], args[1], args[2], w, h, args[5], args[6], args[7], pixels);
          return;
        }
      }
    } catch {
      // Fall through to native texImage2D on unreadable/tainted canvases.
    }
    origTexImage2D(...args);
  }) as T['texImage2D'];

  patchedTexImageContexts.add(gl);
  return gl;
}

const XTERM_BG_CM_MASK = 0x3000000;
const XTERM_RENDER_MODEL_CELL_STRIDE = 4;
const XTERM_RENDER_MODEL_BG_OFFSET = 1;

export interface WebglRenderModelLike {
  cells: Uint32Array;
  lineLengths?: Uint32Array;
  selection?: unknown;
  cursor?: unknown;
}

export interface WebglRectangleRendererLike {
  updateBackgrounds?: (model: WebglRenderModelLike) => void;
}

export interface WebglAddonInternalLike {
  _renderer?: {
    _rectangleRenderer?: {
      value?: WebglRectangleRendererLike;
    };
  };
}

/**
 * Prevents `@xterm/addon-webgl`'s `RectangleRenderer.updateBackgrounds()` from
 * painting opaque `#000000` background rectangles over default-background cells
 * that happen to carry `BgFlags` bits (`DIM`, `ITALIC`, `OVERLINE`, `PROTECTED`,
 * `HAS_EXTENDED` used by hyperlinks, underlines, and `@xterm/addon-image` tiles).
 *
 * In xterm, `RectangleRenderer` checks `bg !== 0` instead of checking `(bg & CM_MASK) !== 0`,
 * causing any flagged cell with default background to fall back to `colors.background`
 * (`#00000000` RGB `0,0,0` in wallpaper mode) with hardcoded `alpha = 1`.
 */
export function patchWebglRectangleBackgrounds(addon: unknown): void {
  const rectRenderer = (addon as WebglAddonInternalLike | null | undefined)?._renderer?._rectangleRenderer?.value;
  if (!rectRenderer) return;
  const proto = Object.getPrototypeOf(rectRenderer) as WebglRectangleRendererLike | null;
  const target: WebglRectangleRendererLike =
    proto && proto !== Object.prototype && typeof proto.updateBackgrounds === 'function'
      ? proto
      : rectRenderer;

  if (patchedRectangleTargets.has(target) || typeof target.updateBackgrounds !== 'function') {
    return;
  }

  const origUpdateBackgrounds = target.updateBackgrounds;
  let scratchCells = new Uint32Array(0);

  target.updateBackgrounds = function patchedUpdateBackgrounds(
    this: unknown,
    model: WebglRenderModelLike,
  ) {
    const cells = model?.cells;
    if (!cells || cells.length === 0) {
      return origUpdateBackgrounds.call(this, model);
    }

    let needsSanitize = false;
    for (let i = XTERM_RENDER_MODEL_BG_OFFSET; i < cells.length; i += XTERM_RENDER_MODEL_CELL_STRIDE) {
      const bg = cells[i];
      if (bg !== 0 && (bg & XTERM_BG_CM_MASK) === 0) {
        needsSanitize = true;
        break;
      }
    }
    if (!needsSanitize) {
      return origUpdateBackgrounds.call(this, model);
    }

    if (scratchCells.length !== cells.length) {
      scratchCells = new Uint32Array(cells.length);
    }
    scratchCells.set(cells);
    for (let i = XTERM_RENDER_MODEL_BG_OFFSET; i < scratchCells.length; i += XTERM_RENDER_MODEL_CELL_STRIDE) {
      const bg = scratchCells[i];
      if (bg !== 0 && (bg & XTERM_BG_CM_MASK) === 0) {
        scratchCells[i] = 0;
      }
    }
    return origUpdateBackgrounds.call(this, { ...model, cells: scratchCells });
  };

  patchedRectangleTargets.add(target);
}

/**
 * Patches `gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` to preserve framebuffer
 * alpha via `gl.blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`.
 *
 * `@xterm/addon-webgl`'s GlyphRenderer creates a `premultipliedAlpha: true` WebGL2
 * context and draws glyphs with `gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`.
 * That reduces destination alpha on anti-aliased glyph edges (`a^2 + (1 - a) * a_dst`),
 * causing the page compositor to bleach dark glyph stems on light themes.
 */
export function wrapWebglContextBlendFunc<T extends WebglBlendContextLike>(
  gl: T | null | undefined,
): T | null | undefined {
  if (!gl || typeof gl.blendFunc !== 'function' || typeof gl.blendFuncSeparate !== 'function') {
    return gl;
  }
  if (patchedWebglContexts.has(gl)) {
    return gl;
  }
  const origBlendFunc = gl.blendFunc.bind(gl);
  const origBlendFuncSeparate = gl.blendFuncSeparate.bind(gl);
  const { SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE } = gl;
  gl.blendFunc = ((sfactor: number, dfactor: number) => {
    if (sfactor === SRC_ALPHA && dfactor === ONE_MINUS_SRC_ALPHA) {
      origBlendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA);
      return;
    }
    origBlendFunc(sfactor, dfactor);
  }) as T['blendFunc'];
  patchedWebglContexts.add(gl);
  return gl;
}

/**
 * Loads `@xterm/addon-webgl` while synchronously intercepting `canvas.getContext('webgl2')`
 * so the renderer's WebGL2 context gets `wrapWebglContextBlendFunc` (and on Linux
 * WebKitGTK, `wrapWebglContextCanvasTexImage2D` to bypass Skia GPU DMA-BUF blank
 * glyph-atlas uploads) without mutating global prototypes beyond the synchronous
 * `loadAddon` call.
 */
export function loadWebglAddonWithBlendFix<
  TTerm extends { loadAddon: (addon: TAddon) => void },
  TAddon,
>(
  term: TTerm,
  addon: TAddon,
  canvasPrototype: CanvasGetContextHost | undefined =
    typeof HTMLCanvasElement !== 'undefined'
      ? (HTMLCanvasElement.prototype as unknown as CanvasGetContextHost)
      : undefined,
  useCanvasImageDataUpload: boolean = isLinuxWebKitGtk(),
): void {
  const origGetContext = canvasPrototype?.getContext;
  if (!canvasPrototype || typeof origGetContext !== 'function') {
    term.loadAddon(addon);
    return;
  }
  canvasPrototype.getContext = function patchedGetContext(
    this: unknown,
    contextId: string,
    ...args: unknown[]
  ) {
    const ctx = origGetContext.call(this, contextId, ...args);
    if (contextId === 'webgl2') {
      wrapWebglContextBlendFunc(ctx as WebglBlendContextLike | null);
      if (useCanvasImageDataUpload) {
        wrapWebglContextCanvasTexImage2D(ctx as WebglTexImage2DContextLike | null);
      }
    }
    return ctx;
  };
  try {
    term.loadAddon(addon);
  } finally {
    canvasPrototype.getContext = origGetContext;
  }
  patchWebglRectangleBackgrounds(addon);
}

/**
 * Returns the `minimumContrastRatio` for xterm.js: `4.5` on opaque light themes
 * so pastel ANSI colors (`white`, `brightWhite`, `yellow`, `brightBlack`) stay legible
 * against light surfaces; `1` on dark themes and translucent `#00000000` wallpaper
 * modes (where xterm computes contrast against transparent black `#000000`).
 */
export function getTerminalMinimumContrastRatio({
  isLight,
  isTranslucent,
}: {
  isLight: boolean;
  isTranslucent: boolean;
}): number {
  if (!isLight || isTranslucent) {
    return 1;
  }
  return 4.5;
}
