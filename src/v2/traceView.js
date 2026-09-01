// What Trace renders, above the fold model in `src/traceModel.js` (t-0071,
// t-0072).
//
// The fold turns a session log into turns holding steps. This turns those into
// the strings and shapes a person reads — kept out of the component so a test
// can assert what Trace SAYS about a run without a DOM, and so the component
// has nothing to decide.
//
// The rule the whole surface exists for: a degraded route must read as
// degraded, a truncated result must say it was truncated, and a tool call with
// no result must not look like one that returned nothing. Trace is where
// somebody goes when the calm surface was not enough, so anything it softens is
// something they came here to see.

/** A duration a person can read at a glance. */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Milliseconds between two ISO stamps, or null when either is missing. */
export function between(from, to) {
  const a = Date.parse(from ?? '');
  const b = Date.parse(to ?? '');
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

/**
 * What a model request cost and how it ended.
 *
 * `finishReason` is shown even when it is `stop`, because "it finished
 * normally" and "nobody recorded how it finished" are different facts and only
 * one of them is reassuring.
 */
export function requestView(request, step) {
  if (!request) return null;
  const usage = request.usage ?? null;
  const tokens = usage
    ? [
      usage.promptTokens != null ? `${usage.promptTokens} in` : null,
      usage.completionTokens != null ? `${usage.completionTokens} out` : null,
      usage.reasoningTokens ? `${usage.reasoningTokens} reasoning` : null,
      usage.cachedTokens ? `${usage.cachedTokens} cached` : null,
    ].filter(Boolean).join(' · ')
    : null;
  const attempts = (request.attempts ?? []).map(attempt => ({
    index: attempt.index,
    model: attempt.model ?? '(unrecorded)',
    provider: attempt.provider ?? '(unresolved provider)',
    effective: [attempt.provider, attempt.resolvedModel].filter(Boolean).join('/') || attempt.model || '(unrecorded)',
    status: attempt.status ?? 'started',
    error: attempt.error ?? null,
    ms: between(attempt.startedAt, attempt.endedAt),
  }));
  const answered = [...(request.attempts ?? [])].reverse().find(attempt => attempt.status === 'succeeded');
  const responseMs = between(answered?.startedAt ?? request.requestedAt, request.respondedAt ?? step?.endedAt);
  const tokensPerSecond = usage?.completionTokens != null && responseMs > 0
    ? usage.completionTokens / (responseMs / 1000) : null;
  return {
    model: request.model ?? '(unrecorded)',
    configuredModel: request.configuredModel ?? null,
    maxTokens: request.maxTokens ?? null,
    settled: request.settled === true,
    // An unsettled request is the live case and the crashed case at once, and
    // the reader can tell which from whether the run is still going.
    finishReason: request.settled ? (request.finishReason ?? '(none recorded)') : null,
    tokens,
    costUsd: usage?.costUsd ?? null,
    ms: between(request.requestedAt, request.respondedAt ?? step?.endedAt),
    tokensPerSecond,
    attempts,
    // D40: reasoning is kept apart from content everywhere, including here. A
    // surface that concatenates them is a surface that cannot answer "how much
    // of what I paid for was thinking".
    content: request.content ?? null,
    reasoning: request.reasoning ?? null,
    route: routeView(request.route),
  };
}

/**
 * The route, in the words somebody actually asks it in.
 *
 * Null when the run recorded none — an absent route is not the same as one that
 * says nothing went wrong, and rendering a reassuring default for a missing
 * record is exactly the lie this surface is here to prevent.
 */
export function routeView(route) {
  if (!route) return null;
  return {
    requested: route.requested ?? '(unrecorded)',
    effective: route.effective ?? '(unrecorded)',
    reason: route.reason ?? '',
    degraded: route.degraded === true,
    line: route.degraded
      ? `asked for ${route.requested}, answered by ${route.effective} — ${route.reason}`
      : `${route.effective}`,
  };
}

/** A tool call, with its arguments and its complete result. */
export function toolView(call, decisions = []) {
  const decision = decisions.find(d => d.callId === call.callId) ?? null;
  return {
    callId: call.callId,
    name: call.name ?? '(unnamed)',
    args: call.args ?? null,
    hasResult: call.hasResult === true,
    // The FULL result. The one time a preview is not enough is the time
    // somebody opened Trace, so this hands over what the log holds and lets
    // the component decide how much of it to show at rest.
    result: call.result ?? null,
    error: call.error ?? null,
    // A call with no result is not a call that returned nothing. The process
    // died while it was running, and its effect on the workspace is unknown.
    unfinished: call.hasResult !== true,
    decision: decision
      ? { decision: decision.decision, reason: decision.reason ?? '', at: decision.at ?? null }
      : null,
  };
}

/** A structured tool input that never became an authoritative response call. */
export function toolInputView(input) {
  return {
    inputId: input.inputId,
    requestCallId: input.requestCallId ?? null,
    toolCallId: input.toolCallId ?? null,
    index: input.index,
    name: input.name ?? '(name pending)',
    arguments: input.arguments ?? '',
    complete: input.complete === true,
    ms: between(input.startedAt, input.endedAt),
  };
}

/** One step, with everything it did. */
export function stepView(step) {
  return {
    id: step.id,
    blockId: step.blockId,
    step: step.step,
    finished: step.finished === true,
    ms: between(step.startedAt, step.endedAt),
    prompt: step.prompt ?? null,
    request: requestView(step.request, step),
    // Inputs committed by llm.response are represented by the parsed ordinary
    // tool call below. Everything else is partial/crash evidence and remains.
    toolInputs: (step.toolInputs ?? []).filter(input => input.committed !== true).map(toolInputView),
    tools: step.toolCalls.map(call => toolView(call, step.decisions)),
    // A decision about a call this step never recorded still belongs to the
    // step: a denial can be the reason there is no call.
    orphanDecisions: step.decisions.filter(d => !step.toolCalls.some(c => c.callId === d.callId)),
  };
}

/** One turn, with its steps. */
export function turnView(turn) {
  const steps = turn.steps.map(stepView);
  return {
    id: turn.id,
    runId: turn.runId,
    finished: turn.finished === true,
    ms: between(turn.startedAt, turn.endedAt),
    steps,
    // The headline a collapsed turn shows: which block, how many steps, what
    // it spent. Enough to decide whether to open it.
    blockId: steps[0]?.blockId ?? null,
    costUsd: steps.reduce((n, s) => n + (s.request?.costUsd ?? 0), 0) || null,
    toolCount: steps.reduce((n, s) => n + s.tools.length, 0),
  };
}

/**
 * The whole trace, ready to render.
 *
 * @param trace — from `foldTrace`/`feed` in src/traceModel.js.
 * @returns turns, plus the events the fold did not recognise. A plugin's own
 *   events are still that run's record, and a surface that hides them is a
 *   surface that stops being the record.
 */
export function traceView(trace) {
  const turns = (trace?.turns ?? []).map(turnView);
  return {
    turns,
    others: trace?.others ?? [],
    costUsd: turns.reduce((n, t) => n + (t.costUsd ?? 0), 0) || null,
    unfinished: turns.some(t => !t.finished),
  };
}
