import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAutoFocusTerminal,
  forceTerminalRenderSync,
  getTerminalMinimumContrastRatio,
  isLinuxWebKitGtk,
  loadWebglAddonWithBlendFix,
  patchWebglRectangleBackgrounds,
  wrapWebglContextBlendFunc,
  wrapWebglContextCanvasTexImage2D,
} from '../src/lib/terminalRenderer.ts';

function makeElement({
  offsetParent = {},
  clientWidth = 800,
  clientHeight = 500,
  canvases = [],
} = {}) {
  return {
    offsetParent,
    clientWidth,
    clientHeight,
    querySelectorAll(selector) {
      return selector === '.xterm-screen canvas' ? canvases : [];
    },
  };
}

function makeFakeTerm({ cols = 80, rows = 24, disposed = false } = {}) {
  const calls = [];
  const term = {
    cols,
    rows,
    clearTextureAtlas() {
      calls.push('clearTextureAtlas');
    },
    refresh(start, end) {
      calls.push(['refresh', start, end]);
    },
    _core: {
      _store: { _isDisposed: disposed },
      _charSizeService: {
        measure() {
          calls.push('measure');
        },
      },
      _renderService: {
        handleResize(c, r) {
          calls.push(['handleResize', c, r]);
        },
      },
    },
  };
  return { term, calls };
}

test('forceTerminalRenderSync preserves shared texture atlas by default while forcing handleResize and refresh when cols/rows do not change', () => {
  const { term, calls } = makeFakeTerm({ cols: 96, rows: 32 });
  const fit = {
    fit() {
      calls.push('fit');
      // Layout size unchanged on reconnect/reopen: FitAddon does not resize terminal.
    },
  };

  const result = forceTerminalRenderSync({
    term,
    fit,
    el: makeElement(),
    hidden: false,
    documentHidden: false,
  });

  assert.deepEqual(result, { synced: true, webglContextLost: false, resized: false });
  assert.deepEqual(calls, [
    'measure',
    'fit',
    ['handleResize', 96, 32],
    ['refresh', 0, 31],
  ]);
});

test('forceTerminalRenderSync clears texture atlas only when clearAtlas is explicitly enabled', () => {
  const { term, calls } = makeFakeTerm({ cols: 96, rows: 32 });
  const fit = {
    fit() {
      calls.push('fit');
    },
  };

  const result = forceTerminalRenderSync({
    term,
    fit,
    el: makeElement(),
    hidden: false,
    documentHidden: false,
    clearAtlas: true,
    forceResize: true,
  });

  assert.deepEqual(result, { synced: true, webglContextLost: false, resized: false });
  assert.deepEqual(calls, [
    'measure',
    'fit',
    'clearTextureAtlas',
    ['handleResize', 96, 32],
    ['refresh', 0, 31],
  ]);
});

test('forceTerminalRenderSync skips redundant handleResize when fit already changed cols/rows and clearAtlas is false', () => {
  const { term, calls } = makeFakeTerm({ cols: 80, rows: 24 });
  const fit = {
    fit() {
      calls.push('fit');
      term.cols = 100;
      term.rows = 30;
    },
  };

  const result = forceTerminalRenderSync({
    term,
    fit,
    el: makeElement(),
    hidden: false,
    documentHidden: false,
    clearAtlas: false,
    forceResize: true,
  });

  assert.deepEqual(result, { synced: true, webglContextLost: false, resized: true });
  assert.deepEqual(calls, [
    'measure',
    'fit',
    ['refresh', 0, 29],
  ]);
});

test('forceTerminalRenderSync still runs handleResize when clearAtlas is false if cols/rows stayed equal', () => {
  const { term, calls } = makeFakeTerm({ cols: 80, rows: 24 });
  const fit = {
    fit() {
      calls.push('fit');
    },
  };

  const result = forceTerminalRenderSync({
    term,
    fit,
    el: makeElement(),
    hidden: false,
    documentHidden: false,
    clearAtlas: false,
    forceResize: true,
  });

  assert.deepEqual(result, { synced: true, webglContextLost: false, resized: false });
  assert.deepEqual(calls, [
    'measure',
    'fit',
    ['handleResize', 80, 24],
    ['refresh', 0, 23],
  ]);
});

