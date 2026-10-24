/**
 * Split tree — the geometry of a terminal tab.
 *
 * A tab's panes are leaves of a binary tree; every internal node splits its rectangle in two,
 * either side by side (`row`) or stacked (`column`), at an adjustable `ratio`. Splitting the
 * focused pane replaces its leaf with a split node holding the old pane and the new one, so any
 * pane can be split in any direction at any depth: there is no pane limit baked into the shape and
 * nothing "snaps" to a grid.
 *
 * Everything here is pure (no React, no DOM) so it can be unit-tested directly.
 * See tests/split-tree.test.mjs.
 */

/** `row` places the two children side by side; `column` stacks them. */
export type SplitAxis = 'row' | 'column';
export type SplitDirection = 'left' | 'right' | 'up' | 'down';

export interface LeafNode {
  type: 'leaf';
  paneId: string;
}

export interface SplitNode {
  type: 'split';
  /** Stable id, used by the UI to address a divider while it is dragged. Unique within a tree. */
  id: string;
  axis: SplitAxis;
  /** Fraction of the node's extent given to `first`, kept within [MIN_RATIO, MAX_RATIO]. */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

/** A rectangle in unit space: (0,0) is the top-left of the tab, (1,1) the bottom-right. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitGeometry {
  id: string;
  axis: SplitAxis;
  ratio: number;
  /** The rectangle the split node divides (both children together). */
  rect: Rect;
}

export const MIN_RATIO = 0.08;
export const MAX_RATIO = 0.92;
const EPS = 1e-6;

export function leaf(paneId: string): LeafNode {
  return { type: 'leaf', paneId };
}

let idCounter = 0;
/** A fresh, collision-free id for a split node created by a user action. */
export function newSplitId(): string {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Split ids for trees built from a template are derived from their content (axis, first leaf,
 * leaf count), so rebuilding the same template twice yields the same ids and a divider never
 * loses its identity between renders. They are unique within a tree: two nodes sharing a first
 * leaf are ancestor and descendant and so have different leaf counts. The `t:` prefix keeps
 * them disjoint from the random `n…` ids above.
 */
function templateSplit(axis: SplitAxis, first: LayoutNode, second: LayoutNode, ratio: number): SplitNode {
  const count = countLeaves(first) + countLeaves(second);
  return { type: 'split', id: `t:${axis}:${firstLeafId(first)}:${count}`, axis, ratio, first, second };
}

export function leafIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.type === 'leaf') {
    out.push(node.paneId);
  } else {
    leafIds(node.first, out);
    leafIds(node.second, out);
  }
  return out;
}

export function countLeaves(node: LayoutNode): number {
  return node.type === 'leaf' ? 1 : countLeaves(node.first) + countLeaves(node.second);
}

export function hasLeaf(node: LayoutNode, paneId: string): boolean {
  return node.type === 'leaf' ? node.paneId === paneId : hasLeaf(node.first, paneId) || hasLeaf(node.second, paneId);
}

export function firstLeafId(node: LayoutNode): string {
  return node.type === 'leaf' ? node.paneId : firstLeafId(node.first);
}

export function lastLeafId(node: LayoutNode): string {
  return node.type === 'leaf' ? node.paneId : lastLeafId(node.second);
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Split `targetId` in `direction`, placing `newId` on that side of it. The new pane takes half
 * of the target's space. Returns the tree unchanged if `targetId` is not a leaf.
 */
export function splitLeaf(
  tree: LayoutNode,
  targetId: string,
  newId: string,
  direction: SplitDirection,
  makeId: () => string = newSplitId
): LayoutNode {
  const axis: SplitAxis = direction === 'left' || direction === 'right' ? 'row' : 'column';
  const newFirst = direction === 'left' || direction === 'up';
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.paneId !== targetId) return node;
      const fresh = leaf(newId);
      return {
        type: 'split',
        id: makeId(),
        axis,
        ratio: 0.5,
        first: newFirst ? fresh : node,
        second: newFirst ? node : fresh,
      };
    }
    const first = walk(node.first);
    const second = walk(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return walk(tree);
}

