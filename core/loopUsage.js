import fs from 'node:fs';
import path from 'node:path';
import { readSessionLogFile } from '#kernel';
import { normalizeSessionEvent } from './telemetry.js';

// A disposable read cache. Restarting rebuilds it from canonical session files.
export function createLoopUsageReader() {
  const cache = new Map();
  return (store, state, runIds = store.listRuns()) => {
    const usage = { tokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, toolCalls: 0 };
    let observed = false, files = 0;
    const fields = new Set();
    for (const id of runIds.filter(id => id.startsWith(`goal-${state.id}-`))) {
      const file = path.join(store.runDir(id), 'session.jsonl');
      if (!fs.existsSync(file)) continue;
      files++;
      const stat = fs.statSync(file), stamp = `${stat.mtimeMs}:${stat.size}`;
      let record = cache.get(file);
      if (!record || record.stamp !== stamp) {
        const events = readSessionLogFile(file).events;
        const totals = { tokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, toolCalls: 0 };
        let hasUsage = false;
        const recordedFields = new Set();
        for (const event of events) {
          if (event.type === 'tool.result') totals.toolCalls++;
          if (event.type !== 'llm.response') continue;
          const measurements = normalizeSessionEvent(state.projectId, id, event).measurements;
          if (measurements.promptTokens != null || measurements.completionTokens != null) hasUsage = true;
          for (const key of ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedTokens']) {
            totals[key] += measurements[key] ?? 0;
            if (measurements[key] != null) recordedFields.add(key);
          }
        }
        totals.tokens = totals.promptTokens + totals.completionTokens;
        record = { stamp, totals, hasUsage, recordedFields }; cache.set(file, record);
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
      }
      observed ||= record.hasUsage;
      for (const key of record.recordedFields) fields.add(key);
      for (const key of Object.keys(usage)) usage[key] += record.totals[key];
    }
    if (!observed && state.calls > 0) for (const key of Object.keys(usage).filter(key => key !== 'toolCalls')) usage[key] = null;
    if (state.calls > 0) {
      for (const key of ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedTokens']) if (!fields.has(key)) usage[key] = null;
      if (!files) usage.toolCalls = null;
    }
    return usage;
  };
}
