// What a `branch` or `loop` condition can see (PIVOT-PLAN §5.3).
//
// One object per run, built fresh each time a condition is evaluated, keyed by
// node id:
//
//   { <nodeId>: { status, text, chars, lines,
//                 calls, retries, errors, cost, usage, latencyMs, ttftMs, tps,
//                 model, provider },
//     loop: { iteration, iterations },   // inside a loop body only
//     run:  { … the same fold, across the whole run … } }
//
// The second half of that shape is the pivot closing its own loop. §5.3:
//
//   Expressions can read metrics. `implement.cost.total > 0.50` and
//   `implement.usage.outputTokens > 4000` are valid conditions. This is where
//   the pivot closes its own loop: the investigator's data becomes an input to
//   control flow, so a flow can cheapen or escalate itself based on what it
//   just spent.
//
// Everything here is derived from files — node outputs, meta.nodeStatus, and
// the call ledger — so a condition's inputs are as inspectable after the fact
// as the decision it made.
import { runMetrics } from './runMetrics.js';

// Node output text is bounded before it enters a scope. A condition asking
// `implement.text contains "TODO"` does not need a megabyte in memory, and an
// unbounded copy of every node's output per evaluation is a real cost inside a
// loop that runs twenty times.
const TEXT_BUDGET = 64 * 1024;

export function buildScope(store, runId, flow, { loop = null } = {}) {
  const scope = {};
  let meta = null;
  try { meta = store.readMeta(runId); } catch { /* a scope over a half-written run is still useful */ }
  const metrics = store.runMetrics ? store.runMetrics(runId) : runMetrics(store.readCalls(runId), meta);

  const nodes = flow?.nodes ?? [];
  for (const node of nodes) {
    const id = node.id;
    const text = readText(store, node, runId);
    const m = metrics.nodes?.[id]
      ?? (node.data?.taskId ? metrics.tasks?.[node.data.taskId] : null)
      ?? null;
    scope[id] = {
      status: meta?.nodeStatus?.[id] ?? 'pending',
      title: node.data?.title ?? id,
      role: node.data?.role ?? null,
      text,
      // Cheap shapes of the output, so a condition doesn't have to do string
      // maths: `plan.lines > 40` reads better than anything involving split().
      chars: text ? text.length : 0,
      lines: text ? text.split('\n').length : 0,
      empty: !text?.trim(),
      // --- the metrics half ---
      calls: m?.calls ?? 0,
      retries: m?.retries ?? 0,
      errors: m?.errors ?? 0,
      // `cost` is the whole object, so both `n.cost > 0.5` (via the scalar
      // alias below) and `n.cost.total > 0.5` read naturally.
      cost: withScalar(m?.cost?.total ?? null, {
        total: m?.cost?.total ?? null,
        estimated: Boolean(m?.cost?.estimated),
        plan: m?.cost?.plan ?? 0
      }),
      usage: m?.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latencyMs: m?.latency?.p50 ?? null,
      maxLatencyMs: m?.latency?.max ?? null,
      ttftMs: m?.ttft?.p50 ?? null,
      tps: m?.throughput?.p50 ?? null,
      model: m?.models?.[0] ?? node.data?.worker?.model ?? null,
      provider: m?.providers?.[0] ?? node.data?.worker?.provider ?? null
    };
  }

  // The run as a whole — for a loop bound on total spend rather than per node.
  const r = metrics.run;
  scope.run = {
    stage: meta?.stage ?? 'unknown',
    calls: r?.calls ?? 0,
    retries: r?.retries ?? 0,
    errors: r?.errors ?? 0,
    cost: withScalar(r?.cost?.total ?? null, { total: r?.cost?.total ?? null, estimated: Boolean(r?.cost?.estimated) }),
    usage: r?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelMs: r?.modelMs ?? 0
  };

  // Inside a loop body, the loop's own state. `loop.iteration` is 1-based:
  // "the third time round" is 3, not 2.
  if (loop) scope.loop = { iteration: loop.iteration, iterations: loop.iterations ?? loop.iteration };

  return scope;
}

// A number that also has fields. `n.cost > 0.5` and `n.cost.total > 0.5` both
// work, because both are things a person would write and neither is wrong.
function withScalar(value, fields) {
  if (value == null) return fields;
  const boxed = new Number(value); // eslint-disable-line no-new-wrappers
  return Object.assign(boxed, fields);
}

function readText(store, node, runId) {
  try {
    if (node.type === 'input') return store.readPrompt(runId);
    if (node.type === 'agentTask' && node.data?.taskId) {
      return cap(store.readTaskOutput(runId, node.data.taskId) ?? store.readNodeOutput(runId, node.id));
    }
    return cap(store.readNodeOutput(runId, node.id));
  } catch { return null; }
}

const cap = t => (typeof t === 'string' && t.length > TEXT_BUDGET ? t.slice(0, TEXT_BUDGET) : t ?? null);

// The vocabulary, for error messages and for the linter's "did you mean"
// nudging. Kept next to buildScope so the two cannot drift.
export const NODE_SCOPE_FIELDS = [
  'status', 'title', 'role', 'text', 'chars', 'lines', 'empty',
  'calls', 'retries', 'errors', 'cost', 'usage', 'latencyMs', 'maxLatencyMs',
  'ttftMs', 'tps', 'model', 'provider'
];
export const COST_FIELDS = ['total', 'estimated', 'plan'];
export const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'];
export const RUN_SCOPE_FIELDS = ['stage', 'calls', 'retries', 'errors', 'cost', 'usage', 'modelMs'];
export const LOOP_SCOPE_FIELDS = ['iteration', 'iterations'];
