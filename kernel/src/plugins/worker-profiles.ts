import type { Context } from '@deepseek-ai/cordis';
import { LOOP_CEILING, WORK_SYSTEM } from './blocks-core.js';
import { WorkerProfileRegistry, type WorkerProfile } from '../workers/profiles.js';

export const name = 'flyt-worker-profiles';

export interface WorkerProfilesConfig { profiles?: readonly WorkerProfile[]; }

export function apply(ctx: Context, config: WorkerProfilesConfig = {}): void {
  const registry = new WorkerProfileRegistry(ctx);
  registry.register({
    id: 'default-work',
    purpose: 'Execute one bounded task-graph node.',
    description: 'Repository worker with isolated context and Flyt’s standard Loop ceiling.',
    systemPrompt: WORK_SYSTEM,
    preferredModel: 'openrouter/auto',
    fallbacks: [],
    reasoning: 'medium',
    toolCeiling: LOOP_CEILING,
    permissionRules: [],
    context: { mode: 'isolated' },
    warnings: { steps: 120, repeatedCalls: 3, repeatedFailures: 2 },
  });
  for (const profile of config.profiles ?? []) registry.register(profile);
}