test('forceTerminalRenderSync skips hidden, backgrounded, detached, collapsed, or disposed terminals', () => {
  const cases = [
    { name: 'hidden prop', opts: { hidden: true } },
    { name: 'document hidden', opts: { documentHidden: true } },
    { name: 'detached offsetParent', opts: { el: makeElement({ offsetParent: null }) } },
    { name: 'narrow width', opts: { el: makeElement({ clientWidth: 16 }) } },
    { name: 'short height', opts: { el: makeElement({ clientHeight: 20 }) } },
    { name: 'disposed term', opts: { disposed: true } },
    { name: 'missing term', opts: { term: null } },
  ];

  for (const c of cases) {
    const { term, calls } = makeFakeTerm({ disposed: c.opts.disposed });
    let fitCalled = false;
    const result = forceTerminalRenderSync({
      term: 'term' in c.opts ? c.opts.term : term,
      fit: { fit() { fitCalled = true; } },
      el: c.opts.el ?? makeElement(),
      hidden: c.opts.hidden ?? false,
      documentHidden: c.opts.documentHidden ?? false,
    });

    assert.deepEqual(result, { synced: false, webglContextLost: false, resized: false }, c.name);
    assert.equal(fitCalled, false, `${c.name} should not fit`);
    assert.deepEqual(calls, [], `${c.name} should not call renderer`);
  }
});

test('forceTerminalRenderSync detects lost WebGL2 context and triggers recovery callback', () => {
  const { term, calls } = makeFakeTerm({ cols: 80, rows: 24 });
  let lostNotified = 0;
  const lostCanvas = {
    getContext(kind) {
      return kind === 'webgl2' ? { isContextLost: () => true } : null;
    },
  };

  const result = forceTerminalRenderSync({
    term,
    fit: { fit() { calls.push('fit'); } },
    el: makeElement({ canvases: [lostCanvas] }),
    hidden: false,
    documentHidden: false,
    isWebglActive: true,
    onWebglContextLost() {
      lostNotified += 1;
    },
  });

  assert.equal(lostNotified, 1);
  assert.deepEqual(result, { synced: true, webglContextLost: true, resized: false });
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'handleResize'));
});

test('forceTerminalRenderSync isolates errors from fit or xterm internals', () => {
  const brokenTerm = {
    cols: 80,
    rows: 24,
    clearTextureAtlas() { throw new Error('atlas error'); },
    refresh() { throw new Error('refresh error'); },
    _core: {
      _charSizeService: { measure() { throw new Error('measure error'); } },
      _renderService: { handleResize() { throw new Error('resize error'); } },
    },
  };

  const result = forceTerminalRenderSync({
    term: brokenTerm,
    fit: { fit() { throw new Error('fit error'); } },
    el: makeElement(),
    hidden: false,
    documentHidden: false,
  });

  assert.deepEqual(result, { synced: true, webglContextLost: false, resized: false });
});

test('canAutoFocusTerminal allows focusing from body/buttons/term textarea and avoids stealing dialog or input focus', () => {
  const termTextarea = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
  const searchInput = { tagName: 'INPUT', isContentEditable: false, closest: () => null };
  const editorDiv = { tagName: 'DIV', isContentEditable: true, closest: () => null };
  const dialogBtn = { tagName: 'BUTTON', isContentEditable: false, closest: (s) => (s.includes('[role="dialog"]') ? {} : null) };
  const bodyEl = { tagName: 'BODY', isContentEditable: false, closest: () => null };

  assert.equal(canAutoFocusTerminal(null, termTextarea), true);
  assert.equal(canAutoFocusTerminal(bodyEl, termTextarea), true);
  assert.equal(canAutoFocusTerminal(termTextarea, termTextarea), true);
  assert.equal(canAutoFocusTerminal(searchInput, termTextarea), false);
  assert.equal(canAutoFocusTerminal(editorDiv, termTextarea), false);
  assert.equal(canAutoFocusTerminal(dialogBtn, termTextarea), false);
});

