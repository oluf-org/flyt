import type { SandboxBackend, SandboxEnforcement, SandboxMode } from './sandbox.js';

/** Immutable identity shared by every capability in one execution world. */
export interface ExecutionWorldDescriptor {
  readonly id: string;
  readonly provider: 'local';
  readonly workspaceId: string;
  /** Local-only diagnostic path. Never serialize this for a remote provider. */
  readonly hostRoot: string;
  readonly processRoot: string;
  readonly platform: NodeJS.Platform;
  readonly sandbox: {
    readonly standingMode: SandboxMode;
    readonly backend: SandboxBackend;
    readonly enforcement: SandboxEnforcement;
    readonly network: 'ambient';
  };
}

export interface CapabilityExecution {
  readonly owner: { runId: string; callId: string };
  readonly tool: string;
  readonly attended: boolean;
  readonly requestedMode?: SandboxMode;
  readonly justification?: string;
  readonly signal?: AbortSignal;
}
