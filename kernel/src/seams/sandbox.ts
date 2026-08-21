/**
 * `ctx.sandbox` — a bounded realm for work that must not touch the workspace.
 *
 * New, and deliberately small. Flyt does not claim production-grade process
 * sandboxing (GOALS); a realm is an isolation *boundary with an owner and an
 * end*, so that unattended work has somewhere to go that is cleaned up whether
 * or not it succeeded.
 *
 * @module #kernel/seams/sandbox
 */
import type { FsSeam } from './fs.js';
import type { ShellSeam } from './shell.js';

/** One bounded realm. */
export interface Realm {
  readonly id: string;
  /** File access confined to this realm. */
  readonly fs: FsSeam;
  /** Command execution inside it, still screened. */
  readonly shell: ShellSeam;
  /**
   * Destroy it.
   *
   * Idempotent, and safe to call on a realm whose creator died: an orphaned
   * realm that nobody can dispose is the failure this seam exists to prevent.
   */
  dispose(): Promise<void>;
}

/** How to make one. */
export interface RealmOptions {
  /** What it is for, shown in diagnostics and in the orphan report. */
  purpose: string;
  /** A git worktree of this ref, rather than an empty directory. */
  worktreeOf?: string;
}

/** The seam. Provider: `flyt-worktree-realm`. */
export interface SandboxSeam {
  create(options: RealmOptions): Promise<Realm>;
  /** Every realm this store knows of, including ones whose creator is gone. */
  list(): Promise<{ id: string; purpose: string; createdAt: string; orphaned: boolean }[]>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandbox: SandboxSeam;
  }
}
