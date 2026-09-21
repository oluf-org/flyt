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
import { AI_STEP_SETTINGS, aiStepSettings, executeAiStep } from './blocks-aistep.js';
import { parseListOutput } from '../blocks/list-output.js';

/** Cordis plugin name. */
export const name = 'flyt-blocks-loop';

/** It contributes blocks, so it needs the registry. */
export const inject = ['blocks', 'sessions'];

/** Backlog-plan may read the project to confirm every path it names. */
const PLAN_CEILING = ['read_file', 'glob', 'search_files', 'search_references'] as const;

const BACKLOG_SYSTEM = [
    'Turn the analysis into claimable backlog tasks.',
    'Prefer three real tasks to ten plausible ones, and prefer tasks that land on their own — a queue where three tasks wait on one stops the moment that one stops.',
    'The blastRadius is the complete list of files the worker may WRITE, including new files the task must create. Inspect existing files and parent directories to ground paths, but do not omit a required new test or document just because it does not exist yet. Read-only context files are not write targets. Take gates from commands this project actually has.',
    'Every task must be claimable by someone standing here weeks from now who has not read the analysis.',
    'Return task objects with title, goal, doneWhen (string array), blastRadius (workspace paths), and optionally gates (existing shell commands), dependsOn (existing backlog ids), skills, value and effort (integers 1–5). Never invent a backlog id for a new task. No other fields.',
  ].join('\n');

export const backlogPlanBlock: BlockDefinition = {
  use: 'flyt-blocks-loop:backlog-plan',
  title: 'Backlog plan',
  description: 'Turn analysis into queued work: claimable backlog tasks a supervisor can pick up.',
  category: 'loop',
  settings: aiStepSettings(BACKLOG_SYSTEM) as unknown as JsonValue,
  ceiling: PLAN_CEILING,
  outputs: [{ name: 'tasks', type: 'list' }],
  execute: (run: BlockRun) => executeAiStep(run, BACKLOG_SYSTEM, { name: 'tasks', type: 'list' }),
};

/**
 * The Loop handoff. The durable boundary where a run hands its tasks to the
 * queue. What it carries upstream is the record; this block's job is to make
 * the handoff a place, not a convention.
 */
export const loopHandoffBlock: BlockDefinition = {
  use: 'flyt-blocks-loop:loop-handoff',
  title: 'Backlog handoff',
  description: 'Queue an explicit list of backlog tasks and return durable receipts. Does not start the Loop.',
  category: 'loop',
  settings: AI_STEP_SETTINGS as unknown as JsonValue,
  ceiling: ['queue_backlog_tasks'],
  outputs: [{ name: 'queued', type: 'list' }],
  async execute(run: BlockRun) {
    let tasks: JsonValue[];
    try {
      tasks = parseListOutput(run.input, 'tasks');
      if (tasks.some(task => !task || typeof task !== 'object' || Array.isArray(task))) throw new Error('Expected task objects with title and goal');
    } catch (error) {
      return { status: 'failed', output: '', structured: { queued: [] }, error: `No tasks were queued. ${String((error as Error).message)}` };
    }
    if (!tasks.length) return { status: 'done', output: '[]', structured: { queued: [] } };
    const session = await run.ctx.sessions.open(run.runId);
    const callId = `${run.blockId}-handoff`;
    const args = { tasks };
    await session.append({ type: 'tool.call', data: { callId, blockId: run.blockId, name: 'queue_backlog_tasks', args } });
    const result = await run.ctx.tools.execute({ runId: run.runId, blockId: run.blockId, step: 1,
      call: { id: callId, name: 'queue_backlog_tasks', args }, ceiling: run.ceiling,
      ...(run.signal ? { signal: run.signal } : {}),
    });
    await session.append({ type: 'tool.result', data: { callId, blockId: run.blockId, name: 'queue_backlog_tasks', content: result.content ?? '', ...(result.error ? { error: result.error } : {}) } });
    try {
      const value = result.durableResult ?? JSON.parse(result.content ?? '{}');
      const queued = value.queued ?? value.result?.queued;
      if (result.error) return { status: 'failed', output: result.content ?? '', structured: { queued: Array.isArray(queued) ? queued : [] }, error: result.error };
      if (!Array.isArray(queued) || queued.length !== tasks.length || queued.some(item => typeof item.id !== 'string')) throw new Error('Missing durable queue receipts');
      return { status: 'done', output: JSON.stringify(queued, null, 2), structured: { queued } };
    } catch (error) {
      return { status: 'failed', output: result.content ?? '', error: result.error ?? String((error as Error).message) };
    }
  },
};

/** Contribute the loop blocks. */
export function apply(ctx: Context): void {
  ctx.blocks.register(backlogPlanBlock);
  ctx.blocks.register(loopHandoffBlock);
}
