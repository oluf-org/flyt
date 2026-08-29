// The block editor's geometry half (t-0074), kept free of React so the
// contract is testable in node:test without a renderer. BlockEditor.jsx is the
// thin view over it; the whole "boxes come from layout(), missing blocks are
// drawn as missing, containers are boxes not edges, nothing about position is
// stored" rule lives here so a test can hold the renderer to it.
//
// Geometry is DERIVED from the tree (D59): `layout(root)` is a pure function of
// containment, so there is nothing to store and no .layout.json. The renderer
// draws those boxes absolute — moving anything means moving it in the tree,
// which is t-0075 and does not exist yet, so this phase is read-only.

// Import the browser-safe pure modules directly. The #kernel barrel also
// exports main-process loaders and session stores; importing it here made Vite
// crawl node:fs/node:path modules even though this renderer only needs math.
import { layout } from '#kernel/stack/layout.js';
import { walk } from '#kernel/stack/types.js';
import { missingBlocks } from '#kernel/plugins/blocks.js';

/** Stack units to CSS px. The kernel's metrics are ratios, not pixels. */
export const LAYOUT_SCALE = 1;

/** One node's rectangle, in rendered CSS px. */
export function renderBox(box, scale = LAYOUT_SCALE) {
  return {
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

/** What a block node looks like: its title, then the use it resolves to. */
export function blockLabel(node) {
  return { title: node.title ?? node.use, use: node.use };
}

/** How one node renders: a block whose use nothing installed is MISSING. */
export function blockView(node, resolve) {
  const label = blockLabel(node);
  const installed = node.kind === 'block' && Boolean(resolve?.(node.use));
  return { ...label, missing: node.kind === 'block' && !installed };
}

/**
 * The whole render view of a stack, geometry and all.
 *
 * @param root — the stack's root node.
 * @param blocks — the registry to resolve `use` through. Omitted (no registry
 *   in the caller's context yet), every block renders missing: nothing is
 *   installed, and nothing claims otherwise.
 * @param scale — stack units to px.
 * @returns `{ boxes, width, height }` where `boxes[id]` is
 *   `{ box, node, missing }`, followed through `walk` so parents come first.
 */
export function editorGeometry(root, blocks = null, scale = LAYOUT_SCALE) {
  const at = layout(root);
  const missing = new Set(
    blocks
      ? missingBlocks(blocks, root).map(m => m.id)
      : [...walk(root)].filter(n => n.kind === 'block').map(n => n.id),
  );
  const boxes = {};
  for (const node of walk(root)) {
    boxes[node.id] = {
      box: renderBox(at.boxes[node.id], scale),
      node,
      missing: missing.has(node.id),
    };
  }
  return { boxes, width: at.width * scale, height: at.height * scale };
}
