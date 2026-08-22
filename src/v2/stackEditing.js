// Editing is containment (t-0075). The half that has no React in it.
//
// A drag does not move a box. It picks a SLOT — a container plus an index —
// and asks for `stack:move-block`. There is no free position to drop into, so
// there is no arrangement that saves and does not parse (D59), and the editor
// never has geometry of its own to reconcile with the tree.
//
// The other half of D63 lives here too: the editor invokes the same command a
// model invokes, and listens to the same `commands/invoke` event either way.
// Which is why an agent-driven edit animates like a dragged one without
// anybody writing a second animation for it.

import { editorGeometry } from './blockGeometry.js';

/** Which way a container lays its children out. */
export const axisOf = node => (node?.kind === 'parallel' ? 'x' : 'y');

/**
 * The innermost container under a point.
 *
 * Innermost, because containers nest and the one you meant is the smallest one
 * you are inside. `walk` yields parents before children, so the last match down
 * the list is the deepest.
 *
 * @param geometry — from {@link editorGeometry}.
 * @param point — `{ x, y }` in the same px space the boxes are in.
 * @returns the container's id, or null when the point is outside the stack.
 */
export function containerAt(geometry, point) {
  const inside = Object.entries(geometry.boxes)
    .filter(([, e]) => e.node.kind !== 'block')
    .filter(([, { box }]) => point.x >= box.x && point.x <= box.x + box.width
      && point.y >= box.y && point.y <= box.y + box.height);
  // Smaller area is deeper — the same rule `hits()` uses in the kernel, because
  // a child's box is always strictly inside its parent's. Taking the last match
  // in tree order would work for a sequence and pick the wrong lane in a
  // parallel whose later sibling happens to be larger.
  inside.sort((a, b) => (a[1].box.width * a[1].box.height) - (b[1].box.width * b[1].box.height));
  return inside[0]?.[0] ?? null;
}

/**
 * Where a drop lands: a container and an index among its children.
 *
 * The index is decided by MIDPOINTS along the container's axis — before a
 * child if the point is in its first half, after it otherwise — which is the
 * rule that makes "between these two" expressible at all. A container's own
 * child count means "last", which is what `Slot` already documents.
 *
 * @param geometry — from {@link editorGeometry}.
 * @param point — `{ x, y }` in px.
 * @param exclude — a node being dragged; it is not a drop target for itself,
 *   and its own box must not shift the index it lands at.
 * @returns `{ container, index }`, or null when the point is nowhere droppable.
 */
export function slotAt(geometry, point, exclude = null) {
  const container = containerAt(geometry, point);
  if (!container) return null;
  const node = geometry.boxes[container].node;
  const axis = axisOf(node);
  const size = axis === 'x' ? 'width' : 'height';

  let index = 0;
  for (const child of node.children) {
    if (child.id === exclude) continue;
    const box = geometry.boxes[child.id]?.box;
    if (!box) continue;
    const midpoint = box[axis] + box[size] / 2;
    if (point[axis] > midpoint) index += 1;
  }
  return { container, index };
}

/**
 * Is this drop a no-op?
 *
 * Moving a node to where it already is produces an identical tree, and an
 * animation of nothing happening reads as a bug. The `-1` is the shift a node
 * causes by leaving: dropping into the gap it is currently occupying, from
 * above, is the same position.
 */
export function isNoop(from, to) {
  if (!from || !to) return false;
  if (from.container !== to.container) return false;
  return to.index === from.index || to.index === from.index + 1;
}

/**
 * A node's current slot, read off the tree.
 *
 * The editor needs it to answer "did this drop change anything", and the undo
 * stack needs it to build the inverse. Both from the tree, never from a copy
 * the editor kept.
 */
export function slotOfNode(geometry, nodeId) {
  for (const [id, entry] of Object.entries(geometry.boxes)) {
    if (entry.node.kind === 'block') continue;
    const index = entry.node.children.findIndex(c => c.id === nodeId);
    if (index >= 0) return { container: id, index };
  }
  return null;
}

/**
 * The command that undoes one edit.
 *
 * The INVERSE COMMAND, not a saved copy of the tree. A snapshot undo drifts the
 * moment anything else edits the stack — an agent working alongside a person is
 * the normal case here (D63), and a snapshot would silently discard their work.
 * An inverse composes with whatever happened in between or fails loudly.
 *
 * `insert` is not invertible into a command that restores a removed subtree, so
 * a remove has no inverse offered rather than a wrong one.
 *
 * @param change — an `EditRecord` from `commands/invoke`.
 * @returns `{ name, args }` to invoke, or null when there is no inverse.
 */
export function inverseOf(change) {
  if (!change) return null;
  switch (change.kind) {
    case 'insert':
      return { name: 'stack:remove-block', args: { nodeId: change.nodeId } };
    case 'move':
      return change.from
        ? { name: 'stack:move-block', args: { nodeId: change.nodeId, to: change.from } }
        : null;
    // A removed subtree is not in the record, so there is nothing to put back.
    // Offering an inverse that restores an empty block would be worse than
    // offering none.
    case 'remove':
      return null;
    case 'configure':
      return change.previousConfig
        ? { name: 'stack:configure-block', args: { nodeId: change.nodeId, config: change.previousConfig } }
        : null;
    default:
      return null;
  }
}

/**
 * Everything the editor needs to draw one drag, from the tree and the pointer.
 *
 * Pure, so the interaction is testable without a DOM: given a stack, a node and
 * a point, this says exactly which command the drop would invoke, or why it
 * would not invoke one.
 *
 * @returns `{ slot, from, command, refusal }`. `command` is null when the drop
 *   changes nothing or is not allowed; `refusal` says which, in words a person
 *   can read.
 */
export function dragTo(stack, blocks, nodeId, point) {
  const geometry = editorGeometry(stack.root, blocks);
  const from = slotOfNode(geometry, nodeId);
  const slot = slotAt(geometry, point, nodeId);

  if (!slot) return { slot: null, from, command: null, refusal: 'Nothing here to drop into.' };
  // A container cannot go inside itself, at any depth. `stack/edit.ts` refuses
  // this too — it is checked here as well so the drag can REFUSE VISIBLY rather
  // than travel to a command and come back as an error the pointer has left
  // behind.
  if (isAncestor(geometry, nodeId, slot.container)) {
    return { slot, from, command: null, refusal: 'A container cannot be moved inside itself.' };
  }
  if (isNoop(from, slot)) return { slot, from, command: null, refusal: null };
  return {
    slot,
    from,
    command: { name: 'stack:move-block', args: { nodeId, to: slot } },
    refusal: null,
  };
}

/** Is `nodeId` the container `candidate`, or an ancestor of it? */
export function isAncestor(geometry, nodeId, candidate) {
  if (nodeId === candidate) return true;
  const node = geometry.boxes[nodeId]?.node;
  if (!node || node.kind === 'block') return false;
  for (const child of node.children) {
    if (isAncestor(geometry, child.id, candidate)) return true;
  }
  return false;
}
