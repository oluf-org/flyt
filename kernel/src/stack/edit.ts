/**
 * Editing a stack, which means editing the tree.
 *
 * There is no second representation to keep in step — no edge list, no stored
 * layout (D59) — so a block moves by moving in the tree and nowhere else. That
 * is what lets one set of operations serve a person dragging and a model
 * calling a command (D63): the drag has nothing extra to say.
 *
 * Every edit returns a NEW tree and a record of what changed. The record is
 * what the editor animates from, so an edit a model made animates the way a
 * dragged one does, because it is the same record. Diffing two trees would
 * work too and would have to guess which node the move was about.
 *
 * Pure and free of the renderer: an edit that needed the DOM could not be made
 * by an agent.
 *
 * @module #kernel/stack/edit
 */
import type { JsonValue } from '../types.js';
import {
  isContainer, walk,
  type BlockNode, type ForEachNode, type IfNode, type ParallelNode, type RepeatNode, type SequenceNode, type StackNode, type UntilNode,
} from './types.js';

/** One of the nodes that can hold children. */
export type ContainerNode = SequenceNode | ParallelNode | RepeatNode | IfNode | ForEachNode | UntilNode;

/** Where a node sits, or is going: a container and an index among its children. */
export interface Slot {
  /** The container's id. Containment addresses positions; there are no coordinates in an edit. */
  container: string;
  /** 0 to the container's child count — the last one being "after everything". */
  index: number;
  /** `else` addresses an If's alternate branch; omitted means its ordinary children/body. */
  branch?: 'else';
}

/** What one edit did, for an editor to animate and a log to record. */
export interface EditRecord {
  kind: 'insert' | 'move' | 'remove' | 'unwrap' | 'wrap' | 'configure';
  nodeId: string;
  /** Where it was. Null for an insert. */
  from: Slot | null;
  /** Where it is now. Null for a remove. */
  to: Slot | null;
}

/** The new tree, and what changed to get there. */
export interface EditResult {
  root: SequenceNode;
  change: EditRecord;
}

/** An edit that would have produced a stack that cannot run. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/** Find a node anywhere in the tree. */
function find(root: StackNode, id: string): StackNode | null {
  for (const node of walk(root)) if (node.id === id) return node;
  return null;
}

/** Where a node currently sits, or null for the root, which sits nowhere. */
function slotOf(root: StackNode, id: string): Slot | null {
  for (const node of walk(root)) {
    if (!isContainer(node)) continue;
    const index = node.children.findIndex(c => c.id === id);
    if (index >= 0) return { container: node.id, index };
    if (node.kind === 'if' && node.else) {
      const other = node.else.findIndex(c => c.id === id);
      if (other >= 0) return { container: node.id, index: other, branch: 'else' };
    }
  }
  return null;
}

function container(root: StackNode, id: string): ContainerNode {
  const node = find(root, id);
  if (!node) throw new EditError(`there is no "${id}" in this stack`);
  if (!isContainer(node)) {
    throw new EditError(`"${id}" is a block, and a block holds nothing; name a container`);
  }
  return node;
}

/**
 * Rebuild the tree with one container's children replaced.
 *
 * Structural sharing: only the containers on the path are new objects, so the
 * editor can tell what moved by identity if it wants to, and the tree handed
 * in is never touched. An edit that mutated its input would make undo a copy
 * the caller had to remember to take.
 */
function rewrite(node: StackNode, id: string, children: (kids: StackNode[]) => StackNode[]): StackNode {
  if (!isContainer(node)) return node;
  if (node.id === id) return { ...node, children: children(node.children) };
  const next = node.children.map(c => rewrite(c, id, children));
  const previousElse = node.kind === 'if' ? node.else : null;
  const other = previousElse ? previousElse.map(c => rewrite(c, id, children)) : null;
  const bodyChanged = next.some((c, i) => c !== node.children[i]);
  const elseChanged = Boolean(other?.some((c, i) => c !== previousElse![i]));
  return bodyChanged || elseChanged ? {
    ...node, children: next,
    ...(node.kind === 'if' ? { else: other } : {}),
  } : node;
}

/** Rebuild one addressed branch. An empty alternate branch is represented by absence, as the grammar requires. */
function rewriteSlot(node: StackNode, at: Slot, children: (kids: StackNode[]) => StackNode[]): StackNode {
  if (!isContainer(node)) return node;
  if (node.id === at.container) {
    if (at.branch === 'else') {
      if (node.kind !== 'if') throw new EditError(`"${node.id}" has no else branch`);
      const next = children(node.else ?? []);
      return { ...node, else: next.length ? next : null };
    }
    return { ...node, children: children(node.children) };
  }
  const next = node.children.map(child => rewriteSlot(child, at, children));
  const previousElse = node.kind === 'if' ? node.else : null;
  const other = previousElse ? previousElse.map(child => rewriteSlot(child, at, children)) : null;
  const bodyChanged = next.some((child, index) => child !== node.children[index]);
  const elseChanged = Boolean(other?.some((child, index) => child !== previousElse![index]));
  return bodyChanged || elseChanged ? {
    ...node, children: next,
    ...(node.kind === 'if' ? { else: other } : {}),
  } : node;
}

