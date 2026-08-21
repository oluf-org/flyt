/**
 * `flyt-session-jsonl` — provides `ctx.sessions` over a directory of run logs.
 *
 * The default provider of the canonical record (D55). Swapping it for a
 * SQLite-backed one is a provider change and nothing else, which is the point
 * of the seam; the open question is only which default keeps the promise that
 * a run stays openable in a text editor.
 *
 * @module #kernel/plugins/session-jsonl
 */
import type { Context } from '@deepseek-ai/cordis';
import { provideSeam } from '../seams/index.js';
import { JsonlSessionStore } from '../session/jsonl.js';

/** Where the logs live. */
export interface SessionJsonlConfig {
  /** The runs directory, e.g. `<project>/runs`. */
  root: string;
}

/** Cordis plugin name. */
export const name = 'flyt-session-jsonl';

/**
 * Provide `ctx.sessions`, and republish every append as `session/append` so a
 * trace surface subscribes to events instead of polling files.
 *
 * @param ctx — the context to provide in.
 * @param config — the runs directory.
 * @returns a disposer withdrawing the seam.
 */
export function apply(ctx: Context, config: SessionJsonlConfig): () => void {
  if (!config?.root) throw new Error('flyt-session-jsonl needs a root');
  const store = new JsonlSessionStore(config.root);

  const announcing: typeof store = Object.create(store);
  announcing.open = async (runId: string) => {
    const session = await store.open(runId);
    const append = session.append.bind(session);
    session.append = async event => {
      const written = await append(event);
      ctx.emit('session/append', runId, written);
      return written;
    };
    return session;
  };

  return provideSeam(ctx, 'sessions', announcing);
}
