/** Deterministic bounded scheduling for one model response's tool calls. */
import type { ToolCall, ToolResult } from '../types.js';
import type { ToolDefinition } from '../seams/tools.js';

export interface ScheduledToolCall { call: ToolCall; tool?: ToolDefinition; }

export function concurrentlySafe(call: ScheduledToolCall): boolean {
  const classification = call.tool?.classification;
  return Boolean(classification
    && classification.effect === 'read'
    && !classification.destructive
    && !classification.untrustedInput);
}

/**
 * Run safe read groups concurrently and every other call as a serialization
 * barrier. Returned results always use input order, never completion order.
 */
export async function executeCompatibleCalls(
  calls: readonly ScheduledToolCall[],
  execute: (item: ScheduledToolCall, index: number) => Promise<ToolResult>,
  maxConcurrency = 4,
): Promise<ToolResult[]> {
  const results: ToolResult[] = new Array(calls.length);
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let cursor = 0;
  while (cursor < calls.length) {
    if (!concurrentlySafe(calls[cursor])) {
      results[cursor] = await execute(calls[cursor], cursor);
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < calls.length && concurrentlySafe(calls[end])) end += 1;
    for (let at = cursor; at < end; at += limit) {
      const batch = calls.slice(at, Math.min(end, at + limit));
      const settled = await Promise.all(batch.map((item, offset) => execute(item, at + offset)));
      for (let offset = 0; offset < settled.length; offset++) results[at + offset] = settled[offset];
    }
    cursor = end;
  }
  return results;
}
