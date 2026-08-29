/**
 * `ctx.agents` — the scheduler that turns a stack into steps.
 *
 * The seam that replaces the runner's scheduling half. A block is one step in
 * a stack; who executes it, in what workspace, under which ceiling, is
 * resolved through the other seams rather than known here.
 *
 * @module #kernel/seams/agents
 */
import type { Message } from '../types.js';

/** A stack as the scheduler receives it: containment, already resolved (D59). */
export interface StackRef {
  id: string;
  /** The run this execution belongs to. */
  runId: string;
  /** Durable host facts needed to explain and reconstruct an unattended run. */
  metadata?: {
    workspace?: string;
    approvalMode?: string;
    loopTaskId?: string;
    model?: string;
    provider?: string;
    level?: string;
    skills?: string[];
    presetId?: string | null;
    conversationId?: string;
    parentRunId?: string | null;
    supervisorSummary?: boolean;
    userMessage?: string;
    routing?: { costTier?: string; allowedModels?: string[] };
  };
}

/** How a run ended, in the only three ways that matter to a caller. */
export type RunOutcome =
  | { status: 'done'; messages: readonly Message[] }
  | { status: 'stopped'; reason: string }
  | { status: 'failed'; error: string };

/** One agent loop, mid-flight. */
export interface AgentRun {
  readonly runId: string;
  /** Resolves when the run settles. */
  settled(): Promise<RunOutcome>;
  /** Ask it to stop. It stops at the next durable boundary, never mid-write. */
  stop(reason: string): Promise<void>;
}

/** The seam. Provider: `flyt-stack-runner`. */
export interface AgentsSeam {
  /** Start a stack. Returns as soon as the run is durable, not when it finishes. */
  start(stack: StackRef, input: string): Promise<AgentRun>;
  /**
   * Resume an interrupted run from its log.
   *
   * Replay reaches the last durable event; a tool call that never returned is
   * reconstructed, not dropped (D17, D55).
   */
  resume(runId: string): Promise<AgentRun>;
  /** A run that is still in flight in this process, if any. */
  get(runId: string): AgentRun | undefined;
  /** Ask a live run to stop at its next durable boundary. False when it is not live here. */
  stop(runId: string, reason: string): Promise<boolean>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentsSeam;
  }
}
