import type { JsonValue } from '../types.js';

/** Reassemble adjacent text/summary deltas; opaque items stay intact. */
export function mergeReasoningDetails(items: readonly JsonValue[]): JsonValue[] {
  const merged: JsonValue[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { merged.push(item); continue; }
    const field = item.type === 'reasoning.text' ? 'text' : item.type === 'reasoning.summary' ? 'summary' : null;
    const previous = merged.at(-1);
    if (field && typeof item[field] === 'string' && previous && typeof previous === 'object' && !Array.isArray(previous)
      && previous.type === item.type && typeof previous[field] === 'string'
      && [...new Set([...Object.keys(previous), ...Object.keys(item)])]
        .filter(key => key !== field).every(key => JSON.stringify(previous[key]) === JSON.stringify(item[key]))) {
      merged[merged.length - 1] = { ...previous, [field]: String(previous[field]) + item[field] };
    } else merged.push({ ...item });
  }
  return merged;
}
