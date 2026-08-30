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
import type { BlockDefinition, BlockRun } from '../blocks/types.js';
import { AI_STEP_SETTINGS, executeAiStep } from './blocks-aistep.js';

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
  'Rewrite the request into a precise, self-contained brief: goal, constraints, deliverable, acceptance. Ask a clarifying question only when an ambiguity would materially change the work; otherwise take the reading a competent person would and mark it.',
  { name: 'brief' },
  ['ask_human'],
);

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
