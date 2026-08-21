/**
 * `ctx.fs` — confined file access.
 *
 * The seam is why worktree isolation stops being a special case threaded
 * through the runner and becomes a provider: a block running in a worktree
 * gets a different `ctx.fs`, not a runner that remembers to check.
 *
 * Every path is relative to `root`. A path that escapes it is refused, and
 * refusal is an error, never a silently clamped path.
 *
 * @module #kernel/seams/fs
 */

/** One directory entry. */
export interface FsEntry {
  /** Relative to `root`, with forward slashes on every platform. */
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

/** The seam. Providers: `flyt-fs-workspace`, `flyt-fs-worktree`. */
export interface FsSeam {
  /** The confinement boundary, for diagnostics. Not a licence to bypass the seam. */
  readonly root: string;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** True when the path exists inside the root. False — never a throw — when it does not. */
  exists(path: string): Promise<boolean>;
  list(path?: string): Promise<FsEntry[]>;
  remove(path: string): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FsSeam;
  }
}
