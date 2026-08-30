export const WORKFLOW_MODEL_TIERS = Object.freeze([
  { id: 'free', name: 'Free', hint: 'No per-token cost' },
  { id: 'economy', name: 'Economy', hint: 'Routine and refining work' },
  { id: 'standard', name: 'Standard', hint: 'Everyday default' },
  { id: 'frontier', name: 'Frontier', hint: 'Hardest work' },
]);

export const DEFAULT_WORKFLOW_MODEL_TIER = 'standard';

export function workersForTier(tiers, tierId, fallback = null) {
  const selected = tiers?.[tierId];
  const configured = (Array.isArray(selected) ? selected : [selected])
    .filter(worker => worker?.model);
  if (configured.length) return configured;
  // Free is a closed list: it may try another configured free model, but it
  // must never spill into the ordinary (potentially paid) executor.
  return tierId === 'free' || !fallback?.model ? [] : [fallback];
}

export function workerForTier(tiers, tierId, fallback = null) {
  return workersForTier(tiers, tierId, fallback)[0] ?? null;
}

export function workflowModelSelection({
  tiers = {}, defaultTier = DEFAULT_WORKFLOW_MODEL_TIER,
  blockTiers = {}, defaultBlockTiers = {}, customBlocks = {}, fallback = null,
} = {}) {
  const defaultCandidates = workersForTier(tiers, defaultTier, fallback);
  const defaultWorker = defaultCandidates[0] ?? null;
  const ids = new Set([
    ...Object.keys(defaultBlockTiers ?? {}), ...Object.keys(blockTiers ?? {}), ...Object.keys(customBlocks ?? {}),
  ]);
  const blocks = {};
  const blockFallbacks = {};
  for (const blockId of ids) {
    if (customBlocks?.[blockId]?.model) {
      blocks[blockId] = customBlocks[blockId];
      continue;
    }
    const tierId = blockTiers?.[blockId] ?? defaultBlockTiers?.[blockId];
    if (!tierId) continue;
    const candidates = workersForTier(tiers, tierId, fallback);
    const worker = candidates[0];
    if (worker?.model) blocks[blockId] = worker;
    if (candidates.length > 1) blockFallbacks[blockId] = candidates.slice(1);
  }
  return {
    defaultWorker,
    defaultFallbacks: defaultCandidates.slice(1),
    blocks,
    blockFallbacks,
  };
}
