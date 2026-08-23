/**
 * Geometry, derived from containment.
 *
 * There is no stored layout file and no unparseable arrangement (D59). The v1
 * canvas kept `flows/<id>.layout.json` beside the flow — presentation state
 * that could disagree with the graph, and did — and the v2 answer is that
 * there is nothing to store: the same tree laid out twice gives the same
 * boxes, so a layout is something you compute rather than something you keep.
 *
 * Pure, and free of the browser on purpose (D63).
 *
 * @module #kernel/stack/layout
 */
import { isContainer, type ForEachNode, type RepeatNode, type StackNode, type UntilNode } from './types.js';

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

/** The sizes the geometry is built from. */
export interface LayoutMetrics {
  blockWidth: number;
  blockHeight: number;
  gap: number;
  padding: number;
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
/**
 * How many copies of its body a container draws.
 *
 * A repeat is authored with a literal count and shows every pass. A for-each is
 * bounded by `max` but its roster comes from a block that has not run yet, and
 * an until may stop after one pass or use all of them — for both, one body is
 * the honest drawing, and `max` empty copies would be a picture of the bound
 * rather than of the stack.
 */
const bodies = (node: RepeatNode | ForEachNode | UntilNode): number =>
  (node.kind === 'repeat' ? node.count : 1);

function measure(node: StackNode, m: LayoutMetrics): { width: number; height: number } {
  if (!isContainer(node)) return { width: m.blockWidth, height: m.blockHeight };

  const kids = node.children.map(child => measure(child, m));
  const gaps = m.gap * (Math.max(kids.length, 1) - 1);

  if (node.kind === 'sequence') {
    return {
      width: Math.max(...kids.map(k => k.width)) + m.padding * 2,
      height: kids.reduce((n, k) => n + k.height, 0) + gaps + m.padding * 2 + m.header,
    };
  }
  if (node.kind === 'parallel') {
    return {
      width: kids.reduce((n, k) => n + k.width, 0) + gaps + m.padding * 2,
      height: Math.max(...kids.map(k => k.height)) + m.padding * 2 + m.header,
    };
  }
  if (node.kind === 'if') {
    // The if shows both branches side by side, so a reader can see the choice.
    const body = stackSize(node.children, m);
    const other = node.else ? stackSize(node.else, m) : { width: 0, height: 0 };
    return {
      width: body.width + (node.else ? other.width + m.gap : 0) + m.padding * 2,
      height: Math.max(body.height, other.height) + m.padding * 2 + m.header,
    };
  }
  // Repeat: as wide as the widest child, and count bodies deep. A for-each
  // draws its body ONCE — the roster is not known until the block above it has
  // run, and drawing `max` empty copies would be a picture of the bound rather
  // than of the stack.
  const childWidth = Math.max(...kids.map(k => k.width));
  const childHeight = kids.reduce((n, k) => n + k.height, 0) + gaps;
  return {
    width: childWidth + m.padding * 2,
    height: childHeight * bodies(node) + m.padding * 2 + m.header,
  };
}

function stackSize(children: StackNode[], m: LayoutMetrics): { width: number; height: number } {
  if (!children.length) return { width: 0, height: 0 };
  const kids = children.map(child => measure(child, m));
  const gaps = m.gap * (kids.length - 1);
  return {
    width: Math.max(...kids.map(k => k.width)),
    height: kids.reduce((n, k) => n + k.height, 0) + gaps,
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
  if (node.kind === 'if') {
    const bodyWidth = node.children.length ? stackSize(node.children, m).width : 0;
    const bodyHeight = node.children.length ? stackSize(node.children, m).height : 0;
    let cursor = inner.x;
    for (const child of node.children) {
      const childSize = measure(child, m);
      const available = bodyWidth;
      place(child, inner.x + (available - childSize.width) / 2, cursor, m, into);
      cursor += childSize.height + m.gap;
    }
    if (node.else) {
      const otherX = inner.x + bodyWidth + m.gap;
      const otherWidth = stackSize(node.else, m).width;
      let oy = inner.y;
      for (const child of node.else) {
        const childSize = measure(child, m);
        place(child, otherX + (otherWidth - childSize.width) / 2, oy, m, into);
        oy += childSize.height + m.gap;
      }
    }
    return;
  }
  // Repeat: body measured once, slots laid out count times; a for-each once.
  const bodyHeight = node.children.reduce((n, child) => n + measure(child, m).height, 0)
    + m.gap * (node.children.length - 1);
  for (let i = 0; i < bodies(node); i++) {
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
 */
export function hits(at: Layout, x: number, y: number): string[] {
  const inside = Object.entries(at.boxes).filter(([, b]) =>
    x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
  inside.sort((a, b) => a[1].width * a[1].height - b[1].width * b[1].height);
  return inside.map(([id]) => id);
}