test('wrapWebglContextBlendFunc redirects glyph blending to preserve destination alpha without affecting other blend modes', () => {
  const calls = [];
  const fakeGl = {
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1,
    ZERO: 0,
    blendFunc(sfactor, dfactor) {
      calls.push(['blendFunc', sfactor, dfactor]);
    },
    blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha) {
      calls.push(['blendFuncSeparate', srcRGB, dstRGB, srcAlpha, dstAlpha]);
    },
  };

  wrapWebglContextBlendFunc(fakeGl);
  // Idempotent if called twice on the same WebGL2 context.
  wrapWebglContextBlendFunc(fakeGl);

  fakeGl.blendFunc(fakeGl.SRC_ALPHA, fakeGl.ONE_MINUS_SRC_ALPHA);
  fakeGl.blendFunc(fakeGl.ONE, fakeGl.ZERO);

  assert.deepEqual(calls, [
    ['blendFuncSeparate', fakeGl.SRC_ALPHA, fakeGl.ONE_MINUS_SRC_ALPHA, fakeGl.ONE, fakeGl.ONE_MINUS_SRC_ALPHA],
    ['blendFunc', fakeGl.ONE, fakeGl.ZERO],
  ]);
});

test('loadWebglAddonWithBlendFix patches created WebGL2 contexts and always restores getContext', () => {
  const calls = [];
  const fakeGl = {
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1,
    blendFunc(s, d) {
      calls.push(['raw', s, d]);
    },
    blendFuncSeparate(sr, dr, sa, da) {
      calls.push(['sep', sr, dr, sa, da]);
    },
  };
  const fake2d = { kind: '2d' };
  const origGetContext = (contextId) => (contextId === 'webgl2' ? fakeGl : fake2d);
  const proto = { getContext: origGetContext };

  loadWebglAddonWithBlendFix(
    {
      loadAddon() {
        const ctx2d = proto.getContext('2d');
        assert.equal(ctx2d, fake2d);
        const gl = proto.getContext('webgl2');
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      },
    },
    {},
    proto,
  );

  assert.equal(proto.getContext, origGetContext);
  assert.deepEqual(calls, [['sep', fakeGl.SRC_ALPHA, fakeGl.ONE_MINUS_SRC_ALPHA, fakeGl.ONE, fakeGl.ONE_MINUS_SRC_ALPHA]]);

  // Also restores getContext if loadAddon throws.
  assert.throws(
    () =>
      loadWebglAddonWithBlendFix(
        {
          loadAddon() {
            throw new Error('webgl init failure');
          },
        },
        {},
        proto,
      ),
    /webgl init failure/,
  );
  assert.equal(proto.getContext, origGetContext);
});

test('getTerminalMinimumContrastRatio enforces 4.5 only on opaque light themes', () => {
  assert.equal(getTerminalMinimumContrastRatio({ isLight: true, isTranslucent: false }), 4.5);
  assert.equal(getTerminalMinimumContrastRatio({ isLight: true, isTranslucent: true }), 1);
  assert.equal(getTerminalMinimumContrastRatio({ isLight: false, isTranslucent: false }), 1);
  assert.equal(getTerminalMinimumContrastRatio({ isLight: false, isTranslucent: true }), 1);
});

test('patchWebglRectangleBackgrounds strips CM_DEFAULT BgFlags without mutating render model cells', () => {
  class FakeRectangleRenderer {
    constructor() {
      this.seenBg = [];
    }
    updateBackgrounds(model) {
      this.seenBg = [];
      for (let i = 1; i < model.cells.length; i += 4) {
        this.seenBg.push(model.cells[i]);
      }
    }
  }

  const rr = new FakeRectangleRenderer();
  const fakeAddon = { _renderer: { _rectangleRenderer: { value: rr } } };
  patchWebglRectangleBackgrounds(fakeAddon);
  // Idempotent on prototype.
  patchWebglRectangleBackgrounds(fakeAddon);

  const cells = new Uint32Array([
    65, 0x10000000, 0, 0, // HAS_EXTENDED image/underline/link cell with CM_DEFAULT -> sanitized to 0
    66, 0x08000000, 0, 0, // DIM cell with CM_DEFAULT -> sanitized to 0
    67, 0x04000000, 0, 0, // ITALIC cell with CM_DEFAULT -> sanitized to 0
    68, 0x01000002, 0, 0, // CM_P16 green background -> preserved!
    69, 0x13ff0000, 0, 0, // CM_RGB + HAS_EXTENDED -> preserved!
  ]);
  const snapshotBefore = new Uint32Array(cells);

  rr.updateBackgrounds({ cells });

  // Caller's render model cells remain unmodified for incremental frame diffing.
  assert.deepEqual(cells, snapshotBefore);
  assert.deepEqual(rr.seenBg, [0, 0, 0, 0x01000002, 0x13ff0000]);

  // Also works transparently on fresh instances sharing the patched prototype (e.g. context restore).
  const rr2 = new FakeRectangleRenderer();
  rr2.updateBackgrounds({ cells });
  assert.deepEqual(rr2.seenBg, [0, 0, 0, 0x01000002, 0x13ff0000]);
});

