// Shipping recommendations are presentation metadata, not execution authority.
// Existing workflow files and saved selections are never rewritten by migration.
export const DEFAULT_WORKFLOW_IDS = ['make-change', 'fix-bug', 'review-change', 'research-question', 'plan-idea', 'deliver-complex-task'];
export const LEGACY_WORKFLOW_IDS = ['pipeline', 'fable-at-home', 'learn-from-repo', 'research', 'spec-an-idea'];
export function workflowRecommendation(id) {
  if (DEFAULT_WORKFLOW_IDS.includes(id)) return 'recommended';
  if (LEGACY_WORKFLOW_IDS.includes(id)) return 'legacy';
  return 'custom';
}
export function recommendedWorkflowOrder(a, b) {
  const left = DEFAULT_WORKFLOW_IDS.indexOf(a.id), right = DEFAULT_WORKFLOW_IDS.indexOf(b.id);
  if (left >= 0 || right >= 0) return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
  return Number(LEGACY_WORKFLOW_IDS.includes(a.id)) - Number(LEGACY_WORKFLOW_IDS.includes(b.id));
}
