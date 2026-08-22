/**
 * `flyt-run-projection` — the run folder, written beside the log as the run goes.
 *
 * The log is the record and the folder is a projection of it (D55). Which
 * raises the question of WHEN, and the answer is: at durable boundaries, while
 * the run is still going. A folder materialised only at the end is a folder
 * that does not exist for the whole stretch somebody is watching the run — and
 * "open the run folder" is what a person does when something looks wrong.
 *
 * A plugin listening to `session/append`, rather than something the scheduler
 * calls. Two reasons, and the second is the load-bearing one:
 *
 * - the scheduler is not the only writer, and a projection that only covers
 *   what the scheduler wrote is not a projection of the log;
 * - it keeps the FILESYSTEM out of `ctx.sessions`. The seam is meant to be
 *   swappable for a SQLite provider, and a `dirFor(runId)` on it would make
 *   that swap a lie.
 *
 * The projection is recomputed from the whole log each time rather than
 * updated incrementally. That is O(n) per boundary on a file that is small, and
 * it buys the property the task actually asks for: the folder is a pure
 * function of the log, so deleting it and rebuilding cannot produce anything
 * different. An incremental writer would be a second implementation of
 * `projectRun`, and the two would drift.
 *
 * @module #kernel/plugins/run-projection
 */
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '../seams/sessions.js';
import { materialise, projectRun } from '../session/projection.js';

/** Where the run folders live — the same root the session store uses. */
export interface RunProjectionConfig {
  /** The runs directory, e.g. `<project>/runs`. */
  root: string;
}

/** Cordis plugin name. */
export const name = 'flyt-run-projection';

/** It reads the log back to project it. */
export const inject = ['sessions'];

/**
 * Event types after which the folder is worth rewriting.
 *
 * Not every append: a busy step appends a request, a response and several tool
 * results in a second, and rewriting the folder for each is a lot of syscalls
 * for a reader who cannot type that fast. These are the moments something a
 * person would look for became true.
 */
export const PROJECT_AFTER = new Set([
  'run.created',
  'run.stage',
  'run.error',
  'stack.resolved',
  'block.status',
  'block.output',
  'tool.result',
  'turn.end',
]);

/**
 * Materialise the run folder beside the log, at durable boundaries.
 *
 * @param ctx — the context to listen in.
 * @param config — the runs directory.
 * @returns a disposer removing the listener.
 */
export function apply(ctx: Context, config: RunProjectionConfig): () => void {
  if (!config?.root) throw new Error('flyt-run-projection needs a root');

  // One projection at a time per run, and one queued behind it. A boundary that
  // arrives while a write is in flight must not be lost, and it must not queue
  // a third: what matters is that the folder ends up reflecting the log, not
  // that every intermediate state was written.
  const busy = new Map<string, { running: boolean; again: boolean }>();

  const write = async (runId: string): Promise<void> => {
    const state = busy.get(runId) ?? { running: false, again: false };
    busy.set(runId, state);
    if (state.running) { state.again = true; return; }
    state.running = true;
    try {
      do {
        state.again = false;
        const session = await ctx.sessions.read(runId);
        const events: SessionEvent[] = [];
        for await (const event of session.read()) events.push(event);
        materialise(path.join(config.root, runId), projectRun(events, runId));
      } while (state.again);
    } catch {
      // A projection that cannot be written is not a run that failed. The log
      // is the record; this folder is a convenience, and taking a run down
      // because a convenience could not be written would be the tail wagging
      // the dog.
    } finally {
      state.running = false;
    }
  };

  return ctx.on('session/append', (runId: string, event: { type: string }) => {
    if (!PROJECT_AFTER.has(event?.type)) return;
    void write(runId);
  });
}
