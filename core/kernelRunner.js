// The Loop's bridge to the production kernel StackRunner (t-0117).
//
// The supervisor used to reach the compatibility runner through `flow:run`.
// The kernel already ships everything the compat runner was a stand-in for —
// `ctx.agents` (stack-runner), the JSONL session log, the run-folder
// projection, the fs/tools/llm/approvals seams — so this module is the one
// place that wires a PROJECT to a booted `flyt-loop-worker` kernel and hands
// runs to it.
//
// Deliberate properties:
//
// - One kernel per (projectId, workspaceDir), memoized and shared. A kernel
//   holds the session store and the run projection for the project's runs
//   root; a second one would double every write.
// - `startStackRun` is durable-first, matching `StackRunner.start`: it
//   returns as soon as `run.created` is in the log, and `run.settled()` is
//   what actually finishes. That is what keeps a heartbeat able to read a
//   run that is still going.
// - The fs seam is confined to the task worktree. The supervisor built the
//   isolation; handing the kernel the main checkout would bypass it.
//
// This module never loads the kernel itself: `bootKernel` keeps the import
// dynamic so a headless `flyt task ready` does not pay for the tree.

import { bootKernel } from './v2.js';

/**
 * Boot (or reuse) the `flyt-loop-worker` kernel for one project + worktree.
 *
 * @param {object} deps
 * @param {string} deps.runsRoot — the project's runs directory (session logs).
 * @param {string} deps.workspaceDir — the task worktree; the fs seam's root.
 * @param {string} [deps.approvalMode] — how this surface approves ('always' for the loop).
 * @param {Function} [deps.load] — kernel importer, injectable for tests.
 * @returns {Promise<{ kernel: object, ctx: object, dispose: Function }>}
 */
export async function bootLoopKernel({ runsRoot, workspaceDir, approvalMode = 'always', load } = {}) {
  const booted = await bootKernel({
    call: true, // the supervisor asked for this run; the flag's default already says yes
    profile: 'flyt-loop-worker',
    runsRoot,
    approvalMode,
    ...(load ? { load } : {}),
  });
  if (!booted) throw new Error('The v2 kernel is off, so a loop task cannot run through the kernel.');
  return booted;
}

/**
 * Start a stack through the kernel and return a handle the supervisor can
 * supervise with the same verbs it used on the compat runner.
 *
 * @param {object} deps
 * @param {object} deps.ctx — the booted kernel context.
 * @param {string} deps.stackId — e.g. 'loop-task'.
 * @param {string} deps.input — the brief.
 * @param {string} [deps.runId] — a fixed run id; defaults to one the store makes.
 * @returns {Promise<{ runId: string, run: object }>}
 */
export async function startStackRun({ ctx, stackId, input, runId = null } = {}) {
  if (!ctx?.agents) {
    const err = new Error('The kernel has no agents seam — the stack-runner plugin did not install.');
    err.code = 'kernel_unavailable';
    throw err;
  }
  const ref = runId ? { id: stackId, runId } : { id: stackId };
  const run = await ctx.agents.start(ref, String(input ?? ''));
  return { runId: run.runId, run };
}

/**
 * A stop that mirrors the compat runner's `stop(runId)` contract closely
 * enough for the supervisor's ladder: cooperative, idempotent, and never
 * cancelling a block mid-write.
 *
 * @param {object} ctx — the booted kernel context.
 * @param {string} runId
 * @returns {Promise<{ ok: boolean, error?: string, message?: string }>}
 */
export async function stopStackRun(ctx, runId) {
  if (!ctx?.agents) return { ok: false, error: 'kernel-unavailable', message: 'No agents seam.' };
  try {
    await ctx.agents.stop(runId, 'stopped by request');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'stop-failed', message: String(err?.message ?? err) };
  }
}
