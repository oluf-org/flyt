/**
 * What a block IS, once a plugin has contributed one.
 *
 * The parser turns `use: flyt-blocks-core:work` into a string (t-0056) and
 * stops there on purpose — a stack may name a block that is not installed, and
 * saying so is the library's job rather than the parser's. This is the other
 * half: the thing that string resolves to.
 *
 * Three consumers, one definition, which is the reason it is one type and not
 * three. The scheduler needs `execute`. The editor needs `settings` to render a
 * form (D61). The library needs `title`, `description` and `category` to
 * describe the block without anybody writing a second description that goes
 * stale.
 *
 * **`ctx.blocks` is a Flyt service, not a capability seam.** `SEAM_NAMES` is the
 * explicit capability contract and a test asserts it holds exactly those
 * eight; a block is Flyt's own noun and adding it to that list would claim
 * compatibility we never promised.
 *
 * @module #kernel/blocks/types
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FailureMetadata, JsonValue } from '../types.js';

/**
 * Which shelf of the library a block sits on.
 *
 * A closed set, because a facet whose values are free text is a facet that
 * narrows nothing (t-0076).
 */
export const BLOCK_CATEGORIES = ['work', 'judgement', 'inquiry', 'loop', 'utility'] as const;

/** One of the categories. */
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

/**
 * The closed set of shapes a declared structured output may hold.
 *
 * `list` is what lets a `For each` roster tell a list from a sentence: a block
 * that declares `type: 'list'` is promising an array, and a predicate or roster
 * that names it knows it is iterating, not splitting prose on newlines (D56).
 */
export const BLOCK_OUTPUT_TYPES = ['string', 'number', 'boolean', 'list'] as const;

/** One of the declared structured-output shapes. */
export type BlockOutputType = (typeof BLOCK_OUTPUT_TYPES)[number];

/** One declared structured output: a field name plus the shape it holds. */
export interface BlockOutput {
  /** The field a predicate or a roster names. */
  name: string;
  /** What that field holds, so a consumer can tell a list from a sentence. */
  type: BlockOutputType;
}

/** The id a stack names in `use`: `plugin:block`, or a bare name for a built-in. */
export const USE_PATTERN = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/;

/** Workflow requests consume explicit input and only this execution's transcript. */
export interface BlockContext {
  mode: 'block-input';
  /** Exclusive cursor in the canonical session; retained when resuming. */
  after: number;
  /** Stable identity of this block invocation, including enclosing iterations. */
  executionId?: string;
}

/** Everything one execution of a block is given. */
export interface BlockRun {
  /**
   * The caller's context. Seams resolve through it — which is what makes
   * worktree isolation a provider of `ctx.fs` rather than a special case
   * threaded through the runner.
   */
  ctx: Context;
  runId: string;
  /** The block's id within the stack, unique across it. */
  blockId: string;
  /** The block's settings, as the stack configured them. Validated against `settings`. */
  config: Record<string, JsonValue>;
  /** What entered this block: the previous block's output, or the run's input. */
  input: string;
  /** Scheduler-owned context boundary, independent of block configuration. */
  context?: BlockContext;
  /**
   * The tools this execution may reach.
   *
   * Already narrowed: a block's declared ceiling intersected with the run's.
   * Children narrow and never widen (D57), so this is the whole authority the
   * block has and there is nowhere to appeal it.
   */
  ceiling: readonly string[];
  /** Cancellation. A block that ignores it stops at its next durable boundary anyway. */
  signal?: AbortSignal;
}

/** What one execution of a block produced. */
export interface BlockOutcome {
  status: 'done' | 'failed';
  /** The model-visible deliverable. Projected to `runs/<id>/blocks/<blockId>.md`. */
  output: string;
  /**
   * Fields the block DECLARED it would produce.
   *
   * Phase 3's `If` predicates may only name a field that appears here (D56),
   * which is why this is part of the contract now rather than added when the
   * predicates arrive: a conditional that can read anything is an expression
   * language, and this is not one.
   */
  structured?: JsonValue;
  /** Why it failed. Present exactly when `status` is `failed`. */
  error?: string;
  /** Machine-readable cause and replay-safety facts. */
  failure?: FailureMetadata;
}

/** A block, as a plugin contributes it. */
export interface BlockDefinition {
  /** The id a stack's `use` names. Unique across every installed plugin. */
  use: string;
  title: string;
  description: string;
  category: BlockCategory;
  /** JSON Schema for `config`. The editor renders a form from it; the block never parses one. */
  settings: JsonValue;
  /**
   * The most this block may ever reach, named by the block itself.
   *
   * `null` means it declares none and inherits the run's, which is not the same
   * as "everything": the run's ceiling is still a ceiling. Naming one here is a
   * LIMIT, never a grant — a tool arrives ungranted and stays that way until a
   * ceiling names it AND somebody grants it (D57).
   */
  ceiling: readonly string[] | null;
  /**
   * The structured fields this block declares it may put in
   * `BlockOutcome.structured`, each a name plus one type from the closed set.
   *
   * Absent means the block offers no field a predicate or a roster can name;
   * that is legal, and simply leaves Phase 3's lint rules nothing to read here.
   */
  outputs?: readonly BlockOutput[];
  /** Run it. The registry never calls this; the scheduler does. */
  execute(run: BlockRun): Promise<BlockOutcome>;
}

/** The registry, as a consumer sees it. */
export interface BlocksService {
  /** Contribute a block. The disposer is owned by the calling plugin's fiber. */
  register(block: BlockDefinition): () => void;
  /** One block by the id a stack names it with, or undefined. */
  resolve(use: string): BlockDefinition | undefined;
  /**
   * One block, or a refusal that names what is installed.
   *
   * The standing rule is that missing must be explicit. A stack that reaches
   * for a block nobody installed has to fail saying which block, in which
   * stack, and what there is instead — not with `undefined is not a function`
   * three frames later.
   */
  require(use: string, where?: string): BlockDefinition;
  /** Every installed block. What the library lists. */
  list(): BlockDefinition[];
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    blocks: BlocksService;
  }
}
