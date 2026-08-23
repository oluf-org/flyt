/**
 * The stack tree: what a stack is, once containment has been resolved.
 *
 * A stack is composed and run; a block is one step in it (D52). Containment
 * replaces edges, so this tree IS the graph — there is no edge list beside it
 * and no layout file under it, and therefore no arrangement that draws but
 * does not parse (D59).
 *
 * Three containers exist. `Repeat N` is built (the first of the Phase 3
 * control-flow containers); `For each`, `Until` and `If` are still Phase 3
 * (t-0038). The containment model had to be right before it held the rest, and
 * a container type is far cheaper to add to a model that works than to remove
 * from one that does not.
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

/**
 * A body, run `count` times, each iteration fed what the one before produced.
 *
 * The count is a literal, authored, capped integer — never an expression. The
 * body is one list of blocks (the same shape a sequence holds), so a repeat
 * contributes `count` times its body's worst-case expansion, while its
 * authored block count is just the body, counted once.
 */
export interface RepeatNode {
  kind: 'repeat';
  id: string;
  /** How many times the body runs. Whole, positive, and at most {@link MAX_REPEAT}. */
  count: number;
  children: StackNode[];
  position: Position;
}

/** Any node in the tree. */
export type StackNode = BlockNode | SequenceNode | ParallelNode | RepeatNode;

/** The container kinds this phase implements. */
export const CONTAINER_KINDS = ['sequence', 'parallel', 'repeat'] as const;

/** One of the containers. */
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * The containers Phase 3 still brings, and the task that brings them.
 *
 * Named here so a stack that reaches for one is refused with the phase rather
 * than with "unknown kind" — somebody hand-writing a stack should learn the
 * boundary from the error, not from the plan document.
 */
export const PLANNED_KINDS: Record<string, string> = {
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

/**
 * The most times one `Repeat N` may run its body.
 *
 * Every later container adds its own multiplier to worst-case expansion, so
 * the repeat bound is the first rung of the ladder, not the whole ladder.
 */
export const MAX_REPEAT = 64;

/**
 * The most blocks one stack may expand to, in the worst case, over the whole
 * tree. A stack that exceeds it is refused before anything runs, with the cap
 * and its own worst case both in the message.
 */
export const MAX_EXPANSION = 512;

/** A block id: something a person can type, and a path can carry. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Is this node a container? */
export function isContainer(node: StackNode): node is SequenceNode | ParallelNode | RepeatNode {
  return node.kind === 'sequence' || node.kind === 'parallel' || node.kind === 'repeat';
}

/** Every node in the tree, parents before children. */
export function* walk(node: StackNode): Generator<StackNode> {
  yield node;
  if (isContainer(node)) for (const child of node.children) yield* walk(child);
}

/**
 * The two numbers a run must know before it spends anything.
 *
 * `blocks` is the total number of authored block nodes in the tree, counted
 * once each. `expansion` is how many block executions the tree can produce in
 * the worst case: every lane runs, and a repeat multiplies its body by
 * `count`. Containers that add a multiplier later extend this same fold, which
 * is why the bound lives with the first one.
 */
export interface StackBounds {
  /** Distinct block nodes in the authored tree. */
  blocks: number;
  /** Worst-case block executions over the whole tree. */
  expansion: number;
}

/** Compute {@link StackBounds} over a whole subtree. */
export function boundStack(node: StackNode): StackBounds {
  if (node.kind === 'block') return { blocks: 1, expansion: 1 };
  const kids = node.children.map(boundStack);
  const blocks = kids.reduce((n, k) => n + k.blocks, 0);
  const expansion = kids.reduce((n, k) => n + k.expansion, 0);
  if (node.kind === 'repeat') return { blocks, expansion: expansion * node.count };
  return { blocks, expansion };
}