test('isLinuxWebKitGtk matches Linux WebKitGTK and excludes Chromium, Android, and macOS Safari', () => {
  assert.equal(
    isLinuxWebKitGtk('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15'),
    true,
  );
  assert.equal(
    isLinuxWebKitGtk('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
    true,
  );
  assert.equal(
    isLinuxWebKitGtk('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'),
    false,
  );
  assert.equal(
    isLinuxWebKitGtk('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36'),
    false,
  );
  assert.equal(
    isLinuxWebKitGtk('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'),
    false,
  );
  assert.equal(isLinuxWebKitGtk(''), false);
});

test('wrapWebglContextCanvasTexImage2D converts HTMLCanvasElement glyph atlas uploads to Uint8Array pixels', () => {
  const texCalls = [];
  const gl = {
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    TEXTURE_2D: 3553,
    texImage2D(...args) {
      texCalls.push(args);
    },
  };

  wrapWebglContextCanvasTexImage2D(gl);
  // Idempotent on same context
  wrapWebglContextCanvasTexImage2D(gl);

  const rawRgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]);
  const fakeCanvas = {
    width: 2,
    height: 1,
    getContext(kind) {
      if (kind !== '2d') return null;
      return {
        getImageData(x, y, w, h) {
          assert.deepEqual([x, y, w, h], [0, 0, 2, 1]);
          return { data: rawRgba };
        },
      };
    },
  };

  // 6-argument HTMLCanvasElement overload (used by @xterm/addon-webgl) -> 9-arg Uint8Array upload
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fakeCanvas);
  assert.equal(texCalls.length, 1);
  assert.equal(texCalls[0].length, 9);
  assert.deepEqual(texCalls[0].slice(0, 8), [gl.TEXTURE_2D, 0, gl.RGBA, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE]);
  assert.ok(texCalls[0][8] instanceof Uint8Array);
  assert.deepEqual(Array.from(texCalls[0][8]), [10, 20, 30, 255, 40, 50, 60, 128]);

  // 9-argument HTMLCanvasElement overload -> converted cleanly as well
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, fakeCanvas);
  assert.equal(texCalls.length, 2);
  assert.ok(texCalls[1][8] instanceof Uint8Array);

  // Direct Uint8Array upload passes through untouched
  const directPixels = new Uint8Array([255, 0, 0, 255]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, directPixels);
  assert.equal(texCalls.length, 3);
  assert.equal(texCalls[2][8], directPixels);
});

test('loadWebglAddonWithBlendFix installs canvas texImage2D pixel upload fix when Linux WebKitGTK mode is enabled', () => {
  const texCalls = [];
  const fakeGl = {
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    ONE: 1,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    TEXTURE_2D: 3553,
    blendFunc() {},
    blendFuncSeparate() {},
    texImage2D(...args) {
      texCalls.push(args);
    },
  };
  const proto = { getContext: (id) => (id === 'webgl2' ? fakeGl : null) };
  const fakeCanvas = {
    width: 1,
    height: 1,
    getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) }),
  };

  loadWebglAddonWithBlendFix(
    {
      loadAddon() {
        const gl = proto.getContext('webgl2');
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fakeCanvas);
      },
    },
    {},
    proto,
    true,
  );

  assert.equal(texCalls.length, 1);
  assert.equal(texCalls[0].length, 9);
  assert.ok(texCalls[0][8] instanceof Uint8Array);
  assert.deepEqual(Array.from(texCalls[0][8]), [1, 2, 3, 255]);
});
