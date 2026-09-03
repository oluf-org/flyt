// What Work shows about a run in flight (t-0077).
//
// Work is everything happening, and it stays calm: which block is live, what it
// is producing, how far the run has got. What it cost, which model answered and
// what it was asked belong one click away, in Trace.
//
// Derived from the same folded trace Trace renders, so a run watched in Work
// and the same run watched in Trace cannot disagree — there is one source, and
// a second read of the log would be a second answer.

/** A block's state, as the log tells it. */
export const BLOCK_STATES = ['pending', 'active', 'done', 'failed', 'blocked', 'waiting', 'approval', 'input', 'skipped'];
const TERMINAL_STAGES = new Set(['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected']);
const ACTIVE_STAGES = new Set(['execution', 'resumed', 'pausing', 'paused', 'stopping']);

/**
 * Which blocks a run has touched, and how they ended.
 *
 * From `block.status` and `block.output`, which the fold keeps in `others`
 * because they are the RUN's lifecycle rather than a turn's. Trace nests turns;
 * Work draws the stack. Same events, two questions.
 *
 * @param trace — a folded trace from src/traceModel.js.
 * @returns `{ [blockId]: { status, output, at } }`, latest status per block.
 */
export function blockStates(trace) {
  const states = {};
  for (const event of trace?.others ?? []) {
    const data = event?.data ?? {};
    const blockId = typeof data.blockId === 'string' ? data.blockId : null;
    if (!blockId) continue;
    const at = states[blockId] ?? { status: 'pending', output: null, at: null };
    if (event.type === 'block.status' && BLOCK_STATES.includes(data.status)) {
      at.status = data.status;
      at.at = event.at ?? at.at;
      if (data.status === 'active') at.startedAt ??= event.at ?? null;
      if (data.error) at.error = String(data.error);
      if (Number.isFinite(data.attempt)) at.attempt = data.attempt;
      if (Number.isFinite(data.maxAttempts)) at.maxAttempts = data.maxAttempts;
      if (data.retryState) at.retryState = String(data.retryState);
      if (data.failure && typeof data.failure === 'object') at.failure = data.failure;
      if (data.lastDurableProgress) at.lastDurableProgress = data.lastDurableProgress;
      if (Array.isArray(data.blockedBy)) at.blockedBy = data.blockedBy.map(String);
      if (['done', 'failed', 'skipped'].includes(data.status) && at.warningTransient) {
        delete at.warning;
        delete at.warningTransient;
      }
    }
    if (event.type === 'block.warning') {
      at.warning = String(data.reason ?? data.content ?? 'This block degraded.');
      at.warningTransient = data.transient === true;
    }
    if (event.type === 'block.output') at.output = String(data.content ?? '');
    states[blockId] = at;
  }
  return states;
}

/**
 * What a block is producing RIGHT NOW, from the turn that is open on it.
 *
 * A finished block has its output; a live one has only what the model has said
 * so far, and that is the thing a person watching wants on screen. Reading it
 * from the trace rather than from a second stream is what keeps Work and Trace
 * from disagreeing about a run they are both watching.
 */
export function liveOutput(trace, blockId) {
  for (let t = (trace?.turns?.length ?? 0) - 1; t >= 0; t--) {
    const turn = trace.turns[t];
    for (let s = turn.steps.length - 1; s >= 0; s--) {
      const step = turn.steps[s];
      if (step.blockId !== blockId) continue;
      if (step.request?.content) return step.request.content;
    }
  }
  return null;
}

const finite = value => Number.isFinite(value) ? value : null;
const earlier = (a, b) => !a || (Date.parse(b ?? '') < Date.parse(a ?? '')) ? b : a;
const later = (a, b) => !a || (Date.parse(b ?? '') > Date.parse(a ?? '')) ? b : a;

// Task-graph planning is an implementation phase of the authored block, not a
// generated child. Attribute it to the visible parent so its live model,
// timing and spend do not disappear into an id no card renders.
export function visibleBlockId(blockId) {
  const id = typeof blockId === 'string' ? blockId : '';
  return id.replace(/\.planner(?:-repair-\d+)?$/, '');
}

function contextBudgets(trace) {
  const budgets = new Map();
  for (const event of trace?.others ?? []) {
    if (event?.type !== 'context.budget' || event.data?.callId == null) continue;
    const effective = event.data?.effective;
    const estimatedInput = finite(effective?.total) != null
      ? Math.max(0, effective.total - (finite(effective?.reservedOutput) ?? finite(event.data?.effectiveOutput) ?? 0))
      : null;
    budgets.set(String(event.data.callId), estimatedInput);
  }
  return budgets;
}

/**
 * Operational facts shown directly on each block.
 *
 * These are deliberately folded from model requests instead of copied from a
 * separate ledger. A live block, its output, and its spend therefore advance
 * from one source and cannot momentarily disagree while a run is streaming.
 */
