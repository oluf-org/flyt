/** First-class, reusable generated-worker configuration. */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { PermissionRule } from '../security/permissions.js';

export type ReasoningVariant = 'low' | 'medium' | 'high' | 'xhigh';

export interface WorkerContextStrategy {
  mode: 'isolated' | 'parent-summary' | 'shared';
  maxInputTokens?: number;
  includeArtifacts?: readonly string[];
}

export interface WorkerWarningThresholds {
  steps?: number;
  tokensWithoutProgress?: number;
  repeatedCalls?: number;
  repeatedFailures?: number;
}

export interface WorkerProfile {
  id: string;
  purpose: string;
  description: string;
  systemPrompt: string;
  preferredModel: string;
  fallbacks: readonly string[];
  reasoning: ReasoningVariant;
  toolCeiling: readonly string[];
  permissionRules: readonly PermissionRule[];
  context: WorkerContextStrategy;
  warnings?: WorkerWarningThresholds;
}

export function validateWorkerProfile(profile: WorkerProfile): WorkerProfile {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.id)) throw new Error('Worker profile id must be lowercase kebab-case');
  for (const key of ['purpose', 'description', 'systemPrompt', 'preferredModel'] as const) {
    if (!String(profile[key] ?? '').trim()) throw new Error(`Worker profile "${profile.id}" needs ${key}`);
  }
  if (!Array.isArray(profile.toolCeiling)) throw new Error(`Worker profile "${profile.id}" needs a tool ceiling`);
  return Object.freeze({
    ...profile,
    fallbacks: Object.freeze([...new Set(profile.fallbacks ?? [])]),
    toolCeiling: Object.freeze([...new Set(profile.toolCeiling)]),
    permissionRules: Object.freeze((profile.permissionRules ?? []).map(rule => Object.freeze({ ...rule }))),
    context: Object.freeze({ ...profile.context }),
    ...(profile.warnings ? { warnings: Object.freeze({ ...profile.warnings }) } : {}),
  });
}

export class WorkerProfileRegistry extends Service {
  private registered = new Map<string, WorkerProfile>();
  constructor(ctx: Context) { super(ctx, 'workerProfiles'); }

  register(profile: WorkerProfile): () => void {
    const stored = validateWorkerProfile(profile);
    if (this.registered.has(stored.id)) throw new Error(`A worker profile named "${stored.id}" is already registered`);
    this.registered.set(stored.id, stored);
    return this.ctx.effect(() => () => { if (this.registered.get(stored.id) === stored) this.registered.delete(stored.id); }) as () => void;
  }
  get(id: string): WorkerProfile | undefined { return this.registered.get(id); }
  list(): WorkerProfile[] { return [...this.registered.values()]; }
  snapshot(id: string): JsonValue {
    const profile = this.get(id);
    if (!profile) throw new Error(`Unknown worker profile "${id}". Available: ${[...this.registered.keys()].join(', ') || 'none'}`);
    return JSON.parse(JSON.stringify(profile)) as JsonValue;
  }
}
