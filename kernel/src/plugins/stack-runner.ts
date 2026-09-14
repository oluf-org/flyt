import type { AssetRef } from '../types.js';
const mergeAssets = (...groups: (AssetRef[] | undefined)[]) => [...new Map(groups.flatMap(group => group ?? []).map(ref => [ref.assetId, ref])).values()];
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
 * received rather than whatever a sibling last produced. The block-input
 * contract also scopes model transcripts; a shared audit log grants no extra
 * context. A repeat is the other clear case: it is a sequence of
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
  type BlockNode, type ForEachNode, type IfNode, type UntilNode, type IfOperator, type IfPredicate, type IfPredicateTerm,
  type ParallelNode, type RepeatNode, type SequenceNode, type StackNode,
} from '../stack/types.js';
import type { BlockContext, BlockDefinition, BlockOutcome } from '../blocks/types.js';
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
  /** Host-owned, scoped context readers; still bounded by the run ceiling. */
  contextTools?: readonly string[];
}

/** What a block was given and what it returned, as the walk records it. */
interface BlockStep {
  node: BlockNode;
  outcome: BlockOutcome;
}

function blockIds(node: StackNode): Set<string> {
  if (node.kind === 'block') return new Set([node.id]);
  const children = node.kind === 'if' ? [...node.children, ...(node.else ?? [])] : node.children;
  return new Set(children.flatMap(child => [...blockIds(child)]));
}

function parallelCarry(node: ParallelNode, steps: readonly BlockStep[]): string | null {
  const outputs = node.children.map(lane => {
    const ids = blockIds(lane);
    const last = [...steps].reverse().find(step => ids.has(step.node.id));
    return last ? `## ${lane.id}\n${last.outcome.output}` : null;
  }).filter((value): value is string => value !== null);
  return outputs.length ? outputs.join('\n\n') : null;
}

/**
 * One run in flight.
 *
 * `stop()` sets the boundary flag and aborts the current model/tool call. The
 * block still reaches the same durable unwind path, which records the stopped
 * stage before the scheduler settles; it just does not wait minutes for a
 * provider or child process after the person asked it to stop.
 */
class Run implements AgentRun {
  readonly runId: string;
  private settledPromise: Promise<RunOutcome>;
  private stopRequest: string | null = null;
  private abortController = new AbortController();
  private pauseRequest = false;
  private pauseGate: Promise<void> | null = null;
  private releasePause: (() => void) | null = null;
  private transitions: Promise<unknown> = Promise.resolve();
  finished = false;

  transition<T>(action: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(action);
    this.transitions = next.catch(() => {});
    return next;
  }

  constructor(runId: string, walk: (run: Run) => Promise<RunOutcome>, readonly replay = new Map<string, BlockOutcome>()) {
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
  get signal(): AbortSignal { return this.abortController.signal; }

  settled(): Promise<RunOutcome> { return this.settledPromise; }

  async stop(reason: string): Promise<void> {
    if (this.finished) return;
    // Idempotent, and harmless after the fact: a caller that crashed halfway
    // through a shutdown has to be able to finish it, and a run that already
    // settled has nothing to stop.
    this.stopRequest ??= reason || 'stopped';
    this.pauseRequest = false;
    this.releasePause?.();
    this.releasePause = null;
    this.abortController.abort(this.stopRequest);
  }

  async pause(_reason?: string): Promise<boolean> {
    if (this.stopRequest || this.pauseRequest || this.pauseGate) return false;
    this.pauseRequest = true;
    return true;
  }

  async continue(): Promise<boolean> {
    if (!this.pauseRequest && !this.pauseGate) return false;
    this.pauseRequest = false;
    this.releasePause?.();
    this.releasePause = null;
    return true;
  }

  /** Cooperatively hold between durable block boundaries. */
  async waitIfPaused(session: SessionHandle): Promise<boolean> {
    let gate: Promise<void> | null = null;
    await this.transition(async () => {
      if (!this.pauseRequest || this.stopRequest || this.finished) return;
      if (!this.pauseGate) {
        this.pauseGate = new Promise(resolve => { this.releasePause = resolve; });
        await session.append({ type: 'run.stage', data: { stage: 'paused', afterBlock: this.lastBlockId } });
      }
      gate = this.pauseGate;
    });
    await gate;
    if (gate && this.pauseGate === gate) {
      this.pauseGate = null;
      this.releasePause = null;
    }
    return gate !== null;
  }

  complete(session: SessionHandle, error: string | null = null, blockId: string | null = null, blocksRan = 0): Promise<RunOutcome> {
    return this.transition(async () => {
      this.finished = true;
      if (this.stopRequest) {
        await session.append({ type: 'run.stage', data: { stage: 'stopped', reason: this.stopRequest, afterBlock: this.lastBlockId, blocksRan } });
        return { status: 'stopped', reason: this.stopRequest };
      }
      if (error) {
        await session.append({ type: 'run.error', data: { error, ...(blockId ? { blockId } : {}) } });
        await session.append({ type: 'run.stage', data: { stage: 'failed' } });
        return { status: 'failed', error };
      }
      await session.append({ type: 'run.stage', data: { stage: 'done' } });
      return { status: 'done', messages: await session.deriveMessages() as Message[] };
    });
  }
}

/** The scheduler. Provider of `ctx.agents`. */
export class StackRunner extends Service implements AgentsSeam {
  private runs = new Map<string, Run>();
  private launches = new Set<string>();
  private stacks: StackSource | null;
  private ceiling: readonly string[];
  private contextTools: readonly string[];

