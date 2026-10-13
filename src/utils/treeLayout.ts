import { ALL_ELEMENTS, ELEMENT_REGISTRY } from '@/data/elements';
import type { ElementId } from '@/types';

export interface TreePoint {
  x: number;
  y: number;
  /** Row index = generation depth, 0 for the primordials. */
  row: number;
}

export interface TreeLayout {
  width: number;
  height: number;
  rows: { row: number; label: string; y: number; ids: ElementId[] }[];
  points: Record<string, TreePoint>;
}

export interface TreeLayoutOptions {
  width?: number;
  height?: number;
  nodeSize?: number;
  /** Horizontal breathing room between two nodes in a row. */
  gap?: number;
  /** Space reserved above the first row and below the last for their labels. */
  topPad?: number;
  bottomPad?: number;
  sidePad?: number;
}

const TIER_LABEL: Record<string, string> = {
  primordial: 'PRIMORDIAL',
  branching: 'BRANCHING',
  advanced: 'ADVANCED',
  final: 'FINAL',
};

/** Generation depth: one more than the deepest parent, so parents always sit above children. */
export function elementDepth(id: ElementId, seen: Set<ElementId> = new Set()): number {
  if (seen.has(id)) return 0; // a cycle in the data must not recurse forever
  seen.add(id);
  const parents = ELEMENT_REGISTRY[id]?.parents ?? [];
  if (parents.length === 0) return 0;
  return 1 + Math.max(...parents.map((parent) => elementDepth(parent as ElementId, seen)));
}

/**
 * A layered (barycentre) layout for the 25-element graph.
 *
 * The old layout put each tier on a ring, which scattered a child anywhere on its
 * circle — parent lines crossed the middle of the diagram and labels collided, so
 * it read as a scatter plot rather than a tree. This does the textbook thing
 * instead: depth becomes rows, a row is ordered by the mean horizontal position of
 * each node's parents, and nodes are then relaxed toward those parents while a
 * de-overlap pass keeps the row legal. The result is that every family grows
 * downward from its own parents, which is the thing a skill tree has to say.
 */
export function layoutSkillTree(options: TreeLayoutOptions = {}): TreeLayout {
  const {
    width = 1180,
    height = 660,
    nodeSize = 54,
    gap = 46,
    topPad = 86,
    bottomPad = 64,
    sidePad = 70,
  } = options;

  const depth = new Map<ElementId, number>();
  for (const def of ALL_ELEMENTS) depth.set(def.id, elementDepth(def.id));
  const maxDepth = Math.max(0, ...Array.from(depth.values()));

  const rowY = (row: number) =>
    maxDepth === 0
      ? height / 2
      : topPad + (row * (height - topPad - bottomPad)) / maxDepth;

  // Group by row, seed the order with the registry index so the layout is stable.
  const rows: ElementId[][] = [];
  for (let row = 0; row <= maxDepth; row += 1) rows.push([]);
  for (const def of ALL_ELEMENTS) rows[depth.get(def.id) ?? 0].push(def.id);

  const xOf = new Map<ElementId, number>();
  const usable = width - sidePad * 2;

  const spread = (ids: ElementId[]) => {
    // Even slots first: this is what makes a row read as a row.
    const step = ids.length > 1 ? usable / (ids.length - 1) : 0;
    ids.forEach((id, index) => {
      xOf.set(id, ids.length > 1 ? sidePad + index * step : width / 2);
    });
  };

  spread(rows[0]);

  const minDistance = nodeSize + gap;
  for (let row = 1; row <= maxDepth; row += 1) {
    const ids = rows[row];
    const parentsOf = (id: ElementId) => (ELEMENT_REGISTRY[id]?.parents ?? []) as ElementId[];
    const barycentre = (id: ElementId) => {
      const parents = parentsOf(id).filter((parent) => xOf.has(parent));
      if (parents.length === 0) return xOf.get(id) ?? width / 2;
      return parents.reduce((sum, parent) => sum + (xOf.get(parent) ?? width / 2), 0) / parents.length;
    };
    ids.sort((a, b) => barycentre(a) - barycentre(b));
    spread(ids);
    /* Two relax passes: pull each node toward the middle of its parents, then push
       neighbours apart again so nothing ever shares a column with its sibling. */
    for (let pass = 0; pass < 2; pass += 1) {
      for (const id of ids) xOf.set(id, barycentre(id));
      ids.sort((a, b) => (xOf.get(a) ?? 0) - (xOf.get(b) ?? 0));
      for (let index = 1; index < ids.length; index += 1) {
        const previous = xOf.get(ids[index - 1]) ?? 0;
        const current = xOf.get(ids[index]) ?? 0;
        if (current - previous < minDistance) xOf.set(ids[index], previous + minDistance);
      }
      // Keep the row inside the diagram: shift the whole line back if it spilled right.
      const last = xOf.get(ids[ids.length - 1]) ?? 0;
      const overflow = last - (width - sidePad);
      if (overflow > 0) for (const id of ids) xOf.set(id, (xOf.get(id) ?? 0) - overflow);
      const first = xOf.get(ids[0]) ?? 0;
      const underflow = sidePad - first;
      if (underflow > 0) for (const id of ids) xOf.set(id, (xOf.get(id) ?? 0) + underflow);
    }
  }

  const points: Record<string, TreePoint> = {};
  for (let row = 0; row <= maxDepth; row += 1) {
    for (const id of rows[row]) points[id] = { x: xOf.get(id) ?? width / 2, y: rowY(row), row };
  }

  return {
    width,
    height,
    rows: rows.map((ids, row) => ({
      row,
      // A row is labelled by the tier its members mostly belong to; depth and tier
      // agree for every element in the registry, and naming the row is what lets the
      // eye read the diagram as generations.
      label: TIER_LABEL[dominantTier(ids)] ?? `GENERATION ${row + 1}`,
      y: rowY(row),
      ids,
    })),
    points,
  };
}

function dominantTier(ids: ElementId[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const tier = ELEMENT_REGISTRY[id]?.tier ?? 'branching';
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [tier, count] of counts) {
    if (count > bestCount) {
      best = tier;
      bestCount = count;
    }
  }
  return best;
}
