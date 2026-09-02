/**
 * The agent loop: how one block turns into steps, through the seams.
 *
 * A shared helper rather than something each block reimplements. A block that
 * wrote its own loop would write its own logging with it, and "model-visible
 * means logged" (D55) would hold for whichever blocks remembered.
 *
 * The invariant is structural here, not a rule to follow: **the request is
 * built from the log**. `deriveMessages()` reads back what was appended, and
 * that list is what goes to the model — so a message the log does not hold is
 * a message the model never saw, and there is no second place for one to hide.
 *
 * Every event in `kernel/src/events.ts` fires, in the order documented there,
 * and `ctx.tools.execute` is the only path to a tool — so the ceiling and the
 * approval gate bind exactly once, on `tools/pre-execute`, wherever the tool
 * came from.
 *
 * @module #kernel/blocks/run
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue, Message, ToolCall, ToolResult, Usage } from '../types.js';
import type { SessionHandle } from '../seams/sessions.js';
import type { LlmChunk, LlmSettled, StepRef } from '../events.js';
import type { ToolDefinition } from '../seams/tools.js';
import type { StructuredOutputRequest, ReasoningRequest } from '../seams/llm.js';
import { normalizeToolCall, reconcileToolCallStates, terminalToolState, type ToolCallState } from '../tool-call-state.js';
import type { PermissionPolicy } from '../security/permissions.js';
import { executeCompatibleCalls } from '../tools/scheduler.js';
import { ProgressDetector, type RepetitionEvidence } from '../tools/progress.js';
import type { InterceptionRegistry } from '../plugins/interceptions.js';

/**
 * How many steps one block gets before the run warns that it is taking longer
 * than expected.
 *
 * This is deliberately a soft threshold for working agents. They keep going
 * after the warning until they answer, are cancelled, or an explicit hard
 * bound supplied by a tightly-scoped control block is reached.
 */
export const MAX_STEPS = 120;

/**
 * Durable stream cadence. Provider chunks can arrive once per token, and a
 * twelve-agent task graph otherwise turns each one into a synchronous append,
 * a projection notification and an IPC update. Batching deltas for a fraction
 * of a frame keeps reconnect recovery while bounding disk and renderer work.
 */
export const SESSION_STREAM_FLUSH_MS = 120;

/** Why the loop stopped, in the four ways that are not "the model finished". */
export type StopReason = 'answered' | 'bound' | 'cancelled' | 'vetoed';

/** What one block's agent loop produced. */
export interface LoopResult {
  /** The last content the model produced. */
  content: string;
  /** How many steps ran. */
  steps: number;
  /** Why it ended. `answered` is the ordinary one. */
  stopped: StopReason;
  /** Present when `stopped` is not `answered`: what to tell a person. */
  reason?: string;
  /** The finish reason of the last model response. */
  finishReason: string;
  /** Internal reasoning from the last response, kept separate from content. */
  reasoning?: string;
  /** Usage from the last response, so a block can diagnose token starvation. */
  usage?: Usage;
  /** Schema-constrained provider result or synthetic submission payload. */
  structuredOutput?: JsonValue;
  /** The message list as the log holds it, after the loop. */
  messages: Message[];
}

