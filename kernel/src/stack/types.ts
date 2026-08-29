/**
 * The stack tree: what a stack is, once containment has been resolved.
 *
 * A stack is composed and run; a block is one step in it (D52). Containment
 * replaces edges, so this tree IS the graph — there is no edge list beside it
 * and no layout file under it, and therefore no arrangement that draws but
 * does not parse (D59).
 *
 * Three containers exist. `Repeat N` is built (the first of the Phase 3
 * control-flow containers); `For each` and `Until` are still Phase 3
 * (t-0038), and `If` arrives here with a structured predicate that is not an
 * expression.
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
  /** Structured fields this instance promises for predicates and for-each rosters. */
  outputs: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'list' }>;
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

/**
 * A body, run once per element of a roster, in order.
 *
 * The roster is a typed LIST output an upstream block declared — `plan.tasks`,
 * where `plan` ran before this and `tasks` is one of its `type: list` fields.
 * There is no path by which a string becomes a roster: no split on newlines, no
 * fallback, no one-item convenience. That restriction is the container, not a
 * detail of it — an iteration over whatever the previous block happened to say
 * is the "roster from prose" D56 exists to forbid, and it is what a plan for
 * this phase proposed before typed outputs existed to make it unnecessary.
 *
 * `max` is the authored bound on how many elements the body runs for. The
 * roster is not known until the upstream block has run, so the authored bound
 * is the only ceiling a pre-run expansion report can multiply by.
 */
export interface UntilNode {
  kind: 'until';
  id: string;
  /**
   * What has to become true for the retrying to stop.
   *
   * The same structured predicate an `If` takes, deliberately: "a named gate"
   * in the plan means a condition somebody declared, and v2 has exactly one
   * vocabulary for that. Inventing a second gate concept beside it would leave
   * two things to keep in your head that mean the same thing. The source
   * normally names a block inside this body — the body's own verdict is what
   * decides whether to go round again.
   */
  condition: IfPredicate;
  /** The most passes the body gets. Whole, positive, at most {@link MAX_UNTIL}. */
  max: number;
  children: StackNode[];
  position: Position;
}

export interface ForEachNode {
  kind: 'foreach';
  id: string;
  /** `<block>.<field>` — the upstream block and its declared list field. */
  roster: string;
  /** The most elements the body runs for. Whole, positive, at most {@link MAX_FOR_EACH}. */
  max: number;
  children: StackNode[];
  position: Position;
}

/**
 * The closed set of operators an `If` predicate may use.
 *
 * A closed set is the fence that keeps this out of expression territory: no
 * concatenation, no arithmetic, no function calls. Each operator compares a
 * declared field against a literal (or emptiness), and nothing else.
 */
export const IF_OPERATORS = ['is', 'is not', '<', '<=', '>', '>=', 'is empty', 'is not empty'] as const;

/** One of the closed predicate operators. */
export type IfOperator = (typeof IF_OPERATORS)[number];

/**
 * One comparison: a declared field, an operator, and a literal.
 *
 * `source` is `<block>.<field>` — as authored, the field a genuinely upstream
 * block declared in its structured outputs. `literal` is absent exactly for
 * `is empty` / `is not empty`, where there is nothing to compare against.
 */
export interface IfPredicateTerm {
  source: string;
  operator: IfOperator;
  literal?: JsonValue;
}

/**
 * A predicate: a single comparison, or one flat all-of / any-of list of them.
 *
 * The flat list is the ONLY combination allowed. No nesting, no `not` of a
 * list, no arithmetic — anything shaped like an expression is refused before
 * it becomes a parallel grammar someone has to keep in their head.
 */
export type IfPredicate =
  | IfPredicateTerm
  | { allOf: IfPredicateTerm[] }
  | { anyOf: IfPredicateTerm[] };

/**
 * A body and an optional else, chosen by a structured predicate.
 *
 * The body runs when the predicate holds; the else (when present) when it does
 * not; when there is no else and the predicate does not hold, the if changes
 * nothing and its input passes through to whatever follows it.
 */
export interface IfNode {
  kind: 'if';
  id: string;
  predicate: IfPredicate;
  /** The body, run when the predicate holds. A list, exactly like a sequence holds. */
  children: StackNode[];
  /** The else branch, run when it does not; null means "pass through". */
  else: StackNode[] | null;
  position: Position;
}

/** Any node in the tree. */
export type StackNode = BlockNode | SequenceNode | ParallelNode | RepeatNode | IfNode | ForEachNode | UntilNode;

