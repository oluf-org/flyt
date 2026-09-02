import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityExecution, ExecutionWorldDescriptor } from '../seams/execution-world.js';
import type { SandboxExecutionPolicy, SandboxMode } from '../seams/sandbox.js';

export interface SandboxPolicyConfig {
  mode: SandboxMode;
  workspaceRoot: string;
  minimumEnforcement: 'full' | 'partial';
  allowAttendedEscalation: boolean;
}

export interface SandboxPolicyRequest {
  runId: string;
  callId: string;
  tool: string;
  requestedMode?: SandboxMode;
  justification?: string;
  attended: boolean;
}

export interface ResolvedSandboxPolicy extends SandboxExecutionPolicy {
  standingMode: SandboxMode;
  escalated: boolean;
}

export interface SandboxPolicySeam {
  readonly world: ExecutionWorldDescriptor;
  resolve(request: SandboxPolicyRequest): Promise<ResolvedSandboxPolicy>;
  describe(): Readonly<SandboxPolicyConfig>;
  disposeOwner(runId: string): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicySeam;
  }
}

export interface SandboxPolicyHooks {
  approve?: (request: SandboxPolicyRequest & { from: SandboxMode; to: SandboxMode }) => Promise<'allowed-once' | 'rejected' | 'cancelled'>;
  event?: (runId: string, event: { type: string; data: Record<string, unknown> }) => Promise<void> | void;
}

const rank: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

export function capabilityRequest(execution: CapabilityExecution): SandboxPolicyRequest {
  return {
    runId: execution.owner.runId,
    callId: execution.owner.callId,
    tool: execution.tool,
    attended: execution.attended,
    ...(execution.requestedMode ? { requestedMode: execution.requestedMode } : {}),
    ...(execution.justification ? { justification: execution.justification } : {}),
  };
}

export function createSandboxPolicy(
  config: SandboxPolicyConfig,
  world: ExecutionWorldDescriptor,
  runsTempRoot: string,
  hooks: SandboxPolicyHooks = {},
): SandboxPolicySeam {
  const canonicalRoot = fs.realpathSync(path.resolve(config.workspaceRoot));
  const normalized = Object.freeze({ ...config, workspaceRoot: canonicalRoot });
  const used = new Set<string>();
  const dirs = new Map<string, Set<string>>();

  return {
    world,
    describe: () => normalized,
    async resolve(request) {
      const requested = request.requestedMode ?? normalized.mode;
      const key = `${request.runId}\0${request.callId}`;
      if (used.has(key)) throw Object.assign(new Error('This sandbox escalation was already consumed.'), { code: 'SANDBOX_ESCALATION_REUSED' });
      let effective = requested;
      let escalated = false;
      if (rank[requested] > rank[normalized.mode]) {
        const invalid = !request.justification?.trim() || !request.attended || !normalized.allowAttendedEscalation;
        if (invalid) {
          await hooks.event?.(request.runId, { type: 'sandbox.escalation', data: {
            callId: request.callId, tool: request.tool, from: normalized.mode, to: requested,
            outcome: 'invalid', justification: bounded(request.justification),
          } });
          throw Object.assign(new Error(`Sandbox escalation from ${normalized.mode} to ${requested} is not available for this call.`), { code: 'SANDBOX_ESCALATION_DENIED' });
        }
        const outcome = await hooks.approve?.({ ...request, from: normalized.mode, to: requested }) ?? 'rejected';
        await hooks.event?.(request.runId, { type: 'sandbox.escalation', data: {
          callId: request.callId, tool: request.tool, from: normalized.mode, to: requested,
          outcome, justification: bounded(request.justification),
        } });
        if (outcome !== 'allowed-once') {
          throw Object.assign(new Error(`Sandbox escalation was ${outcome}.`), { code: 'SANDBOX_ESCALATION_DENIED' });
        }
        used.add(key);
        escalated = true;
      } else if (request.requestedMode && rank[requested] === rank[normalized.mode]) {
        throw Object.assign(new Error('sandbox_permissions must request a strictly wider mode.'), { code: 'SANDBOX_ESCALATION_INVALID' });
      }
      const privateTemp = path.join(runsTempRoot, safe(request.runId), safe(request.callId));
      if (effective === 'workspace-write') fs.mkdirSync(privateTemp, { recursive: true, mode: 0o700 });
      const owned = dirs.get(request.runId) ?? new Set<string>();
      owned.add(privateTemp); dirs.set(request.runId, owned);
      return {
        mode: effective, standingMode: normalized.mode, workspaceRoot: canonicalRoot,
        owner: { runId: request.runId, callId: request.callId }, privateTemp,
        minimumEnforcement: normalized.minimumEnforcement, escalated,
      };
    },
    async disposeOwner(runId: string) {
      for (const dir of dirs.get(runId) ?? []) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      dirs.delete(runId);
    },
  };
}

const safe = (value: string): string => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || '_';
const bounded = (value?: string): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
