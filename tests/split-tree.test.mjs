import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RATIO,
  MIN_RATIO,
  computeRects,
  computeSplits,
  countLeaves,
  ensureTree,
  equalize,
  fromPresetTree,
  hasLeaf,
  isLayoutNode,
  leaf,
  leafIds,
  neighborPane,
  removeLeaf,
  setRatio,
  splitLeaf,
  swapLeaves,
  toPresetTree,
  treeFromLayout,
} from '../src/lib/splitTree.ts';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);

/** Every pane's rectangle must be inside the unit square, and together they must tile it exactly. */
function assertTiles(tree) {
  const rects = [...computeRects(tree).values()];
  let area = 0;
  for (const r of rects) {
    assert.ok(r.w > 0 && r.h > 0, 'positive size');
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, 'inside unit square');
    area += r.w * r.h;
  }
  near(area, 1, 'areas sum to 1');
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > 1e-9 && oy > 1e-9), 'panes must not overlap');
    }
  }
}

function splitIds(tree) {
  return computeSplits(tree).map((s) => s.id);
}

test('splitting a lone pane gives two halves on the requested side', () => {
  const right = splitLeaf(leaf('a'), 'a', 'b', 'right');
  assert.deepEqual(leafIds(right), ['a', 'b']);
  const left = splitLeaf(leaf('a'), 'a', 'b', 'left');
  assert.deepEqual(leafIds(left), ['b', 'a']);
  const down = splitLeaf(leaf('a'), 'a', 'b', 'down');
  const up = splitLeaf(leaf('a'), 'a', 'b', 'up');
  assert.deepEqual(leafIds(down), ['a', 'b']);
  assert.deepEqual(leafIds(up), ['b', 'a']);
  assert.deepEqual(computeRects(right).get('b'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(computeRects(down).get('b'), { x: 0, y: 0.5, w: 1, h: 0.5 });
});

test('there is no pane limit and nothing snaps to a grid', () => {
  // Ghostty-style: keep splitting the focused pane, alternating directions.
  let tree = leaf('p0');
  const dirs = ['right', 'down', 'left', 'up'];
  for (let i = 1; i <= 40; i++) tree = splitLeaf(tree, `p${i - 1}`, `p${i}`, dirs[i % 4]);
  assert.equal(countLeaves(tree), 41);
  assertTiles(tree);
  assert.equal(new Set(splitIds(tree)).size, 40, 'split ids are unique');
});

test('splitting only affects the target pane', () => {
  let tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  tree = splitLeaf(tree, 'b', 'c', 'down');
  const rects = computeRects(tree);
  assert.deepEqual(rects.get('a'), { x: 0, y: 0, w: 0.5, h: 1 }, 'a keeps its full-height half');
  assert.deepEqual(rects.get('b'), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.deepEqual(rects.get('c'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
});

test('five panes in a free-form arrangement tile the window', () => {
  // The layout from the feature request: wide top, tall middle, two panes along the bottom.
  let tree = leaf('top');
  tree = splitLeaf(tree, 'top', 'mid', 'down');
  tree = splitLeaf(tree, 'mid', 'bottom', 'down');
  tree = splitLeaf(tree, 'top', 'topRight', 'right');
  tree = splitLeaf(tree, 'bottom', 'bottomRight', 'right');
  assert.equal(countLeaves(tree), 5);
  assertTiles(tree);
});

test('splitting a missing pane leaves the tree untouched', () => {
  const tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  assert.equal(splitLeaf(tree, 'zzz', 'c', 'right'), tree);
});

test('removing a pane lets its sibling take the space', () => {
  let tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  tree = splitLeaf(tree, 'b', 'c', 'down');
  const afterC = removeLeaf(tree, 'c');
  assert.deepEqual(leafIds(afterC.tree), ['a', 'b']);
  assert.equal(afterC.focus, 'b', 'focus goes to the pane that grew');
  assert.deepEqual(computeRects(afterC.tree).get('b'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  const afterA = removeLeaf(tree, 'a');
  assert.deepEqual(computeRects(afterA.tree).get('b'), { x: 0, y: 0, w: 1, h: 0.5 }, 'remaining split survives');
  assertTiles(afterA.tree);
  assert.equal(removeLeaf(leaf('only'), 'only').tree, null);
  assert.equal(removeLeaf(leaf('only'), 'other').tree.paneId, 'only');
});

test('closing panes down to one never leaves gaps', () => {
  let tree = treeFromLayout('grid', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  for (const id of ['d', 'a', 'g', 'b', 'f', 'c']) {
    tree = removeLeaf(tree, id).tree;
    assertTiles(tree);
  }
  assert.deepEqual(leafIds(tree), ['e']);
});

test('swapping exchanges positions but keeps the sizes', () => {
  let tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  tree = setRatio(tree, tree.id, 0.3);
  const swapped = swapLeaves(tree, 'a', 'b');
  assert.deepEqual(leafIds(swapped), ['b', 'a']);
  near(computeRects(swapped).get('b').w, 0.3);
  assert.equal(swapLeaves(tree, 'a', 'a'), tree);
});

test('divider ratios are clamped and a no-op returns the same tree', () => {
  const tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  assert.equal(setRatio(tree, tree.id, 0.5), tree);
  assert.equal(setRatio(tree, tree.id, 0).ratio, MIN_RATIO);
  assert.equal(setRatio(tree, tree.id, 5).ratio, MAX_RATIO);
  assert.equal(setRatio(tree, tree.id, Number.NaN).ratio, 0.5);
  assert.equal(setRatio(tree, 'no-such-split', 0.2), tree);
});

test('equalize gives every pane in a strip the same share', () => {
  let tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  tree = splitLeaf(tree, 'b', 'c', 'right');
  tree = splitLeaf(tree, 'c', 'd', 'right');
  const even = equalize(tree);
  for (const r of computeRects(even).values()) near(r.w, 0.25);
  assertTiles(even);
});

test('equalize treats a perpendicular split as one cell', () => {
  let tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  tree = splitLeaf(tree, 'b', 'c', 'down');
  tree = setRatio(tree, tree.id, 0.8);
  const rects = computeRects(equalize(tree));
  near(rects.get('a').w, 0.5);
  near(rects.get('b').h, 0.5);
});

test('directional focus follows the geometry', () => {
  const grid = treeFromLayout('grid', ['a', 'b', 'c', 'd']);
  assert.equal(neighborPane(grid, 'a', 'right'), 'b');
  assert.equal(neighborPane(grid, 'a', 'down'), 'c');
  assert.equal(neighborPane(grid, 'd', 'left'), 'c');
  assert.equal(neighborPane(grid, 'd', 'up'), 'b');
  // Wrapping stays on the same row / column.
  assert.equal(neighborPane(grid, 'b', 'right'), 'a');
  assert.equal(neighborPane(grid, 'c', 'down'), 'a');
  assert.equal(neighborPane(grid, 'b', 'right', false), null);
});

test('directional focus picks the pane that actually touches', () => {
  // a | (b over c)
  let tree = splitLeaf(leaf('a'), 'a', 'b', 'right');
  tree = splitLeaf(tree, 'b', 'c', 'down');
  assert.equal(neighborPane(tree, 'a', 'right'), 'b', 'ties go to the first (top) pane');
  assert.equal(neighborPane(tree, 'c', 'left'), 'a');
  assert.equal(neighborPane(tree, 'b', 'down'), 'c');
  assert.equal(neighborPane(tree, 'c', 'up'), 'b');
  // A single row has nothing above or below.
  const row = treeFromLayout('columns', ['x', 'y', 'z']);
  assert.equal(neighborPane(row, 'y', 'up'), null);
  assert.equal(neighborPane(row, 'y', 'down'), null);
  assert.equal(neighborPane(row, 'z', 'right'), 'x');
  assert.equal(neighborPane(row, 'x', 'left'), 'z');
  assert.equal(neighborPane(leaf('solo'), 'solo', 'right'), null);
  assert.equal(neighborPane(row, 'missing', 'right'), null);
});

test('directional focus prefers the larger overlap', () => {
  // Tall left pane beside a narrow stack: from the bottom-right pane, left is the tall pane.
  let tree = splitLeaf(leaf('left'), 'left', 'topRight', 'right');
  tree = splitLeaf(tree, 'topRight', 'botRight', 'down');
  tree = splitLeaf(tree, 'left', 'leftBottom', 'down');
  tree = setRatio(tree, tree.id, 0.5);
  assert.equal(neighborPane(tree, 'botRight', 'left'), 'leftBottom');
  assert.equal(neighborPane(tree, 'topRight', 'left'), 'left');
});

test('every legacy layout name still produces a tiling in pane order', () => {
  const names = [
    'single', 'vertical', 'horizontal', 'grid', 'main-left', 'main-right', 'main-top', 'main-bottom',
    '3-columns', '3-rows', '4-columns', 'columns', 'rows', 'custom', undefined,
  ];
  for (const name of names) {
    for (let n = 1; n <= 9; n++) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const tree = treeFromLayout(name, ids);
      assert.deepEqual([...leafIds(tree)].sort(), [...ids].sort(), `${name}/${n} keeps every pane once`);
      assertTiles(tree);
      assert.equal(new Set(splitIds(tree)).size, n - 1, `${name}/${n} unique split ids`);
    }
  }
});

test('legacy layouts keep the geometry users already had', () => {
  const rect = (name, ids, id) => computeRects(treeFromLayout(name, ids)).get(id);
  assert.deepEqual(rect('vertical', ['a', 'b'], 'b'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(rect('horizontal', ['a', 'b'], 'b'), { x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.deepEqual(rect('main-left', ['a', 'b', 'c'], 'a'), { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(rect('main-left', ['a', 'b', 'c'], 'c'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.deepEqual(rect('main-right', ['a', 'b', 'c'], 'c'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(rect('main-top', ['a', 'b', 'c'], 'a'), { x: 0, y: 0, w: 1, h: 0.5 });
  assert.deepEqual(rect('main-bottom', ['a', 'b', 'c'], 'c'), { x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.deepEqual(rect('grid', ['a', 'b', 'c'], 'c'), { x: 0, y: 0.5, w: 1, h: 0.5 }, '3-pane grid: third spans');
  assert.deepEqual(rect('grid', ['a', 'b', 'c', 'd'], 'd'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  for (const r of computeRects(treeFromLayout('3-columns', ['a', 'b', 'c'])).values()) near(r.w, 1 / 3);
  for (const r of computeRects(treeFromLayout('4-columns', ['a', 'b', 'c', 'd'])).values()) near(r.w, 0.25);
  for (const r of computeRects(treeFromLayout('3-rows', ['a', 'b', 'c'])).values()) near(r.h, 1 / 3);
});

test('templates scale past four panes', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const grid = computeRects(treeFromLayout('grid', ids));
  assert.equal(grid.size, 5);
  near(grid.get('a').w, 1 / 3);
  near(grid.get('d').w, 0.5, 'a short last row stretches');
  const main = computeRects(treeFromLayout('main-left', ids));
  near(main.get('a').w, 0.5);
  near(main.get('e').h, 0.25);
});

test('template split ids are stable across rebuilds', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(splitIds(treeFromLayout('grid', ids)), splitIds(treeFromLayout('grid', ids)));
});

test('ensureTree returns a matching tree untouched', () => {
  const tree = treeFromLayout('grid', ['a', 'b', 'c']);
  assert.equal(ensureTree(tree, ['c', 'b', 'a']), tree);
  assert.equal(ensureTree(tree, []), null);
});

test('ensureTree builds a tree for a legacy tab that has none', () => {
  const tree = ensureTree(undefined, ['a', 'b', 'c', 'd'], 'grid');
  assert.deepEqual(leafIds(tree), ['a', 'b', 'c', 'd']);
  assert.deepEqual(computeRects(tree).get('d'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.deepEqual(leafIds(ensureTree(undefined, ['a']), []), ['a']);
  assert.deepEqual(leafIds(ensureTree(null, ['a', 'b'])), ['a', 'b']);
});

test('ensureTree repairs a tree that drifted from the pane list', () => {
  const tree = treeFromLayout('columns', ['a', 'b', 'c']);
  const dropped = ensureTree(tree, ['a', 'c']);
  assert.deepEqual([...leafIds(dropped)].sort(), ['a', 'c']);
  assertTiles(dropped);
  const added = ensureTree(tree, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual([...leafIds(added)].sort(), ['a', 'b', 'c', 'd', 'e']);
  assertTiles(added);
  assert.ok(hasLeaf(added, 'e'));
  assert.equal(new Set(splitIds(added)).size, 4);
  const swappedOut = ensureTree(tree, ['x', 'y']);
  assert.deepEqual([...leafIds(swappedOut)].sort(), ['x', 'y']);
});

test('ensureTree rebuilds from garbage', () => {
  const garbage = [
    'nope', 42, {}, { type: 'split' },
    { type: 'split', id: 's', axis: 'diagonal', ratio: 0.5, first: leaf('a'), second: leaf('b') },
    { type: 'split', id: 's', axis: 'row', ratio: 2, first: leaf('a'), second: leaf('b') },
    { type: 'split', id: 's', axis: 'row', ratio: 0.5, first: leaf('a'), second: leaf('a') },
  ];
  for (const g of garbage) {
    const tree = ensureTree(g, ['a', 'b'], 'vertical');
    assert.deepEqual([...leafIds(tree)].sort(), ['a', 'b']);
    assertTiles(tree);
  }
});

test('isLayoutNode validates shape and ratios', () => {
  assert.equal(isLayoutNode(leaf('a')), true);
  assert.equal(isLayoutNode(splitLeaf(leaf('a'), 'a', 'b', 'right')), true);
  assert.equal(isLayoutNode({ type: 'leaf', paneId: '' }), false);
  assert.equal(isLayoutNode({ type: 'leaf' }), false);
  assert.equal(isLayoutNode(null), false);
  assert.equal(isLayoutNode({ type: 'split', id: 's', axis: 'row', ratio: Number.NaN, first: leaf('a'), second: leaf('b') }), false);
});

test('a tree survives a JSON round trip (workspace persistence)', () => {
  let tree = treeFromLayout('grid', ['a', 'b', 'c', 'd', 'e']);
  tree = setRatio(tree, computeSplits(tree)[0].id, 0.3);
  const restored = JSON.parse(JSON.stringify(tree));
  assert.ok(isLayoutNode(restored));
  assert.equal(ensureTree(restored, ['a', 'b', 'c', 'd', 'e']), restored);
});

test('preset trees are independent of live pane ids', () => {
  let tree = leaf('x1');
  tree = splitLeaf(tree, 'x1', 'x2', 'right');
  tree = splitLeaf(tree, 'x2', 'x3', 'down');
  tree = splitLeaf(tree, 'x1', 'x4', 'down');
  tree = splitLeaf(tree, 'x3', 'x5', 'right');
  const order = leafIds(tree);
  const preset = JSON.parse(JSON.stringify(toPresetTree(tree, order)));
  const fresh = ['n0', 'n1', 'n2', 'n3', 'n4'];
  const rebuilt = fromPresetTree(preset, fresh);
  assert.deepEqual(leafIds(rebuilt), fresh);
  const original = [...computeRects(tree).values()];
  const again = [...computeRects(rebuilt).values()];
  assert.deepEqual(again, original, 'same geometry');
  assert.equal(fromPresetTree(preset, ['only', 'two']), null, 'wrong pane count is rejected');
  assert.equal(fromPresetTree({ type: 'leaf', paneId: '9' }, ['a']), null, 'out-of-range index is rejected');
  assert.equal(fromPresetTree('garbage', ['a']), null);
});
