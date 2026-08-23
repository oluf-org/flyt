/**
 * `flyt-stack-runner` — `ctx.agents`, the scheduler over containment.
 *
 * A sequence walks its children top to bottom. A parallel runs its lanes
 * together under `maxParallel`. A repeat runs its body `count` times, each
 * iteration fed what the one before produced. None of that is decided here:
 * the tree already says it, and the scheduler's job is to honour the
 * structure rather than to reimplement it in a second place where the two can
 * disagree.
 *
 * Lane isolation (D37) is the clearest case. The containment says a parallel's
 * lanes are siblings; the scheduler gives each lane the input the PARALLEL
 * received rather than whatever a sibling last produced, so a lane cannot see
 * another lane's work. A repeat is the other clear case: it is a sequence of
 * `count` runs of the same body, and the carry is exactly the thread a
 * sequence already knows how to pass.
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
import {
  boundStack,
  type BlockNode, type ForEachNode, type IfNode, type IfOperator, type IfPredicate, type IfPredicateTerm,
  type ParallelNode, type RepeatNode, type SequenceNode, type StackNode,
} from '../stack/types.js';
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

    // The bounds that decide whether this tree may run at all are known now,
    // before any block executes. They go in the log so a run that went wrong
    // can still say what it was allowed to become (D55).
    const bounds = boundStack(root);
    await session.append({
      type: 'run.stage',
      data: { stage: 'execution', blockCount: bounds.blocks, worstCaseExpansion: bounds.expansion },
    });

    const run = new Run(stack.runId, r => this.walkRun(r, root, input, session));
    this.runs.set(stack.runId, run);
    return run;
  }

  /**
   * Resume an interrupted run from its log.
   *
   * A READ, not a reconstruction. v1 rebuilt state from status files and had to
   * be told what each of them meant; here the log is the record, so resuming is
   * a matter of reading what already happened and continuing (D55).
   *
   * A block that reached a terminal `block.status` is not run again — its
   * recorded output is the carry, exactly as it was the first time. A block
   * that went `active` and never settled IS run again, and its unreturned tool
   * call comes back through `deriveMessages()` as a synthetic never-returned
   * result rather than disappearing (D17). A dropped call is how a resumed
   * conversation silently changes shape, and the model then answers a question
   * nobody asked.
   */
  async resume(runId: string): Promise<AgentRun> {
    const live = this.runs.get(runId);
    if (live) return live;

    // `read` refuses a run with no log, naming it — which is the honest answer
    // to "resume something that never started".
    const past = await this.ctx.sessions.read(runId);
    const events = [];
    for await (const event of past.read()) events.push(event);

    const created = events.find(e => e.type === 'run.created');
    const stackId = String((created?.data as { stackId?: unknown })?.stackId ?? '');
    const input = String((created?.data as { input?: unknown })?.input ?? '');
    if (!stackId) throw new Error(`Run "${runId}" has a log with no stack in it, so there is nothing to resume.`);

    // FINISHED? Then resuming is reading, not running: a caller that asks twice
    // must not pay twice.
    //
    // `stopped` is deliberately not in this list. A stopped run is the thing
    // you resume — that is what stopping is for. Treating it as terminal made
    // `resume` hand back the stop it was asked to undo, which reads as success
    // and is the exact opposite of the feature.
    const stages = events.filter(e => e.type === 'run.stage')
      .map(e => String((e.data as { stage?: unknown })?.stage ?? ''));
    const last = stages.at(-1);
    if (last === 'done' || last === 'failed') {
      const settled: RunOutcome = last === 'done'
        ? { status: 'done', messages: await past.deriveMessages() as Message[] }
        : {
          status: 'failed',
          error: String((events.findLast(e => e.type === 'run.error')?.data as { error?: unknown })?.error
            ?? 'the run failed'),
        };
      return { runId, settled: async () => settled, stop: async () => {} };
    }

    const root = this.stacks?.resolve(stackId) ?? null;
    if (!root) throw new Error(`Run "${runId}" is a run of stack "${stackId}", which this runner cannot resolve.`);

    // What already finished, and what it produced. Both from the log.
    const done = new Map<string, BlockOutcome>();
    const outputs = new Map<string, string>();
    for (const event of events) {
      const data = event.data as { blockId?: unknown; status?: unknown; content?: unknown; error?: unknown };
      if (event.type === 'block.output' && typeof data.blockId === 'string') {
        outputs.set(data.blockId, String(data.content ?? ''));
      }
      if (event.type !== 'block.status' || typeof data.blockId !== 'string') continue;
      if (data.status === 'done' || data.status === 'failed') {
        done.set(data.blockId, {
          status: data.status,
          output: outputs.get(data.blockId) ?? '',
          ...(data.error ? { error: String(data.error) } : {}),
          // The structured fields go back too, or a resumed run reads every
          // predicate against nothing and quietly takes the other branch —
          // a resume that changes which work happens is worse than one that
          // repeats work. `block.status` records them for exactly this.
          ...((data as { structured?: unknown }).structured !== undefined
            ? { structured: (data as { structured?: JsonValue }).structured }
            : {}),
        });
      }
    }

    const session = await this.ctx.sessions.open(runId);
    await session.append({ type: 'run.stage', data: { stage: 'resumed', from: events.at(-1)?.seq ?? 0, replayed: done.size } });

    const run = new Run(runId, r => this.walkRun(r, root, input, session, done));
    this.runs.set(runId, run);
    return run;
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
  private async walkRun(
    run: Run, root: SequenceNode, input: string, session: SessionHandle,
    /** Blocks the log says already settled, from `resume`. Empty for a fresh run. */
    done: Map<string, BlockOutcome> = new Map(),
  ): Promise<RunOutcome> {
    try {
      const walked = await this.walk(run, root, input, session, done);
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
  private async walk(
    run: Run, node: StackNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>,
  ): Promise<BlockStep[]> {
    if (node.kind === 'block') return [await this.runBlock(run, node, input, session, done)];
    if (node.kind === 'parallel') return this.runParallel(run, node, input, session, done);
    if (node.kind === 'repeat') return this.runRepeat(run, node, input, session, done);
    if (node.kind === 'if') return this.runIf(run, node, input, session, done);
    if (node.kind === 'foreach') return this.runForEach(run, node, input, session, done);
    return this.runSequence(run, node, input, session, done);
  }

  /** Children, top to bottom, each fed what the one before produced. */
  private async runSequence(
    run: Run, node: SequenceNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>,
  ): Promise<BlockStep[]> {
    const steps: BlockStep[] = [];
    let carried = input;
    for (const child of node.children) {
      // The durable boundary. A stop lands BETWEEN children, after the event
      // that recorded the last one, and never inside a block.
      if (run.stopReason) break;
      const ran = await this.walk(run, child, carried, session, done);
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
  private async runParallel(
    run: Run, node: ParallelNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>,
  ): Promise<BlockStep[]> {
    const lanes = node.children;
    const bound = Math.max(1, node.maxParallel ?? lanes.length);
    const steps: BlockStep[] = [];
    for (let i = 0; i < lanes.length; i += bound) {
      if (run.stopReason) break;
      const wave = lanes.slice(i, i + bound);
      // Each lane gets its OWN view of what has settled. Every lane already
      // receives what entered the parallel rather than what a sibling produced
      // (D37); a shared map would have handed that isolation straight back,
      // because an `If` predicate in one lane could name a block in another and
      // read its structured output. A lane still sees everything that settled
      // before the parallel, which is genuinely upstream of it.
      const ran = await Promise.all(wave.map(lane => this.walk(run, lane, input, session, new Map(done))));
      for (const laneSteps of ran) steps.push(...laneSteps);
      if (steps.some(s => s.outcome.status === 'failed')) break;
    }
    return steps;
  }

  /**
   * A repeat runs its body exactly `count` times, each iteration fed what the
   * one before produced — the same carry a sequence threads — and a failing
   * body stops it the way a sequence stops.
   */
  private async runRepeat(
    run: Run, node: RepeatNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>,
  ): Promise<BlockStep[]> {
    const body: SequenceNode = { kind: 'sequence', id: node.id, children: node.children, position: node.position };
    const steps: BlockStep[] = [];
    let carried = input;
    for (let i = 0; i < node.count; i++) {
      if (run.stopReason) break;
      const walked = await this.runSequence(run, body, carried, session, done);
      steps.push(...walked);
      const last = walked.at(-1);
      if (last?.outcome.status === 'failed') break;
      if (last) carried = last.outcome.output;
    }
    return steps;
  }

  /**
   * An if runs exactly one branch, chosen by its structured predicate.
   *
   * A predicate reads only the structured outputs of blocks that have already
   * settled in THIS run. A field that was never declared can still be decided
   * truthfully: it is empty, so `is empty` holds and a value comparison does
   * not. When there is no else and the body is not chosen, the if runs nothing
   * and its input passes through unchanged.
   */
  /**
   * A body, once per roster element, in order.
   *
   * The roster is resolved from what the named block actually put in
   * `structured` — the parser has already refused any roster that is not a
   * declared `list` field on a block above this one, so what is left to decide
   * here is what to do when the promise was not kept. A block that declared a
   * list and returned something else, or nothing, gives an empty roster and the
   * body does not run: iterating a string by splitting it is the one thing this
   * container must never do, and that stays true when the string arrives at run
   * time rather than in the file.
   *
   * `max` is the authored bound the pre-run expansion report multiplied by, so
   * it is also the bound honoured here — a roster longer than it is cut, and the
   * log says so rather than quietly running the whole thing.
   */
  private async runForEach(
    run: Run, node: ForEachNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>,
  ): Promise<BlockStep[]> {
    const dot = node.roster.indexOf('.');
    const record = done.get(node.roster.slice(0, dot))?.structured as Record<string, unknown> | undefined;
    const value = record?.[node.roster.slice(dot + 1)];
    const roster = Array.isArray(value) ? value : [];
    const items = roster.slice(0, node.max);
    await session.append({
      type: 'block.status',
      data: {
        blockId: node.id, status: 'active', kind: 'foreach',
        roster: node.roster, elements: items.length,
        ...(roster.length > items.length ? { cut: roster.length - items.length } : {}),
      },
    });
    const steps: BlockStep[] = [];
    for (const item of items) {
      if (run.stopReason) break;
      const body: SequenceNode = { kind: 'sequence', id: node.id, children: node.children, position: node.position };
      // Each element is its own pass: it gets the element, not the carry from
      // the pass before, or the second element would be reading the first one's
      // work instead of its own.
      const ran = await this.runSequence(run, body, String(item ?? ''), session, new Map(done));
      steps.push(...ran);
      if (ran.at(-1)?.outcome.status === 'failed') break;
    }
    return steps;
  }

  private async runIf(
    run: Run, node: IfNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>,
  ): Promise<BlockStep[]> {
    const held = this.holds(node.predicate, done);
    const chosen = held ? node.children : (node.else ?? []);
    if (!chosen.length) return [];
    const body: SequenceNode = { kind: 'sequence', id: node.id, children: chosen, position: node.position };
    return this.runSequence(run, body, input, session, done);
  }

  private holds(predicate: IfPredicate, done: ReadonlyMap<string, BlockOutcome>): boolean {
    if ('source' in predicate) return this.holdsTerm(predicate, done);
    const terms = 'allOf' in predicate ? predicate.allOf : predicate.anyOf;
    const results = terms.map(term => this.holdsTerm(term, done));
    return 'allOf' in predicate ? results.every(Boolean) : results.some(Boolean);
  }

  private holdsTerm(term: IfPredicateTerm, done: ReadonlyMap<string, BlockOutcome>): boolean {
    const dot = term.source.indexOf('.');
    const record = done.get(term.source.slice(0, dot))?.structured as Record<string, unknown> | undefined;
    const value = record?.[term.source.slice(dot + 1)];
    return this.compare(term.operator, value, term.literal);
  }

  private compare(operator: IfOperator, value: unknown, literal: unknown): boolean {
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    switch (operator) {
      case 'is': return value === literal;
      case 'is not': return value !== literal;
      case 'is empty': return empty;
      case 'is not empty': return !empty;
      case '<': return typeof value === 'number' && typeof literal === 'number' && value < literal;
      case '<=': return typeof value === 'number' && typeof literal === 'number' && value <= literal;
      case '>': return typeof value === 'number' && typeof literal === 'number' && value > literal;
      case '>=': return typeof value === 'number' && typeof literal === 'number' && value >= literal;
      default: return false;
    }
  }

  /** One block, through the registry and the other seams. */
  private async runBlock(
    run: Run, node: BlockNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome> = new Map(),
  ): Promise<BlockStep> {
    // Already settled, according to the log. Not run again, and not
    // re-logged: replaying a block that finished is how a resume charges
    // twice for the same work and writes a second copy of its output.
    const already = done.get(node.id);
    if (already) {
      run.lastBlockId = node.id;
      return { node, outcome: already };
    }
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
    // What this block settled as, for anything downstream that reads it — an
    // `If` predicate names `<block>.<field>` and resolves it here. Without this
    // the map only ever held what a RESUME replayed from the log, so in a fresh
    // run every predicate read `undefined`, every field was empty, and every
    // `If` took its else branch. The parser cannot catch that: it checks the
    // field was declared, not that anyone recorded it.
    done.set(node.id, outcome);
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