export function blockMetrics(trace) {
  const metrics = {};
  const budgets = contextBudgets(trace);
  for (const turn of trace?.turns ?? []) {
    for (const step of turn.steps ?? []) {
      const blockId = typeof step?.blockId === 'string' ? visibleBlockId(step.blockId) : null;
      if (!blockId) continue;
      const at = metrics[blockId] ?? {
        model: null, costUsd: null, tokensIn: null, tokensOut: null,
        reasoningTokens: null, cachedTokens: null, requestCount: 0,
        toolCount: 0, startedAt: null, endedAt: null, lastTokenAt: null,
        waitingForToken: false, estimatedTokensIn: null, estimatedTokensOut: null,
      };
      at.startedAt = earlier(at.startedAt, step.startedAt ?? step.request?.requestedAt ?? null);
      at.endedAt = later(at.endedAt, step.endedAt ?? step.request?.respondedAt ?? null);
      at.toolCount += (step.toolCalls ?? []).length;

      const request = step.request;
      if (request) {
        at.requestCount += 1;
        const attempts = request.attempts ?? [];
        const answered = [...attempts].reverse().find(item => item.status === 'succeeded');
        const latest = attempts.at(-1);
        at.model = answered?.resolvedModel ?? answered?.model
          ?? request.route?.effective ?? latest?.resolvedModel ?? latest?.model
          ?? request.model ?? request.configuredModel ?? at.model;
        at.lastTokenAt = later(at.lastTokenAt, request.lastTokenAt);
        at.waitingForToken ||= request.settled !== true;

        const usage = request.usage ?? null;
        for (const [target, source] of [
          ['tokensIn', 'promptTokens'], ['tokensOut', 'completionTokens'],
          ['reasoningTokens', 'reasoningTokens'], ['cachedTokens', 'cachedTokens'],
        ]) {
          const value = finite(usage?.[source]);
          if (value != null) at[target] = (at[target] ?? 0) + value;
        }
        const cost = finite(usage?.costUsd);
        if (cost != null) at.costUsd = (at.costUsd ?? 0) + cost;

        const estimatedInput = budgets.get(String(request.callId ?? ''));
        if (finite(usage?.promptTokens) == null && estimatedInput != null) {
          at.estimatedTokensIn = (at.estimatedTokensIn ?? 0) + estimatedInput;
        }

        // Providers usually report authoritative usage only in the final
        // envelope. The context manager has already measured the effective
        // request before dispatch, so surface that estimate immediately and
        // replace it with provider usage when the response settles.
        if (request.settled !== true) {
          const streamedChars = String(request.content ?? '').length + String(request.reasoning ?? '').length;
          if (streamedChars) at.estimatedTokensOut = (at.estimatedTokensOut ?? 0) + Math.max(1, Math.ceil(streamedChars / 4));
        }
      }
      metrics[blockId] = at;
    }
  }
  return metrics;
}

const eventSeq = (value, fallback = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) ? value : fallback;

function validationTitle(code, resolved) {
  if (code === 'invalid_task_graph') return 'Static validation failed';
  if (code === 'task_graph_repaired' || resolved) return 'Static validation passed';
  if (code === 'task_graph_degraded') return 'Safe planner fallback applied';
  return 'Block warning';
}

/**
 * Chronological, block-owned activity for the calm Work surface. Unlike Trace,
 * this is grouped by what a person sees as one block. It retains sequence ids
 * so a validation failure stays between the planner response that caused it
 * and the repair request that followed.
 */
export function blockActivity(trace) {
  const activity = {};
  const add = (blockId, item) => {
    const id = visibleBlockId(blockId);
    if (!id) return;
    (activity[id] ??= []).push(item);
  };

  for (const turn of trace?.turns ?? []) {
    for (const step of turn.steps ?? []) {
      const request = step.request;
      if (!request || !step.blockId) continue;
      const base = `${step.runId ?? ''}:${step.blockId}:${step.step}`;
      add(step.blockId, {
        id: `${base}:request`, kind: 'request', title: 'Request sent',
        seq: eventSeq(request.requestedSeq, eventSeq(step.promptSeq, eventSeq(step.startedSeq))), order: 0,
        at: request.requestedAt ?? step.startedAt ?? null, status: request.settled ? 'done' : 'running',
        model: request.model ?? null, maxTokens: request.maxTokens ?? null, content: step.prompt ?? request.prompt ?? null,
      });
      if (request.reasoning) add(step.blockId, {
        id: `${base}:reasoning`, kind: 'reasoning', title: 'Internal reasoning',
        seq: eventSeq(request.reasoningSeq, eventSeq(request.respondedSeq)), order: 1,
        at: request.firstTokenAt ?? request.respondedAt ?? null, status: request.settled ? 'done' : 'running',
        content: request.reasoning, chars: String(request.reasoning).length,
      });
      add(step.blockId, {
        id: `${base}:response`, kind: 'chat', title: 'Visible response',
        seq: eventSeq(request.contentSeq, eventSeq(request.respondedSeq)), order: 2,
        at: request.respondedAt ?? request.lastTokenAt ?? null,
        status: request.settled ? (request.content ? 'done' : 'empty') : request.content ? 'running' : 'waiting',
        content: request.content ?? '', finishReason: request.finishReason ?? null,
      });
      for (const call of step.toolCalls ?? []) add(step.blockId, {
        id: `${base}:tool:${call.callId ?? call.name}`, kind: 'tool', title: call.name ?? 'Tool call',
        seq: eventSeq(call.calledSeq, eventSeq(request.respondedSeq)), order: 3,
        at: call.calledAt ?? request.respondedAt ?? null,
        status: call.hasResult ? (call.error ? 'error' : 'done') : 'running',
        args: call.args ?? null, result: call.result ?? null, error: call.error ?? null,
      });
    }
  }

  for (const event of trace?.others ?? []) {
    if (event?.type !== 'block.warning' || typeof event.data?.blockId !== 'string') continue;
    const data = event.data;
    const validation = ['invalid_task_graph', 'task_graph_repaired', 'task_graph_degraded'].includes(String(data.code ?? ''));
    add(data.blockId, {
      id: `warning:${event.seq ?? activity[data.blockId]?.length ?? 0}`, kind: validation ? 'validation' : 'warning',
      title: validationTitle(data.code, data.resolved), seq: eventSeq(event.seq), order: 0, at: event.at ?? null,
      status: data.resolved || data.code === 'task_graph_repaired' ? 'done' : data.code === 'invalid_task_graph' ? 'error' : 'warning',
      content: String(data.reason ?? data.content ?? 'This block degraded.'), code: data.code ?? null,
      attempt: finite(data.attempt), maxAttempts: finite(data.maxAttempts),
      diagnostics: Array.isArray(data.diagnostics) ? data.diagnostics.map(String) : [],
      transformations: Array.isArray(data.transformations) ? data.transformations : [],
    });
  }

  for (const items of Object.values(activity)) items.sort((a, b) => a.seq - b.seq || a.order - b.order);
  return activity;
}

