// Pure, versioned projections for the History surface. Raw events remain the
// authority; every value returned here says which projection produced it.
import { PROJECTION_VERSION, usageMeasurements } from './telemetry.js';

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const avg = values => values.length ? values.reduce((a, b) => a + n(b), 0) / values.length : null;
const rate = (yes, total) => total ? yes / total : null;
const round = value => value == null ? null : Math.round(value * 100) / 100;
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const modelOf = e => e.attributes?.model ?? e.attributes?.effectiveModel ?? e.attributes?.route?.effective?.split('/').slice(1).join('/') ?? 'unknown';
const toolNameOf = e => e.attributes?.tool ?? e.attributes?.toolName ?? 'unknown';
const toolSucceeded = e => e.attributes?.ok === true || e.attributes?.resultStatus === 'success' || e.attributes?.status === 'ok';
const gateSucceeded = e => e.attributes?.ok === true || ['pass', 'passed'].includes(e.attributes?.status)
  || e.attributes?.exitStatus === 0 || e.attributes?.exitCode === 0 || e.attributes?.code === 0;
const isWorkspaceEffect = e => (
  (e.kind === 'workspace.observed' && e.attributes?.changed === true)
  || (e.kind === 'workspace.effect_observed' && e.attributes?.workspaceChange === true)
  || (e.kind === 'tool.result' && toolSucceeded(e) && e.attributes?.scope === 'workspace' && e.attributes?.effects?.includes('write'))
);

function filtersMatch(event, filters) {
  if (filters.model && modelOf(event) !== filters.model) return false;
  if (filters.projectId && event.projectId !== filters.projectId) return false;
  if (filters.outcome && String(event.attributes?.ok) !== filters.outcome) return false;
  return true;
}