function childrenAt(node: ContainerNode, at: Slot): StackNode[] {
  if (at.branch !== 'else') return node.children;
  if (node.kind !== 'if') throw new EditError(`"${node.id}" has no else branch`);
  return node.else ?? [];
}

/** Is `id` inside `ofId`, or is it `ofId`? */
function within(root: StackNode, id: string, ofId: string): boolean {
  const outer = find(root, ofId);
  if (!outer) return false;
  for (const node of walk(outer)) if (node.id === id) return true;
  return false;
}

function checkIndex(at: Slot, count: number): void {
  if (!Number.isInteger(at.index) || at.index < 0 || at.index > count) {
    throw new EditError(
      `"${at.container}" has ${count} child${count === 1 ? '' : 'ren'}, so an index of ${at.index} names no position`);
  }
}

/**
 * Put a node into a container.
 *
 * @param root — the stack's root.
 * @param node — the node to insert, ids and all.
 * @param at — where it goes.
 * @returns the new tree and what changed.
 * @throws {EditError} when the position or the node would not survive a parse.
 */
export function insertNode(root: SequenceNode, node: StackNode, at: Slot): EditResult {
  for (const incoming of walk(node)) {
    if (find(root, incoming.id)) {
      throw new EditError(`the id "${incoming.id}" is already in this stack`);
    }
  }
  const target = container(root, at.container);
  const targetChildren = childrenAt(target, at);
  checkIndex(at, targetChildren.length);

  const next = rewriteSlot(root, at, kids => [
    ...kids.slice(0, at.index), node, ...kids.slice(at.index),
  ]) as SequenceNode;
  return { root: next, change: { kind: 'insert', nodeId: node.id, from: null, to: at } };
}

/**
 * Take a node out.
 *
 * @param root — the stack's root.
 * @param nodeId — what to remove; its children go with it.
 * @returns the new tree and what changed.
 * @throws {EditError} when the removal would leave a container that cannot run.
 */
export function removeNode(root: SequenceNode, nodeId: string): EditResult {
  const from = slotOf(root, nodeId);
  if (!from) {
    throw new EditError(find(root, nodeId)
      ? `"${nodeId}" is the stack itself, and a stack cannot be removed from inside`
      : `there is no "${nodeId}" in this stack`);
  }
  const parent = container(root, from.container);
  const siblings = childrenAt(parent, from);
  if (from.branch !== 'else' && siblings.length === 1) {
    // The parser refuses an empty container because a container with nothing in
    // it cannot run. An edit may not produce what the parser would reject —
    // that is the whole promise of deriving the graph from containment.
    throw new EditError(
      `"${nodeId}" is the only thing in "${from.container}", and a container with nothing in it cannot run;`
      + ' remove the container instead');
  }

  const next = rewriteSlot(root, from, kids => kids.filter(c => c.id !== nodeId)) as SequenceNode;
  return { root: next, change: { kind: 'remove', nodeId, from, to: null } };
}

/** Remove a container while keeping its authored children at the same position. */
export function unwrapContainer(root: SequenceNode, nodeId: string): EditResult {
  const node = find(root, nodeId);
  if (!node) throw new EditError(`there is no "${nodeId}" in this stack`);
  if (!isContainer(node)) throw new EditError(`"${nodeId}" is a block, not a container to unwrap`);
  const from = slotOf(root, nodeId);
  if (!from) throw new EditError('the root sequence is the workflow itself and cannot be unwrapped');
  const kept = [...node.children, ...(node.kind === 'if' && node.else ? node.else : [])];
  const next = rewriteSlot(root, from, kids => [
    ...kids.slice(0, from.index), ...kept, ...kids.slice(from.index + 1),
  ]) as SequenceNode;
  return { root: next, change: { kind: 'unwrap', nodeId, from, to: from } };
}

/** Wrap one existing node in a newly-authored container. */
export function wrapNode(root: SequenceNode, nodeId: string, wrapper: ContainerNode): EditResult {
  if (find(root, wrapper.id)) throw new EditError(`the id "${wrapper.id}" is already in this stack`);
  const from = slotOf(root, nodeId);
  if (!from) throw new EditError(find(root, nodeId)
    ? 'the root sequence is already the workflow container'
    : `there is no "${nodeId}" in this stack`);
  const node = find(root, nodeId)!;
  const wrapped = {
    ...wrapper,
    children: [node],
    ...(wrapper.kind === 'if' ? { else: wrapper.else ?? null } : {}),
  } as ContainerNode;
  const next = rewriteSlot(root, from, kids => [
    ...kids.slice(0, from.index), wrapped, ...kids.slice(from.index + 1),
  ]) as SequenceNode;
  return { root: next, change: { kind: 'wrap', nodeId: wrapper.id, from, to: from } };
}

