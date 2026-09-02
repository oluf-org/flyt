import type { ExecutionWorldDescriptor } from '../seams/execution-world.js';
import { createFsSeam, type FsSeam } from '../seams/fs.js';
import type { SandboxBackend, SandboxEnforcement, SandboxMode } from '../seams/sandbox.js';
import { capabilityRequest, type SandboxPolicySeam } from './sandbox-policy.js';

export interface SandboxEventSink {
  (runId: string, event: { type: string; data: Record<string, unknown> }): Promise<void> | void;
}

export function createSandboxedFs(
  world: ExecutionWorldDescriptor,
  policy: SandboxPolicySeam,
  event?: SandboxEventSink,
): FsSeam {
  return createFsSeam(world.hostRoot, {
    world,
    resolveMutation: execution => policy.resolve(capabilityRequest(execution)),
    async onDecision(execution, mode, escalated) {
      const facts = factsFor(world, mode);
      await event?.(execution.owner.runId, { type: 'sandbox.decision', data: {
        callId: execution.owner.callId, tool: execution.tool,
        standingMode: policy.describe().mode, ...(execution.requestedMode ? { requestedMode: execution.requestedMode } : {}),
        effectiveMode: mode, ...facts, escalated,
      } });
    },
    async onFailure(execution, _code, mode) {
      await event?.(execution.owner.runId, { type: 'sandbox.failure', data: {
        callId: execution.owner.callId, tool: execution.tool, code: 'SANDBOX_DENIED', mode,
        backend: world.sandbox.backend,
      } });
    },
  });
}

function factsFor(world: ExecutionWorldDescriptor, mode: SandboxMode): { backend: SandboxBackend; enforcement: SandboxEnforcement } {
  return mode === 'danger-full-access'
    ? { backend: 'unconfined', enforcement: 'none' }
    : { backend: world.sandbox.backend, enforcement: world.sandbox.enforcement };
}
