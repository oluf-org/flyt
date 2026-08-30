/**
 * `flyt-blocks-judgement` — the blocks that read and judge.
 *
 * Evaluation, compare, prompt-refiner. Each is a one-shot step (see
 * `blocks-aistep`): it reads what came in and returns a verdict, a comparison,
 * or a tightened brief. None holds a tool by default; a stack grants reach by
 * naming a ceiling, and children narrow it (D57).
 *
 * @module #kernel/plugins/blocks-judgement
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { BlockDefinition, BlockOutcome, BlockRun } from '../blocks/types.js';
import { AI_STEP_SETTINGS, executeAiStep } from './blocks-aistep.js';

const PROMPT_REFINER_SYSTEM = [
  'Rewrite the request into a precise, self-contained brief: goal, constraints, deliverable, acceptance.',
  'If an ambiguity would materially change the work, call ask_human and wait for its answer.',
  'You refine the request; you do not inspect or execute it. That role boundary is not an ambiguity: never ask whether you should refine, plan, or execute. Always produce the downstream brief.',
  'Preserve references such as "this repository" or "the bound workspace" for downstream blocks, and never ask the user for repository paths or file contents.',
  'You may ask at most one question. After its answer, make any remaining assumptions explicit and finish the brief.',
  'Never return an unanswered question as the brief. Otherwise take the reading a competent person would and mark the assumption.',
].join(' ');

/** A final refiner answer must be a brief, never a question accidentally sent downstream. */
export function unansweredRefinerQuestion(text: string): string | null {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const questions = lines.filter(line => /\?\s*$/.test(line));
  if (!questions.length) return null;
  return questions.slice(0, 3).join('\n').slice(0, 1200);
}

async function askRefinerQuestion(run: BlockRun, question: string): Promise<string> {
  const session = await run.ctx.sessions.open(run.runId);
  const callId = `${run.blockId}-clarification`;
  const args = {
    question,
    context: 'The prompt refiner cannot produce a final brief until this consequential ambiguity is answered.',
  };
  await session.append({ type: 'tool.call', data: {
    callId, blockId: run.blockId, name: 'ask_human', args, modelVisible: false,
  } });
  const result = await run.ctx.tools.execute({
    runId: run.runId, blockId: run.blockId, step: 1,
    call: { id: callId, name: 'ask_human', args }, ceiling: run.ceiling,
    ...(run.signal ? { signal: run.signal } : {}),
  });
  await session.append({
    type: 'tool.result',
    data: {
      callId, blockId: run.blockId, name: 'ask_human', content: result.content ?? '', modelVisible: false,
      ...(result.error ? { error: result.error } : {}),
    },
  });
  if (result.error) throw new Error(result.error);
  try { return String((JSON.parse(result.content ?? '{}') as { answer?: unknown }).answer ?? ''); }
  catch { return String(result.content ?? ''); }
}

async function deterministicRefinerFallback(run: BlockRun, reason: string): Promise<BlockOutcome> {
  const session = await run.ctx.sessions.open(run.runId);
  let answer = '';
  for await (const event of session.read()) {
    const data = event.data as Record<string, unknown>;
    if (event.type !== 'tool.result' || data.name !== 'ask_human' || !data.content) continue;
    try { answer = String((JSON.parse(String(data.content)) as { answer?: unknown }).answer ?? answer); }
    catch { /* the original request remains a valid brief */ }
  }
  const output = [
    '# Goal', run.input.trim(),
    answer ? `# User clarification\n${answer.trim()}` : '',
    '# Execution note',
    'The prompt refiner did not produce a usable final brief. Preserve the request as written, resolve repository references against the bound workspace, make only reversible assumptions, and state consequential assumptions in the result.',
  ].filter(Boolean).join('\n\n');
  await session.append({
    type: 'block.warning',
    data: { blockId: run.blockId, code: 'refiner_degraded', reason, content: 'Continuing with the original request.' },
  });
  return { status: 'done', output, structured: { brief: output } };
}

