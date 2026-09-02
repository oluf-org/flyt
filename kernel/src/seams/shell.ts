/**
 * `ctx.shell` — screened command execution.
 *
 * The screen is not a sandbox and does not claim to be (GOALS). It is the
 * refusal a person can read: a command that is refused says which rule
 * refused it.
 *
 * @module #kernel/seams/shell
 */

import type { CapabilityExecution, ExecutionWorldDescriptor } from './execution-world.js';
import type { SandboxBackend, SandboxEnforcement, SandboxMode } from './sandbox.js';

/** What a command did. */
export interface ShellResult {
  /** Null when the process was killed before exiting. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the screen refused before anything ran. */
  refused?: string;
  /** True when the command hit its timeout. */
  timedOut?: boolean;
  signal?: string;
  errorCode?: 'SANDBOX_UNAVAILABLE' | 'SANDBOX_DENIED' | 'SANDBOX_RUNNER_FAILED' | 'SPAWN_FAILED';
  sandbox: {
    mode: SandboxMode;
    backend: SandboxBackend;
    enforcement: SandboxEnforcement;
    escalated: boolean;
  };
}

/** How to run one. */
export interface ShellOptions {
  execution: CapabilityExecution;
  /** Relative to the seam's confinement root. */
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

/** The seam. Provider: `flyt-shell-screened`. */
export interface ShellSeam {
  readonly world: ExecutionWorldDescriptor;
  run(command: string, options: ShellOptions): Promise<ShellResult>;
  /**
   * What the screen would say, without running anything.
   *
   * Exists so a surface can show the refusal before a person commits to the
   * command, and so a test can assert the screen without side effects.
   */
  screen(command: string): { allowed: boolean; reason?: string };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellSeam;
  }
}
