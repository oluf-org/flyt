// Shared projections for loop results, chat history and historical statistics.
// Counts belong to a loop instance, never to each of its child workflows.
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
export const LOOP_SETTLED = new Set(['achieved', 'completed', 'failed', 'stopped', 'plateau', 'limit_reached']);

export function loopSummary(state, usage = state.usage ?? {}) {
  const checks = (state.contract?.criteria?.length ?? 0) + (state.contract?.tests?.length ?? 0);
  const score = state.best?.score ?? null;
  return {
    evaluationPolicy: state.contract?.evaluationPolicy ?? 'legacy-containment-v1',
    evaluation: state.best?.evaluation ?? null, bestPartial: state.bestPartial ?? null,
    id: state.id, goalId: state.id, projectId: state.projectId, kind: 'loop', name: state.name,
    createdAt: state.createdAt, updatedAt: state.updatedAt ?? state.createdAt,
    status: state.status, stage: state.status === 'achieved' ? 'done' : state.status,
    reason: state.reason, model: state.contract?.worker?.model ?? null,
    iterations: number(state.iteration), calls: number(state.calls), elapsedMs: number(state.elapsedMs),
    knownUsd: number(state.knownUsd), unknownCostCalls: number(state.unknownCostCalls),
    tokens: usage.tokens ?? null, toolCalls: usage.toolCalls ?? null,
    promptTokens: usage.promptTokens ?? null, completionTokens: usage.completionTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null, cachedTokens: usage.cachedTokens ?? null,
    score, checks, passedChecks: score == null ? null : Math.round(score * checks),
    limits: state.contract?.limits ?? {}, preview: state.best?.preview ?? state.current?.preview ?? '',
    settled: LOOP_SETTLED.has(state.status),
    history: (state.history ?? []).map(({ iteration, score, runId, artifact, revision }) => ({ iteration, score, runId, artifact, revision })),
  };
}

export function aggregateLoops(rows) {
  const settled = rows.filter(row => row.settled);
  const achieved = settled.filter(row => row.status === 'achieved');
  return {
    count: rows.length, achieved: achieved.length, settled: settled.length,
    successRate: settled.length ? achieved.length / settled.length : null,
    iterations: rows.reduce((sum, row) => sum + number(row.iterations), 0),
    calls: rows.reduce((sum, row) => sum + number(row.calls), 0),
    knownUsd: rows.reduce((sum, row) => sum + number(row.knownUsd), 0),
    unknownCostCalls: rows.reduce((sum, row) => sum + number(row.unknownCostCalls), 0),
    tokens: rows.some(row => row.tokens != null) ? rows.reduce((sum, row) => sum + number(row.tokens), 0) : null,
    averageElapsedMs: settled.length ? settled.reduce((sum, row) => sum + number(row.elapsedMs), 0) / settled.length : null,
  };
}

export function selectLoops(rows, filters = {}) {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.projectId}:${row.id}`;
    if (!latest.has(key) || latest.get(key).updatedAt <= row.updatedAt) latest.set(key, row);
  }
  return [...latest.values()].filter(row => row.status !== 'ready'
    && (!filters.projectId || row.projectId === filters.projectId)
    && (!filters.model || row.model === filters.model)
    && (!filters.from || (row.updatedAt ?? row.createdAt) >= filters.from)
    && (!filters.to || row.createdAt <= filters.to))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function chatHistory(runs, loops) {
  const conversations = new Map();
  const loopIds = new Set(loops.map(loop => loop.id));
  for (const run of runs) {
    if (run.goalId && loopIds.has(run.goalId)) continue;
    if (loops.some(loop => run.id.startsWith(`goal-${loop.id}-`))) continue;
    if (run.id.includes('--child-')) continue;
    const key = run.conversationId ?? run.parentRunId ?? run.id;
    const list = conversations.get(key) ?? [];
    list.push(run); conversations.set(key, list);
  }
  const workflows = [...conversations.values()].map(list => {
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const first = list[0], last = list.at(-1);
    return { ...last, kind: 'workflow', name: first.name, conversationRuns: list.length, createdAt: last.createdAt };
  });
  return [...workflows, ...loops.filter(loop => loop.status !== 'ready')]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
