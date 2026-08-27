/**
 * `flyt-fs` — provides `ctx.fs` confined to a workspace root.
 *
 * The seam is why worktree isolation stops being a special case threaded
 * through the runner and becomes a provider: a block running in a worktree
 * gets a different `ctx.fs`, not a runner that remembers to check.
 *
 * Every read and write goes through the single text interpretation in
 * `../seams/textFile.ts` (ported from `core/tools/textFile.js`). Providers
 * `flyt-fs-workspace` and `flyt-fs-worktree` are the same code with different
 * roots; the boundary is the root, not the implementation.
 *
 * @module #kernel/plugins/fs
 */
import type { Context } from '@deepseek-ai/cordis';
import { provideSeam } from '../seams/index.js';
import { createFsSeam } from '../seams/fs.js';

export interface FsConfig {
  /** Directory the seam is confined to. */
  root: string;
}

export const name = 'flyt-fs';

export function apply(ctx: Context, config: FsConfig): () => void {
  if (!config?.root) throw new Error('flyt-fs needs a root');
  return provideSeam(ctx, 'fs', createFsSeam(config.root));
}

// Alias providers expected by the seam docs — same implementation, distinct names.
export const workspaceName = 'flyt-fs-workspace';
export const worktreeName = 'flyt-fs-worktree';