/**
 * Move a node to another position.
 *
 * `to.index` is read against the tree as it is NOW, which is what a drag means:
 * the gap you dropped into was a gap in what you were looking at. Moving down
 * within one container therefore shifts by one once the node is lifted out, and
 * that adjustment happens here rather than in every caller.
 *
 * @param root — the stack's root.
 * @param nodeId — what to move.
 * @param to — where it goes.
 * @returns the new tree and what changed.
 * @throws {EditError} when the move would make containment lie or empty a container.
 */
export function moveNode(root: SequenceNode, nodeId: string, to: Slot): EditResult {
  const from = slotOf(root, nodeId);
  if (!from) {
    throw new EditError(find(root, nodeId)
      ? `"${nodeId}" is the stack itself, and there is nowhere above it to move to`
      : `there is no "${nodeId}" in this stack`);
  }
  // The one way containment can be made to lie: a container inside itself is a
  // cycle, and a tree with a cycle has no order to run in.
  if (within(root, to.container, nodeId)) {
    throw new EditError(to.container === nodeId
      ? `"${nodeId}" cannot be moved inside itself`
      : `"${to.container}" is inside "${nodeId}", so moving it there would put "${nodeId}" inside itself`);
  }
  const target = container(root, to.container);
  checkIndex(to, childrenAt(target, to).length);

  const sameBranch = from.container === to.container && from.branch === to.branch;
  if (sameBranch && (to.index === from.index || to.index === from.index + 1)) {
    // Dropped where it already was. Not an error — a drag that ends where it
    // started is a normal thing to do — and not a change either.
    return { root, change: { kind: 'move', nodeId, from, to: from } };
  }
  if (!sameBranch) {
    const parent = container(root, from.container);
    if (from.branch !== 'else' && childrenAt(parent, from).length === 1) {
      throw new EditError(
        `"${nodeId}" is the only thing in "${from.container}", and moving it out would leave a container`
        + ' that cannot run; move the container instead');
    }
  }

  const node = find(root, nodeId)!;
  const lifted = rewriteSlot(root, from, kids => kids.filter(c => c.id !== nodeId));
  // Same container and moving down: the gap the caller named lost a place when
  // the node was lifted out of the row above it.
  const index = sameBranch && to.index > from.index ? to.index - 1 : to.index;
  const next = rewriteSlot(lifted, to, kids => [
    ...kids.slice(0, index), node, ...kids.slice(index),
  ]) as SequenceNode;
  return { root: next, change: { kind: 'move', nodeId, from, to } };
}

/**
 * Replace a block's settings.
 *
 * The config is carried, not interpreted — what a block's settings mean is the
 * block's business, and an editor that validated them would have to be taught
 * every plugin ever installed. The block's own settings schema is what the form
 * is rendered from (D61), and that is where a value is judged.
 *
 * @param root — the stack's root.
 * @param nodeId — the block to configure.
 * @param config — the new settings, whole.
 * @returns the new tree and what changed.
 * @throws {EditError} when the node is not a block.
 */
export function configureBlock(
  root: SequenceNode, nodeId: string, config: Record<string, JsonValue>,
): EditResult {
  const node = find(root, nodeId);
  if (!node) throw new EditError(`there is no "${nodeId}" in this stack`);
  if (isContainer(node)) {
    throw new EditError(`"${nodeId}" is a ${node.kind}, and a container has no block settings`);
  }
  const from = slotOf(root, nodeId);
  const configured: BlockNode = { ...node, config: { ...config } };
  const next = rewriteSlot(root, from!, kids =>
    kids.map(c => (c.id === nodeId ? configured : c))) as SequenceNode;
  return { root: next, change: { kind: 'configure', nodeId, from, to: from } };
}

/** Replace the authored settings owned by a container kind. */
export function configureContainer(
  root: SequenceNode, nodeId: string, config: Record<string, JsonValue>,
): EditResult {
  const node = find(root, nodeId);
  if (!node) throw new EditError(`there is no "${nodeId}" in this stack`);
  if (!isContainer(node)) throw new EditError(`"${nodeId}" is a block, not a container`);
  if (node.kind === 'sequence' && node.id === root.id) {
    throw new EditError('the root sequence has no configurable runtime settings');
  }
  let configured: ContainerNode = { ...node };
  if (node.kind === 'parallel') configured = { ...node, maxParallel: (config.maxParallel ?? null) as number | null };
  if (node.kind === 'repeat') configured = { ...node, count: Number(config.count) };
  if (node.kind === 'foreach') configured = { ...node, roster: String(config.roster ?? ''), max: Number(config.max) };
  if (node.kind === 'until') configured = { ...node, condition: config.condition as unknown as UntilNode['condition'], max: Number(config.max) };
  if (node.kind === 'if') configured = { ...node, predicate: config.predicate as unknown as IfNode['predicate'] };
  const from = slotOf(root, nodeId)!;
  const next = rewriteSlot(root, from, kids =>
    kids.map(child => child.id === nodeId ? configured : child)) as SequenceNode;
  return { root: next, change: { kind: 'configure', nodeId, from, to: from } };
}