/** Everything the loop needs that is not already on the context. */
export interface LoopOptions {
  ctx: Context;
  session: SessionHandle;
  runId: string;
  /** The block this turn belongs to. */
  blockId: string;
  /** Monotonic across the run, so a trace can nest turns. */
  turn: number;
  /** The model to ask for. Routing is the seam's business, not this loop's. */
  model: string;
  /** Ordered alternatives within the same explicit profile (Free today). */
  fallbackModels?: readonly string[];
  /** The system message. Appended to the log before anything is sent. */
  system: string;
  /** What entered the block. Appended as the user message. */
  input: string;
  /** The tools this block may reach — the ceiling, already applied. */
  tools?: readonly ToolDefinition[];
  /** The ceiling itself, carried onto each execution so the gate can read it. */
  ceiling?: readonly string[];
  /** Resource-scoped rules beneath the static ceiling. */
  permissionPolicy?: PermissionPolicy;
  /** Bounded parallelism for compatible read-only calls in one response. */
  toolConcurrency?: number;
  /** Explicit attended decision required once repeated evidence is a clear loop. */
  approveRepeatedLoop?: (evidence: RepetitionEvidence) => Promise<boolean>;
  maxSteps?: number;
  /** Warn at this many steps and continue. Further warnings use exponential
   * milestones so a long run stays visible without flooding the log. */
  softMaxSteps?: number;
  /** Whole-completion ceiling. Reasoning models need headroom beyond the
   * visible answer budget because providers count both against max_tokens. */
  maxTokens?: number;
  /** Sampling temperature for bounded structural turns such as planning. */
  temperature?: number;
  structuredOutput?: StructuredOutputRequest;
  reasoning?: ReasoningRequest;
  /** A provider token ceiling is necessarily hard per request. When enabled,
   * a length-truncated response is logged, warned, and continued in a new
   * request instead of being mistaken for a finished block. */
  continueOnLength?: boolean;
  /** How many unusable empty or non-native tool-call turns may be repaired.
   * Repairs ask for a real call; they never infer or execute narrated args. */
  maxTurnRepairs?: number;
  /** Per-tool call caps for role-specific loops such as clarification. */
  toolLimits?: Readonly<Record<string, number>>;
  /** Role-specific semantic refusal before a call reaches the shared gate. */
  toolGuard?: (call: ToolCall) => string | null | undefined;
  /** Read only this block's tagged conversation from the canonical run log. */
  isolated?: boolean;
  signal?: AbortSignal;
}

/** The tool schemas a model request carries, from the definitions. */
function schemasFor(tools: readonly ToolDefinition[]): { name: string; description: string; parameters: unknown }[] {
  return tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export interface TurnRepairDiagnosis {
  kind: 'empty' | 'unparsed_tool_call';
  /** Adapter dialect or the allowed tool name narrated as a zero-argument call. */
  detail?: string;
}

/**
 * Classify a turn that produced no usable answer.
 *
 * The textual-call match is intentionally narrow: the whole visible answer
 * must be one or more zero-argument calls to tools that were actually offered.
 * We use it only to ask the model for a native call on the next turn. Parsing
 * and executing prose here would bypass schema validation and the approval
 * gate, and would invent every missing argument.
 */
export function diagnoseTurnRepair(
  content: string,
  toolNames: readonly string[],
  adapterDialect?: string,
): TurnRepairDiagnosis | null {
  if (adapterDialect) return { kind: 'unparsed_tool_call', detail: adapterDialect };
  const source = String(content ?? '').trim();
  if (!source) return { kind: 'empty' };
  if (!toolNames.length) return null;
  const calls = [...source.matchAll(/(?:^|\s)(?:→|➜|->)?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\)\s*[.;]?/g)];
  if (!calls.length) return null;
  const residue = source
    .replace(/(?:^|\s)(?:→|➜|->)?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\)\s*[.;]?/g, '')
    .trim();
  const names = calls.map(match => match[1]);
  return !residue && names.every(name => toolNames.includes(name))
    ? { kind: 'unparsed_tool_call', detail: [...new Set(names)].join(', ') }
    : null;
}

function turnRepairInstruction(diagnosis: TurnRepairDiagnosis): string {
  if (diagnosis.kind === 'unparsed_tool_call') {
    return [
      `Your previous response attempted a tool call as visible text (${diagnosis.detail ?? 'unparsed syntax'}).`,
      'No tool ran and you received no result. Do not repeat or imitate the text.',
      'If an offered tool is needed, issue it now through the native tool-calling interface with complete structured arguments.',
      'Otherwise provide the ordinary final answer now.',
    ].join(' ');
  }
  return [
    'Your previous response produced no visible answer or native tool call.',
    'Any internal reasoning was recorded, but it is not an actionable result.',
    'Continue now with a native tool call if work remains, or provide the ordinary final answer.',
  ].join(' ');
}

