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
    instructions: { type: 'string', description: 'Appended to the block’s standing brief.' },
    effort: {
      enum: ['low', 'medium', 'high'],
      description: 'How hard to think, carried from the v1 node. A hint, not a route.',
    },
    maxSteps: { type: 'integer', minimum: 1, description: 'Tool rounds before it must answer.' },
  },
} as const;

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
 *   is the newline-separated items a For each roster may be read from (D56).
 * @returns what it produced, and why it stopped.
 */
export async function executeAiStep(
  run: BlockRun, brief: string, output: { name: string; type?: 'string' | 'list' } = { name: AI_STEP_OUTPUT },
): Promise<BlockOutcome> {
  const session = await run.ctx.sessions.open(run.runId);
  const instructions = str(run.config.instructions);
  const effort = str(run.config.effort);
  const tools = run.ctx.tools.list().filter(t => run.ceiling.includes(t.name));

  const system = [
    brief,
    ...(effort ? [`\nWork at ${effort.toUpperCase()} effort.`] : []),
    ...(instructions ? [`\n${instructions}`] : []),
  ].join('');

  const result = await runAgentLoop({
    ctx: run.ctx,
    session,
    runId: run.runId,
    blockId: run.blockId,
    turn: 1,
    model: str(run.config.model, 'openrouter/auto'),
    system,
    input: run.input,
    tools,
    ceiling: run.ceiling,
    maxSteps: typeof run.config.maxSteps === 'number' ? run.config.maxSteps : MAX_STEPS,
    ...(run.signal ? { signal: run.signal } : {}),
  });

  if (result.stopped !== 'answered') {
    return { status: 'failed', output: result.content, error: result.reason ?? result.stopped };
  }
  // The declaration is the contract: the one field this block declared is
  // the one field `structured` carries, so a predicate or a roster never
  // names a field the block did not fill.
  const structured = output.type === 'list'
    ? { [output.name]: result.content.split('\n').map(line => line.trim()).filter(Boolean) }
    : { [output.name]: result.content };
  return { status: 'done', output: result.content, structured };
}