  constructor(ctx: Context, config: StackRunnerConfig = {}) {
    super(ctx, 'agents');
    this.stacks = config.stacks ?? null;
    this.ceiling = config.ceiling ?? [];
    this.contextTools = config.contextTools ?? [];
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
    if (this.launches.has(stack.runId) || this.runs.has(stack.runId)) throw new Error(`Run "${stack.runId}" is already live or starting`);
    this.launches.add(stack.runId);
    try { return await this.startReserved(stack, input); }
    finally { this.launches.delete(stack.runId); }
  }

  private async startReserved(stack: StackRef, input: string): Promise<AgentRun> {
    const resolved = this.stacks?.resolve(stack.id) ?? null;
    const root = resolved ? structuredClone(resolved) : null;
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
    await session.append({
      type: 'run.created',
      data: {
        runId: stack.runId, stackId: stack.id, input, prompt: input,
        ...(stack.metadata ?? {}),
      },
    });

    // The bounds that decide whether this tree may run at all are known now,
    // before any block executes. They go in the log so a run that went wrong
    // can still say what it was allowed to become (D55).
    const bounds = boundStack(root);
    await session.append({
      type: 'stack.resolved',
      data: { stackId: stack.id, stack: root as unknown as JsonValue },
    });
    await session.append({
      type: 'run.stage',
      data: { stage: 'execution', blockCount: bounds.blocks, worstCaseExpansion: bounds.expansion },
    });

    const run = new Run(stack.runId, r => this.walkRun(r, root, input, session));
    this.runs.set(stack.runId, run);
    void run.settled().finally(() => {
      if (this.runs.get(stack.runId) === run) this.runs.delete(stack.runId);
    });
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
    if (this.launches.has(runId)) throw new Error(`Run "${runId}" is already starting or resuming`);
    const live = this.runs.get(runId);
    if (live) return live;
    this.launches.add(runId);
    try { return await this.resumeReserved(runId); }
    finally { this.launches.delete(runId); }
  }

