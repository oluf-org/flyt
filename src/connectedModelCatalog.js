import { routeFor } from './providerMirror.js';

/** Keep the catalog honest: a model is visible only when its saved source or
 * automatic route resolves through a provider that is connected right now. */
export function connectedModelCatalog(models, active, settings) {
  const routes = new Map((models ?? []).map(model => [model.id, routeFor(model.id, {
    providers: settings?.providers,
    providerPriority: settings?.providerPriority,
    source: (active ?? []).find(entry => entry.id === model.id)?.source ?? 'auto'
  })]));
  return { models: (models ?? []).filter(model => routes.get(model.id)), routes };
}

/** Attribute locally observed model activity to the route that would serve the
 * model now. History intentionally contains no credentials or vendor quota
 * data, so this is an observed-usage summary rather than a billing balance. */
export function providerUsageSummary(rows, active, settings) {
  const sources = new Map((active ?? []).map(entry => [entry.id, entry.source ?? 'auto']));
  const byProvider = {};
  let totalCalls = 0;
  let totalTokens = 0;

  for (const row of rows ?? []) {
    const calls = Math.max(0, Number(row.calls) || 0);
    const tokens = Math.max(0, Number(row.promptTokens) || 0) + Math.max(0, Number(row.completionTokens) || 0);
    totalCalls += calls;
    totalTokens += tokens;
    const provider = routeFor(row.model, {
      providers: settings?.providers,
      providerPriority: settings?.providerPriority,
      source: sources.get(row.model) ?? 'auto'
    });
    if (!provider) continue;
    const current = byProvider[provider] ?? { calls: 0, tokens: 0, costUsd: 0, models: 0, measuredCalls: 0, successfulCalls: 0 };
    current.calls += calls;
    current.tokens += tokens;
    current.costUsd += Math.max(0, Number(row.costUsd) || 0);
    current.models += 1;
    if (Number.isFinite(Number(row.successRate))) {
      current.measuredCalls += calls;
      current.successfulCalls += calls * Number(row.successRate);
    }
    byProvider[provider] = current;
  }

  for (const summary of Object.values(byProvider)) {
    summary.successRate = summary.measuredCalls ? summary.successfulCalls / summary.measuredCalls : null;
    delete summary.measuredCalls;
    delete summary.successfulCalls;
  }

  return { byProvider, totalCalls, totalTokens };
}
