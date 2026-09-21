/**
 * The one-shot step most blocks are.
 *
 * `work` is the exception — it runs the shared agent loop with tools until the
 * model stops calling them, because doing the work IS the point. Everything
 * else the canonical set holds (analyse, combine, split, plan, evaluate,
 * compare, refine, interrogate, orient) is one bounded pass over its input:
 * read what came in, produce the artifact its role names. None of them holds a
 * tool by default — a block that needs the repository names that in its own
 * ceiling (D57), and a stack narrows it further.
 *
 * Shared so the difference between "the thing that reads and judges" and "the
 * thing that does the work" is stated in exactly one place, and so a plugin
 * contributing a judgement block does not reimplement a loop — and its logging
 * — to do it. The request is built from the session log inside
 * {@link runAgentLoop}, so "model-visible means logged" (D55) holds for these
 * blocks the same way it holds for `work`.
 *
 * @module #kernel/plugins/blocks-aistep
 */
import type { JsonValue } from '../types.js';
import { outputWordLimit } from '../blocks/output-contract.js';
import { parseListOutput } from '../blocks/list-output.js';
import type { BlockOutcome, BlockRun } from '../blocks/types.js';
import { MAX_STEPS, runAgentLoop } from '../blocks/run.js';

/**
 * The settings a one-shot step accepts.
 *
 * `model` and `instructions` match `work` so a stack configures every block the
 * same way. `effort` is the v1 dial, carried across the port: a hint about how
 * hard to think, stated as an instruction because routing is the seam's
 * business, not the block's.
 */
export const AI_STEP_SETTINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', description: 'The model to ask for. Routing is the seam’s business.' },
    modelTier: {
      title: 'Model tier', enum: ['free', 'economy', 'standard', 'frontier'],
      description: 'Stable cost/quality profile. The model behind it is chosen globally.',
    },
    modelFallbacks: {
      type: 'array', items: { type: 'string' }, maxItems: 3,
      description: 'Ordered alternatives in the same explicit cost profile.',
    },
    systemPrompt: {
      type: 'string', format: 'multiline',
      description: 'Replace this block’s standing system prompt for this workflow instance.',
    },
    maxOutputWords: { type: 'integer', minimum: 1, description: 'Hard final-answer word limit, with one tool-free correction before failure.' },
    maxTokens: { type: 'integer', minimum: 1, maximum: 131_072, description: 'Per-query completion budget, including reasoning. A truncated answer continues before the block completes.' },
    inputOnly: { type: 'boolean', default: false, title: 'Use input only', description: 'Disable tools for this step. Use for summaries and transformations that need only the supplied material.' },
    instructions: { type: 'string', description: 'Appended to the block’s standing brief.' },
    effort: {
      enum: ['low', 'medium', 'high'],
      description: 'How hard to think, carried from the v1 node. A hint, not a route.',
    },
    maxSteps: { type: 'integer', minimum: 1, description: 'Soft tool-round threshold: warn here, then continue working.' },
  },
} as const;

/** Expose the same standing brief used by execution without storing an override. */
export const aiStepSettings = (brief: string) => ({
  ...AI_STEP_SETTINGS,
  properties: { ...AI_STEP_SETTINGS.properties,
    systemPrompt: { ...AI_STEP_SETTINGS.properties.systemPrompt, default: brief },
  },
});

const str = (value: JsonValue | undefined, fallback = ''): string =>
  (typeof value === 'string' && value ? value : fallback);

/**
 * The field a one-shot step fills when its block declares no narrower name.
 *
 * Every named ai-step block passes its own declared field; the fallback keeps
 * the executor callable without one.
 */
export const AI_STEP_OUTPUT = 'text';

/**
 * Run one bounded pass over the block's input.
 *
 * @param run — the block's execution context.
 * @param brief — the block's standing instructions (its role).
 * @param output — the declared structured field this pass fills, and what it
 *   holds: the deliverable itself unless it is 'list', when the deliverable
 *   is an array of complete items a For each roster may be read from (D56).
 * @returns what it produced, and why it stopped.
 */
export async function executeAiStep(
  run: BlockRun, brief: string, output: { name: string; type?: 'string' | 'list' } = { name: AI_STEP_OUTPUT },
  options: {
    turn?: number;
    toolLimits?: Readonly<Record<string, number>>;
    toolGuard?: (call: { id: string; name: string; args: JsonValue }) => string | null | undefined;
    maxSteps?: number;
  } = {},
): Promise<BlockOutcome> {
  const session = await run.ctx.sessions.open(run.runId);
  const instructions = str(run.config.instructions);
  const effort = str(run.config.effort);
  const standing = str(run.config.systemPrompt, brief);
  const ceiling = run.config.inputOnly === true ? [] : run.ceiling;
  const tools = run.ctx.tools.list().filter(t => ceiling.includes(t.name));

  const system = [
    standing,
    ...(str(run.config.systemPrompt) ? [] : ['\nFollow the requested scope and output format. Keep depth proportional to the task. Do not invent infrastructure, authorize additional changes, or add requirements to the supplied acceptance criteria. Label consequential assumptions. If instructions narrow this general role, follow that narrower task.']),
    ...(effort ? [`\nWork at ${effort.toUpperCase()} effort.`] : []),
    ...(instructions ? [`\n${instructions}`] : []),
    ...(output.type === 'list' ? [`\nOutput contract: return ONLY a JSON array. Each item is one complete, self-contained part or task, either a string (with all its Markdown details inside that string) or a task object. Do not make headings, context files, or acceptance criteria separate items. An empty list is [].`] : []),
  ].join('');

  const result = await runAgentLoop({
    ctx: run.ctx,
    session,
    runId: run.runId,
    blockId: run.blockId,
    context: run.context,
    turn: options.turn ?? 1,
    model: str(run.config.model, 'openrouter/auto'),
    fallbackModels: Array.isArray(run.config.modelFallbacks)
      ? run.config.modelFallbacks.filter((model): model is string => typeof model === 'string' && Boolean(model))
      : [],
    system,
    input: run.input, attachments: run.attachments,
    maxOutputWords: outputWordLimit(run.config.maxOutputWords, instructions) ?? outputWordLimit(undefined, run.input),
    maxTokens: typeof run.config.maxTokens === 'number' ? run.config.maxTokens : 16_384,
    continueOnLength: true,
    maxLengthContinuations: 2,
    tools,
    ceiling,
    ...(options.maxSteps != null ? { maxSteps: options.maxSteps } : {}),
    softMaxSteps: typeof run.config.maxSteps === 'number' ? run.config.maxSteps : MAX_STEPS,
    ...(options.toolLimits ? { toolLimits: options.toolLimits } : {}),
    ...(options.toolGuard ? { toolGuard: options.toolGuard } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
  });

  if (result.stopped !== 'answered') {
    return { status: 'failed', output: result.content, error: result.reason ?? result.stopped };
  }
  // The declaration is the contract: the one field this block declared is
  // the one field `structured` carries, so a predicate or a roster never
  // names a field the block did not fill.
  try {
    const structured = output.type === 'list'
      ? { [output.name]: parseListOutput(result.content, output.name) }
      : { [output.name]: result.content };
    return { status: 'done', output: result.content, structured };
  } catch (error) {
    return { status: 'failed', output: result.content, error: String((error as Error).message) };
  }
}
