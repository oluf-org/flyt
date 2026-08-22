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
import type { JsonValue, Message, ToolCall } from '../types.js';
import type { SessionHandle } from '../seams/sessions.js';
import type { LlmChunk, LlmSettled, StepRef } from '../events.js';
import type { ToolDefinition } from '../seams/tools.js';

/**
 * How many steps one block gets before it must answer.
 *
 * An unbounded agent loop is a budget with no floor under it. The number is a
 * default and not a law: a block declares its own, and a caller may say.
 */
export const MAX_STEPS = 24;

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
  /** The system message. Appended to the log before anything is sent. */
  system: string;
  /** What entered the block. Appended as the user message. */
  input: string;
  /** The tools this block may reach — the ceiling, already applied. */
  tools?: readonly ToolDefinition[];
  /** The ceiling itself, carried onto each execution so the gate can read it. */
  ceiling?: readonly string[];
  maxSteps?: number;
  signal?: AbortSignal;
}

/** The tool schemas a model request carries, from the definitions. */
function schemasFor(tools: readonly ToolDefinition[]): { name: string; description: string; parameters: unknown }[] {
  return tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * Run one block's agent loop.
 *
 * @param options — see {@link LoopOptions}.
 * @returns what the block produced, and why the loop ended.
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    ctx, session, runId, blockId, turn, model, system, input,
    tools = [], ceiling = [], maxSteps = MAX_STEPS, signal,
  } = options;

  await session.append({ type: 'turn.start', data: { runId, turn, blockId } });
  ctx.emit('turn/start', { runId, turn });

  // The system and user messages reach the log BEFORE the request that carries
  // them. That ordering is the whole of D55: a crash between the append and the
  // call leaves a log that over-reports what the model saw, which is safe; the
  // other order leaves one that under-reports it, which is not.
  await session.append({ type: 'message.system', data: { content: system } });
  await session.append({ type: 'message.user', data: { content: input } });

  const schemas = schemasFor(tools);
  let content = '';
  let finishReason = 'unknown';
  let stopped: StopReason = 'bound';
  let reason: string | undefined =
    `The block used all ${maxSteps} of its steps without finishing.`;
  let step = 0;

  for (step = 1; step <= maxSteps; step++) {
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
    const messages = await session.deriveMessages();
    const callId = `${blockId}-${step}`;
    await session.append({
      type: 'llm.request',
      data: { callId, model, blockId, step, tools: schemas.map(s => s.name), messages: messages.length },
    });

    const stream = ctx.llm.stream({
      model, messages, signal,
      ...(schemas.length ? { tools: schemas } : {}),
    });
    for await (const chunk of stream) ctx.emit('llm/stream', ref, chunk as LlmChunk);
    const answer = await stream.settled();

    content = answer.content ?? '';
    finishReason = answer.finishReason ?? 'unknown';
    const calls: ToolCall[] = (answer.toolCalls ?? []).map(c => ({
      id: c.id, name: c.name, args: (c.args ?? null) as JsonValue,
    }));

    await session.append({
      type: 'llm.response',
      data: {
        callId,
        content,
        ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
        ...(calls.length ? { toolCalls: calls as unknown as JsonValue } : {}),
        finishReason,
        ...(answer.usage ? { usage: answer.usage as unknown as JsonValue } : {}),
        ...(answer.route ? { route: answer.route as unknown as JsonValue } : {}),
      },
    });

    const settled: LlmSettled = {
      finishReason: finishReason as LlmSettled['finishReason'],
      ...(answer.usage ? { usage: answer.usage } : {}),
      ...(answer.route ? { route: answer.route } : {}),
    };

    if (!calls.length) {
      await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
      ctx.emit('step/end', ref, settled);
      stopped = 'answered';
      reason = undefined;
      break;
    }

    for (const call of calls) {
      await session.append({ type: 'tool.call', data: { callId: call.id, name: call.name, args: call.args } });
      // The ONE path. `ctx.tools.execute` dispatches `tool/call`, then the
      // `tools/pre-execute` gate, then the body, then `tools/post-execute` —
      // so a refusal comes back as a result the model can read rather than as
      // an exception the scheduler has to interpret.
      const result = await ctx.tools.execute({ ...ref, call, ceiling, ...(signal ? { signal } : {}) });
      await session.append({
        type: 'tool.result',
        data: {
          callId: call.id, name: call.name,
          content: result.content ?? '',
          ...(result.error ? { error: result.error } : {}),
        },
      });
    }

    await session.append({ type: 'step.end', data: { runId, blockId, step, finishReason } });
    ctx.emit('step/end', ref, settled);
  }

  const messages = await session.deriveMessages();
  await session.append({
    type: 'turn.end',
    data: { runId, turn, blockId, stopped, ...(reason ? { reason } : {}) },
  });
  ctx.emit('turn/end', { runId, turn, messages });

  return {
    content,
    steps: Math.min(step, maxSteps),
    stopped,
    ...(reason ? { reason } : {}),
    finishReason,
    messages,
  };
}