  private async resumeReserved(runId: string): Promise<AgentRun> {

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
    const stageEvents = events.filter(e => e.type === 'run.stage');
    const lastStage = stageEvents.at(-1);
    const last = String((lastStage?.data as { stage?: unknown })?.stage ?? '');
    const restartedAfterTerminal = (last === 'done' || last === 'failed') && events.some(event => (
      event.type === 'block.status'
      && (event.data as { status?: unknown })?.status === 'pending'
      && event.seq > (lastStage?.seq ?? 0)
    ));
    if ((last === 'done' || last === 'failed') && !restartedAfterTerminal) {
      const settled: RunOutcome = last === 'done'
        ? { status: 'done', messages: await past.deriveMessages() as Message[] }
        : {
          status: 'failed',
          error: String((events.findLast(e => e.type === 'run.error')?.data as { error?: unknown })?.error
            ?? 'the run failed'),
        };
      return {
        runId, settled: async () => settled, stop: async () => {},
        pause: async () => false, continue: async () => false,
      };
    }

    // Recovery executes the recorded definition, even if its library file was
    // edited or removed. Old logs without a snapshot keep the legacy fallback.
    const saved = events.find(e => e.type === 'stack.resolved')?.data as { stack?: SequenceNode } | undefined;
    const root = saved?.stack ? structuredClone(saved.stack) : this.stacks?.resolve(stackId) ?? null;
    if (!root) throw new Error(`Run "${runId}" is a run of stack "${stackId}", which this runner cannot resolve.`);
    // Explicit worker changes are separate from changing the authored tree.
    for (const event of events.filter(e => e.type === 'run.reconfigured')) {
      const change = event.data as Record<string, any>;
      const visit = (node: StackNode): void => {
        if (node.kind === 'block') {
          const model = change.blockWorkers?.[node.id]?.model ?? change.model;
          if (model) node.config = { ...node.config, model, modelFallbacks: [] };
        } else { node.children.forEach(visit); if (node.kind === 'if') node.else?.forEach(visit); }
      };
      visit(root);
    }

    // What already finished, and what it produced. Both from the log.
    const done = new Map<string, BlockOutcome>();
    const outputs = new Map<string, string>();
    const owners = new Map<string, string>();
    for (const event of events) {
      const data = event.data as { blockId?: unknown; executionId?: string; status?: unknown; attachments?: AssetRef[]; content?: unknown; error?: unknown; port?: unknown };
      const key = data.executionId ?? String(data.blockId ?? '');
      if (typeof data.blockId === 'string') owners.set(key, data.blockId);
      if (event.type === 'block.output' && typeof data.blockId === 'string') {
        if (!data.port) outputs.set(key, String(data.content ?? ''));
      }
      if (event.type !== 'block.status' || typeof data.blockId !== 'string') continue;
      if (data.status === 'pending') {
        // A supervisor restart names the authored block, so invalidate every
        // iteration of that block; interruption records name one execution.
        if (!data.executionId) for (const [execution, owner] of owners) {
          if (owner === data.blockId) { done.delete(execution); outputs.delete(execution); }
        }
        done.delete(key);
        outputs.delete(key);
        continue;
      }
      if (data.status === 'done' || data.status === 'failed') {
        done.set(key, {
          status: data.status,
          attachments: (data.attachments ?? []) as AssetRef[],
          output: outputs.get(key) ?? '',
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

    const run = new Run(runId, r => this.walkRun(r, root, input, session), done);
    this.runs.set(runId, run);
    void run.settled().finally(() => {
      if (this.runs.get(runId) === run) this.runs.delete(runId);
    });
    return run;
  }

  /** A run still in flight in this process, if any. */
  get(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }

  async stop(runId: string, reason: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    const pending = run.transition(async () => {
      if (run.finished) return false;
      const session = await this.ctx.sessions.open(runId);
      await session.append({ type: 'run.stage', data: { stage: 'stopping', reason: reason || 'stopped', afterBlock: run.lastBlockId } });
      return true;
    });
    // Signal immediately, while ordering the acknowledgement ahead of settlement.
    await run.stop(reason);
    return pending;
  }

  async pause(runId: string, reason = 'paused by request'): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    return run.transition(async () => {
      if (run.finished || !await run.pause(reason)) return false;
      const session = await this.ctx.sessions.open(runId);
      await session.append({ type: 'run.stage', data: { stage: 'pausing', reason, afterBlock: run.lastBlockId } });
      return true;
    });
  }

  async continue(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    return run.transition(async () => {
      if (run.finished || run.stopReason) return false;
      if (!await run.continue()) return false;
      const session = await this.ctx.sessions.open(runId);
      await session.append({ type: 'run.stage', data: { stage: 'resumed', afterBlock: run.lastBlockId } });
      return true;
    });
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
      // The implicit root is represented by run.stage; authored controls
      // below it own the container lifecycle shown in Work.
      let attachments: AssetRef[] = [];
      for await (const event of session.read()) if (event.type === 'run.created') {
        attachments = ((event.data as Record<string, JsonValue>).attachments ?? []) as AssetRef[]; break;
      }
      const walked = await this.runSequence(run, root, input, session, done, '', attachments);
      const failed = walked.find(s => s.outcome.status === 'failed');
      return run.complete(session, failed ? `Block "${failed.node.id}" failed: ${failed.outcome.error ?? 'no reason given'}` : null, failed?.node.id, walked.length);
    } catch (err) {
      const error = String((err as Error)?.message ?? err);
      return run.complete(session, error);
    }
  }

  /**
   * Walk one node, with what entered it.
   *
   * @returns every block step this subtree ran, in completion order.
   */
  private async walk(
    run: Run, node: StackNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep[]> {
    await run.waitIfPaused(session);
    if (run.stopReason) return [];
    if (node.kind === 'block') return [await this.runBlock(run, node, input, session, done, scope, attachments)];
    const identity = { blockId: node.id, kind: node.kind, executionId: scope ? `${scope}/${node.id}` : node.id };
    // Controls have a lifecycle too. Child completion alone cannot describe
    // a running Repeat, an empty For each, or an If's unselected branch.
    // For each announces its active state with roster size and truncation.
    if (node.kind !== 'foreach') await session.append({ type: 'block.status', data: { ...identity, status: 'active' } });
    try {
      const steps = node.kind === 'parallel' ? await this.runParallel(run, node, input, session, done, scope, attachments)
        : node.kind === 'repeat' ? await this.runRepeat(run, node, input, session, done, scope, attachments)
        : node.kind === 'if' ? await this.runIf(run, node, input, session, done, scope, attachments)
        : node.kind === 'foreach' ? await this.runForEach(run, node, input, session, done, scope, attachments)
        : node.kind === 'until' ? await this.runUntil(run, node, input, session, done, scope, attachments)
        : await this.runSequence(run, node, input, session, done, scope, attachments);
      const failure = steps.find(step => step.outcome.status === 'failed');
      await session.append({ type: 'block.status', data: { ...identity,
        status: run.stopReason ? 'pending' : failure ? 'failed' : 'done',
        ...(failure?.outcome.error ? { error: failure.outcome.error } : {}),
      } });
      return steps;
    } catch (error) {
      await session.append({ type: 'block.status', data: { ...identity, status: 'failed', error: String((error as Error)?.message ?? error) } });
      throw error;
    }
  }

  /** Children, top to bottom, each fed what the one before produced. */
  private async runSequence(
    run: Run, node: SequenceNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep[]> {
    const steps: BlockStep[] = [];
    let carried = input;
    for (const child of node.children) {
      // The durable boundary. A stop lands BETWEEN children, after the event
      // that recorded the last one, and never inside a block.
      if (run.stopReason) break;
      const ran = await this.walk(run, child, carried, session, done, scope, attachments);
      steps.push(...ran);
      attachments = mergeAssets(attachments, ...ran.map(step => step.outcome.attachments));
      const last = ran.at(-1);
      if (ran.some(step => step.outcome.status === 'failed')) break;
      if (child.kind === 'parallel') carried = parallelCarry(child, ran) ?? carried;
      else if (last) carried = last.outcome.output;
    }
    return steps;
  }

  /**
   * Lanes, together, under the bound.
   *
   * Every lane receives what entered the PARALLEL. That single choice is lane
   * input isolation (D37). runBlock's context contract independently prevents
   * sibling transcripts from entering model requests through the shared log.
   */
  private async runParallel(
    run: Run, node: ParallelNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep[]> {
    const lanes = node.children;
    const bound = Math.max(1, node.maxParallel ?? lanes.length);
    const steps: BlockStep[] = [];
    // Freeze before any wave starts. On resume, done also contains completed
    // siblings: those belong only to their own lane until this container joins.
    const entry = new Map(done);
    const upstream = new Map(done);
    for (const lane of lanes) for (const id of blockIds(lane)) upstream.delete(id);
    for (let i = 0; i < lanes.length; i += bound) {
      if (run.stopReason) break;
      const wave = lanes.slice(i, i + bound);
      // Each lane gets its OWN view of what has settled. Every lane already
      // receives what entered the parallel rather than what a sibling produced
      // (D37); a shared map would have handed that isolation straight back,
      // because an `If` predicate in one lane could name a block in another and
      // read its structured output. A lane still sees everything that settled
      // before the parallel, which is genuinely upstream of it.
      const ran = await Promise.all(wave.map(lane => {
        const laneDone = new Map(upstream);
        for (const id of blockIds(lane)) {
          const prior = entry.get(id);
          if (prior) laneDone.set(id, prior);
        }
        return this.walk(run, lane, input, session, laneDone, scope, [...attachments]);
      }));
      for (const laneSteps of ran) steps.push(...laneSteps);
      if (steps.some(s => s.outcome.status === 'failed')) break;
    }
    // The container boundary is the explicit join for structured artifacts.
    for (const step of steps) done.set(step.node.id, step.outcome);
    return steps;
  }

  /**
   * A repeat runs its body exactly `count` times, each iteration fed what the
   * one before produced — the same carry a sequence threads — and a failing
   * body stops it the way a sequence stops.
   */
  private async runRepeat(
    run: Run, node: RepeatNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep[]> {
    const body: SequenceNode = { kind: 'sequence', id: node.id, children: node.children, position: node.position };
    const steps: BlockStep[] = [];
    let carried = input;
    for (let i = 0; i < node.count; i++) {
      if (run.stopReason) break;
      const attempt = new Map(done);
      for (const id of blockIds(body)) attempt.delete(id);
      const walked = await this.runSequence(run, body, carried, session, attempt, `${scope}/${node.id}[${i}]`, attachments);
      steps.push(...walked);
      attachments = mergeAssets(attachments, ...walked.map(step => step.outcome.attachments));
      const last = walked.at(-1);
      if (walked.some(step => step.outcome.status === 'failed')) break;
      if (last) carried = last.outcome.output;
      for (const step of walked) done.set(step.node.id, step.outcome);
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
  /**
   * The body, again, until the condition holds or the passes run out.
   *
   * The condition is the same structured predicate an `If` takes, and it
   * normally names a block inside this body: the body's own verdict is what
   * decides whether to go round again. Each pass therefore starts from the
   * `done` map as it was BEFORE the pass — otherwise pass two would be judged
   * on pass one's verdict, and an until that succeeded once would never run
   * again however bad the next attempt was.
   *
   * Running out of passes fails the run. An until whose condition never holds
   * has not finished quietly; it has failed to do the thing, and a walk that
   * carried on would hand the next block work that was never accepted.
   */
  private async runUntil(
    run: Run, node: UntilNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep[]> {
    const steps: BlockStep[] = [];
    let carried = input;
    for (let pass = 1; pass <= node.max; pass++) {
      if (run.stopReason) break;
      const attempt = new Map(done);
      const body: SequenceNode = { kind: 'sequence', id: node.id, children: node.children, position: node.position };
      for (const id of blockIds(body)) attempt.delete(id);
      const ran = await this.runSequence(run, body, carried, session, attempt, `${scope}/${node.id}[${pass - 1}]`, attachments);
      steps.push(...ran);
      attachments = mergeAssets(attachments, ...ran.map(step => step.outcome.attachments));
      const last = ran.at(-1);
      if (ran.some(step => step.outcome.status === 'failed')) return steps;
      if (last) carried = last.outcome.output;
      if (this.holds(node.condition, attempt)) {
        await session.append({
          type: 'block.status',
          data: { blockId: node.id, status: 'done', kind: 'until', passes: pass },
        });
        // What the body settled as is what the until settled as, so whatever
        // follows reads the accepted attempt rather than the first one.
        for (const [id, outcome] of attempt) done.set(id, outcome);
        return steps;
      }
    }
    if (run.stopReason) return steps;
    const error = `"${node.id}" ran its body ${node.max} time(s) and its condition never held`;
    await session.append({
      type: 'block.status',
      data: { blockId: node.id, status: 'failed', kind: 'until', passes: node.max, error },
    });
    steps.push({
      node: { kind: 'block', id: node.id, use: 'until', title: null, config: {}, outputs: [], position: node.position },
      outcome: { status: 'failed', output: carried, error },
    });
    return steps;
  }

  private async runForEach(
    run: Run, node: ForEachNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
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
    const upstream = new Map(done);
    for (const [index, item] of items.entries()) {
      if (run.stopReason) break;
      const body: SequenceNode = { kind: 'sequence', id: node.id, children: node.children, position: node.position };
      // Each element is its own pass: it gets the element, not the carry from
      // the pass before, or the second element would be reading the first one's
      // work instead of its own.
      const attempt = new Map(upstream);
      for (const id of blockIds(body)) attempt.delete(id);
      const itemInput = typeof item === 'string' ? item : JSON.stringify(item ?? null);
      const ran = await this.runSequence(run, body, itemInput, session, attempt, `${scope}/${node.id}[${index}]`, [...attachments]);
      steps.push(...ran);
      if (ran.some(step => step.outcome.status === 'failed')) break;
      // Downstream structured consumers see the last completed element.
      for (const step of ran) done.set(step.node.id, step.outcome);
    }
    return steps;
  }

  private async runIf(
    run: Run, node: IfNode, input: string, session: SessionHandle,
    done: Map<string, BlockOutcome>, scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep[]> {
    const held = this.holds(node.predicate, done);
    const chosen = held ? node.children : (node.else ?? []);
    if (!chosen.length) return [];
    const body: SequenceNode = { kind: 'sequence', id: node.id, children: chosen, position: node.position };
    return this.runSequence(run, body, input, session, done, scope, attachments);
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
    done: Map<string, BlockOutcome> = new Map(), scope = '', attachments: AssetRef[] = [],
  ): Promise<BlockStep> {
    // Already settled, according to the log. Not run again, and not
    // re-logged: replaying a block that finished is how a resume charges
    // twice for the same work and writes a second copy of its output.
    const executionId = scope ? `${scope}/${node.id}` : node.id;
    // Old logs lack iteration ids. Their one recorded outcome can only be
    // reused for the first element/pass, never for every remaining element.
    const legacyFirst = scope && !/\[[1-9]\d*\]/.test(scope);
    const already = run.replay.get(executionId) ?? (legacyFirst ? run.replay.get(node.id) : undefined);
    if (already) {
      done.set(node.id, already);
      run.lastBlockId = node.id;
      return { node, outcome: already };
    }
    const definition: BlockDefinition = this.ctx.blocks.require(node.use, `block "${node.id}"`);
    // The block's own ceiling narrows the run's; it never widens it (D57).
    const blockCeiling = definition.ceiling
      ? definition.ceiling.filter(t => this.ceiling.includes(t))
      : this.ceiling;
    const ceiling = [...new Set([...blockCeiling, ...this.contextTools.filter(tool => this.ceiling.includes(tool))])];

    // A fresh invocation starts with explicit input only. An interrupted one
    // keeps its cursor so its own tool history survives resume. Parent ordering
    // stays authoritative; context isolation does not require moving the trace.
    let context: BlockContext | undefined;
    let restartGuidance = '';
    let legacyAfter = 0;
    for await (const event of session.read()) {
      const data = event.data as Record<string, unknown>;
      if (event.type !== 'block.status' || data.blockId !== node.id) continue;
      if (!data.executionId && data.status === 'pending' && data.reason === 'restarted by supervisor') {
        context = undefined;
        restartGuidance = String(data.guidance ?? '');
        legacyAfter = event.seq;
        continue;
      }
      if ((data.executionId ?? node.id) !== executionId && !(legacyFirst && !data.executionId)) continue;
      if (data.status === 'active') {
        context = (data.context as unknown as BlockContext | undefined)
          ?? { mode: 'block-input', after: legacyAfter };
      } else if (data.status !== 'pending' || data.reason !== 'interrupted before this block settled') {
        context = undefined;
        legacyAfter = event.seq;
      }
    }
    context ??= { mode: 'block-input', after: await session.head() };
    context = { ...context, executionId };
    await session.append({ type: 'block.status', data: {
      blockId: node.id, executionId, status: 'active', use: node.use,
      context: { ...context }, attachments,
    } });
    let outcome: BlockOutcome;
    try {
      let goalContext = '';
      for await (const event of session.read()) {
        if (event.type === 'run.created') {
          const packet = (event.data as Record<string, JsonValue>).goalContext;
          if (packet) goalContext = `GOAL CONTRACT AND MEMORY:\n${JSON.stringify(packet)}\n\nSTEP INPUT:\n`;
          break;
        }
      }
      if (goalContext && input.length > 32000) throw new Error('Goal step input exceeds 32,000 characters; chunk the artifact before continuing.');
      outcome = await definition.execute({
        ctx: this.ctx,
        runId: run.runId,
        blockId: node.id,
        config: node.config,
        input: goalContext + (restartGuidance ? `${input}\n\nSupervisor restart guidance:\n${restartGuidance}` : input),
        context,
        attachments,
        ceiling,
        signal: run.signal,
        checkpoint: () => run.waitIfPaused(session),
      });
    } catch (err) {
      // A throwing block is a failed block, not a crashed run: the walk still
      // has to close the log and say which block it was.
      outcome = { status: 'failed', output: '', error: String((err as Error)?.message ?? err) };
    }

// Only this invocation's user answers can add references to its output scope.
    for await (const event of session.read(context.after)) {
      if (event.type === 'message.user' && (event.data as Record<string, JsonValue>).blockId === node.id && Array.isArray((event.data as Record<string, JsonValue>).attachments)) {
        attachments = mergeAssets(attachments, (event.data as Record<string, JsonValue>).attachments as AssetRef[]);
      }
    }
    outcome.attachments = mergeAssets(attachments, outcome.attachments);
    if (outcome.output) {
      await session.append({ type: 'block.output', data: { blockId: node.id, executionId, content: outcome.output } });
    }
    await session.append({
      type: 'block.status',
      data: {
        blockId: node.id, executionId, status: run.stopReason && outcome.status === 'failed' ? 'pending' : outcome.status,
        ...(run.stopReason && outcome.status === 'failed' ? { reason: 'interrupted before this block settled' } : {}),
        attachments: outcome.attachments,
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
