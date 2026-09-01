/**
 * The kernel's event names and their payloads.
 *
 * The order a turn runs in:
 *
 * ```
 * turn/start -> agent/pre-step -> step/start -> llm/stream -> tool/call ->
 * tools/pre-execute -> tools/post-execute -> step/end -> turn/end
 * ```
 *
 * Names match dsh's where dsh has one, because a plugin written against
 * `tools/pre-execute` must find the same event here (D54). Dispatch mode is
 * part of the contract and is stated on every event: `waterfall` events can
 * veto or replace, `emit` events only observe.
 *
 * @module #kernel/events
 */
import type { Message, ToolCall, ToolResult, Usage, JsonValue } from './types.js';
import type { PermissionPolicy } from './security/permissions.js';

/** Where a turn happens: one run, one block, one step within it. */
export interface StepRef {
  runId: string;
  /** The block this step belongs to. */
  blockId: string;
  /** Monotonic within the block, from 1. */
  step: number;
}

/** One structured fragment of a native tool call while the model emits it. */
export interface ToolInputStreamEvent {
  /** Stable within one model request, including across parallel tool calls. */
  inputId: string;
  /** Provider tool-call index; ordering is by this index, not arrival. */
  index: number;
  phase: 'start' | 'delta' | 'end';
  /** Provider call id, once it has arrived. */
  toolCallId?: string;
  /** Tool name, once it has arrived. */
  name?: string;
  /** Exact JSON-string fragment for a delta. */
  delta?: string;
  /** Exact complete JSON string on end. */
  arguments?: string;
}

/** A pending tool call, on its way through the gate. */
export interface ToolExecution extends StepRef {
  call: ToolCall;
  /** The block's static ceiling at the moment of the call. Never widened downstream. */
  ceiling: readonly string[];
  /** Optional resource policy. The static ceiling is checked before this narrower layer. */
  permissionPolicy?: PermissionPolicy;
  /** Cancellation: a gate that waits must observe this. */
  signal?: AbortSignal;
  /** Durable lifecycle hook owned by the runner/session. */
  onState?: (transition: {
    callId: string;
    state: 'received' | 'normalized' | 'validated' | 'authorized' | 'running' | 'completed' | 'failed' | 'interrupted';
    reason?: string;
    diagnostics?: string[];
  }) => Promise<void> | void;
}

/**
 * The gate's answer.
 *
 * `ask` means a human must decide; a surface without approval support turns
 * `ask` into `deny`, because the failure of an unattended worker to ask is not
 * permission to proceed (D57).
 */
export type PreToolDecision =
  | { decision: 'allow' }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string };

/** What `tools/post-execute` may do to a settled result. */
export type PostToolDecision =
  | { decision: 'accept'; result: ToolResult }
  | { decision: 'block'; reason: string };

/** One streamed piece of a model response. */
export interface LlmChunk {
  /** Text destined for the model-visible content. */
  text?: string;
  /** Reasoning, kept separate from content (D40). */
  reasoning?: string;
  /** A tool call the model completed. */
  toolCall?: ToolCall;
  /** A native tool call's arguments while they are still being assembled. */
  toolInput?: ToolInputStreamEvent;
}

/** Why a model stopped, plus what it cost. */
export interface LlmSettled {
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';
  usage?: Usage;
  /** Which rung of the priority ladder answered, and why that one. */
  route?: RouteRecord;
}

/** The honest record of who answered a model request. */
export interface RouteRecord {
  /** The model the caller asked for. */
  requested: string;
  /** The provider that actually answered. */
  effective: string;
  /** Why this rung won: the one thing a person asks when the answer surprises them. */
  reason: string;
  /** True when this is not what the caller asked for. */
  degraded: boolean;
}

/** What `commands/invoke` says happened. */
export interface CommandInvocation {
  name: string;
  /** Recorded, never inferred: "an agent did this" is the first question asked. */
  caller: 'human' | 'agent';
  args: JsonValue;
  at: string;
  /** Present when it succeeded. */
  result?: JsonValue;
  /** Present when it refused. */
  error?: string;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A turn began. @mode emit */
    'turn/start'(turn: { runId: string; turn: number }): void;
    /** Before a step is planned: a listener may veto by returning a reason. @mode serial */
    'agent/pre-step'(step: StepRef): Promise<string | undefined> | string | undefined;
    /** A step began. @mode emit */
    'step/start'(step: StepRef): void;
    /** A piece of a model response arrived. @mode emit */
    'llm/stream'(step: StepRef, chunk: LlmChunk): void;
    /** The model asked for a tool. Observation only — the gate is the next event. @mode emit */
    'tool/call'(exec: ToolExecution): void;
    /**
     * Allow, deny or ask, before dispatch. `next()` delegates to allow.
     * @mode waterfall
     */
    'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
    /**
     * Accept or block a settled result. `next()` accepts it unchanged.
     * @mode waterfall
     */
    'tools/post-execute'(
      exec: ToolExecution,
      result: Readonly<ToolResult>,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision>;
    /** The registered tool set changed. @mode emit */
    'tools/change'(): void;
    /**
     * The installed block set changed.
     *
     * The peer of `tools/change`, and the library and the editor subscribe to
     * it for the same reason: a block that appeared because a plugin loaded,
     * or went because one unloaded, changes what a stack can name. @mode emit
     */
    'blocks/change'(): void;
    /**
     * A command was invoked, by whoever invoked it.
     *
     * The editor's subscription, and the reason an edit a model made animates
     * the way a dragged one does: both callers arrive here with the same
     * record (D63). Carries `error` instead of `result` when the command
     * refused — an edit that was attempted and refused is something a person
     * watching an agent work needs to see. @mode emit
     */
    'commands/invoke'(record: CommandInvocation): void;
    /** The validated UI declaration set changed. @mode emit */
    'ui-extensions/change'(): void;
    /** A step ended, with what the model settled on. @mode emit */
    'step/end'(step: StepRef, settled: LlmSettled): void;
    /** A turn ended. @mode emit */
    'turn/end'(turn: { runId: string; turn: number; messages: readonly Message[] }): void;
    /** An event was appended to a session log. The trace surface's subscription. @mode emit */
    'session/append'(runId: string, event: { seq: number; type: string; at: string; data: JsonValue }): void;
  }
}

/**
 * Every event the kernel defines, in the order a turn runs them.
 *
 * Exported as data so a test can assert the contract is complete rather than
 * asserting it in prose.
 */
export const KERNEL_EVENTS = [
  'turn/start',
  'agent/pre-step',
  'step/start',
  'llm/stream',
  'tool/call',
  'tools/pre-execute',
  'tools/post-execute',
  'tools/change',
  'blocks/change',
  'commands/invoke',
  'step/end',
  'turn/end',
  'session/append',
] as const;

/** One of the kernel's event names. */
export type KernelEvent = (typeof KERNEL_EVENTS)[number];
