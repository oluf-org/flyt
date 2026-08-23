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
): BlockDefinition => ({
  use, title, description, category: 'judgement',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: [],
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
);

/** Contribute the judgement blocks. */
export function apply(ctx: Context): void {
  ctx.blocks.register(evaluationBlock);
  ctx.blocks.register(compareBlock);
  ctx.blocks.register(promptRefinerBlock);
}