/**
 * Remove a pane. Its sibling takes over the parent's space. `focus` is the pane that should
 * receive focus afterwards: the neighbour that grew into the freed space.
 */
export function removeLeaf(tree: LayoutNode, paneId: string): { tree: LayoutNode | null; focus: string | null } {
  const result = { focus: null as string | null };
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'leaf') return node.paneId === paneId ? null : node;
    const first = walk(node.first);
    const second = walk(node.second);
    if (first === null && second === null) return null;
    if (first === null) {
      result.focus = firstLeafId(second as LayoutNode);
      return second;
    }
    if (second === null) {
      result.focus = lastLeafId(first);
      return first;
    }
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return { tree: walk(tree), focus: result.focus };
}

export function mapLeaves(tree: LayoutNode, fn: (paneId: string) => string): LayoutNode {
  if (tree.type === 'leaf') {
    const next = fn(tree.paneId);
    return next === tree.paneId ? tree : leaf(next);
  }
  const first = mapLeaves(tree.first, fn);
  const second = mapLeaves(tree.second, fn);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

/** Exchange the positions of two panes. Split sizes stay where they are. */
export function swapLeaves(tree: LayoutNode, a: string, b: string): LayoutNode {
  if (a === b) return tree;
  return mapLeaves(tree, (id) => (id === a ? b : id === b ? a : id));
}

function splitRect(rect: Rect, axis: SplitAxis, ratio: number): [Rect, Rect] {
  if (axis === 'row') {
    const w = rect.w * ratio;
    return [
      { x: rect.x, y: rect.y, w, h: rect.h },
      { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h },
    ];
  }
  const h = rect.h * ratio;
  return [
    { x: rect.x, y: rect.y, w: rect.w, h },
    { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h },
  ];
}

const UNIT: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** Where every pane sits, in unit space. Insertion order is the visual (left-to-right, top-to-bottom) order. */
export function computeRects(tree: LayoutNode, rect: Rect = UNIT, out: Map<string, Rect> = new Map()): Map<string, Rect> {
  if (tree.type === 'leaf') {
    out.set(tree.paneId, rect);
    return out;
  }
  const [a, b] = splitRect(rect, tree.axis, tree.ratio);
  computeRects(tree.first, a, out);
  computeRects(tree.second, b, out);
  return out;
}

/** Every divider with the rectangle it spans, for rendering drag handles. */
export function computeSplits(tree: LayoutNode, rect: Rect = UNIT, out: SplitGeometry[] = []): SplitGeometry[] {
  if (tree.type === 'leaf') return out;
  out.push({ id: tree.id, axis: tree.axis, ratio: tree.ratio, rect });
  const [a, b] = splitRect(rect, tree.axis, tree.ratio);
  computeSplits(tree.first, a, out);
  computeSplits(tree.second, b, out);
  return out;
}

/** Move one divider. Returns the same tree object when nothing changes. */
export function setRatio(tree: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const next = clampRatio(ratio);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') return node;
    if (node.id === splitId) {
      return Math.abs(node.ratio - next) < EPS ? node : { ...node, ratio: next };
    }
    const first = walk(node.first);
    const second = walk(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return walk(tree);
}

/** How many equal-sized panes fit along `axis` inside `node` (perpendicular splits count once). */
function weight(node: LayoutNode, axis: SplitAxis): number {
  if (node.type === 'leaf') return 1;
  const a = weight(node.first, axis);
  const b = weight(node.second, axis);
  return node.axis === axis ? a + b : Math.max(a, b);
}

/** Give every pane an equal share along each axis. */
export function equalize(tree: LayoutNode): LayoutNode {
  if (tree.type === 'leaf') return tree;
  const a = weight(tree.first, tree.axis);
  const b = weight(tree.second, tree.axis);
  return { ...tree, ratio: clampRatio(a / (a + b)), first: equalize(tree.first), second: equalize(tree.second) };
}

/**
 * The pane next to `fromId` in `direction`, judged by on-screen geometry rather than by tree
 * shape, so it behaves sensibly for any arrangement. Among panes that touch the focused pane's
 * edge it picks the nearest, then the one overlapping it the most. With `wrap`, moving past the
 * edge lands on the opposite side of the same row/column.
 */
export function neighborPane(tree: LayoutNode, fromId: string, direction: SplitDirection, wrap = true): string | null {
  const rects = computeRects(tree);
  const cur = rects.get(fromId);
  if (!cur) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down';
  const lo = (r: Rect) => (horizontal ? r.x : r.y);
  const hi = (r: Rect) => (horizontal ? r.x + r.w : r.y + r.h);
  const crossLo = (r: Rect) => (horizontal ? r.y : r.x);
  const crossHi = (r: Rect) => (horizontal ? r.y + r.h : r.x + r.w);
  const crossMid = (r: Rect) => (crossLo(r) + crossHi(r)) / 2;

  interface Candidate {
    id: string;
    gap: number;
    overlap: number;
    centerDiff: number;
  }
  const candidates: Candidate[] = [];
  const sameLine: Candidate[] = [];
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    const overlap = Math.min(crossHi(r), crossHi(cur)) - Math.max(crossLo(r), crossLo(cur));
    if (overlap <= EPS) continue;
    const gap = forward ? lo(r) - hi(cur) : lo(cur) - hi(r);
    const entry = { id, gap, overlap, centerDiff: Math.abs(crossMid(r) - crossMid(cur)) };
    if (gap >= -EPS) candidates.push(entry);
    else sameLine.push(entry);
  }

  const best = (list: Candidate[], cmp: (a: Candidate, b: Candidate) => number): string | null => {
    let pick: Candidate | null = null;
    for (const c of list) if (!pick || cmp(c, pick) < 0) pick = c;
    return pick ? pick.id : null;
  };
  const byOverlap = (a: Candidate, b: Candidate) => {
    if (Math.abs(a.overlap - b.overlap) > EPS) return b.overlap - a.overlap;
    return a.centerDiff - b.centerDiff;
  };

  const found = best(candidates, (a, b) => {
    if (Math.abs(a.gap - b.gap) > EPS) return a.gap - b.gap;
    return byOverlap(a, b);
  });
  if (found || !wrap) return found;

  // Nothing further along: wrap to the far end of the same row/column.
  // (Every pane on the near side has a negative gap; the most negative one is the farthest.)
  return best(sameLine, (a, b) => {
    if (Math.abs(a.gap - b.gap) > EPS) return a.gap - b.gap;
    return byOverlap(a, b);
  });
}

// ── Templates ────────────────────────────────────────────────────────────────

function evenChain(axis: SplitAxis, nodes: LayoutNode[]): LayoutNode {
  if (nodes.length === 1) return nodes[0];
  const rest = evenChain(axis, nodes.slice(1));
  return templateSplit(axis, nodes[0], rest, 1 / nodes.length);
}

function gridTree(ids: string[]): LayoutNode {
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: LayoutNode[] = [];
  for (let i = 0; i < ids.length; i += cols) {
    rows.push(evenChain('row', ids.slice(i, i + cols).map(leaf)));
  }
  return evenChain('column', rows);
}

/**
 * Build a tree for a named arrangement, with `ids` in visual order. Accepts the legacy layout
 * names so workspaces saved by older versions open exactly as they were; new arrangements
 * generalise to any pane count.
 *
 * - `columns` / `rows`: equal strips.
 * - `grid`: as square as possible; a short last row stretches to the full width.
 * - `main-left|right|top|bottom`: one large pane plus the rest in an equal strip beside it.
 *   (`main-right` and `main-bottom` use the *last* pane as the large one, as they always have.)
 */
export function treeFromLayout(layout: string | undefined, ids: string[]): LayoutNode {
  if (ids.length === 0) throw new Error('treeFromLayout needs at least one pane');
  if (ids.length === 1) return leaf(ids[0]);
  const leaves = ids.map(leaf);
  const n = ids.length;
  switch (layout) {
    case 'vertical':
    case 'columns':
    case '3-columns':
    case '4-columns':
      return evenChain('row', leaves);
    case 'horizontal':
    case 'rows':
    case '3-rows':
      return evenChain('column', leaves);
    case 'main-left':
      return n === 2 ? evenChain('row', leaves) : templateSplit('row', leaves[0], evenChain('column', leaves.slice(1)), 0.5);
    case 'main-right':
      return n === 2
        ? evenChain('row', leaves)
        : templateSplit('row', evenChain('column', leaves.slice(0, -1)), leaves[n - 1], 0.5);
    case 'main-top':
      return n === 2 ? evenChain('column', leaves) : templateSplit('column', leaves[0], evenChain('row', leaves.slice(1)), 0.5);
    case 'main-bottom':
      return n === 2
        ? evenChain('column', leaves)
        : templateSplit('column', evenChain('row', leaves.slice(0, -1)), leaves[n - 1], 0.5);
    case 'grid':
    default:
      return n === 2 ? evenChain('row', leaves) : gridTree(ids);
  }
}

// ── Validation and repair ────────────────────────────────────────────────────

/** Deep structural check. Trees come from localStorage and presets, so never trust their shape. */
export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'leaf') return typeof v.paneId === 'string' && v.paneId.length > 0;
  if (v.type !== 'split') return false;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    (v.axis === 'row' || v.axis === 'column') &&
    typeof v.ratio === 'number' &&
    Number.isFinite(v.ratio) &&
    v.ratio > 0 &&
    v.ratio < 1 &&
    isLayoutNode(v.first) &&
    isLayoutNode(v.second)
  );
}

