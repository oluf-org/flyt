/** `ctx.sandbox` confines exact argv in the current execution world. */
import type { ExecutionWorldDescriptor } from './execution-world.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;
export type SandboxEnforcement = 'full' | 'partial' | 'none';
export type SandboxBackend = 'bubblewrap' | 'seatbelt' | 'windows-restricted-token' | 'unconfined';

export interface ProcessOwner { runId: string; callId: string }

export interface SandboxExecutionPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
  owner: ProcessOwner;
  privateTemp: string;
  minimumEnforcement: Exclude<SandboxEnforcement, 'none'>;
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: ConfinedSandboxMode;
}

export interface RunnerFailureRule {
  readonly exitCodes: readonly number[];
  readonly stderrSignature: string;
  readonly stripLines?: readonly string[];
}

export interface ConfinedArgv {
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  backend: Exclude<SandboxBackend, 'unconfined'>;
  enforcement: Exclude<SandboxEnforcement, 'none'>;
  runnerFailure: RunnerFailureRule;
}

export interface SandboxProbe {
  platform: NodeJS.Platform;
  backend: SandboxBackend | null;
  available: boolean;
  enforcement: SandboxEnforcement | null;
  checkedAt: string;
  reason?: string;
}

export interface SandboxSeam {
  readonly world: ExecutionWorldDescriptor;
  probe(force?: boolean): Promise<SandboxProbe>;
  confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv>;
  disposeOwner(runId: string): Promise<void>;
}

export class SandboxUnavailableError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE';
  constructor(message: string, readonly probe?: SandboxProbe) { super(message); this.name = 'SandboxUnavailableError'; }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandbox: SandboxSeam;
  }
}
