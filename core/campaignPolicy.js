// Shared, data-only campaign policy and launch arithmetic (also used by the UI).
export const initialCampaignState = () => ({ phase: 'pilot', candidateCount: 0, retestsUsed: 0, repairCallsUsed: 0, population: [], families: {}, seen: {}, promoted: 0 });
export const campaignDefaults = (candidates = 200) => ({
  mode: 'optimize', maxCandidates: candidates, minExploration: Math.min(60, candidates),
  families: ['task-granularity', 'dependencies', 'context-handoff', 'verification', 'prompt-structure', 'fresh-design'],
  allowedChanges: ['prompt'], screenCases: 3, survivors: 24, finalists: 3,
  confirmationRepeats: 3, validationQueries: 3, concurrency: 1, retests: 5,
  repairCalls: 20, reserveCalls: 100, reserveUsd: 0, estimatedCallUsd: 0.02,
  unknownPricing: 'pause', reuseLearning: true,
});
export function validateCampaign(input, evaluation, limits) {
  if (input == null || input.mode === 'acceptance') return null;
  const defaults = campaignDefaults(Math.min(200, limits.iterations));
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(defaults, k))) throw new Error('Unknown campaign setting');
  const p = { ...defaults, ...input };
  if (!['optimize', 'improve'].includes(p.mode)) throw new Error('Unknown completion mode');
  if (!evaluation?.baseline) throw new Error('Optimization requires a versioned evaluation and a fixed baseline');
  if (evaluation.promotion.mode !== 'off') throw new Error('Campaign benchmarks stay fixed; use a new campaign revision to change references');
  if (evaluation.referencePreparation) throw new Error('Campaign references must be fixed in the benchmark before launch');
  if (evaluation.target === 'workflow' && !evaluation.baseline.source) throw new Error('Workflow optimization requires baseline.source');
  for (const [key, min, max] of [['maxCandidates', 1, limits.iterations], ['minExploration', 1, p.maxCandidates], ['screenCases', 1, 30], ['survivors', 1, 1000], ['finalists', 1, 10], ['confirmationRepeats', 2, 20], ['validationQueries', 0, 10], ['concurrency', 1, 4], ['retests', 0, 1000], ['repairCalls', 0, limits.calls], ['reserveCalls', 1, limits.calls - 1]]) {
    if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) throw new Error(`Campaign ${key} must be ${min}–${max}`);
  }
  for (const key of ['reserveUsd', 'estimatedCallUsd']) if (!Number.isFinite(p[key]) || p[key] < 0) throw new Error(`Invalid campaign ${key}`);
  if (p.estimatedCallUsd === 0) throw new Error('Campaign calls require a positive estimated reservation');
  if (limits.usd != null && p.reserveUsd >= limits.usd) throw new Error('Confirmation reserve must leave search capacity');
  if (!['pause', 'reserve'].includes(p.unknownPricing) || (p.unknownPricing === 'reserve' && p.estimatedCallUsd <= 0)) throw new Error('Unknown pricing requires a pause or a positive per-call reservation');
  if (typeof p.reuseLearning !== 'boolean') throw new Error('Invalid learning policy');
  if (!Array.isArray(p.families) || p.families.length < 2 || p.families.length > 10 || new Set(p.families).size !== p.families.length || p.families.some(x => typeof x !== 'string' || !/^[\w-]{1,60}$/.test(x))) throw new Error('Choose 2–10 distinct named strategy families');
  if (!Array.isArray(p.allowedChanges) || !p.allowedChanges.length || p.allowedChanges.some(x => !['prompt', 'settings', 'structure'].includes(x))) throw new Error('Choose the permitted search space');
  if (evaluation.target !== 'workflow' && p.allowedChanges.some(x => x !== 'prompt')) throw new Error('Worker settings and structure require a workflow target');
  if (evaluation.suite.cases.some(c => c.split === 'validation') && p.validationQueries < 1) throw new Error('Validation cases require a query allowance');
  return p;
}
export function campaignPhase(count, maximum) {
  return count < Math.ceil(maximum * 0.3) ? 'explore' : count < Math.ceil(maximum * 0.8) ? 'refine' : 'challenge';
}
export function campaignForecast(definition, pilot = null) {
  const p = definition.campaign, e = definition.evaluation;
  if (!p || p.mode === 'acceptance' || !e) return null;
  const dev = e.suite.cases.filter(c => c.split === 'development');
  const n = p.maxCandidates, screen = Math.min(p.screenCases, dev.length);
  const deep = dev.reduce((sum, c) => sum + c.repeats, 0);
  const finalists = Math.min(p.finalists, p.validationQueries || p.finalists, p.survivors, n);
  const confirmation = e.suite.cases.some(c => c.split === 'validation') ? e.suite.cases.filter(c => c.split === 'validation') : dev;
  const trials = screen + deep + n * screen + Math.min(p.survivors, n) * deep
    + 2 * finalists * confirmation.reduce((sum, c) => sum + Math.max(c.repeats, p.confirmationRepeats), 0)
    + (e.finalVerification.required ? e.suite.cases.filter(c => c.split === 'held-out').reduce((s, c) => s + Math.max(c.repeats, p.confirmationRepeats), 0) : 0);
  const judgeCalls = e.suite.evaluators.reduce((s, x) => s + (x.id === 'reference' ? 2 : x.id === 'ai-rubric' ? 1 : 0), 0);
  const callsPerTrial = pilot?.callsPerTrial ?? (e.target === 'artifact' ? judgeCalls : 1 + judgeCalls);
  const calls = Math.ceil(n + trials * callsPerTrial + p.repairCalls);
  return { trials, candidates: n, calls, callsRange: [calls, Math.ceil(calls * 1.8)],
    usdRange: pilot?.usdPerTrial != null ? [trials * pilot.usdPerTrial, trials * pilot.usdPerTrial * 1.8 + n * p.estimatedCallUsd] : null,
    tokensRange: pilot?.tokensPerTrial != null ? [trials * pilot.tokensPerTrial, trials * pilot.tokensPerTrial * 1.8] : null,
    minutesRange: pilot?.msPerTrial != null ? [trials * pilot.msPerTrial / 60000 / p.concurrency, trials * pilot.msPerTrial * 1.8 / 60000] : null,
    source: pilot ? 'calibration observations' : 'topology estimate; worker calls and repairs can increase it',
    exceedsCalls: calls > definition.limits.calls, reserveCalls: p.reserveCalls };
}