/** Questions about the refiner's role or repository transport are not user decisions. */
function guardRefinerQuestion(call: { name: string; args: JsonValue }): string | null {
  if (call.name !== 'ask_human') return null;
  const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
    ? call.args as Record<string, JsonValue> : {};
  const question = String(args.question ?? '');
  if (/(?:repository|workspace)\s+path|(?:paste|provide|send|share)\b[^?]{0,80}\bcontents?|file[- ]reading tool|(?:do not|don\'t) have (?:a )?(?:file[- ]?)?read tool|only (?:available )?tool/i.test(question)) {
    return 'The bound workspace reference and file access belong to downstream workers. Preserve the reference and produce the brief without asking the user for paths or contents.';
  }
  if (/should i\s+(?:refine|plan|execute)|do you want me to\s+(?:refine|plan|execute)|my role is to refine/i.test(question)) {
    return 'Whether to refine is not an ambiguity. Produce the downstream brief now.';
  }
  return null;
}

async function executePromptRefiner(run: BlockRun): Promise<BlockOutcome> {
  let first: BlockOutcome;
  try {
    first = await executeAiStep(run, PROMPT_REFINER_SYSTEM, { name: 'brief' }, {
      toolLimits: { ask_human: 1 }, toolGuard: guardRefinerQuestion, maxSteps: 4,
    });
  } catch (error) {
    return deterministicRefinerFallback(run, String((error as Error)?.message ?? error));
  }
  if (first.status !== 'done') return deterministicRefinerFallback(run, first.error ?? 'The refiner did not finish.');
  const question = unansweredRefinerQuestion(first.output);
  if (!question) return first;
  try {
    const answer = await askRefinerQuestion(run, question);
    const settled = await executeAiStep({
      ...run,
      input: `${run.input}\n\nCLARIFICATION FROM THE USER:\n${answer}\n\nReturn the final brief now. Do not ask another question.`,
    }, PROMPT_REFINER_SYSTEM, { name: 'brief' }, {
      turn: 2, toolLimits: { ask_human: 0 }, toolGuard: guardRefinerQuestion, maxSteps: 2,
    });
    return settled.status === 'done'
      ? settled : deterministicRefinerFallback(run, settled.error ?? 'The refiner did not finish after clarification.');
  } catch (error) {
    return deterministicRefinerFallback(run, String((error as Error)?.message ?? error));
  }
}

/** Cordis plugin name. */
export const name = 'flyt-blocks-judgement';

/** It contributes blocks, so it needs the registry. */
export const inject = ['blocks', 'sessions'];

const judge = (
  use: string, title: string, description: string, brief: string,
  output: { name: string; type?: 'string' | 'list' },
  ceiling: readonly string[] = [],
): BlockDefinition => ({
  use, title, description, category: 'judgement',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling,
  outputs: [{ name: output.name, type: output.type ?? 'string' }],
  execute: (run: BlockRun) => executeAiStep(run, brief, output),
});

export const evaluationBlock = judge(
  'flyt-blocks-judgement:evaluation', 'Evaluation',
  'Judge work against its plan or brief: pass, retry, or escalate, with the reason.',
  'Evaluate the work against the plan or brief it answers to. Return a verdict — pass, retry, or escalate — and say why. A pass that rests on nothing is a retry.',
  // The verdict an `If` predicate names (the plan's `gate.result` example).
  { name: 'verdict' },
);
export const compareBlock = judge(
  'flyt-blocks-judgement:compare', 'Compare',
  'Compare upstream alternatives: agreements, differences, strengths, and a keep-the-best recommendation.',
  'Compare the alternatives in front of you: where they agree, where they differ, each one’s strengths, and a keep-the-best recommendation. Say which you would keep and why.',
  { name: 'comparison' },
);
export const promptRefinerBlock = judge(
  'flyt-blocks-judgement:prompt-refiner', 'Prompt refiner',
  'Rewrite the request into a precise, self-contained brief (goal, constraints, deliverable, acceptance).',
  PROMPT_REFINER_SYSTEM,
  { name: 'brief' },
  ['ask_human'],
);

// The generic judgement constructor is intentionally simple. Refinement adds
// the human-interaction guard above so a prose question cannot become a brief.
promptRefinerBlock.execute = executePromptRefiner;

/**
 * A deterministic, optional human boundary. It spends no model call: the
 * upstream artifact is shown to the person and passed through unchanged only
 * after they approve it. This is particularly useful after a Free refiner,
 * where one cheap misunderstanding should not aim an expensive plan.
 */
export const humanCheckpointBlock: BlockDefinition = {
  use: 'flyt-blocks-judgement:human-checkpoint',
  title: 'Human checkpoint',
  description: 'Optionally pause after an upstream artifact and require a person to approve it before continuing.',
  category: 'utility',
  settings: {
    type: 'object', additionalProperties: false,
    properties: {
      enabled: {
        type: 'boolean', title: 'Require approval',
        description: 'When off, the artifact passes through without pausing.',
      },
    },
  } as unknown as JsonValue,
  ceiling: ['ask_human'],
  outputs: [{ name: 'approved', type: 'boolean' }],
  async execute(run: BlockRun) {
    if (run.config.enabled === false) {
      return { status: 'done', output: run.input, structured: { approved: true } };
    }
    const callId = `${run.blockId}-checkpoint`;
    const args = {
      question: 'Approve the refined request before the workflow spends more on planning?',
      options: ['Approve and continue', 'Stop this workflow'],
      context: run.input,
    };
    const session = await run.ctx.sessions.open(run.runId);
    await session.append({ type: 'tool.call', data: { callId, name: 'ask_human', args } });
    const result = await run.ctx.tools.execute({
      runId: run.runId, blockId: run.blockId, step: 1,
      call: { id: callId, name: 'ask_human', args },
      ceiling: run.ceiling,
      ...(run.signal ? { signal: run.signal } : {}),
    });
    await session.append({
      type: 'tool.result',
      data: { callId, name: 'ask_human', content: result.content ?? '', ...(result.error ? { error: result.error } : {}) },
    });
    if (result.error) return { status: 'failed', output: run.input, error: result.error };
    let answer = '';
    try { answer = String((JSON.parse(result.content ?? '{}') as { answer?: unknown }).answer ?? ''); }
    catch { answer = String(result.content ?? ''); }
    const approved = /^approve\b/i.test(answer.trim());
    return approved
      ? { status: 'done', output: run.input, structured: { approved: true } }
      : { status: 'failed', output: run.input, structured: { approved: false }, error: 'The refined request was not approved.' };
  },
};

/** Contribute the judgement blocks. */
export function apply(ctx: Context): void {
  ctx.blocks.register(evaluationBlock);
  ctx.blocks.register(compareBlock);
  ctx.blocks.register(promptRefinerBlock);
  ctx.blocks.register(humanCheckpointBlock);
}
