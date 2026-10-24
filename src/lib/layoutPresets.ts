import type { Layout, Host, Pane, LayoutPreset, LayoutPresetPane } from './types';
import { leafIds, toPresetTree, type LayoutNode } from './splitTree';

export type { LayoutPreset, LayoutPresetPane };

export const BUILTIN_LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'builtin-dual-vert',
    name: 'Dual Vertical (50/50)',
    description: '50/50 vertical side-by-side',
    createdAt: 0,
    layout: 'vertical',
    isBuiltin: true,
    panes: [
      { hostId: '__current__', label: 'Pane 1 (Left)' },
      { hostId: '__local__', isLocal: true, label: 'Pane 2 (Right)' },
    ],
  },
  {
    id: 'builtin-dual-horiz',
    name: 'Dual Horizontal (50/50)',
    description: '50/50 horizontal stacked',
    createdAt: 0,
    layout: 'horizontal',
    isBuiltin: true,
    panes: [
      { hostId: '__current__', label: 'Pane 1 (Top)' },
      { hostId: '__local__', isLocal: true, label: 'Pane 2 (Bottom)' },
    ],
  },
  {
    id: 'builtin-main-left',
    name: 'Main Left + 2 Stacked Right',
    description: 'Large left IDE pane + 2 right stack',
    createdAt: 0,
    layout: 'main-left',
    isBuiltin: true,
    panes: [
      { hostId: '__current__', label: 'Main Left' },
      { hostId: '__local__', isLocal: true, label: 'Top Right' },
      { hostId: '__local__', isLocal: true, label: 'Bottom Right' },
    ],
  },
  {
    id: 'builtin-main-top',
    name: 'Main Top + 2 Side Bottom',
    description: 'Wide top editor + 2 bottom terminals',
    createdAt: 0,
    layout: 'main-top',
    isBuiltin: true,
    panes: [
      { hostId: '__current__', label: 'Main Top' },
      { hostId: '__local__', isLocal: true, label: 'Bottom Left' },
      { hostId: '__local__', isLocal: true, label: 'Bottom Right' },
    ],
  },
  {
    id: 'builtin-3-cols',
    name: 'Triple Columns (33/33/33)',
    description: '3 equal vertical columns',
    createdAt: 0,
    layout: '3-columns',
    isBuiltin: true,
    panes: [
      { hostId: '__current__', label: 'Column 1' },
      { hostId: '__local__', isLocal: true, label: 'Column 2' },
      { hostId: '__local__', isLocal: true, label: 'Column 3' },
    ],
  },
  {
    id: 'builtin-quad-grid',
    name: 'Quad Grid (2x2)',
    description: '4-quadrant 2x2 terminal grid',
    createdAt: 0,
    layout: 'grid',
    isBuiltin: true,
    panes: [
      { hostId: '__current__', label: 'Top Left' },
      { hostId: '__local__', isLocal: true, label: 'Top Right' },
      { hostId: '__local__', isLocal: true, label: 'Bottom Left' },
      { hostId: '__local__', isLocal: true, label: 'Bottom Right' },
    ],
  },
];

const PRESETS_STORAGE_KEY = 'drx.layout_presets.v1';

export function loadUserLayoutPresets(): LayoutPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveUserLayoutPresets(presets: LayoutPreset[]): void {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {}
}

/** Snapshot a tab's free-form arrangement. Panes are stored in visual order. */
export function createUserPreset(
  name: string,
  tree: LayoutNode,
  panes: Pane[],
  hostMap: Map<string, Host>
): LayoutPreset {
  const order = leafIds(tree);
  const byId = new Map(panes.map((p) => [p.id, p]));
  const ordered = order.map((id) => byId.get(id)).filter((p): p is Pane => !!p);
  const presetPanes: LayoutPresetPane[] = ordered.map((p) => {
    const h = hostMap.get(p.hostId);
    const lbl = h?.label || (p.isLocal ? 'Local Terminal' : 'Remote Session');
    return {
      hostId: p.hostId,
      isLocal: p.isLocal,
      label: lbl,
      hostLabel: lbl,
      color: h?.color ?? undefined,
    };
  });

  return {
    id: 'preset_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    name: name.trim() || 'Custom Layout',
    description: `${ordered.length} panes (${getLayoutDescription('custom')})`,
    createdAt: Date.now(),
    layout: 'custom',
    tree: toPresetTree(tree, order),
    panes: presetPanes,
    isBuiltin: false,
  };
}

export function getLayoutDescription(layout: Layout): string {
  switch (layout) {
    case 'vertical':
      return '2 Columns (Side-by-side)';
    case 'horizontal':
      return '2 Rows (Stacked)';
    case 'main-left':
      return '1 Main Left + 2 Stacked Right';
    case 'main-right':
      return '2 Stacked Left + 1 Main Right';
    case 'main-top':
      return '1 Main Top + 2 Side-by-side Bottom';
    case 'main-bottom':
      return '2 Side-by-side Top + 1 Main Bottom';
    case '3-columns':
      return '3 Columns (Side-by-side)';
    case '3-rows':
      return '3 Rows (Stacked)';
    case '4-columns':
      return '4 Columns (Side-by-side)';
    case 'columns':
      return 'Columns (Side-by-side)';
    case 'rows':
      return 'Rows (Stacked)';
    case 'grid':
      return 'Grid';
    case 'custom':
      return 'Free-form split layout';
    case 'single':
    default:
      return 'Single Pane';
  }
}
