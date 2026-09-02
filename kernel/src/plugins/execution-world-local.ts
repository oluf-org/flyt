import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { provideSeam } from '../seams/index.js';
import type { ExecutionWorldDescriptor } from '../seams/execution-world.js';
import { SandboxUnavailableError, type SandboxMode } from '../seams/sandbox.js';
import { defaultSandboxFacts, createLocalSandbox, type LocalSandboxOptions } from './sandbox-local.js';
import { createLocalSubprocess } from './subprocess-local.js';
import { createSandboxPolicy, type SandboxPolicyHooks } from './sandbox-policy.js';
import { createSandboxedFs, type SandboxEventSink } from './fs-sandbox.js';
import { createScreenedShell } from './shell-screened.js';

export interface LocalExecutionWorldConfig extends LocalSandboxOptions {
  workspaceRoot: string;
  mode: SandboxMode;
  minimumEnforcement: 'full' | 'partial';
  allowAttendedEscalation: boolean;
  forwardedEnv?: readonly string[];
  runsTempRoot: string;
  approveEscalation?: SandboxPolicyHooks['approve'];
}

export const name = 'flyt-execution-world-local';
export const inject = ['sessions'];

export async function createLocalExecutionWorld(config: LocalExecutionWorldConfig, event?: SandboxEventSink) {
  if (!config?.workspaceRoot || !config?.runsTempRoot) throw new Error('Local execution world needs workspaceRoot and runsTempRoot.');
  const hostRoot = fs.realpathSync(path.resolve(config.workspaceRoot));
  const workspaceId = crypto.createHash('sha256').update(process.platform).update('\0').update(hostRoot).digest('hex').slice(0, 24);
  const facts = config.mode === 'danger-full-access' ? { backend: 'unconfined' as const, enforcement: 'none' as const } : defaultSandboxFacts();
  if (facts.enforcement === 'none' && config.mode !== 'danger-full-access') {
    const probe = { platform: process.platform, backend: null, available: false, enforcement: null,
      checkedAt: new Date().toISOString(), reason: `There is no confined sandbox backend for ${process.platform}.` } as const;
    throw new SandboxUnavailableError(probe.reason, probe);
  }
  const world: ExecutionWorldDescriptor = Object.freeze({
    id: `local:${workspaceId}:${config.mode}:${config.minimumEnforcement}`,
    provider: 'local', workspaceId, hostRoot, processRoot: hostRoot, platform: process.platform,
    sandbox: Object.freeze({ standingMode: config.mode, backend: facts.backend, enforcement: facts.enforcement, network: 'ambient' }),
  });
  const providerTemp = path.join(config.runsTempRoot, `.execution-world-${workspaceId}`);
  fs.mkdirSync(providerTemp, { recursive: true, mode: 0o700 });
  const subprocess = createLocalSubprocess(world, path.join(providerTemp, 'processes'));
  const sandbox = createLocalSandbox(world, subprocess, path.join(providerTemp, 'probes'), config);
  fs.mkdirSync(path.join(providerTemp, 'probes'), { recursive: true, mode: 0o700 });
  if (config.mode !== 'danger-full-access') {
    const probe = await sandbox.probe();
    if (!probe.available) {
      await subprocess.dispose();
      throw Object.assign(new Error(`Sandbox unavailable: ${probe.reason ?? 'functional probe failed'}`), { code: 'SANDBOX_UNAVAILABLE', probe });
    }
    const enough = config.minimumEnforcement === 'partial' || probe.enforcement === 'full';
    if (!enough) {
      await subprocess.dispose();
      throw Object.assign(new Error(`Sandbox enforcement ${probe.enforcement} is weaker than required ${config.minimumEnforcement}.`), { code: 'SANDBOX_UNAVAILABLE', probe });
    }
  }
  const policy = createSandboxPolicy({
    mode: config.mode, workspaceRoot: hostRoot, minimumEnforcement: config.minimumEnforcement,
    allowAttendedEscalation: config.allowAttendedEscalation,
  }, world, path.join(providerTemp, 'calls'), { approve: config.approveEscalation, event });
  const fsSeam = createSandboxedFs(world, policy, event);
  const shell = createScreenedShell(world, policy, sandbox, subprocess, config.forwardedEnv ?? [], event);
  if (fsSeam.world !== subprocess.world || subprocess.world !== shell.world || shell.world !== sandbox.world || policy.world !== world) {
    await subprocess.dispose();
    throw new Error('Mixed execution-world providers were composed; filesystem and subprocess identities differ.');
  }
  let disposed = false;
  return {
    world, fs: fsSeam, shell, sandbox, subprocess, sandboxPolicy: policy,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await subprocess.dispose();
      fs.rmSync(providerTemp, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export async function apply(ctx: Context, config: LocalExecutionWorldConfig): Promise<() => Promise<void>> {
  const event: SandboxEventSink = async (runId, input) => {
    const session = await ctx.sessions.open(runId);
    await session.append(input as any);
  };
  const owner = await createLocalExecutionWorld(config, event);
  const withdraw = [
    provideSeam(ctx, 'fs', owner.fs), provideSeam(ctx, 'subprocess', owner.subprocess),
    provideSeam(ctx, 'sandbox', owner.sandbox), provideSeam(ctx, 'shell', owner.shell),
    () => { void ctx.provide('sandboxPolicy', owner.sandboxPolicy)(); },
  ];
  return async () => {
    for (const dispose of [...withdraw].reverse()) dispose();
    await owner.dispose();
  };
}
