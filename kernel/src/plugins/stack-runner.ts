/**
 * `flyt-stack-runner` — `ctx.agents`, the scheduler over containment.
 *
 * A sequence walks its children top to bottom. A parallel runs its lanes
 * together under `maxParallel`. Neither fact is decided here: the tree already
 * says it, and the scheduler's job is to honour the structure rather than to
 * reimplement it in a second place where the two can disagree.
 *
 * Lane isolation (D37) is the clearest case. The containment says a parallel's
 * lanes are siblings; the scheduler gives each lane the input the PARALLEL
 * received rather than whatever a sibling last produced, so a lane cannot see
 * another lane's work. That is one line, and it is one line because the tree
 * did the work.
 *
 * What executes a block, in what workspace, under which ceiling, is resolved
 * through the other seams. The scheduler does not know — which is what makes
 * worktree isolation a provider of `ctx.fs` rather than a special case threaded
 * through here.
 *
 * @module #kernel/plugins/stack-runner
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { JsonValue, Message } from '../types.js';
import type { AgentRun, AgentsSeam, RunOutcome, StackRef } from '../seams/agents.js';
import type { SessionHandle } from '../seams/sessions.js';
import type { BlockNode, ParallelNode, SequenceNode, StackNode } from '../stack/types.js';
import type { BlockDefinition, BlockOutcome } from '../blocks/types.js';
import { missingBlocks } from './blocks.js';

/** Cordis plugin name. */
export const name = 'flyt-stack-runner';

/** It walks blocks, and blocks come from the registry. */
export const inject = ['blocks', 'sessions'];

/** How a caller hands the runner a stack to walk. */
export interface StackSource {
  /** The resolved tree for this stack id, or null when there is none. */
  resolve(stackId: string): SequenceNode | null;
}

/** How the runner is configured. */
export interface StackRunnerConfig {
  /** Where the trees come from. Without one, `start` refuses rather than guessing. */
  stacks?: StackSource;
  /** The run-wide ceiling. A block narrows it and never widens it (D57). */
  ceiling?: readonly string[];
}

/** What a block was given and what it returned, as the walk records it. */
interface BlockStep {
  node: BlockNode;
  outcome: BlockOutcome;
}

/**
 * One run in flight.
 *
 * `stop()` sets a flag the walk reads at its boundaries; it never cancels
 * anything mid-write. An in-flight block is allowed to finish — a call
 * abandoned mid-flight is a provider billing for work no record survives,
 * which the aborted-spend work already found from the other direction.
 */
class Run implements AgentRun {
  readonly runId: string;
  private settledPromise: Promise<RunOutcome>;
  private stopRequest: string | null = null;

  constructor(runId: string, walk: (run: Run) => Promise<RunOutcome>) {
    this.runId = runId;
    this.settledPromise = walk(this);
  }

  /**
   * The last block that finished.
   *
   * Written as the walk goes so a stop can say WHERE it landed. A run that
   * stopped and cannot say where is a run nobody can resume, and "it stopped"
   * on its own is the least useful true sentence a log can contain.
   */
  lastBlockId: string | null = null;

  /** Has somebody asked this run to stop, and why? */
  get stopReason(): string | null { return this.stopRequest; }

  settled(): Promise<RunOutcome> { return this.settledPromise; }

  async stop(reason: string): Promise<void> {
    // Idempotent, and harmless after the fact: a caller that crashed halfway
    // through a shutdown has to be able to finish it, and a run that already
    // settled has nothing to stop.
    this.stopRequest ??= reason || 'stopped';
  }
}

/** The scheduler. Provider of `ctx.agents`. */
export class StackRunner extends Service implements AgentsSeam {
  private runs = new Map<string, Run>();
  private stacks: StackSource | null;
  private ceiling: readonly string[];

  constructor(ctx: Context, config: StackRunnerConfig = {}) {
    super(ctx, 'agents');
    this.stacks = config.stacks ?? null;
    this.ceiling = config.ceiling ?? [];
  }

  /**
   * Start a stack.
   *
   * Returns as soon as the run is durable — the log exists and the first event
   * is in it — rather than when the walk finishes. That is what lets Work
   * render a run that is still going, and what makes `settled()` the thing you
   * await rather than the thing you got.
   */
  async start(stack: StackRef, input: string): Promise<AgentRun> {
    const root = this.stacks?.resolve(stack.id) ?? null;
    if (!root) {
      throw new Error(this.stacks
        ? `There is no stack "${stack.id}".`
        : 'This runner was given no stack source, so it cannot resolve any stack.');
    }

    // Before anything is spent: a stack naming a block nobody installed fails
    // at block 1, not at block 9 after paying for the first eight.
    const missing = missingBlocks(this.ctx.blocks, root);
    if (missing.length) {
      throw new Error(`Stack "${stack.id}" names ${missing.length} block type(s) nothing contributes: `
        + missing.map(m => `${m.id} (${m.use})`).join(', '));
    }

    const session = await this.ctx.sessions.open(stack.runId);
    await session.append({ type: 'run.created', data: { runId: stack.runId, stackId: stack.id, input } });

    const run = new Run(stack.runId, r => this.walkRun(r, root, input, session));
    this.runs.set(stack.runId, run);
    return run;
  }

  /** Resume an interrupted run from its log. Implemented in t-0068. */
  async resume(runId: string): Promise<AgentRun> {
    const live = this.runs.get(runId);
    if (live) return live;
    throw new Error(`Resuming run "${runId}" from its log is not built yet (t-0068).`);
  }

