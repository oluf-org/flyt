/**
 * `flyt-blocks-loop` — the blocks that turn analysis into queued work.
 *
 * Backlog-plan reads what was learned and proposes claimable backlog tasks;
 * the Loop handoff block is the durable boundary where a run hands those tasks
 * to the queue a supervisor claims. Backlog-plan reads the project to ground
 * every `blastRadius` path, so it names a read ceiling (D57) and can write
 * nothing itself — queueing is the handoff's job, not the planner's.
 *
 * @module #kernel/plugins/blocks-loop
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { BlockDefinition, BlockRun } from '../blocks/types.js';
import { AI_STEP_SETTINGS, executeAiStep } from './blocks-aistep.js';

/** Cordis plugin name. */
export const name = 'flyt-blocks-loop';

/** It contributes blocks, so it needs the registry. */
export const inject = ['blocks', 'sessions'];

/** Backlog-plan may read the project to confirm every path it names. */
const PLAN_CEILING = ['read_file', 'glob', 'search_files', 'search_references'] as const;

export const backlogPlanBlock: BlockDefinition = {
  use: 'flyt-blocks-loop:backlog-plan',
  title: 'Backlog plan',
  description: 'Turn analysis into queued work: claimable backlog tasks a supervisor can pick up.',
  category: 'loop',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: PLAN_CEILING,
  execute: (run: BlockRun) => executeAiStep(run, [
    'Turn the analysis into claimable backlog tasks.',
    'Prefer three real tasks to ten plausible ones, and prefer tasks that land on their own — a queue where three tasks wait on one stops the moment that one stops.',
    'Confirm every path you put in a blast radius against this workspace, and take gates from the commands this project actually has.',
    'Every task must be claimable by someone standing here weeks from now who has not read the analysis.',
  ].join('\n')),
};

/**
 * The Loop handoff. The durable boundary where a run hands its tasks to the
 * queue. What it carries upstream is the record; this block's job is to make
 * the handoff a place, not a convention.
 */
export const loopHandoffBlock: BlockDefinition = {
  use: 'flyt-blocks-loop:loop-handoff',
  title: 'Loop handoff',
  description: 'Hand the planned tasks to the queue the supervisor claims from.',
  category: 'loop',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: [],
  execute: (run: BlockRun) => executeAiStep(run,
    'Hand the planned tasks to the loop queue: emit them as the queue accepts them, and say what was queued. Nothing else is this block’s to do.'),
};

/** Contribute the loop blocks. */
export function apply(ctx: Context): void {
  ctx.blocks.register(backlogPlanBlock);
  ctx.blocks.register(loopHandoffBlock);
}