/** The container kinds this phase implements. */
export const CONTAINER_KINDS = ['sequence', 'parallel', 'repeat', 'if', 'foreach', 'until'] as const;

/** One of the containers. */
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * Containers that are named but not built.
 *
 * Empty, and kept: Phase 3 finished the four it held (`Repeat N`, `For each`,
 * `Until`, `If`), and the mechanism is what mattered — a kind we have not built
 * is refused by NAME with the phase that brings it, so somebody hand-writing a
 * stack learns the boundary from the error rather than from a plan document.
 * The next container to be planned before it is written goes here.
 */
export const PLANNED_KINDS: Record<string, string> = {};

/** A parsed stack. */
export interface Stack {
  /** Always 2. Version 1 is a flow, read through the migration path, never here. */
  version: 2;
  id: string;
  name: string;
  description: string;
  /** Only launchable workflows appear in the ordinary chat picker. */
  launchable: boolean;
  /** Named behavioural variants. Model/provider pinning is deliberately not a preset concern. */
  presets: Record<string, WorkflowPreset>;
  /** The implicit root sequence. A stack is a sequence, whatever else it holds. */
  root: SequenceNode;
}

export interface WorkflowPreset {
  name: string;
  description: string;
  /** Block id -> partial config merged over the authored block config for this run. */
  overrides: Record<string, Record<string, JsonValue>>;
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
 * The most roster elements one `For each` may run its body for.
 *
 * A rung beside {@link MAX_REPEAT} in the same ladder: a for-each inside a
 * for-each multiplies `max` twice, and {@link MAX_EXPANSION} is the whole-tree
 * gate that catches what the individual rungs do not.
 */
export const MAX_FOR_EACH = 64;

/**
 * The most passes one `Until` gives its body.
 *
 * Lower than the other rungs on purpose: a repeat's passes are work somebody
 * asked for, while an until's are attempts at work that keeps not being right,
 * and the cost of the last few is rarely worth what they buy.
 */
export const MAX_UNTIL = 16;

/**
 * The most blocks one stack may expand to, in the worst case, over the whole
 * tree. A stack that exceeds it is refused before anything runs, with the cap
 * and its own worst case both in the message.
 */
export const MAX_EXPANSION = 512;

/** A block id: something a person can type, and a path can carry. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Is this node a container? */
export function isContainer(node: StackNode): node is Exclude<StackNode, BlockNode> {
  return node.kind !== 'block';
}

/** Every node in the tree, parents before children. */
export function* walk(node: StackNode): Generator<StackNode> {
  yield node;
  if (isContainer(node)) {
    for (const child of node.children) yield* walk(child);
    if (node.kind === 'if' && node.else) {
      for (const child of node.else) yield* walk(child);
    }
  }
}

/**
 * The two numbers a run must know before it spends anything.
 *
 * `blocks` is the total number of authored block nodes in the tree, counted
 * once each. `expansion` is how many block executions the tree can produce in
 * the worst case: every lane runs, and a repeat multiplies its body by
 * `count`. An if runs one branch, so its worst case is the heavier of the two.
 */
export interface StackBounds {
  /** Distinct block nodes in the authored tree. */
  blocks: number;
  /** Worst-case block executions over the whole tree. */
  expansion: number;
}

const sum = (kids: StackBounds[]): StackBounds => ({
  blocks: kids.reduce((n, k) => n + k.blocks, 0),
  expansion: kids.reduce((n, k) => n + k.expansion, 0),
});

/** Compute {@link StackBounds} over a whole subtree. */
export function boundStack(node: StackNode): StackBounds {
  if (node.kind === 'block') return { blocks: 1, expansion: 1 };
  if (node.kind === 'if') {
    const body = sum(node.children.map(boundStack));
    const other = node.else ? sum(node.else.map(boundStack)) : { blocks: 0, expansion: 0 };
    return {
      blocks: body.blocks + other.blocks,
      expansion: Math.max(body.expansion, other.expansion),
    };
  }
  const kids = sum(node.children.map(boundStack));
  if (node.kind === 'repeat') return { blocks: kids.blocks, expansion: kids.expansion * node.count };
  // The authored bound, not the roster: the roster is not known until the block
  // above has run, and a bound that can only be computed after spending money
  // is not a bound.
  if (node.kind === 'foreach') return { blocks: kids.blocks, expansion: kids.expansion * node.max };
  if (node.kind === 'until') return { blocks: kids.blocks, expansion: kids.expansion * node.max };
  return kids;
}
