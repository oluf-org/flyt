// Run-scoped workflow debugger.
//
// This is deliberately an observer, not another workflow runner. It reads the
// durable session, gives a no-tool model the smallest useful evidence packet,
// and returns a structured bug report. Mutating actions stay on the existing
// run-control path and remain explicit in the UI.
import { callModel as defaultCallModel } from './adapters/index.js';

const MAX_CONTEXT_CHARS = 52_000;
const MAX_UNIT_CHARS = 12_000;
const MAX_OUTPUT_TOKENS = 1_600;

const text = value => String(value ?? '').trim();
const clipped = (value, max = MAX_UNIT_CHARS) => {
  const clean = text(value);
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n[clipped by debugger]`;
};

function blockIdOf(event) {
  return text(event?.data?.blockId ?? event?.data?.nodeId) || null;
}

/** Load every canonical child referenced by child.session, once, with provenance. */
export async function loadLinkedSessionEvents(parentSessionId, events = [], readSession = null) {
  const root = (events ?? []).map(event => ({ ...event, sessionId: event.sessionId ?? parentSessionId }));
  if (typeof readSession !== 'function') return root;
  const loaded = [...root];
  const seen = new Set([parentSessionId]);
  for (let cursor = 0; cursor < loaded.length; cursor++) {
    const event = loaded[cursor];
    if (event?.type !== 'child.session') continue;
    const childId = text(event?.data?.sessionId);
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);
    try {
      const children = await readSession(childId);
      for (const child of children ?? []) loaded.push({ ...child, sessionId: childId, parentSessionId: event.sessionId ?? parentSessionId });
    } catch (error) {
      loaded.push({
        type: 'debug.child-load-failed', sessionId: childId, parentSessionId: event.sessionId ?? parentSessionId,
        seq: null, at: null, data: { sessionId: childId, error: text(error?.message ?? error) },
      });
    }
  }
  return loaded;
}

/** Build a bounded, inspectable packet from one canonical session. */
export function workflowDebugFacts(snapshot = {}, events = []) {
  const blocks = {};
  const attempts = [];
  const tools = [];
  const outputs = [];
  const notable = [];
  const failures = [];
  const retries = [];
  const checkpoints = [];
  const boundaries = [];
  const children = [];
  const callBlocks = new Map();
  let lastRequest = null;
  let currentBlockId = null;

  const ensure = id => {
    if (!id) return null;
    blocks[id] ??= { id, status: 'unknown', error: null, warnings: [], outputs: 0, requests: 0 };
    return blocks[id];
  };

  for (const [id, status] of Object.entries(snapshot?.meta?.blockStatus ?? snapshot?.meta?.nodeStatus ?? {})) {
    const block = ensure(id);
    if (block) block.status = text(status) || block.status;
  }

  for (const event of events ?? []) {
    const data = event?.data ?? {};
    const sessionId = event?.sessionId ?? snapshot?.meta?.runId ?? null;
    const locator = { sessionId, seq: event?.seq ?? null, at: event?.at ?? null };
    if (event?.type === 'step.start' && blockIdOf(event)) currentBlockId = blockIdOf(event);
    if (event?.type === 'step.end') currentBlockId = null;
    const explicitBlockId = blockIdOf(event);
    const blockId = explicitBlockId ?? (data.callId != null ? callBlocks.get(String(data.callId)) : null) ?? currentBlockId;
    if (event?.type === 'block.status') {
      const block = ensure(blockId);
      if (block) {
        block.status = text(data.status) || block.status;
        if (data.error) block.error = clipped(data.error, 2_000);
        if (data.attempt != null) block.attempt = Number(data.attempt);
        if (data.maxAttempts != null) block.maxAttempts = Number(data.maxAttempts);
        if (data.retryState) block.retryState = text(data.retryState);
        if (data.failure) block.failure = data.failure;
        if (data.lastDurableProgress) block.lastDurableProgress = data.lastDurableProgress;
        if (Array.isArray(data.blockedBy)) block.blockedBy = data.blockedBy.map(text);
        if (data.status === 'done') boundaries.push({ kind: 'block.done', blockId, ...locator });
      }
    } else if (event?.type === 'block.warning') {
      const block = ensure(blockId);
      if (block) {
        if (data.resolved === true) {
          for (const warning of block.warnings) if ((!data.resolves && !data.code) || warning.code === (data.resolves ?? data.code)) warning.resolved = true;
        } else block.warnings.push({
          code: data.code ?? null, message: clipped(data.reason ?? data.content, 2_000), resolved: false, ...locator,
        });
      }
    } else if (event?.type === 'block.output') {
      const block = ensure(blockId);
      if (block) block.outputs += 1;
      outputs.push({ blockId, at: event.at ?? null, content: clipped(data.content) });
      boundaries.push({ kind: data.port === 'plan' ? 'plan.accepted' : 'block.output', blockId, ...locator });
      if (data.port === 'plan') {
        const owner = ensure(blockId);
        for (const warning of owner?.warnings ?? []) if (warning.code === 'invalid_task_graph') warning.resolved = true;
      }
    } else if (event?.type === 'step.prompt') {
      notable.push({ kind: 'prompt', blockId, at: event.at ?? null, content: clipped(data.content ?? data.prompt) });
    } else if (event?.type === 'llm.request') {
      const block = ensure(blockId);
      if (block) block.requests += 1;
      lastRequest = { callId: data.callId ?? null, blockId, model: data.model ?? null };
      if (data.callId != null && blockId) callBlocks.set(String(data.callId), blockId);
    } else if (event?.type === 'llm.attempt') {
      attempts.push({
        callId: data.callId ?? lastRequest?.callId ?? null,
        blockId: blockId ?? lastRequest?.blockId ?? null,
        provider: data.provider ?? null,
        model: data.resolvedModel ?? data.model ?? lastRequest?.model ?? null,
        status: data.status ?? null,
        error: data.error ? clipped(data.error, 3_000) : null,
        at: event.at ?? null,
      });
    } else if (event?.type === 'llm.response') {
      boundaries.push({ kind: 'llm.response', blockId, callId: data.callId ?? null, ...locator });
      if (data.ok === false || data.error || data.finishReason === 'length') notable.push({
        kind: 'model-response', blockId: blockId ?? lastRequest?.blockId ?? null,
        ok: data.ok !== false, finishReason: data.finishReason ?? null,
        error: data.error ? clipped(data.error, 3_000) : null,
        content: clipped(data.content, 4_000), at: event.at ?? null,
      });
    } else if (event?.type === 'tool.call') {
      const owner = blockId ?? lastRequest?.blockId ?? null;
      if (data.callId != null && owner) callBlocks.set(String(data.callId), owner);
    } else if (event?.type === 'tool.result') {
      tools.push({
        blockId, name: data.name ?? 'tool', ok: !data.error,
        error: data.error ? clipped(data.error, 3_000) : null,
        result: data.error ? null : clipped(data.content ?? data.preview, 2_000),
        at: event.at ?? null,
      });
      if (!data.error) boundaries.push({ kind: data.durableProgress ? 'durable.write' : 'tool.result', blockId, callId: data.callId ?? null, ...locator });
    } else if (event?.type === 'llm.failure') {
      const failure = data.failure ?? {};
      failures.push({
        ...failure, callId: failure.callId ?? data.callId ?? lastRequest?.callId ?? null,
        step: failure.step ?? data.step ?? null, blockId: blockId ?? lastRequest?.blockId ?? null,
        model: failure.model ?? lastRequest?.model ?? null, detail: clipped(failure.detail ?? data.error, 3_000),
        ...locator,
      });
    } else if (event?.type === 'task.retry') {
      retries.push({ taskId: data.taskId ?? null, blockId, attempt: data.attempt ?? null,
        decision: data.decision ?? null, nextAttempt: data.nextAttempt ?? null, failure: data.failure ?? null, ...locator });
    } else if (event?.type === 'context.checkpoint') {
      checkpoints.push({ blockId, kind: data.kind ?? 'context-compaction', content: clipped(data.content, 3_000),
        durableWriteProduced: Boolean(data.durableWriteProduced), lastDurableProgress: data.lastDurableProgress ?? null,
        artifactHandles: data.artifactHandles ?? [], ...locator });
    } else if (event?.type === 'child.session') {
      children.push({ sessionId: data.sessionId ?? null, taskId: data.taskId ?? null, stage: data.stage ?? null,
        attempt: data.attempt ?? null, retryDecision: data.retryDecision ?? null, failure: data.failure ?? null, ...locator });
    } else if (['run.error', 'sandbox.failure', 'permission.decision', 'run.reconfigured'].includes(event?.type)) {
      notable.push({ kind: event.type, blockId, at: event.at ?? null, data });
    }
  }

  if (!outputs.length) {
    for (const [blockId, content] of Object.entries(snapshot?.nodeOutputs ?? {})) {
      const block = ensure(blockId);
      if (block) block.outputs += 1;
      outputs.push({ blockId, at: null, content: clipped(content) });
    }
  }

  const causalChain = failures.map(failure => {
    const prior = boundaries.filter(boundary => boundary.sessionId === failure.sessionId
      && (failure.seq == null || boundary.seq == null || boundary.seq < failure.seq)).at(-1) ?? null;
    const retry = [...retries].reverse().find(item => item.taskId && item.blockId === failure.blockId
      || item.failure?.callId && item.failure.callId === failure.callId) ?? null;
    return { from: prior, failure, retryDecision: retry?.decision ?? 'none-recorded', taskAttempt: retry?.attempt ?? null };
  });

  return {
    run: {
      id: snapshot?.meta?.runId ?? null,
      workflow: snapshot?.meta?.stackName ?? snapshot?.meta?.stackId ?? null,
      workflowId: snapshot?.meta?.stackId ?? null,
      stage: snapshot?.meta?.stage ?? null,
      currentBlockId: snapshot?.meta?.currentBlockId ?? snapshot?.meta?.currentNodeId ?? null,
      error: snapshot?.meta?.error ?? null,
      prompt: clipped(snapshot?.prompt, 8_000),
    },
    blocks: Object.values(blocks), attempts, tools, outputs, notable,
    failures, retries, checkpoints, children, causalChain,
  };
}

function probableBlock(facts) {
  return [...(facts.failures ?? [])].reverse().find(failure => failure.blockId)?.blockId
    ?? facts.blocks.find(block => block.status === 'failed')?.id
    ?? [...facts.attempts].reverse().find(attempt => attempt.error)?.blockId
    ?? [...facts.tools].reverse().find(tool => !tool.ok)?.blockId
    ?? facts.run.currentBlockId
    ?? null;
}

/** Useful even when no debugging model is configured or the provider fails. */
export function deterministicDebugReport(facts, reason = null) {
  const failedBlock = probableBlock(facts);
  const terminalFailure = [...(facts.failures ?? [])].reverse().find(failure => failure.code || failure.detail);
  const modelFailure = [...facts.attempts].reverse().find(attempt => attempt.error);
  const toolFailure = [...facts.tools].reverse().find(tool => !tool.ok);
  const blockFailure = facts.blocks.find(block => block.status === 'failed' && block.error);
  const lengthStop = [...facts.notable].reverse().find(item => item.kind === 'model-response' && item.finishReason === 'length');
  const runError = text(facts.run.error);
  let probableCause = 'The record does not contain a single conclusive failure signal.';
  let confidence = 'low';
  let suggestedArea = failedBlock ? `Inspect the prompt, inputs, and model/tool events for block “${failedBlock}”.` : 'Inspect the last incomplete model or tool event in Trace.';
  const repairedWarnings = facts.blocks.flatMap(block => block.warnings ?? []).filter(warning => warning.code === 'invalid_task_graph' && warning.resolved);
  if (terminalFailure) {
    const retry = [...(facts.retries ?? [])].reverse().find(item => item.failure?.callId === terminalFailure.callId
      || item.blockId === terminalFailure.blockId);
    const count = ['zero', 'one', 'two', 'three'][repairedWarnings.length] ?? String(repairedWarnings.length);
    const repairLead = repairedWarnings.length
      ? `The initial graph failed ${count} static check${repairedWarnings.length === 1 ? '' : 's'} and was successfully repaired. ` : '';
    const step = terminalFailure.step != null ? ` at step ${terminalFailure.step}` : '';
    const output = terminalFailure.reasoningOutputProduced && !terminalFailure.visibleOutputProduced
      ? ' after reasoning-only output' : terminalFailure.visibleOutputProduced ? ' after visible output' : '';
    probableCause = `${repairLead}The accepted worker’s ${terminalFailure.provider ?? 'provider'} stream terminated during ${terminalFailure.callId ?? 'an unlabelled call'}${step}${output}. `
      + `Retry decision: ${retry?.decision ?? 'none-recorded'}${terminalFailure.retryable ? ' (classified retryable)' : ''}.`;
    confidence = 'high';
    suggestedArea = `Session ${terminalFailure.sessionId ?? 'unknown'}, event ${terminalFailure.seq ?? 'unknown'}, task attempt ${retry?.attempt ?? 'unknown'}, model ${terminalFailure.model ?? 'unknown'}.`;
  } else if (runError) {
    probableCause = runError;
    confidence = 'high';
  } else if (modelFailure) {
    probableCause = `The model attempt failed: ${modelFailure.error}`;
    confidence = 'high';
    suggestedArea = `Check the ${modelFailure.provider ?? 'provider'} route, credentials, limits, and model availability for “${failedBlock ?? 'the affected block'}”.`;
  } else if (toolFailure) {
    probableCause = `Tool “${toolFailure.name}” failed: ${toolFailure.error}`;
    confidence = 'high';
    suggestedArea = `Inspect the tool arguments, permissions, and workspace state for “${failedBlock ?? 'the affected block'}”.`;
  } else if (blockFailure) {
    probableCause = blockFailure.error;
    confidence = 'high';
  } else if (lengthStop) {
    probableCause = 'A model response reached its output-token ceiling before completing.';
    confidence = 'medium';
    suggestedArea = `Inspect the output ceiling and prompt scope for “${failedBlock ?? 'the affected block'}”.`;
  } else if (facts.run.stage === 'done') {
    probableCause = 'The workflow completed technically; the likely issue is output quality or a missing acceptance check.';
    suggestedArea = 'Compare the final block output with the original request and add a precise retry instruction or evaluation block.';
  }
  return {
    summary: failedBlock ? `The strongest failure signal points to “${failedBlock}”.` : 'No single block can be blamed from the recorded evidence.',
    probableCause, confidence, suspectedBlockId: failedBlock,
    evidence: [
      terminalFailure ? `session=${terminalFailure.sessionId ?? 'unknown'} seq=${terminalFailure.seq ?? 'unknown'} call=${terminalFailure.callId ?? 'unknown'} step=${terminalFailure.step ?? 'unknown'} model=${terminalFailure.model ?? 'unknown'}` : null,
      terminalFailure?.detail, runError, modelFailure?.error, toolFailure?.error, blockFailure?.error,
    ].filter(Boolean).slice(0, 6),
    suggestedAreas: [suggestedArea],
    suggestedPrompt: failedBlock ? `Re-run ${failedBlock} after addressing the recorded failure. Preserve successful upstream work and verify the output against the original request.` : '',
    recommendedAction: failedBlock ? 'Review the evidence, edit the retry instruction, then retry the suspected block.' : 'Open Trace and inspect the last incomplete request.',
    model: null, degraded: true, reason: reason ?? 'no debug model is configured',
  };
}

function parseReport(value) {
  const raw = text(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('debug model returned no report object');
  return {
    summary: text(parsed.summary),
    probableCause: text(parsed.probableCause),
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
    suspectedBlockId: text(parsed.suspectedBlockId) || null,
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(text).filter(Boolean).slice(0, 8) : [],
    suggestedAreas: Array.isArray(parsed.suggestedAreas) ? parsed.suggestedAreas.map(text).filter(Boolean).slice(0, 8) : [],
    suggestedPrompt: text(parsed.suggestedPrompt),
    recommendedAction: text(parsed.recommendedAction),
  };
}

export async function analyzeWorkflowRun({
  snapshot, events, worker = null, resolveModelSource = null,
  callModel = defaultCallModel, retry = null, timeout = null, readSession = null,
} = {}) {
  const linkedEvents = await loadLinkedSessionEvents(snapshot?.meta?.runId ?? null, events, readSession);
  const facts = workflowDebugFacts(snapshot, linkedEvents);
  if (!worker?.model || typeof resolveModelSource !== 'function') return { ...deterministicDebugReport(facts), facts };
  try {
    const route = resolveModelSource(worker.model, worker.provider && worker.provider !== 'auto' ? worker.provider : null);
    let packet = JSON.stringify(facts, null, 2);
    if (packet.length > MAX_CONTEXT_CHARS) {
      const compact = { ...facts, outputs: facts.outputs.slice(-4), notable: facts.notable.slice(-12), tools: facts.tools.slice(-20), attempts: facts.attempts.slice(-20) };
      packet = JSON.stringify(compact, null, 2).slice(0, MAX_CONTEXT_CHARS);
    }
    const result = await callModel({
      ...route,
      system: [
        'You are Flyt Debugger, a no-tool incident investigator for an agent workflow.',
        'Use only the supplied durable run facts. Distinguish evidence from inference. Never claim an action was taken.',
        'Return only JSON with keys: summary, probableCause, confidence (low|medium|high), suspectedBlockId, evidence (string[]), suggestedAreas (string[]), suggestedPrompt, recommendedAction.',
        'The suggestedPrompt is retry guidance for the suspected block, not a replacement for the user request.',
        'Follow facts.causalChain from the last successful boundary to the terminal failure. Terminal child/provider failures outrank earlier resolved planner warnings.',
        'Cite session id, event sequence, task attempt, model, and retry decision. Mention resolved planner warnings only as recovered context.',
      ].join('\n'),
      prompt: `Investigate this workflow run and prepare a self-contained bug report.\n\n${packet}`,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(retry ? { retry } : {}), ...(timeout ? { timeout } : {}),
    });
    const modelReport = parseReport(result?.text ?? result?.content);
    if (facts.failures.length) {
      // A configured analysis model may improve wording and remediation, but it
      // must not be able to rewrite the durable causal attribution. Keep the
      // terminal failure, its event coordinates, and its retry classification
      // deterministic; merge only advisory fields around that spine.
      const causal = deterministicDebugReport(facts);
      return {
        ...modelReport,
        probableCause: causal.probableCause,
        confidence: causal.confidence,
        suspectedBlockId: causal.suspectedBlockId,
        evidence: [...causal.evidence, ...modelReport.evidence].filter(Boolean).slice(0, 8),
        suggestedAreas: [...causal.suggestedAreas, ...modelReport.suggestedAreas].filter(Boolean).slice(0, 8),
        facts, model: `${route.provider}/${route.model}`, degraded: false, reason: null,
      };
    }
    return { ...modelReport, facts, model: `${route.provider}/${route.model}`, degraded: false, reason: null };
  } catch (error) {
    return { ...deterministicDebugReport(facts, text(error?.message ?? error)), facts };
  }
}