/**
 * Return a tree whose leaves are exactly `paneIds`.
 *
 * A valid, matching tree is returned as-is (same object). A tree that drifted from the pane
 * list is repaired: unknown leaves are dropped and new panes are split in beside the last one.
 * A missing or unusable tree is rebuilt from `legacyLayout` (the name old versions stored), or
 * a sensible default. Returns null only when there are no panes.
 */
export function ensureTree(tree: unknown, paneIds: string[], legacyLayout?: string): LayoutNode | null {
  if (paneIds.length === 0) return null;
  const want = new Set(paneIds);
  if (isLayoutNode(tree)) {
    const ids = leafIds(tree);
    const have = new Set(ids);
    if (ids.length === have.size) {
      if (have.size === want.size && ids.every((id) => want.has(id))) return tree;
      let repaired: LayoutNode | null = tree;
      for (const id of ids) {
        if (!want.has(id) && repaired) repaired = removeLeaf(repaired, id).tree;
      }
      if (repaired) {
        for (const id of paneIds) {
          if (!hasLeaf(repaired, id)) repaired = splitLeaf(repaired, lastLeafId(repaired), id, 'right', () => `t:add:${id}`);
        }
        return repaired;
      }
    }
  }
  return treeFromLayout(legacyLayout, paneIds);
}

/**
 * A tree for saving in a preset: leaf ids become the pane's index in `orderedPaneIds`, so the
 * preset is independent of the live pane ids.
 */
export function toPresetTree(tree: LayoutNode, orderedPaneIds: string[]): LayoutNode {
  const index = new Map(orderedPaneIds.map((id, i) => [id, String(i)]));
  return mapLeaves(tree, (id) => index.get(id) ?? id);
}

/**
 * Instantiate a preset tree for freshly created panes (`newPaneIds[i]` replaces leaf "i").
 * Returns null if the preset tree is malformed or does not describe exactly those panes.
 */
export function fromPresetTree(tree: unknown, newPaneIds: string[]): LayoutNode | null {
  if (!isLayoutNode(tree)) return null;
  const ids = leafIds(tree);
  const wanted = new Set(newPaneIds.map((_, i) => String(i)));
  if (ids.length !== newPaneIds.length || new Set(ids).size !== ids.length || !ids.every((id) => wanted.has(id))) {
    return null;
  }
  return mapLeaves(tree, (id) => newPaneIds[Number(id)]);
}