export function projectHistory(events, filters = {}) {
  const callRequests = new Map(events.filter(event => event.kind === 'llm.request' && event.attributes?.callId)
    .map(event => [`${event.projectId}:${event.runId}:${event.attributes.callId}`, event]));
  // Old normalized records still carry the canonical provider usage. Repair
  // their missing measurements in this projection without rewriting raw logs.
  events = events.map(event => {
    if (event.kind !== 'llm.result') return event;
    const usage = usageMeasurements(event.attributes?.usage ?? {}, event.attributes);
    const measurements = { ...event.measurements };
    for (const [key, value] of Object.entries(usage)) if (measurements[key] == null) measurements[key] = value;
    const request = callRequests.get(`${event.projectId}:${event.runId}:${event.attributes?.callId}`);
    if (request && measurements.durationMs == null) measurements.durationMs = Math.max(0, Date.parse(event.at) - Date.parse(request.at));
    if (typeof event.attributes?.content === 'string') measurements.visibleChars ??= event.attributes.content.length;
    if (typeof event.attributes?.reasoning === 'string') measurements.reasoningChars ??= event.attributes.reasoning.length;
    measurements.visibleChars ??= event.attributes?.contentChars ?? null;
    measurements.reasoningChars ??= event.attributes?.reasoningChars ?? null;
    const model = modelOf(event) === 'unknown' && request ? modelOf(request) : modelOf(event);
    return { ...event, measurements, attributes: { ...event.attributes, model,
      nativeToolCalls: event.attributes?.nativeToolCalls ?? event.attributes?.toolCalls?.length ?? 0 } };
  });
  const matchingRuns = new Set(events.filter(event => filtersMatch(event, filters)).map(event => `${event.projectId}:${event.runId}`));
  const rows = events.filter(event => filtersMatch(event, filters) || (['run.created', 'run.stage'].includes(event.kind)
    && matchingRuns.has(`${event.projectId}:${event.runId}`)));
  const results = rows.filter(e => e.kind === 'llm.result');
  const requests = rows.filter(e => e.kind === 'llm.request');
  const tools = rows.filter(e => e.kind === 'tool.result');
  const workspace = rows.filter(e => e.kind.startsWith('workspace.') || e.kind.includes('effect'));
  const workspaceEffects = rows.filter(isWorkspaceEffect);
  const gates = rows.filter(e => e.kind.startsWith('verification.') || e.kind.includes('gate'));
  const runs = new Map();
  for (const event of rows) {
    if (!event.runId) continue;
    const rec = runs.get(event.runId) ?? { runId: event.runId, projectId: event.projectId, at: event.at, endAt: event.at, events: 0, modelCalls: 0, toolCalls: 0, costUsd: 0, tokens: 0, status: 'running' };
    rec.at = rec.at < event.at ? rec.at : event.at; rec.endAt = rec.endAt > event.at ? rec.endAt : event.at; rec.events += 1;
    if (event.kind === 'llm.result') { rec.modelCalls += 1; rec.costUsd += n(event.measurements?.costUsd); rec.tokens += n(event.measurements?.completionTokens) + n(event.measurements?.promptTokens); }
    if (event.kind === 'tool.result') rec.toolCalls += 1;
    if (event.kind === 'run.created') {
      rec.workflow = event.attributes?.workflowId ?? event.attributes?.flowId ?? event.attributes?.stackId ?? rec.workflow ?? null;
      rec.workflowVersion = event.attributes?.workflowVersion ?? event.attributes?.version ?? rec.workflowVersion ?? null;
      rec.preset = event.attributes?.presetId ?? event.attributes?.modeId ?? rec.preset ?? null;
      rec.taskClass = event.attributes?.taskClass ?? rec.taskClass ?? null;
    }
    if (event.kind === 'run.stage') rec.status = event.attributes?.stage ?? rec.status;
    if (event.kind === 'scheduler.cancelled') rec.status = 'cancelled';
    runs.set(event.runId, rec);
  }

  const byModel = new Map();
  for (const event of results) {
    const model = modelOf(event);
    const rec = byModel.get(model) ?? { model, calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0, latencies: [], noVisible: 0, nativeCalls: 0 };
    rec.calls += 1; rec.failures += event.attributes?.ok === false ? 1 : 0;
    rec.promptTokens += n(event.measurements?.promptTokens); rec.completionTokens += n(event.measurements?.completionTokens);
    rec.reasoningTokens += n(event.measurements?.reasoningTokens); rec.cachedTokens += n(event.measurements?.cachedTokens);
    rec.costUsd += n(event.measurements?.costUsd); if (Number.isFinite(event.measurements?.durationMs)) rec.latencies.push(event.measurements.durationMs);
    rec.nativeCalls += n(event.attributes?.nativeToolCalls);
    if (n(event.measurements?.visibleChars) === 0 && n(event.attributes?.nativeToolCalls) === 0 && (n(event.measurements?.reasoningChars) > 0 || n(event.measurements?.completionTokens) > 0)) rec.noVisible += 1;
    byModel.set(model, rec);
  }
  const models = [...byModel.values()].map(rec => ({
    model: rec.model, calls: rec.calls, successRate: round(rate(rec.calls - rec.failures, rec.calls)),
    promptTokens: rec.promptTokens, completionTokens: rec.completionTokens, cachedTokens: rec.cachedTokens,
    reasoningTokenShare: round(rate(rec.reasoningTokens, rec.completionTokens)), costUsd: round(rec.costUsd),
    medianLatencyMs: percentile(rec.latencies, .5), p95LatencyMs: percentile(rec.latencies, .95),
    noVisibleOutputRate: round(rate(rec.noVisible, rec.calls)), nativeToolCalls: rec.nativeCalls,
  })).sort((a, b) => b.calls - a.calls);

  const firstBySpan = kind => new Map(rows.filter(e => e.kind === kind).map(e => [e.spanId, e.measurements?.elapsedMs]));
  const firstReasoning = firstBySpan('llm.first_reasoning'), firstVisible = firstBySpan('llm.first_visible_content');
  const firstTool = firstBySpan('llm.first_tool_input');
  const repeated = rows.filter(e => e.kind === 'tool.repeated').length;
  const successfulGates = gates.filter(gateSucceeded);
  const approvalPauses = rows.filter(e => e.kind === 'tool.approval_requested');
  const approvalDecisions = rows.filter(e => e.kind === 'tool.approval');
  const approvalWaits = approvalPauses.map(start => {
    const end = approvalDecisions.find(event => event.runId === start.runId && event.blockId === start.blockId && event.at >= start.at);
    return end ? Date.parse(end.at) - Date.parse(start.at) : null;
  }).filter(Number.isFinite);
  const runElapsed = [...runs.values()].reduce((total, run) => total + Math.max(0, Date.parse(run.endAt) - Date.parse(run.at)), 0);
  const workspaceEffectRuns = new Set(workspaceEffects.map(e => e.runId).filter(Boolean));
  const gatedRuns = new Set(successfulGates.map(e => e.runId).filter(Boolean));
  const verifiedRuns = new Set([...workspaceEffectRuns].filter(runId => gatedRuns.has(runId)));
  const firstWorkspaceEffectMs = [];
  for (const runId of workspaceEffectRuns) {
    const run = runs.get(runId);
    const effect = workspaceEffects.filter(e => e.runId === runId).sort((a, b) => a.at.localeCompare(b.at))[0];
    if (run && effect) firstWorkspaceEffectMs.push(Math.max(0, Date.parse(effect.at) - Date.parse(run.at)));
  }
  const failedRecoveries = [];
  for (let index = 0; index < tools.length; index += 1) {
    if (toolSucceeded(tools[index])) continue;
    failedRecoveries.push(tools.slice(index + 1).some(event => event.runId === tools[index].runId
      && toolNameOf(event) === toolNameOf(tools[index]) && toolSucceeded(event)));
  }
  const planAccepted = rows.filter(e => e.kind === 'planner.accepted');
  const planRejected = rows.filter(e => e.kind === 'planner.rejected');
  const plannerDiagnostics = rows.filter(e => e.kind === 'planner.diagnostic' || e.kind === 'planner.diagnostics');
  const repairedPlans = planAccepted.filter(e => n(e.attributes?.attempt) > 1);
  const totalsForRuns = selectedRuns => [...selectedRuns].reduce((acc, runId) => {
    const run = runs.get(runId); if (!run) return acc;
    acc.tokens += n(run.tokens); acc.costUsd += n(run.costUsd); return acc;
  }, { tokens: 0, costUsd: 0 });
  const acceptedSpend = totalsForRuns(new Set(planAccepted.map(e => e.runId).filter(Boolean)));
  const verifiedSpend = totalsForRuns(verifiedRuns);
  const comparison = new Map();
  for (const event of results) {
    const run = runs.get(event.runId) ?? {};
    const item = {
      workflow: run.workflow ?? 'unknown', workflowVersion: run.workflowVersion ?? 'unknown',
      preset: run.preset ?? 'default', taskClass: run.taskClass ?? event.taskId ?? event.blockId ?? 'unknown',
      model: modelOf(event), outcome: event.attributes?.ok === false ? 'failed' : 'successful',
    };
    const key = JSON.stringify(item);
    const rec = comparison.get(key) ?? { ...item, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, latencies: [] };
    rec.calls += 1; rec.promptTokens += n(event.measurements?.promptTokens); rec.completionTokens += n(event.measurements?.completionTokens);
    rec.costUsd += n(event.measurements?.costUsd); rec.reasoningTokens = n(rec.reasoningTokens) + n(event.measurements?.reasoningTokens);
    if (Number.isFinite(event.measurements?.durationMs)) rec.latencies.push(event.measurements.durationMs);
    comparison.set(key, rec);
  }

  return {
    projectionVersion: PROJECTION_VERSION,
    backend: filters.backend ?? null,
    range: { from: filters.from ?? null, to: filters.to ?? null },
    totals: {
      runs: runs.size, modelCalls: results.length, toolCalls: tools.length,
      promptTokens: results.reduce((a, e) => a + n(e.measurements?.promptTokens), 0),
      completionTokens: results.reduce((a, e) => a + n(e.measurements?.completionTokens), 0),
      reasoningTokens: results.reduce((a, e) => a + n(e.measurements?.reasoningTokens), 0),
      cachedTokens: results.reduce((a, e) => a + n(e.measurements?.cachedTokens), 0),
      costUsd: round(results.reduce((a, e) => a + n(e.measurements?.costUsd), 0)),
    },
    latency: {
      timeToFirstReasoningMs: round(avg([...firstReasoning.values()])),
      timeToFirstVisibleTokenMs: round(avg([...firstVisible.values()])),
      timeToFirstNativeToolCallMs: round(avg([...firstTool.values()])),
      timeToFirstWorkspaceEffectMs: round(avg(firstWorkspaceEffectMs)),
      usefulChangeLatencyMs: round(avg(firstWorkspaceEffectMs)),
      totalRunLatencyMs: round(avg([...runs.values()].map(run => Math.max(0, Date.parse(run.endAt) - Date.parse(run.at))))),
      modelMedianMs: percentile(results.map(e => e.measurements?.durationMs), .5),
      modelP95Ms: percentile(results.map(e => e.measurements?.durationMs), .95),
    },
    milestoneTokens: {
      beforeFirstVisibleContent: round(avg(results.map(e => e.measurements?.tokensBeforeFirstVisibleContent).filter(Number.isFinite))),
      beforeFirstNativeToolCall: round(avg(results.map(e => e.measurements?.tokensBeforeFirstNativeToolCall).filter(Number.isFinite))),
      beforeFirstWorkspaceEffect: null,
      source: results.some(e => e.measurements?.milestoneTokensEstimated === true) ? 'estimated' : 'provider_reported_when_available',
    },
    quality: {
      nativeToolCallRate: round(rate(results.filter(e => n(e.attributes?.nativeToolCalls) > 0).length, results.length)),
      toolSchemaValidRate: round(rate(tools.filter(e => e.attributes?.schemaValid === true).length, tools.filter(e => typeof e.attributes?.schemaValid === 'boolean').length)),
      repeatedToolCallRate: round(rate(repeated, tools.length)),
      failedCallRecoveryRate: round(rate(failedRecoveries.filter(Boolean).length, failedRecoveries.length)),
      toolRepairSuccessRate: round(rate(failedRecoveries.filter(Boolean).length, failedRecoveries.length)),
      unparsedDialectRate: round(rate(results.filter(e => Boolean(e.attributes?.unparsedDialect)).length, results.length)),
      callsPerSuccessfulWorkspaceEffect: workspaceEffects.length ? round(tools.length / workspaceEffects.length) : null,
      streamIdleIncidence: round(rate(results.filter(e => n(e.measurements?.streamIdleGapCount) > 0).length, results.length)),
      approvalWaitShare: round(rate(approvalWaits.reduce((a, value) => a + value, 0), runElapsed)),
      noVisibleOutputRate: round(rate(results.filter(e => n(e.measurements?.visibleChars) === 0 && n(e.attributes?.nativeToolCalls) === 0 && (n(e.measurements?.reasoningChars) > 0 || n(e.measurements?.completionTokens) > 0)).length, results.length)),
      verificationClosureRate: round(rate(verifiedRuns.size, workspaceEffectRuns.size)),
      firstPassPlanValidRate: round(rate(planAccepted.filter(e => n(e.attributes?.attempt ?? 1) === 1).length, planAccepted.length + planRejected.filter(e => n(e.attributes?.attempt ?? 1) === 1).length)),
      graphRepairSuccessRate: round(rate(planAccepted.filter(e => n(e.attributes?.attempt) > 1).length, planRejected.length)),
    },
    planner: {
      acceptedPlans: planAccepted.length, rejectedPlans: planRejected.length,
      diagnosticEvents: plannerDiagnostics.length,
      repairsPerAcceptedPlan: round(rate(repairedPlans.length, planAccepted.length)),
    },
    efficiency: {
      tokensPerAcceptedPlan: round(rate(acceptedSpend.tokens, planAccepted.length)),
      costPerAcceptedPlanUsd: round(rate(acceptedSpend.costUsd, planAccepted.length)),
      tokensPerSuccessfulToolEffect: round(rate(results.reduce((a, e) => a + n(e.measurements?.promptTokens) + n(e.measurements?.completionTokens), 0), workspaceEffects.length)),
      costPerSuccessfulToolEffectUsd: round(rate(results.reduce((a, e) => a + n(e.measurements?.costUsd), 0), workspaceEffects.length)),
      tokensPerVerifiedCompletion: round(rate(verifiedSpend.tokens, verifiedRuns.size)),
      costPerVerifiedCompletionUsd: round(rate(verifiedSpend.costUsd, verifiedRuns.size)),
      verifiedCompletions: verifiedRuns.size,
    },
    models,
    comparisons: [...comparison.values()].map(rec => ({
      ...rec, costUsd: round(rec.costUsd), reasoningTokenShare: round(rate(rec.reasoningTokens, rec.completionTokens)),
      medianLatencyMs: percentile(rec.latencies, .5), latencies: undefined,
    })).sort((a, b) => b.calls - a.calls).slice(0, 500),
    runs: [...runs.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 250),
    facets: {
      models: [...new Set(events.filter(event => ['llm.request', 'llm.result'].includes(event.kind)).map(modelOf))].filter(Boolean).sort(),
      projects: [...new Set(events.map(e => e.projectId).filter(Boolean))].sort(),
    },
  };
}

export function flatCsv(events) {
  const columns = ['schemaVersion','eventId','traceId','spanId','parentSpanId','runId','projectId','blockId','taskId','step','at','monotonicMs','kind','source','attributes','measurements'];
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [columns.join(','), ...events.map(event => columns.map(column => cell(
    column === 'attributes' || column === 'measurements' ? JSON.stringify(event[column] ?? {}) : event[column]
  )).join(','))].join('\n') + '\n';
}
