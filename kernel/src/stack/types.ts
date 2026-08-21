/**
 * The stack tree: what a stack is, once containment has been resolved.
 *
 * A stack is composed and run; a block is one step in it (D52). Containment
 * replaces edges, so this tree IS the graph — there is no edge list beside it
 * and no layout file under it, and therefore no arrangement that draws but
 * does not parse (D59).
 *
 * Two containers exist, and that is deliberate. `Repeat N`, `For each`,
 * `Until` and `If` are Phase 3 (t-0038): the containment model has to be right
 * before it holds four more types, and a container type is far cheaper to add
 * to a model that works than to remove from one that does not.
 *
 * @module #kernel/stack/types
 */
import type { JsonValue } from '../types.js';

/** Where a node came from in the file, so a refusal can point at it. */
export interface Position {
  /** 1-based line in the source. 0 when the node was built rather than parsed. */
  line: number;
  /** Dotted path from the root, e.g. `blocks[1].lanes[0]`. */
  path: string;
}

/** One step. A plugin contributes what `use` names; the stack only references it. */
export interface BlockNode {
  kind: 'block';
  id: string;
  /** The block type a plugin contributed. Unresolved here — a stack may name a block that is not installed, and saying so is the library's job, not the parser's. */
  use: string;
  title: string | null;
  /** Whatever the block's own settings schema accepts. The parser does not interpret it. */
  config: Record<string, JsonValue>;
  position: Position;
}

/** Children, top to bottom. The implicit container: a stack's root is one. */
export interface SequenceNode {
  kind: 'sequence';
  id: string;
  children: StackNode[];
  position: Position;
}

/**
 * Lanes, side by side.
 *
 * `maxParallel` bounds how many run at once; null means all of them. Lanes are
 * isolated until aggregation (D37), which is a runner property — the parser's
 * job is only to make the boundary between them structural rather than a
 * convention someone has to remember.
 */
export interface ParallelNode {
  kind: 'parallel';
  id: string;
  maxParallel: number | null;
  children: StackNode[];
  position: Position;
}

/** Any node in the tree. */
export type StackNode = BlockNode | SequenceNode | ParallelNode;

/** The container kinds this phase implements. */
export const CONTAINER_KINDS = ['sequence', 'parallel'] as const;

/** One of the containers. */
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * The containers Phase 3 brings, and the task that brings them.
 *
 * Named here so a stack that reaches for one is refused with the phase rather
 * than with "unknown kind" — somebody hand-writing a stack should learn the
 * boundary from the error, not from the plan document.
 */
export const PLANNED_KINDS: Record<string, string> = {
  repeat: 'Repeat N',
  foreach: 'For each',
  'for-each': 'For each',
  until: 'Until',
  if: 'If',
};

/** A parsed stack. */
export interface Stack {
  /** Always 2. Version 1 is a flow, read through the migration path, never here. */
  version: 2;
  id: string;
  name: string;
  description: string;
  /** The implicit root sequence. A stack is a sequence, whatever else it holds. */
  root: SequenceNode;
}

/**
 * How deep containers may nest, root included.
 *
 * The root sequence is depth 1, so a parallel of sequences of parallels sits
 * at 3 and there is room to spare for a hand-authored stack. A bound is not
 * about what is reasonable to write — it is about what is reasonable to run:
 * worst-case expansion is reported before a run starts, and it cannot be
 * reported for a tree that has no ceiling.
 */
export const MAX_DEPTH = 6;

/** A block id: something a person can type, and a path can carry. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Is this node a container? */
export function isContainer(node: StackNode): node is SequenceNode | ParallelNode {
  return node.kind === 'sequence' || node.kind === 'parallel';
}

/** Every node in the tree, parents before children. */
export function* walk(node: StackNode): Generator<StackNode> {
  yield node;
  if (isContainer(node)) for (const child of node.children) yield* walk(child);
}