  /** A run still in flight in this process, if any. */
  get(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }

  // Ordinary private methods below, never `#private` ones. Cordis derives a
  // per-caller view of a Service with `Object.create(this)`, and a `#private`
  // member is unreachable through a derived object: the symptom is "Receiver
  // must be an instance of class StackRunner" thrown from the first call any
  // consumer makes, which is exactly how this was found.

  /** The whole run: the root sequence, then the outcome. */
  private async walkRun(run: Run, root: SequenceNode, input: string, session: SessionHandle): Promise<RunOutcome> {
    await session.append({ type: 'run.stage', data: { stage: 'execution' } });
    try {
      const walked = await this.walk(run, root, input, session);
      if (run.stopReason) {
        await session.append({
          type: 'run.stage',
          data: {
            stage: 'stopped', reason: run.stopReason,
            // Where it landed. A stop that cannot say where is a stop nobody
            // can resume from.
            afterBlock: run.lastBlockId, blocksRan: walked.length
          }
        });
        return { status: 'stopped', reason: run.stopReason };
      }
      const failed = walked.find(s => s.outcome.status === 'failed');
      if (failed) {
        const error = `Block "${failed.node.id}" failed: ${failed.outcome.error ?? 'no reason given'}`;
        await session.append({ type: 'run.error', data: { error, blockId: failed.node.id } });
        await session.append({ type: 'run.stage', data: { stage: 'failed' } });
        return { status: 'failed', error };
      }
      await session.append({ type: 'run.stage', data: { stage: 'done' } });
      return { status: 'done', messages: await session.deriveMessages() as Message[] };
    } catch (err) {
      const error = String((err as Error)?.message ?? err);
      await session.append({ type: 'run.error', data: { error } });
      await session.append({ type: 'run.stage', data: { stage: 'failed' } });
      return { status: 'failed', error };
    }
  }

  /**
   * Walk one node, with what entered it.
   *
   * @returns every block step this subtree ran, in completion order.
   */
  private async walk(run: Run, node: StackNode, input: string, session: SessionHandle): Promise<BlockStep[]> {
    if (node.kind === 'block') {
      const step = await this.runBlock(run, node, input, session);
      return [step];
    }
    if (node.kind === 'parallel') return this.runParallel(run, node, input, session);
    return this.runSequence(run, node, input, session);
  }

  /** Children, top to bottom, each fed what the one before produced. */
  private async runSequence(run: Run, node: SequenceNode, input: string, session: SessionHandle): Promise<BlockStep[]> {
    const steps: BlockStep[] = [];
    let carried = input;
    for (const child of node.children) {
      // The durable boundary. A stop lands BETWEEN children, after the event
      // that recorded the last one, and never inside a block.
      if (run.stopReason) break;
      const ran = await this.walk(run, child, carried, session);
      steps.push(...ran);
      const last = ran.at(-1);
      if (last?.outcome.status === 'failed') break;
      if (last) carried = last.outcome.output;
    }
    return steps;
  }

  /**
   * Lanes, together, under the bound.
   *
   * Every lane receives what entered the PARALLEL. That single choice is lane
   * isolation (D37): a lane cannot see what a sibling produced because it was
   * never handed it, and there is no shared carry for one to leak through.
   */
  private async runParallel(run: Run, node: ParallelNode, input: string, session: SessionHandle): Promise<BlockStep[]> {
    const lanes = node.children;
    const bound = Math.max(1, node.maxParallel ?? lanes.length);
    const steps: BlockStep[] = [];
    for (let i = 0; i < lanes.length; i += bound) {
      if (run.stopReason) break;
      const wave = lanes.slice(i, i + bound);
      const ran = await Promise.all(wave.map(lane => this.walk(run, lane, input, session)));
      for (const laneSteps of ran) steps.push(...laneSteps);
      if (steps.some(s => s.outcome.status === 'failed')) break;
    }
    return steps;
  }

  /** One block, through the registry and the other seams. */
  private async runBlock(run: Run, node: BlockNode, input: string, session: SessionHandle): Promise<BlockStep> {
    const definition: BlockDefinition = this.ctx.blocks.require(node.use, `block "${node.id}"`);
    // The block's own ceiling narrows the run's; it never widens it (D57).
    const ceiling = definition.ceiling
      ? definition.ceiling.filter(t => this.ceiling.includes(t))
      : this.ceiling;

    await session.append({ type: 'block.status', data: { blockId: node.id, status: 'active', use: node.use } });
    let outcome: BlockOutcome;
    try {
      outcome = await definition.execute({
        ctx: this.ctx,
        runId: run.runId,
        blockId: node.id,
        config: node.config,
        input,
        ceiling,
      });
    } catch (err) {
      // A throwing block is a failed block, not a crashed run: the walk still
      // has to close the log and say which block it was.
      outcome = { status: 'failed', output: '', error: String((err as Error)?.message ?? err) };
    }

    if (outcome.output) {
      await session.append({ type: 'block.output', data: { blockId: node.id, content: outcome.output } });
    }
    await session.append({
      type: 'block.status',
      data: {
        blockId: node.id, status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.structured !== undefined ? { structured: outcome.structured as JsonValue } : {}),
      },
    });
    run.lastBlockId = node.id;
    return { node, outcome };
  }
}

/**
 * Provide `ctx.agents`.
 *
 * @param ctx — the context to provide in.
 * @param config — where stacks come from, and the run-wide ceiling.
 */
export function apply(ctx: Context, config: StackRunnerConfig = {}): void {
  new StackRunner(ctx, config);
}
