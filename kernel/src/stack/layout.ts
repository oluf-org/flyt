/**
 * Geometry, derived from containment.
 *
 * There is no stored layout file and no unparseable arrangement (D59). The v1
 * canvas kept `flows/<id>.layout.json` beside the flow — presentation state
 * that could disagree with the graph, and did — and the v2 answer is that
 * there is nothing to store: the same tree laid out twice gives the same
 * boxes, so a layout is something you compute rather than something you keep.
 *
 * Pure, and free of the browser on purpose. A layout that needed measurement
 * could not be tested without a DOM, could not be rendered by the CLI, and
 * could not be reasoned about by the agent editing the stack — and the same
 * boxes have to serve all three (D63).
 *
 * @module #kernel/stack/layout
 */
import { isContainer, type StackNode } from './types.js';

/** One node's rectangle, in stack units. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every box, and the extent that holds them. */
export interface Layout {
  /** Node id to rectangle, containers included — the editor addresses both. */
  boxes: Record<string, Box>;
  width: number;
  height: number;
}

/**
 * The sizes the geometry is built from.
 *
 * Units, not pixels. The renderer scales; what matters here is the ratios, and
 * that they are the same everywhere the layout is computed.
 */
export interface LayoutMetrics {
  /** A leaf block's footprint. */
  blockWidth: number;
  blockHeight: number;
  /** Between siblings, along whichever axis the container runs. */
  gap: number;
  /** Between a container's edge and its children. */
  padding: number;
  /** Room at the top of a container for its own label. */
  header: number;
}

/** What a stack looks like when nobody has said otherwise. */
export const METRICS: LayoutMetrics = {
  blockWidth: 240,
  blockHeight: 96,
  gap: 24,
  padding: 16,
  header: 28,
};

/** The size a node needs, before anything decides where to put it. */
function measure(node: StackNode, m: LayoutMetrics): { width: number; height: number } {
  if (!isContainer(node)) return { width: m.blockWidth, height: m.blockHeight };

  const kids = node.children.map(child => measure(child, m));
  const gaps = m.gap * (kids.length - 1);

  if (node.kind === 'sequence') {
    // Top to bottom: as wide as the widest child, as tall as all of them.
    return {
      width: Math.max(...kids.map(k => k.width)) + m.padding * 2,
      height: kids.reduce((n, k) => n + k.height, 0) + gaps + m.padding * 2 + m.header,
    };
  }
  if (node.kind === 'parallel') {
    // Side by side: as wide as all the lanes, as tall as the tallest.
    return {
      width: kids.reduce((n, k) => n + k.width, 0) + gaps + m.padding * 2,
      height: Math.max(...kids.map(k => k.height)) + m.padding * 2 + m.header,
    };
  }
  // A repeat runs its body count times in sequence: as wide as the widest
  // child, and count bodies deep.
  const childWidth = Math.max(...kids.map(k => k.width));
  const childHeight = kids.reduce((n, k) => n + k.height, 0) + gaps;
  return {
    width: childWidth + m.padding * 2,
    height: childHeight * node.count + m.padding * 2 + m.header,
  };
}

function place(node: StackNode, x: number, y: number, m: LayoutMetrics, into: Record<string, Box>): void {
  const size = measure(node, m);
  into[node.id] = { x, y, width: size.width, height: size.height };
  if (!isContainer(node)) return;

  const inner = { x: x + m.padding, y: y + m.padding + m.header };
  if (node.kind === 'sequence') {
    let cursor = inner.y;
    for (const child of node.children) {
      // Centred across the container's inner width, so a narrow block under a
      // wide one reads as one column rather than a ragged left edge.
      const childSize = measure(child, m);
      const available = size.width - m.padding * 2;
      place(child, inner.x + (available - childSize.width) / 2, cursor, m, into);
      cursor += childSize.height + m.gap;
    }
    return;
  }
  if (node.kind === 'parallel') {
    let cursor = inner.x;
    for (const child of node.children) {
      const childSize = measure(child, m);
      place(child, cursor, inner.y, m, into);
      cursor += childSize.width + m.gap;
    }
    return;
  }
  // Repeat: the body is measured once and its slots laid out count times,
  // which is what the measure() height above promised.
  const bodyHeight = node.children.reduce((n, child) => n + measure(child, m).height, 0)
    + m.gap * (node.children.length - 1);
  for (let i = 0; i < node.count; i++) {
    let cursor = inner.y + bodyHeight * i;
    for (const child of node.children) {
      const childSize = measure(child, m);
      const available = size.width - m.padding * 2;
      place(child, inner.x + (available - childSize.width) / 2, cursor, m, into);
      cursor += childSize.height + m.gap;
    }
  }
}

/**
 * Lay a stack out.
 *
 * @param root — the stack's root node.
 * @param metrics — sizes to build from; the defaults are {@link METRICS}.
 * @returns every box, keyed by node id, and the extent that holds them.
 */
export function layout(root: StackNode, metrics: Partial<LayoutMetrics> = {}): Layout {
  const m = { ...METRICS, ...metrics };
  const boxes: Record<string, Box> = {};
  place(root, 0, 0, m, boxes);
  const size = boxes[root.id]!;
  return { boxes, width: size.width, height: size.height };
}

/**
 * Which node is at this point, innermost first.
 *
 * What a click resolves to. Innermost wins, because a container's box contains
 * every child's — a drop onto a block inside a lane is a drop into that lane,
 * not onto the parallel that holds it.
 *
 * @param at — the layout to search.
 * @param x — horizontal position, in stack units.
 * @param y — vertical position.
 * @returns node ids, innermost first; empty when the point is outside everything.
 */
export function hits(at: Layout, x: number, y: number): string[] {
  const inside = Object.entries(at.boxes).filter(([, b]) =>
    x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
  // Smaller area is deeper: a child is always strictly inside its parent.
  inside.sort((a, b) => a[1].width * a[1].height - b[1].width * b[1].height);
  return inside.map(([id]) => id);
}
