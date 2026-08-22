/**
 * `flyt-blocks-core` — the block a stack cannot do without.
 *
 * One block for now, and it is `work`: read the repository, change it, verify
 * with the project's own gates. Everything else the v1 library holds is Phase 2
 * (`t-0037`); this exists because the handoff test needs `loop-task` to run,
 * and `loop-task` is one work block (D45).
 *
 * The block does not implement an agent loop. It calls `runAgentLoop`, which
 * every block shares, so "model-visible means logged" holds for this block the
 * same way it holds for one a third party writes — because it is not this
 * block's job to remember.
 *
 * What IS this block's job is stating its contract: the ceiling it may ever
 * reach, the settings it accepts, and the fact that its deliverable is a change
 * to the workspace rather than a description of one. That last part is why
 * `loop-task` exists at all: the pipeline it replaced could report `done`
 * having touched no file.
 *
 * @module #kernel/plugins/blocks-core
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { BlockDefinition, BlockOutcome, BlockRun } from '../blocks/types.js';
import { MAX_STEPS, runAgentLoop } from '../blocks/run.js';

/** Cordis plugin name. */
export const name = 'flyt-blocks-core';

/** It contributes blocks, so it needs the registry. */
export const inject = ['blocks', 'sessions'];

/**
 * The tools an unattended worker gets (D45).
 *
 * The repository, the shell, the queue it lives in, the run that failed last
 * time, and a way to ask a human. Not the web: a task that genuinely needs it
 * asks for it, and a worker that can reach the network unasked is a worker
 * whose inputs nobody has reviewed.
 *
 * A CEILING, not a grant. What this block may ever reach; whether it reaches it
 * is still the run's ceiling intersected with this one (D57).
 */
export const LOOP_CEILING = [
  'read_file', 'glob', 'search_files', 'search_references', 'read_tool_result',
  'list_tasks', 'read_task', 'why_blocked', 'read_run',
  'create_file', 'write_file', 'edit_file',
  'create_task', 'enqueue_task', 'write_task_md', 'update_task',
  'ask_human', 'bash', 'run_gate',
] as const;

/** What the work block is told before the task's own brief. */
export const WORK_SYSTEM = [
  'You are working one task, alone and unattended.',
  '',
  'Read before you write. The acceptance criteria are the contract — not a summary of it,',
  'and not a starting point to improve on. Meet them and stop. Work outside the task’s blast',
  'radius is how an unattended change becomes unreviewable.',
  '',
  'Verify with the project’s own gates, yourself, before you finish. You have run_gate, and',
  'the harness runs the same commands afterwards while a reviewer reads the diff. Finding a',
  'failure now costs one more turn; finding it after landing costs the task.',
  '',
  'Your tool calls are bounded, and READING is what runs out first. Every call resends the',
  'whole conversation, so forty small reads cost far more than their contents. Read a file',
  'once with read_file and a pattern once with search_files — not a series of narrowing',
  'bash ranges over something you have already opened. Stop reading at the point where you',
  'can name the change you are about to make, and make it. A run that explores until its',
  'budget is gone has produced nothing, however well it understood the code.',
  '',
  'Leave nothing behind. Everything in the workspace when you stop becomes the diff a',
  'reviewer reads — a scratch script, an output file, an empty file from a mistyped',
  'redirect. Each one is outside the blast radius and a reviewer is right to reject it.',
  '',
  'Two honest failures beat one confident sentence: if a gate is red, say which and why',
  'rather than reporting success.',
].join('\n');

/** The `work` block's settings. Everything optional; the defaults are the loop's. */
export const WORK_SETTINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', description: 'The model to ask for. Routing is the seam’s business.' },
    instructions: { type: 'string', description: 'Appended to the standing instructions above.' },
    maxSteps: { type: 'integer', minimum: 1, description: 'Tool rounds before it must answer.' },
    effect: {
      enum: ['workspace-change', 'artifact', 'none'],
      description: 'What this block owes. `workspace-change` fails where the work was, rather than looking finished until it is judged.',
    },
  },
} as const;

const str = (value: JsonValue | undefined, fallback = ''): string =>
  (typeof value === 'string' && value ? value : fallback);

/**
 * Run one work block.
 *
 * @param run — the block's execution context.
 * @returns what it produced, and why it stopped.
 */
export async function executeWork(run: BlockRun): Promise<BlockOutcome> {
  const session = await run.ctx.sessions.open(run.runId);
  const instructions = str(run.config.instructions);
  const tools = run.ctx.tools.list().filter(t => run.ceiling.includes(t.name));

  const result = await runAgentLoop({
    ctx: run.ctx,
    session,
    runId: run.runId,
    blockId: run.blockId,
    // One turn per block for now. A block that needs several is a container,
    // and containers are Phase 3.
    turn: 1,
    model: str(run.config.model, 'openrouter/auto'),
    system: instructions ? `${WORK_SYSTEM}\n\n${instructions}` : WORK_SYSTEM,
    input: run.input,
    tools,
    ceiling: run.ceiling,
    maxSteps: typeof run.config.maxSteps === 'number' ? run.config.maxSteps : MAX_STEPS,
    ...(run.signal ? { signal: run.signal } : {}),
  });

  // A loop that ran out of steps did not finish, and saying `done` here is how
  // an attempt that stopped mid-thought reaches a reviewer looking complete.
  if (result.stopped !== 'answered') {
    return { status: 'failed', output: result.content, error: result.reason ?? result.stopped };
  }
  return { status: 'done', output: result.content };
}

/** The definition, exported so a test can hold the contract without booting a kernel. */
export const workBlock: BlockDefinition = {
  use: 'flyt-blocks-core:work',
  title: 'Work',
  description: 'Read the repository, change it, and verify with the project’s own gates.',
  category: 'work',
  settings: WORK_SETTINGS as unknown as JsonValue,
  ceiling: LOOP_CEILING,
  execute: executeWork,
};

/**
 * Contribute the core blocks.
 *
 * @param ctx — the context to register in.
 */
export function apply(ctx: Context): void {
  ctx.blocks.register(workBlock);
}
