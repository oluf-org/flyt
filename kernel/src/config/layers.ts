/** Effective configuration with leaf-level precedence and provenance. */
import type { JsonValue } from '../types.js';

export const CONFIG_LAYER_ORDER = ['global', 'project', 'workflow', 'mode', 'block', 'run'] as const;
export type ConfigLayerName = (typeof CONFIG_LAYER_ORDER)[number];
export interface ConfigLayer { source: ConfigLayerName; values: Record<string, JsonValue>; }
export interface ConfigProvenance { path: string; source: ConfigLayerName; value: JsonValue; overridden: { source: ConfigLayerName; value: JsonValue }[]; }

function object(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function resolveConfiguration(layers: readonly ConfigLayer[]): {
  effective: Record<string, JsonValue>;
  provenance: ConfigProvenance[];
} {
  const rank = new Map(CONFIG_LAYER_ORDER.map((name, index) => [name, index]));
  const ordered = [...layers].sort((a, b) => rank.get(a.source)! - rank.get(b.source)!);
  const effective: Record<string, JsonValue> = {};
  const history = new Map<string, { source: ConfigLayerName; value: JsonValue }[]>();
  const merge = (target: Record<string, JsonValue>, input: Record<string, JsonValue>, source: ConfigLayerName, prefix = '') => {
    for (const [key, value] of Object.entries(input)) {
      const at = prefix ? `${prefix}.${key}` : key;
      if (object(value) && object(target[key])) merge(target[key] as Record<string, JsonValue>, value, source, at);
      else if (object(value)) {
        target[key] = {};
        merge(target[key] as Record<string, JsonValue>, value, source, at);
      } else {
        history.set(at, [...(history.get(at) ?? []), { source, value }]);
        target[key] = value;
      }
    }
  };
  for (const layer of ordered) merge(effective, layer.values, layer.source);
  const provenance = [...history].map(([path, entries]) => ({
    path, ...entries.at(-1)!, overridden: entries.slice(0, -1),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return { effective, provenance };
}

export function explainConfiguration(layers: readonly ConfigLayer[]): string[] {
  return resolveConfiguration(layers).provenance.map(item =>
    `${item.path} = ${JSON.stringify(item.value)} from ${item.source}${item.overridden.length ? ` (overrode ${item.overridden.map(v => v.source).join(', ')})` : ''}`);
}