/**
 * Run one block's agent loop.
 *
 * @param options — see {@link LoopOptions}.
 * @returns what the block produced, and why the loop ended.
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    ctx, session, runId, blockId, turn, model, fallbackModels = [], system, input,
    tools = [], ceiling = [], permissionPolicy, toolConcurrency = 4, approveRepeatedLoop,
    maxSteps, softMaxSteps = MAX_STEPS, maxTokens, temperature,
    structuredOutput, reasoning: reasoningRequest,
    continueOnLength = false, maxTurnRepairs = 2,
    toolLimits = {}, toolGuard, isolated = false, signal,
  } = options;

  // A process restart never leaves a call looking live. Reconciliation is an
  // explicit durable transition; the original call id is settled in place.
  const priorEvents = [];
  for await (const event of session.read()) priorEvents.push(event);
  for (const call of reconcileToolCallStates(priorEvents, blockId)) {
    if (terminalToolState(call.state)) continue;
    await session.append({ type: 'tool.state', data: {
      blockId, callId: call.callId, state: 'interrupted',
      reason: `restart reconciliation settled a nonterminal ${call.state} call`, reconciled: true,
    } });
  }

  await session.append({ type: 'turn.start', data: { runId, turn, blockId } });
  ctx.emit('turn/start', { runId, turn });

  // The system and user messages reach the log BEFORE the request that carries
  // them. That ordering is the whole of D55: a crash between the append and the
  // call leaves a log that over-reports what the model saw, which is safe; the
  // other order leaves one that under-reports it, which is not.
  await session.append({ type: 'message.system', data: { blockId, content: system } });
  await session.append({ type: 'message.user', data: { blockId, content: input } });

  const schemas = schemasFor(tools);
  let content = '';
  const continuedContent: string[] = [];
  let reasoning = '';
  let usage: Usage | undefined;
  let structured: JsonValue | undefined;
  let finishReason = 'unknown';
  let stopped: StopReason = 'bound';
  let reason: string | undefined = maxSteps == null
    ? undefined
    : `The block used all ${maxSteps} of its hard-bounded steps without finishing.`;
  let step = 0;
  let stepsRun = 0;
  let nextSoftWarning = Math.max(1, Math.floor(softMaxSteps));
  const toolUses = new Map<string, number>();
  const progress = new ProgressDetector();
  let turnRepairs = 0;
  let toolValidationFailures = 0;
  let tokensSinceDurableProgress = 0;
  let costSinceDurableProgress = 0;
  // Once an ordered fallback has answered, prefer it for the rest of this
  // block turn. A tool-using response can need many follow-up steps; retrying a
  // rate-limited primary before every one adds minutes of identical failure.
  // Earlier rungs remain at the end as a last resort if the winner later goes
  // away, so affinity improves progress without silently narrowing the chain.
  let routeModels = [model, ...fallbackModels];

  for (step = 1; ; step++) {
    if (maxSteps != null && step > maxSteps) break;
    const ref: StepRef = { runId, blockId, step };

    if (signal?.aborted) {
      stopped = 'cancelled';
      reason = 'Stopped before the step began.';
      break;
    }

    // A listener may veto. Returning a reason is how a policy plugin refuses a
    // step without having to throw through the scheduler.
    const veto = await ctx.serial('agent/pre-step', ref);
    if (typeof veto === 'string' && veto) {
      stopped = 'vetoed';
      reason = veto;
      break;
    }

    await session.append({ type: 'step.start', data: { runId, blockId, step } });
    ctx.emit('step/start', ref);

    // From the LOG, never from a list held alongside it. This is what makes
    // "model-visible means logged" a property of the code rather than a rule
    // somebody has to keep: a message that is not in the log is not in the
    // request, because the request is the log.
    let messages = await session.deriveMessages(undefined, isolated ? blockId : undefined);
    const callId = `${blockId}-${step}`;
    let [requestModel, ...requestFallbacks] = routeModels;
    let requestSchemas = schemas;
    const interceptions = (ctx as typeof ctx & { interceptions?: InterceptionRegistry }).interceptions;
    const traceInterception = async (trace: readonly { point: string; plugin: string; order: number; mutated: boolean; beforeHash: string; afterHash: string }[]) => {
      for (const item of trace) await session.append({ type: 'plugin.interception', data: {
        callId, blockId, step, ...item,
      } });
    };
    if (interceptions) {
      const preparedTools: typeof schemas = [];
      for (const schema of requestSchemas) {
        const prepared = await interceptions.apply('tool.definition.prepared', schema as unknown as JsonValue);
        await traceInterception(prepared.trace);
        const value = prepared.payload as Record<string, unknown>;
        if (typeof value.name !== 'string' || typeof value.description !== 'string' || !value.parameters) {
          throw new Error('A tool.definition.prepared hook produced an invalid tool definition');
        }
        preparedTools.push(value as unknown as typeof schema);
      }
      requestSchemas = preparedTools;
      const assembled = await interceptions.apply('context.assembled', {
        messages: messages as unknown as JsonValue,
        tools: requestSchemas as unknown as JsonValue,
      });
      await traceInterception(assembled.trace);
      const value = assembled.payload as { messages?: unknown; tools?: unknown };
      if (Array.isArray(value.messages)) messages = value.messages as Message[];
      if (Array.isArray(value.tools)) requestSchemas = value.tools as typeof schemas;

      const prepared = await interceptions.apply('model.request.prepared', {
        model: requestModel, fallbackModels: requestFallbacks,
        messages: messages as unknown as JsonValue, tools: requestSchemas as unknown as JsonValue,
        maxTokens: maxTokens ?? null, temperature: temperature ?? null,
      });
      await traceInterception(prepared.trace);
      const request = prepared.payload as Record<string, unknown>;
      if (typeof request.model === 'string' && request.model) requestModel = request.model;
      if (Array.isArray(request.fallbackModels)) requestFallbacks = request.fallbackModels.filter((item): item is string => typeof item === 'string');
      if (Array.isArray(request.messages)) messages = request.messages as Message[];
      if (Array.isArray(request.tools)) requestSchemas = request.tools as typeof schemas;
    }
    await session.append({
      type: 'step.prompt',
      data: {
        blockId, step,
        // The messages are already canonical session events. Recording their
        // exact assembled request here makes one query inspectable without a
        // reader having to reconstruct the conversation by hand.
        content: {
          messages: messages as unknown as JsonValue,
          tools: requestSchemas.map(schema => schema.name),
        } as unknown as JsonValue,
      },
    });
    await session.append({
      type: 'llm.request',
      data: {
        callId, model: requestModel, blockId, step,
        ...(requestModel !== model ? { configuredModel: model } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        tools: requestSchemas.map(s => s.name), messages: messages.length,
      },
    });

    const stream = ctx.llm.stream({
      model: requestModel, messages, signal,
      ...(requestFallbacks.length ? { fallbackModels: requestFallbacks } : {}),
      ...(requestSchemas.length ? { tools: requestSchemas } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(structuredOutput ? { structuredOutput } : {}),
      ...(reasoningRequest ? { reasoning: reasoningRequest } : {}),
      onAttempt: async attempt => {
        await session.append({
          type: 'llm.attempt',
          data: { callId, blockId, step, ...attempt },
        });
      },
      onBudget: async decision => {
        await session.append({ type: 'context.budget', data: {
          callId, blockId, step,
          requested: decision.requested as unknown as JsonValue,
          effective: decision.effective as unknown as JsonValue,
          contextLimit: decision.contextLimit,
          contextUtilization: decision.contextUtilization,
          requestedOutput: decision.requestedOutput,
          effectiveOutput: decision.effectiveOutput,
          resolutions: decision.resolutions as unknown as JsonValue,
          actions: decision.actions as unknown as JsonValue,
        } });
        if (decision.checkpoint) await session.append({ type: 'context.checkpoint', data: {
          callId, blockId, step, content: decision.checkpoint,
          inputTokens: decision.requested.total,
          outputTokens: decision.effective.total,
          compressionRatio: Number((decision.effective.total / decision.requested.total).toFixed(6)),
        } });
      },
      onTelemetry: async record => {
        await session.append({ type: 'llm.telemetry', data: { callId, blockId, step, ...record } });
      },
    });
    let streamText = '';
    let streamReasoning = '';
    let lastStreamFlush = Date.now();
    const flushStream = async (): Promise<void> => {
      if (!streamText && !streamReasoning) return;
      const text = streamText;
      const thought = streamReasoning;
      streamText = '';
      streamReasoning = '';
      lastStreamFlush = Date.now();
      await session.append({
        type: 'llm.stream',
        data: {
          callId, blockId, step,
          ...(text ? { text } : {}),
          ...(thought ? { reasoning: thought } : {}),
        },
      });
    };
    for await (const chunk of stream) {
      ctx.emit('llm/stream', ref, chunk as LlmChunk);
      if (chunk.toolInput) {
        // Structured tool input is a crash-recovery boundary, not display
        // telemetry. Flush older prose first, then durably append this exact
        // fragment immediately; it must never wait behind the text timer.
        await flushStream();
        const input = chunk.toolInput;
        await session.append({
          type: `tool.input.${input.phase}`,
          data: {
            requestCallId: callId, blockId, step,
            inputId: input.inputId, index: input.index,
            ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.delta !== undefined ? { delta: input.delta } : {}),
            ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
          },
        });
      }
      if (chunk.text) streamText += chunk.text;
      if (chunk.reasoning) streamReasoning += chunk.reasoning;
      if (Date.now() - lastStreamFlush >= SESSION_STREAM_FLUSH_MS) await flushStream();
    }
    // The final partial batch is durable before the authoritative response.
    // A crash between these two writes therefore still leaves the latest text
    // a renderer can reconnect to.
    await flushStream();
    const answer = await stream.settled();
    stepsRun = step;

    const winner = routeModels.findIndex(candidate =>
      answer.route?.effective === candidate || answer.route?.effective?.endsWith(`/${candidate}`));
    if (winner > 0) routeModels = [...routeModels.slice(winner), ...routeModels.slice(0, winner)];

    content = answer.content ?? '';
    reasoning = answer.reasoning ?? '';
    usage = answer.usage;
    structured = answer.structuredOutput;
    finishReason = answer.finishReason ?? 'unknown';
    const offeredNames = requestSchemas.map(schema => schema.name);
    let calls: ToolCall[] = (answer.toolCalls ?? []).map(c => normalizeToolCall({
      id: c.id, name: c.name, args: (c.args ?? {}) as JsonValue,
    }, offeredNames));
    if (interceptions) {
      const hooked: ToolCall[] = [];
      for (const call of calls) {
        const normalized = await interceptions.apply('tool.call.normalized', call as unknown as JsonValue);
        await traceInterception(normalized.trace);
        const value = normalized.payload as Record<string, unknown>;
        hooked.push(normalizeToolCall({
          id: typeof value.id === 'string' ? value.id : call.id,
          name: typeof value.name === 'string' ? value.name : call.name,
          args: (value.args ?? call.args) as JsonValue,
        }, offeredNames));
      }
      calls = hooked;
    }
    tokensSinceDurableProgress += (answer.usage?.promptTokens ?? 0) + (answer.usage?.completionTokens ?? 0);
    costSinceDurableProgress += answer.usage?.costUsd ?? 0;

    await session.append({
      type: 'llm.response',
      data: {
        callId, blockId,
        content,
        ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
        ...(answer.replay ? { replay: answer.replay as unknown as JsonValue } : {}),
        ...(structured !== undefined ? { structuredOutput: structured } : {}),
        ...(calls.length ? { toolCalls: calls as unknown as JsonValue } : {}),
        ...(answer.unparsedToolCall ? { unparsedToolCall: answer.unparsedToolCall } : {}),
        finishReason,
        ...(answer.usage ? { usage: answer.usage as unknown as JsonValue } : {}),
        ...(answer.route ? { route: answer.route as unknown as JsonValue } : {}),
        requestedOutputBudget: maxTokens ?? null,
        effectiveOutputBudget: null,
        toolCallRepairCount: turnRepairs,
        toolValidationCount: toolValidationFailures,
        tokensSinceDurableProgress,
        costSinceDurableProgress,
      },
    });

    const settled: LlmSettled = {
      finishReason: finishReason as LlmSettled['finishReason'],
      ...(answer.usage ? { usage: answer.usage } : {}),
      ...(answer.route ? { route: answer.route } : {}),
    };

    if (!calls.length && finishReason === 'length' && continueOnLength) {
      if (content) continuedContent.push(content);
      await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
      ctx.emit('step/end', ref, settled);
      const continuation = `The provider stopped this response at its ${maxTokens?.toLocaleString('en-US') ?? 'configured'}-token ceiling. The block is still working and will continue in another request.`;
      await session.append({ type: 'block.warning', data: {
        blockId, code: 'soft_token_limit', transient: true, reason: continuation,
      } });
      await session.append({ type: 'message.user', data: {
        blockId,
        content: 'Your previous response reached the provider output limit. Continue from where it stopped. Do not repeat completed work; finish the task and then answer normally.',
      } });
      continue;
    }

    const repair = structured === undefined && !calls.length && tools.length
      ? diagnoseTurnRepair(content, schemas.map(schema => schema.name), answer.unparsedToolCall)
      : null;
    if (repair) {
      await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
      ctx.emit('step/end', ref, settled);
      if (turnRepairs >= Math.max(0, Math.floor(maxTurnRepairs))) {
        stopped = 'bound';
        reason = repair.kind === 'unparsed_tool_call'
          ? `The model repeatedly emitted a non-native tool call (${repair.detail ?? 'unknown syntax'}); no tool ran.`
          : 'The model repeatedly returned no visible answer or native tool call.';
        break;
      }
      turnRepairs += 1;
      await session.append({ type: 'block.warning', data: {
        blockId,
        code: repair.kind === 'unparsed_tool_call' ? 'tool_call_repair' : 'empty_turn_repair',
        transient: true,
        attempt: turnRepairs,
        maxAttempts: Math.max(0, Math.floor(maxTurnRepairs)),
        ...(repair.detail ? { detail: repair.detail } : {}),
        reason: turnRepairInstruction(repair),
      } });
      await session.append({ type: 'message.user', data: {
        blockId, content: turnRepairInstruction(repair),
      } });
      continue;
    }

    if (!calls.length) {
      if (continuedContent.length) content = [...continuedContent, content].join('');
      await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
      ctx.emit('step/end', ref, settled);
      stopped = 'answered';
      reason = undefined;
      break;
    }

    // State/call events are committed in model call order before any body can
    // finish. Safe reads may execute out of order; results below are appended
    // only after the scheduler restores this order.
    for (const call of calls) {
      await session.append({ type: 'tool.state', data: { callId: call.id, blockId, state: 'received' } });
      await session.append({ type: 'tool.state', data: {
        callId: call.id, blockId, state: 'normalized', name: call.name, args: call.args,
      } });
      await session.append({ type: 'tool.call', data: { callId: call.id, blockId, name: call.name, args: call.args } });
    }
    const results = await executeCompatibleCalls(
      calls.map(call => ({ call, tool: ctx.tools.get(call.name) })),
      async ({ call }) => {
      // The ONE path. `ctx.tools.execute` dispatches `tool/call`, then the
      // `tools/pre-execute` gate, then the body, then `tools/post-execute` —
      // so a refusal comes back as a result the model can read rather than as
      // an exception the scheduler has to interpret.
      const used = toolUses.get(call.name) ?? 0;
      const limit = toolLimits[call.name];
      let result: ToolResult;
      if (Number.isInteger(limit) && used >= limit) {
        result = {
          content: `Refused: ${call.name} has already used its ${limit}-call budget in this block. Make a reasonable explicit assumption and finish the deliverable.`,
          error: `${call.name} call budget exhausted`,
        };
        await session.append({ type: 'tool.state', data: {
          callId: call.id, blockId, state: 'failed', ...(result.error ? { reason: result.error } : {}),
        } });
      } else {
        toolUses.set(call.name, used + 1);
        const guarded = toolGuard?.(call);
        if (guarded) {
          result = { content: `Refused: ${guarded}`, error: `${call.name} call refused by this block` };
          await session.append({ type: 'tool.state', data: {
            callId: call.id, blockId, state: 'failed', ...(result.error ? { reason: result.error } : {}),
          } });
        } else {
          result = await ctx.tools.execute({
            ...ref, call, ceiling, ...(signal ? { signal } : {}),
            ...(permissionPolicy ? { permissionPolicy } : {}),
            onState: async transition => {
              if (transition.diagnostics?.length) toolValidationFailures += 1;
              await session.append({ type: 'tool.state', data: {
                blockId, callId: transition.callId, state: transition.state,
                ...(transition.reason ? { reason: transition.reason } : {}),
                ...(transition.diagnostics ? { diagnostics: transition.diagnostics } : {}),
              } });
            },
          });
        }
      }
      return result;
    }, toolConcurrency);

    let clearLoop: RepetitionEvidence | undefined;
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const result = results[index];
      await session.append({
        type: 'tool.result',
        data: {
          callId: call.id, blockId, name: call.name,
          content: result.content ?? '',
          ...(result.durableResult !== undefined ? { result: result.durableResult } : {}),
          ...(result.handle ? { handle: result.handle } : {}),
          ...(result.error ? { error: result.error } : {}),
          durableProgress: !result.error && ctx.tools.get(call.name)?.classification?.effect !== 'read',
        },
      });
      if (!result.error && ctx.tools.get(call.name)?.classification?.effect !== 'read') {
        progress.durableProgress();
        tokensSinceDurableProgress = 0;
        costSinceDurableProgress = 0;
      }
      const repeated = progress.record(call, Boolean(result.error), tokensSinceDurableProgress);
      if (repeated.warning) {
        await session.append({ type: 'tool.repetition', data: {
          blockId, callId: call.id, name: call.name, args: call.args,
          fingerprint: repeated.fingerprint, count: repeated.count,
          failureCount: repeated.failureCount, tokens: repeated.tokensSinceDurableProgress,
          durableStateChanged: repeated.durableStateChanged, clearLoop: repeated.clearLoop,
        } });
        if (!repeated.clearLoop) await session.append({ type: 'message.system', data: {
          blockId,
          content: `You repeated the identical ${call.name} call ${repeated.count} times. Before calling it again, explain what hypothesis changed and why the same input can now produce progress.`,
        } });
      }
      if (repeated.clearLoop) clearLoop = repeated;
    }

    if (clearLoop) {
      const allowed = approveRepeatedLoop ? await approveRepeatedLoop(clearLoop) : false;
      await session.append({ type: 'permission.decision', data: {
        blockId, callId: clearLoop.call.id, kind: 'repeated_tool_loop',
        decision: allowed ? 'allow' : 'deny', count: clearLoop.count,
        failureCount: clearLoop.failureCount, tokens: clearLoop.tokensSinceDurableProgress,
        durableStateChanged: clearLoop.durableStateChanged,
      } });
      if (!allowed) {
        stopped = 'vetoed';
        reason = `Repeated identical ${clearLoop.call.name} calls formed a clear loop; permission to continue was not granted.`;
        await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
        ctx.emit('step/end', ref, settled);
        break;
      }
    }

    await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
    ctx.emit('step/end', ref, settled);

    if (step >= nextSoftWarning) {
      const warning = `The block has used ${step.toLocaleString('en-US')} steps and is still working. This is a soft limit: execution will continue until the block answers or you stop it.`;
      await session.append({ type: 'block.warning', data: {
        blockId, code: 'soft_step_limit', transient: true, reason: warning,
      } });
      await session.append({ type: 'message.system', data: {
        blockId,
        content: `You have used ${step.toLocaleString('en-US')} tool rounds. Keep working if necessary, but avoid repeating reads or checks and finish the deliverable as soon as it is complete.`,
      } });
      nextSoftWarning *= 2;
    }
  }

  const messages = await session.deriveMessages(undefined, isolated ? blockId : undefined);
  await session.append({
    type: 'turn.end',
    data: { runId, turn, blockId, stopped, ...(reason ? { reason } : {}) },
  });
  ctx.emit('turn/end', { runId, turn, messages });

  return {
    content,
    steps: stepsRun,
    stopped,
    ...(reason ? { reason } : {}),
    finishReason,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(structured !== undefined ? { structuredOutput: structured } : {}),
    messages,
  };
}
