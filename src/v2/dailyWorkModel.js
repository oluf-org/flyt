import { foldTrace } from '../traceModel.js';

const DONE = new Set(['done', 'complete', 'completed']);
const ACTIVE = new Set(['active', 'running', 'execution', 'thinking', 'streaming', 'tool']);
const FAILED = new Set(['failed', 'error', 'interrupted', 'rejected']);
const WAITING = new Set(['waiting', 'awaiting_input']);
const APPROVAL = new Set(['approval', 'awaiting_approval']);
const INPUT = new Set(['input']);

export function normalizeBlockStatus(value) {
  const status = String(value ?? 'pending').toLowerCase();
  if (DONE.has(status)) return 'done';
  if (ACTIVE.has(status)) return 'active';
  if (FAILED.has(status)) return 'failed';
  if (WAITING.has(status)) return 'waiting';
  if (APPROVAL.has(status)) return 'approval';
  if (INPUT.has(status)) return 'input';
  if (status === 'skipped') return 'skipped';
  return 'pending';
}

function executableNodes(flow) {
  return (flow?.nodes ?? []).filter(node => !['input', 'output'].includes(node.type));
}

function useForView(node) {
  const type = node.templateId ?? node.data?.templateId ?? node.type;
  if (type === 'aiStep') return 'flyt-blocks-core:general-analysis';
  return 'flyt-blocks-core:work';
}

/**
 * Old run snapshots still carry their authored flow while the production run
 * entry point is being moved onto canonical stacks. Work needs a containment
 * tree, not the retired canvas geometry, so this projection is deliberately a
 * read-only sequence. It never becomes an authoring source or writes a stack.
 */
export function stackFromSnapshot(snapshot) {
  if (snapshot?.stack?.root) return snapshot.stack;
  const flow = snapshot?.flow;
  if (!flow) return null;
  return {
    version: 2,
    id: flow.id ?? snapshot?.meta?.flowId ?? 'run',
    name: flow.name ?? snapshot?.meta?.flowName ?? flow.id ?? 'Run',
    root: {
      id: 'root',
      kind: 'sequence',
      children: executableNodes(flow).map(node => ({
        id: node.id,
        kind: 'block',
        use: useForView(node),
        title: node.overrides?.title ?? node.data?.title ?? node.title ?? node.id,
        config: {},
      })),
    },
  };
}

function usageForTrace(usage) {
  if (!usage) return null;
  return {
    promptTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? null,
    completionTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? usage.reasoning_tokens ?? null,
    cachedTokens: usage.cachedTokens ?? usage.cached_tokens ?? null,
    costUsd: usage.costUsd ?? usage.cost ?? null,
  };
}

function modelEvents(log, runId, startSeq) {
  const events = [];
  let seq = startSeq;
  let turn = 0;
  for (const record of Array.isArray(log) ? log : []) {
    if (record?.event !== 'model_call') continue;
    turn += 1;
    const at = record.at ?? record.ts ?? null;
    const blockId = record.node ?? 'run';
    const callId = record.callId ?? `legacy-${turn}`;
    events.push(
      { seq: seq++, at, type: 'turn.start', data: { runId, turn, blockId } },
      { seq: seq++, at, type: 'step.start', data: { runId, blockId, step: 1 } },
      { seq: seq++, at, type: 'llm.request', data: {
        callId, provider: record.provider ?? null, model: record.model ?? null,
      } },
      { seq: seq++, at, type: 'llm.response', data: {
        callId,
        content: record.content ?? record.text ?? null,
        reasoning: record.reasoning ?? null,
        finishReason: record.finishReason ?? (record.ok === false ? 'error' : 'stop'),
        usage: usageForTrace(record.usage),
        route: record.route ?? null,
      } },
      { seq: seq++, at, type: 'step.end', data: { runId, blockId, step: 1 } },
      { seq: seq++, at, type: 'turn.end', data: { runId, turn, blockId } },
    );
  }
  return events;
}

/** One renderer-safe source for both Work and Trace from a persisted run. */
export function watchingFromRun(runId, snapshot, log = []) {
  if (!runId || !snapshot || snapshot.retired) return null;
  if (Array.isArray(log) && log.some(event => event?.type === 'run.created')) {
    return { runId, stack: stackFromSnapshot(snapshot), trace: foldTrace(log), snapshot };
  }
  const events = [];
  let seq = 1;
  const at = snapshot.meta?.updatedAt ?? snapshot.meta?.createdAt ?? null;
  events.push({ seq: seq++, at, type: 'run.created', data: {
    runId, stackId: snapshot.meta?.flowId ?? snapshot.flow?.id ?? null,
  } });
  events.push(...modelEvents(log, runId, seq));
  seq += events.length - 1;

  const nodes = executableNodes(snapshot.flow);
  for (const node of nodes) {
    const status = normalizeBlockStatus(snapshot.meta?.nodeStatus?.[node.id]);
    const error = snapshot.retrospectives?.[node.id]?.error ?? null;
    events.push({ seq: seq++, at, type: 'block.status', data: { blockId: node.id, status, error } });
    const taskId = node.data?.taskId ?? node.overrides?.taskId;
    const output = snapshot.nodeOutputs?.[node.id]
      ?? (taskId ? snapshot.taskOutputs?.[taskId] : null)
      ?? snapshot.retrospectives?.[node.id]?.output
      ?? null;
    if (output != null) {
      events.push({ seq: seq++, at, type: 'block.output', data: {
        blockId: node.id, content: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
      } });
    }
  }
  const stage = String(snapshot.meta?.stage ?? 'execution');
  if (snapshot.meta?.error) {
    events.push({ seq: seq++, at, type: 'run.error', data: { error: String(snapshot.meta.error) } });
  }
  events.push({ seq: seq++, at, type: 'run.stage', data: { stage } });
  return { runId, stack: stackFromSnapshot(snapshot), trace: foldTrace(events), snapshot };
}

export function initialFlowId(flows, saved = null) {
  if (saved && flows.some(flow => flow.id === saved)) return saved;
  return flows[0]?.id ?? null;
}

