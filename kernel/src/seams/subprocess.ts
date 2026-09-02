import type { ExecutionWorldDescriptor } from './execution-world.js';
import type { ProcessOwner, RunnerFailureRule } from './sandbox.js';

export interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  runnerFailed?: { code: 'SANDBOX_RUNNER_FAILED'; detail: string };
}

export interface CollectedStream {
  text: string;
  truncated: boolean;
  bytesSeen: number;
  spillPath?: string;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly owner: ProcessOwner;
  readonly stdout: CollectedStream;
  readonly stderr: CollectedStream;
  readonly done: Promise<ProcessOutcome>;
  terminate(reason?: string): Promise<void>;
  waitForExit(): Promise<void>;
}

export interface SpawnSpec {
  owner: ProcessOwner;
  argv: readonly [string, ...string[]];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin?: string | Uint8Array;
  stdout: { maxBytes: number; spillMaxBytes?: number };
  stderr: { maxBytes: number; spillMaxBytes?: number };
  timeoutMs: number;
  graceMs: number;
  signal?: AbortSignal;
  runnerFailure?: RunnerFailureRule;
}

export interface SubprocessSeam {
  readonly world: ExecutionWorldDescriptor;
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>): Promise<string>;
  spawn(spec: SpawnSpec): ProcessHandle;
  terminateOwner(runId: string, reason?: string): Promise<void>;
  active(runId?: string): readonly { owner: ProcessOwner; pid: number }[];
  dispose(): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessSeam;
  }
}
