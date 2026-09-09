// One small cache per host. Live rows are always refreshed; completed rows have
// a short lifetime as a fallback for external edits without changed metadata.
export function createBuildHistoryReader(read, { now = Date.now, maxAgeMs = 5000 } = {}) {
  let cached = null;
  return {
    async read({ projectId, workflowId, runs = [], visible }) {
      if (!visible || !projectId || !workflowId) return [];
      const candidates = runs.filter(row => (row.stackId ?? row.flowId) === workflowId).slice(0, 10);
      const key = JSON.stringify([projectId, workflowId, candidates]);
      const settled = candidates.every(row => ['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected'].includes(row.stage));
      if (settled && cached?.key === key && now() - cached.at < maxAgeMs) return cached.promise;
      const entry = { key, at: now(), promise: null };
      entry.promise = candidates.length ? read(projectId, candidates.map(row => row.id)) : Promise.resolve([]);
      cached = entry;
      try { return await entry.promise; }
      catch (error) { if (cached === entry) cached = null; throw error; }
    },
  };
}