/** The run's own stage, from the log rather than from a caller's memory. */
export function runStage(trace) {
  let stage = null;
  let error = null;
  let errorBlockId = null;
  let reason = null;
  for (const event of trace?.others ?? []) {
    if (event?.type === 'run.stage' && typeof event.data?.stage === 'string') {
      stage = event.data.stage;
      reason = event.data?.reason ? String(event.data.reason) : null;
      if (stage === 'execution' || stage === 'resumed' || stage === 'done') {
        error = null;
        errorBlockId = null;
      }
    }
    if (event?.type === 'run.error' && event.data?.error) {
      error = String(event.data.error);
      errorBlockId = typeof event.data.blockId === 'string' ? event.data.blockId : null;
    }
  }
  return { stage, error, errorBlockId, reason };
}

/**
 * The whole of what Work draws over the stack.
 *
 * @param trace — the folded trace.
 * @returns per-block state with the live text folded in, plus the run's stage.
 */
export function runView(trace) {
  const states = blockStates(trace);
  const metrics = blockMetrics(trace);
  const activity = blockActivity(trace);
  const { stage, error, errorBlockId, reason } = runStage(trace);
  // A terminal run cannot have live blocks, even if the process died or the
  // scheduler failed between the active and terminal block events. Preserve
  // the raw trace for inspection; make the operational view truthful.
  if (TERMINAL_STAGES.has(stage)) {
    for (const block of Object.values(states)) {
      if (block.status === 'active') block.status = stage === 'failed' ? 'failed' : 'pending';
    }
  }
  const blocks = {};
  for (const [blockId, at] of Object.entries(states)) {
    const foldedMetrics = metrics[blockId] ?? {};
    const terminalAt = ['done', 'failed', 'skipped'].includes(at.status) ? at.at : null;
    const visibleMetrics = at.startedAt || Object.keys(foldedMetrics).length ? {
      ...foldedMetrics,
      startedAt: earlier(foldedMetrics.startedAt, at.startedAt) ?? null,
      endedAt: terminalAt ? later(foldedMetrics.endedAt, terminalAt) : foldedMetrics.endedAt ?? null,
    } : null;
    blocks[blockId] = {
      ...at,
      metrics: visibleMetrics,
      activity: activity[blockId] ?? [],
      // An active block shows what it is saying; a finished one shows what it
      // produced. Never both, and never the streaming text after the
      // deliverable exists — that would replace an answer with a draft of it.
      showing: at.status === 'active' ? (liveOutput(trace, blockId) ?? '') : (at.output ?? ''),
    };
  }
  const active = Object.entries(blocks).filter(([, b]) => b.status === 'active').map(([id]) => id);
  return {
    blocks,
    // Plural on purpose: a parallel has several, and rendering "the" active
    // block would make lanes running together look like one running alone.
    active,
    stage,
    error,
    errorBlockId,
    reason,
    warnings: Object.entries(blocks).filter(([, block]) => block.warning).map(([blockId, block]) => ({ blockId, message: block.warning })),
    running: ACTIVE_STAGES.has(stage) && !['paused', 'interrupted'].includes(stage),
    pausing: stage === 'pausing',
    paused: stage === 'paused',
    stopping: stage === 'stopping',
    resumable: stage === 'paused' || stage === 'stopped' || stage === 'interrupted',
  };
}
