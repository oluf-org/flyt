/** Ordered, typed plugin interception with trusted-only mutation and trace evidence. */
import { Service, type Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import type { JsonValue } from '../types.js';
import { belongsToTrustedPlugin } from './trusted-install.js';

export const INTERCEPTION_POINTS = [
  'context.assembled', 'model.budget.resolved', 'model.request.prepared', 'retry.classified',
  'tool.definition.prepared', 'tool.call.normalized', 'compaction.starting', 'compaction.completed',
] as const;
export type InterceptionPoint = (typeof INTERCEPTION_POINTS)[number];

export interface InterceptionTrace {
  point: InterceptionPoint;
  plugin: string;
  order: number;
  mutated: boolean;
  beforeHash: string;
  afterHash: string;
}

export type Interceptor = (payload: JsonValue) => JsonValue | void | Promise<JsonValue | void>;
export interface InterceptionRegistration { plugin: string; point: InterceptionPoint; order: number; mutates: boolean; run: Interceptor; }

const hash = (value: JsonValue) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const clone = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export class InterceptionRegistry extends Service {
  private registered: InterceptionRegistration[] = [];
  constructor(ctx: Context, private trustOverride?: (plugin: string) => boolean) { super(ctx, 'interceptions'); }

  register(hook: InterceptionRegistration): () => void {
    if (!INTERCEPTION_POINTS.includes(hook.point)) throw new Error(`Unknown interception point "${hook.point}"`);
    const trusted = this.trustOverride?.(hook.plugin) ?? belongsToTrustedPlugin(this.ctx.fiber);
    if (hook.mutates && !trusted) throw new Error(`Mutating hook from untrusted plugin "${hook.plugin}" was refused`);
    const stored = { ...hook };
    this.registered.push(stored);
    this.registered.sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin));
    return () => { this.registered = this.registered.filter(item => item !== stored); };
  }

  async apply(point: InterceptionPoint, payload: JsonValue): Promise<{ payload: JsonValue; trace: InterceptionTrace[] }> {
    let current = clone(payload);
    const trace: InterceptionTrace[] = [];
    for (const hook of this.registered.filter(item => item.point === point)) {
      const beforeHash = hash(current);
      const proposed = await hook.run(clone(current));
      if (hook.mutates && proposed !== undefined) current = clone(proposed);
      trace.push({ point, plugin: hook.plugin, order: hook.order, mutated: hook.mutates && proposed !== undefined, beforeHash, afterHash: hash(current) });
    }
    return { payload: current, trace };
  }
}

export const name = 'flyt-interceptions';
export function apply(ctx: Context): void { new InterceptionRegistry(ctx); }
