import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAutoFocusTerminal,
  forceTerminalRenderSync,
  getTerminalMinimumContrastRatio,
  loadWebglAddonWithBlendFix,
  wrapWebglContextBlendFunc,
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
